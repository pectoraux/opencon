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
- W029 — **CURRENT IMPLEMENTATION TARGET**. Cryptographic attestations and commitments: signed evidence attestations and hash commitments over existing authoritative records, without changing centralized semantic authority (PostgreSQL stays authoritative; no consensus, no external execution).
- W030, W031, W032 — **PLANNED**.

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

## W029 implementation contract

### Authority model

```text
existing authoritative records
(/evidence evidence records, /reputation inputs, /settlement value records)
                    ↓
     /evidence attestation + commitment semantics
     (the integrity layer over authoritative references)
                    ↓
 signed attestations (versioned algorithms + key references)
 + hash commitments (payload-hiding, binding)
                    ↓
 deterministic server-side verification (fail closed)
                    ↓
 PostgreSQL remains THE authoritative state
 (an attestation never mints, mutates or resurrects authority)
```

### Non-negotiables

1. W029 attaches attestations/commitments to existing authoritative records; it never creates new semantic authority and never mutates authoritative state.
2. Cryptography is an integrity/provenance layer, never a consensus layer: no blockchain, no network validation, no token economics (W030/W031/W032 remain excluded).
3. `/evidence` remains the provenance/truth authority and the home of attestation/commitment semantics; `/reputation` and `/settlement` ports stay untouched (references cross through neutral read paths).
4. Signature verification is deterministic, server-side and version-pinned; failures fail closed; algorithm/key-reference vocabularies are closed and frozen.
5. Commitments hide sensitive payloads while binding to them; disclosure reveals only what the frozen privacy rules permit (PRIV-003).
6. Keys resolve only through `SecretProvider`; no key material is ever committed; secret scan stays clean.
7. PostgreSQL remains authoritative: an attestation can never resurrect revoked, invalidated or superseded authoritative state.
8. Material attestation mutations use the established composite idempotency, concurrency, one-authoritative-transaction, transactional-audit and post-commit publication patterns.
9. Tenant and authorization failures remain fail-closed without existence oracles.
10. AI, if used, is advisory only; it cannot authorize attestations, commitments or verification outcomes.
11. W030+ external settlement adapters and W033+ end-to-end flows remain excluded.
12. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

### Required evidence

AC coverage for EVID-006 + PRIV-003; attestation signing/verification round-trips; tamper detection (mutated payload/key/algorithm fails closed); commitment binding + privacy preservation; tenancy/authorization; idempotency/concurrency/atomicity and fault injection; PostgreSQL-authority containment; targeted mutation checks; `bun run verify`; architecture/authority checks; secret scan; configured PostgreSQL/Redis integration.

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
