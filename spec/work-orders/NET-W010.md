# Work Order — NET-W010: Stake, challenges, disputes and appeals

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md`)
**Requirements:** DISPUTE-001..005, GOV-002..003, AUD-006 (dispute audit lineage)
**Acceptance criteria:** NET-W010-AC-01..08
**Dependencies:** NET-W002, NET-W003, NET-W004, NET-W005, NET-W006, NET-W007, NET-W008, NET-W009 (all merged)
**Canonical issue:** #19

## 1. Objective

Implement the provider-neutral disputes/challenges/appeals foundation
in the existing `/disputes` trust boundary. NET-W010 extends the
NET-W009 risk/case foundation with participant-initiated challenges,
formal disputes, stake/commitment semantics, reviewer/appeal
workflows, deadlines, resolution evidence, and deterministic
disposition of challenged decisions.

The separation of authorities is the work item's strongest constraint:

```text
/disputes   → owns challenge/review decisions
/workflows  → still owns lifecycle mutation
/settlement → still owns economic accounting
/evidence   → remains truth authority
/reputation → remains trust-signal authority
```

## 2. Design constraints (from Issue #19, binding)

```text
Prior decision / risk case / authoritative record
                      ↓
                Challenge request
                      ↓
              Eligibility gate
                      ↓
                Stake (explicit)
                      ↓
                OPEN / REVIEW
                      ↓
                 APPEAL (0..n)
                      ↓
                   RESOLVED
                  ↙        ↘
             control      economic
             decision      consequence
                ↓             ↓
            /workflows    /settlement
```

The dispute domain may issue provider-neutral control decisions and
settlement commands through injected interfaces, but it must never
call downstream mutation services as a hidden back door. The
composition root remains responsible for wiring the integration.

## 3. Scope

### 3.1 Core dispute vocabulary (`src/core/disputes.ts`)

- `DisputeKind` (`CHALLENGE` / `APPEAL`), `DisputeState`
  (`PENDING_STAKE` / `OPEN` / `UNDER_REVIEW` / `APPEALED` /
  `RESOLVED` / `REJECTED` / `WITHDRAWN`), `ACTIVE_DISPUTE_STATES`
  (the gating states), `LIVE_DISPUTE_STATES` (the duplicate-gate
  states).
- `DisputeOutcome` (`UPHELD` / `DENIED` / `DISMISSED`) and
  `DisputeControlDisposition` (`MAINTAIN_CONTROL` /
  `RELEASE_CONTROL` / `REQUIRE_REEVALUATION`) — the control outcome
  is RECORDED for consumers, never executed against
  `/workflows`/`/evidence` directly.
- `DisputeStakeDisposition` (`NONE` / `RELEASE` / `FORFEIT`) with the
  DETERMINISTIC `stakeDispositionForOutcome` mapping (REJECTED →
  RELEASE; UPHELD/DISMISSED → RELEASE; DENIED → FORFEIT; WITHDRAWN →
  RELEASE).
- `DisputeSubjectType` (contribution / proof_of_value /
  measured_outcome / economic_value / credit_issuance / cash_obligation
  / risk_case / risk_control_decision) — the challengeable
  authoritative records.
- Frozen policy lineage `DISPUTE_POLICY_VERSION = "NET-W010:1"`,
  windows (challenge 14d from the subject's authoritative anchor,
  appeal 7d from resolution) and the default stake requirement
  (10 Participation Credits), all consumed with EXPLICIT timestamps
  (pure window math — no wall clock reads).

### 3.2 Stake escrow — the settlement authority side (`/settlement`)

Additive core economics vocabulary: the `stake_escrow` account kind
(credit-normal, `credits` unit), the `stake_commit` / `stake_release`
/ `stake_forfeit` ledger transaction kinds, the `stake` ledger
subject kind, `EconomicStakeStates` (`COMMITTED` / `RELEASED` /
`FORFEITED`) and the `dispute_challenge` stake purpose.

`StakeService` (`src/settlement/stake-service.ts` +
`authority-stake-repository.ts`, collection `stakes`):

```text
commit:  debit credits(owner)       amount   credit stake_escrow(owner)  amount
release: debit stake_escrow(owner)  amount   credit credits(owner)      amount
forfeit: debit stake_escrow(owner)  amount   credit protocol(credits)   amount
```

Every posting flows through the shared posting layer (per-unit
conservation, per-account non-negative guards, deterministic account
ids, account/purpose/record lock ordering). One COMMITTED stake per
purpose. Terminal outcomes carry append-only lineage (reason +
transaction). Audit events: `stake.committed` / `stake.released` /
`stake.forfeited`.

### 3.3 The dispute aggregate (`/disputes`)

`DisputeRecord` (collection `disputes`): kind, optional
`appealOfDisputeId`, challenger, subject ref + subject snapshot
(anchor + beneficiary for COI), statement, reason codes, supporting
references, state, stake bookkeeping (frozen requirement + settlement
record reference + recorded disposition), windows, reviewer identity,
immutable resolution block, forward appeal pointer, append-only event
history, policy version, execution lineage.

The deterministic state machine:

```text
PENDING_STAKE ──bond_stake──→ OPEN ──start_review──→ UNDER_REVIEW ──resolve──→ RESOLVED ──appeal──→ APPEALED
      │                        │ │                                                                        ↑ terminal
      └── withdraw ────────────┘ └── withdraw ──→ WITHDRAWN
                               └── reject (also from UNDER_REVIEW) ──→ REJECTED
```

- `openDispute` — the eligibility gate: person actor (server-side),
  subject resolves same-scope with an authoritative anchor,
  `effectiveAt` within the challenge window, no other LIVE dispute on
  the subject, reason codes + ≥1 supporting references. Creates
  PENDING_STAKE (the stake is NOT touched).
- `bondStake` — VERIFIES the settlement authority's committed stake
  through the READ-ONLY stake lookup (owner == challenger,
  amount/unit match the frozen requirement, state COMMITTED, purpose
  links THIS dispute, committed within the window) and flips the
  record to OPEN. Never posts.
- `markStakeOutcome` — records the settlement-executed outcome
  (verifying the stake's terminal state through the read-only
  lookup); append-only bookkeeping.
- `startReview` / `rejectDispute` / `resolveDispute` — reviewer
  identity from the execution actor; the conflict-of-interest gate
  bars the challenger and the subject beneficiary on every reviewer
  action; material decisions require ≥1 supporting references;
  resolution records the outcome + control disposition + the
  DETERMINISTIC stake mapping; the appeal window derives from
  resolvedAt.
- `appealDispute` — the ORIGINAL flips to terminal APPEALED
  (append-only event + forward pointer; the resolution block stays
  byte-identical) and a NEW linked APPEAL record opens its own
  PENDING_STAKE cycle. Standing: the original challenger or the
  subject beneficiary; `effectiveAt` within the appeal window.
- `withdrawDispute` — the challenger, before resolution.

Neutral lookups (composition-root wired, read-only):
`DisputeSubjectLookup` (subject existence + anchor + beneficiary over
the owning domains' repositories), `DisputeStakeLookup` (over the
settlement stake repository), plus the shared NET-W009 source
resolution (now including `risk_case` as an authoritative source
kind).

Audit events (AUD-006): `dispute.opened`, `dispute.stake_bonded`,
`dispute.review_started`, `dispute.rejected`, `dispute.resolved`,
`dispute.appealed`, `dispute.withdrawn`,
`dispute.stake_outcome_recorded`.

### 3.4 Composition-root orchestration + the dispute gate

- The composite API commands (`openDispute`, `bondDisputeStake`,
  `startDisputeReview`, `rejectDispute`, `resolveDispute`,
  `appealDispute`, `withdrawDispute`) sequence the dispute decisions
  and the settlement stake commands with COMPOUND idempotency keys
  (`${key}:stake`, `:bond`, `:release`, `:forfeit`, `:record`) — the
  NET-W009 `applyWorkflowHold` precedent. The /disputes domain code
  never calls /settlement.
- `refuseWhenDisputed` (the lock-invariant-21 disputed half): the
  guarded `matureEconomicValue` / `issueCredits` / `allocateRewards`
  commands consult the dispute registry (ACTIVE states: OPEN /
  UNDER_REVIEW / APPEALED) covering the record id OR any of its
  upstream source ids, and refuse with `DISPUTE_CHALLENGE`
  (precondition). PENDING_STAKE disputes never gate (griefing
  resistance — an unbonded request cannot freeze value).

### 3.5 Persistence, idempotency, audit, tenancy

Every material mutation runs through the NET-W004
`IdempotencyStore.applyIdempotent` primitive with namespaced keys
(`dispute_open/bond/review/reject/resolve/appeal/withdraw/
stake_outcome:{org}:{key}`), commits its record + events + audit
lineage in ONE authoritative transaction, and serializes
check-then-act sequences on the store's per-key mutexes:
`dispute_subject:{org}:{type}:{subjectId}` (duplicate gate) and
`dispute_record:{id}` (state machine) — the org-independent-lock
reasoning of the NET-W007 remediation. Post-commit audit publication
failures remain recoverable (the transactional audit buffer).

## 4. Required invariants (from Issue #19, binding)

1. **No hidden economic authority:** stake and any economic
   consequences are executed through the settlement authority;
   disputes cannot mint, destroy, or silently move value.
2. **No direct reputation mutation:** dispute outcomes may be
   consumed later by reputation policy but cannot directly rewrite
   reputation.
3. **No evidence rewriting:** disputes can reference, challenge, or
   request re-evaluation of evidence/measurements, but cannot mutate
   evidence truth records directly.
4. **Determinism:** eligibility, deadlines, state transitions, and
   resolution disposition are reproducible from explicit timestamps,
   policy/version, and stored records.
5. **Authority separation:** disputes control the challenge/review
   decision; `/workflows` remains the lifecycle authority and
   `/settlement` remains the economic authority.
6. **Tenant isolation:** challenges, disputes, stakes, reviewer
   actions, and appeals cannot cross organization scopes.
7. **Auditability and atomicity:** every material dispute mutation
   commits with its idempotency record and audit lineage in one
   authoritative transaction; post-commit publication failures remain
   recoverable.
8. **Append-only resolution:** appeals and corrections create linked
   records; historical decisions remain immutable and reconstructable.

## 5. Explicit non-goals

No replacement of the NET-W009 risk engine, no direct economic ledger
mutations inside /disputes, no reputation scoring changes, no evidence
truth rewriting, no campaign optimization, no creator marketplace
behavior, no procurement/demand pools, no benefit-pool allocation, no
external payments, no blockchain consensus, and no provider-specific
dispute SDK semantics.

## 6. Acceptance criteria mapping

| AC | Statement | Automated evidence |
| -- | --------- | ------------------ |
| AC-01 | First-class durable scoped records with immutable history | `tests/disputes/net-w010-ac-01-records.test.ts` |
| AC-02 | Eligibility + challenge-window rules explicit, deterministic, authorized, idempotent | `tests/disputes/net-w010-ac-02-eligibility.test.ts` |
| AC-03 | Stake semantics through the settlement authority, no hidden balance mutation | `tests/disputes/net-w010-ac-03-stakes.test.ts` |
| AC-04 | Review/appeal/resolution lifecycle deterministic and append-only | `tests/disputes/net-w010-ac-04-lifecycle.test.ts` |
| AC-05 | Reviewer identity, reasons, refs, conflict controls auditable | `tests/disputes/net-w010-ac-05-reviewers.test.ts` |
| AC-06 | Concurrent-safe, PostgreSQL-authoritative, audit-linked atomically | `tests/disputes/net-w010-ac-06-atomicity.test.ts` |
| AC-07 | Resolution/control outputs separate from economic/reputation/evidence authority | `tests/disputes/net-w010-ac-07-authority.test.ts` |
| AC-08 | Architecture/out-of-scope regression (Architecture v1.0 + lock unchanged) | `tests/regression/net-w010-ac-08-architecture-out-of-scope.test.ts` (+ deliberate amendments to the NET-W008 account-kind pin and the NET-W009 dispute denylist, both documenting their NET-W010 extensions) |

## 7. Verification

`bun run verify` = `bun run typecheck && bun run arch:check && bun test`
— all green. The full evidence document is
`docs/net-w010-disputes.md`.
