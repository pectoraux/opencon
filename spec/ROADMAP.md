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
- W030 — **COMPLETE**. PR #62 merged `1d902e2148920ddd04e2b170509184d7b585cb3e`. The Phase-8 fact-ingestion/reconciliation layer: external settlement transactions as authenticated, idempotent, append-only FACTS inside `/settlement` (neutral adapter contracts; structural adapter implementation under `/adapters`; SecretProvider-only per-provider trust material, fail-closed, no dev fallback), deterministically reconciled against the internal ledger lineage — an external fact can never mint, consume or mutate internal value (architecture-lock §14 invariant 25).
- W031 — **CURRENT IMPLEMENTATION TARGET**. Portable reputation proofs: verifiable reputation claims without raw private records — proofs derive from the authoritative `/reputation` state through the W029 signed-attestation machinery, disclose aggregate facts only under the aggregate disclosure gate, and verify deterministically with fail-closed machine-readable reasons.
- W032 — **PLANNED**.

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

## W031 implementation contract

### Authority model

```text
/reputation internal reputation authority (W007 — UNCHANGED)
(dimension state, authoritative inputs, snapshots, time decay)
        ↓ neutral lookups (aggregate, opaque-reference facts only)
/evidence W029 signed-attestation machinery (COMPOSED — no new crypto)
(versioned algorithm/key vocabularies, SecretProvider-only keys,
 deterministic fail-closed verification)
        ↓
portable reputation PROOFS (derived, tenant-scoped at issuance,
 self-contained at presentation, aggregate disclosure only)
        ↓
verification is deterministic + fail-closed (machine-readable reasons)
no raw private record, no cross-tenant data, no reputation transfer
(reputation STAYS authoritative in PostgreSQL; proofs INFORM)
```

`/reputation` remains the SOLE reputation authority; W031 adds proof DERIVATION, presentation and verification only, composing the existing W029 signed-attestation machinery (the composition root is the only join). No 18th domain.

### Non-negotiables

1. Proofs are DERIVED views over the authoritative `/reputation` state — never a second reputation authority, never raw record transfer (PRIV-001..002).
2. Proof issuance composes the W029 machinery: REP-004 evidence lineage via opaque references; no new signing surface, no new key-material class.
3. Disclosure is AGGREGATE and scoped under the aggregate disclosure gate (dimension scores, grades, decayed values, evidence-reference counts) — no raw personal activity, payloads, or cross-tenant data (PRIV-003).
4. Verification is deterministic, non-mutating, fail-closed with machine-readable reasons from a closed vocabulary.
5. Proofs are tenant-scoped at issuance and self-contained at presentation (no existence oracles; verification never queries tenant-scoped state).
6. Reputation remains non-purchasable (REP-002): no proof path accepts spend/wealth as reputation substance.
7. Time decay applies at derivation (REP-003): disclosed scores are the authority's own deterministic decayed values, never presentation-side recomputations.
8. Issuance uses composite idempotency, one authoritative transaction, transactional audit; presentation/verification mutates and audits nothing.
9. AI, if used, is advisory only; it cannot authorize proof issuance or verification outcomes.
10. W032+ decentralized validation and W033+ end-to-end flows remain excluded.
11. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

### Required evidence

AC coverage for REP-003..004 + PRIV-001..003; proof-issuance round-trips over the composed W029 machinery; aggregate-disclosure containment (no raw records, no cross-tenant leakage); deterministic verification with fail-closed paths (tamper/revocation/staleness); non-purchasability containment; time-decay consistency; tenancy/authorization; idempotency/concurrency/atomicity; targeted mutation checks; `bun run verify`; architecture/authority checks; secret scan; configured PostgreSQL/Redis integration.

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
