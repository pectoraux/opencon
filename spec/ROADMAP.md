# OpenCon Persistent Roadmap

**Architecture:** Open Contribution Protocol Architecture v1.0  
**Status:** Frozen architecture / approved requirements; implementation progressing by sequential NET-W work items  
**Canonical backlog:** `spec/work-items.md`  
**Canonical dependency graph:** `spec/dependency-graph.md`  
**Canonical frozen constraints:** `spec/architecture.md`, `spec/architecture-lock.md`  
**Operational state:** `spec/PROJECT-STATE.md`  

## Purpose

This is the durable roadmap for the implementation program. A new LLM architect must be able to continue from the repository without prior chat context.

## Program invariant

OpenCon is one protocol with explicit authorities. Do not create a second authority for something an existing boundary already owns. The v1.0 architecture freezes sixteen domain boundaries; a seventeenth domain requires an explicit Architecture Change Request and new architecture version.

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
- W024 — **COMPLETE**.
- W025 — **COMPLETE**. PR #51 merged `bcaf81b82088688af701f1a90242cc61b1fdd094`.
- W026 — **COMPLETE**. PR #53 merged `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`.
- W027 — **COMPLETE**. PR #55 merged `d78a9b8bbb8e4319e73e75e1ca4bc8229b2ed300`.
- W028 — **CURRENT IMPLEMENTATION TARGET**. Benefit Pools inside `/benefits` using authoritative upstream value and `/settlement` as the sole economic authority.

### Phase 8 — Decentralization
W029, W030, W031, W032 — **PLANNED**.

### Phase 9 — End-to-end proof
W033, W034, W035, W036 — **PLANNED**.

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

## W028 implementation contract

### Authority model

```text
verified authoritative upstream value / realized savings
                    ↓
          Benefit Pool funding reference
                    ↓
       /benefits — pool + allocation semantics
                    ↓
   deterministic member eligibility + weights
                    ↓
       allocation plan / benefit lineage
                    ↓
 /settlement — SOLE economic mutation authority
```

### Non-negotiables

1. W028 stays inside the existing `/benefits` frozen boundary; no new domain.
2. Pool funding must resolve server-side to authoritative upstream value; caller-supplied amounts are never authority.
3. No value is created: allocation cannot exceed funded value.
4. Rounding and remainders are deterministic, explicit and conserved.
5. Allocation policy is explicit, versioned/immutable and lineage-safe.
6. Eligibility and weights are derived from authoritative inputs, not caller assertions.
7. Material economic effects re-derive current funding/eligibility/capacity; stale snapshots cannot authorize new value movement.
8. Member and pool views preserve privacy and do not expose protected procurement commitments unnecessarily.
9. Tenant and authorization failures are fail-closed and do not reveal existence.
10. Coupled mutations use existing idempotency, concurrency, one-authoritative-transaction, transactional-audit and post-commit publication patterns. Use `...WithinTx` settlement primitives.
11. `/settlement` remains the only authority for balances, credits, cash, rewards and economic postings.
12. AI, if used, is advisory only; it cannot authorize funding, eligibility, privacy or allocation.
13. `/workflows` remains lifecycle authority; W028 must not create local workflow machinery.
14. W029+ and W033+ work remain excluded.
15. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

### Required evidence

AC coverage for BEN-001..004; funding authority; conservation/rounding; deterministic allocation; policy versioning; privacy/tenancy/authorization; idempotency/concurrency/atomicity and fault injection; settlement-only economic mutation; targeted mutation checks; `bun run verify`; architecture/authority checks; secret scan; configured PostgreSQL/Redis integration.

## Operating procedure

1. Confirm issue/readiness/dependencies.
2. Read this roadmap, `spec/PROJECT-STATE.md`, frozen architecture/lock and canonical work item.
3. Author `spec/work-orders/NET-WXXX.md` and evidence ledger before coding.
4. Reuse existing ports and `...WithinTx` primitives.
5. Implement one-to-one AC tests plus architecture/out-of-scope regressions.
6. Run complete local and configured integration gates plus targeted mutation checks.
7. Create exactly one implementation PR.
8. Architect reviews; CHANGES REQUESTED is remediated on the same PR.
9. Merge only after implementation + green verification/CI + architect approval.
10. After merge, update `spec/PROJECT-STATE.md` and this roadmap with the canonical merge SHA before advancing.

## Merge policy

```text
implementation complete
+ verification/CI green
+ architect approval
→ merge
```
