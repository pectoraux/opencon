# NET-W004 — Canonical Transition Matrix

**Work order:** spec/work-orders/NET-W004.md §3.3, §8
**Architecture:** v1.0 (FROZEN) §17 (canonical lifecycle), architecture-lock §7 (workflow authority), §11 (workflow invariants)
**Status:** READY_FOR_IMPLEMENTATION → implemented in NET-W004

This document is the exhaustive legal-transition matrix for the
Opportunity/Contribution lifecycle. It is the canonical artifact
referenced by `tests/workflows/net-w004-ac-03-transition-matrix.test.ts`
(AC-03). The implementation lives in
`src/workflows/transition-table.ts` (data) and
`src/workflows/state-machine.ts` (pure evaluator). The workflow service
in `src/workflows/workflow-service.ts` is the SOLE entry point that
mutates lifecycle state (work order §4.1).

## 1. Canonical lifecycle

```text
DRAFT → READY → ASSIGNED → IN_PROGRESS → SUBMITTED → MEASURING
→ EVALUATING → CHALLENGE_WINDOW → SETTLING → SETTLED → VERIFIED
```

`VERIFIED` is the canonical terminal state.

## 2. Exceptional states

```text
BLOCKED
FRAUD_REVIEW
DISPUTED
REJECTED       (terminal)
CANCELLED      (terminal)
```

## 3. Terminal states

A subject in a terminal state admits no further transitions. The
transition table contains NO rule whose `from` is a terminal state:

- `VERIFIED` (canonical terminal)
- `REJECTED` (exceptional terminal)
- `CANCELLED` (exceptional terminal)

The state machine rejects any transition out of a terminal state with
`TerminalStateError` (stable error code `TERMINAL_STATE`,
classification `validation`, never retryable).

## 4. Transition rules — Opportunity

Every rule below is enumerated in `OPPORTUNITY_TRANSITION_TABLE`
(`src/workflows/transition-table.ts`). The workflow service's
`evaluateTransition` pure function looks up the rule for a given
(from, to) pair; if none exists, it rejects with `IllegalTransitionError`
(stable error code `ILLEGAL_TRANSITION`, classification `validation`,
never retryable).

### 4.1 Canonical forward path

| from              | to                | policyAction                              | auditEventName                                       |
|-------------------|-------------------|-------------------------------------------|------------------------------------------------------|
| DRAFT             | READY             | opportunity.transition.draft_to_ready     | opportunity.transition.draft_to_ready                |
| READY             | ASSIGNED          | opportunity.transition.ready_to_assigned  | opportunity.transition.ready_to_assigned             |
| ASSIGNED          | IN_PROGRESS       | opportunity.transition.assigned_to_in_progress | opportunity.transition.assigned_to_in_progress |
| IN_PROGRESS       | SUBMITTED         | opportunity.transition.in_progress_to_submitted | opportunity.transition.in_progress_to_submitted |
| SUBMITTED         | MEASURING         | opportunity.transition.submitted_to_measuring | opportunity.transition.submitted_to_measuring   |
| MEASURING         | EVALUATING        | opportunity.transition.measuring_to_evaluating | opportunity.transition.measuring_to_evaluating  |
| EVALUATING        | CHALLENGE_WINDOW  | opportunity.transition.evaluating_to_challenge_window | opportunity.transition.evaluating_to_challenge_window |
| CHALLENGE_WINDOW  | SETTLING          | opportunity.transition.challenge_window_to_settling | opportunity.transition.challenge_window_to_settling |
| SETTLING          | SETTLED           | opportunity.transition.settling_to_settled | opportunity.transition.settling_to_settled       |
| SETTLED           | VERIFIED          | opportunity.transition.settled_to_verified | opportunity.transition.settled_to_verified       |

### 4.2 Exceptional-state entries (BLOCKED)

Any non-terminal canonical state can transition to `BLOCKED`:

| from              | to        | policyAction                              | auditEventName                             |
|-------------------|-----------|-------------------------------------------|--------------------------------------------|
| DRAFT             | BLOCKED   | opportunity.transition.draft_to_blocked   | opportunity.transition.draft_to_blocked    |
| READY             | BLOCKED   | opportunity.transition.ready_to_blocked   | opportunity.transition.ready_to_blocked    |
| ASSIGNED          | BLOCKED   | opportunity.transition.assigned_to_blocked | opportunity.transition.assigned_to_blocked |
| IN_PROGRESS       | BLOCKED   | opportunity.transition.in_progress_to_blocked | opportunity.transition.in_progress_to_blocked |
| SUBMITTED         | BLOCKED   | opportunity.transition.submitted_to_blocked | opportunity.transition.submitted_to_blocked |
| MEASURING         | BLOCKED   | opportunity.transition.measuring_to_blocked | opportunity.transition.measuring_to_blocked |
| EVALUATING        | BLOCKED   | opportunity.transition.evaluating_to_blocked | opportunity.transition.evaluating_to_blocked |
| CHALLENGE_WINDOW  | BLOCKED   | opportunity.transition.challenge_window_to_blocked | opportunity.transition.challenge_window_to_blocked |
| SETTLING          | BLOCKED   | opportunity.transition.settling_to_blocked | opportunity.transition.settling_to_blocked |

### 4.3 BLOCKED recovery

A blocked subject can return to a canonical state:

| from    | to          | policyAction                          | auditEventName                         |
|---------|-------------|---------------------------------------|----------------------------------------|
| BLOCKED | DRAFT       | opportunity.transition.blocked_to_draft | opportunity.transition.blocked_to_draft |
| BLOCKED | READY       | opportunity.transition.blocked_to_ready | opportunity.transition.blocked_to_ready |
| BLOCKED | IN_PROGRESS | opportunity.transition.blocked_to_in_progress | opportunity.transition.blocked_to_in_progress |

### 4.4 FRAUD_REVIEW

| from              | to            | policyAction                              | auditEventName                             |
|-------------------|---------------|-------------------------------------------|--------------------------------------------|
| SUBMITTED         | FRAUD_REVIEW  | opportunity.transition.submitted_to_fraud_review | opportunity.transition.submitted_to_fraud_review |
| MEASURING         | FRAUD_REVIEW  | opportunity.transition.measuring_to_fraud_review | opportunity.transition.measuring_to_fraud_review |
| EVALUATING        | FRAUD_REVIEW  | opportunity.transition.evaluating_to_fraud_review | opportunity.transition.evaluating_to_fraud_review |
| CHALLENGE_WINDOW  | FRAUD_REVIEW  | opportunity.transition.challenge_window_to_fraud_review | opportunity.transition.challenge_window_to_fraud_review |
| SETTLING          | FRAUD_REVIEW  | opportunity.transition.settling_to_fraud_review | opportunity.transition.settling_to_fraud_review |
| FRAUD_REVIEW      | DISPUTED      | opportunity.transition.fraud_review_to_disputed | opportunity.transition.fraud_review_to_disputed |
| FRAUD_REVIEW      | SUBMITTED     | opportunity.transition.fraud_review_to_submitted | opportunity.transition.fraud_review_to_submitted |

### 4.5 DISPUTED

| from        | to               | policyAction                              | auditEventName                             |
|-------------|------------------|-------------------------------------------|--------------------------------------------|
| DISPUTED    | REJECTED         | opportunity.transition.disputed_to_rejected | opportunity.transition.disputed_to_rejected |
| DISPUTED    | CHALLENGE_WINDOW | opportunity.transition.disputed_to_challenge_window | opportunity.transition.disputed_to_challenge_window |

### 4.6 CANCELLED

| from              | to        | policyAction                              | auditEventName                             |
|-------------------|-----------|-------------------------------------------|--------------------------------------------|
| DRAFT             | CANCELLED | opportunity.transition.draft_to_cancelled | opportunity.transition.draft_to_cancelled |
| READY             | CANCELLED | opportunity.transition.ready_to_cancelled | opportunity.transition.ready_to_cancelled |
| ASSIGNED          | CANCELLED | opportunity.transition.assigned_to_cancelled | opportunity.transition.assigned_to_cancelled |
| IN_PROGRESS       | CANCELLED | opportunity.transition.in_progress_to_cancelled | opportunity.transition.in_progress_to_cancelled |
| SUBMITTED         | CANCELLED | opportunity.transition.submitted_to_cancelled | opportunity.transition.submitted_to_cancelled |
| MEASURING         | CANCELLED | opportunity.transition.measuring_to_cancelled | opportunity.transition.measuring_to_cancelled |
| EVALUATING        | CANCELLED | opportunity.transition.evaluating_to_cancelled | opportunity.transition.evaluating_to_cancelled |
| CHALLENGE_WINDOW  | CANCELLED | opportunity.transition.challenge_window_to_cancelled | opportunity.transition.challenge_window_to_cancelled |

## 5. Transition rules — Contribution

The contribution transition table (`CONTRIBUTION_TRANSITION_TABLE`)
mirrors the opportunity table. Every rule above for "opportunity" has
a corresponding rule for "contribution" with the policyAction and
auditEventName prefixed `contribution.transition.*` instead of
`opportunity.transition.*`. The lifecycle states, exceptional states,
terminal states, and recovery rules are identical.

## 6. Idempotency semantics

Every transition rule is idempotent: repeating the same authorized
transition with the same idempotency key is a deterministic replay
(work order §4.4). The workflow service's `requestTransition` returns
`executed: true` for the first call and `executed: false` for replays,
with the SAME `transitionId` + `recordId` so the caller can dedupe.

## 7. Optimistic concurrency requirement

Every transition requires the caller to pass `expectedVersion`
matching the authoritative subject's current version. A stale writer
is rejected with `ConcurrentTransitionError` (stable error code
`CONCURRENT_TRANSITION`, classification `conflict`, never retryable as-
is — the caller MUST re-read the subject and retry with the current
version). The version increments by 1 on every successful transition
(work order §4.8).

## 8. Audit event names

Every transition emits an audit record whose `eventType` is the rule's
`auditEventName` (e.g. `opportunity.transition.draft_to_ready`). The
audit record carries:

- `actor`: the server-resolved authenticated principal's person id.
- `subject`: the subject id.
- `resourceType`: `opportunity` or `contribution`.
- `resourceId`: the subject id.
- `correlationId` / `executionId`: carried from the request's
  ExecutionContext.
- `metadata.fromState` / `metadata.toState`: the transition.
- `metadata.fromVersion` / `metadata.toVersion`: the version change.
- `metadata.policyAction`: the authorization action evaluated.
- `metadata.idempotencyKey` / `metadata.idempotencyRecordId`: for
  cross-reference with the idempotency store.
- `metadata.transitionId`: stable transition id (deterministic on replay).
- `metadata.organizationScopeId`: the tenant/participant scope.
- `metadata.transactionId`: the AUTHORITATIVE `AuthorityTransaction`
  id that committed the mutation + idempotency record (stamped by the
  transactional audit buffer; NOT the execution id).

The audit record is atomic with the lifecycle mutation (work order
§4.7) under the transaction-ordering contract (NET-W004-AC-07
remediation v2): the transition appends the record to a transactional
audit buffer BOUND to the same authoritative transaction as the
mutation + the idempotency record. The buffer has no publish method of
its own — publication is registered on the transaction's `afterCommit`
hook and runs STRICTLY AFTER the durable commit succeeds; the
`afterRollback` hook discards the buffer when the transaction settles
without committing (explicit rollback OR failed commit):

```
tx.commit() succeeds → afterCommit → audit published (visible)
tx.commit() fails    → afterRollback → audit discarded (invisible)
tx.rollback()        → afterRollback → audit discarded (invisible)
```

A publication failure after a successful durable commit is retried;
on exhaustion the unpublished event is RETAINED (it belongs to a
COMMITTED transaction) for the explicit `retryPendingPublications()`
recovery path — so recovery can never create "audit exists, mutation
doesn't".

## 9. Out of scope (work order §5)

This matrix declares states + transitions only. It does NOT introduce:

- evidence evaluation or Proof-of-Value
- outcome/measurement semantics
- reputation calculation
- Participation Credits or cash settlement
- campaign behavior
- helpfulness scoring
- creator matching/UGC
- advertising inventory
- fraud scoring or challenge economics
- demand pools/procurement/benefit pools
- blockchain consensus or decentralized validation

Transitions that require later domains (for example `EVALUATING` →
`CHALLENGE_WINDOW` requires evidence evaluation) are represented as
states + preconditions only. The `requiresEvidenceReference` flag on
the relevant rule is a placeholder; NET-W004 does NOT enforce it.
Later work items (NET-W005..014) attach the downstream semantics.
