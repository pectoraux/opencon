/**
 * The PURE Proof-of-Helpfulness evaluation engine.
 *
 * Work order ref: spec/work-orders/NET-W012.md §3.3.
 * Architecture ref: spec/architecture-lock.md §4 (model/self evidence
 * is never solely authoritative), §1 invariant 9 (commercial
 * recommendations must preserve required disclosure and must not
 * condition reward on positive sentiment).
 *
 * THE BINDING INVARIANTS (work order §4), enforced STRUCTURALLY:
 *
 *  1. MENTION ≠ HELPFULNESS. The engine input carries mentions ONLY
 *     for disclosure compliance. There is NO code path — no weight, no
 *     score, no bonus, no threshold adjustment — through which a
 *     mention contributes to qualification. Mentions are not an input
 *     to `qualifyingBasisCount` or `independentSourceCount`.
 *
 *  2. HELPFULNESS IS EVIDENCED. `outcome === "QUALIFIED"` requires at
 *     least `policy.sections.minimumQualifyingBases` bases that EACH
 *     resolve through the truth authorities (the resolved views are
 *     supplied by the caller — the domain service re-resolves them at
 *     evaluation time through the neutral lookups) with grade,
 *     confidence/uncertainty and provenance.
 *
 *  3. AI IS ADVISORY. Advisory scores appear ONLY in the recorded
 *     evaluation metadata (`advisoryCount`). They never add a basis,
 *     never count as an independent source, and never flip an outcome.
 *     MODEL_ASSESSED / SELF_REPORTED grades and `model` / `self`
 *     source types can never qualify (the qualifying-source-type
 *     check rejects them before the grade comparison even runs).
 *
 * This module is PURE: no I/O, no clock, no randomness. The caller
 * supplies every resolved fact; the engine derives the outcome
 * deterministically.
 */

import { EVIDENCE_GRADE_RANK } from "../core/evidence.ts";
import type { EvidenceGrade } from "../core/evidence.ts";
import { isQualifyingHelpfulnessSourceType } from "../core/contributions.ts";
import type { HelpfulnessBasisKind } from "../core/contributions.ts";

/** The policy view the engine consumes (structural, provider-neutral). */
export interface PohPolicyView {
  readonly qualifyingBasisKinds: readonly HelpfulnessBasisKind[];
  readonly minimumGrade: EvidenceGrade;
  readonly qualifyingSourceTypes: readonly string[];
  readonly qualifyingOutcomeTypes: readonly string[];
  readonly minimumConfidence: number;
  readonly minimumIndependentSources: number;
  readonly minimumQualifyingBases: number;
  readonly requiresDisclosure: boolean;
}

/** A basis, plus its truth-authority resolution (resolved by the caller). */
export interface PohBasisInput {
  readonly kind: HelpfulnessBasisKind;
  readonly referenceId: string;
  /** Null when the authority record no longer resolves. */
  readonly resolution: PohBasisResolution | null;
}

export interface PohBasisResolution {
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  /** evidence_record only: */
  readonly sourceType?: string;
  readonly grade?: EvidenceGrade;
  readonly confidencePoint?: number;
  /** measured_outcome only: */
  readonly outcomeType?: string;
  readonly state?: string;
  readonly rollupConfidencePoint?: number | null;
  /** Independent-provenance key (see computeIndependentSources). */
  readonly provenanceKey?: string | null;
}

export interface PohEngineInput {
  readonly policy: PohPolicyView;
  readonly bases: readonly PohBasisInput[];
  readonly advisoryCount: number;
  /**
   * Disclosure compliance (computed by the domain service: every
   * commercial mention resolves to an ACTIVE disclosure). Mentions
   * influence ONLY this boolean — never the counts below.
   */
  readonly disclosureCompliant: boolean;
  readonly hasCommercialMentions: boolean;
  /** The contribution's current workflow state (publication gate). */
  readonly contributionState: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
}

export interface PohEngineResult {
  readonly outcome: "QUALIFIED" | "NOT_QUALIFIED";
  readonly reasons: readonly string[];
  readonly qualifyingBasisCount: number;
  readonly independentSourceCount: number;
}

/**
 * The deterministic independent-source key for a qualifying basis:
 *  - evidence_record → `evidence:{sourceType}:{provenanceSourceId ?? referenceId}`
 *    (distinct source TYPES and distinct provenance source ids are
 *    distinct independent sources — the /evidence provenance rule);
 *  - measured_outcome → `measurement:{referenceId}` (each finalized
 *    normalized measurement is one independent measured source);
 *  - proof_of_value → `pov:{referenceId}` (each VERIFIED PoV is one
 *    independent verified aggregate).
 */
export function computeIndependentSourceKey(
  basis: PohBasisInput,
): string | null {
  if (!basis.resolution) return null;
  switch (basis.kind) {
    case "evidence_record":
      return `evidence:${String(basis.resolution.sourceType ?? "unknown")}:${String(basis.resolution.provenanceKey ?? basis.referenceId)}`;
    case "measured_outcome":
      return `measurement:${basis.referenceId}`;
    case "proof_of_value":
      return `pov:${basis.referenceId}`;
    default:
      return null;
  }
}

/**
 * Grade strength: lower rank = STRONGER (MEASURED=1 …
 * SELF_REPORTED=5, the frozen independence ordering). A basis grade
 * qualifies when it is AT LEAST AS STRONG as the policy minimum.
 */
export function gradeAtLeast(
  grade: EvidenceGrade,
  minimum: EvidenceGrade,
): boolean {
  const g = EVIDENCE_GRADE_RANK[grade];
  const m = EVIDENCE_GRADE_RANK[minimum];
  return g !== undefined && m !== undefined && g <= m;
}

/**
 * Evaluate one basis against the policy — PURE. Returns the failure
 * reason, or null when the basis qualifies.
 */
export function evaluateBasis(
  input: PohEngineInput,
  basis: PohBasisInput,
): string | null {
  if (!input.policy.qualifyingBasisKinds.includes(basis.kind)) {
    return `basis ${basis.referenceId}: kind '${basis.kind}' is not a qualifying basis kind for this policy`;
  }
  const r = basis.resolution;
  if (r === null) {
    return `basis ${basis.referenceId}: the authority record does not resolve (re-resolved at evaluation time)`;
  }
  if (r.organizationScopeId !== input.organizationScopeId) {
    return `basis ${basis.referenceId}: organization scope mismatch (tenant isolation)`;
  }
  if (r.subjectType !== "contribution" || r.subjectId !== input.contributionId) {
    return `basis ${basis.referenceId}: the authority record does not reference this contribution`;
  }
  switch (basis.kind) {
    case "evidence_record": {
      const sourceType = r.sourceType ?? null;
      if (sourceType === null || !isQualifyingHelpfulnessSourceType(sourceType)) {
        return `basis ${basis.referenceId}: evidence source type '${String(sourceType)}' never qualifies (model and self evidence are advisory-only)`;
      }
      if (!input.policy.qualifyingSourceTypes.includes(sourceType)) {
        return `basis ${basis.referenceId}: evidence source type '${sourceType}' is not a policy-qualifying source type`;
      }
      const grade = r.grade ?? null;
      if (grade === null || !gradeAtLeast(grade, input.policy.minimumGrade)) {
        return `basis ${basis.referenceId}: evidence grade '${String(grade)}' is below the policy minimum '${input.policy.minimumGrade}'`;
      }
      const point = r.confidencePoint ?? null;
      if (point === null || point < input.policy.minimumConfidence) {
        return `basis ${basis.referenceId}: evidence confidence ${String(point)} is below the policy minimum ${String(input.policy.minimumConfidence)}`;
      }
      return null;
    }
    case "measured_outcome": {
      if ((r.state ?? null) !== "VERIFIED") {
        return `basis ${basis.referenceId}: the measured outcome is not finalized (VERIFIED with a recorded rollup)`;
      }
      const outcomeType = r.outcomeType ?? null;
      if (
        outcomeType === null ||
        !input.policy.qualifyingOutcomeTypes.includes(outcomeType)
      ) {
        return `basis ${basis.referenceId}: outcome type '${String(outcomeType)}' is not a policy-qualifying outcome type`;
      }
      const point = r.rollupConfidencePoint ?? null;
      if (point === null || point < input.policy.minimumConfidence) {
        return `basis ${basis.referenceId}: rollup confidence ${String(point)} is below the policy minimum ${String(input.policy.minimumConfidence)} (uncertainty must be quantified)`;
      }
      return null;
    }
    case "proof_of_value": {
      if ((r.state ?? null) !== "VERIFIED") {
        return `basis ${basis.referenceId}: the proof-of-value is not VERIFIED (the /evidence gate — aggregation + attestation — has not passed)`;
      }
      return null;
    }
    default:
      return `basis ${basis.referenceId}: unknown basis kind '${String(basis.kind)}'`;
  }
}

/**
 * Evaluate the Proof-of-Helpfulness — PURE and DETERMINISTIC.
 *
 * QUALIFIED iff ALL of:
 *  1. the contribution is PUBLISHED (workflow state ≥ SUBMITTED — the
 *     canonical lifecycle ordering; unpublished drafts can never be
 *     finally helpful);
 *  2. disclosure compliance (when the policy requires disclosure and
 *     commercial mentions exist);
 *  3. ≥ minimumQualifyingBases qualifying bases (each evidenced,
 *     provenance-tracked, uncertainty-quantified, truth-authority
 *     owned);
 *  4. ≥ minimumIndependentSources distinct independent provenance
 *     sources among the QUALIFYING bases.
 *
 * Mentions and advisory scores are structurally incapable of
 * satisfying 3 or 4 (invariants 1 and 3).
 */
export function evaluateProofOfHelpfulness(
  input: PohEngineInput,
): PohEngineResult {
  const reasons: string[] = [];

  // Gate 1 — publication (user-controlled publication is upstream;
  // this gate makes "unpublished draft" structurally non-qualifiable).
  const lifecycleOrder = [
    "DRAFT",
    "READY",
    "ASSIGNED",
    "IN_PROGRESS",
    "SUBMITTED",
    "MEASURING",
    "EVALUATING",
    "CHALLENGE_WINDOW",
    "SETTLING",
    "SETTLED",
    "VERIFIED",
  ];
  const stateIndex = lifecycleOrder.indexOf(input.contributionState);
  const submittedIndex = lifecycleOrder.indexOf("SUBMITTED");
  if (stateIndex < submittedIndex) {
    reasons.push(
      `the contribution is not published (workflow state '${input.contributionState}' < SUBMITTED — publication is a user-controlled action)`,
    );
  }

  // Gate 2 — disclosure compliance.
  if (input.policy.requiresDisclosure && input.hasCommercialMentions) {
    if (!input.disclosureCompliant) {
      reasons.push(
        "commercial mentions exist without compliant active disclosures (commercial disclosure is explicit — HELP-005)",
      );
    }
  }

  // Gate 3 + 4 — qualifying bases and independent sources.
  const qualifying: PohBasisInput[] = [];
  for (const basis of input.bases) {
    const failure = evaluateBasis(input, basis);
    if (failure === null) {
      qualifying.push(basis);
    } else {
      reasons.push(failure);
    }
  }
  if (qualifying.length < input.policy.minimumQualifyingBases) {
    reasons.push(
      `only ${String(qualifying.length)} qualifying basis(es) — the policy requires at least ${String(input.policy.minimumQualifyingBases)} (helpfulness must be evidenced)`,
    );
  }
  const independentSources = new Set<string>();
  for (const basis of qualifying) {
    const key = computeIndependentSourceKey(basis);
    if (key !== null) independentSources.add(key);
  }
  if (independentSources.size < input.policy.minimumIndependentSources) {
    reasons.push(
      `only ${String(independentSources.size)} independent source(s) — the policy requires at least ${String(input.policy.minimumIndependentSources)}`,
    );
  }

  return {
    outcome: reasons.length === 0 ? "QUALIFIED" : "NOT_QUALIFIED",
    reasons,
    qualifyingBasisCount: qualifying.length,
    independentSourceCount: independentSources.size,
  };
}
