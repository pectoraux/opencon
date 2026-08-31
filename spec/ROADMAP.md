# OpenCon Persistent Roadmap

**Architecture:** Open Contribution Protocol Architecture v1.0
**Status:** Frozen architecture / approved requirements; implementation progressing by sequential NET-W work items
**Canonical backlog:** `spec/work-items.md`
**Canonical dependency graph:** `spec/dependency-graph.md`
**Canonical frozen constraints:** `spec/architecture.md`, `spec/architecture-lock.md`
**Operational state:** `spec/PROJECT-STATE.md`

## Purpose

This document is the durable roadmap for the implementation program. It is intentionally repository-local so a new LLM architect can resume the project without access to previous conversation history.

The roadmap describes what each work item is intended to accomplish, its dependencies, its authority boundary, and the non-drift rule that applies to it. Exact acceptance criteria remain in the corresponding work item/work order and evidence artifacts.

## Program invariant

OpenCon is built as one protocol with explicit authorities. Do not solve a new problem by creating a second authority for something an existing boundary already owns.

The v1.0 frozen architecture has sixteen domain boundaries. A new seventeenth domain requires an explicit Architecture Change Request and a new architecture version.

### Authority map

| Responsibility | Authoritative boundary |
|---|---|
| identity / organizations / participants | `/identity`, `/organizations`, `/participants` |
| opportunities / contributions | `/opportunities`, `/contributions` |
| lifecycle state | `/workflows` |
| evidence / commitments / Proof-of-Value | `/evidence` |
| normalized outcomes / measurement semantics | `/outcomes` |
| reputation | `/reputation` |
| economic ledger / value / credits / cash / settlement | `/settlement` |
| risk / controls / disputes | `/disputes` |
| campaign policy | `/campaigns` |
| creator identity / preferences / matching / creator records | `/creators` |
| inventory / placements | `/inventory` |
| provider-specific integrations | `/adapters` |
| LLM / provider-neutral AI boundary | `/llm` |
| agents / orchestration mechanisms | `/agents` |
| API / workers / persistence / audit / config / observability | infrastructure boundaries |

Composition-root orchestration is allowed, but an orchestration function must not become a hidden second authority.

## Development state

### Phase 1 — Foundation

- **NET-W001 — Platform and modular-monolith foundation** — **COMPLETE**.
- **NET-W002 — Identity, organizations and participant model** — **COMPLETE**.
- **NET-W003 — Persistence, queues, objects, secrets and observability** — **COMPLETE**.

### Phase 2 — Protocol core

- **NET-W004 — Opportunity and contribution lifecycle** — **COMPLETE**.
- **NET-W005 — Evidence and Proof-of-Value** — **COMPLETE**.
- **NET-W006 — Outcomes and measurement abstraction** — **COMPLETE**.
- **NET-W007 — Reputation engine** — **COMPLETE**.
- **NET-W008 — Participation Credits and economic ledger** — **COMPLETE**.

### Phase 3 — Trust

- **NET-W009 — Fraud and risk engine** — **COMPLETE**.
- **NET-W010 — Stake, challenges and disputes** — **COMPLETE**.

### Phase 4 — Farmable contribution market

- **NET-W011 — Campaign domain** — **COMPLETE**.
- **NET-W012 — Helpful contributions** — **COMPLETE**.
- **NET-W013 — Quality, moderation and anti-spam controls** — **COMPLETE**.
- **NET-W014 — Reward and settlement integration** — **COMPLETE**.

### Phase 5 — Creator network

- **NET-W015 — Creator identity and preferences** — **COMPLETE**.
- **NET-W016 — Creator matching** — **COMPLETE**.
- **NET-W017 — UGC workflow and rights** — **COMPLETE**.
- **NET-W018 — Sponsorship and disclosure** — **COMPLETE**.

### Phase 6 — Advertising network

- **NET-W019 — Inventory and placements** — **COMPLETE**. Supply registration, ownership, placement context, provenance and derived settlement-readiness established.
- **NET-W020 — Cross-promotion and clearing** — **COMPLETE**. Clearing orchestration established inside `/settlement`; the economic draw, clearing record, campaign bookkeeping and audit lineage share one authoritative transaction.
- **NET-W021 — Campaign matching and optimization** — **COMPLETE**. Matching remains selection-not-authority; hard eligibility precedes deterministic ranking and bounded AI advisory.
- **NET-W022 — Attribution and privacy measurement adapters** — **COMPLETE**. Browser/platform and iOS attribution facts normalize through `/measurement`; `/outcomes` remains measurement authority; provider secrets/raw payloads remain isolated.
- **NET-W023 — OpenRTB and supply-chain adapters** — **COMPLETE**. All provider-specific OpenRTB/ads.txt/app-ads.txt/sellers.json/schain parsing lives in `/adapters`; supply-chain `verified` requires authenticated (HMAC trust channel via `SecretProvider`) + fresh + consistent evidence; the delivery-notice material path reuses the W022 measurement ingestion composite.

### Phase 7 — Demand economy

- **NET-W024 — Consumer Demand Pools** — **CURRENT IMPLEMENTATION TARGET**. Aggregate privacy-preserving consumer demand commitments and expose qualified aggregate demand to competing suppliers without exposing individual commitments or creating a parallel economic authority.
- **NET-W025 — Business procurement pools** — **PLANNED**.
- **NET-W026 — Supplier offers and competitive selection** — **PLANNED**.
- **NET-W027 — Verified savings and counterfactuals** — **PLANNED**.
- **NET-W028 — Benefit Pools** — **PLANNED**.

### Phase 8 — Decentralization

- **NET-W029 — Cryptographic attestations and commitments** — **PLANNED**.
- **NET-W030 — External settlement adapters** — **PLANNED**.
- **NET-W031 — Portable reputation proofs** — **PLANNED**.
- **NET-W032 — Decentralized validation/dispute layer** — **PLANNED**.

### Phase 9 — End-to-end proof

- **NET-W033 — Complete contribution lifecycle** — **PLANNED**.
- **NET-W034 — Complete advertising lifecycle** — **PLANNED**.
- **NET-W035 — Complete creator lifecycle** — **PLANNED**.
- **NET-W036 — Complete demand/procurement/benefit lifecycle** — **PLANNED**.

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

The precise dependency and readiness rules remain authoritative in `spec/dependency-graph.md` and `spec/work-items.md`.

## W024 implementation contract

### Authority model

```text
consumer demand commitments (tenant-scoped, consented)
        ↓
/demand owns pools + commitments + versioned neutral category/attribute vocabulary
        ↓
privacy-preserving aggregation (deterministic derivation, frozen privacy floor)
        ↓
qualified aggregate demand views (derived, never stored, never caller-asserted)
        ↓
composition root ONLY (neutral membership reads over /organizations)
        ↓
/settlement stays the sole economic authority (zero demand-side economic surface)
```

### Inputs

- consumer demand commitments: bounded provider-neutral category + attribute vocabulary (region, quantity, budget band) with explicit consent;
- tenant-scoped pool records with explicit, versioned qualification policy;
- organization membership facts resolved read-only through the neutral lookup (server-enforced authorization/consent);
- existing identity/participant contracts through neutral reads only;
- nothing else: no activity, spend, wealth, reputation or economic-source assertion may influence qualification.

### Required behavior

1. Pools and commitments are first-class, tenant-scoped, durable records with explicit provenance and server-written consent grants.
2. Pool membership requires server-side authorization (guard policy + active organization membership) and correct tenant scope; client claims never fabricate either.
3. Aggregate demand is derived from authoritative commitment records at evaluation time; no caller-provided aggregate is trusted; nothing aggregate is stored as asserted truth.
4. Individual commitments are private: supplier-facing outputs are counts/ranges/bounded distributions only, emitted only above the frozen privacy floor, with below-floor groups suppressed (never named).
5. Qualification is deterministic and reproducible: one explicit evaluation anchor, canonical digest over the aggregate facts, fixed orderings.
6. Threshold policy is explicit and versioned and cannot be caller-asserted at evaluation; the privacy floor is a frozen constant no policy can lower.
7. Pool closure and commitment withdrawal are one-way field mutations (no local status machinery; `/workflows` untouched).
8. Cross-tenant references fail closed as not-found with no existence oracle.
9. Material mutations are idempotent (composite keys), concurrency-safe (per-pool locking), and atomically audited on ONE authoritative transaction; failed commits leave no partial pool state.
10. No economic mutation surface exists in `/demand`: no ledger, credits, cash, stakes, rewards; no new domain boundary; no procurement/supplier-offer/selection/savings/benefit semantics (W025–W028).

### Evidence gate

W024 is mergeable only after implementation, acceptance coverage (privacy, authorization, aggregation, tenancy, idempotency, concurrency, atomicity), mutation checks for privacy/minimization, consent/authorization and threshold bypasses, `bun run verify`, configured real PostgreSQL/Redis integration, exactly one implementation PR, and architect approval are all complete.

## Work-item operating procedure

1. Confirm GitHub issue/readiness and dependencies.
2. Read the issue and this roadmap plus `spec/PROJECT-STATE.md`.
3. Create/update `spec/work-orders/NET-WXXX.md` as the decision record.
4. Inspect relevant authorities/tests before coding.
5. Prefer existing ports and `...WithinTx` primitives.
6. Implement one-to-one acceptance tests plus architecture/out-of-scope regressions.
7. Run the complete quality gate and configured real-provider integrations.
8. Perform targeted mutation checks for highest-risk invariants.
9. Create exactly one implementation PR.
10. Wait for architect review; remediate on the same PR if required.
11. On approval and green verification, merge and update `spec/PROJECT-STATE.md` before advancing.

## Merge policy

```text
implementation complete
+ verification/CI green
+ architect approval
→ merge
```

No chat message can override this gate.
