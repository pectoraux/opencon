/**
 * Evidence aggregation — deterministic combination of evidence from
 * multiple independent sources (NET-W005 §3.7; EVID-004).
 *
 * The aggregation is a PURE function over durable evidence records:
 *
 *  - Point estimate: grade-weighted mean of the contributing point
 *    estimates (weights: MEASURED 1.0, ATTESTED 0.8,
 *    PROVIDER_REPORTED 0.6, MODEL_ASSESSED 0.3, SELF_REPORTED 0.2 —
 *    evidential strength for CONFIDENCE combination only, never
 *    economic value).
 *  - Uncertainty: a conservative envelope — lower = min over
 *    contributing records of (lower ?? point), upper = max of
 *    (upper ?? point). null when no record quantifies an interval
 *    (EVID-005: uncertainty is preserved, never manufactured).
 *  - Independence: the count of distinct sources, keyed by
 *    `sourceId ?? "unknown:<sourceType>"` — records from the same
 *    source are NOT independent (conservative).
 *  - Dominant grade: the grade with the highest total weight (ties
 *    broken by better rank — deterministic).
 *
 * Privacy (work order §4 invariant 1, AC-04): aggregation consumes
 * ONLY the durable evidence records (metadata + confidence +
 * commitments). It never touches raw payloads — sensitive records
 * carry none, and the aggregate result contains no payload fields by
 * construction.
 *
 * Determinism: same input records (in the same order) → same output.
 * The function is order-insensitive for the weighted mean (sums are
 * commutative); gradesPresent is sorted by rank.
 */

import type { EvidenceGrade, EvidenceSourceType } from "../core/evidence.ts";
import { EVIDENCE_GRADE_RANK } from "../core/evidence.ts";
import { EVIDENCE_GRADE_WEIGHTS, gradesOrderedBestFirst } from "./grade-rules.ts";
import type { AggregateEvidenceResult, Evidence } from "./port.ts";
import { OpenConError } from "../core/errors.ts";

/** The source key used for the independence count (conservative). */
function sourceKeyOf(evidence: Evidence): string {
  const provenance = evidence.provenance;
  return provenance.sourceId !== undefined && provenance.sourceId !== ""
    ? provenance.sourceId
    : `unknown:${provenance.sourceType}`;
}

/**
 * Aggregate evidence records from multiple sources (EVID-004).
 * Throws when `records` is empty (nothing to aggregate — a
 * deterministic validation error, not a fallback estimate).
 */
export function aggregateEvidence(records: readonly Evidence[]): AggregateEvidenceResult {
  if (records.length === 0) {
    throw new OpenConError({
      code: "AGGREGATION_REQUIRES_EVIDENCE",
      classification: "validation",
      message: "evidence aggregation requires at least one evidence record",
      retryable: false,
      context: {},
    });
  }

  let totalWeight = 0;
  let weightedPointSum = 0;
  let lowerBound = Number.POSITIVE_INFINITY;
  let upperBound = Number.NEGATIVE_INFINITY;
  let anyInterval = false;
  const sources = new Set<string>();
  const weightByGrade = new Map<EvidenceGrade, number>();
  const grades = new Set<EvidenceGrade>();

  for (const record of records) {
    const weight = EVIDENCE_GRADE_WEIGHTS[record.grade];
    const point = record.confidence.point;
    totalWeight += weight;
    weightedPointSum += weight * point;
    sources.add(sourceKeyOf(record));
    grades.add(record.grade);
    weightByGrade.set(record.grade, (weightByGrade.get(record.grade) ?? 0) + weight);
    const lower = record.confidence.lower ?? point;
    const upper = record.confidence.upper ?? point;
    if (record.confidence.lower !== undefined || record.confidence.upper !== undefined) {
      anyInterval = true;
    }
    if (lower < lowerBound) lowerBound = lower;
    if (upper > upperBound) upperBound = upper;
  }

  const aggregatePoint = weightedPointSum / totalWeight;

  // Dominant grade: highest total weight; ties → better (lower) rank.
  let dominantGrade: EvidenceGrade = records[0]!.grade;
  let dominantWeight = -1;
  for (const [grade, weight] of weightByGrade) {
    if (
      weight > dominantWeight ||
      (weight === dominantWeight &&
        EVIDENCE_GRADE_RANK[grade] < EVIDENCE_GRADE_RANK[dominantGrade])
    ) {
      dominantGrade = grade;
      dominantWeight = weight;
    }
  }

  const gradesPresent = Array.from(grades).sort(gradesOrderedBestFirst);

  const result: AggregateEvidenceResult = {
    evidenceCount: records.length,
    independentSources: sources.size,
    aggregatePoint,
    aggregateInterval: anyInterval
      ? Object.freeze({ lower: lowerBound, upper: upperBound })
      : null,
    dominantGrade,
    gradesPresent,
    totalWeight,
  };
  return Object.freeze(result);
}

/**
 * Whether the record set contains at least one record whose grade can
 * independently support a VERIFIED Proof-of-Value (MEASURED or
 * ATTESTED — architecture-lock §4: never model/self-assessed alone).
 */
export function hasHighSupportEvidence(records: readonly Evidence[]): boolean {
  return records.some((r) => EVIDENCE_GRADE_RANK[r.grade] <= EVIDENCE_GRADE_RANK["ATTESTED"]);
}

export type { EvidenceSourceType };
