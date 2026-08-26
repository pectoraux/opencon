/**
 * Evidence and Proof-of-Value vocabulary — shared contracts for the
 * evidence layer (NET-W005).
 *
 * Work order ref: spec/work-orders/NET-W005.md
 *   §3.1 Evidence first-class model (provenance, confidence, grade).
 *   §3.2 Evidence grades — deterministic (explicit rule table).
 *   §3.3 Confidence and uncertainty (EVID-005).
 *   §3.4 Outcome claims (OUT-001 vocabulary, provider-neutral).
 *   §3.6 Evidence commitments (EVID-006).
 *
 * Architecture ref: spec/architecture.md §4 (Evidence / Outcome /
 * Proof-of-Value primitives), §18 (`/evidence`, `/outcomes` module
 * ownership); spec/architecture-lock.md §4 (evidence authority:
 * agent/model output is input evidence, never authoritative), §6
 * (privacy authority: sensitive evidence may remain off-chain;
 * commitments + attestations prove integrity without publishing raw
 * personal data), §11..§12 (data authority invariants).
 *
 * This file lives in `src/core/` so it can be imported by EVERY tier
 * that consumes evidence vocabulary (the `/evidence` domain in
 * NET-W005; `/outcomes`, `/reputation`, `/settlement` in later work
 * items) without violating the tier allow matrix (domain→core is
 * permitted; domain→other-domain is not). The grade RULE TABLE lives
 * in the `/evidence` domain (grade-rules.ts) — it is evidence-domain
 * behaviour; this file declares only the shared vocabulary + errors.
 *
 * No economically material behaviour (credit issuance, settlement,
 * reputation mutation, fraud decisions) is introduced by this file.
 * The vocabulary is pure data: outcome types, grades, confidence
 * estimates, provenance records, commitments.
 */

import { OpenConError } from "./errors.ts";

/**
 * The protocol's standard outcome vocabulary (requirements OUT-001,
 * architecture §4 "Outcome"). Provider-neutral: a claim about a
 * measured outcome names one of these types; measurement semantics
 * and attribution modes are NET-W006 (`/outcomes`) — NET-W005 only
 * carries the vocabulary on outcome CLAIMS.
 */
export const STANDARD_OUTCOME_TYPES = [
  "view",
  "attention",
  "engagement",
  "intent",
  "install",
  "signup",
  "purchase",
  "subscription",
  "retention",
  "referral",
  "savings",
  "fulfillment",
  "helpfulness",
] as const;

export type OutcomeType = (typeof STANDARD_OUTCOME_TYPES)[number];

export function isStandardOutcomeType(value: string): value is OutcomeType {
  return (STANDARD_OUTCOME_TYPES as readonly string[]).includes(value);
}

/**
 * Evidence source types — where the evidence record came from. The
 * source type is the SOLE input to the deterministic grade rule table
 * (NET-W005 §3.2):
 *
 *  - `platform`: measured by the platform's own instrumentation.
 *  - `attested`: attested by an independent verifier.
 *  - `provider`: reported by an external provider/platform through an
 *    adapter, with provenance.
 *  - `model`: produced by an AI/agent model. Admissible as INPUT
 *    evidence but NEVER authoritative (architecture-lock §4).
 *  - `self`: reported by the participant about their own activity.
 */
export const EVIDENCE_SOURCE_TYPES = [
  "platform",
  "attested",
  "provider",
  "model",
  "self",
] as const;

export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export function isEvidenceSourceType(value: string): value is EvidenceSourceType {
  return (EVIDENCE_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Evidence grades — the deterministic quality tier of an evidence
 * record, derived ONLY from its provenance source type by the rule
 * table in `/evidence/grade-rules.ts` (NET-W005 §3.2):
 *
 *  - `MEASURED`: platform-measured (best).
 *  - `ATTESTED`: independently attested.
 *  - `PROVIDER_REPORTED`: external provider report with provenance.
 *  - `MODEL_ASSESSED`: AI/model assessment — input evidence only.
 *  - `SELF_REPORTED`: participant self-report (weakest).
 *
 * The rank order is fixed; a Proof-of-Value can reach VERIFIED only
 * with at least one MEASURED or ATTESTED record (work order §3.8 —
 * model/self-assessed evidence alone is never sufficient).
 */
export const EVIDENCE_GRADES = [
  "MEASURED",
  "ATTESTED",
  "PROVIDER_REPORTED",
  "MODEL_ASSESSED",
  "SELF_REPORTED",
] as const;

export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export function isEvidenceGrade(value: string): value is EvidenceGrade {
  return (EVIDENCE_GRADES as readonly string[]).includes(value);
}

/** The fixed rank of a grade (1 = best). Used for ordering + tiebreaks. */
export const EVIDENCE_GRADE_RANK: Readonly<Record<EvidenceGrade, number>> = Object.freeze({
  MEASURED: 1,
  ATTESTED: 2,
  PROVIDER_REPORTED: 3,
  MODEL_ASSESSED: 4,
  SELF_REPORTED: 5,
});

/**
 * A confidence estimate with uncertainty (EVID-005: preserve
 * uncertainty/confidence intervals where meaningful; unsupported
 * exact claims are not manufactured).
 *
 * Invariants (validated by {@link validateConfidenceEstimate}):
 *  - `point` ∈ [0, 1].
 *  - when `lower`/`upper` are present: `0 <= lower <= point <= upper
 *    <= 1` (an interval MUST bracket the point estimate).
 *  - `method` describes HOW the confidence was derived (free-form,
 *    provider-neutral; recorded for auditability).
 */
export interface ConfidenceEstimate {
  /** Point estimate in [0, 1]. */
  readonly point: number;
  /** Optional interval lower bound (<= point). */
  readonly lower?: number;
  /** Optional interval upper bound (>= point). */
  readonly upper?: number;
  /** How the confidence was derived (e.g. "platform-counter", "sampled"). */
  readonly method?: string;
}

/**
 * Validate a confidence estimate against the EVID-005 invariants.
 * Returns a normalized copy (interval fields dropped when absent) or
 * throws {@link InvalidConfidenceError}.
 */
export function validateConfidenceEstimate(
  estimate: ConfidenceEstimate,
): ConfidenceEstimate {
  const { point, lower, upper } = estimate;
  if (typeof point !== "number" || !Number.isFinite(point) || point < 0 || point > 1) {
    throw new InvalidConfidenceError(
      `confidence point must be a finite number in [0, 1] (got ${String(point)})`,
      { point },
    );
  }
  if (lower !== undefined) {
    if (typeof lower !== "number" || !Number.isFinite(lower) || lower < 0 || lower > point) {
      throw new InvalidConfidenceError(
        `confidence lower bound must be a finite number in [0, point] (got ${String(lower)}, point ${point})`,
        { lower, point },
      );
    }
  }
  if (upper !== undefined) {
    if (typeof upper !== "number" || !Number.isFinite(upper) || upper > 1 || upper < point) {
      throw new InvalidConfidenceError(
        `confidence upper bound must be a finite number in [point, 1] (got ${String(upper)}, point ${point})`,
        { upper, point },
      );
    }
  }
  const normalized: ConfidenceEstimate = {
    point,
    ...(lower !== undefined ? { lower } : {}),
    ...(upper !== undefined ? { upper } : {}),
    ...(estimate.method !== undefined ? { method: estimate.method } : {}),
  };
  return Object.freeze(normalized);
}

/**
 * Evidence provenance (EVID-002: evidence records provenance, method,
 * timestamp, scope and confidence). The provenance record is the
 * deterministic input to the grade rule table.
 */
export interface ProvenanceRecord {
  /** Where the evidence came from (see EVIDENCE_SOURCE_TYPES). */
  readonly sourceType: EvidenceSourceType;
  /**
   * Stable identifier of the source (provider id, verifier id, model
   * id, participant id...). Optional: platform instrumentation may be
   * its own source. Aggregation counts distinct sources using
   * `sourceId ?? "unknown:<sourceType>"`.
   */
  readonly sourceId?: string;
  /** How the evidence was produced (provider-neutral description). */
  readonly method: string;
  /** When the underlying material was collected (ISO-8601). */
  readonly collectedAt: string;
  /** Who collected/recorded it (participant or service id), if known. */
  readonly collectorId?: string;
}

/**
 * Supported commitment hash algorithms (EVID-006). Standard
 * cryptographic digests — deterministic, provider-neutral, no
 * external dependency.
 */
export const COMMITMENT_ALGORITHMS = ["sha256", "sha512"] as const;

export type CommitmentAlgorithm = (typeof COMMITMENT_ALGORITHMS)[number];

export function isCommitmentAlgorithm(value: string): value is CommitmentAlgorithm {
  return (COMMITMENT_ALGORITHMS as readonly string[]).includes(value);
}

/**
 * A cryptographic commitment over sensitive evidence material
 * (EVID-006). The durable evidence record stores the commitment; the
 * raw material stays off-record (architecture-lock §6). Integrity is
 * verified by recomputing the digest when the plaintext is presented.
 *
 *  - `algorithm`: the digest algorithm ("sha256" | "sha512").
 *  - `digest`: hex-encoded digest of the committed material.
 *  - `salt`: optional salt mixed into the digest input. Storing the
 *    salt beside the digest is standard practice (it enables
 *    verification while preventing precomputation/rainbow attacks on
 *    low-entropy material); it reveals nothing about the material.
 */
export interface EvidenceCommitment {
  readonly algorithm: CommitmentAlgorithm;
  readonly digest: string;
  readonly salt?: string;
}

/** Raised when an outcome claim names a type outside OUT-001's vocabulary. */
export class UnsupportedOutcomeTypeError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "UNSUPPORTED_OUTCOME_TYPE",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/** Raised when a confidence estimate violates the EVID-005 invariants. */
export class InvalidConfidenceError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVALID_CONFIDENCE_ESTIMATE",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/** Raised when an evidence commitment is malformed or fails verification. */
export class InvalidCommitmentError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVALID_EVIDENCE_COMMITMENT",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/** Raised when an attestation is malformed, covers no evidence, or fails verification. */
export class InvalidAttestationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVALID_ATTESTATION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}
