/**
 * QuorumEngine — the PURE, deterministic quorum/outcome derivation for
 * the NET-W032 decentralized validation/dispute coordination layer
 * (work order §3.5).
 *
 * Architecture ref: spec/architecture.md §12, §18 (module ownership:
 * /disputes owns the validation coordination and the outcome
 * derivation), §19; spec/architecture-lock.md §2.
 *
 * DETERMINISM (invariant 4 / work order §3.5): the derivation is a
 * PURE FUNCTION of the RECORDED inputs — the frozen policy shape, the
 * recorded assignment set, the recorded observations and the EXPLICIT
 * evaluation anchor. No I/O, no wall clock, no ambient mutable state:
 * the identical input always produces the identical decision,
 * participation block, trace and checks (reproducible by any auditor
 * from the recorded records).
 *
 * FAIL-CLOSED CONTRACT (the closed decision vocabulary, in
 * precedence order):
 *  1. the evaluation anchor is after the bounded window's expiry ⇒
 *     `WINDOW_EXPIRED`;
 *  2. valid observations < policy.minimumSubmitted ⇒
 *     `INSUFFICIENT_PARTICIPATION`;
 *  3. BOTH the uphold and reject thresholds are met ⇒
 *     `CONFLICTED_QUORUM` (a contradictory split cannot resolve
 *     deterministically — never a coin flip);
 *  4. exactly one threshold met ⇒ `UPHELD` or `DENIED` (the ACCEPTED
 *     decisions);
 *  5. neither met ⇒ `NO_QUORUM`.
 *
 * OBSERVATION VALIDITY (re-checked at derivation, defense in depth —
 * submission already gated these; the derivation never trusts stored
 * invariants it can re-derive): an observation is INCLUDED only when
 * its validator is in the recorded assignment set, its verdict is in
 * the closed vocabulary, its observedAt falls within the round window
 * (inclusive bounds) and it is the FIRST observation of that validator
 * (deterministic (observedAt, observationId) ordering — duplicates
 * are excluded as `duplicate_validator`). INVALID OBSERVATIONS ARE
 * NEVER COUNTED (work order §3.5), and every exclusion is carried in
 * the machine-readable trace (auditability, §3.4).
 *
 * ABSTENTION: an explicit ABSTAIN verdict counts toward participation
 * (submitted/valid) but never toward agreement (uphold/reject) — the
 * decision of record in core/validation.ts.
 *
 * Tier compliance: disputes domain → self + core contracts only (this
 * module is pure core-contract consumption — the same discipline as
 * risk-engine.ts; re-exported from the boundary's public index).
 */

import {
  isValidationVerdict,
  type ValidationDecision,
  type ValidationQuorumPolicyShape,
  type ValidationVerdict,
} from "../core/validation.ts";

/** One recorded observation as seen by the engine (a projection). */
export interface QuorumEngineObservation {
  readonly observationId: string;
  readonly validatorPersonId: string;
  readonly verdict: string;
  readonly observedAt: string;
}

/** The complete derivation input — every field RECORDED state or an explicit anchor. */
export interface QuorumEngineInput {
  readonly policy: ValidationQuorumPolicyShape;
  /** The round window start (the challenge's effectiveAt). */
  readonly windowStartAt: string;
  /** The round window expiry (effectiveAt + policy.challengeWindowMs). */
  readonly windowExpiresAt: string;
  /** The EXPLICIT evaluation anchor (deterministic — never a wall clock). */
  readonly evaluatedAt: string;
  /** The recorded assignment set's validator person ids (selection order). */
  readonly assignedValidatorPersonIds: readonly string[];
  /** The recorded observations (the engine re-validates each). */
  readonly observations: readonly QuorumEngineObservation[];
}

/**
 * One machine-readable derivation check (the fixed order: window →
 * participation → quorum). `subject` carries the pinpointing context;
 * `reason` is a closed token per check.
 */
export interface QuorumEngineCheck {
  readonly check: "window" | "participation" | "quorum";
  readonly subject: string | null;
  readonly passed: boolean;
  readonly reason: string;
}

/** One observation's inclusion/exclusion entry (the derivation trace). */
export interface QuorumEngineTraceEntry {
  readonly observationId: string;
  readonly validatorPersonId: string;
  readonly verdict: string;
  readonly observedAt: string;
  readonly included: boolean;
  readonly exclusionReason: string | null;
}

/** The deterministic derivation result. */
export interface QuorumEngineResult {
  readonly decision: ValidationDecision;
  readonly participation: {
    readonly assignedCount: number;
    readonly submittedCount: number;
    readonly validCount: number;
    readonly upholdCount: number;
    readonly rejectCount: number;
    readonly abstainCount: number;
    readonly excludedCount: number;
  };
  readonly trace: readonly QuorumEngineTraceEntry[];
  readonly checks: readonly QuorumEngineCheck[];
}

/**
 * Derive the quorum outcome (PURE). The observations are processed in
 * deterministic (observedAt, observationId) order so a duplicate
 * validator's FIRST observation (by that order) is the included one.
 */
export function deriveQuorumOutcome(input: QuorumEngineInput): QuorumEngineResult {
  const { policy, windowStartAt, windowExpiresAt, evaluatedAt } = input;
  const assigned = new Set<string>(input.assignedValidatorPersonIds);

  // Deterministic processing order: (observedAt, observationId).
  const ordered = [...input.observations].sort((a, b) =>
    a.observedAt === b.observedAt
      ? a.observationId < b.observationId
        ? -1
        : 1
      : a.observedAt < b.observedAt
        ? -1
        : 1,
  );

  const trace: QuorumEngineTraceEntry[] = [];
  const seenValidators = new Set<string>();
  let upholdCount = 0;
  let rejectCount = 0;
  let abstainCount = 0;
  let validCount = 0;
  for (const observation of ordered) {
    const assignedValidator = assigned.has(observation.validatorPersonId);
    const verdictValid = isValidationVerdict(observation.verdict);
    const withinWindow =
      Date.parse(observation.observedAt) >= Date.parse(windowStartAt) &&
      Date.parse(observation.observedAt) <= Date.parse(windowExpiresAt);
    const duplicate = seenValidators.has(observation.validatorPersonId);
    const included =
      assignedValidator && verdictValid && withinWindow && !duplicate;
    const exclusionReason = included
      ? null
      : !assignedValidator
        ? "not_assigned"
        : duplicate
          ? "duplicate_validator"
          : !verdictValid
            ? "invalid_verdict"
            : "outside_window";
    if (included) {
      // Only an INCLUDED observation consumes the validator's slot —
      // an excluded (invalid/unassigned/out-of-window) observation
      // never blocks a later VALID observation from the same
      // validator (the re-validation is defense in depth; the
      // recorded invariant is one observation per validator).
      seenValidators.add(observation.validatorPersonId);
      validCount += 1;
      const verdict: ValidationVerdict = observation.verdict;
      if (verdict === "UPHOLD") upholdCount += 1;
      else if (verdict === "REJECT") rejectCount += 1;
      else abstainCount += 1;
    }
    trace.push(
      Object.freeze({
        observationId: observation.observationId,
        validatorPersonId: observation.validatorPersonId,
        verdict: observation.verdict,
        observedAt: observation.observedAt,
        included,
        exclusionReason,
      }),
    );
  }

  const submittedCount = input.observations.length;
  const excludedCount = submittedCount - validCount;

  // ---- Check 1: the window (the evaluation anchor within the round). --
  const windowOpen = Date.parse(evaluatedAt) <= Date.parse(windowExpiresAt);
  const windowCheck: QuorumEngineCheck = Object.freeze({
    check: "window",
    subject: windowExpiresAt,
    passed: windowOpen,
    reason: windowOpen ? "window_open" : "window_expired",
  });

  // ---- Check 2: participation (the count-based floor). ----------------
  const participationMet = validCount >= policy.minimumSubmitted;
  const participationCheck: QuorumEngineCheck = Object.freeze({
    check: "participation",
    subject: `${String(validCount)}/${String(policy.minimumSubmitted)}`,
    passed: participationMet,
    reason: participationMet ? "participation_sufficient" : "insufficient_participation",
  });

  // ---- Check 3: the quorum thresholds (count-based, absolute). --------
  const upholdMet = upholdCount >= policy.upholdThreshold;
  const rejectMet = rejectCount >= policy.rejectThreshold;
  let quorumReason: string;
  if (upholdMet && rejectMet) quorumReason = "conflicted_quorum";
  else if (upholdMet) quorumReason = "upheld";
  else if (rejectMet) quorumReason = "denied";
  else quorumReason = "no_quorum";
  const quorumPassed = upholdMet || rejectMet;
  const quorumCheck: QuorumEngineCheck = Object.freeze({
    check: "quorum",
    subject: `uphold=${String(upholdCount)}/${String(policy.upholdThreshold)},reject=${String(rejectCount)}/${String(policy.rejectThreshold)}`,
    passed: quorumPassed,
    reason: quorumReason,
  });

  // ---- The decision (fixed precedence, fail-closed). -----------------
  let decision: ValidationDecision;
  if (!windowOpen) decision = "WINDOW_EXPIRED";
  else if (!participationMet) decision = "INSUFFICIENT_PARTICIPATION";
  else if (upholdMet && rejectMet) decision = "CONFLICTED_QUORUM";
  else if (upholdMet) decision = "UPHELD";
  else if (rejectMet) decision = "DENIED";
  else decision = "NO_QUORUM";

  return Object.freeze({
    decision,
    participation: Object.freeze({
      assignedCount: input.assignedValidatorPersonIds.length,
      submittedCount,
      validCount,
      upholdCount,
      rejectCount,
      abstainCount,
      excludedCount,
    }),
    trace: Object.freeze(trace),
    checks: Object.freeze([windowCheck, participationCheck, quorumCheck]),
  });
}
