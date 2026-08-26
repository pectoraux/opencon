# NET-W005 — Proof-of-Value Transition Matrix

**Work item:** NET-W005 — Evidence and Proof-of-Value foundation
**Work order:** spec/work-orders/NET-W005.md §3.8
**Architecture:** v1.0 (FROZEN) — architecture §17 (authoritative workflow), architecture-lock §7 (workflow authority), §4 (evidence authority), §11 (workflow invariants)
**Lifecycle authority:** `/workflows` (the transition table lives in `src/workflows/transition-table.ts` — `PROOF_OF_VALUE_TRANSITION_TABLE`)

The Proof-of-Value (PoV) is an evidence-backed claim object owned by
`/evidence`. Its lifecycle state is mutated ONLY by the `/workflows`
boundary (the same deterministic, idempotent, authorized, audited
machinery as opportunities/contributions — architecture-lock §7). The
evidence domain service validates business preconditions and REQUESTS
transitions; it never mutates lifecycle state directly.

## 1. Lifecycle states

The PoV reuses the canonical lifecycle state vocabulary
(`src/core/workflow.ts`) with its intended semantics:

| state       | meaning                                                              |
|-------------|----------------------------------------------------------------------|
| `DRAFT`     | PoV created, referencing a subject + outcome claims                 |
| `MEASURING` | evidence gathering open (evidence + attestations being attached)    |
| `EVALUATING`| evidence set frozen; aggregation + attestations recorded             |
| `VERIFIED`  | terminal: the complete, verified PoV (NET-W008 credit issuance references it — architecture-lock §20) |
| `REJECTED`  | terminal: deterministic evaluation rules failed                       |
| `CANCELLED` | terminal: owner withdrew                                              |

`VERIFIED`, `REJECTED`, and `CANCELLED` are terminal — no legal
outgoing transition.

## 2. Legal transition matrix (exhaustive)

| from        | to          | policyAction                                        | auditEventName                                      | precondition |
|-------------|-------------|-----------------------------------------------------|------------------------------------------------------|--------------|
| `DRAFT`     | `MEASURING` | `proof_of_value.transition.draft_to_measuring`      | `proof_of_value.transition.draft_to_measuring`       | — |
| `MEASURING` | `EVALUATING`| `proof_of_value.transition.measuring_to_evaluating` | `proof_of_value.transition.measuring_to_evaluating`  | ≥1 attached evidence (domain-validated) |
| `EVALUATING`| `VERIFIED`  | `proof_of_value.transition.evaluating_to_verified`  | `proof_of_value.transition.evaluating_to_verified`   | recorded aggregation + ≥1 MEASURED/ATTESTED evidence + ≥1 attestation (domain-validated) |
| `MEASURING` | `REJECTED`  | `proof_of_value.transition.measuring_to_rejected`   | `proof_of_value.transition.measuring_to_rejected`    | — |
| `EVALUATING`| `REJECTED`  | `proof_of_value.transition.evaluating_to_rejected`  | `proof_of_value.transition.evaluating_to_rejected`   | — |
| `DRAFT`     | `CANCELLED` | `proof_of_value.transition.draft_to_cancelled`      | `proof_of_value.transition.draft_to_cancelled`       | — |
| `MEASURING` | `CANCELLED` | `proof_of_value.transition.measuring_to_cancelled`  | `proof_of_value.transition.measuring_to_cancelled`   | — |
| `EVALUATING`| `CANCELLED` | `proof_of_value.transition.evaluating_to_cancelled` | `proof_of_value.transition.evaluating_to_cancelled`  | — |

Every (from, to) pair NOT in this table is rejected with a stable
error code: `ILLEGAL_TRANSITION` (`TERMINAL_STATE` when the source is
terminal). The table is exhaustive — there are no hidden transitions.

Intentional absences:

- `DRAFT → REJECTED` is illegal: rejection is an EVALUATION outcome —
  the PoV must at least have entered evidence gathering.
- No `BLOCKED` / `FRAUD_REVIEW` / `DISPUTED` for the PoV: fraud and
  dispute semantics are NET-W009..010 (work order §5 non-goals).
- No transitions out of `VERIFIED` / `REJECTED` / `CANCELLED`.

## 3. Idempotency + concurrency semantics

Every transition request carries:

- an `idempotencyKey` — repeating the same transition with the same key
  is a deterministic replay (exactly one mutation + one audit record;
  `executed: false` on replay);
- an `expectedVersion` — a stale writer is rejected with
  `CONCURRENT_TRANSITION` (optimistic concurrency; the PoV's `version`
  is the LIFECYCLE version, incremented only by workflow transitions);
- the server-resolved `actorPersonId` — the workflow authorizer checks
  the PoV's `organizationScopeId` against the actor's policies
  (deny-by-default; cross-org transitions are denied).

## 4. Domain preconditions (validated by /evidence, enforced before the transition request)

| transition            | precondition                                                                                     |
|-----------------------|--------------------------------------------------------------------------------------------------|
| `MEASURING → EVALUATING` | at least one attached evidence record                                                          |
| `EVALUATING → VERIFIED`  | a recorded aggregation (aggregateEvidence ran) + at least one MEASURED or ATTESTED evidence record (never model-assessed or self-reported alone — architecture-lock §4) + at least one attached attestation |

Domain mutations (not lifecycle transitions): `attachEvidence` is legal
in DRAFT/MEASURING (the evidence set freezes at EVALUATING);
`attachAttestation` in MEASURING/EVALUATING; `aggregateEvidence` only
in EVALUATING (deterministic; re-running recomputes the same result).

## 5. Audit lineage

Every transition emits an audit record whose `eventType` is the rule's
`auditEventName`, committed atomically with the lifecycle mutation +
the idempotency record in one authoritative transaction, and published
strictly after the durable commit (the NET-W004-AC-07
transaction-ordering contract). The record carries actor/subject/
resource lineage, `fromState`/`toState`/`fromVersion`/`toVersion`, the
`idempotencyKey` + real `idempotencyRecordId`, `transitionId`, and the
AUTHORITATIVE `transactionId` (not the execution id).

## 6. Out of scope (work order §5)

This matrix introduces NO economic value: the PoV carries evidence
lineage (outcome claims, evidence set, aggregation, attestations)
only. Participation Credits, settlement, reputation, fraud/challenge
economics, and campaign behavior attach in later work items
(NET-W006..014). `VERIFIED` is the terminal confirmation state —
NET-W008's credit issuance will require a VERIFIED PoV reference
(architecture-lock §20).
