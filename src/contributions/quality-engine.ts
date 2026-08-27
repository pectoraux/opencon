/**
 * The PURE quality evaluation engine — NET-W013.
 *
 * Work order ref: spec/work-orders/NET-W013.md §3.3.
 * Architecture ref: spec/architecture.md §14 (AI outputs are evidence
 * inputs, never unilateral truth), §12 (no single signal is
 * authoritative), architecture-lock §4/§5.
 *
 * THE BINDING INVARIANTS (work order §4), enforced STRUCTURALLY:
 *
 *  1. DETERMINISTIC. This module is PURE: no I/O, no clock, no
 *     randomness. The caller supplies every resolved fact; identical
 *     (policy, facts) pairs always produce identical results.
 *
 *  2. MENTION ≠ QUALITY (HELP-002). The engine input carries NO
 *     mention field AT ALL. There is no code path — no weight, no
 *     bonus, no threshold adjustment — through which a product
 *     mention contributes to a quality score.
 *
 *  3. AI IS ADVISORY AND PROVIDER-NEUTRAL (AI-004). Advisory scores
 *     blend into the total at the policy's bounded
 *     `advisoryWeightFactor` — they assist, never dominate — and the
 *     structural `advisoryOnlyCapBand` composition means an
 *     advisory-only fact set can NEVER certify a top band (at best
 *     ADEQUATE, validated by the core policy validator).
 *
 *  4. FAIL-CLOSED. A required input kind with zero qualifying facts
 *     floors the band at `missingInputFloorBand` (at best
 *     LOW_QUALITY, validated by the core policy validator).
 */

import { EVIDENCE_GRADE_RANK } from "../core/evidence.ts";
import type { EvidenceGrade } from "../core/evidence.ts";
import { isQualifyingHelpfulnessSourceType } from "../core/contributions.ts";
import { worseQualityBand } from "../core/moderation.ts";
import type {
  QualityAdvisoryRules,
  QualityBand,
  QualityInputKind,
  QualityInputRule,
  QualityStructuralRules,
  QualityThresholds,
} from "../core/moderation.ts";
import type { QualityInputContribution } from "./port.ts";

/** The policy view the engine consumes (structural, provider-neutral). */
export interface QualityEnginePolicy {
  readonly inputs: readonly QualityInputRule[];
  readonly advisory: QualityAdvisoryRules;
  readonly minimumGrade: EvidenceGrade;
  readonly qualifyingSourceTypes: readonly string[];
  readonly qualifyingOutcomeTypes: readonly string[];
  readonly minimumConfidence: number;
  readonly thresholds: QualityThresholds;
  readonly structural: QualityStructuralRules;
}

/** The PoH aggregate fact (resolved by the service, same-domain). */
export interface QualityPohFact {
  readonly state: string;
  readonly qualifyingBasisCount: number;
  readonly independentSourceCount: number;
}

/** An evidence-record resolution (re-resolved through the lookups). */
export interface QualityEvidenceFact {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly sourceType: string;
  readonly grade: EvidenceGrade;
  readonly confidencePoint: number;
}

/** A measured-outcome resolution (re-resolved through the lookups). */
export interface QualityMeasuredOutcomeFact {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly outcomeType: string;
  readonly state: string;
  readonly rollupConfidencePoint: number | null;
}

/** A proof-of-value resolution (re-resolved through the lookups). */
export interface QualityPovFact {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly state: string;
}

/**
 * The resolved fact set. NOTE: there is deliberately NO mention field
 * — product mentions are structurally absent from quality evaluation
 * (HELP-002).
 */
export interface QualityEngineFacts {
  readonly proofOfHelpfulness: QualityPohFact | null;
  readonly evidenceRecords: readonly QualityEvidenceFact[];
  readonly measuredOutcomes: readonly QualityMeasuredOutcomeFact[];
  readonly proofsOfValue: readonly QualityPovFact[];
  readonly advisoryScores: readonly {
    readonly id: string;
    readonly kind: string;
    readonly score: number;
  }[];
}

export interface QualityEngineInput {
  readonly policy: QualityEnginePolicy;
  readonly facts: QualityEngineFacts;
  readonly organizationScopeId: string;
  readonly contributionId: string;
}

export interface QualityEngineResult {
  readonly inputContributions: readonly QualityInputContribution[];
  readonly advisoryCount: number;
  readonly advisoryAverage: number | null;
  /** The normalized score ∈ [0,1] (the persisted form is scaled). */
  readonly score: number;
  readonly band: QualityBand;
  readonly reasons: readonly string[];
  readonly evaluator: "deterministic_policy_v1";
}

/** Grade strength: lower rank = STRONGER (the frozen ordering). */
function gradeAtLeast(grade: EvidenceGrade, minimum: EvidenceGrade): boolean {
  const g = EVIDENCE_GRADE_RANK[grade];
  const m = EVIDENCE_GRADE_RANK[minimum];
  return g !== undefined && m !== undefined && g <= m;
}

function countsAuthoritativeSubject(
  fact: { readonly organizationScopeId: string; readonly subjectId: string; readonly subjectType: string },
  input: QualityEngineInput,
): boolean {
  return (
    fact.organizationScopeId === input.organizationScopeId &&
    fact.subjectType === "contribution" &&
    fact.subjectId === input.contributionId
  );
}

/**
 * Count the qualifying instances of one input kind over the resolved
 * facts — PURE.
 */
export function countQualifyingInput(
  input: QualityEngineInput,
  kind: QualityInputKind,
): number {
  switch (kind) {
    case "proof_of_helpfulness": {
      const poh = input.facts.proofOfHelpfulness;
      return poh !== null && poh.state === "QUALIFIED" ? 1 : 0;
    }
    case "evidence_record": {
      let count = 0;
      for (const r of input.facts.evidenceRecords) {
        if (!countsAuthoritativeSubject(r, input)) continue;
        if (!isQualifyingHelpfulnessSourceType(r.sourceType)) continue;
        if (!input.policy.qualifyingSourceTypes.includes(r.sourceType)) continue;
        if (!gradeAtLeast(r.grade, input.policy.minimumGrade)) continue;
        if (r.confidencePoint < input.policy.minimumConfidence) continue;
        count += 1;
      }
      return count;
    }
    case "measured_outcome": {
      let count = 0;
      for (const m of input.facts.measuredOutcomes) {
        if (!countsAuthoritativeSubject(m, input)) continue;
        if (m.state !== "VERIFIED") continue;
        if (!input.policy.qualifyingOutcomeTypes.includes(m.outcomeType)) continue;
        if (m.rollupConfidencePoint === null) continue;
        if (m.rollupConfidencePoint < input.policy.minimumConfidence) continue;
        count += 1;
      }
      return count;
    }
    case "proof_of_value": {
      let count = 0;
      for (const p of input.facts.proofsOfValue) {
        if (!countsAuthoritativeSubject(p, input)) continue;
        if (p.state !== "VERIFIED") continue;
        count += 1;
      }
      return count;
    }
    default:
      return 0;
  }
}

/**
 * Evaluate the contribution quality — PURE and DETERMINISTIC.
 *
 *  1. per configured input kind: attainment ∈ [0,1] over the
 *     re-resolved authoritative facts;
 *  2. `authoritative = Σ(weight·attainment)/Σ(weight)`;
 *  3. advisory composition (when advisory scores exist):
 *     `score = (1-f)·authoritative + f·advisoryAverage` with
 *     `f = advisoryWeightFactor ≤ 1`; absent advisory scores leave the
 *     authoritative score untouched;
 *  4. band from the monotonic thresholds, then the STRUCTURAL
 *     composition: advisory-only cap + missing-required-input floor
 *     (both move the band toward WORSE).
 */
export function evaluateQuality(input: QualityEngineInput): QualityEngineResult {
  const reasons: string[] = [];

  // 1 + 2 — per-input attainment and the authoritative aggregate.
  const inputContributions: QualityInputContribution[] = [];
  const totalWeight = input.policy.inputs.reduce(
    (acc, rule) => acc + rule.weight,
    0,
  );
  let weightedAttainment = 0;
  const counts = new Map<QualityInputKind, number>();
  for (const rule of input.policy.inputs) {
    const count = countQualifyingInput(input, rule.kind);
    counts.set(rule.kind, count);
    const attainment =
      rule.minimumCount <= 0
        ? count > 0
          ? 1
          : 0
        : Math.min(1, count / rule.minimumCount);
    weightedAttainment += rule.weight * attainment;
    inputContributions.push({
      kind: rule.kind,
      count,
      attainment,
      weight: rule.weight,
    });
    reasons.push(
      `input ${rule.kind}: ${String(count)} qualifying fact(s) (attainment ${attainment.toFixed(4)} at weight ${String(rule.weight)})`,
    );
  }
  const authoritative =
    totalWeight > 0 ? weightedAttainment / totalWeight : 0;

  // 3 — advisory composition (bounded; never dominating).
  const allowedAdvisory = input.facts.advisoryScores.filter((s) =>
    input.policy.advisory.allowedKinds.includes(s.kind as never),
  );
  const advisoryCount = allowedAdvisory.length;
  const advisoryAverage =
    advisoryCount > 0
      ? allowedAdvisory.reduce((acc, s) => acc + s.score, 0) / advisoryCount
      : null;
  const f = input.policy.advisory.advisoryWeightFactor;
  let score: number;
  if (advisoryAverage === null) {
    score = authoritative;
    reasons.push(
      `no advisory scores — the score is the authoritative aggregate ${authoritative.toFixed(4)}`,
    );
  } else {
    score = (1 - f) * authoritative + f * advisoryAverage;
    reasons.push(
      `advisory composition: (1-${String(f)})·${authoritative.toFixed(4)} + ${String(f)}·${advisoryAverage.toFixed(4)} = ${score.toFixed(4)} (AI assists at bounded weight, never dominates)`,
    );
  }
  score = Math.max(0, Math.min(1, score));

  // 4 — band from the thresholds.
  const t = input.policy.thresholds;
  let band: QualityBand;
  if (score >= t.highQualityAt) band = "HIGH_QUALITY";
  else if (score >= t.adequateAt) band = "ADEQUATE";
  else if (score >= t.lowQualityAt) band = "LOW_QUALITY";
  else band = "UNSATISFACTORY";

  // Structural composition ① — the advisory-only cap: with NO
  // qualifying authoritative facts, advisory evidence alone can never
  // certify a top band.
  const totalQualifying = Array.from(counts.values()).reduce(
    (acc, c) => acc + c,
    0,
  );
  if (totalQualifying === 0) {
    const capped = worseQualityBand(band, input.policy.structural.advisoryOnlyCapBand);
    if (capped !== band) {
      reasons.push(
        `structural advisory-only cap applied: no qualifying authoritative facts, so the band is capped at ${input.policy.structural.advisoryOnlyCapBand} (AI output is never the sole basis for a final determination)`,
      );
      band = capped;
    } else {
      reasons.push(
        `structural advisory-only cap noted (${input.policy.structural.advisoryOnlyCapBand}); the threshold band is already at or below the cap`,
      );
    }
  }

  // Structural composition ② — the missing-required-input floor
  // (fail-closed).
  for (const kind of input.policy.structural.requiredInputs) {
    if ((counts.get(kind) ?? 0) === 0) {
      const floored = worseQualityBand(
        band,
        input.policy.structural.missingInputFloorBand,
      );
      if (floored !== band) {
        reasons.push(
          `structural missing-input floor applied: required input ${kind} has no qualifying facts, so the band is floored at ${input.policy.structural.missingInputFloorBand} (fail-closed)`,
        );
        band = floored;
      } else {
        reasons.push(
          `required input ${kind} has no qualifying facts (missing-input floor ${input.policy.structural.missingInputFloorBand} already satisfied)`,
        );
      }
    }
  }

  return {
    inputContributions,
    advisoryCount,
    advisoryAverage,
    score,
    band,
    reasons,
    evaluator: "deterministic_policy_v1",
  };
}
