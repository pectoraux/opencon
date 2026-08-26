# Work Order NET-W008 — Participation Credits and economic ledger

**Architecture:** v1.0 (FROZEN) — binds to `spec/architecture.md` + `spec/architecture-lock.md`; changes neither.
**Issue:** #15 (READY_FOR_IMPLEMENTATION)
**Requirements:** ECON-001..005, SETTLE-001..003, AUD-003
**Acceptance criteria:** NET-W008-AC-01..08
**Dependencies:** NET-W002 (merged), NET-W003 (merged), NET-W004 (merged), NET-W005 (merged, 2d2cc6f), NET-W006 (merged, 63f24e3), NET-W007 (merged, 95fcf63)

## 1. Objective

Implement the provider-neutral economic ledger and Participation Credits
foundation in `/settlement` (architecture §18: the settlement boundary owns
credits, pending/mature value, cash/credit settlement). This is the
protocol's internal accounting authority for verified value: economic
inputs, pending value, explicit maturation, mature value, Participation
Credit issuance, cash accounting, reward allocation and internal
settlement state.

```text
Evidence / Measurement / VERIFIED PoV
                  ↓
         Economic Input (verified-source gate)
                  ↓
      Pending Value (PENDING value records + ledger)
                  ↓
        Explicit Maturation Gate
                  ↓
       Mature Value (MATURE value records + ledger)
         ↙           ↘
  Credit Issuance   Cash Accounting
   (PoV-gated)      (payable/receivable)
         ↓             ↓
       Reward / Internal Settlement State
```

## 2. The key rules

**No unverified issuance; pending ≠ mature; conservation.**

- A record that is not backed by a qualifying VERIFIED value source
  (a VERIFIED Proof-of-Value, a VERIFIED measured outcome, or
  platform/attested/provider-grade evidence) cannot create economic
  value at all (architecture-lock §1.3/§1.4, economic invariant 1).
- Pending value is visible as pending accounting state only and cannot
  be consumed as mature value (architecture-lock invariant 19). Credit
  issuance and reward allocation consume MATURE value records only.
- Credit issuance additionally REQUIRES a Proof-of-Value reference
  (architecture-lock §5 + invariant 20): the consumed mature value
  record must carry ≥1 `proof_of_value` source that resolves VERIFIED.
- Reputation, advertising spend, wealth, deposits, raw activity volume
  and model output can NEVER mint economic value: the economic-input
  contract carries no field for any of them, and the only accepted
  upstream source kinds are the three verified record kinds above
  (invariant 4; ECON-002; architecture-lock §4 — model output is input
  evidence, never authoritative).
- Double-entry conservation: every ledger transaction is mechanically
  balanced per unit (`Σdebit === Σcredit`, exact 6-decimal integer
  arithmetic), every posting leaves every account balance ≥ 0, and
  value/credits exist ONLY through explicitly authorized ledger entries
  (invariant 3). Cash and Credits are distinct accounting concepts
  (different units, different account kinds, architecture-lock
  invariant 7): no implicit 1:1 conversion exists — conversion is an
  explicit ledger entry recording both sides and the explicit rate.
- Corrections are append-only: historical ledger entries are immutable;
  reversals post negated entries that reference the original
  transaction (invariant 6).

## 3. Scope

### 3.1 Core vocabulary (`src/core/economics.ts`)

- `ECONOMIC_UNIT_TYPES` — `value` | `credits` | `cash` (ECON-004:
  cash, pending/mature value, credits and reputation are separate
  concepts; reputation carries no unit at all).
- `ECONOMIC_VALUE_SOURCES` — `proof_of_value` | `measured_outcome` |
  `evidence` + type guard (the qualifying verified record kinds).
- `QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES` — `platform` | `attested`
  | `provider` (model/self evidence never qualifies — the same
  evidence-authority rule the reputation engine applies, from the
  evidence domain's own source-type vocabulary).
- `ECONOMIC_VALUE_STATES` — `PENDING` | `MATURE` | `CONSUMED` |
  `REVERSED` + guard; `ECONOMIC_MATURATION_STRATEGIES` — `immediate` |
  `fixed_window` (SETTLE-002 settlement windows).
- `ECONOMIC_ACCOUNT_KINDS` — `pending_value`, `mature_value`,
  `credits`, `rewards`, `cash_payable`, `cash_receivable`,
  `protocol_recognition` + `economicAccountNormalSide` (credit-normal
  obligations vs debit-normal protocol/receivable accounts).
- `ECONOMIC_LEDGER_TX_KINDS`, `ECONOMIC_ENTRY_DIRECTIONS`,
  `ECONOMIC_CASH_KINDS`, `ECONOMIC_CONVERSION_DIRECTIONS`.
- `ECONOMIC_DECIMALS = 6` + `validateEconomicAmount` /
  `computeCreditAmount` (deterministic scaled-integer arithmetic;
  stable error code `ECONOMIC_VALIDATION`).

### 3.2 Double-entry ledger (`/settlement`)

- `EconomicAccount` — first-class account records keyed
  deterministically by (organizationScopeId, owner, kind, unit) so a
  tenant can never accumulate duplicate accounts for the same role.
  Person-owned accounts: pending/mature value, credits, rewards,
  cash payable/receivable. System account: `protocol_recognition`
  (per org, per unit) — the recognition/conversion contra account that
  keeps every transaction balanced per unit.
- `EconomicLedgerEntry` — immutable posting line: transaction id,
  account, direction (debit/credit), amount, unit, entry kind,
  denormalized (organizationScopeId, ownerPersonId, accountKind) so
  balances and lineage queries reconstruct from entries alone.
- `EconomicLedgerTransaction` — a balanced set of entries with an
  explicit `kind` (value_recognition, maturation, reversal,
  credit_issuance, reward_allocation, cash_accounting, conversion,
  settlement) and a `subjectRef` (the economic record it belongs to —
  AUD-003 settlement lineage).
- The posting layer validates per-unit balance + post-balance ≥ 0 for
  every affected account INSIDE the authoritative transaction (the
  shim's transaction-scoped scan sees uncommitted writes).
- Balances are NEVER stored as mutable counters — they are derived
  from the immutable entry set (reconstructability, AC-01).

### 3.3 Pending value / maturation (`/settlement` value service)

- `recordPendingValue` — the economic input gate: ≥1 upstream source,
  each RESOLVED through injected neutral lookups (existence + same
  organization scope + qualifying verified state: VERIFIED PoV, VERIFIED
  measured outcome, or platform/attested/provider evidence). Creates a
  PENDING `EconomicValueRecord` (amount > 0, 6 decimals, `value` unit,
  maturation policy) + the balanced recognition postings (debit
  protocol_recognition(value), credit pending_value). Atomic with the
  `economic_value.recorded` audit event.
- `matureValue` — the EXPLICIT maturation gate: PENDING → MATURE with
  balanced postings (debit pending_value, credit mature_value). Under a
  `fixed_window` policy, maturation is legal only when the explicit
  `effectiveAt` reference timestamp ≥ `windowEndAt` (no wall clock).
  Atomic with `economic_value.matured`.
- `reverseValue` — append-only correction from PENDING or MATURE (never
  CONSUMED): posts negated copies of the record's original postings,
  state → REVERSED with reason. Atomic with
  `economic_value.reversed`.
- Record mutations are version-checked read-modify-write within the
  authoritative transaction and serialized per record under an
  organization-independent mutex (`IdempotencyStore.withLock`,
  `economic_value_record:{id}` — the NET-W007 remediation pattern), so
  concurrent maturation/reversal/consumption of the same record can
  never double-apply.

### 3.4 Participation Credits (`/settlement` credit service)

- `issueCredits` — consumes ONE MATURE value record; the record MUST
  carry ≥1 `proof_of_value` source resolving VERIFIED (invariant 20).
  The explicit `creditsPerValueUnit` rate determines the deterministic
  credit amount (scaled-integer rounding). Posts a dual-side balanced
  transaction: value side (debit mature_value, credit
  protocol_recognition(value)) + credits side (debit
  protocol_recognition(credits), credit credits). Record → CONSUMED.
  Creates a first-class `CreditIssuance` record with a stable id, the
  PoV reference, the rate, both amounts, and full lineage. Atomic with
  `credit_issuance.issued`.
- `reverseIssuance` — append-only correction: negated postings (the
  beneficiary's credits balance must cover the return — conservation
  rejects overdraft), issuance → reversed, value record restored to
  MATURE. Atomic with `credit_issuance.reversed`.
- Credits are a protocol-native accounting unit (ECON-001): earned via
  issuance against verified value only; no speculative-asset semantics
  (ECON-005 — the ledger records utility/accounting balances only).

### 3.5 Reward accounting (`/settlement` reward service)

- `RewardAllocationPolicy` — immutable, versioned (stable `policyId`,
  monotonic version exactly latest+1, one organization scope per
  lineage, org-independent lineage mutex + in-tx lineage verification
  on EVERY create including version 1 — the exact NET-W007 policy
  lineage pattern). A policy carries ≥1 allocation entry
  (beneficiary person + weight > 0, unique beneficiaries).
- `allocateRewards` — consumes ONE MATURE value record as the source;
  deterministic split: share_i = floor(source × w_i / Σw) in policy
  order, the LAST share absorbs the rounding remainder so
  Σ shares === source EXACTLY (conservation). Posts debit
  mature_value(source holder) + credit rewards(beneficiary) per share.
  Record → CONSUMED. Creates a `RewardAllocation` carrying
  policyId + policyVersion, source reference, shares, lineage. Atomic
  with `reward_allocation.recorded`.
- `reverseAllocation` — negated postings with per-beneficiary balance
  checks; allocation → reversed; source record restored to MATURE.
  Atomic with `reward_allocation.reversed`.

### 3.6 Cash accounting + internal settlement state (`/settlement` cash service)

- `recordCashObligation` — payable (the protocol owes a counterparty)
  or receivable (a counterparty owes the protocol), amount > 0 in the
  `cash` unit, balanced postings against
  protocol_recognition(cash). First-class `CashObligation` record.
  Atomic with `cash_obligation.recorded`.
- `settleCashObligation` — explicit INTERNAL settlement state change
  (recognized → settled) with balanced postings; external payment
  execution remains NET-W030 (the neutral `/payments` port stays
  skeletal and untouched — architecture-lock invariant 25). Atomic
  with `cash_obligation.settled`.
- `reverseCashObligation` — append-only correction from `recognized`;
  negated postings. Atomic with `cash_obligation.reversed`.
- `recordConversion` — the ONLY cash↔credits movement path: explicit
  direction (`cash_to_credits` | `credits_to_cash`), explicit amounts
  on BOTH sides (the rate is recorded, never assumed 1:1), dual-side
  balanced postings. First-class `Conversion` record. Atomic with
  `conversion.recorded`. `reverseConversion` mirrors it.

### 3.7 API surface (guarded, tenant-scoped)

- Mutations (deny-by-default guard actions): `economicValue.create` /
  `economicValue.mature` / `economicValue.reverse`;
  `creditIssuance.create` / `creditIssuance.reverse`;
  `rewardPolicy.create`; `rewardAllocation.create` /
  `rewardAllocation.reverse`; `cashObligation.create` /
  `cashObligation.settle` / `cashObligation.reverse`;
  `conversion.create` / `conversion.reverse`.
- Reads (public, non-mutating): value records (+ per-beneficiary
  listing), credit issuances, reward policies/versions, reward
  allocations, cash obligations, conversions, ledger transactions
  (by id + by subject lineage), account balances and the per-participant
  economic summary (pending/mature/credits/rewards/cash balances
  derived from the immutable entry set).

## 4. Required invariants

1. **No unverified issuance:** pending value creation requires ≥1
   qualifying VERIFIED upstream source; credit issuance requires a
   MATURE record carrying a VERIFIED Proof-of-Value reference
   (architecture-lock §5, invariant 20). Evidence, not participant or
   agent claims, is authoritative for settlement (lock §1.4).
2. **Pending ≠ mature:** only MATURE records can be consumed by credit
   issuance or reward allocation; maturation is an explicit, audited,
   policy-gated state change (lock invariant 19; SETTLE-002).
3. **Conservation:** every ledger transaction balances per unit;
   every posting keeps every account balance ≥ 0; retries/replays do
   not duplicate value (idempotency keys + the per-record mutex);
   value/credits are created only by the explicitly authorized ledger
   entries above.
4. **No direct purchase of trust/value:** spend, wealth, deposits,
   raw activity volume, reputation records and model output have no
   contract path into the economic input gate (source-kind gate +
   verified-state gate; structural, like NET-W007's REP-002).
5. **Auditability:** every material economic change carries its
   source references, policy/version (rewards), actor, authoritative
   transaction id, idempotency record id and correlation/execution/
   causation lineage (AUD-003 settlement lineage).
6. **Correction by append-only accounting:** historical entries are
   never rewritten; every reversal posts negated entries referencing
   the original transaction and is balance-checked.
7. **Atomicity:** economic mutation + idempotency record + audit
   record commit in ONE authoritative transaction
   (IdempotencyStore.applyIdempotent + transactional audit buffer —
   NET-W004-AC-07 semantics). Post-commit audit publication failures
   retain pending events for the explicit recovery path; the durable
   commit is never undone (no fabricated economic state).
8. **External settlement separation:** no payment-provider semantics
   in `/settlement`; the neutral `/payments` port stays skeletal
   (NET-W030 owns external execution); internal payable/receivable
   state only (lock invariant 25). Fraud/hold/dispute semantics are
   NET-W009/010 (out of scope); the maturation gate is the seam where
   their hold checks will attach.

## 5. Non-goals (out of scope)

No fraud scoring/risk signals (NET-W009), staking/challenges/disputes
(NET-W010), campaign budgets/optimization (NET-W011+), helpfulness
pipeline (NET-W012), creator marketplace (NET-W015+), demand/
procurement pools (NET-W024+), benefit pools (NET-W028), external
settlement/payment execution (NET-W030 — the `/payments` and `/ledger`
neutral ports stay skeletal), blockchain/decentralized validation
(NET-W029+), credit utility consumption (NET-W011+ — credits may be
issued, held and converted; spending them on network utility arrives
with its own work item), and no pricing of advertising inventory.

## 6. Acceptance criteria → verification mapping

- **AC-01 economic ledger + credits first-class, durable,
  reconstructable** — `tests/settlement/net-w008-ac-01-first-class.test.ts`.
- **AC-02 pending/mature distinct; maturation explicit/auditable** —
  `tests/settlement/net-w008-ac-02-pending-mature.test.ts`.
- **AC-03 issuance requires verified value; spend/wealth/activity/
  reputation cannot mint** —
  `tests/settlement/net-w008-ac-03-verified-gate.test.ts`.
- **AC-04 cash and credits distinct; explicit conversion entries** —
  `tests/settlement/net-w008-ac-04-cash-credits.test.ts`.
- **AC-05 reward allocation deterministic, policy/version aware,
  lineage-backed** —
  `tests/settlement/net-w008-ac-05-rewards.test.ts`.
- **AC-06 mutations authorized, idempotent, concurrent-safe,
  authoritative, audit-atomic** —
  `tests/settlement/net-w008-ac-06-atomicity-concurrency.test.ts`.
- **AC-07 reversals preserve history + conservation** —
  `tests/settlement/net-w008-ac-07-reversals.test.ts`.
- **AC-08 architecture/out-of-scope regression (Architecture v1.0 +
  architecture-lock unchanged)** —
  `tests/regression/net-w008-ac-08-architecture-out-of-scope.test.ts`
  + baseline updates in
  `tests/regression/ac-08-no-premature-domain-logic.test.ts`,
  `tests/regression/net-w006-ac-08-architecture-out-of-scope.test.ts`
  and `tests/regression/net-w007-ac-08-architecture-out-of-scope.test.ts`.

Evidence document: `docs/net-w008-economic-ledger.md`.
