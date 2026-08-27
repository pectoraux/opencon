/**
 * Core moderation/quality vocabulary — NET-W013 (Quality, moderation
 * and anti-spam controls).
 *
 * Work order ref: spec/work-orders/NET-W013.md.
 * Architecture ref: spec/architecture.md §14 (AI architecture —
 * provider-independent; outputs are evidence inputs, never unilateral
 * truth), §12 (fraud architecture — multiple signals, none
 * authoritative), §11 (reputation — quality is a reputation DIMENSION
 * computed by /reputation, never mutated here).
 *
 * THE BINDING RULES (work order §4), encoded structurally:
 *
 *  1. DETERMINISTIC, VERSIONED, AUDITABLE QUALITY POLICY. The quality
 *     vocabulary is closed and provider-neutral; evaluations are
 *     computed by a PURE engine over an explicitly pinned policy
 *     version (the format version below participates in the record
 *     identity).
 *
 *  2. MENTION ≠ QUALITY (HELP-002 — "score contextual relevance and
 *     usefulness rather than mere product mention"). The quality input
 *     kinds are the evidence-backed fact kinds ONLY. There is NO input
 *     kind, weight, bonus or threshold adjustment through which a
 *     product mention contributes to a quality score.
 *
 *  3. AI IS ADVISORY AND PROVIDER-NEUTRAL (AI-004). Model outputs
 *     enter quality evaluation only as advisory scores with REQUIRED
 *     method identity and provider identity, at a bounded
 *     (`advisoryWeightFactor ≤ 1`) weight, and NEVER as the sole basis
 *     for a top band (the structural `advisoryOnlyCapBand` composition).
 *     Sentiment/positivity/tone are NOT quality vocabulary at all
 *     (incentives are never conditioned on sentiment — the frozen
 *     HELP-004 rule).
 *
 *  4. MODERATION HISTORY IS APPEND-ONLY. Decisions are a closed
 *     vocabulary of immutable records; the current status is DERIVED
 *     from the history, never stored or rewritten.
 *
 *  5. ABUSE/SPAM FEEDS THE EXISTING RISK AUTHORITY. The spam/abuse
 *     reason kinds below are the moderation-side classification that
 *     the composition root emits as /disputes risk signals (additive
 *     categories in core/risk.ts) — never a second fraud authority.
 */

// ---------------------------------------------------------------------------
// Quality input kinds (the evidence-backed fact vocabulary)
// ---------------------------------------------------------------------------

/**
 * The authoritative quality INPUT kinds. Each resolves through a truth
 * authority (the NET-W012 lookups) at evaluation time:
 *  - `proof_of_helpfulness` — the NET-W012 PoH aggregate state
 *    (QUALIFIED + its qualifying counts);
 *  - `evidence_record` — /evidence records for the contribution
 *    (grade/source-type/confidence minimums apply);
 *  - `measured_outcome` — /outcomes VERIFIED measured outcomes of
 *    qualifying types;
 *  - `proof_of_value` — /evidence VERIFIED proofs of value.
 *
 * Product mentions are STRUCTURALLY ABSENT from this list (HELP-002).
 */
export const QUALITY_INPUT_KINDS = [
  "proof_of_helpfulness",
  "evidence_record",
  "measured_outcome",
  "proof_of_value",
] as const;

export type QualityInputKind = (typeof QUALITY_INPUT_KINDS)[number];

export function isQualityInputKind(value: string): value is QualityInputKind {
  return (QUALITY_INPUT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Quality advisory kinds (the frozen measurement rule)
// ---------------------------------------------------------------------------

/**
 * Advisory score kinds — recorded SIGNALS, never qualifying inputs.
 * Model-generated scores carry provider/model identity (AI-004);
 * heuristic scores carry method identity. Method identity
 * (methodRef + methodVersion) is REQUIRED for every advisory score.
 */
export const QUALITY_ADVISORY_KINDS = [
  "model_score",
  "heuristic_score",
] as const;

export type QualityAdvisoryKind = (typeof QUALITY_ADVISORY_KINDS)[number];

export function isQualityAdvisoryKind(
  value: string,
): value is QualityAdvisoryKind {
  return (QUALITY_ADVISORY_KINDS as readonly string[]).includes(value);
}

/**
 * Validate an advisory weight factor: a finite number in [0, 1]. The
 * factor bounds HOW MUCH advisory scores may move a quality score —
 * they assist, never dominate.
 */
export function validateQualityAdvisoryWeight(value: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

// ---------------------------------------------------------------------------
// Quality bands (the deterministic outcome vocabulary)
// ---------------------------------------------------------------------------

/**
 * The quality bands in NORMATIVE ORDER (best → worst). Lower rank =
 * better quality. The structural composition rules (advisory-only cap,
 * missing-required-input floor) move a band toward WORSE (higher rank).
 */
export const QUALITY_BANDS = [
  "HIGH_QUALITY",
  "ADEQUATE",
  "LOW_QUALITY",
  "UNSATISFACTORY",
] as const;

export type QualityBand = (typeof QUALITY_BANDS)[number];

export const QUALITY_BAND_RANK: Readonly<Record<QualityBand, number>> = {
  HIGH_QUALITY: 0,
  ADEQUATE: 1,
  LOW_QUALITY: 2,
  UNSATISFACTORY: 3,
};

export function isQualityBand(value: string): value is QualityBand {
  return (QUALITY_BANDS as readonly string[]).includes(value);
}

/** The WORSE of two bands (the structural-composition direction). */
export function worseQualityBand(a: QualityBand, b: QualityBand): QualityBand {
  return QUALITY_BAND_RANK[a] >= QUALITY_BAND_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Quality score scale (the scaled-integer persisted form)
// ---------------------------------------------------------------------------

export const QUALITY_SCORE_DECIMALS = 6;
export const QUALITY_SCORE_SCALE = 1_000_000;

/**
 * Validate a quality score input: a finite number in [0, 1] (the
 * normalized domain; the persisted form is the scaled integer).
 */
export function validateQualityScore(value: number): boolean {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

/** Scale a normalized [0,1] score to the persisted integer form. */
export function scaleQualityScore(value: number): number {
  return Math.round(value * QUALITY_SCORE_SCALE);
}

// ---------------------------------------------------------------------------
// Moderation decision vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed moderation decision vocabulary. Decisions are immutable
 * append-only records; the contribution's CURRENT moderation status is
 * derived from the LATEST decision in the history.
 */
export const MODERATION_DECISIONS = [
  "APPROVE",
  "REJECT",
  "FLAG_FOR_REVIEW",
] as const;

export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export function isModerationDecision(
  value: string,
): value is ModerationDecision {
  return (MODERATION_DECISIONS as readonly string[]).includes(value);
}

/**
 * The closed moderation reason vocabulary. `spam` and `abuse` are the
 * ABUSE reason kinds: a decision carrying either triggers the
 * composition-root risk-signal emission into /disputes (work order
 * §3.5). `no_violation` is the affirmative APPROVE reason.
 */
export const MODERATION_REASON_KINDS = [
  "spam",
  "abuse",
  "policy_violation",
  "off_topic",
  "low_evidence_quality",
  "no_violation",
  "other",
] as const;

export type ModerationReasonKind = (typeof MODERATION_REASON_KINDS)[number];

export function isModerationReasonKind(
  value: string,
): value is ModerationReasonKind {
  return (MODERATION_REASON_KINDS as readonly string[]).includes(value);
}

/** The reasons that trigger the /disputes risk-signal emission. */
export const ABUSE_REASON_KINDS = ["spam", "abuse"] as const;

export type AbuseReasonKind = (typeof ABUSE_REASON_KINDS)[number];

export function isAbuseReasonKind(value: string): value is AbuseReasonKind {
  return (ABUSE_REASON_KINDS as readonly string[]).includes(value);
}

/**
 * The DERIVED contribution moderation statuses (never stored — computed
 * from the append-only decision history; UNMODERATED when no decision
 * exists).
 */
export const CONTRIBUTION_MODERATION_STATUSES = [
  "UNMODERATED",
  "APPROVED",
  "REJECTED",
  "FLAGGED_FOR_REVIEW",
] as const;

export type ContributionModerationStatus =
  (typeof CONTRIBUTION_MODERATION_STATUSES)[number];

export function isContributionModerationStatus(
  value: string,
): value is ContributionModerationStatus {
  return (
    (CONTRIBUTION_MODERATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Derive the moderation status for a decision kind. */
export function moderationStatusForDecision(
  decision: ModerationDecision,
): ContributionModerationStatus {
  switch (decision) {
    case "APPROVE":
      return "APPROVED";
    case "REJECT":
      return "REJECTED";
    case "FLAG_FOR_REVIEW":
      return "FLAGGED_FOR_REVIEW";
  }
}

// ---------------------------------------------------------------------------
// Policy format
// ---------------------------------------------------------------------------

/** The quality policy record format (participates in record identity). */
export const QUALITY_POLICY_FORMAT = "NET-W013:1";

// ---------------------------------------------------------------------------
// The policy shape + the PURE validator
// ---------------------------------------------------------------------------

import type { EvidenceGrade } from "./evidence.ts";

/** One authoritative input rule: kind + weight + minimum count. */
export interface QualityInputRule {
  readonly kind: QualityInputKind;
  /** Relative weight > 0 (finite). */
  readonly weight: number;
  /**
   * The attainment denominator: how many qualifying instances of the
   * kind constitute FULL attainment. 0 ⇒ binary attainment (any
   * qualifying instance counts as 1).
   */
  readonly minimumCount: number;
}

/** The advisory composition rules. */
export interface QualityAdvisoryRules {
  readonly allowedKinds: readonly QualityAdvisoryKind[];
  /**
   * The advisory weight factor f ∈ [0,1]: the score blends
   * `(1-f)·authoritative + f·advisoryAverage`. Advisory scores can
   * never dominate (f ≤ 1) and never alone lift the band above the
   * structural cap.
   */
  readonly advisoryWeightFactor: number;
}

/** The monotonic band thresholds (normalized score domain [0,1]). */
export interface QualityThresholds {
  readonly highQualityAt: number;
  readonly adequateAt: number;
  readonly lowQualityAt: number;
}

/**
 * The structural fail-safes (the risk-engine composition mirror):
 *  - `advisoryOnlyCapBand` — when NO authoritative input kind has any
 *    qualifying facts, the band is capped AT BEST at this band
 *    (validated ≤ ADEQUATE: AI alone can never certify top quality);
 *  - `requiredInputs` — input kinds that MUST have qualifying facts;
 *  - `missingInputFloorBand` — a missing required input floors the
 *    band AT BEST at this band (validated ≤ LOW_QUALITY — fail-closed).
 */
export interface QualityStructuralRules {
  readonly advisoryOnlyCapBand: QualityBand;
  readonly requiredInputs: readonly QualityInputKind[];
  readonly missingInputFloorBand: QualityBand;
}

/** The full deterministic quality policy shape (validated pure). */
export interface QualityPolicyShape {
  readonly inputs: readonly QualityInputRule[];
  readonly advisory: QualityAdvisoryRules;
  readonly minimumGrade: EvidenceGrade;
  readonly qualifyingSourceTypes: readonly string[];
  readonly qualifyingOutcomeTypes: readonly string[];
  readonly minimumConfidence: number;
  readonly thresholds: QualityThresholds;
  readonly structural: QualityStructuralRules;
  readonly description: string | null;
}

export type QualityPolicyShapeInput = QualityPolicyShape;

/**
 * Validate a quality policy shape — PURE, fail-closed. Returns the
 * normalized shape or throws a descriptive error.
 */
export function validateQualityPolicyShape(
  shape: QualityPolicyShapeInput,
): QualityPolicyShape {
  const errors: string[] = [];

  if (!Array.isArray(shape.inputs) || shape.inputs.length === 0) {
    errors.push("at least one input rule is required");
  } else {
    const seenKinds = new Set<string>();
    for (const rule of shape.inputs) {
      if (!isQualityInputKind(rule.kind)) {
        errors.push(
          `input kind '${String(rule.kind)}' is not a quality input kind (mention-like inputs are structurally absent — HELP-002)`,
        );
        continue;
      }
      if (seenKinds.has(rule.kind)) {
        errors.push(`duplicate input rule for kind '${rule.kind}'`);
      }
      seenKinds.add(rule.kind);
      if (
        typeof rule.weight !== "number" ||
        !Number.isFinite(rule.weight) ||
        rule.weight <= 0
      ) {
        errors.push(`input '${rule.kind}': weight must be > 0`);
      }
      if (
        typeof rule.minimumCount !== "number" ||
        !Number.isInteger(rule.minimumCount) ||
        rule.minimumCount < 0
      ) {
        errors.push(
          `input '${rule.kind}': minimumCount must be a non-negative integer`,
        );
      }
    }
  }

  const advisory = shape.advisory;
  if (
    !advisory ||
    !Array.isArray(advisory.allowedKinds) ||
    advisory.allowedKinds.length === 0 ||
    advisory.allowedKinds.some((k) => !isQualityAdvisoryKind(k))
  ) {
    errors.push(
      "advisory.allowedKinds must be a non-empty subset of the advisory kinds (model_score, heuristic_score)",
    );
  }
  if (
    !advisory ||
    !validateQualityAdvisoryWeight(advisory.advisoryWeightFactor ?? NaN)
  ) {
    errors.push(
      "advisory.advisoryWeightFactor must be a number in [0, 1] (advisory assists, never dominates)",
    );
  }

  if (
    typeof shape.minimumConfidence !== "number" ||
    !Number.isFinite(shape.minimumConfidence) ||
    shape.minimumConfidence < 0 ||
    shape.minimumConfidence > 1
  ) {
    errors.push("minimumConfidence must be a number in [0, 1]");
  }

  const t = shape.thresholds;
  if (
    !t ||
    !validateQualityScore(t.lowQualityAt ?? NaN) ||
    !validateQualityScore(t.adequateAt ?? NaN) ||
    !validateQualityScore(t.highQualityAt ?? NaN)
  ) {
    errors.push("thresholds must be numbers in [0, 1]");
  } else if (!(t.lowQualityAt <= t.adequateAt && t.adequateAt <= t.highQualityAt)) {
    errors.push(
      "thresholds must be monotonic: lowQualityAt ≤ adequateAt ≤ highQualityAt",
    );
  }

  const s = shape.structural;
  if (!s || !isQualityBand(s.advisoryOnlyCapBand ?? "")) {
    errors.push("structural.advisoryOnlyCapBand must be a quality band");
  } else if (QUALITY_BAND_RANK[s.advisoryOnlyCapBand] < QUALITY_BAND_RANK.ADEQUATE) {
    errors.push(
      "structural.advisoryOnlyCapBand may be at best ADEQUATE (advisory-only input sets can never certify HIGH_QUALITY — AI is not authoritative)",
    );
  }
  if (!s || !isQualityBand(s.missingInputFloorBand ?? "")) {
    errors.push("structural.missingInputFloorBand must be a quality band");
  } else if (
    QUALITY_BAND_RANK[s.missingInputFloorBand] < QUALITY_BAND_RANK.LOW_QUALITY
  ) {
    errors.push(
      "structural.missingInputFloorBand may be at best LOW_QUALITY (missing required inputs fail closed)",
    );
  }
  if (!s || !Array.isArray(s.requiredInputs)) {
    errors.push("structural.requiredInputs must be an array (may be empty)");
  } else {
    for (const kind of s.requiredInputs) {
      if (!isQualityInputKind(kind)) {
        errors.push(
          `structural.requiredInputs: '${String(kind)}' is not a quality input kind`,
        );
      }
    }
    const configured = new Set((shape.inputs ?? []).map((r) => r.kind));
    for (const kind of s.requiredInputs) {
      if (isQualityInputKind(kind) && !configured.has(kind)) {
        errors.push(
          `structural.requiredInputs: '${kind}' has no input rule (a required input must be configured)`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `invalid quality policy shape: ${errors.join("; ")}`,
    );
  }

  return {
    inputs: shape.inputs.map((r) => ({ ...r })),
    advisory: {
      allowedKinds: [...advisory.allowedKinds],
      advisoryWeightFactor: advisory.advisoryWeightFactor,
    },
    minimumGrade: shape.minimumGrade,
    qualifyingSourceTypes: [...shape.qualifyingSourceTypes],
    qualifyingOutcomeTypes: [...shape.qualifyingOutcomeTypes],
    minimumConfidence: shape.minimumConfidence,
    thresholds: { ...t },
    structural: {
      advisoryOnlyCapBand: s.advisoryOnlyCapBand,
      requiredInputs: [...s.requiredInputs],
      missingInputFloorBand: s.missingInputFloorBand,
    },
    description: shape.description ?? null,
  };
}
