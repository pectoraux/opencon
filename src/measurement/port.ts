/**
 * Measurement boundary — provider-neutral measurement provider port
 * (NET-W006).
 *
 * Architecture ref: spec/architecture.md §13 (measurement
 * architecture), §18 (`/measurement` — "measurement provider
 * integrations; semantics remain in `/outcomes`");
 * spec/architecture-lock.md §14 invariant 25 ("Measurement and
 * payment adapters provide evidence/transaction facts; `/outcomes`
 * and `/settlement` retain semantic authority"), §14 invariant 24
 * ("Provider-specific SDK/types do not cross into core domain
 * modules").
 *
 * Work order ref: spec/work-orders/NET-W006.md §3.7 — external
 * measurement platforms integrate behind THIS provider-neutral
 * contract. The `/outcomes` domain imports ONLY this neutral port
 * (domain → neutral is allowed by the tier matrix); concrete
 * providers (browser/platform attribution, iOS attribution —
 * requirements ADAPTER-003..004) arrive as adapters under
 * `src/measurement/providers/` in NET-W022 and are wired by the
 * bootstrap composition root.
 *
 * Provider reports are measurement INPUTS: they are normalized into
 * outcome observations with `sourceType: "provider"`, the provider id
 * as the source id, and full method/version/confidence provenance.
 * A provider (or model) output is never authoritative truth by virtue
 * of its origin (architecture-lock §4) — the deterministic rollup
 * gate in `/outcomes` enforces that a finalized measurement requires
 * non-model, non-self sources.
 *
 * This file is the NEUTRAL tier (root port of the measurement
 * boundary): it may import ONLY core contracts. The tier allow
 * matrix classifies `measurement/port.ts` as neutral, so both the
 * `/outcomes` domain and concrete adapters may import it.
 */

import { OpenConError } from "../core/errors.ts";
import type { AttributionMode } from "../core/measurement.ts";
import type {
  ConfidenceEstimate,
  OutcomeType,
} from "../core/evidence.ts";

export type { AttributionMode, ConfidenceEstimate, OutcomeType };

/**
 * A single observation reported by an external measurement provider.
 * Provider-neutral: the report carries only normalized facts +
 * provenance — no provider payload, no platform-specific semantics.
 * The provider's raw response NEVER crosses this boundary (raw
 * platform state stays on the platform; architecture-lock §12.18).
 */
export interface ProviderObservationReport {
  /** The reporting provider's stable id (recorded as the source id). */
  readonly providerId: string;
  /**
   * The provider's own subject reference (opaque to the protocol).
   * Recorded on the observation as `externalSubjectRef` for
   * provenance/traceability.
   */
  readonly externalSubjectRef: string;
  /** Normalized outcome type from the OUT-001 vocabulary. */
  readonly outcomeType: OutcomeType;
  /** The measured value + unit. */
  readonly observedValue: { readonly value: number; readonly unit: string };
  /** Confidence with uncertainty (EVID-005 invariants apply). */
  readonly confidence: ConfidenceEstimate;
  /** Provider-neutral method identifier. */
  readonly method: string;
  /** Method/model version (REQUIRED — identity is never collapsed). */
  readonly methodVersion: string;
  /** When the provider collected the underlying material (ISO-8601). */
  readonly collectedAt: string;
  /**
   * OPTIONAL provider-reported attribution mode. When present the
   * ingestion path records it as the provider-reported attribution
   * basis on the observation (NOT as a protocol AttributionRecord —
   * provider-reported attribution is a provenance fact, not a
   * validated attribution).
   */
  readonly attributionMode?: AttributionMode;
}

/**
 * A request to fetch observations from a provider adapter. The
 * `subjectId` is the PROTOCOL subject id (typically a contribution);
 * the adapter maps it to the provider's own identifiers.
 */
export interface ProviderObservationFetchRequest {
  readonly subjectId: string;
  readonly subjectType: string;
  /** Fetch observations collected after this instant (ISO-8601), if any. */
  readonly since?: string;
}

/** The result of a provider fetch. */
export interface ProviderObservationFetchResult {
  readonly observations: readonly ProviderObservationReport[];
  /** Opaque continuation cursor (null when exhausted). */
  readonly nextCursor: string | null;
}

/**
 * MeasurementProviderAdapter — the provider-neutral contract every
 * external measurement platform integration implements (NET-W006
 * §3.7). Concrete adapters (NET-W022: browser/platform attribution,
 * iOS attribution) live in `src/measurement/providers/` and are wired
 * by the bootstrap composition root. The `/outcomes` domain consumes
 * only this interface — provider SDKs/types never cross into the
 * domain (architecture-lock §14.24).
 */
export interface MeasurementProviderAdapter {
  /** Adapter identity (recorded for provenance + health). */
  readonly info: {
    readonly kind: "measurement";
    readonly provider: string;
    readonly version: string;
  };
  /** Initialize the adapter (called once at composition time). */
  initialize(): Promise<void>;
  /** Health check (aggregated into runtime readiness). */
  healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  /**
   * Fetch provider observations for a protocol subject. Returns
   * NORMALIZED reports only — raw provider payloads stay on the
   * provider side of the adapter boundary.
   */
  fetchObservations(
    request: ProviderObservationFetchRequest,
  ): Promise<ProviderObservationFetchResult>;
  /**
   * NET-W022 (ADAPTER-003..004): normalize ONE raw, provider-shaped
   * attribution report (a pushed postback / platform report) into the
   * neutral report shape. OPTIONAL on purpose: adapters that only
   * serve the pull surface (e.g. the W006 echo reference) may omit
   * it — the ingestion service then fails CLOSED with the
   * `unsupported_push_ingestion` rejection (a provider that cannot
   * normalize pushed reports must never have them accepted).
   *
   * Implementations MUST: validate the vendor payload structure
   * (fail closed on malformed reports), resolve the provider-side
   * subject mapping (fail closed when ambiguous), enforce
   * mode-specific consistency, verify report integrity, and REDACT
   * every field beyond the neutral contract (privacy minimization —
   * only field NAMES may be reported back in
   * `redactedFieldNames`, never values). The verification secret is
   * injected at composition time and NEVER appears in the normalized
   * report, logs, or error context.
   */
  normalizeReport?(
    submission: RawProviderReportSubmission,
  ): Promise<AdapterReportNormalization>;
}

/**
 * NET-W022: a raw provider report submission (push ingestion). The
 * `payload` is the vendor-shaped report exactly as the platform
 * delivered it — OPAQUE at every tier except the adapter that owns
 * `providerId`. Provider SDK vocabulary must not cross into domain
 * authorities (issue #44 architectural constraints).
 */
export interface RawProviderReportSubmission {
  /** The registered provider adapter that owns this report shape. */
  readonly providerId: string;
  /** The raw vendor report payload (uninterpreted outside the adapter). */
  readonly payload: unknown;
}

/**
 * NET-W022: the result of ONE adapter's normalization of a raw
 * provider report. `redactedFieldNames` is a privacy-transparency
 * summary — the NAMES of dropped over-broad/vendor fields (values
 * NEVER cross the adapter boundary; PRIV-002/PRIV-003 minimization).
 */
export interface AdapterReportNormalization {
  readonly report: ProviderObservationReport;
  readonly redactedFieldNames: readonly string[];
}

/** NET-W022: normalization result at the ingestion boundary. */
export interface MeasurementReportNormalizationResult
  extends AdapterReportNormalization {
  /** The adapter version that performed the normalization. */
  readonly providerVersion: string;
}

/**
 * NET-W022: the closed rejection-reason vocabulary for provider
 * report ingestion (fail closed, stable reasons — the W019
 * gate-reason pattern):
 *
 *  - `malformed_report` — the raw payload violates the vendor shape.
 *  - `unsupported_attribution_mode` — the report claims an
 *    attribution mode the adapter does not accept (provider reports
 *    may claim deterministic/probabilistic attribution as a
 *    provenance fact; EXPERIMENTAL attribution is protocol-owned via
 *    /outcomes experiments and can never be claimed by a provider).
 *  - `invalid_attribution_mode` — mode-specific consistency failed
 *    (deterministic without a mechanical link; probabilistic WITH a
 *    mechanical link or WITHOUT a quantified interval).
 *  - `missing_provenance` — method/method-version/collectedAt absent.
 *  - `ambiguous_subject_mapping` — the provider-side subject mapping
 *    resolved to zero or multiple candidates.
 *  - `unverifiable_integrity` — the report's integrity fields are
 *    missing, use an unsupported algorithm, cannot be verified with
 *    the configured provider secret, or do not match the payload.
 *  - `unsupported_push_ingestion` — the addressed adapter does not
 *    accept pushed reports at all.
 */
export const MEASUREMENT_REPORT_REJECTION_REASONS = [
  "malformed_report",
  "unsupported_attribution_mode",
  "invalid_attribution_mode",
  "missing_provenance",
  "ambiguous_subject_mapping",
  "unverifiable_integrity",
  "unsupported_push_ingestion",
] as const;

export type MeasurementReportRejectionReason =
  (typeof MEASUREMENT_REPORT_REJECTION_REASONS)[number];

export function isMeasurementReportRejectionReason(
  value: string,
): value is MeasurementReportRejectionReason {
  return (
    MEASUREMENT_REPORT_REJECTION_REASONS as readonly string[]
  ).includes(value);
}

/**
 * NET-W022: the provider registration boundary. The composition root
 * registers every wired adapter; the ingestion service routes raw
 * report submissions by provider id. Registration validates adapter
 * identity (kind "measurement", non-empty provider + version) and
 * fails on duplicate provider ids — one adapter per provider identity.
 */
export interface MeasurementProviderRegistry {
  /** Register an adapter (composition root only). Fails closed on invalid/duplicate identity. */
  register(adapter: MeasurementProviderAdapter): void;
  /** The adapter registered under a provider id (undefined when unknown). */
  byProviderId(providerId: string): MeasurementProviderAdapter | undefined;
  /** All registered adapters (iteration order = registration order). */
  list(): readonly MeasurementProviderAdapter[];
  /** Aggregate health of every registered adapter. */
  checkHealth(): Promise<
    readonly {
      readonly provider: string;
      readonly ok: boolean;
      readonly detail?: string;
    }[]
  >;
}

/**
 * NET-W022: the provider-neutral ingestion boundary. Routes ONE raw
 * report submission to the adapter that owns its provider id and
 * returns the normalized neutral report. This boundary performs NO
 * mutation — persistence, idempotency and audit live in `/outcomes`
 * (the measurement-semantics authority), composed by the bootstrap
 * root. The adapter tier may not import domain modules (tier matrix).
 */
export interface MeasurementIngestionService {
  /**
   * Normalize one raw submission. Fail closed: unknown provider ids,
   * adapters without push support, and adapters that produce neutral
   * reports violating the neutral contract or claiming another
   * provider's identity are all rejected.
   */
  normalizeSubmission(
    submission: RawProviderReportSubmission,
  ): Promise<MeasurementReportNormalizationResult>;
  /** Aggregate health of the registered provider adapters. */
  checkHealth(): Promise<
    readonly {
      readonly provider: string;
      readonly ok: boolean;
      readonly detail?: string;
    }[]
  >;
}

/**
 * NET-W022: raised when a raw report is addressed to a provider id
 * that is not registered (fail closed — an unknown provider's report
 * can never enter the measurement layer).
 */
export class UnknownMeasurementProviderError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "UNKNOWN_MEASUREMENT_PROVIDER",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * NET-W022: raised when a raw provider report is rejected fail
 * closed (stable code MEASUREMENT_REPORT_REJECTED + the closed
 * {@link MEASUREMENT_REPORT_REJECTION_REASONS} reason vocabulary in
 * the error context). The context NEVER includes report payload
 * values or secret material — only the reason, the provider id, and
 * optionally a field name.
 */
export class MeasurementReportRejectedError extends OpenConError {
  public readonly reason: MeasurementReportRejectionReason;
  public constructor(
    reason: MeasurementReportRejectionReason,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "MEASUREMENT_REPORT_REJECTED",
      classification: "validation",
      message,
      retryable: false,
      context: { ...context, reason },
    });
    this.reason = reason;
  }
}

/**
 * The MeasurementPort describes the boundary's readiness. After
 * NET-W006 the boundary carries the provider-neutral adapter contract
 * (the integration surface); concrete platform adapters arrive in
 * NET-W022.
 */
export interface MeasurementPort {
  readonly boundary: "measurement";
  readonly readiness: "ready";
}
