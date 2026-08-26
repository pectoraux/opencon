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
