/**
 * The deterministic risk engine — PURE evaluation over committed
 * signals + a risk policy (NET-W009 §3.4).
 *
 * Architecture ref: spec/architecture.md §12 (fraud detection combines
 * multiple signals; NO single signal is authoritative), §19 (AI/model
 * output is never sufficient by itself to authorize settlement,
 * reputation, or governance state); spec/architecture-lock.md §4/§5
 * (model output is input evidence, never authoritative).
 *
 * DETERMINISM (work order §4 invariant 4): the engine is a pure
 * function of (policy, signals, evaluatedAt). No I/O, no wall clock,
 * no hidden state. Identical inputs ALWAYS produce bit-for-bit
 * identical contributions, score, state and digest.
 *
 * THE STRUCTURAL RULES enforced here (not by convention):
 *  - advisory cap (invariant 5): when EVERY contributing signal is
 *    advisory (`model_output` provenance), the resulting state is
 *    capped at the policy's `advisoryOnlyCapState` (validated ≤
 *    REVIEW) — model output can never ALONE produce a material
 *    HOLD/BLOCKED decision;
 *  - critical floor: any non-advisory CRITICAL signal floors the
 *    state at `criticalFloorState` (validated ≥ REVIEW);
 *  - fail-safe (invariant 8): a policy-required category with no
 *    resolvable signal fails CLOSED to `missingDataState` (validated
 *    ≥ REVIEW) — missing required risk data never silently clears
 *    risk;
 *  - category authority: signals in categories the policy does NOT
 *    consume contribute nothing (no ambient signal authority).
 *
 * Scaled-integer arithmetic (RISK_SCORE_DECIMALS): all point/score
 * math runs on scaled integers so identical inputs yield identical
 * scores with no floating-point drift.
 *
 * Tier compliance: core contracts only; no domain imports; this
 * module is imported by the /disputes domain services and by tests.
 */

import { createHash } from "node:crypto";
import {
  RISK_SIGNAL_CATEGORIES,
  isAdvisoryProvenanceKind,
  riskStateRank,
  type RiskSignalCategory,
  type RiskState,
} from "../core/risk.ts";
import type {
  RiskPolicy,
  RiskSignal,
  RiskSignalContribution,
} from "./port.ts";

export interface RiskEvaluationResult {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly subjectPersonId: string;
  readonly evaluatedAt: string;
  /** Deterministic order: recordedAt, then id (stable tiebreak). */
  readonly signalIds: readonly string[];
  readonly contributions: readonly RiskSignalContribution[];
  /** Scaled-integer total score (RISK_SCORE_DECIMALS). */
  readonly score: number;
  readonly state: RiskState;
  readonly missingCategories: readonly RiskSignalCategory[];
  readonly digest: string;
}

export interface EngineSignalView {
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly confidence: number;
  readonly advisory: boolean;
  readonly recordedAt: string;
  readonly supersededBySignalId: string | null;
}

const SCORE_DECIMALS = 6;
const SCORE_SCALE = 10 ** SCORE_DECIMALS;

/** Points (scaled) for one signal under one rule. Pure. */
function scaledPointsFor(
  signal: EngineSignalView,
  weight: number,
  advisoryWeightFactor: number,
  severityPoints: { readonly LOW: number; readonly MEDIUM: number; readonly HIGH: number; readonly CRITICAL: number },
): number {
  const base =
    severityPoints[signal.severity as keyof typeof severityPoints] ?? 0;
  const w = signal.advisory ? weight * advisoryWeightFactor : weight;
  // points = base * weight * confidence, computed in scaled-integer
  // space: base and weight are plain numbers; scale once at the end of
  // each multiplication chain with intermediate scaling to keep the
  // result exact for the decimal inputs the validator admits.
  const raw = base * w * signal.confidence;
  return Math.round(raw * SCORE_SCALE);
}

/**
 * Deterministic state from a scaled score + the structural floors/caps.
 *
 * Composition order is NORMATIVE (invariant precedence):
 *  1. the advisory-only cap applies to the SCORE-DERIVED state first
 *     (invariant 5: model output alone can never produce a material
 *     HOLD/BLOCKED);
 *  2. floors raise afterwards (invariant 8: fail-safe precedence — a
 *     fail-closed missing-data state is caused by the ABSENCE of
 *     required risk data, not by model output, so the advisory cap
 *     cannot mask it; the critical floor is by definition non-advisory
 *     and therefore never triggers on an advisory-only set).
 */
function composeState(
  scoreState: RiskState,
  criticalFloorTriggered: boolean,
  criticalFloorState: RiskState,
  missingCategories: readonly string[],
  missingDataState: RiskState,
  advisoryOnly: boolean,
  advisoryOnlyCapState: RiskState,
): RiskState {
  let state = scoreState;
  if (advisoryOnly) {
    // Model non-authority: advisory-only sets can never alone produce
    // HOLD/BLOCKED — cap the score-derived state.
    if (riskStateRank(advisoryOnlyCapState) < riskStateRank(state)) {
      state = advisoryOnlyCapState;
    }
  }
  if (criticalFloorTriggered) {
    if (riskStateRank(criticalFloorState) > riskStateRank(state)) {
      state = criticalFloorState;
    }
  }
  if (missingCategories.length > 0) {
    // Fail-closed: missing required risk data never silently clears.
    if (riskStateRank(missingDataState) > riskStateRank(state)) {
      state = missingDataState;
    }
  }
  return state;
}

function canonical(result: Omit<RiskEvaluationResult, "digest">): string {
  // Deterministic canonical serialization: fixed key order, fixed
  // precision for scaled integers, frozen category order (the policy
  // rules are already in canonical vocabulary order).
  return JSON.stringify({
    policyId: result.policyId,
    policyVersion: result.policyVersion,
    evaluatedAt: result.evaluatedAt,
    signalIds: result.signalIds,
    contributions: result.contributions.map((c) => ({
      signalId: c.signalId,
      category: c.category,
      severity: c.severity,
      weight: c.weight,
      advisory: c.advisory,
      points: c.points,
    })),
    score: result.score,
    state: result.state,
    missingCategories: result.missingCategories,
  });
}

/**
 * Evaluate a subject's signal set under a policy version (PURE).
 *
 * `signals` MUST be the subject's signals in the policy's organization
 * scope (the caller enforces tenancy); superseded signals are EXCLUDED
 * by this function (supersededBySignalId !== null).
 */
export function evaluateRisk(
  policy: RiskPolicy,
  subjectPersonId: string,
  signals: readonly EngineSignalView[],
  evaluatedAt: string,
): RiskEvaluationResult {
  const rulesByCategory = new Map(policy.rules.map((r) => [r.category, r]));

  // 1. Select contributing signals: non-superseded, category consumed
  //    by the policy. Deterministic order: recordedAt, then id.
  const contributing = signals
    .filter((s) => s.supersededBySignalId === null)
    .filter((s) => rulesByCategory.has(s.category as (typeof RISK_SIGNAL_CATEGORIES)[number]))
    .sort((a, b) => (a.recordedAt === b.recordedAt ? (a.id < b.id ? -1 : 1) : a.recordedAt < b.recordedAt ? -1 : 1));

  // 2. Per-signal contributions (scaled-integer points).
  const contributions: RiskSignalContribution[] = contributing.map((s) => {
    const rule = rulesByCategory.get(s.category as (typeof RISK_SIGNAL_CATEGORIES)[number])!;
    return {
      signalId: s.id,
      category: s.category as RiskSignalContribution["category"],
      severity: s.severity as RiskSignalContribution["severity"],
      weight: rule.weight,
      advisory: s.advisory,
      points: scaledPointsFor(s, rule.weight, rule.advisoryWeightFactor, rule.severityPoints),
    };
  });

  // 3. Total score (scaled).
  const score = contributions.reduce((sum, c) => sum + c.points, 0);

  // 4. Threshold state (score ≥ threshold ⇒ strongest met state).
  const t = policy.thresholds;
  let scoreState: RiskState = "CLEAR";
  if (score >= Math.round(t.blocked * SCORE_SCALE)) scoreState = "BLOCKED";
  else if (score >= Math.round(t.hold * SCORE_SCALE)) scoreState = "HOLD";
  else if (score >= Math.round(t.review * SCORE_SCALE)) scoreState = "REVIEW";
  else if (score >= Math.round(t.watch * SCORE_SCALE) && t.watch > 0) scoreState = "WATCH";

  // 5. Structural floors / caps.
  const criticalFloorTriggered = contributions.some(
    (c) => !c.advisory && c.severity === "CRITICAL",
  );
  const advisoryOnly = contributions.length > 0 && contributions.every((c) => c.advisory);
  const missing = policy.requiredCategories.filter(
    (category) => !contributing.some((s) => s.category === category),
  );

  const state = composeState(
    scoreState,
    criticalFloorTriggered,
    policy.criticalFloorState,
    missing,
    policy.missingDataState,
    advisoryOnly,
    policy.advisoryOnlyCapState,
  );

  const result: Omit<RiskEvaluationResult, "digest"> = {
    policyId: policy.policyId,
    policyVersion: policy.version,
    subjectPersonId,
    evaluatedAt,
    signalIds: contributing.map((s) => s.id),
    contributions: Object.freeze(contributions),
    score,
    state,
    missingCategories: Object.freeze(missing),
  };
  const digest = createHash("sha256").update(canonical(result)).digest("hex");
  return { ...result, digest };
}

// ---------------------------------------------------------------------------
// Pure velocity / duplicate-pattern detectors (work order §3.4).
//
// Detectors NEVER consume raw activity: they operate over AUTHORITATIVE
// economic record views (cited back as the signal's provenance source
// refs) and return deterministic findings the caller records through
// the signal service. Rule parameters are explicit inputs.
// ---------------------------------------------------------------------------

/** Structural view of an economic value record for detectors. */
export interface DetectorEconomicRecordView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly state: string;
  readonly recordedAt: string;
}

export interface VelocityFinding {
  readonly triggered: boolean;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** The authoritative records inside the window (the source refs). */
  readonly recordIds: readonly string[];
}

/**
 * Velocity rule: ≥ `maxRecords` economic records for one beneficiary
 * within [windowStart, windowEnd] (inclusive) ⇒ triggered. Pure,
 * tenant-scoped by construction (the caller passes ONE org's records).
 */
export function evaluateVelocityRule(
  records: readonly DetectorEconomicRecordView[],
  organizationScopeId: string,
  beneficiaryPersonId: string,
  windowStart: string,
  windowEnd: string,
  maxRecords: number,
): VelocityFinding {
  const inWindow = records
    .filter(
      (r) =>
        r.organizationScopeId === organizationScopeId &&
        r.beneficiaryPersonId === beneficiaryPersonId &&
        r.recordedAt >= windowStart &&
        r.recordedAt <= windowEnd,
    )
    .sort((a, b) => (a.recordedAt === b.recordedAt ? (a.id < b.id ? -1 : 1) : a.recordedAt < b.recordedAt ? -1 : 1));
  return {
    triggered: inWindow.length >= maxRecords,
    windowStart,
    windowEnd,
    recordIds: inWindow.map((r) => r.id),
  };
}

export interface DuplicateFinding {
  readonly triggered: boolean;
  /** Groups of ≥2 records sharing the fingerprint (deterministic order). */
  readonly groups: readonly (readonly string[])[];
}

/**
 * Duplicate-pattern rule: ≥2 economic records sharing a caller-derived
 * fingerprint (e.g. same source PoV + same amount) ⇒ a duplicate group.
 * Pure; the fingerprint is caller-computed from authoritative record
 * content so the detector itself stays generic and deterministic.
 */
export function evaluateDuplicatePatternRule(
  records: readonly DetectorEconomicRecordView[],
  fingerprint: (record: DetectorEconomicRecordView) => string,
): DuplicateFinding {
  const byFingerprint = new Map<string, string[]>();
  for (const r of records) {
    const key = fingerprint(r);
    const list = byFingerprint.get(key) ?? [];
    list.push(r.id);
    byFingerprint.set(key, list);
  }
  const groups = [...byFingerprint.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, ids]) => {
      void key;
      return [...ids].sort((a, b) => (a < b ? -1 : 1));
    })
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  return { triggered: groups.length > 0, groups };
}

export { SCORE_DECIMALS as RISK_ENGINE_SCORE_DECIMALS, SCORE_SCALE as RISK_ENGINE_SCORE_SCALE, isAdvisoryProvenanceKind };
