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
- W028 — **COMPLETE**. PR #57 merged `6e309e2af05a962e3417999ad8079da16d9ebc37`. The last skeletal v1.0 domain activated: every frozen domain is now implemented.

### Phase 8 — Decentralization
- W029 — **COMPLETE**. PR #60 merged `cf53378e1c432dfd735e1b408010eece55d7612f`. The Phase-8 integrity layer: production signed attestations (Ed25519/ECDSA behind injected interfaces; closed versioned vocabularies; SecretProvider-only keys) + salted coverage commitments over the three authoritative record families, with deterministic fail-closed verification and PostgreSQL authority containment.
- W030 — **CURRENT IMPLEMENTATION TARGET**. External settlement adapters: authenticated, idempotent, append-only external transaction FACTS recorded inside `/settlement` and deterministically reconciled against the internal ledger lineage — adapters provide transaction facts, never economic authority (architecture-lock §14 invariant 25).
- W031, W032 — **PLANNED**.

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

## W030 implementation contract

### Authority model

```text
/settlement internal economic authority (W008/W014/W020)
(ledger transactions, value records, credits, cash obligations)
                    ↓ neutral internal lineage references
/adapters provider-specific external settlement integrations
(authenticated + fail-closed; the W023 discipline)
                    ↓
external settlement transaction FACTS (append-only, idempotent,
provider-authenticated, tenant-scoped)
                    ↓
/settlement records the facts + DERIVES the deterministic reconciliation
(matched / pending / mismatched — never an economic mutation)
                    ↓
PostgreSQL remains THE authoritative state
(an external fact can never mint, consume or mutate internal value)
```

### Non-negotiables

1. External transaction facts attach to the EXISTING internal settlement lineage by canonical id; they never mint, consume or mutate internal economic state.
2. `/settlement` remains the SOLE economic authority: adapters provide transaction FACTS (architecture-lock §14 invariant 25); no external execution of internal mutations; no second ledger.
3. `/adapters` owns ALL provider-specific code; `/settlement` consumes ONLY the neutral `ExternalSettlementAdapter` contract wired at the composition root (the W023 discipline); no 17th domain.
4. Adapter-delivered facts are AUTHENTICATED with SecretProvider-resolved material; unauthenticated, stale or malformed submissions fail closed — never silently recorded.
5. Fact recording is idempotent per (organization scope, provider, external id): exactly-once, replay-safe, concurrency-safe.
6. Reconciliation (matched/pending/mismatched) is DERIVED, deterministic and server-side with machine-readable reasons; mismatches are recorded + audited, never auto-corrected.
7. Tenant and authorization failures remain fail-closed without existence oracles.
8. Material mutations use the established composite idempotency, one-authoritative-transaction, transactional-audit and post-commit publication patterns.
9. AI, if used, is advisory only; it cannot authorize ingestion or reconciliation outcomes.
10. W031+ portable reputation proofs, W032+ decentralized validation and W033+ end-to-end flows remain excluded.
11. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

### Required evidence

AC coverage for SETTLE-001..003 + ADAPTER-008; fact-recording round-trips over the neutral adapter contract; authentication fail-closed paths; deterministic reconciliation with machine-readable reasons; no-economic-bypass containment; tenancy/authorization; idempotency/concurrency/atomicity and fault injection; traceability in both directions; targeted mutation checks; `bun run verify`; architecture/authority checks; secret scan; configured PostgreSQL/Redis integration.

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
