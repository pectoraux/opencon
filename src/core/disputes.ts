/**
 * Shared challenge/dispute vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §12 (challenge mechanisms are
 * part of the fraud posture), §18 (module ownership: /disputes owns
 * challenges, disputes, appeals and penalties), §19 (AI/model output
 * is never sufficient by itself to authorize settlement, reputation,
 * or governance state); spec/architecture-lock.md §2 (the sixteen
 * frozen core domains — /disputes is the Phase-3 Trust boundary),
 * §5 (economic authority: stake accounting belongs to /settlement),
 * §13 invariant 21 (a disputed or fraud-held claim cannot mature
 * until the applicable resolution policy permits it).
 *
 * Work order ref: spec/work-orders/NET-W010.md §3.1.
 * Requirements: DISPUTE-001..005 (challenges/disputes/appeals/stake),
 * GOV-002..003, AUD-006 (dispute audit lineage).
 *
 * The `/disputes` boundary implements the behaviour; the vocabulary is
 * shared so infrastructure (API) and later work items consume the same
 * frozen terms. This module is data + pure validation ONLY — no I/O,
 * no wall clock reads inside pure helpers (every window computation
 * takes explicit timestamps), no lifecycle behaviour (the state
 * machine validation lives in the dispute service).
 *
 * THE KEY RULES (work order §4):
 *  - disputes own the challenge/review DECISION only: /workflows
 *    remains the lifecycle authority, /settlement remains the economic
 *    authority (stake is committed/released/forfeited ONLY through
 *    explicit settlement commands — the dispute domain carries NO
 *    economic-unit mutation methods), /evidence remains the truth
 *    authority, /reputation remains the trust-signal authority;
 *  - appeals create NEW linked records — prior decisions are never
 *    rewritten (append-only resolution, invariant 8);
 *  - eligibility, deadlines, state transitions and resolution
 *    disposition are DETERMINISTIC: reproducible from explicit
 *    timestamps, the recorded policy version, and stored records
 *    (invariant 4).
 */

import { OpenConError } from "./errors.ts";

/**
 * The dispute record kinds. A `CHALLENGE` is a participant-initiated
 * challenge against a prior decision / risk case / authoritative
 * record. An `APPEAL` is a new linked record created against a
 * RESOLVED dispute's outcome (0..n appeals — each appeal is itself a
 * full dispute record with its own stake and review cycle; the
 * appealed original flips to the terminal `APPEALED` state with an
 * append-only event, never a rewrite).
 */
export const DISPUTE_KINDS = ["CHALLENGE", "APPEAL"] as const;

export type DisputeKind = (typeof DISPUTE_KINDS)[number];

export function isDisputeKind(value: string): value is DisputeKind {
  return (DISPUTE_KINDS as readonly string[]).includes(value);
}

/**
 * The deterministic dispute state machine (work item §Scope):
 *
 * ```text
 * PENDING_STAKE ──bond_stake──→ OPEN ──start_review──→ UNDER_REVIEW ──resolve──→ RESOLVED
 *       │                        │  │                                               │
 *       └── withdraw ────────────┘  └── withdraw ──→ WITHDRAWN                      └── appeal (within window) ──→ APPEALED
 *                                │                                                   (a NEW linked APPEAL record opens
 *                                └── reject ──→ REJECTED                              its own PENDING_STAKE cycle)
 *                                └── reject (from UNDER_REVIEW) ──→ REJECTED
 * ```
 *
 *  - `PENDING_STAKE` — the challenge request passed the eligibility
 *    gate but the explicit stake has not been committed yet. It is
 *    NOT a formal dispute: it does not gate downstream operations
 *    (griefing resistance — an unbonded request can never freeze
 *    value) and it can be withdrawn costlessly.
 *  - `OPEN` — the stake is committed through the settlement
 *    authority; the formal dispute is live (this and the following
 *    two states ARE active: they gate downstream operations).
 *  - `UNDER_REVIEW` — a reviewer (conflict-checked) has taken the
 *    dispute.
 *  - `RESOLVED` — terminal for the decision content (the resolution
 *    block is immutable); the ONLY legal forward transition is
 *    `appeal` within the appeal window.
 *  - `APPEALED` — terminal: the outcome was appealed; the linked
 *    appeal record carries the live cycle.
 *  - `REJECTED` — terminal: the challenge was inadmissible (stake
 *    disposition is deterministically RELEASE).
 *  - `WITHDRAWN` — terminal: the challenger withdrew before review
 *    resolution (stake disposition is deterministically RELEASE).
 */
export const DISPUTE_STATES = [
  "PENDING_STAKE",
  "OPEN",
  "UNDER_REVIEW",
  "APPEALED",
  "RESOLVED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export type DisputeState = (typeof DISPUTE_STATES)[number];

export function isDisputeState(value: string): value is DisputeState {
  return (DISPUTE_STATES as readonly string[]).includes(value);
}

/**
 * The states that gate downstream operations (the composition-root
 * `refuseWhenDisputed` consults exactly these). `PENDING_STAKE` is
 * deliberately excluded: an unbonded challenge request must never
 * freeze value (griefing resistance — only a STAKED, formal dispute
 * can hold a claim; architecture-lock invariant 21 requires a
 * disputed claim, and a dispute without a stake is not yet one).
 */
export const ACTIVE_DISPUTE_STATES: readonly DisputeState[] = [
  "OPEN",
  "UNDER_REVIEW",
  "APPEALED",
];

/**
 * The states in which a dispute's lifecycle can still move (used for
 * duplicate-challenge checks: a subject with a live dispute cycle
 * cannot be challenged again — the outcome must resolve, or be
 * appealed, first).
 */
export const LIVE_DISPUTE_STATES: readonly DisputeState[] = [
  "PENDING_STAKE",
  "OPEN",
  "UNDER_REVIEW",
];

/**
 * The deterministic resolution outcomes (relative to the CHALLENGED
 * decision):
 *  - `UPHELD` — the challenge has merit: the prior decision is
 *    overturned/invalidated (the challenger's stake is RELEASE).
 *  - `DENIED` — the prior decision stands (the challenge was heard on
 *    the merits and lost — the challenger's stake is FORFEIT: the
 *    documented penalty for an unsuccessful challenge).
 *  - `DISMISSED` — procedurally resolved without a merits decision
 *    (e.g. the subject was already reversed/corrected): the
 *    challenger's stake is RELEASE.
 */
export const DISPUTE_OUTCOMES = ["UPHELD", "DENIED", "DISMISSED"] as const;

export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export function isDisputeOutcome(value: string): value is DisputeOutcome {
  return (DISPUTE_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The provider-neutral control dispositions a resolution records for
 * workflow/control consumers (work item: "keep a hold active, release
 * a hold, require re-evaluation"):
 *  - `MAINTAIN_CONTROL` — active risk controls covering the subject
 *    stay active;
 *  - `RELEASE_CONTROL` — the consumer may release holds/controls
 *    covering the subject (through the owning authority's own
 *    commands);
 *  - `REQUIRE_REEVALUATION` — the consumer should re-run evaluation
 *    (e.g. re-assess risk, re-verify evidence) before proceeding.
 * A fourth economic hook — authorizing a later economic CORRECTION —
 * is carried by the stake/economic consequence path (the settlement
 * authority's explicit reversal commands), never by direct mutation.
 */
export const DISPUTE_CONTROL_DISPOSITIONS = [
  "MAINTAIN_CONTROL",
  "RELEASE_CONTROL",
  "REQUIRE_REEVALUATION",
] as const;

export type DisputeControlDisposition =
  (typeof DISPUTE_CONTROL_DISPOSITIONS)[number];

export function isDisputeControlDisposition(
  value: string,
): value is DisputeControlDisposition {
  return (DISPUTE_CONTROL_DISPOSITIONS as readonly string[]).includes(value);
}

/** The stake dispositions the dispute lifecycle derives/records. */
export const DISPUTE_STAKE_DISPOSITIONS = ["NONE", "RELEASE", "FORFEIT"] as const;

export type DisputeStakeDisposition = (typeof DISPUTE_STAKE_DISPOSITIONS)[number];

export function isDisputeStakeDisposition(
  value: string,
): value is DisputeStakeDisposition {
  return (DISPUTE_STAKE_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * The DETERMINISTIC outcome→stake mapping (invariant 4 — reviewers
 * cannot override it): REJECTED (inadmissible) → RELEASE; UPHELD →
 * RELEASE (a successful challenge is never penalized); DISMISSED →
 * RELEASE (no merits decision, no penalty); DENIED → FORFEIT (the
 * documented unsuccessful-challenge penalty). WITHDRAWN → RELEASE.
 */
export function stakeDispositionForOutcome(
  outcome: DisputeOutcome,
): DisputeStakeDisposition {
  switch (outcome) {
    case "UPHELD":
      return "RELEASE";
    case "DISMISSED":
      return "RELEASE";
    case "DENIED":
      return "FORFEIT";
  }
}

/**
 * The authoritative record kinds a dispute may be about (the subject
 * vocabulary — "prior decision / risk case / authoritative record").
 * Resolution may challenge, suspend, route or re-evaluate these — but
 * never mutate them directly (authority separation, invariant 5).
 */
export const DISPUTE_SUBJECT_TYPES = [
  "contribution",
  "proof_of_value",
  "measured_outcome",
  "economic_value",
  "credit_issuance",
  "cash_obligation",
  "risk_case",
  "risk_control_decision",
] as const;

export type DisputeSubjectType = (typeof DISPUTE_SUBJECT_TYPES)[number];

export function isDisputeSubjectType(
  value: string,
): value is DisputeSubjectType {
  return (DISPUTE_SUBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * The dispute policy version stamped on every record (deterministic
 * reproducibility, invariant 4: eligibility windows, the state
 * machine and the stake mapping are the recorded behaviour of this
 * version). Bumping this constant starts a new policy lineage.
 */
export const DISPUTE_POLICY_VERSION = "NET-W010:1" as const;

/**
 * The frozen default windows (milliseconds). The challenge window
 * anchors at the SUBJECT's authoritative timestamp (the resolved
 * subject lookup returns it); the appeal window anchors at the
 * resolution's `resolvedAt`. All checks take explicit timestamps —
 * never a wall clock.
 */
export const DISPUTE_CHALLENGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const DISPUTE_APPEAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The frozen default stake requirement for challenge participation:
 * 10 Participation Credits, committed through the settlement
 * authority's stake command (work item: stake is explicit, escrowed
 * accounting — never a hidden balance mutation).
 */
export const DISPUTE_STAKE_REQUIREMENT_CREDITS = 10;

/**
 * Validate an explicit ISO-8601 timestamp (pure). Throws a stable
 * `DISPUTE_VALIDATION` error unless the value parses.
 */
export function validateDisputeTimestamp(field: string, value: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new OpenConError({
      code: "DISPUTE_VALIDATION",
      classification: "validation",
      message: `dispute field ${field} must be a valid ISO-8601 timestamp (got ${String(value)})`,
      context: { field, value },
    });
  }
  return value;
}

/**
 * Deterministically add milliseconds to an ISO-8601 timestamp
 * (pure — no wall clock): the window-expiry computation used by the
 * eligibility gate.
 */
export function addWindowMs(anchorAt: string, windowMs: number): string {
  const anchor = Date.parse(anchorAt);
  if (Number.isNaN(anchor)) {
    throw new OpenConError({
      code: "DISPUTE_VALIDATION",
      classification: "validation",
      message: `window anchor must be a valid ISO-8601 timestamp (got ${String(anchorAt)})`,
      context: { anchorAt },
    });
  }
  return new Date(anchor + windowMs).toISOString();
}

/** The challenge-window expiry for a subject anchored at `anchorAt`. */
export function challengeWindowExpiry(anchorAt: string): string {
  return addWindowMs(anchorAt, DISPUTE_CHALLENGE_WINDOW_MS);
}

/** The appeal-window expiry for a resolution recorded at `resolvedAt`. */
export function appealWindowExpiry(resolvedAt: string): string {
  return addWindowMs(resolvedAt, DISPUTE_APPEAL_WINDOW_MS);
}

/**
 * The deterministic in-window check (pure): `at` must fall in
 * [anchorAt, anchorAt + windowMs] (inclusive bounds — the same
 * inclusive-bounds convention as the NET-W009 velocity detector).
 */
export function isWithinWindow(
  at: string,
  anchorAt: string,
  windowMs: number,
): boolean {
  const t = Date.parse(at);
  const anchor = Date.parse(anchorAt);
  return t >= anchor && t <= anchor + windowMs;
}
