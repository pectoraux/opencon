/**
 * Workflow lifecycle contract — shared vocabulary for authoritative
 * lifecycle transitions.
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.3 Workflow authority: the canonical contribution lifecycle.
 *   §4 Required invariants: only `/workflows` may authoritatively
 *      transition Opportunity/Contribution lifecycle state.
 *   §8 Workflow state machine requirements: explicit transition table.
 *
 * Architecture ref: spec/architecture.md §17 (canonical lifecycle),
 * spec/architecture-lock.md §7 (workflow authority), §11 (workflow
 * invariants: deterministic/idempotent transitions; stable error codes
 * for illegal transitions).
 *
 * This file lives in `src/core/` so it can be imported by EVERY domain
 * tier that owns a lifecycle subject (opportunities, contributions, and
 * later domains) without violating the tier allow matrix (domain→core is
 * permitted; domain→other-domain is not). The transition *table* itself
 * lives in `src/workflows/` — the SOLE lifecycle authority (work order
 * §4.1) — so the rules are owned by the workflows boundary, not by each
 * domain. Domains import only the type vocabulary from here.
 *
 * No economically material behaviour (settlement, reputation, credit
 * issuance, fraud decisions, evidence evaluation, Proof-of-Value) is
 * introduced by this file. The lifecycle states are pure state names;
 * the transition table is pure routing. Downstream semantics attach in
 * later work items (NET-W005..014),”work order §5 explicit non-goals.
 */

import { OpenConError } from "./errors.ts";

/**
 * The canonical contribution lifecycle states (NET-W004 §3.3, architecture §17).
 * A subject traverses these in declared order; every legal transition is
 * enumerated in the transition table owned by the workflows boundary.
 */
export const CANONICAL_LIFECYCLE_STATES = [
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
] as const;

/**
 * Exceptional lifecycle states (NET-W004 §3.3). A subject MAY transition
 * into an exceptional state from a canonical state under the rules
 * enumerated by the transition table. `REJECTED`, `CANCELLED`, and
 * `VERIFIED` are terminal — once reached, no further transition is legal.
 */
export const EXCEPTIONAL_LIFECYCLE_STATES = [
  "BLOCKED",
  "FRAUD_REVIEW",
  "DISPUTED",
  "REJECTED",
  "CANCELLED",
] as const;

export type CanonicalLifecycleState = (typeof CANONICAL_LIFECYCLE_STATES)[number];

export type ExceptionalLifecycleState = (typeof EXCEPTIONAL_LIFECYCLE_STATES)[number];

/**
 * The full lifecycle state union (canonical + exceptional).
 * Domain modules consume this type to declare their subject's `state` field.
 */
export type LifecycleState = CanonicalLifecycleState | ExceptionalLifecycleState;

/**
 * Terminal states — once reached, no further transition is legal. The
 * transition table MUST NOT define any transition whose source is a
 * terminal state. `VERIFIED` is the canonical terminal state;
 * `REJECTED` and `CANCELLED` are the exceptional terminal states.
 */
export const TERMINAL_LIFECYCLE_STATES: readonly LifecycleState[] = [
  "VERIFIED",
  "REJECTED",
  "CANCELLED",
];

export function isTerminalState(state: LifecycleState): boolean {
  return TERMINAL_LIFECYCLE_STATES.includes(state);
}

/**
 * Build the policy-action string for a (subjectKind, from, to) triple
 * (e.g. "opportunity.transition.draft_to_ready",
 * "proof_of_value.transition.measuring_to_evaluating"). Centralized in
 * CORE (pure string vocabulary over the lifecycle types) so the
 * transition table (workflows domain — the SOLE lifecycle authority)
 * and domain services that REQUEST transitions (e.g. the evidence
 * domain's Proof-of-Value service, NET-W005) derive IDENTICAL policy
 * actions without a domain→domain import. The authorization policies
 * seeded for a subject kind stay aligned with the transition table by
 * construction.
 */
export function policyActionFor(
  subjectKind: LifecycleSubjectKind,
  from: LifecycleState,
  to: LifecycleState,
): string {
  return `${subjectKind}.transition.${from.toLowerCase()}_to_${to.toLowerCase()}`;
}

/**
 * Build the audit event name for a (subjectKind, from, to) triple —
 * identical shape to the policy action (see {@link policyActionFor}).
 */
export function auditEventFor(
  subjectKind: LifecycleSubjectKind,
  from: LifecycleState,
  to: LifecycleState,
): string {
  return `${subjectKind}.transition.${from.toLowerCase()}_to_${to.toLowerCase()}`;
}

/**
 * The kind of lifecycle subject. NET-W004 introduced two first-class
 * subjects: opportunities and contributions. NET-W005 added the
 * Proof-of-Value (the evidence-backed claim object whose lifecycle is
 * DRAFT → MEASURING → EVALUATING → VERIFIED with REJECTED/CANCELLED
 * exceptional states — see spec/work-orders/NET-W005.md §3.8).
 * NET-W006 adds the measured outcome (the outcome-measurement
 * aggregate whose maturation lifecycle is DRAFT → MEASURING →
 * VERIFIED with CANCELLED exceptional states — see
 * spec/work-orders/NET-W006.md §3.5; finalization is explicit and
 * auditable, delayed outcomes cannot silently become final).
 * Later work items (campaigns, disputes, etc.) may add more. The
 * transition table is parameterized by subject kind so each subject
 * can have its own legal-transition set.
 */
export type LifecycleSubjectKind =
  | "opportunity"
  | "contribution"
  | "proof_of_value"
  | "outcome_measurement";

/**
 * The minimal shape of an authoritative lifecycle subject. Domain
 * entities (Opportunity, Contribution) satisfy this contract so the
 * workflows boundary can manipulate their lifecycle state uniformly
 * without coupling to their domain-specific fields.
 *
 * Fields:
 *  - `id`: stable opaque identifier.
 *  - `kind`: discriminator so the workflow service can route to the
 *    correct lifecycle repository.
 *  - `state`: current lifecycle state (canonical or exceptional).
 *  - `version`: monotonic revision counter; the workflow service uses
 *    optimistic concurrency — a transition carrying a stale `version`
 *    is rejected as `ConcurrentTransitionError` (work order §4.8).
 *  - `organizationScopeId`: tenant/participant scope; the workflow
 *    service rejects cross-organization transitions (work order §4.5).
 *  - `ownerId`: canonical identity id that owns the subject (provenance
 *    for ownership checks; the workflow service uses this for
 *    server-side authorization).
 *  - `executionId` / `correlationId` / `causationId`: stable lineage
 *    identifiers carried forward so audit records can be traced back to
 *    the execution that produced the mutation (work order §4.7).
 *  - `createdAt` / `updatedAt`: ISO-8601 timestamps.
 */
export interface LifecycleSubject {
  readonly id: string;
  readonly kind: LifecycleSubjectKind;
  readonly state: LifecycleState;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A request to authoritatively transition a lifecycle subject. The
 * workflow service receives this and evaluates it against the
 * transition table.
 *
 * - `subjectId` / `subjectKind`: identifies the subject.
 * - `targetState`: the requested target state.
 * - `expectedVersion`: the caller's view of the current subject version.
 *   If the authoritative version differs, the transition is rejected as
 *   a concurrent transition (optimistic concurrency, work order §4.8).
 * - `idempotencyKey`: stable key for exactly-once delivery. Repeating
 *   the same transition with the same key is a deterministic replay —
 *   no duplicate mutation/audit record is created (work order §4.4).
 * - `actorPersonId`: the canonical identity id of the caller (server-
 *   resolved; never client-asserted). Used for authorization + audit.
 * - `policyAction`: the authorization action to evaluate (e.g.
 *   "opportunity.transition.draft_to_ready"). The workflow service
 *   delegates to the AuthorizationService.
 * - `metadata`: free-form caller metadata (e.g. reason, evidence
 *   reference placeholders). Carried into the audit record.
 */
export interface TransitionRequest {
  readonly subjectId: string;
  readonly subjectKind: LifecycleSubjectKind;
  readonly targetState: LifecycleState;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actorPersonId: string;
  readonly policyAction: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The result of an authorized lifecycle transition. Carries stable
 * identifiers + lineage so the caller can trace the mutation back to
 * its authoritative transaction (work order §4.7).
 *
 * - `subject`: the post-transition subject (new state, incremented version).
 * - `executed`: false when this call was a deterministic replay of an
 *   earlier transition with the same idempotency key; true when this
 *   call actually performed the mutation.
 * - `transitionId`: stable id for the transition (audit lineage).
 * - `recordId`: the idempotency record id (for audit cross-reference).
 * - `auditEventName`: the audit event type emitted atomically with the
 *   mutation (e.g. "opportunity.transition.draft_to_ready").
 * - `executionId` / `correlationId` / `causationId`: lineage propagated
 *   from the request's ExecutionContext.
 * - `transactionId`: the authoritative transaction id under which the
 *   mutation + the audit record were committed atomically.
 */
export interface TransitionResult {
  readonly subject: LifecycleSubject;
  readonly executed: boolean;
  readonly transitionId: string;
  readonly recordId: string;
  readonly auditEventName: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly transactionId: string;
}

/**
 * Raised when a transition request specifies a (source, target) pair
 * that is not enumerated in the transition table (work order §4.3,
 * §3.3: "The work item must define the legal transition matrix explicitly
 * and reject every unspecified transition").
 *
 * Classification: `validation` — never retryable. Stable error code
 * `ILLEGAL_TRANSITION` so callers can route deterministically without
 * parsing strings (architecture-lock §11).
 */
export class IllegalTransitionError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "ILLEGAL_TRANSITION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised when a transition request carries a stale `expectedVersion`
 * that does not match the authoritative subject's current version
 * (work order §4.8: optimistic concurrency so stale writers cannot
 * overwrite newer state).
 *
 * Classification: `conflict` — never retryable as-is. The caller MUST
 * re-read the subject and retry with the current version. Stable error
 * code `CONCURRENT_TRANSITION` (architecture-lock §11).
 */
export class ConcurrentTransitionError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "CONCURRENT_TRANSITION",
      classification: "conflict",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised when a transition request is made for a subject that does not
 * exist (e.g. unknown opportunity id).
 *
 * Classification: `not_found` — never retryable.
 */
export class LifecycleSubjectNotFoundError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "LIFECYCLE_SUBJECT_NOT_FOUND",
      classification: "not_found",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised when a transition is requested for a subject that is already in
 * a terminal state (work order §3.3: terminal states admit no further
 * transitions).
 *
 * Classification: `validation` — never retryable.
 */
export class TerminalStateError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "TERMINAL_STATE",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}
