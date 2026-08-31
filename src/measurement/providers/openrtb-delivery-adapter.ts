/**
 * OpenRTB delivery-notice measurement adapter — the NET-W023
 * sanctioned measurement path (issue #46; work order §3.5 "route
 * measurement facts through /measurement → /outcomes").
 *
 * An external exchange reports DELIVERY FACTS (impression notices for
 * admitted bid requests) as provider measurement reports. This
 * adapter implements the W022 OPTIONAL
 * `MeasurementProviderAdapter.normalizeReport` contract — the exact
 * extension point NET-W022 built for pushed provider reports — so
 * delivery facts flow through the EXISTING authoritative ingestion
 * chain (`submitMeasurementReport` → `/measurement` normalization →
 * `/outcomes` exactly-once persistence + atomic audit) with ZERO
 * /outcomes changes.
 *
 * Raw notice shape (this adapter's vendor tier — nothing here is
 * imported by `/outcomes`; OpenRTB request/supply-chain parsing stays
 * owned by `/adapters` per the NET-W023 authority checklist — this
 * payload is an exchange's delivery REPORT, not an OpenRTB protocol
 * object):
 *  - `noticeId`            provider-unique notice id (dedup/trace)
 *  - `requestRef`          the bid request id this delivery relates to
 *                          (the MECHANICAL LINK — must equal
 *                          `deterministicLink`)
 *  - `impressionRef`       the delivered impression slot id
 *  - `subjectRefs`         provider-side subject references (exactly
 *                          one — the neutral externalSubjectRef)
 *  - `outcomeType`         MUST be "view" (a delivery notice reports
 *                          an ad exposure — anything else fails closed)
 *  - `observedValue`       { value, unit }
 *  - `confidence`          { point, lower?, upper? }
 *  - `attributionMode`     MUST be "deterministic" with
 *                          `deterministicLink` == `requestRef`
 *  - `method`, `methodVersion`, `collectedAt`  provenance (REQUIRED)
 *  - `integrity`           { algorithm: "hmac-sha256", signature,
 *                          signedAt } — REQUIRED, verified against
 *                          the provider verification secret
 *  - REDACTED (never cross; names only): `device`, `user`,
 *    `vendorExtensions`, and any unknown extra field.
 *
 * Normalization is PURE: the same payload + verification secret
 * always produces the identical neutral report. Push-only:
 * `fetchObservations` returns empty.
 */

import type {
  AdapterReportNormalization,
  MeasurementProviderAdapter,
  ProviderObservationFetchResult,
  ProviderObservationFetchRequest,
  RawProviderReportSubmission,
} from "../port.ts";
import { verifyReportIntegrity } from "./report-integrity.ts";
import {
  buildNeutralReport,
  collectRedactedFieldNames,
  rejectReport,
  resolveExternalSubjectRef,
  validateProviderAttributionMode,
  validateRawConfidence,
  validateRawObservedValue,
} from "./report-normalization.ts";

/** The reference OpenRTB delivery-notice provider id. */
export const OPENRTB_DELIVERY_PROVIDER_ID = "openrtb-delivery" as const;

export interface OpenRtbDeliveryNoticeAdapterOptions {
  /**
   * The provider verification secret (HMAC-SHA256 key) resolved
   * through the SecretProvider at composition time. NEVER persisted,
   * logged, or included in any normalized report/error context
   * (PRIV-002).
   */
  readonly verificationSecret: string | undefined;
  /** Adapter version override (defaults to the reference version). */
  readonly version?: string;
}

export class OpenRtbDeliveryNoticeAdapter implements MeasurementProviderAdapter {
  public readonly info: {
    readonly kind: "measurement";
    readonly provider: string;
    readonly version: string;
  };
  private readonly verificationSecret: string | undefined;

  public constructor(options: OpenRtbDeliveryNoticeAdapterOptions) {
    this.info = Object.freeze({
      kind: "measurement",
      provider: OPENRTB_DELIVERY_PROVIDER_ID,
      version: options.version ?? "1.0.0",
    });
    this.verificationSecret = options.verificationSecret;
  }

  public async initialize(): Promise<void> {}

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.verificationSecret) {
      return {
        ok: false,
        detail:
          "no verification secret configured — pushed notices fail closed (unverifiable integrity)",
      };
    }
    return { ok: true };
  }

  public async fetchObservations(
    _request: ProviderObservationFetchRequest,
  ): Promise<ProviderObservationFetchResult> {
    // Push-only reference adapter: the pull surface reports nothing.
    return { observations: [], nextCursor: null };
  }

  public async normalizeReport(
    submission: RawProviderReportSubmission,
  ): Promise<AdapterReportNormalization> {
    const providerId = this.info.provider;
    const raw = submission.payload;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw rejectReport(
        "malformed_report",
        providerId,
        "the delivery notice payload must be a JSON object",
      );
    }
    const notice = raw as Record<string, unknown>;
    // Structural validation (fail closed on malformed fields).
    for (const field of ["noticeId", "requestRef", "impressionRef"] as const) {
      const value = notice[field];
      if (typeof value !== "string" || !value.trim()) {
        throw rejectReport(
          "malformed_report",
          providerId,
          `${field} must be a non-empty string`,
          field,
        );
      }
    }
    // A delivery notice reports an ad EXPOSURE: the outcome type is
    // pinned to the neutral "view" vocabulary entry (anything else is
    // a malformed vendor claim, not a measurement-semantics decision
    // — /outcomes owns semantics).
    const outcomeType = notice["outcomeType"];
    if (outcomeType !== "view") {
      throw rejectReport(
        "malformed_report",
        providerId,
        `a delivery notice reports a view (outcomeType must be "view"; got ${JSON.stringify(String(outcomeType ?? ""))})`,
        "outcomeType",
      );
    }
    // Integrity FIRST: nothing else is trusted before the payload is
    // verified (fail closed on unverifiable integrity fields).
    verifyReportIntegrity({
      providerId,
      raw: notice,
      verificationSecret: this.verificationSecret,
    });
    // Subject mapping (fail closed on ambiguity).
    const externalSubjectRef = resolveExternalSubjectRef(notice, providerId);
    // Provider-reported attribution mode + mode consistency. A
    // delivery notice is mechanically linked to its bid request.
    const attributionMode = validateProviderAttributionMode({ raw: notice, providerId });
    if (attributionMode !== "deterministic") {
      throw rejectReport(
        "unsupported_attribution_mode",
        providerId,
        "a delivery notice must claim deterministic attribution (the bid request reference is the mechanical link)",
        "attributionMode",
      );
    }
    const deterministicLink = notice["deterministicLink"];
    if (deterministicLink !== notice["requestRef"]) {
      throw rejectReport(
        "malformed_report",
        providerId,
        "deterministicLink must equal requestRef (the bid request reference is the mechanical link)",
        "deterministicLink",
      );
    }
    // Neutral-contract observation fields.
    const observedValue = validateRawObservedValue(notice, providerId);
    const confidence = validateRawConfidence(notice, providerId);
    // Privacy minimization: only the neutral contract fields cross
    // the boundary; every OTHER input field (device, user, vendor
    // extensions, consumed-for-validation ids and the integrity
    // block) is dropped and reported by NAME only.
    const neutralReport = buildNeutralReport({
      providerId,
      externalSubjectRef,
      outcomeType,
      observedValue,
      confidence,
      attributionMode,
      raw: notice,
    });
    const redactedFieldNames = collectRedactedFieldNames(
      notice,
      Object.keys(neutralReport),
    );
    return { report: neutralReport, redactedFieldNames };
  }
}
