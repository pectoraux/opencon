# OpenCon Persistent Roadmap

**Architecture:** Open Contribution Protocol Architecture v1.0  
**Status:** Frozen architecture / approved requirements; all canonical work items W001–W036 complete; UX-01 is the first authorized post-backlog product-client target  
**Canonical backlog:** `spec/work-items.md`  
**Canonical dependency graph:** `spec/dependency-graph.md`  
**Canonical frozen constraints:** `spec/architecture.md`, `spec/architecture-lock.md`  
**Operational state:** `spec/PROJECT-STATE.md`

## Purpose

Durable implementation roadmap. A new LLM architect must be able to continue from the repository without prior chat context.

## Program invariant

OpenCon is one protocol with explicit authorities. Do not create a second authority for something an existing boundary already owns. Architecture v1.0 freezes sixteen domain boundaries; a seventeenth domain requires an Architecture Change Request and a new architecture version.

## Authority map

| Responsibility | Authoritative boundary |
|---|---|
| identity / organizations / participants | `/identity`, `/organizations`, `/participants` |
| opportunities / contributions | `/opportunities`, `/contributions` |
| lifecycle state | `/workflows` |
| evidence / commitments / Proof-of-Value | `/evidence` |
| normalized outcomes / measurement | `/outcomes` |
| reputation | `/reputation` |
| economic ledger / value / credits / cash / settlement | `/settlement` |
| risk / controls / disputes | `/disputes` |
| campaign policy | `/campaigns` |
| creator identity / matching / creator records | `/creators` |
| inventory / placements | `/inventory` |
| provider-specific integrations | `/adapters` |
| LLM / provider-neutral AI boundary | `/llm` |
| agent/orchestration mechanisms | `/agents` |
| API / workers / persistence / audit / config / observability | infrastructure boundaries |

Composition-root orchestration is allowed, but must not become a hidden second authority.

## Development state

### Phase 1 — Foundation
W001, W002, W003 — **COMPLETE**.

### Phase 2 — Protocol core
W004, W005, W006, W007, W008 — **COMPLETE**.

### Phase 3 — Trust
W009, W010 — **COMPLETE**.

### Phase 4 — Farmable contribution market
W011, W012, W013, W014 — **COMPLETE**.

### Phase 5 — Creator network
W015, W016, W017, W018 — **COMPLETE**.

### Phase 6 — Advertising network
W019, W020, W021, W022, W023 — **COMPLETE**.

### Phase 7 — Demand economy
W024, W025, W026, W027, W028 — **COMPLETE**.

### Phase 8 — Decentralization
W029, W030, W031, W032 — **COMPLETE**.

### Phase 9 — End-to-end proof

- W033 — **COMPLETE**. PR #68 merged `92482c6ea3b3dc18f8286d37b9c6236f9ef1c001`; final reviewed head `476b57971a06a9e74d1545fa30824904cbc2359b`. Complete contribution traversal proved in executable order with authoritative state/version witnesses and durable audit ordering; initial sequencing drift was remediated on the same PR.
- W034 — **COMPLETE**. PR #70 squash-merged `7c19a19addd44a07965fa25ee7cab021bab2016a`; final reviewed head `f66cb4f380afde56ed23716453a297d0280b2411`. Advertising traversal proved campaign/policy → supply/provenance → W021 selection → placement → lifecycle → MEASURING → real W022 measurement → outcomes → evidence/PoV → workflow completion → risk/dispute → settlement pending/mature → clearing. The same PR remediated the AC-09 fault proof into a genuine composite commit-failure rollback and replaced a wall-clock dispute fixture anchor.
- W035 — **COMPLETE**. PR #73 squash-merged `85e5d6d7b8ff1df2fda4740fdd1f541890496610`; final reviewed head `eaf19bd9292a1c924cf7a8e6d086838369a5affc`. Creator traversal proved discovery/matching → terms → W017 acceptance/UGC/rights → W018 disclosure/compliance → MEASURING → real W022 measurement → outcomes → evidence/PoV → workflow completion → risk/dispute → settlement → W030 external payment. Architect CHANGES REQUESTED on determinism was remediated on the same PR with fixed/authoritative timestamps, deterministic payment identity, a mechanical regression pin and additional mutation coverage. Final evidence: 2330 pass / 15 skip / 0 fail, 322/0 architecture+authority violations, 16/16 targeted mutations caught with byte-identical restoration, real PostgreSQL/Redis 17/17, real-provider round-trip 23/23, exact-head CI green, no production `src/` changes.
- W036 — **COMPLETE**. PR #81 squash-merged `e7e858e6f5734cf4be0a95b287e6b736f50f3287`; final reviewed head `d795b12b3db26c56593357fc8e2da62295c3e8bb`; issue #75 completed. Demand/procurement/benefit traversal proved demand pool → aggregate disclosure gate → qualified demand → supplier offers/hard eligibility/deterministic selection → sanctioned fulfillment lifecycle → measurement/outcomes → W027 baseline/counterfactual → verified savings/PoV → settlement → W028 benefit funding/deterministic allocation, with the 17-stage witness sequence, authoritative state/version ladder, 44 strictly-ascending durable audit markers, 17/17 targeted mutations caught with byte-identical restoration, real PostgreSQL/Redis 17/17, real provider round-trip 26/26, and exact-head CI green on both event paths. **Phase 9 and the canonical protocol backlog are complete.**

### Phase 10 — Product client (post-backlog)

- **UX-01 — CURRENT IMPLEMENTATION TARGET.** Issue #83 — `ready-for-implementation`. Governance PR #82 squash-merged `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`. The unified product client is a pure consumer of the versioned product API; implementation evidence lives in the product client environment. No new protocol authority, lifecycle engine, ledger, W037 behavior or architecture amendment is authorized.

## Dependency sequence

```text
W001 → W002/W003 → W004 → W005 → W006 → W007 → W008
                                 └→ W009 → W010
W004/W005/W008 → W011 → W012 → W013 → W014
W002/W007 → W015 → W016 → W017 → W018
W002/W011 → W019 → W020 → W021 → W022 → W023
W002/W008 → W024 → W025 → W026 → W027 → W028
W005/W007/W008 → W029 → W030/W031 → W032
W014/W018/W023/W028 → W033 → W034 → W035
W028/W033 → W036
```

The protocol dependency graph terminates at W036. UX-01 is post-backlog governance/product work and is not a new protocol dependency edge.

## W035 merge record

W035 is merged and closes the creator-side Phase-9 composition milestone. The implementation remains composition/proof-only with no production `src/` changes and no architecture amendment. Final merge is PR #73 at `85e5d6d7b8ff1df2fda4740fdd1f541890496610`, from reviewed head `eaf19bd9292a1c924cf7a8e6d086838369a5affc`.

The W035 evidence record is `docs/net-w035-complete-creator-lifecycle.md`. The same-PR determinism remediation is part of the durable evidence record.

## W036 merge record

W036 is merged and closes the demand/procurement/benefit Phase-9 composition milestone and, with it, the canonical protocol backlog. Final merge is PR #81 at `e7e858e6f5734cf4be0a95b287e6b736f50f3287`, from the architect-approved reviewed head `d795b12b3db26c56593357fc8e2da62295c3e8bb`. The implementation remained composition/proof-only with no production `src/` changes and no architecture amendment.

The W036 evidence record is `docs/net-w036-complete-demand-procurement-benefit-lifecycle.md`: the frozen 17-stage traversal contract proved with authoritative state/version witnesses and 44 ordered durable audit markers, 17/17 targeted mutations with byte-identical restoration, real PostgreSQL/Redis integration, a real provider-selection round-trip, and exact-head CI green on both event paths. The frozen work order `spec/work-orders/NET-W036.md` remains the governing record of the delivered contract.

## UX-01 governance merge record

UX-01 is the first authorized post-backlog product-client work item. Governance PR #82 squash-merged at `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`. Its four-file repository diff adds the Phase-10 backlog entry, dependency-graph product-client node, frozen work order and evidence ledger. No protocol `src/` behavior or frozen architecture file changed. The canonical implementation issue is #83, `READY_FOR_IMPLEMENTATION`.

The evidence ledger `docs/ux-01-unified-product-client.md` records the external product-client implementation, 23/23 interaction-path tests, browser verification and documented backend capability gaps. Those external implementation artifacts are not being represented as protocol-source changes in this repository.

## Post-backlog governance state

`spec/work-items.md` and the protocol dependency graph still terminate at NET-W036. UX-01 is explicitly authorized as a post-backlog product-client work item under the existing `/api` contract boundary; it is not W037 and must not introduce W037 protocol behavior. Architecture v1.0 remains frozen. Any later protocol work still requires a new architect-authored canonical backlog amendment, and any seventeenth domain requires an Architecture Change Request and a new architecture version.

## Operating procedure

1. Confirm issue/readiness/dependencies.
2. Read roadmap, project state, frozen architecture/lock and canonical work item.
3. Author work order and evidence ledger before coding.
4. Reuse existing ports and `...WithinTx` primitives.
5. Implement one-to-one AC suites plus architecture/out-of-scope regression.
6. Run complete local/integration gates and targeted mutations.
7. Create exactly one implementation PR.
8. Architect reviews; CHANGES REQUESTED is remediated on the same PR.
9. Merge only after implementation, green verification/CI and architect approval.
10. After merge, update `spec/PROJECT-STATE.md` and this roadmap with the canonical merge SHA before advancing.

For UX-01, the product-client implementation is external to this protocol repository; its own implementation PR/environment must satisfy the frozen UX-01 work order and retain the same single-PR remediation discipline.

## Merge policy

```text
implementation complete
+ verification/CI green
+ architect approval
→ merge
```
