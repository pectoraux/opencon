# `settlement` boundary

**Tier:** domain
**Authority:** credits, pending/mature value, cash/credit settlement (architecture §18)
**Architecture ref:** `spec/architecture.md` §4–§5, §18–§19; `spec/architecture-lock.md` §1 (invariants 3/4/7), §5 (economic authority), §13 (economic safety invariants 19–21), §14 (invariant 25)
**Concrete behaviour:** NET-W008 (see `spec/work-orders/NET-W008.md`)

## Scope after NET-W008

The settlement boundary is the protocol's internal accounting
authority for verified value — a provider-neutral, double-entry
economic ledger:

- **Economic value records** — pending value recognized ONLY from
  qualifying VERIFIED upstream sources (a VERIFIED Proof-of-Value, a
  VERIFIED measured outcome, or platform/attested/provider evidence),
  with an explicit, auditable maturation gate (`immediate` or
  `fixed_window` settlement windows — SETTLE-002) and append-only
  reversals.
- **Participation Credits** — issued ONLY against a MATURE value
  record carrying a VERIFIED Proof-of-Value reference
  (architecture-lock invariant 20), at an explicit recorded rate;
  credits are an earned accounting unit, distinct from cash
  (invariant 7) and never a speculative asset (ECON-005).
- **Reward accounting** — immutable versioned allocation policies
  (the NET-W007 lineage pattern) and deterministic splits of a mature
  source record among beneficiaries (Σ shares === source exactly).
- **Cash accounting** — payables/receivables in the `cash` unit with
  internal settlement state; external payment execution is NET-W030
  behind the neutral `/payments` port (invariant 25) and never
  happens here.
- **Conversions** — the ONLY cash↔credits path: an explicit ledger
  entry recording both amounts (the rate is recorded, never assumed
  1:1).

## Conservation model

Every ledger transaction balances per unit (`Σdebit === Σcredit` in
scaled-integer arithmetic), every posting keeps every account balance
≥ 0, and balances are always DERIVED from the immutable entry set
(never stored as mutable counters) — the ledger is reconstructable by
construction. Concurrent postings serialize per account (sorted lock
acquisition — see `posting.ts`), the documented monolith stand-in for
PostgreSQL `SELECT … FOR UPDATE` row locking.

## Scope in NET-W010 — stake escrow

`stake-service.ts` (+ `authority-stake-repository.ts`, collection
`stakes`): the economic authority for challenge participation stakes
(NET-W010). Commit debits the owner's `credits` into their
`stake_escrow`; release returns it; forfeit moves it to protocol
recognition — every posting through the shared posting layer
(conservation + non-negative guards). One COMMITTED stake per purpose;
terminal outcomes carry append-only lineage. The /disputes boundary
consumes these ONLY through composition-root orchestration (it never
posts); this domain carries NO dispute lifecycle (asserted by the
NET-W008/W010 regressions).

## Scope in NET-W020 — cross-promotion clearing

`clearing-service.ts` + `clearing-eligibility.ts` (the pure evaluator)
+ `authority-clearing-repository.ts` (collection
`cross_promotion_clearings`): the durable clearing EXECUTION records
linking a qualifying source contribution and a settlement-ready target
placement through canonical inventory/campaign references (CAMP-004/
005 multilateral clearing). The records are pure LINEAGE — the
eligibility snapshot is RE-DERIVED inside the authoritative clearing
transaction through the neutral lookups (contribution qualification,
the W019 placement settlement readiness, the campaign clearing rules,
the risk/dispute gate) and the draw result is verified against the
same domain's allocation/issuance/obligation records. ONE clearing per
(contribution, placement) pair (advisory pair mutex + in-tx
create-once). The record posts NOTHING — the economic mutation flows
exclusively through the EXISTING primitives' `...WithinTx` bodies
(`allocateRewardsWithinTx` / `issueCreditsWithinTx` /
`recordCashObligationWithinTx`) executed on the clearing's SINGLE
authoritative transaction; no new account kind, transaction kind or
value source exists (no second ledger). The atomic clearing operation
is `executeCrossPromotionClearing` (the PR #40 remediation: qualify →
risk/dispute gate → draw → clearing record → campaign bookkeeping in
ONE exactly-once economic unit — one `applyIdempotent`, one
`AuthorityTransaction`, one COMMIT; the campaign bookkeeping
participates through the neutral `ClearingCampaignBookkeepingPort`);
the derived eligibility view is `evaluateClearingEligibility`; the
composition-root apiCommand is the thin adapter.

## Dependencies

`core` contracts only. Upstream record resolution (evidence,
Proof-of-Value, measured outcomes, persons) arrives through the
neutral structural lookups declared in `port.ts`, wired by the
bootstrap composition root. The domain imports no infrastructure, no
other domain and no payment provider SDK.
