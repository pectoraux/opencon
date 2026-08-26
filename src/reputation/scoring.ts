/**
 * Deterministic reputation scoring + time-decay engine (PURE).
 *
 * Architecture ref: spec/architecture.md §11 (multidimensional,
 * evidence-traced reputation), spec/architecture-lock.md §4 (model
 * output is input evidence, never authoritative — the indicated-only
 * cap makes this mechanical).
 *
 * Work order ref: spec/work-orders/NET-W007.md §3.4.
 *
 * Determinism contract (AC-02/AC-04): these functions perform NO I/O
 * and read NO wall clock. The decay reference timestamp is an explicit
 * parameter. Identical (rules, inputs, referenceAt) ALWAYS produce
 * bit-identical scores and digests: weights are rounded to
 * REPUTATION_SCORE_DECIMALS, scores are rounded to
 * REPUTATION_SCORE_DECIMALS, and the digest serializes at that fixed
 * precision so floating-point drift can never change a digest.
 *
 * REP-002 (not purchasable) is mechanical here: the engine consumes
 * only (dimension, basis, occurredAt) per input — there is no channel
 * through which spend, wealth, deposits, credits or raw activity
 * volume can enter, and inputs with ZERO verified backing are bounded
 * by the policy's indicatedOnlyCap.
 */

import { createHash } from "node:crypto";
import {
  REPUTATION_DIMENSIONS,
  REPUTATION_SCORE_DECIMALS,
  type ReputationDimension,
  type ReputationScoringRule,
} from "../core/reputation.ts";
import type {
  ReputationDimensionScore,
  ReputationInput,
} from "./port.ts";

const MS_PER_DAY = 86_400_000;

/** Deterministic fixed-precision rounding. */
export function round6(value: number): number {
  return Number(value.toFixed(REPUTATION_SCORE_DECIMALS));
}

/**
 * The exponential decay factor for one input (REP-003). Pure +
 * deterministic: `factor = 0.5 ^ (elapsedDays / halfLifeDays)`.
 *
 * Temporal scoping: callers exclude inputs whose `occurredAt` is after
 * `referenceAt` (see {@link computeDimensionScores}); this function
 * therefore only ever sees elapsed >= 0. A defensive clamp keeps the
 * factor <= 1 (future inputs can never earn decay BONUS).
 */
export function decayFactor(
  occurredAt: string,
  referenceAt: string,
  decayHalfLifeDays: number,
): number {
  const occurred = Date.parse(occurredAt);
  const reference = Date.parse(referenceAt);
  if (Number.isNaN(occurred)) {
    throw new Error(`decayFactor: occurredAt is not a valid timestamp: ${occurredAt}`);
  }
  if (Number.isNaN(reference)) {
    throw new Error(`decayFactor: referenceAt is not a valid timestamp: ${referenceAt}`);
  }
  if (decayHalfLifeDays <= 0) {
    throw new Error(`decayFactor: decayHalfLifeDays must be > 0 (got ${String(decayHalfLifeDays)})`);
  }
  const elapsedMs = Math.max(0, reference - occurred);
  const elapsedDays = elapsedMs / MS_PER_DAY;
  return Math.pow(0.5, elapsedDays / decayHalfLifeDays);
}

/**
 * Score ONE dimension from that dimension's inputs (independence is
 * mechanical — work order §4 invariant 1: this function is invoked
 * per dimension with ONLY that dimension's inputs).
 *
 * Caps (REP-002 + architecture-lock §4):
 *  - zero verified inputs → score = min(Σ indicatedWeight,
 *    indicatedOnlyCap): raw activity/model output alone is strictly
 *    bounded below maxScore;
 *  - ≥1 verified input → score = min(Σ weights, maxScore).
 */
export function computeDimensionScore(
  rule: ReputationScoringRule,
  dimensionInputs: readonly ReputationInput[],
  referenceAt: string,
): ReputationDimensionScore {
  let verifiedCount = 0;
  let indicatedCount = 0;
  let verifiedWeight = 0;
  let indicatedWeight = 0;
  for (const input of dimensionInputs) {
    // Temporal scoping: a snapshot at referenceAt covers events up to
    // referenceAt only (deterministic, no future leakage).
    if (Date.parse(input.occurredAt) > Date.parse(referenceAt)) continue;
    const factor = decayFactor(input.occurredAt, referenceAt, rule.decayHalfLifeDays);
    if (input.basis === "verified") {
      verifiedCount += 1;
      verifiedWeight += rule.inputWeight * factor;
    } else {
      indicatedCount += 1;
      indicatedWeight += rule.inputWeight * rule.indicatedWeightFactor * factor;
    }
  }
  const includedCount = verifiedCount + indicatedCount;
  let raw: number;
  let capped: boolean;
  if (verifiedCount === 0) {
    raw = indicatedWeight;
    capped = indicatedWeight > rule.indicatedOnlyCap;
    if (capped) raw = rule.indicatedOnlyCap;
  } else {
    raw = verifiedWeight + indicatedWeight;
    capped = raw > rule.maxScore;
    if (capped) raw = rule.maxScore;
  }
  return {
    dimension: rule.dimension,
    score: round6(raw),
    inputCount: includedCount,
    verifiedInputCount: verifiedCount,
    indicatedInputCount: indicatedCount,
    decayedVerifiedWeight: round6(verifiedWeight),
    decayedIndicatedWeight: round6(indicatedWeight),
    capped,
  };
}

/**
 * Compute ALL dimension scores from a rule set + the subject's inputs.
 * Each dimension is scored ONLY from its own inputs (independence).
 * The result order follows the frozen dimension vocabulary; dimensions
 * with no inputs score 0.
 */
export function computeDimensionScores(
  rules: readonly ReputationScoringRule[],
  inputs: readonly ReputationInput[],
  referenceAt: string,
): readonly ReputationDimensionScore[] {
  const byDimension = new Map<ReputationDimension, ReputationDimensionScore>();
  for (const rule of rules) {
    const dimensionInputs = inputs.filter((i) => i.dimension === rule.dimension);
    byDimension.set(rule.dimension, computeDimensionScore(rule, dimensionInputs, referenceAt));
  }
  // Emit every dimension in the frozen vocabulary order (missing rule
  // → zero score; the policy service enforces full coverage, this is
  // defense in depth).
  const out: ReputationDimensionScore[] = [];
  for (const dimension of REPUTATION_DIMENSIONS) {
    const score = byDimension.get(dimension);
    if (score) {
      out.push(score);
    } else {
      out.push({
        dimension,
        score: 0,
        inputCount: 0,
        verifiedInputCount: 0,
        indicatedInputCount: 0,
        decayedVerifiedWeight: 0,
        decayedIndicatedWeight: 0,
        capped: false,
      });
    }
  }
  return out;
}

/**
 * The input ids a computation covers: same-dimension inputs that
 * occurred at/before referenceAt, in a DETERMINISTIC order (dimension
 * vocabulary order, then occurredAt, then id) so the id list itself is
 * reproducible (AUD-004 reconstructability).
 */
export function includedInputIds(
  rules: readonly ReputationScoringRule[],
  inputs: readonly ReputationInput[],
  referenceAt: string,
): readonly string[] {
  const dimensions = new Set(rules.map((r) => r.dimension));
  const reference = Date.parse(referenceAt);
  const included = inputs.filter(
    (i) =>
      dimensions.has(i.dimension) &&
      !Number.isNaN(Date.parse(i.occurredAt)) &&
      Date.parse(i.occurredAt) <= reference,
  );
  const order = new Map(REPUTATION_DIMENSIONS.map((d, idx) => [d, idx] as const));
  included.sort((a, b) => {
    const da = order.get(a.dimension) ?? REPUTATION_DIMENSIONS.length;
    const db = order.get(b.dimension) ?? REPUTATION_DIMENSIONS.length;
    if (da !== db) return da - db;
    const oa = Date.parse(a.occurredAt);
    const ob = Date.parse(b.occurredAt);
    if (oa !== ob) return oa - ob;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return included.map((i) => i.id);
}

/**
 * The deterministic digest over a computation. Canonical
 * serialization at fixed precision: identical (policyId, version,
 * referenceAt, scores) → identical digest. Used by snapshots and by
 * the AC-02 reproducibility tests.
 */
export function computeScoresDigest(
  policyId: string,
  policyVersion: number,
  referenceAt: string,
  scores: readonly ReputationDimensionScore[],
): string {
  const canonical = JSON.stringify({
    policyId,
    policyVersion,
    referenceAt,
    scores: scores.map((s) => [
      s.dimension,
      s.score.toFixed(REPUTATION_SCORE_DECIMALS),
      s.inputCount,
      s.verifiedInputCount,
      s.indicatedInputCount,
      s.decayedVerifiedWeight.toFixed(REPUTATION_SCORE_DECIMALS),
      s.decayedIndicatedWeight.toFixed(REPUTATION_SCORE_DECIMALS),
      s.capped,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
