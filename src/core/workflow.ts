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
 * SANCTIONED TRANSITION VOCABULARY (the PR #36 remediation — architect
 * CHANGES REQUESTED on NET-W018).
 *
 * A few lifecycle edges are not ordinary caller-requestable workflow
 * transitions: they ARE domain gates whose preconditions can only be
 * derived by a specific composite inside its authoritative
 * transaction. The first (and so far only) such edge is the
 * publication `DRAFT → VERIFIED` transition — THE DISCLOSURE GATE of
 * NET-W018 §3.4. The verification is only sound after the creators
 * domain's publication-verification composite derives the applicable
 * disclosure obligations from DURABLE RECORDS (campaign policy ∪
 * commercial-relationship obligations) and proves each satisfied by
 * an evidence-bound declaration FOR THIS PUBLICATION.
 *
 * Structural consequence (the remediation decision of record): the
 * sanctioned edges live in a SEPARATE sanctioned transition table —
 * they are absent from the generic tables, so `findRule` (the ONLY
 * resolver the generic `WorkflowService.requestTransition` path and
 * the `/api/workflows/transitions` endpoint use) structurally CANNOT
 * resolve them. The ONLY way to execute a sanctioned edge is the
 * in-transaction composition twin
 * (`WorkflowService.requestTransitionWithinTx`) invoked WITH the
 * matching sanction constant by the owning composite. A caller —
 * however authorized — cannot request the edge, because no code path
 * from the public transition surface passes a sanction.
 *
 * The vocabulary lives in CORE (like `policyActionFor`) so the
 * workflow authority (transition table + state machine), the owning
 * domain composite (creators), and tests share ONE frozen constant
 * without a domain→domain import.
 */
export const PUBLICATION_VERIFICATION_SANCTION =
  "creators.publication-verification";

/**
 * The exhaustive set of transition sanctions (frozen — additions are
 * deliberate architecture decisions, never incidental). Each entry
 * names the single composite sanctioned to execute its edge.
 */
export const WORKFLOW_TRANSITION_SANCTIONS = [
  PUBLICATION_VERIFICATION_SANCTION,
] as const;

/** A transition sanction (see {@link WORKFLOW_TRANSITION_SANCTIONS}). */
export type WorkflowTransitionSanction =
  (typeof WORKFLOW_TRANSITION_SANCTIONS)[number];

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
 * NET-W017 adds the creator ENGAGEMENT (the workflow-mediated
 * creator↔campaign engagement whose production lifecycle is
 * DRAFT → READY → ASSIGNED → IN_PROGRESS → SUBMITTED → VERIFIED with
 * REJECTED/CANCELLED exceptional states — see
 * spec/work-orders/NET-W017.md §3.1; acceptance/production execute
 * through the SAME workflow machinery, never a second lifecycle
 * authority).
 * NET-W018 adds the creator PUBLICATION (the workflow-mediated
 * publication record whose lifecycle is DRAFT → VERIFIED with a
 * CANCELLED exceptional state — see spec/work-orders/NET-W018.md §3.4).
 * The publication REUSES the canonical state vocabulary (the W005/W006
 * precedent: the state universe stays small, the workflow machinery is
 * untouched): VERIFIED here means the publication record is VERIFIED —
 * the applicable disclosure obligations are satisfied and the
 * publication carries canonical, subject-bound evidence. The boundary
 * itself never performs the external publication act (no silent
 * publication authority — CRE-004/HELP-005) and the DRAFT → VERIFIED
 * transition is the disclosure gate: it is a SANCTIONED edge
 * (`PUBLICATION_VERIFICATION_SANCTION`) resolvable ONLY through the
 * in-transaction composition twin invoked by the creators domain's
 * verification composite — NEVER through the generic transition path
 * (the PR #36 remediation decision of record).
 * Later work items (campaigns, disputes, etc.) may add more. The
 * transition table is parameterized by subject kind so each subject
 * can have its own legal-transition set.
 */
export type LifecycleSubjectKind =
  | "opportunity"
  | "contribution"
  | "proof_of_value"
  | "outcome_measurement"
  | "engagement"
  | "publication";

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
