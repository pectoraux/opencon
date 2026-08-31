/**
 * iOS attribution reference adapter — ADAPTER-004 (NET-W022, issue
 * #44 scope 2).
 *
 * Provider-neutral reference implementation of the mobile-OS
 * attribution postback surface: the raw shape mirrors the COMMON
 * structure of OS-level attribution postbacks (a postback id, ad
 * campaign/group references, an attribution record or modeled
 * attribution, and signed postback integrity) WITHOUT binding to any
 * vendor SDK (architecture-lock §14.24; issue #44 non-goal "no
 * vendor lock-in").
 *
 * Raw postback shape (this adapter's vendor tier — nothing here is
 * imported by `/outcomes`):
 *  - `postbackId`          provider-unique postback id (dedup/trace)
 *  - `adCampaignRef`       vendor ad campaign reference (REDACTED —
 *                          vendor vocabulary never crosses)
 *  - `adGroupRef?`         vendor ad group reference (REDACTED)
 *  - `subjectRefs`         provider-side subject references (exactly
 *                          one — the neutral externalSubjectRef)
 *  - `outcomeType`         OUT-001 vocabulary
 *  - `observedValue`       { value, unit }
 *  - `confidence`          { point, lower?, upper? }
 *  - `attributionMode?`    deterministic | probabilistic
 *  - `deterministicLink?`  mechanical link (REQUIRED iff
 *                          deterministic; FORBIDDEN otherwise)
 *  - `method`, `methodVersion`, `collectedAt`  provenance (REQUIRED)
 *  - `integrity`           { algorithm: "hmac-sha256", signature,
 *                          signedAt } — REQUIRED, verified against
 *                          the provider verification secret
 *  - REDACTED (never cross; names only): `adCampaignRef`,
 *    `adGroupRef`, `deviceHints`, `vendorPayload`, `postbackSource`,
 *    and any unknown extra field.
 *
 * Normalization is PURE: the same payload + verification secret
 * always produces the identical neutral report (deterministic —
 * issue #44 definition of done). Push-only: `fetchObservations`
 * returns empty.
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

/** The reference iOS attribution provider id. */
export const IOS_ATTRIBUTION_PROVIDER_ID = "ios-attribution" as const;


export interface IOSAttributionAdapterOptions {
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

export class IOSAttributionAdapter implements MeasurementProviderAdapter {
  public readonly info: {
    readonly kind: "measurement";
    readonly provider: string;
    readonly version: string;
  };
  private readonly verificationSecret: string | undefined;

  public constructor(options: IOSAttributionAdapterOptions) {
    this.info = Object.freeze({
      kind: "measurement",
      provider: IOS_ATTRIBUTION_PROVIDER_ID,
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
          "no verification secret configured — pushed reports fail closed (unverifiable integrity)",
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
        "the iOS attribution postback payload must be a JSON object",
      );
    }
    const report = raw as Record<string, unknown>;
    // Structural validation (fail closed on malformed fields).
    const postbackId = report["postbackId"];
    if (typeof postbackId !== "string" || !postbackId.trim()) {
      throw rejectReport(
        "malformed_report",
        providerId,
        "postbackId must be a non-empty string",
        "postbackId",
      );
    }
    // Integrity FIRST: nothing else is trusted before the payload is
    // verified (fail closed on unverifiable integrity fields).
    verifyReportIntegrity({ providerId, raw: report, verificationSecret: this.verificationSecret });
    // Subject mapping (fail closed on ambiguity).
    const externalSubjectRef = resolveExternalSubjectRef(report, providerId);
    // Provider-reported attribution mode + mode consistency.
    const attributionMode = validateProviderAttributionMode({ raw: report, providerId });
    // Neutral-contract observation fields.
    const observedValue = validateRawObservedValue(report, providerId);
    const confidence = validateRawConfidence(report, providerId);
    const outcomeType = report["outcomeType"];
    if (typeof outcomeType !== "string" || !outcomeType.trim()) {
      throw rejectReport(
        "malformed_report",
        providerId,
        "outcomeType must be a non-empty string",
        "outcomeType",
      );
    }
    // Privacy minimization: only the neutral contract fields cross
    // the boundary; every OTHER input field (the vendor ad
    // references, device hints AND consumed-for-validation fields) is
    // dropped and reported by NAME only.
    const neutralReport = buildNeutralReport({
      providerId,
      externalSubjectRef,
      outcomeType,
      observedValue,
      confidence,
      attributionMode,
      raw: report,
    });
    const redactedFieldNames = collectRedactedFieldNames(
      report,
      Object.keys(neutralReport),
    );
    return { report: neutralReport, redactedFieldNames };
  }
}
