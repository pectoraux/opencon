/**
 * Shared reputation vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §4 (Reputation: a
 * multi-dimensional record derived from verified historical
 * performance), §11 (Reputation architecture: multidimensional, NOT
 * purchasable, each major change traceable to evidence),
 * spec/architecture-lock.md §4 (model/agent output is input evidence,
 * never authoritative), §14 (provider neutrality).
 *
 * Work order ref: spec/work-orders/NET-W007.md §3.1.
 * Requirements: REP-001 (dimension vocabulary), REP-002 (not
 * purchasable — the input contract simply carries no spend/wealth/
 * credit field), REP-003 (time decay parameters), REP-004 (provenance
 * via required upstream source references).
 *
 * The `/reputation` domain implements the behaviour; the vocabulary is
 * shared so infrastructure (API) and later work items consume the same
 * frozen terms. This module is data + pure validation ONLY — no I/O,
 * no wall clock, no scoring behaviour (the deterministic engine lives
 * in `/reputation/scoring.ts`).
 */

import { OpenConError } from "./errors.ts";

/**
 * The frozen reputation dimension vocabulary (architecture §11;
 * REP-001). Dimensions are INDEPENDENT: a dimension score is derived
 * only from that dimension's inputs (work order §4 invariant 1).
 */
export const REPUTATION_DIMENSIONS = [
  "helpfulness",
  "content_quality",
  "creator_performance",
  "inventory_quality",
  "measurement_reliability",
  "commerce_reliability",
  "fraud_resistance",
  "fulfillment_reliability",
] as const;

export type ReputationDimension = (typeof REPUTATION_DIMENSIONS)[number];

export function isReputationDimension(value: string): value is ReputationDimension {
  return (REPUTATION_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * The upstream record kinds that may back a reputation input (work
 * order §3.2). Every reputation input MUST reference at least one of
 * these — a bare activity/spend assertion cannot enter the system
 * (REP-002/REP-004).
 */
export const REPUTATION_INPUT_SOURCES = [
  "evidence",
  "proof_of_value",
  "measured_outcome",
  "contribution",
] as const;

export type ReputationInputSourceKind =
  (typeof REPUTATION_INPUT_SOURCES)[number];

export function isReputationInputSourceKind(
  value: string,
): value is ReputationInputSourceKind {
  return (REPUTATION_INPUT_SOURCES as readonly string[]).includes(value);
}

/**
 * The derived authority basis of a reputation input (work order §3.2).
 *
 *  - `verified`: at least one referenced upstream record resolves to
 *    verified-grade (a VERIFIED contribution/Proof-of-Value/measured
 *    outcome, or evidence from a platform/attested/provider source).
 *  - `indicated`: the input is backed only by model-assessed or
 *    self-reported evidence. Indicated inputs contribute at a reduced
 *    weight and can NEVER lift a dimension above the policy's
 *    `indicatedOnlyCap` — AI/model output remains non-authoritative
 *    (architecture-lock §4).
 *
 * The basis is DETERMINED by the reputation input service from the
 * resolved upstream records; it is never caller-asserted.
 */
export const REPUTATION_INPUT_BASES = ["verified", "indicated"] as const;

export type ReputationInputBasis = (typeof REPUTATION_INPUT_BASES)[number];

export function isReputationInputBasis(value: string): value is ReputationInputBasis {
  return (REPUTATION_INPUT_BASES as readonly string[]).includes(value);
}

/**
 * The evidence source types that yield a `verified` basis. `model` and
 * `self` evidence yield an `indicated` basis only (architecture-lock
 * §4: model output is input evidence, never authoritative).
 */
export const VERIFIED_GRADE_EVIDENCE_SOURCE_TYPES = [
  "platform",
  "attested",
  "provider",
] as const;

/**
 * The deterministic, per-dimension scoring-rule parameters (work order
 * §3.3/§3.4). A scoring policy carries exactly one rule per dimension.
 * All parameters are finite numbers; identical rule parameters +
 * identical inputs + identical referenceAt ALWAYS produce identical
 * scores (no hidden state, no wall clock).
 */
export interface ReputationScoringRule {
  readonly dimension: ReputationDimension;
  /** Weight contributed by a single verified input (> 0). */
  readonly inputWeight: number;
  /** Decay half-life in days (> 0). REP-003. */
  readonly decayHalfLifeDays: number;
  /** Maximum achievable dimension score (> 0). */
  readonly maxScore: number;
  /** Weight factor applied to `indicated`-basis inputs, ∈ [0, 1]. */
  readonly indicatedWeightFactor: number;
  /**
   * The score bound that applies when a dimension has ZERO verified
   * inputs (raw activity / model output alone). ∈ [0, maxScore) —
   * strictly below maxScore so indicated-only input can never reach a
   * fully verified score (REP-002, architecture-lock §4).
   */
  readonly indicatedOnlyCap: number;
}

/**
 * Deterministic decimal precision for scores, weights and digests.
 * Scores are rounded to this precision; digests serialize at this
 * precision, so floating-point drift can never change a digest.
 */
export const REPUTATION_SCORE_DECIMALS = 6;

/**
 * Validate a scoring rule (pure). Throws {@link OpenConError} with the
 * stable code `REPUTATION_POLICY_VALIDATION` on any violation:
 * unknown dimension, non-finite numbers, or parameters outside their
 * deterministic bounds.
 */
export function validateReputationScoringRule(
  rule: ReputationScoringRule,
): ReputationScoringRule {
  if (!isReputationDimension(rule.dimension)) {
    throw new OpenConError({
      code: "REPUTATION_POLICY_VALIDATION",
      classification: "validation",
      message: `scoring rule dimension must be one of the standard reputation dimensions (got ${String(rule.dimension)})`,
      context: { dimension: rule.dimension },
    });
  }
  const numeric: ReadonlyArray<[keyof ReputationScoringRule, number]> = [
    ["inputWeight", rule.inputWeight],
    ["decayHalfLifeDays", rule.decayHalfLifeDays],
    ["maxScore", rule.maxScore],
    ["indicatedWeightFactor", rule.indicatedWeightFactor],
    ["indicatedOnlyCap", rule.indicatedOnlyCap],
  ];
  for (const [field, value] of numeric) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new OpenConError({
        code: "REPUTATION_POLICY_VALIDATION",
        classification: "validation",
        message: `scoring rule field ${field} must be a finite number (got ${String(value)})`,
        context: { dimension: rule.dimension, field, value },
      });
    }
  }
  if (rule.inputWeight <= 0) {
    throw new OpenConError({
      code: "REPUTATION_POLICY_VALIDATION",
      classification: "validation",
      message: `scoring rule inputWeight must be > 0 (got ${String(rule.inputWeight)})`,
      context: { dimension: rule.dimension, inputWeight: rule.inputWeight },
    });
  }
  if (rule.decayHalfLifeDays <= 0) {
    throw new OpenConError({
      code: "REPUTATION_POLICY_VALIDATION",
      classification: "validation",
      message: `scoring rule decayHalfLifeDays must be > 0 (got ${String(rule.decayHalfLifeDays)})`,
      context: { dimension: rule.dimension, decayHalfLifeDays: rule.decayHalfLifeDays },
    });
  }
  if (rule.maxScore <= 0) {
    throw new OpenConError({
      code: "REPUTATION_POLICY_VALIDATION",
      classification: "validation",
      message: `scoring rule maxScore must be > 0 (got ${String(rule.maxScore)})`,
      context: { dimension: rule.dimension, maxScore: rule.maxScore },
    });
  }
  if (rule.indicatedWeightFactor < 0 || rule.indicatedWeightFactor > 1) {
    throw new OpenConError({
      code: "REPUTATION_POLICY_VALIDATION",
      classification: "validation",
      message: `scoring rule indicatedWeightFactor must be within [0, 1] (got ${String(rule.indicatedWeightFactor)})`,
      context: {
        dimension: rule.dimension,
        indicatedWeightFactor: rule.indicatedWeightFactor,
      },
    });
  }
  if (rule.indicatedOnlyCap < 0 || rule.indicatedOnlyCap >= rule.maxScore) {
    throw new OpenConError({
      code: "REPUTATION_POLICY_VALIDATION",
      classification: "validation",
      message: `scoring rule indicatedOnlyCap must be within [0, maxScore) so indicated-only input can never reach a fully verified score (got ${String(rule.indicatedOnlyCap)}, maxScore ${String(rule.maxScore)})`,
      context: {
        dimension: rule.dimension,
        indicatedOnlyCap: rule.indicatedOnlyCap,
        maxScore: rule.maxScore,
      },
    });
  }
  return rule;
}

export { OpenConError };
