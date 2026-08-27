# NET-W008 — Participation Credits and economic ledger: evidence document

**Work item:** NET-W008 / Issue #15
**Architecture:** v1.0 (FROZEN) — unchanged; this implementation binds to `spec/architecture.md` + `spec/architecture-lock.md`
**Work order:** `spec/work-orders/NET-W008.md`
**Requirements:** ECON-001..005, SETTLE-001..003, AUD-003
**Domain:** `/settlement` (architecture §18: credits, pending/mature value, cash/credit settlement)

## 1. What was built

A provider-neutral, double-entry **economic ledger** — the protocol's
internal accounting authority for verified value:

```text
Evidence / Measurement / VERIFIED PoV   (NET-W005 / NET-W006)
                 ↓  verified-source input gate
     EconomicValueRecord (PENDING)  + recognition postings
                 ↓  explicit maturation gate (immediate | fixed_window)
     EconomicValueRecord (MATURE)   + maturation postings
           ↙                ↘
CreditIssuance          CashObligation (payable/receivable)
(PoV-gated, explicit    + internal settlement state
 rate, dual-side        ↘
 postings)                Conversion (explicit cash↔credits rate)
           ↘                ↗
        RewardAllocation (deterministic, policy/version-aware)
```

Everything is expressed as **immutable ledger entries**; every balance
is derived from the entry set — never stored as a mutable counter — so
the ledger is reconstructable by construction (AC-01).

### Component map

| Component | File |
|---|---|
| Core vocabulary (units, sources, states, accounts, tx kinds, amount math) | `src/core/economics.ts` |
| Domain contracts | `src/settlement/port.ts` |
| Pure ledger math (per-unit balance validation, non-negative guard, negation, deterministic reward split, global conservation) | `src/settlement/ledger.ts` |
| Posting layer (account provisioning, conservation checks, per-account serialization) | `src/settlement/posting.ts` |
| Value service (input gate / maturation gate / reversal) | `src/settlement/value-service.ts` |
| Credit service (PoV-gated issuance / reversal) | `src/settlement/credit-service.ts` |
| Reward service (versioned policies + deterministic allocation) | `src/settlement/reward-service.ts` |
| Cash service (obligations + internal settlement) | `src/settlement/cash-service.ts` |
| Conversion service (explicit cash↔credits) | `src/settlement/conversion-service.ts` |
| Ledger read service (balances / summaries / lineage) | `src/settlement/ledger-service.ts` |
| Authority repositories (7 collections) | `src/settlement/authority-*.ts` |
| Composition-root wiring + API views/commands | `src/bootstrap/runtime.ts`, `src/api/port.ts`, `src/api/server.ts` |

## 2. The economic invariants (work order §4) and where they are enforced

1. **No unverified issuance** — `value-service.recordPendingValue`
   resolves every source through the neutral lookups and requires a
   qualifying VERIFIED record (VERIFIED PoV / VERIFIED measured
   outcome / platform-attested-provider evidence);
   `credit-service.issueCredits` re-resolves the PoV and requires
   state VERIFIED (architecture-lock invariant 20). Model/self
   evidence never qualifies (§4 of the lock).
2. **Pending ≠ mature** — `EconomicValueState` PENDING/MATURE/
   CONSUMED/REVERSED; issuance and allocation consume MATURE records
   only (lock invariant 19); maturation is an explicit authorized
   audited command; `fixed_window` requires the explicit `effectiveAt`
   ≥ `windowEndAt` (SETTLE-002; no wall clock).
3. **Conservation** — `ledger.validatePostings` (per-unit
   Σdebit === Σcredit on scaled integers) +
   `ledger.assertNonNegativeAfterPostings` (post-balance ≥ 0 on every
   affected account) run inside every mutation transaction; balances
   derive from immutable entries; retries/concurrent same-key calls
   are exactly-once via the NET-W004 `IdempotencyStore` primitive.
4. **No direct purchase of trust/value** — the input contract carries
   no spend/wealth/deposit/activity/reputation field and no such
   source kind exists (`ECONOMIC_VALUE_SOURCES`); the gate is
   structural (same design as NET-W007's REP-002).
5. **Auditability** — 13 audit event types, every one committed
   atomically with its mutation + idempotency record and carrying
   source references, policy/version (rewards), actor, authoritative
   `transactionId`, `idempotencyRecordId`, execution/correlation/
   causation lineage (AUD-003; the ledger transaction `subjectRef`
   makes every movement of an economic record queryable).
6. **Correction by append-only accounting** — every reversal posts
   `ledger.negatePostings(original.entries)` — mechanically exact
   inversions — with balance checks; historical entries are immutable.
7. **Atomicity** — every mutation runs through
   `IdempotencyStore.applyIdempotent` with the transactional audit
   buffer bound to the same authoritative transaction
   (NET-W004-AC-07 semantics; publication failures retain pending
   events for the explicit recovery path and never undo the commit).
8. **External settlement separation** — internal payable/receivable
   state only; the neutral `/payments` port stays skeletal and is NOT
   imported by the domain (lock invariant 25); fraud/hold/dispute
   semantics are NET-W009/010 (the maturation gate is the seam where
   their hold checks attach).

## 3. Design decisions of note

1. **A real double-entry ledger with a protocol contra account.**
   Person-owned accounts (pending/mature value, credits, rewards, cash
   payable/receivable) post against a per-org, per-unit
   `protocol_recognition` system account. Credit issuance and
   conversions are DUAL-SIDE transactions: each unit balances
   independently, so value never silently becomes credits or cash —
   the only value→credits path is an issuance with its rate recorded
   on the first-class issuance record, and the only cash↔credits path
   is an explicit conversion entry with BOTH amounts recorded.
2. **Deterministic account identities.** Account ids are the
   deterministic composite `org|owner|kind|unit`, so provisioning is
   idempotent by construction — a tenant can never hold duplicate
   accounts for one role, and balances/lineage reconstruct from the
   key alone.
3. **Rewards are accounted in the `value` unit.** A reward allocation
   distributes a MATURE record's value among beneficiaries' rewards
   accounts (an entitlement ledger, conserved mechanically:
   Σ shares === source EXACTLY via last-share remainder absorption).
   Converting reward balances to credits/cash is a later explicit
   ledger operation (benefit pools NET-W028 / external settlement
   NET-W030) — no implicit conversion exists.
4. **No workflow lifecycle subject.** Ledger entities are accounting
   records with explicit, authorized, idempotent, audited commands
   (each conservation-checked), not multi-step lifecycle subjects; the
   qualifying VERIFIED state is produced upstream by the PoV lifecycle
   that NET-W005 owns through `/workflows`. This mirrors the NET-W007
   decision (append-only records, no workflow subject) and is asserted
   by the AC-08 regression.
5. **Per-record + per-account serialization (learned from the PR #14
   remediation).** Record state mutations serialize under the
   organization-independent mutex `economic_value_record:{id}` /
   `economic_cash_obligation:{id}` (`IdempotencyStore.withLock`); every
   posting additionally serializes per ACCOUNT — locks acquired in a
   globally sorted order after the optional record lock — because two
   concurrent balance-based debits (e.g. an issuance reversal and a
   conversion against the same credits balance) could otherwise each
   pass an individual balance check while jointly overdrafting. The
   mutex is the documented monolith stand-in for PostgreSQL
   `SELECT … FOR UPDATE` on the account row.
6. **Reward policy lineages reuse the full NET-W007 pattern** —
   monotonic versioning, tuple-idempotent replays, org-independent
   lineage lock (`economic_reward_policy_lineage:{policyId}`) with the
   cross-scope check running against the org-independent lineage read
   on EVERY create (including version 1): a lineage can never fork,
   proven again by a concurrent cross-org regression test.
7. **Allocation version pinning.** `allocateRewards` resolves the
   policy (exact version or latest) BEFORE acquiring the locks and
   pins it; the in-tx load then reads the exact pinned version
   (immutable once committed), so the pre-computed account-lock set
   always covers the beneficiaries actually paid.

## 4. API surface (13 guarded mutations + public reads)

| Route | Guard action |
|---|---|
| `POST /api/settlement/values` | `economicValue.create` |
| `POST /api/settlement/values/:id/mature` | `economicValue.mature` |
| `POST /api/settlement/values/:id/reverse` | `economicValue.reverse` |
| `POST /api/settlement/credit-issuances` | `creditIssuance.create` |
| `POST /api/settlement/credit-issuances/:id/reverse` | `creditIssuance.reverse` |
| `POST /api/settlement/reward-policies` | `rewardPolicy.create` |
| `POST /api/settlement/reward-allocations` | `rewardAllocation.create` |
| `POST /api/settlement/reward-allocations/:id/reverse` | `rewardAllocation.reverse` |
| `POST /api/settlement/cash-obligations` | `cashObligation.create` |
| `POST /api/settlement/cash-obligations/:id/settle` | `cashObligation.settle` |
| `POST /api/settlement/cash-obligations/:id/reverse` | `cashObligation.reverse` |
| `POST /api/settlement/conversions` | `conversion.create` |
| `POST /api/settlement/conversions/:id/reverse` | `conversion.reverse` |

Public reads: value records (by id / by beneficiary with state
filter), credit issuances, reward policies + versions, reward
allocations, cash obligations, conversions, ledger transactions (by id
AND by subject — the AUD-003 lineage query), account balances, and the
per-participant economic summary.

## 5. Acceptance criteria → verification mapping

| AC | Evidence | Tests |
|---|---|---|
| AC-01 first-class, durable, reconstructable records | Stable ids + lineage; balances derived from immutable entries; deterministic accounts; per-subject lineage; durable authority read-back; API exposure | `tests/settlement/net-w008-ac-01-first-class.test.ts` (7) |
| AC-02 pending ≠ mature; maturation explicit/auditable | Pending cannot be consumed; explicit audited maturation; fixed_window gate before/at/after; double-maturation rejected; same-key replay; measured-outcome source | `tests/settlement/net-w008-ac-02-pending-mature.test.ts` (7) |
| AC-03 issuance requires verified value; spend/wealth/activity/reputation cannot mint | No-PoV rejection (invariant 20); DRAFT PoV rejection; model/self evidence rejection; structural source-kind gate; reputation-snapshot-id rejection; exactly-once consumption; tenant scoping | `tests/settlement/net-w008-ac-03-verified-gate.test.ts` (7) |
| AC-04 cash and credits distinct; explicit conversion | Separate units/accounts; recorded non-1:1 rates; funded-side balance checks both directions; conversion reversal; internal obligation settlement | `tests/settlement/net-w008-ac-04-cash-credits.test.ts` (6) |
| AC-05 rewards deterministic, policy/version aware, lineage-backed | Pure split determinism + exact conservation; consumption; cross-record determinism; versioned lineages + exact-version allocation; concurrent cross-org fork rejection; validation | `tests/settlement/net-w008-ac-05-rewards.test.ts` (6) |
| AC-06 authorized, idempotent, concurrent-safe, authoritative, audit-atomic | 13 endpoints deny-by-default; same-key replays; concurrent same-key; mature-vs-reverse serialization with no double-apply; concurrent conversions cannot overdraft; audit-append failure rollback; publication-failure recovery; authoritative tx lineage | `tests/settlement/net-w008-ac-06-atomicity-concurrency.test.ts` (8) |
| AC-07 reversals preserve history + conservation | PENDING/MATURE reversals with exact negation; CONSUMED guard; issuance reversal + insufficient-balance rejection + re-issuance; allocation reversal; obligation reversal; audit lineage to original transactions; global conservation after every reversal | `tests/settlement/net-w008-ac-07-reversals.test.ts` (9) |
| AC-08 architecture/out-of-scope regression | arch check 0 violations; frozen specs unchanged (all economic lock invariants quoted); work order binding; non-skeletal module; out-of-scope identifier patterns absent; /payments untouched + not imported; core+self imports only; no mutable balances; no workflow subject; boundary files; frozen core vocabulary; no other domain gained economic authority | `tests/regression/net-w008-ac-08-architecture-out-of-scope.test.ts` (11) + baseline updates |

Baseline updates (the same convention as NET-W005/006/007):
`tests/regression/ac-08-no-premature-domain-logic.test.ts`
(settlement → NET_W008_DOMAINS; /issueCredit/ permitted ONLY in
settlement, mirroring the NET-W005 PoV exception),
`tests/regression/net-w004-ac-08-architecture-out-of-scope.test.ts`
(settlement leaves DEFERRED_DOMAINS),
`tests/regression/net-w006-ac-08-architecture-out-of-scope.test.ts`
and `tests/regression/net-w007-ac-08-architecture-out-of-scope.test.ts`
(settlement implemented by NET-W008; W006/W007 intents preserved —
outcomes/reputation themselves still mint nothing).

## 6. Verification summary

`bun run verify` (final): **exit 0**.

- `tsc --noEmit` — PASS.
- `arch:check` — PASS (215 files scanned, 0 violations).
- `bun test` — **578 pass / 15 skip / 0 fail / 5854 expect() / 593
  tests across 71 files** (NET-W007 baseline: 515 pass / 530 tests /
  63 files; **+63 tests**, of which 50 are the seven NET-W008 AC
  suites + harness and 13 are the AC-08 regression suite; the
  remainder are strengthened baseline assertions).

Frozen specs untouched: `spec/architecture.md`,
`spec/architecture-lock.md` unchanged (AC-08 asserts the FROZEN status
and quotes the economic invariants verbatim).
