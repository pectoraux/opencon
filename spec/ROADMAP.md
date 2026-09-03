# OpenCon Persistent Roadmap

**Architecture:** Open Contribution Protocol Architecture v1.0  
**Status:** Frozen architecture / approved requirements; canonical work items W001–W036 complete; UX-01 complete  
**Canonical backlog:** `spec/work-items.md`  
**Canonical dependency graph:** `spec/dependency-graph.md`  
**Canonical frozen constraints:** `spec/architecture.md`, `spec/architecture-lock.md`  
**Operational state:** `spec/PROJECT-STATE.md`  
**Post-backlog use-case governance:** `spec/USE-CASE-PROGRAM.md`

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
| LLM / provider-neutral AI | `/llm` |
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
- W033 — **COMPLETE**. PR #68 merged `92482c6ea3b3dc18f8286d37b9c6236f9ef1c001`.
- W034 — **COMPLETE**. PR #70 merged `7c19a19addd44a07965fa25ee7cab021bab2016a`.
- W035 — **COMPLETE**. PR #73 merged `85e5d6d7b8ff1df2fda4740fdd1f541890496610`.
- W036 — **COMPLETE**. PR #81 merged `e7e858e6f5734cf4be0a95b287e6b736f50f3287`. Phase 9 and the canonical protocol backlog terminate here.

### Phase 10 — Product client (post-backlog)

- UX-01 — **COMPLETE**. Issue #83 closed as completed. Governance PR #82 merged `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`; implementation PR #84 squash-merged `d87977c7ed14bb67f51925a3d3d09c67e76c79a1` from reviewed head `acc44c90789f0705d7b3866dc893accc9333c50a`. The unified client remains external to this protocol repository and is a pure consumer of the versioned product API.

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

The protocol dependency graph terminates at W036. UX-01 is post-backlog product work, not a new protocol dependency edge.

## W036 merge record

W036 closed the demand/procurement/benefit Phase-9 composition milestone and the canonical protocol backlog. Final merge: PR #81 at `e7e858e6f5734cf4be0a95b287e6b736f50f3287`, reviewed head `d795b12b3db26c56593357fc8e2da62295c3e8bb`.

## UX-01 completion record

UX-01 is the first authorized post-backlog product-client work item. Governance PR #82 merged at `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`. Implementation PR #84 was architect-approved at exact head `acc44c90789f0705d7b3866dc893accc9333c50a` and squash-merged as `d87977c7ed14bb67f51925a3d3d09c67e76c79a1`.

The implementation record is `docs/ux-01-unified-product-client.md`. The product client remains outside the protocol repository; no frontend authority, new ledger, lifecycle engine, W037 behavior, or architecture amendment was introduced. The final evidence records 23 interaction-path tests / 125 assertions, protocol architecture + authority 322/0, fresh browser verification, responsive verification and exact-head CI green including real PostgreSQL + Redis integration.

## Post-backlog state

There is currently **no authorized successor work item** after UX-01. No UX-02 or W037 may be invented. The next implementation must first be authorized through the governance process with a frozen scope, acceptance criteria, authority placement and verification gate.

The intended operating mode is now **use-case-driven platform validation**. `spec/USE-CASE-PROGRAM.md` defines the candidate scoring, capability-coverage matrix, capability-gap classification, evidence contract and implementation/merge discipline. The candidate scenario families in that document are not authorized work items.

## Operating procedure

1. Confirm issue/readiness/dependencies or, for post-backlog work, complete the governance authorization first.
2. Read roadmap, project state, frozen architecture/lock and the active governance/use-case/work item.
3. Author/freeze the work order and evidence ledger before coding.
4. Reuse existing ports and `...WithinTx` primitives.
5. Implement one-to-one acceptance tests plus architecture/out-of-scope regression.
6. Run complete local/integration gates and targeted mutations.
7. Create exactly one implementation PR.
8. Architect reviews; CHANGES REQUESTED is remediated on the same PR.
9. Merge only after implementation, green verification/CI and architect approval.
10. After merge, update `spec/PROJECT-STATE.md` and this roadmap with the canonical merge SHA before advancing.

For post-backlog product work, the product implementation is external to this protocol repository unless a future governance decision explicitly changes that boundary.

## Merge policy

```text
implementation complete
+ verification/CI green
+ architect approval
→ merge
```
