/**
 * Shared fraud/risk vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §12 (Fraud architecture: no
 * single signal is authoritative; detection combines identity,
 * behavioral, device/platform integrity, graph, economic anomaly,
 * historical reputation, model ensembles), §14 (AI outputs remain
 * recommendations/evidence inputs — never unilateral truth),
 * §19 (AI/model output is never sufficient by itself to authorize
 * settlement, reputation, or governance state);
 * spec/architecture-lock.md §5 (model output is input, never
 * authoritative), §13 invariant 21 (a disputed or fraud-held claim
 * cannot mature until the applicable resolution policy permits it).
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.1.
 * Requirements: FRAUD-001 (multiple fraud signals), FRAUD-002 (Sybil
 * resistance signal families), FRAUD-003 (collusion/cycle detection),
 * AI-003 (AI-assisted risk analysis — ADVISORY input only).
 *
 * The `/disputes` boundary (the Phase-3 Trust domain — see the work
 * order §2 placement decision) implements the behaviour; the vocabulary
 * is shared so infrastructure (API) and later work items (NET-W010
 * challenges/disputes, NET-W013 moderation, NET-W021 advertising fraud)
 * consume the same frozen terms. This module is data + pure validation
 * ONLY — no I/O, no wall clock, no evaluation behaviour (the
 * deterministic engine lives in `/disputes/risk-engine.ts`).
 *
 * THE KEY RULES (work order §4): fraud/risk is a decision-support and
 * control authority — it can block, hold, route or require review, but
 * it can never mint/destroy/transfer economic value (invariant 1) and
 * never mutates reputation directly (invariant 2). `model_output`
 * provenance is structurally ADVISORY (invariant 5): advisory-only
 * signal sets can never alone produce a material HOLD/BLOCKED state.
 */

import { OpenConError } from "./errors.ts";

/**
 * The frozen risk-signal category vocabulary (architecture §12 signal
 * families + the named NET-W009 controls + the model-advisory family).
 *
 * Categories are independent input classes; a policy consumes them
 * explicitly (a category absent from the policy's rule set contributes
 * nothing — no ambient signal authority; FRAUD-001 "no single signal
 * is authoritative").
 */
export const RISK_SIGNAL_CATEGORIES = [
  "identity",
  "behavioral",
  "device_integrity",
  "graph",
  "economic_anomaly",
  "velocity",
  "duplicate_pattern",
  "historical_reputation",
  "model_advisory",
] as const;

export type RiskSignalCategory = (typeof RISK_SIGNAL_CATEGORIES)[number];

export function isRiskSignalCategory(value: string): value is RiskSignalCategory {
  return (RISK_SIGNAL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The upstream authoritative record kinds that may back a risk signal's
 * provenance source refs (work order §3.2). Every signal MUST cite ≥1
 * authoritative source — a bare assertion cannot enter the system
 * (invariant 3, evidence-backed material decisions). Raw activity,
 * spend, wealth, deposits and reputation scores are structurally absent
 * as sources: they are never risk authorities by themselves.
 */
export const RISK_SIGNAL_SOURCE_KINDS = [
  "evidence",
  "proof_of_value",
  "measured_outcome",
  "contribution",
  "economic_value",
  "credit_issuance",
  "cash_obligation",
  "reputation_snapshot",
  // NET-W009 invariant 3 lets material decisions reference "the risk
  // signals and/or authoritative upstream records that caused it":
  // case decisions and control activations may therefore ALSO cite
  // the risk records themselves (signals + assessments) alongside the
  // upstream authoritative records. Signal-level PROVENANCE sources
  // remain the upstream kinds above (a signal's evidence base is
  // always an authoritative upstream record).
  "risk_signal",
  "risk_assessment",
  // NET-W010 (additive, non-breaking): a resolved risk CASE is an
  // authoritative prior decision — challenge/dispute records and
  // their supporting references may cite it ("prior decision / risk
  // case" per the NET-W010 work item). Signal-level provenance
  // sources remain the upstream kinds (a risk case is never a
  // signal's evidence base).
  "risk_case",
] as const;

export type RiskSignalSourceKind = (typeof RISK_SIGNAL_SOURCE_KINDS)[number];

export function isRiskSignalSourceKind(value: string): value is RiskSignalSourceKind {
  return (RISK_SIGNAL_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * How a signal was produced (work order §3.2 provenance).
 *
 *  - `authoritative_record`: derived directly from a referenced
 *    authoritative upstream record (e.g. a VERIFIED PoV cited as the
 *    subject of a duplicate-pattern finding).
 *  - `rule_detection`: produced by a deterministic detector over the
 *    cited authoritative records (velocity/anomaly/duplicate rules).
 *  - `model_output`: produced by an AI/model ensemble — STRUCTURALLY
 *    ADVISORY (architecture-lock §4/§5; AI-003): it can contribute to
 *    a risk assessment only through a policy rule that explicitly
 *    consumes the category, and advisory-only signal sets can never
 *    alone produce HOLD/BLOCKED (the engine caps them at REVIEW).
 *  - `manual_review`: produced by an authenticated human reviewer
 *    through the audited case flow.
 */
export const RISK_SIGNAL_PROVENANCE_KINDS = [
  "authoritative_record",
  "rule_detection",
  "model_output",
  "manual_review",
] as const;

export type RiskSignalProvenanceKind =
  (typeof RISK_SIGNAL_PROVENANCE_KINDS)[number];

export function isRiskSignalProvenanceKind(
  value: string,
): value is RiskSignalProvenanceKind {
  return (RISK_SIGNAL_PROVENANCE_KINDS as readonly string[]).includes(value);
}

/**
 * The structurally advisory provenance kinds. `model_output` is ALWAYS
 * advisory regardless of caller input (invariant 5 — model
 * non-authority is enforced by construction, not by convention).
 */
export const ADVISORY_PROVENANCE_KINDS: readonly RiskSignalProvenanceKind[] = [
  "model_output",
];

export function isAdvisoryProvenanceKind(kind: RiskSignalProvenanceKind): boolean {
  return ADVISORY_PROVENANCE_KINDS.includes(kind);
}

/**
 * Signal severity vocabulary. Severities carry deterministic per-rule
 * point weights inside a policy; ordering LOW < MEDIUM < HIGH <
 * CRITICAL is normative for the critical-floor rule.
 */
export const RISK_SIGNAL_SEVERITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export type RiskSignalSeverity = (typeof RISK_SIGNAL_SEVERITIES)[number];

export function isRiskSignalSeverity(value: string): value is RiskSignalSeverity {
  return (RISK_SIGNAL_SEVERITIES as readonly string[]).includes(value);
}

/**
 * The explicit risk states (work item). The array order is the
 * NORMATIVE severity ordering used by deterministic state transitions:
 * an assessment never returns a state weaker than a triggered floor
 * (critical-signal floor, fail-safe missing-data state).
 */
export const RISK_STATES = [
  "CLEAR",
  "WATCH",
  "REVIEW",
  "HOLD",
  "BLOCKED",
] as const;

export type RiskState = (typeof RISK_STATES)[number];

export function isRiskState(value: string): value is RiskState {
  return (RISK_STATES as readonly string[]).includes(value);
}

/** Ordinal position in the normative RISK_STATES ordering. */
export function riskStateRank(state: RiskState): number {
  return RISK_STATES.indexOf(state);
}

/**
 * The control-hook operation classes (work order §3.7). A control
 * decision is scoped to exactly one class; downstream gates consult
 * the active-control registry by (organization, operationClass,
 * subject).
 */
export const RISK_OPERATION_CLASSES = [
  "value_maturation",
  "credit_issuance",
  "reward_allocation",
  "cash_settlement",
  "workflow_transition",
  "participant_eligibility",
] as const;

export type RiskOperationClass = (typeof RISK_OPERATION_CLASSES)[number];

export function isRiskOperationClass(value: string): value is RiskOperationClass {
  return (RISK_OPERATION_CLASSES as readonly string[]).includes(value);
}

/**
 * The control actions a risk control decision may impose. `BLOCK` is
 * strictly stronger than `HOLD` (both refuse gated operations; BLOCK
 * additionally signals terminal/serious posture to reviewers). Gates
 * refuse on HOLD and BLOCK alike; the distinction is decision-support
 * metadata, not a weaker enforcement level.
 */
export const RISK_CONTROL_ACTIONS = ["REQUIRE_REVIEW", "HOLD", "BLOCK"] as const;

export type RiskControlAction = (typeof RISK_CONTROL_ACTIONS)[number];

export function isRiskControlAction(value: string): value is RiskControlAction {
  return (RISK_CONTROL_ACTIONS as readonly string[]).includes(value);
}

/** Scaled-integer risk-score precision (deterministic arithmetic). */
export const RISK_SCORE_DECIMALS = 6;

export const RISK_SCORE_SCALE = 10 ** RISK_SCORE_DECIMALS;

/**
 * Confidence convention: a signal's confidence is a float point
 * estimate in [0, 1] (same convention as evidence confidence). The
 * ENGINE multiplies it into contribution points using scaled-integer
 * arithmetic so identical inputs always yield identical scores.
 */
export function validateRiskConfidence(point: number): number {
  if (typeof point !== "number" || !Number.isFinite(point) || point < 0 || point > 1) {
    throw new OpenConError({
      code: "RISK_SIGNAL_VALIDATION",
      classification: "validation",
      message: `risk signal confidence must be a finite number in [0, 1] (got ${String(point)})`,
      context: { field: "confidence", value: point },
    });
  }
  return point;
}

/**
 * The deterministic, per-category evaluation rule (work order §3.3). A
 * risk policy carries rules for the categories it explicitly consumes;
 * categories without a rule contribute nothing (no ambient authority).
 * All parameters are finite deterministic numbers: identical rules +
 * identical signals + identical evaluatedAt ALWAYS produce identical
 * assessments (invariant 4).
 */
export interface RiskEvaluationRule {
  readonly category: RiskSignalCategory;
  /** Weight multiplier applied to the severity points (> 0). */
  readonly weight: number;
  /**
   * Weight factor applied to ADVISORY signals of this category, ∈ [0, 1].
   * Combined with the engine-level advisory-only cap this keeps model
   * output non-authoritative (invariant 5).
   */
  readonly advisoryWeightFactor: number;
  /** Points per severity: exactly the four frozen severities. */
  readonly severityPoints: {
    readonly LOW: number;
    readonly MEDIUM: number;
    readonly HIGH: number;
    readonly CRITICAL: number;
  };
}

/**
 * The deterministic state thresholds of a policy (work order §3.3).
 * Thresholds are non-decreasing over the normative state ordering;
 * the score maps to the STRONGEST state whose threshold it meets
 * (score ≥ threshold), defaulting to CLEAR.
 */
export interface RiskStateThresholds {
  /** ≥ this score (when > 0) ⇒ WATCH. */
  readonly watch: number;
  /** ≥ this score ⇒ REVIEW. */
  readonly review: number;
  /** ≥ this score ⇒ HOLD. */
  readonly hold: number;
  /** ≥ this score ⇒ BLOCKED. */
  readonly blocked: number;
}

/**
 * Validate + normalize a policy rule set (pure). Enforces:
 *  - ≥1 rule, no duplicate categories, valid vocabulary;
 *  - weight > 0, advisoryWeightFactor ∈ [0, 1];
 *  - severity points ≥ 0 and MONOTONIC per the severity ordering
 *    (LOW ≤ MEDIUM ≤ HIGH ≤ CRITICAL — a non-monotonic map would make
 *    severity ordering meaningless);
 *  - thresholds ≥ 0 and monotonic over the normative state ordering
 *    (watch ≤ review ≤ hold ≤ blocked);
 *  - the fail-safe `missingDataState` must be a SAFE state: WATCH at
 *    the weakest is rejected — missing required data must fail CLOSED
 *    (REVIEW/HOLD/BLOCKED), never silently clear risk (invariant 8).
 *  - `advisoryOnlyCapState` must be ≤ REVIEW (invariant 5).
 *  - `criticalFloorState` must be ≥ REVIEW (a non-advisory CRITICAL
 *    signal is never merely watched by default policy shape).
 */
export interface RiskPolicyShape {
  readonly rules: readonly RiskEvaluationRule[];
  readonly thresholds: RiskStateThresholds;
  /** Any non-advisory CRITICAL signal floors the assessment at this state. */
  readonly criticalFloorState: RiskState;
  /** Advisory-only signal sets can never exceed this state (≤ REVIEW). */
  readonly advisoryOnlyCapState: RiskState;
  /** Categories the policy REQUIRES; missing ⇒ fail-closed state. */
  readonly requiredCategories: readonly RiskSignalCategory[];
  /** Fail-closed state for missing required categories (≥ REVIEW). */
  readonly missingDataState: RiskState;
}

/**
 * The RAW (stringly-typed) policy shape callers submit. The validator
 * checks vocabulary + numeric constraints and returns the NORMALIZED,
 * fully-typed shape (canonical rule order, deduplicated required
 * categories). Pure.
 */
export interface RiskPolicyShapeInput {
  readonly rules: readonly {
    readonly category: string;
    readonly weight: number;
    readonly advisoryWeightFactor: number;
    readonly severityPoints: {
      readonly LOW: number;
      readonly MEDIUM: number;
      readonly HIGH: number;
      readonly CRITICAL: number;
    };
  }[];
  readonly thresholds: {
    readonly watch: number;
    readonly review: number;
    readonly hold: number;
    readonly blocked: number;
  };
  readonly criticalFloorState: string;
  readonly advisoryOnlyCapState: string;
  readonly requiredCategories: readonly string[];
  readonly missingDataState: string;
}

export function validateRiskPolicyShape(
  shape: RiskPolicyShapeInput,
): RiskPolicyShape {
  if (!Array.isArray(shape.rules) || shape.rules.length === 0) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "a risk policy requires a non-empty rules array",
      context: { ruleCount: Array.isArray(shape.rules) ? shape.rules.length : 0 },
    });
  }
  const seen = new Set<string>();
  const normalizedRules: RiskEvaluationRule[] = [];
  for (const rule of shape.rules) {
    if (!rule || typeof rule !== "object") {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: "each risk evaluation rule must be an object",
        context: { rule },
      });
    }
    if (!isRiskSignalCategory(rule.category)) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `risk evaluation rule category must be one of the standard risk signal categories (got ${String(rule.category)})`,
        context: { category: rule.category },
      });
    }
    if (seen.has(rule.category)) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `risk policy carries more than one rule for category ${rule.category}`,
        context: { category: rule.category },
      });
    }
    seen.add(rule.category);
    if (
      typeof rule.weight !== "number" ||
      !Number.isFinite(rule.weight) ||
      rule.weight <= 0
    ) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `rule weight for ${rule.category} must be a finite number > 0`,
        context: { category: rule.category, weight: rule.weight },
      });
    }
    if (
      typeof rule.advisoryWeightFactor !== "number" ||
      !Number.isFinite(rule.advisoryWeightFactor) ||
      rule.advisoryWeightFactor < 0 ||
      rule.advisoryWeightFactor > 1
    ) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `rule advisoryWeightFactor for ${rule.category} must be in [0, 1]`,
        context: { category: rule.category, advisoryWeightFactor: rule.advisoryWeightFactor },
      });
    }
    const pts = rule.severityPoints;
    if (
      !pts ||
      [pts.LOW, pts.MEDIUM, pts.HIGH, pts.CRITICAL].some(
        (p) => typeof p !== "number" || !Number.isFinite(p) || p < 0,
      )
    ) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `severity points for ${rule.category} must be finite numbers ≥ 0 (LOW/MEDIUM/HIGH/CRITICAL)`,
        context: { category: rule.category, severityPoints: pts },
      });
    }
    if (!(pts.LOW <= pts.MEDIUM && pts.MEDIUM <= pts.HIGH && pts.HIGH <= pts.CRITICAL)) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `severity points for ${rule.category} must be monotonic (LOW ≤ MEDIUM ≤ HIGH ≤ CRITICAL)`,
        context: { category: rule.category, severityPoints: pts },
      });
    }
    normalizedRules.push({
      category: rule.category,
      weight: rule.weight,
      advisoryWeightFactor: rule.advisoryWeightFactor,
      severityPoints: {
        LOW: pts.LOW,
        MEDIUM: pts.MEDIUM,
        HIGH: pts.HIGH,
        CRITICAL: pts.CRITICAL,
      },
    });
  }
  // Canonical rule order = the frozen category vocabulary (deterministic
  // serialization for digests).
  normalizedRules.sort(
    (a, b) =>
      RISK_SIGNAL_CATEGORIES.indexOf(a.category) -
      RISK_SIGNAL_CATEGORIES.indexOf(b.category),
  );

  const t = shape.thresholds;
  if (
    !t ||
    [t.watch, t.review, t.hold, t.blocked].some(
      (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0,
    )
  ) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "state thresholds must be finite numbers ≥ 0 (watch/review/hold/blocked)",
      context: { thresholds: t },
    });
  }
  if (!(t.watch <= t.review && t.review <= t.hold && t.hold <= t.blocked)) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "state thresholds must be monotonic over the normative state ordering (watch ≤ review ≤ hold ≤ blocked)",
      context: { thresholds: t },
    });
  }

  if (!isRiskState(shape.criticalFloorState)) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: `criticalFloorState must be a standard risk state (got ${String(shape.criticalFloorState)})`,
      context: { criticalFloorState: shape.criticalFloorState },
    });
  }
  if (riskStateRank(shape.criticalFloorState) < riskStateRank("REVIEW")) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "criticalFloorState must be at least REVIEW (a non-advisory CRITICAL signal is never merely watched)",
      context: { criticalFloorState: shape.criticalFloorState },
    });
  }
  if (!isRiskState(shape.advisoryOnlyCapState)) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: `advisoryOnlyCapState must be a standard risk state (got ${String(shape.advisoryOnlyCapState)})`,
      context: { advisoryOnlyCapState: shape.advisoryOnlyCapState },
    });
  }
  if (riskStateRank(shape.advisoryOnlyCapState) > riskStateRank("REVIEW")) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "advisoryOnlyCapState must be at most REVIEW (advisory-only signal sets can never alone produce HOLD/BLOCKED)",
      context: { advisoryOnlyCapState: shape.advisoryOnlyCapState },
    });
  }

  if (!Array.isArray(shape.requiredCategories)) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "requiredCategories must be an array of risk signal categories",
      context: { requiredCategories: shape.requiredCategories },
    });
  }
  const required: RiskSignalCategory[] = [];
  for (const c of shape.requiredCategories) {
    if (!isRiskSignalCategory(c)) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `requiredCategories entries must be standard risk signal categories (got ${String(c)})`,
        context: { category: c },
      });
    }
    // Every required category MUST carry a rule: requiring a category
    // the policy does not consume would fail closed forever.
    if (!seen.has(c)) {
      throw new OpenConError({
        code: "RISK_POLICY_VALIDATION",
        classification: "validation",
        message: `required category ${c} has no evaluation rule in the policy`,
        context: { category: c },
      });
    }
    if (!required.includes(c)) required.push(c);
  }
  required.sort(
    (a, b) =>
      RISK_SIGNAL_CATEGORIES.indexOf(a) - RISK_SIGNAL_CATEGORIES.indexOf(b),
  );

  if (!isRiskState(shape.missingDataState)) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: `missingDataState must be a standard risk state (got ${String(shape.missingDataState)})`,
      context: { missingDataState: shape.missingDataState },
    });
  }
  if (riskStateRank(shape.missingDataState) < riskStateRank("REVIEW")) {
    throw new OpenConError({
      code: "RISK_POLICY_VALIDATION",
      classification: "validation",
      message: "missingDataState must fail CLOSED (at least REVIEW): missing required risk data never silently clears risk",
      context: { missingDataState: shape.missingDataState },
    });
  }

  return {
    rules: Object.freeze(normalizedRules),
    thresholds: {
      watch: t.watch,
      review: t.review,
      hold: t.hold,
      blocked: t.blocked,
    },
    criticalFloorState: shape.criticalFloorState,
    advisoryOnlyCapState: shape.advisoryOnlyCapState,
    requiredCategories: Object.freeze(required),
    missingDataState: shape.missingDataState,
  };
}
