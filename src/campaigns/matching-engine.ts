/**
 * The NET-W021 campaign matching/optimization engine — PURE and
 * DETERMINISTIC.
 *
 * Architecture ref: spec/architecture.md §7 (campaign matching is a
 * campaign-domain rule), §14 (AI outputs remain
 * recommendations/evidence inputs, never unilateral truth), §18
 * (module ownership: `/campaigns` owns campaign domain rules),
 * §19 (AI output never authorizes state); spec/architecture-lock.md
 * §2 (the frozen core domains — NO 17th domain), §3 (PostgreSQL
 * authoritative — the engine performs NO I/O), §12 (execution
 * lineage), §14 (provider neutrality).
 *
 * Work order ref: spec/work-orders/NET-W021.md
 *   §3.1 The deterministic hard eligibility gates (closed reason
 *        vocabulary; conjunction semantics; complete traces).
 *   §3.2 Evidence-backed feature extraction + baseline ranking (six
 *        signals; VERIFIED-outcome performance; canonical
 *        reputation standing/reliability/risk; deterministic
 *        baseline ordering).
 *   §3.3 The bounded AI advisory optimization (AI-002 matching +
 *        AI-003 risk analysis — each capped at 25%, blended into
 *        alignment/risk ONLY, structurally unable to flip a gate).
 *   §3.4 The explainable candidate ordering (baseline + final
 *        orderings, per-signal inputs, deterministic digest).
 *
 * Requirements: CAMP-001..003 (objective/outcome-aware matching
 * under declared policy), AI-002 (AI-assisted matching — advisory
 * only), AI-003 (AI-assisted fraud/risk analysis — advisory only).
 *
 * MATCHING IS SELECTION, NOT AUTHORITY (the work item's strongest
 * constraint, the NET-W016 engine precedent): this engine is a pure
 * function over resolved facts. It mutates NOTHING — no inventory,
 * no campaign, no workflow, no settlement, no reputation, no risk,
 * no outcome state. All I/O (supply enumeration, policy-rule
 * evaluation, reputation resolution, safety reads, outcome-evidence
 * reads, the advisory consultations) happens in the matching
 * SERVICE before/around the engine; the engine receives
 * fully-resolved facts and returns gates, signals, orderings and
 * the digest.
 *
 * THE PIPELINE (the architect-pinned shape):
 *
 * ```text
 * hard eligibility gates            (§3.1 — BEFORE any ranking or
 *         ↓                          advisory; ineligible options
 * evidence-backed feature           are never ranked)
 *         ↓
 * deterministic baseline ranking    (§3.2 — advisory-off ordering)
 *         ↓
 * bounded AI advisory optimization  (§3.3 — ≤25% blends into
 *         ↓                          alignment/risk only)
 * explainable candidate ordering    (§3.4 — baseline + final
 *                                   ranks, per-signal inputs)
 * ```
 *
 * Tier compliance: campaigns domain → self + core contracts only.
 */

import { createHash } from "node:crypto";
import {
  CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE,
  type CampaignMatchGateReason,
  type CampaignMatchSignal,
  type CampaignMatchWeightsShape,
} from "../core/campaigns.ts";
import type {
  CampaignMatchAdvisoryAssessment,
  CampaignMatchCandidateResult,
  CampaignMatchEligibility,
  CampaignMatchExcludedCandidate,
  CampaignMatchGateEvaluation,
  CampaignMatchInventoryItemView,
  CampaignMatchOutcomeEvidence,
  CampaignMatchRunRecord,
  CampaignMatchSafetyView,
  CampaignMatchSignalScore,
  CampaignMatchSupplyEligibilityEvaluation,
  CampaignMatchTargeting,
  ResolvedCampaignMatchReputationScore,
} from "./port.ts";

/** Fixed 1-decimal rounding (deterministic digests). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The per-candidate reputation facts, resolved read-only by the service. */
export interface CampaignMatchReputationFacts {
  /**
   * The owner's canonical standing score (creator_performance for
   * creator surfaces, inventory_quality otherwise — the frozen
   * surface mapping). Null = no snapshot (no evidence — score 0).
   */
  readonly standing: ResolvedCampaignMatchReputationScore | null;
  /** The owner's measurement_reliability score (null = no evidence). */
  readonly reliability: ResolvedCampaignMatchReputationScore | null;
  /** The owner's fraud_resistance score (null = no evidence). */
  readonly fraudResistance: ResolvedCampaignMatchReputationScore | null;
}

/**
 * Everything the pure engine needs about ONE candidate: the neutral
 * supply view + the policy-rule evaluation + the resolved reputation
 * facts + the safety read + the VERIFIED outcome evidence. Assembled
 * by the matching service (all I/O outside the engine).
 */
export interface CampaignMatchCandidateFacts {
  readonly item: CampaignMatchInventoryItemView;
  readonly eligibility: CampaignMatchSupplyEligibilityEvaluation;
  readonly reputation: CampaignMatchReputationFacts;
  readonly safety: CampaignMatchSafetyView;
  readonly outcomeEvidence: readonly CampaignMatchOutcomeEvidence[];
}

// ---------------------------------------------------------------------------
// Hard-gate evaluation (work order §3.1; AC-01)
// ---------------------------------------------------------------------------

function gate(
  reason: CampaignMatchGateReason,
  passed: boolean,
  detail: string | null,
): CampaignMatchGateEvaluation {
  return { gate: reason, passed, detail };
}

/**
 * Evaluate the deterministic hard gates for one candidate against
 * the effective targeting. Every gate is evaluated (no
 * short-circuit) so the trace is complete; eligibility is the
 * conjunction of all gates. The closed reason vocabulary is
 * `CAMPAIGN_MATCH_GATE_REASONS` (core/campaigns.ts).
 *
 * The run-level constraints (campaign publishability, policy
 * resolution, policy tenant scope) are validated BEFORE candidate
 * enumeration by the service — they fail the whole run closed
 * (CAMP-002: no matching before an ACTIVE campaign with a pinned
 * policy); the per-candidate gates below are the supply-side hard
 * constraints.
 */
export function evaluateEligibility(
  facts: CampaignMatchCandidateFacts,
  targeting: CampaignMatchTargeting,
): CampaignMatchEligibility {
  const gates: CampaignMatchGateEvaluation[] = [];
  const failed: CampaignMatchGateReason[] = [];
  const fail = (reason: CampaignMatchGateReason, detail: string | null) => {
    gates.push(gate(reason, false, detail));
    failed.push(reason);
  };
  const pass = (reason: CampaignMatchGateReason, detail: string | null) => {
    gates.push(gate(reason, true, detail));
  };

  // -- supply-state gates --------------------------------------------
  if (facts.item.retiredAt !== null) {
    fail(
      "item_retired",
      `the inventory item is retired (${facts.item.retiredAt})`,
    );
  } else {
    pass("item_retired", "supply is active");
  }

  if (facts.item.verificationEvidenceReference === null) {
    fail(
      "supply_not_verified",
      "the inventory item carries no supply verification evidence (the W019 settlement-readiness supply_available component)",
    );
  } else {
    pass(
      "supply_not_verified",
      `verification evidence ${facts.item.verificationEvidenceReference}`,
    );
  }

  // -- policy eligibility rules (the /inventory authority's own
  //    semantics, evaluated through the neutral lookup) --------------
  if (!facts.eligibility.eligible) {
    const failedRules = facts.eligibility.ruleResults
      .filter((r) => !r.satisfied)
      .map((r) => `${r.attribute} ${r.operator} [${r.values.join(", ")}] (${r.reason})`);
    fail(
      "eligibility_rules_not_satisfied",
      failedRules.length > 0
        ? `policy eligibility rules not satisfied: ${failedRules.join("; ")}`
        : "policy eligibility rules not satisfied",
    );
  } else {
    pass(
      "eligibility_rules_not_satisfied",
      facts.eligibility.ruleResults.length === 0
        ? "no policy eligibility rules declared"
        : "all policy eligibility rules satisfied",
    );
  }

  // -- targeting gates ------------------------------------------------
  if (
    targeting.requiredFormats.length > 0 &&
    !targeting.requiredFormats.includes(facts.item.format)
  ) {
    fail(
      "format_not_targeted",
      `format ${facts.item.format} is not among the required formats: ${targeting.requiredFormats.join(", ")}`,
    );
  } else if (targeting.requiredFormats.length > 0) {
    pass(
      "format_not_targeted",
      `format ${facts.item.format} is targeted`,
    );
  }

  if (
    targeting.requiredSurfaceKinds.length > 0 &&
    !targeting.requiredSurfaceKinds.includes(facts.item.surfaceKind)
  ) {
    fail(
      "surface_kind_not_targeted",
      `surface kind ${facts.item.surfaceKind} is not among the required surface kinds: ${targeting.requiredSurfaceKinds.join(", ")}`,
    );
  } else if (targeting.requiredSurfaceKinds.length > 0) {
    pass(
      "surface_kind_not_targeted",
      `surface kind ${facts.item.surfaceKind} is targeted`,
    );
  }

  if (targeting.targetTerritories.length > 0) {
    const reached = targeting.targetTerritories.filter((t) =>
      facts.item.territories.includes(t),
    );
    if (reached.length === 0) {
      fail(
        "territory_not_reached",
        `the supply reaches none of the target territories: ${targeting.targetTerritories.join(", ")}`,
      );
    } else {
      pass("territory_not_reached", `reaches: ${reached.join(", ")}`);
    }
  }

  if (targeting.requiredLanguages.length > 0) {
    const spoken = targeting.requiredLanguages.filter((l) =>
      facts.item.languages.includes(l),
    );
    if (spoken.length === 0) {
      fail(
        "language_not_supported",
        `the supply supports none of the required languages: ${targeting.requiredLanguages.join(", ")}`,
      );
    } else {
      pass("language_not_supported", `supports: ${spoken.join(", ")}`);
    }
  }

  // -- risk gate -------------------------------------------------------
  if (facts.safety.held) {
    fail(
      "owner_risk_control",
      facts.safety.controlId
        ? `active participant_eligibility control ${facts.safety.controlId} (${facts.safety.action ?? "UNKNOWN"}) on the supply owner`
        : "active participant_eligibility control on the supply owner",
    );
  } else {
    pass("owner_risk_control", "no active control");
  }

  return {
    eligible: failed.length === 0,
    gates: Object.freeze(gates),
    failedReasons: Object.freeze(failed),
  };
}

// ---------------------------------------------------------------------------
// Evidence-backed feature extraction + baseline ranking (§3.2; AC-02)
// ---------------------------------------------------------------------------

/**
 * The evidence value a candidate holds for one required outcome
 * type (the VERIFIED measured outcome's rollup value), or null.
 */
function evidenceValueFor(
  facts: CampaignMatchCandidateFacts,
  outcomeType: string,
): CampaignMatchOutcomeEvidence | null {
  const matches = facts.outcomeEvidence.filter(
    (e) => e.outcomeType === outcomeType,
  );
  if (matches.length === 0) return null;
  // Deterministic: the latest VERIFIED outcome by verifiedAt (then
  // id) wins — the rollup strategy is the /outcomes authority's; the
  // engine only picks deterministically among the evidence it was
  // given.
  const sorted = [...matches].sort((a, b) => {
    const ta = a.verifiedAt ?? "";
    const tb = b.verifiedAt ?? "";
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.measuredOutcomeId < b.measuredOutcomeId ? -1 : 1;
  });
  return sorted[0]!;
}

/**
 * Score the six explicit signals for every ELIGIBLE candidate — the
 * BASELINE (advisory-off) scores. Performance is evidence-backed
 * (VERIFIED measured outcomes only) and RELATIVE within the run
 * (min-max per required outcome type across the evidence holders —
 * ranking semantics; the absolute evidence values are recorded in
 * the signal inputs). Absent evidence yields NO performance credit.
 */
export function scoreBaselineSignals(
  eligible: readonly CampaignMatchCandidateFacts[],
  targeting: CampaignMatchTargeting,
  requiredOutcomeTypes: readonly string[],
  weights: CampaignMatchWeightsShape,
): readonly (readonly CampaignMatchSignalScore[])[] {
  const perCandidate: {
    readonly facts: CampaignMatchCandidateFacts;
    readonly alignment: number;
    readonly territoryAlignment: number;
    readonly languageAlignment: number;
    readonly evidenceByType: readonly (readonly [
      string,
      CampaignMatchOutcomeEvidence | null,
    ])[];
    readonly standing: number;
    readonly reliability: number;
    readonly risk: number;
    readonly coverage: number;
  }[] = eligible.map((facts) => {
    // -- alignment: territory + language overlap depth (the binary
    //    format/surface fit is a HARD GATE; alignment measures the
    //    depth of the remaining fit).
    const territoryAlignment =
      targeting.targetTerritories.length === 0
        ? 100
        : (100 *
            targeting.targetTerritories.filter((t) =>
              facts.item.territories.includes(t),
            ).length) /
          targeting.targetTerritories.length;
    const languageAlignment =
      targeting.requiredLanguages.length === 0
        ? 100
        : (100 *
            targeting.requiredLanguages.filter((l) =>
              facts.item.languages.includes(l),
            ).length) /
          targeting.requiredLanguages.length;

    const evidenceByType = requiredOutcomeTypes.map(
      (t) => [t, evidenceValueFor(facts, t)] as const,
    );

    // -- reputation signals (canonical, read-only; 0 without a
    //    snapshot — no evidence, no credit).
    const standing = facts.reputation.standing?.score ?? 0;
    const reliability = facts.reputation.reliability?.score ?? 0;
    const risk = facts.reputation.fraudResistance?.score ?? 0;

    // -- coverage: share of required outcome types with VERIFIED
    //    evidence (vacuously 100 when none are required).
    const covered = evidenceByType.filter(([, e]) => e !== null).length;
    const coverage =
      requiredOutcomeTypes.length === 0
        ? 100
        : (100 * covered) / requiredOutcomeTypes.length;

    return {
      facts,
      alignment: round1((territoryAlignment + languageAlignment) / 2),
      territoryAlignment: round1(territoryAlignment),
      languageAlignment: round1(languageAlignment),
      evidenceByType,
      standing,
      reliability,
      risk,
      coverage: round1(coverage),
    };
  });

  // -- performance: min-max normalization per required outcome type
  //    across THIS RUN's evidence holders.
  const performanceByCandidate: number[] = perCandidate.map(() => 0);
  const performanceInputs: Record<string, unknown>[][] = perCandidate.map(
    () => [],
  );
  for (let typeIndex = 0; typeIndex < requiredOutcomeTypes.length; typeIndex++) {
    const outcomeType = requiredOutcomeTypes[typeIndex]!;
    const holders = perCandidate
      .map((c, i) => ({ c, i, evidence: c.evidenceByType[typeIndex]![1] }))
      .filter((h) => h.evidence !== null);
    if (holders.length === 0) {
      // No evidence anywhere for this type: no credit for anyone.
      for (let i = 0; i < perCandidate.length; i++) {
        performanceInputs[i]!.push({
          outcomeType,
          evidence: null,
          typeScore: 0,
        });
      }
      continue;
    }
    const values = holders.map((h) => h.evidence!.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const holderScores = holders.map((h) =>
      max > min
        ? (100 * (h.evidence!.value - min)) / (max - min)
        : 100,
    );
    let holderIndex = 0;
    for (let i = 0; i < perCandidate.length; i++) {
      const entry = perCandidate[i]!.evidenceByType[typeIndex]!;
      if (entry[1] !== null) {
        const typeScore = holderScores[holderIndex]!;
        holderIndex++;
        performanceByCandidate[i] = (performanceByCandidate[i] ?? 0) + typeScore;
        performanceInputs[i]!.push({
          outcomeType,
          evidence: {
            measuredOutcomeId: entry[1]!.measuredOutcomeId,
            value: entry[1]!.value,
            unit: entry[1]!.unit,
            confidencePoint: entry[1]!.confidencePoint,
          },
          runMin: min,
          runMax: max,
          typeScore: round1(typeScore),
        });
      } else {
        performanceInputs[i]!.push({
          outcomeType,
          evidence: null,
          typeScore: 0,
        });
      }
    }
  }

  const weightOf = (signal: CampaignMatchSignal): number => {
    switch (signal) {
      case "alignment":
        return weights.alignment;
      case "performance":
        return weights.performance;
      case "standing":
        return weights.standing;
      case "reliability":
        return weights.reliability;
      case "risk":
        return weights.risk;
      case "coverage":
        return weights.coverage;
    }
  };

  return Object.freeze(
    perCandidate.map((c, i) => {
      const performance =
        requiredOutcomeTypes.length === 0
          ? 50
          : round1(
              performanceByCandidate[i]! / requiredOutcomeTypes.length,
            );
      const signals: readonly {
        signal: CampaignMatchSignal;
        score: number;
        inputs: Record<string, unknown>;
      }[] = [
        {
          signal: "alignment",
          score: c.alignment,
          inputs: {
            territoryAlignment: c.territoryAlignment,
            languageAlignment: c.languageAlignment,
            targetTerritories: [...targeting.targetTerritories],
            requiredLanguages: [...targeting.requiredLanguages],
          },
        },
        {
          signal: "performance",
          score: performance,
          inputs: {
            requiredOutcomeTypes: [...requiredOutcomeTypes],
            perType: performanceInputs[i]!,
          },
        },
        {
          signal: "standing",
          score: round1(c.standing),
          inputs: {
            dimension:
              CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE[
                c.facts.item.surfaceKind as "publisher" | "app" | "creator"
              ] ?? null,
            snapshotId: c.facts.reputation.standing?.snapshotId ?? null,
            digest: c.facts.reputation.standing?.digest ?? null,
            score: c.facts.reputation.standing?.score ?? null,
          },
        },
        {
          signal: "reliability",
          score: round1(c.reliability),
          inputs: {
            dimension: "measurement_reliability",
            snapshotId: c.facts.reputation.reliability?.snapshotId ?? null,
            digest: c.facts.reputation.reliability?.digest ?? null,
            score: c.facts.reputation.reliability?.score ?? null,
          },
        },
        {
          signal: "risk",
          score: round1(c.risk),
          inputs: {
            dimension: "fraud_resistance",
            snapshotId: c.facts.reputation.fraudResistance?.snapshotId ?? null,
            digest: c.facts.reputation.fraudResistance?.digest ?? null,
            score: c.facts.reputation.fraudResistance?.score ?? null,
            activeControl: c.facts.safety.controlId,
          },
        },
        {
          signal: "coverage",
          score: c.coverage,
          inputs: {
            requiredOutcomeTypes: [...requiredOutcomeTypes],
            coveredTypes: c.evidenceByType
              .filter(([, e]) => e !== null)
              .map(([t]) => t),
          },
        },
      ];
      return Object.freeze(
        signals.map((s) =>
          Object.freeze({
            signal: s.signal,
            score: s.score,
            baselineScore: s.score,
            weight: weightOf(s.signal),
            contribution: round1((s.score * weightOf(s.signal)) / 100),
            inputs: Object.freeze(s.inputs),
          } satisfies CampaignMatchSignalScore),
        ),
      );
    }),
  );
}

/**
 * The final (post-advisory) signal view: the AI-002 matching
 * assessment blends into `alignment` and the AI-003 risk analysis
 * blends into `risk` — each at its own capped blend. Every other
 * signal keeps its baseline score. Blends are recorded as
 * score ≠ baselineScore with the advisory identity in the result.
 */
export function applyAdvisoryBlends(
  baseline: readonly CampaignMatchSignalScore[],
  advisory: {
    readonly matching: CampaignMatchAdvisoryAssessment | null;
    readonly matchingBlend: number;
    readonly risk: CampaignMatchAdvisoryAssessment | null;
    readonly riskBlend: number;
  },
): readonly CampaignMatchSignalScore[] {
  return Object.freeze(
    baseline.map((s) => {
      if (
        s.signal === "alignment" &&
        advisory.matching !== null &&
        advisory.matchingBlend > 0
      ) {
        const blended = round1(
          (1 - advisory.matchingBlend) * s.baselineScore +
            advisory.matchingBlend * advisory.matching.score,
        );
        return Object.freeze({
          ...s,
          score: blended,
          contribution: round1((blended * s.weight) / 100),
          inputs: Object.freeze({
            ...s.inputs,
            advisoryScore: advisory.matching.score,
            advisoryProvider: advisory.matching.provider,
            advisoryModelRef: advisory.matching.modelRef,
            advisoryBlend: advisory.matchingBlend,
          }),
        });
      }
      if (
        s.signal === "risk" &&
        advisory.risk !== null &&
        advisory.riskBlend > 0
      ) {
        const blended = round1(
          (1 - advisory.riskBlend) * s.baselineScore +
            advisory.riskBlend * advisory.risk.score,
        );
        return Object.freeze({
          ...s,
          score: blended,
          contribution: round1((blended * s.weight) / 100),
          inputs: Object.freeze({
            ...s.inputs,
            advisoryScore: advisory.risk.score,
            advisoryProvider: advisory.risk.provider,
            advisoryModelRef: advisory.risk.modelRef,
            advisoryBlend: advisory.riskBlend,
          }),
        });
      }
      return s;
    }),
  );
}

// ---------------------------------------------------------------------------
// Ranking (deterministic total order; AC-02/AC-04)
// ---------------------------------------------------------------------------

/** totalScore = Σ rounded contributions (deterministic). */
export function totalScoreOf(
  signals: readonly CampaignMatchSignalScore[],
): number {
  return round1(signals.reduce((sum, s) => sum + s.contribution, 0));
}

export interface ScoredCandidate {
  readonly facts: CampaignMatchCandidateFacts;
  readonly baselineSignals: readonly CampaignMatchSignalScore[];
  readonly finalSignals: readonly CampaignMatchSignalScore[];
  readonly baselineTotalScore: number;
  readonly totalScore: number;
}

/**
 * Rank scored candidates: totalScore DESC, then itemId ASC — a
 * deterministic total order (no ties survive; identical inputs rank
 * identically). The baseline ordering uses the same rule over
 * baselineTotalScore.
 */
export function orderCandidates(
  scored: readonly ScoredCandidate[],
): readonly (ScoredCandidate & {
  readonly rank: number;
  readonly baselineRank: number;
})[] {
  const byFinal = [...scored].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.facts.item.id < b.facts.item.id ? -1 : 1;
  });
  const byBaseline = [...scored].sort((a, b) => {
    if (b.baselineTotalScore !== a.baselineTotalScore) {
      return b.baselineTotalScore - a.baselineTotalScore;
    }
    return a.facts.item.id < b.facts.item.id ? -1 : 1;
  });
  const baselineRankOf = new Map<string, number>();
  byBaseline.forEach((c, index) =>
    baselineRankOf.set(c.facts.item.id, index + 1),
  );
  return Object.freeze(
    byFinal.map((c) => ({
      ...c,
      rank: byFinal.indexOf(c) + 1,
      baselineRank: baselineRankOf.get(c.facts.item.id)!,
    })),
  );
}

// ---------------------------------------------------------------------------
// Result views (§3.4)
// ---------------------------------------------------------------------------

/** Build the ranked candidate result view (the run's `results`). */
export function buildCandidateResults(
  ranked: readonly (ScoredCandidate & {
    readonly rank: number;
    readonly baselineRank: number;
  })[],
  advisory: {
    readonly matching: CampaignMatchAdvisoryAssessment | null;
    readonly risk: CampaignMatchAdvisoryAssessment | null;
  },
  placedItemIds: ReadonlySet<string>,
): readonly CampaignMatchCandidateResult[] {
  return Object.freeze(
    ranked.map((c) =>
      Object.freeze({
        inventoryItemId: c.facts.item.id,
        ownerPersonId: c.facts.item.ownerPersonId,
        surfaceKind: c.facts.item.surfaceKind,
        format: c.facts.item.format,
        rank: c.rank,
        baselineRank: c.baselineRank,
        totalScore: c.totalScore,
        baselineTotalScore: c.baselineTotalScore,
        alreadyPlaced: placedItemIds.has(c.facts.item.id),
        signals: c.finalSignals,
        advisory: {
          matching: advisory.matching
            ? {
                score: advisory.matching.score,
                provider: advisory.matching.provider,
                modelRef: advisory.matching.modelRef,
              }
            : null,
          risk: advisory.risk
            ? {
                score: advisory.risk.score,
                provider: advisory.risk.provider,
                modelRef: advisory.risk.modelRef,
              }
            : null,
        },
      } satisfies CampaignMatchCandidateResult),
    ),
  );
}

/** Build the excluded-candidate view (the run's `excluded`). */
export function buildExcludedCandidates(
  factsList: readonly CampaignMatchCandidateFacts[],
  eligibilityOf: (
    facts: CampaignMatchCandidateFacts,
  ) => CampaignMatchEligibility,
): readonly CampaignMatchExcludedCandidate[] {
  return Object.freeze(
    factsList
      .map((facts) => ({ facts, eligibility: eligibilityOf(facts) }))
      .filter((c) => !c.eligibility.eligible)
      .sort((a, b) => (a.facts.item.id < b.facts.item.id ? -1 : 1))
      .map((c) =>
        Object.freeze({
          inventoryItemId: c.facts.item.id,
          ownerPersonId: c.facts.item.ownerPersonId,
          surfaceKind: c.facts.item.surfaceKind,
          format: c.facts.item.format,
          failedReasons: c.eligibility.failedReasons,
        } satisfies CampaignMatchExcludedCandidate),
      ),
  );
}

// ---------------------------------------------------------------------------
// The deterministic digest (§3.4; AC-06)
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the canonical serialization of a run's decision
 * content at fixed 1-decimal precision (the NET-W007/W016 digest
 * precedents): identical inputs + results → identical digest.
 * Re-running the same match reproduces it bit-for-bit
 * (advisory-off); with the advisory on, the provider identity is
 * part of the recorded decision.
 */
export function computeMatchDigest(
  run: Omit<
    CampaignMatchRunRecord,
    | "digest"
    | "idempotencyKey"
    | "executionId"
    | "correlationId"
    | "causationId"
    | "id"
    | "createdBy"
    | "createdAt"
  >,
): string {
  const canonical = JSON.stringify({
    formatVersion: run.formatVersion,
    organizationScopeId: run.organizationScopeId,
    campaign: [run.campaign.campaignId, run.campaign.policyVersion],
    targeting: {
      requiredFormats: [...run.targeting.requiredFormats].sort(),
      requiredSurfaceKinds: [...run.targeting.requiredSurfaceKinds].sort(),
      targetTerritories: [...run.targeting.targetTerritories].sort(),
      requiredLanguages: [...run.targeting.requiredLanguages].sort(),
    },
    requiredOutcomeTypes: [...run.requiredOutcomeTypes].sort(),
    weights: run.weights,
    advisory: {
      config: [
        run.advisory.config.matching.enabled,
        run.advisory.config.matching.maxWeight,
        run.advisory.config.risk.enabled,
        run.advisory.config.risk.maxWeight,
      ],
      matching: [
        run.advisory.matching.used,
        run.advisory.matching.blend.toFixed(2),
        run.advisory.matching.provider,
        run.advisory.matching.modelRef,
      ],
      risk: [
        run.advisory.risk.used,
        run.advisory.risk.blend.toFixed(2),
        run.advisory.risk.provider,
        run.advisory.risk.modelRef,
      ],
    },
    candidateCount: run.candidateCount,
    eligibleCount: run.eligibleCount,
    results: run.results.map((r) => [
      r.inventoryItemId,
      r.rank,
      r.baselineRank,
      r.totalScore.toFixed(1),
      r.baselineTotalScore.toFixed(1),
      r.alreadyPlaced,
      r.signals.map((s) => [
        s.signal,
        s.score.toFixed(1),
        s.baselineScore.toFixed(1),
        s.weight,
        s.contribution.toFixed(1),
      ]),
      r.advisory.matching
        ? [r.advisory.matching.score.toFixed(1), r.advisory.matching.provider]
        : null,
      r.advisory.risk
        ? [r.advisory.risk.score.toFixed(1), r.advisory.risk.provider]
        : null,
    ]),
    excluded: run.excluded.map((e) => [
      e.inventoryItemId,
      [...e.failedReasons].sort(),
    ]),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
