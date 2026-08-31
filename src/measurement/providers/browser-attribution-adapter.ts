/**
 * Browser/platform attribution reference adapter — ADAPTER-003
 * (NET-W022, issue #44 scope 2).
 *
 * Provider-neutral reference implementation of the browser/platform
 * attribution report surface: the raw shape mirrors the COMMON
 * structure of browser attribution reporting (a source event, a
 * reporting destination, a trigger, and signed report integrity)
 * WITHOUT binding to any vendor SDK (architecture-lock §14.24 —
 * provider vocabulary never crosses into domain authorities; issue
 * #44 non-goal "no vendor lock-in").
 *
 * Raw report shape (this adapter's vendor tier — nothing here is
 * imported by `/outcomes`):
 *  - `reportId`            provider-unique report id (dedup/trace)
 *  - `sourceEventId`       the attribution source event (click/view)
 *  - `destination`         the reporting destination site
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
 *  - REDACTED (never cross; names only): `triggerData`,
 *    `vendorExtensions`, `userAgent`, `ipHint`,
 *    `scheduledReportTime`, and any unknown extra field.
 *
 * Normalization is PURE: the same payload + verification secret
 * always produces the identical neutral report (deterministic —
 * issue #44 definition of done). This adapter is push-only:
 * `fetchObservations` returns empty (the pull surface stays with the
 * W006 pull adapters; the reference adapters normalize PUSHED
 * reports).
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

/** The reference browser/platform attribution provider id. */
export const BROWSER_ATTRIBUTION_PROVIDER_ID = "browser-attribution" as const;


export interface BrowserAttributionAdapterOptions {
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

export class BrowserAttributionAdapter implements MeasurementProviderAdapter {
  public readonly info: {
    readonly kind: "measurement";
    readonly provider: string;
    readonly version: string;
  };
  private readonly verificationSecret: string | undefined;

  public constructor(options: BrowserAttributionAdapterOptions) {
    this.info = Object.freeze({
      kind: "measurement",
      provider: BROWSER_ATTRIBUTION_PROVIDER_ID,
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
        "the browser attribution payload must be a JSON object",
      );
    }
    const report = raw as Record<string, unknown>;
    // Structural validation (fail closed on malformed fields).
    const reportId = report["reportId"];
    if (typeof reportId !== "string" || !reportId.trim()) {
      throw rejectReport(
        "malformed_report",
        providerId,
        "reportId must be a non-empty string",
        "reportId",
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
    // the boundary; every OTHER input field (vendor fields AND
    // consumed-for-validation fields) is dropped and reported by
    // NAME only.
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
