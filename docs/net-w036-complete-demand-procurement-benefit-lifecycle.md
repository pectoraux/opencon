# NET-W036 Evidence Ledger — Complete demand/procurement/benefit lifecycle

**Status:** PREPARED — awaiting implementation  
**Issue:** #75  
**Dependencies:** NET-W028 + NET-W033 — merged/verified  
**Architecture:** v1.0 frozen  
**Preparation branch:** `docs/net-w036-prep`

## 1. Purpose

This ledger is the durable evidence contract for W036. The implementation PR must replace the verification placeholders with exact commands, counts, SHAs, CI runs, test paths and architect-reviewed remediation.

W036 proves one canonical demand/procurement/benefit execution through the existing authorities:

```text
demand pool
→ privacy-safe qualified demand
→ supplier offers / eligibility / deterministic selection
→ fulfillment lifecycle
→ measurement / outcomes
→ W027 baseline / counterfactual
→ evidence / Proof-of-Value
→ settlement
→ W028 benefit funding / allocation
```

A terminal benefit allocation is not sufficient evidence; executable order must be demonstrated with authoritative state/version witnesses and durable audit ordering.

## 2. Evidence contract by authority

| Area | Owner | Forbidden W036 behavior |
|---|---|---|
| demand pools / supplier offers / selection | `/demand` | second procurement authority or hidden supplier economics |
| lifecycle | `/workflows` | local fulfillment state machine |
| measurement integration | `/measurement`, `/adapters` | provider semantics in core |
| normalized outcomes | `/outcomes` | local measurement truth |
| savings/baseline/counterfactual | W027 / `/evidence` existing contracts | new savings semantics or caller-supplied savings |
| evidence / PoV | `/evidence` | caller/provider/model authorization |
| economics | `/settlement` | procurement/benefit ledger |
| benefits | `/benefits` | recreated economic value or second ledger |

## 3. Canonical traversal witness contract

The implementation must emit an ordered witness set with durable ids and owning-authority state/version where applicable. Minimum stages:

1. demand pool resolved;
2. aggregate disclosure gate passed;
3. qualified demand resolved;
4. supplier offers recorded;
5. supplier hard eligibility evaluated;
6. deterministic competitive selection committed;
7. fulfillment/execution entered through sanctioned lifecycle;
8. authoritative execution state/version observed;
9. realized outcome normalized;
10. supported baseline/counterfactual resolved;
11. savings verified / PoV qualified;
12. settlement value recognized pending;
13. applicable risk/dispute controls exercised and resolved;
14. value matured through `/settlement`;
15. benefit funding reference resolved;
16. deterministic member eligibility/allocation committed;
17. final lineage reconstruction completed.

If ordering depends on durable commits, audit insertion/commit order must corroborate the witness order. Local array order alone is not evidence.

## 4. Acceptance evidence map

### AC-01 Demand pool authority

**Required proof:** tenant-scoped pool, authorization, authoritative commitments, qualified demand and fail-closed foreign references.

**Mutation targets:** bypass tenant gate; trust caller aggregate; select unqualified demand.

### AC-02 Aggregate disclosure privacy

**Required proof:** commitment count and distinct buyer-organization count remain separate dimensions; every aggregate is behind the correct disclosure gate.

**Mutation targets:** collapse counts; bypass aggregate gate; leak participant/commercial detail.

### AC-03 Supplier offers and selection

**Required proof:** offers owned by `/demand`, hard eligibility precedes selection, at least one candidate excluded, deterministic winner.

**Mutation targets:** rank before hard gates; accept stale/ineligible offer; let AI/advisory override eligibility; create economic mutation during selection.

### AC-04 Fulfillment lifecycle

**Required proof:** execution uses existing `/workflows` authority wherever lifecycle state applies; no second procurement state machine.

**Mutation targets:** direct state write; bypass sanctioned lifecycle transition.

### AC-05 Measurement/outcomes

**Required proof:** deterministic measurement through provider boundary into `/outcomes`, provenance and uncertainty preserved, raw provider payload contained.

**Mutation targets:** accept before required measurement point; strip uncertainty; leak raw provider data; bypass adapter boundary.

### AC-06 Baseline/counterfactual/savings

**Required proof:** W027-supported baseline/counterfactual, observed/counterfactual evidence, uncertainty preserved, unsupported/stale/invalid support fails closed.

**Mutation targets:** accept unsupported baseline; accept stale baseline; invent deterministic savings from insufficient evidence; drop uncertainty.

### AC-07 Evidence / Proof-of-Value

**Required proof:** verified evidence/PoV authorizes downstream value only through `/evidence`; caller/provider/model assertions do not mint savings.

**Mutation targets:** trust caller grade/value; bypass verification; sever outcome-to-evidence lineage.

### AC-08 Settlement

**Required proof:** verified value enters `/settlement` through existing primitives, pending/mature distinction holds, applicable risk/dispute gates hold, no procurement ledger exists.

**Mutation targets:** recognize unverified value; mature while gated; write outside settlement primitive; create second ledger.

### AC-09 Benefits

**Required proof:** W028 consumes authoritative funded value; deterministic eligibility/allocation; allocation ≤ funded source; remainder/conservation explicit; no private supplier/buyer leakage.

**Mutation targets:** fund from caller-supplied value; allocate beyond funded amount; bypass eligibility; collapse privacy dimensions; write economic state outside settlement.

### AC-10 Replay/concurrency/atomicity/tenancy/lineage/architecture

**Required proof:** same-key replay returns identical records; race yields exactly-once economic effect; commit failure after staged work leaves no partial value/ledger/audit/idempotency state and healthy retry succeeds once; cross-tenant references fail closed; architecture and authority checks remain clean; no W037 behavior.

**Mutation targets:** skip idempotency store; remove concurrency lock; publish audit before commit; suppress rollback; remove tenant recheck; introduce local state/ledger.

## 5. Required implementation evidence

- `bun run typecheck`
- `bun run arch:check`
- `bun run authority:check`
- `bun run verify`
- targeted mutation driver with byte-identical source restoration;
- configured real PostgreSQL + Redis integration;
- applicable real provider-selection end-to-end round-trip;
- secret scan;
- exact changed-file inventory;
- frozen architecture byte comparison;
- one-to-one AC-01..AC-10 suites;
- final traversal and durable audit-order reconstruction;
- exact CI push + pull_request runs at the final reviewed head;
- architect approval and merge SHA.

## 6. Verification record template

```text
Implementation PR: #___
Implementation branch: feat/net-w036-complete-demand-procurement-benefit-lifecycle
Reviewed head: __________
Merge SHA: __________

Changed files: ___
Production src changes: ___
Frozen architecture file changes: 0

bun run typecheck: PASS/FAIL
bun run arch:check: ___ files / ___ violations
bun run authority:check: ___ files / ___ violations
bun run verify: ___ pass / ___ skip / ___ fail / ___ tests / ___ files
Targeted mutations: ___/___ caught; byte-identical restoration: PASS/FAIL
Real PostgreSQL + Redis: ___ pass / ___ fail
Real provider round-trip: ___ checks / ___ passed
Secret scan: PASS/FAIL
CI push exact-head: run ___ / PASS/FAIL
CI pull_request exact-head: run ___ / PASS/FAIL

Traversal witnesses: __________
Durable audit markers: __________
AC-09 rollback proof: __________
Same-key retry: __________
Concurrent exactly-once proof: __________
Tenant matrix: __________
Benefit conservation: __________

Architect decision: PENDING
```

## 7. Remediation discipline

Any architect CHANGES REQUESTED finding is remediated on the same implementation PR/branch. Re-run the complete required gate at the resulting exact head, update this ledger, and re-review. No second implementation PR is permitted for W036.

## 8. Decision of record

W036 is a composition/evidence milestone. The implementation must use existing W024–W030/W033 authorities, with W027 savings/counterfactual semantics and W028 benefit semantics treated as existing truth. Missing primitives are formal architecture/work-item gaps, never an invitation to invent authority in W036.
