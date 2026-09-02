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
- W031 — **COMPLETE**. PR #64 merged `83f0e5b0041f6cb8c67b8d6334f08d52eaafc770`. Portable reputation proofs: verifiable reputation claims without raw private records, derived from `/reputation` through W029 signing/commitment machinery with aggregate-only disclosure, deterministic fail-closed verification, tenant-scoped issuance and self-contained presentation. Final remediation sealed revocation state into the signed canonical facts and preserved zero tenant-state lookups at presentation.
- W032 — **COMPLETE**. PR #66 merged `a65bfdbd967ab6a606757a49538aa184f6838480`. Decentralized validation/dispute coordination inside `/disputes`: scoped validator participants, deterministic assignment and conflict exclusion, versioned count-based quorum, immutable challenge rounds/rechallenge, evidence-backed independent observations, settlement-only validator stakes, and owning-authority application. Architect review initially found an idempotent-replay ordering defect; the same PR remediated it across all audited W032 mutations, adding temporal replay regressions and mutation coverage. Final remediation head `fe2c9001753a3bacac553fed953103005e1e4b59` passed the full gate before merge.

### Phase 9 — End-to-end proof
- W033 — **COMPLETE**. PR #68 merged `92482c6ea3b3dc18f8286d37b9c6236f9ef1c001`. Final reviewed head `476b57971a06a9e74d1545fa30824904cbc2359b`. The complete contribution traversal is proven in executable order: sanctioned `/workflows` publication to SUBMITTED, MEASURING point, `/evidence` + `/outcomes`, PoH evaluation, lifecycle completion to VERIFIED, reputation, settlement, then benefits. The same PR remediated initial sequencing drift and added deterministic traversal/audit-order witnesses.
- W034 — **CURRENT IMPLEMENTATION TARGET**. Complete advertising lifecycle composition proof: advertiser/campaign → inventory/creator supply → measurement → Evidence/Proof-of-Value → applicable risk/privacy controls → settlement.
- W035 — **PLANNED**. Complete creator lifecycle: creator discovery → contract → UGC → disclosure → measurement → payment.
- W036 — **PLANNED**. Complete demand/procurement/benefit lifecycle: demand → supplier → fulfillment → verified savings → benefit allocation.

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

## W033 merge record

W033 is merged and closes the first Phase-9 composition milestone for the contribution side. The implementation deliberately added no new source-domain authority: the final scenario uses existing owning boundaries and proves the declared executable order with authoritative contribution state/version witnesses plus durable audit order. The final merge is PR #68 at `92482c6ea3b3dc18f8286d37b9c6236f9ef1c001` (reviewed head `476b57971a06a9e74d1545fa30824904cbc2359b`).

The final W033 evidence record is `docs/net-w033-complete-contribution-lifecycle.md`.

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
