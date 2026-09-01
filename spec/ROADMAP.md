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

- **NET-W024 — Consumer Demand Pools** — **COMPLETE**. Privacy-preserving consumer demand aggregation inside `/demand`: tenant-scoped pools, private consented commitments, the frozen disclosure floor, derived qualified-aggregate supplier views (never stored, never caller-asserted); zero economic surface.
- **NET-W025 — Business procurement pools** — **COMPLETE**. Privacy/competition-preserving business demand aggregation inside `/demand`, with dual server-enforced membership, frozen commitment and distinct-organization floors, deterministic qualification, and minimized supplier-facing demand. Merged in PR #51 as `bcaf81b82088688af701f1a90242cc61b1fdd094`.
- **NET-W026 — Supplier offers and competitive selection** — **COMPLETE**. Supplier offers and deterministic competitive selection live inside `/demand`; hard eligibility is server-derived; W025 privacy remains intact; selection is procurement-only and non-economic. Merged in PR #53 as `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`.
- **NET-W027 — Verified savings and counterfactuals** — **CURRENT IMPLEMENTATION TARGET**. Establish evidence-backed baselines, counterfactuals and realized savings with explicit uncertainty, deterministic anchor-aware derivation and fail-closed evidence sufficiency.
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

## W025 implementation contract

### Authority model

```text
business demand commitments (tenant-scoped, buyer-organization-authorized, consented)
        ↓
/demand owns procurement pools + commitments + versioned neutral category/attribute vocabulary
(no second demand/procurement authority — the W024 boundary extended, not duplicated)
        ↓
privacy / competition policy (deterministic derivation, frozen commitment floor
AND frozen distinct-organization floor; bands/buckets/windows only — never exact
quantities, unit prices, budgets or timing)
        ↓
deterministic qualified aggregate (derived, never stored, never caller-asserted)
        ↓
supplier-facing minimized demand view
        ↓
/settlement stays the sole economic authority (zero demand-side economic surface)
```

### W025 outcome

NET-W025 is complete. Its authoritative work order and evidence ledger remain in `spec/work-orders/NET-W025.md` and `docs/net-w025-business-procurement-pools.md`; implementation merged to `main` at `bcaf81b82088688af701f1a90242cc61b1fdd094` after green CI and architect approval.

## W026 implementation contract

### Authority model

```text
NET-W025 qualified business demand
        ↓
supplier offers (tenant/pool scoped, durable, provenance + validity)
        ↓
server-derived hard eligibility
        ↓
deterministic competitive ranking / selection
        ↓
auditable selection result
        ↓
/settlement remains the SOLE economic authority
```

### W026 outcome

NET-W026 is complete. The authoritative work order and evidence ledger remain in `spec/work-orders/NET-W026.md` and `docs/net-w026-supplier-offers-competitive-selection.md`; implementation merged to `main` at `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936` after green CI and architect approval.

## W027 implementation contract

### Authority model

```text
W026 supplier selection / procurement outcome context
                    ↓
           explicit baseline + supported observed/counterfactual inputs
                    ↓
        /evidence + /outcomes remain truth/measurement authorities
                    ↓
        deterministic savings / uncertainty derivation in the
        existing procurement boundary or composition root
                    ↓
        economically-authoritative use only after evidence sufficiency
                    ↓
        /settlement remains the SOLE economic authority
```

### Inputs

- explicit baseline record with method/version, population or comparison window, provenance and evaluation scope;
- authoritative observed outcomes from `/outcomes` and supporting evidence/commitments from `/evidence`;
- explicit counterfactual model/assumptions with version, uncertainty and invalidation/quality status;
- W026 offer/selection context only as lineage/context — offer price alone is never savings truth;
- one explicit evaluation anchor for deterministic derivation;
- server-resolved tenancy/authorization facts.

### Required behavior

1. Baselines are first-class, explicit, versioned/immutable where required, tenant-scoped and provenance-backed.
2. Counterfactuals preserve assumptions, method/version, uncertainty and invalidation semantics; caller arithmetic is never trusted as authoritative truth.
3. Realized savings derive only from supported baseline + authoritative outcome/counterfactual evidence; supplier offer price, spend, reputation or raw activity alone cannot produce a verified savings claim.
4. Uncertainty is first-class and never silently collapsed into a point value. Unsupported exact claims fail closed.
5. Derived savings are deterministic for identical authoritative state and explicit evaluation anchor; canonical digest excludes the anchor.
6. Invalid, stale, missing or insufficient evidence fails closed for economically authoritative use; no evidence downgrade may occur implicitly.
7. Cross-tenant references and unauthorized reads/mutations fail closed without existence oracles.
8. Material baseline/counterfactual/savings mutations use composite idempotency, concurrency serialization, one authoritative transaction and transactional audit publication after commit.
9. `/settlement` remains the only economic authority. W027 creates no ledger, credits, cash, rewards or payment execution state.
10. W028 Benefit Pools remain excluded; W027 does not allocate member benefits or create benefit-pool semantics.
11. AI/model output, if introduced, is advisory only and cannot establish evidence sufficiency, approve a savings claim, release privacy, or authorize economics.
12. Frozen architecture and lock remain unchanged.

### Required evidence

One-to-one AC-01..09 coverage, baseline/counterfactual immutability and provenance tests, uncertainty-preservation tests, deterministic anchor/digest tests, evidence sufficiency/staleness tests, tenancy/authorization regressions, idempotency/concurrency/atomicity tests, economic-containment regressions, targeted mutation checks, architecture/authority checks, secret scan, `bun run verify`, and configured real PostgreSQL/Redis integration.

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
