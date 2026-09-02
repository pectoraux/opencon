/**
 * Shared decentralized validation/dispute vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §12 (challenge mechanisms are
 * part of the fraud posture), §18 (module ownership: /disputes owns
 * challenges, disputes, appeals and penalties — the W032 validation
 * coordination layer lives INSIDE that boundary), §19 (AI/model output
 * is never sufficient by itself to authorize settlement, reputation,
 * or governance state); spec/architecture-lock.md §2 (the sixteen
 * frozen core domains — /disputes is the Phase-3 Trust boundary),
 * §5 (economic authority: stake accounting belongs to /settlement).
 *
 * Work order ref: spec/work-orders/NET-W032.md
 *   §3.1 validator participant model (eligibility inputs),
 *   §3.2 deterministic assignment (frozen tie-break + cardinality),
 *   §3.3 challenge semantics (bounded window, terminal rounds),
 *   §3.4 validator observations,
 *   §3.5 quorum/outcome derivation (the versioned policy contract),
 *   §3.6 conflict-of-interest exclusions,
 *   §3.7 integrity/privacy (opaque references),
 *   §3.8 application through the owning authority.
 * Requirements: GOV-001..003 (decentralized validation/dispute
 * coordination), AUD-006 (dispute audit lineage).
 *
 * The `/disputes` boundary implements the behaviour; the vocabulary is
 * shared so infrastructure (API) and later work items consume the same
 * frozen terms. This module is data + pure validation ONLY — no I/O,
 * no wall clock reads inside pure helpers (every window computation
 * takes explicit timestamps), no lifecycle behaviour (round state is
 * IMMUTABLE FACTS + explicit outcome records — never a status machine;
 * work order §3.3).
 *
 * THE KEY RULES (work order §4 / §9 decision of record):
 *  - W032 is decentralized VALIDATION/DISPUTE COORDINATION inside
 *    /disputes: validators produce independent observations; a
 *    deterministic quorum derives an accepted result; ONLY the owning
 *    authority applies the result (never a validator, never the
 *    disputes domain);
 *  - /settlement remains the sole economic authority (validator
 *    stakes commit/release/forfeit ONLY through the settlement
 *    boundary's stake commands, orchestrated at the composition root);
 *  - /workflows remains the lifecycle authority; /reputation remains
 *    the reputation authority (accepted outcomes that revoke a W031
 *    portable proof apply through the reputation authority's own
 *    revocation command); /evidence + W029 remain the integrity
 *    primitive (referenced opaquely, never re-implemented);
 *  - closed rounds are IMMUTABLE: revalidation/rechallenge creates a
 *    NEW round record (never a rewrite of history);
 *  - derivation is DETERMINISTIC: reproducible from the recorded
 *    assignment set, the recorded observations, the frozen policy
 *    shape and an EXPLICIT evaluation anchor — never a wall clock.
 */

import { OpenConError } from "./errors.ts";

/**
 * The target kinds a validation challenge may reference (work order
 * §3.3: "the target claim/proof/resource", referenced OPAQUELY). The
 * closed set covers the mandated surfaces: the NET-W031 portable
 * reputation proof (the claim/proof case — resolvable through the
 * neutral proof lookup) and the three lifecycle/economic claim kinds
 * (contribution, measured outcome, economic value). Additional kinds
 * are additive frozen-vocabulary extensions, never silent.
 */
export const VALIDATION_TARGET_KINDS = [
  "reputation_proof",
  "contribution",
  "measured_outcome",
  "economic_value",
] as const;

export type ValidationTargetKind = (typeof VALIDATION_TARGET_KINDS)[number];

export function isValidationTargetKind(value: string): value is ValidationTargetKind {
  return (VALIDATION_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * The validator verdict vocabulary (one observation per validator per
 * round, work order §3.4):
 *  - `UPHOLD` — the validator upholds the challenge (the target claim
 *    is disputed successfully);
 *  - `REJECT` — the validator rejects the challenge (the target claim
 *    stands);
 *  - `ABSTAIN` — the validator explicitly abstains (counts toward
 *    participation, never toward agreement — see the quorum policy).
 */
export const VALIDATION_VERDICTS = ["UPHOLD", "REJECT", "ABSTAIN"] as const;

export type ValidationVerdict = (typeof VALIDATION_VERDICTS)[number];

export function isValidationVerdict(value: string): value is ValidationVerdict {
  return (VALIDATION_VERDICTS as readonly string[]).includes(value);
}

/**
 * The terminal outcome-decision vocabulary (work order §3.5: a closed
 * outcome vocabulary with fail-closed behaviour):
 *  - `UPHELD` — the quorum upholds the challenge (ACCEPTED: the
 *    target claim is invalidated; the owning authority may apply the
 *    sanctioned mutation);
 *  - `DENIED` — the quorum denies the challenge (ACCEPTED: the target
 *    claim stands);
 *  - `INSUFFICIENT_PARTICIPATION` — fail-closed: fewer valid
 *    observations than the policy's participation floor;
 *  - `NO_QUORUM` — fail-closed: neither threshold met (split/abstain
 *    heavy rounds);
 *  - `CONFLICTED_QUORUM` — fail-closed: BOTH thresholds met (a
 *  contradictory split cannot resolve deterministically);
 *  - `WINDOW_EXPIRED` — fail-closed: the derivation anchor is after
 *    the bounded challenge window's expiry.
 */
export const VALIDATION_DECISIONS = [
  "UPHELD",
  "DENIED",
  "INSUFFICIENT_PARTICIPATION",
  "NO_QUORUM",
  "CONFLICTED_QUORUM",
  "WINDOW_EXPIRED",
] as const;

export type ValidationDecision = (typeof VALIDATION_DECISIONS)[number];

export function isValidationDecision(value: string): value is ValidationDecision {
  return (VALIDATION_DECISIONS as readonly string[]).includes(value);
}

/** The ACCEPTED decisions (definitive merits outcomes, applicable). */
export const ACCEPTED_VALIDATION_DECISIONS: readonly ValidationDecision[] = [
  "UPHELD",
  "DENIED",
];

export function isAcceptedValidationDecision(
  value: string,
): value is "UPHELD" | "DENIED" {
  return (ACCEPTED_VALIDATION_DECISIONS as readonly string[]).includes(value);
}

/**
 * The deterministic eligibility-exclusion reasons recorded on the
 * assignment-set derivation trace (work order §3.6: auditable
 * exclusions — every considered-but-excluded candidate carries its
 * machine-readable reason).
 */
export const VALIDATOR_EXCLUSION_REASONS = [
  "suspended",
  "target_subject",
  "target_beneficiary",
  "challenge_initiator",
  "explicitly_conflicted",
] as const;

export type ValidatorExclusionReason =
  (typeof VALIDATOR_EXCLUSION_REASONS)[number];

export function isValidatorExclusionReason(
  value: string,
): value is ValidatorExclusionReason {
  return (VALIDATOR_EXCLUSION_REASONS as readonly string[]).includes(value);
}

/**
 * The closed evidence-reference kinds an observation may cite (work
 * order §3.7: opaque references to W029 integrity records and W031
 * proofs — minimum aggregate disclosure, never private source
 * history). Resolved read-only through the neutral lookups at
 * submission; never stored with content.
 */
export const VALIDATION_EVIDENCE_REF_KINDS = [
  "signed_attestation",
  "reputation_proof",
] as const;

export type ValidationEvidenceRefKind =
  (typeof VALIDATION_EVIDENCE_REF_KINDS)[number];

export function isValidationEvidenceRefKind(
  value: string,
): value is ValidationEvidenceRefKind {
  return (VALIDATION_EVIDENCE_REF_KINDS as readonly string[]).includes(value);
}

/**
 * The W032 protocol version stamped on every record (deterministic
 * reproducibility: the eligibility rules, the assignment ordering, the
 * quorum contract and the stake mapping are the recorded behaviour of
 * this version). Bumping this constant starts a new protocol lineage.
 */
export const VALIDATION_PROTOCOL_VERSION = "NET-W032:1" as const;

/**
 * The frozen DEFAULT challenge window (milliseconds) — the bounded
 * round window anchoring at the challenge's explicit `effectiveAt`
 * (work order §3.3). A per-policy `challengeWindowMs` overrides it;
 * every check takes explicit timestamps — never a wall clock.
 */
export const VALIDATION_CHALLENGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The quorum policy shape — the VERSIONED policy contract (work order
 * §3.5: these rules must be represented by a versioned policy, not
 * undocumented constants). All thresholds are COUNT-BASED absolute
 * integers over the recorded assignment set:
 *  - `assignmentCardinality` — the EXACT number of validators selected
 *    per round (the deterministic assignment size);
 *  - `minimumSubmitted` — the participation floor: fewer VALID
 *    observations than this fails closed
 *    (INSUFFICIENT_PARTICIPATION);
 *  - `upholdThreshold` — the absolute count of UPHOLD verdicts that
 *    decides UPHELD;
 *  - `rejectThreshold` — the absolute count of REJECT verdicts that
 *    decides DENIED;
 *  - `challengeWindowMs` — the bounded round window (anchored at the
 *    challenge's effectiveAt);
 *  - `validatorStakeRequirementCredits` — the per-validator,
 *    per-assignment eligibility bond (0 = no stake requirement; a
 *    positive requirement must be bonded through /settlement before
 *    the assigned validator's observation is accepted).
 *
 * DECISIONS OF RECORD (work order §3.5, "make explicit before merge"):
 *  - thresholds are COUNT-based (no weights, no stake-weighted votes);
 *  - ABSTAIN counts toward participation, never toward agreement;
 *  - an INVALID observation is excluded entirely (never counted);
 *  - tie/conflict: BOTH thresholds met ⇒ CONFLICTED_QUORUM (fail
 *    closed); exactly one met ⇒ that decision; neither ⇒ NO_QUORUM;
 *  - duplicate submissions are impossible by construction (one
 *    observation per (round, validator) — a second submission with a
 *    fresh key is a CONFLICT);
 *  - a rechallenge/revalidation creates a NEW round (closed rounds are
 *    immutable), never mutates the closed round.
 */
export interface ValidationQuorumPolicyShape {
  readonly assignmentCardinality: number;
  readonly minimumSubmitted: number;
  readonly upholdThreshold: number;
  readonly rejectThreshold: number;
  readonly challengeWindowMs: number;
  readonly validatorStakeRequirementCredits: number;
}

/** The bounds keep the policy contract sane and frozen-checkable. */
export const VALIDATION_POLICY_MAX_CARDINALITY = 64;
export const VALIDATION_POLICY_MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
export const VALIDATION_POLICY_MAX_STAKE_CREDITS = 1_000_000;

/**
 * Pure shape validation for a quorum policy version (throws a stable
 * `VALIDATION_POLICY_VALIDATION` error). Cross-field rules:
 * cardinality ≥ minimumSubmitted, upholdThreshold and
 * rejectThreshold ≤ cardinality (a threshold above the assignment
 * size could never decide anything); all thresholds positive; the
 * window positive and bounded; the stake requirement a non-negative
 * integer.
 */
export function validateValidationQuorumPolicyShape(
  raw: {
    assignmentCardinality: number;
    minimumSubmitted: number;
    upholdThreshold: number;
    rejectThreshold: number;
    challengeWindowMs: number;
    validatorStakeRequirementCredits: number;
  },
): ValidationQuorumPolicyShape {
  const shape: ValidationQuorumPolicyShape = {
    assignmentCardinality: raw.assignmentCardinality,
    minimumSubmitted: raw.minimumSubmitted,
    upholdThreshold: raw.upholdThreshold,
    rejectThreshold: raw.rejectThreshold,
    challengeWindowMs: raw.challengeWindowMs,
    validatorStakeRequirementCredits: raw.validatorStakeRequirementCredits,
  };
  const fail = (message: string, context: Readonly<Record<string, unknown>>): OpenConError =>
    new OpenConError({
      code: "VALIDATION_POLICY_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  for (const field of ["assignmentCardinality", "minimumSubmitted", "upholdThreshold", "rejectThreshold"] as const) {
    const value = shape[field];
    if (!Number.isInteger(value) || value < 1) {
      throw fail(
        `validation policy field ${field} must be a positive integer (got ${String(value)})`,
        { field, value },
      );
    }
  }
  if (shape.assignmentCardinality > VALIDATION_POLICY_MAX_CARDINALITY) {
    throw fail(
      `validation policy assignmentCardinality must not exceed ${String(VALIDATION_POLICY_MAX_CARDINALITY)} (got ${String(shape.assignmentCardinality)})`,
      { field: "assignmentCardinality", value: shape.assignmentCardinality },
    );
  }
  if (shape.minimumSubmitted > shape.assignmentCardinality) {
    throw fail(
      `validation policy minimumSubmitted (${String(shape.minimumSubmitted)}) must not exceed assignmentCardinality (${String(shape.assignmentCardinality)})`,
      { minimumSubmitted: shape.minimumSubmitted, assignmentCardinality: shape.assignmentCardinality },
    );
  }
  if (shape.upholdThreshold > shape.assignmentCardinality) {
    throw fail(
      `validation policy upholdThreshold (${String(shape.upholdThreshold)}) must not exceed assignmentCardinality (${String(shape.assignmentCardinality)})`,
      { upholdThreshold: shape.upholdThreshold, assignmentCardinality: shape.assignmentCardinality },
    );
  }
  if (shape.rejectThreshold > shape.assignmentCardinality) {
    throw fail(
      `validation policy rejectThreshold (${String(shape.rejectThreshold)}) must not exceed assignmentCardinality (${String(shape.assignmentCardinality)})`,
      { rejectThreshold: shape.rejectThreshold, assignmentCardinality: shape.assignmentCardinality },
    );
  }
  if (
    !Number.isInteger(shape.challengeWindowMs) ||
    shape.challengeWindowMs < 1 ||
    shape.challengeWindowMs > VALIDATION_POLICY_MAX_WINDOW_MS
  ) {
    throw fail(
      `validation policy challengeWindowMs must be a positive integer of at most ${String(VALIDATION_POLICY_MAX_WINDOW_MS)} ms (got ${String(shape.challengeWindowMs)})`,
      { field: "challengeWindowMs", value: shape.challengeWindowMs },
    );
  }
  if (
    !Number.isInteger(shape.validatorStakeRequirementCredits) ||
    shape.validatorStakeRequirementCredits < 0 ||
    shape.validatorStakeRequirementCredits > VALIDATION_POLICY_MAX_STAKE_CREDITS
  ) {
    throw fail(
      `validation policy validatorStakeRequirementCredits must be a non-negative integer of at most ${String(VALIDATION_POLICY_MAX_STAKE_CREDITS)} (got ${String(shape.validatorStakeRequirementCredits)})`,
      { field: "validatorStakeRequirementCredits", value: shape.validatorStakeRequirementCredits },
    );
  }
  return shape;
}

/**
 * Validate an explicit ISO-8601 timestamp (pure). Throws a stable
 * `VALIDATION_VALIDATION` error unless the value parses.
 */
export function validateValidationTimestamp(field: string, value: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new OpenConError({
      code: "VALIDATION_VALIDATION",
      classification: "validation",
      message: `validation field ${field} must be a valid ISO-8601 timestamp (got ${String(value)})`,
      context: { field, value },
    });
  }
  return value;
}

/**
 * Deterministically add milliseconds to an ISO-8601 timestamp (pure —
 * no wall clock): the bounded-round window-expiry computation.
 */
export function addValidationWindowMs(anchorAt: string, windowMs: number): string {
  const anchor = Date.parse(anchorAt);
  if (Number.isNaN(anchor)) {
    throw new OpenConError({
      code: "VALIDATION_VALIDATION",
      classification: "validation",
      message: `window anchor must be a valid ISO-8601 timestamp (got ${String(anchorAt)})`,
      context: { anchorAt },
    });
  }
  return new Date(anchor + windowMs).toISOString();
}

/** The bounded-round window expiry for a challenge anchored at `anchorAt`. */
export function validationWindowExpiry(anchorAt: string, windowMs: number): string {
  return addValidationWindowMs(anchorAt, windowMs);
}

/**
 * The deterministic in-window check (pure): `at` must fall in
 * [anchorAt, anchorAt + windowMs] (inclusive bounds — the same
 * inclusive-bounds convention as the NET-W009/W010 windows).
 */
export function isWithinValidationWindow(
  at: string,
  anchorAt: string,
  windowMs: number,
): boolean {
  const t = Date.parse(at);
  const anchor = Date.parse(anchorAt);
  return t >= anchor && t <= anchor + windowMs;
}

/**
 * The stake dispositions the validation round records for a BONDED
 * validator assignment (work order §3.8: economic consequences execute
 * ONLY through /settlement; the disputes domain records what settlement
 * executed). `NONE`-like "not bonded" is structural (no stakeId), not
 * a disposition.
 */
export const VALIDATOR_STAKE_DISPOSITIONS = ["RELEASE", "FORFEIT"] as const;

export type ValidatorStakeDisposition =
  (typeof VALIDATOR_STAKE_DISPOSITIONS)[number];

export function isValidatorStakeDisposition(
  value: string,
): value is ValidatorStakeDisposition {
  return (VALIDATOR_STAKE_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * The DETERMINISTIC closure→stake mapping for a bonded validator
 * (invariant: reviewers/validators cannot override it):
 *  - the validator SUBMITTED an observation (any verdict, including
 *    ABSTAIN) ⇒ RELEASE — participation was the skin-in-the-game and
 *    honest participation is never penalized (no minority-dissent
 *    slashing);
 *  - the validator bonded a stake but NEVER submitted ⇒ FORFEIT — the
 *    non-participation penalty (a bonded-silent validator withheld the
 *    round's quorum input after committing to provide it).
 * Applied uniformly on EVERY terminal closure (accepted and
 * fail-closed alike): a terminal round resolves its eligibility bonds.
 */
export function validatorStakeDispositionForClosure(submitted: boolean): ValidatorStakeDisposition {
  return submitted ? "RELEASE" : "FORFEIT";
}

/**
 * The closed vocabulary of outcome APPLICATIONS (work order §3.8: the
 * owning-authority mutation an accepted outcome may drive, composed at
 * the composition root through the owner's sanctioned command). The
 * delivered contract: an UPHELD challenge against a W031 portable
 * reputation proof revokes the proof through the /reputation
 * authority's own one-way revocation command (verified read-only by
 * the disputes domain before the application fact is recorded).
 * Lifecycle/economic end-to-end application composites are NET-W033+
 * scope (work order §7) — deliberately absent, never silent.
 */
export const VALIDATION_OUTCOME_APPLICATIONS = [
  "reputation_proof_revocation",
] as const;

export type ValidationOutcomeApplication =
  (typeof VALIDATION_OUTCOME_APPLICATIONS)[number];

export function isValidationOutcomeApplication(
  value: string,
): value is ValidationOutcomeApplication {
  return (VALIDATION_OUTCOME_APPLICATIONS as readonly string[]).includes(value);
}
