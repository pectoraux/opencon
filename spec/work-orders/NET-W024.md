# NET-W024 — Consumer Demand Pools

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` MUST remain unchanged)
**Requirements:** DEM-001..003
**Dependencies:** NET-W002, NET-W008 — VERIFIED/MERGED
**Tracking:** GitHub issue #48
**Implementation branch:** `feat/net-w024-consumer-demand-pools`

## §1 Objective

Aggregate privacy-preserving consumer demand commitments into tenant-scoped pools and expose qualified aggregate demand to competing suppliers (DEM-001, DEM-002, DEM-003 bounded to the consumer-demand surface), without exposing unnecessary individual commitments, trusting caller-asserted aggregates, or creating a second economic authority.

Definition of done: `/demand` (the frozen sixteenth-domain boundary NET-W001 established as a skeleton) carries the consumer demand-pool domain — pools, commitments, the versioned provider-neutral category/attribute vocabulary, deterministic privacy-preserving aggregation, and the derived qualification view — while `/settlement` remains the sole economic authority (zero economic mutation surface in `/demand`), `/identity`//`organizations`//`participants` remain the membership/authorization authorities (server-enforced consent and membership), and no W025–W028 semantics leak in.

## §2 Architecture decision of record

```text
consumer demand commitments (explicit consent, server-resolved owner)
        ↓
/demand pools (tenant-scoped, versioned category + qualification policy)
        ↓
deterministic privacy-preserving aggregation engine (pure derivation)
        ↓
qualified aggregate demand view (derived at evaluation time — never stored)
        ↓
bootstrap composition root ONLY (neutral membership lookup over /organizations)
        ↓
zero economic mutation (supplier competition/offers are W025/W026)
```

### Authority rules

- `/demand` owns demand POOL and COMMITMENT records, the closed versioned category/attribute vocabularies, the aggregation/qualification derivation, and the supplier-facing aggregate contract.
- `/settlement` remains the economic authority: NO ledger entries, credits, cash obligations, stakes, rewards or value records are created by demand pools; commitments mint nothing.
- `/identity`, `/organizations`, `/participants` remain the identity/membership/authorization authorities: commitment authorization and pool membership resolve server-side through the NEUTRAL membership lookup (the NET-W002 structural-interface dependency-inversion precedent — wired at the bootstrap root); client claims never fabricate demand membership or qualification.
- `/workflows` remains the sole lifecycle authority and is UNTOUCHED: pools and commitments carry NO lifecycle subject kind and NO transition machinery. Pool closure and commitment withdrawal are ONE-WAY field mutations (the NET-W019 retirement precedent).
- `/evidence`, `/outcomes`, `/reputation`, `/disputes`, `/campaigns`, `/inventory`, `/adapters`: ZERO coupling. No demand surface reads or writes them (reputation/spend/activity cannot influence qualification — invariant 4 of issue #48).
- NO new domain boundary: `/demand` is already one of the sixteen frozen domains (`spec/architecture-lock.md` §2); NET-W024 implements INSIDE it.

## §3 Scope

### §3.1 Neutral vocabulary (core contracts, `src/core/demand.ts`)

A closed, bounded, provider-neutral, versioned vocabulary: demand category keys (8 consumer verticals, category version "1"); commitment attribute vocabulary — region codes (12 neutral macro-regions), monthly quantity (bounded integer 1..10000), budget bands (5 currency-neutral bands); the frozen privacy disclosure floor (a CONSTANT — no pool policy can lower it); consent scope (exactly `aggregate_disclosure`) + consent version; record-format lineage constants (`NET-W024:1`); prose bounds; `InvalidDemandError` (validation) and `DemandCommitmentConflictError` (conflict) per the core error taxonomy. Data + pure validation only — no I/O, no wall clock inside pure helpers.

### §3.2 Records (`/demand` own durable state)

- **DemandPool**: first-class, tenant-scoped, durable: id, organizationScopeId, createdBy (the acting person — there is no ownerPersonId input), bounded name, categoryKey + categoryVersion, qualification policy `{ version, minimumCommitments }` (bounded 1..10000, versioned), one-way `closedAt`/`closureReason` (null while open), record format, idempotency/execution lineage fields. Static after creation except the one-way closure — creator-only, audited.
- **DemandCommitment**: first-class, tenant-scoped, durable: id, organizationScopeId, poolId, consumerPersonId (the acting person — server-resolved; there is no consumerPersonId input), category snapshot, bounded attributes `{ region, quantity, budgetBand? }`, the SERVER-WRITTEN consent grant `{ scope: "aggregate_disclosure", version, grantedAt, grantedBy }` (the input may only name the closed consent scope — any other value fails closed), one-way `withdrawnAt`/`withdrawalReason`, record format, idempotency/execution lineage fields. Static after creation except the one-way withdrawal — consumer-only, audited. ONE ACTIVE (non-withdrawn) commitment per (pool, consumer) — a stable conflict otherwise; withdrawal then re-commitment is a NEW record.

### §3.3 Material mutations (the NET-W003/004/008/019/020 conventions)

Every material command follows: validation (closed vocabularies, bounds, fail-closed) → server-resolved acting person → pre-flight tenant-anchored reads (cross-tenant = NotFoundError, no existence oracle) → membership/owner gates → composite idempotency key (`demand_pool:{org}:{key}`, `demand_pool_close:{org}:{poolId}:{key}`, `demand_commitment:{org}:{poolId}:{consumer}:{key}`, `demand_commitment_withdraw:{org}:{commitmentId}:{key}`) → per-pool advisory lock (`demand_pool_commitment:{org}:{poolId}`) for commitment writes (conservation under concurrency) → `applyIdempotent` on ONE authoritative transaction → IN-TX fresh reads + gate re-derivation (TOCTOU closure) → `...WithinTx` repository writes → transactional audit buffer append (`demand_pool.created`, `demand_pool.closed`, `demand_commitment.recorded`, `demand_commitment.withdrawn` — metadata carries organizationScopeId, pool/commitment identity, category, bounded attributes, idempotencyRecordId, transactionId) → COMMIT. Same-key replay returns the committed record (`created: false`) with NO second audit event. Failed commits leave no partial pool state (buffer discarded on rollback).

### §3.4 Derived aggregate (never stored, never caller-asserted)

`evaluateQualifiedDemand` re-derives from CURRENT durable records on every call: the pool (tenant-anchored), the ACTIVE commitments (withdrawn excluded, deterministically ordered by (createdAt, id)), the requestor's membership (neutral lookup), ONE explicit evaluation anchor (the NET-W021 anchor precedent — no wall clock inside the derivation), then the PURE engine:

- checks (machine-readable, every one re-derived): `pool_open`, `requestor_membership` (active), `commitments_present`, `privacy_floor_met` (activeCount ≥ frozen floor), `qualification_threshold_met` (activeCount ≥ pool policy minimum). `qualified` = every check satisfied.
- aggregate facts (emitted ONLY when the privacy floor is met AND the requestor is an active member): commitmentCount; quantity-bucket distribution (5 fixed buckets); region-group distribution; budget-band distribution; `suppressedGroups` (the COUNT of below-floor non-empty groups — never named). All groups sorted deterministically; below-floor groups are suppressed, never listed.
- deterministic digest: SHA-256 over the canonical (sorted-key) serialization of the aggregate decision facts, EXCLUDING the anchor — identical commitment state yields the identical digest across evaluations; any change to the governing facts changes the digest.
- when the privacy floor is NOT met, the view carries NO aggregate facts and NO commitment count (even the count is suppressed below the floor).
- NO mutation, NO audit event, NO stored result — a derived 200 decision (the W019 readiness / W023 admission precedent).

### §3.5 Composition root and API surface

- Bootstrap wires: authority repositories (PostgresAuthority-backed, append-only collections `demand_pools` / `demand_commitments`), the NEUTRAL `DemandMembershipLookup` (thin read-only adapter over the /organizations membership repository — the NET-W002 pattern), and `createDemandService`. Runtime exposes `demandService`.
- API commands (guard actions seeded as policies): `demand.pools.create` (POST /api/demand/pools → 201), `demand.pools.close` (POST /api/demand/pools/:id/closure → 200), `demand.commitments.create` (POST /api/demand/commitments → 201), `demand.commitments.withdraw` (POST /api/demand/commitments/:id/withdrawal → 200), `demand.aggregates.evaluate` (POST /api/demand/pools/:id/qualified-aggregate → 200 derived decision), `demand.commitments.read` (POST /api/demand/commitments/mine → 200 — the ONLY commitment read surface, actor-scoped server-side: the consumer is the authenticated actor; individual commitments are never exposed through any other route). Public tenant-scoped reads: GET /api/demand/pools/:id and GET /api/demand/pools (pool metadata only — category, policy, creator, timestamps; no commitment data). Status semantics: 201 create / 200 read + derived decision / 400 validation / 403 guard deny / 404 not-found / 409 conflict.
- No secrets, no new configuration, no new external packages.

## §4 Acceptance criteria

### AC-01 — First-class records
Consumer demand pools and commitments are first-class, tenant-scoped, durable records with explicit provenance (execution/correlation/causation lineage) and explicit server-written authorization/consent grants; the closed category/attribute/consent vocabularies are versioned and fail closed on invalid input; the acting person BECOMES the owner (no owner input exists).

### AC-02 — Deterministic qualification
Pool qualification and the aggregate view are deterministically DERIVED from current authoritative records at evaluation time: identical commitment state produces the identical digest across evaluations; commitment order does not affect the derivation; withdrawn commitments are excluded; closed pools fail the `pool_open` check; threshold boundaries behave exactly at threshold−1/threshold; the evaluation anchor is recorded; nothing derived is stored or trusted from storage.

### AC-03 — Privacy-preserving aggregation
Supplier-facing output is aggregate-only: no consumer person ids, no commitment ids, no exact per-person quantities, no per-commitment timestamps in any view; aggregates (including the commitment count) are emitted ONLY above the frozen privacy floor; below-floor distribution groups are suppressed (counted, never named); withdrawn commitments vanish immediately from aggregates; the normal output contract does not permit reconstructing individual commitments; privacy-relevant fields never leak into logs, audit or error payloads beyond approved aggregates.

### AC-04 — Explicit, unassertable thresholds
Qualification policy is explicit and versioned on the pool record; policy bounds are validated fail-closed; the privacy floor is a frozen constant no pool policy can lower or bypass; there is NO command surface input for aggregates, counts or qualification outcomes (extra caller fields are ignored — the evaluation re-derives everything); raw activity, spend, wealth or reputation inputs do not exist anywhere in the qualification path.

### AC-05 — Idempotency, concurrency, conservation
Same-key replays are exactly-once (one record, one audit event); concurrent same-key submissions yield exactly one commitment; concurrent distinct-key submissions all commit and the derived count is conserved; commitment withdrawal is exactly-once and idempotent; ONE active commitment per (pool, consumer) conflicts deterministically (stable conflict error); withdrawal then re-commitment creates a new record; pool creation replays exactly-once.

### AC-06 — Tenancy and authorization fail closed
Cross-tenant pool/commitment/evaluation references resolve as not-found with NO existence oracle (a cross-scope pool is indistinguishable from a nonexistent one); non-members cannot create commitments or pools and receive suppressed (non-member) aggregate views; non-owners cannot withdraw commitments or close pools; unauthorized HTTP calls receive 403; malformed input receives 400; the derived evaluation is a 200 decision.

### AC-07 — Atomicity and audit lineage
Pool/commitment mutations and their audit events commit atomically on ONE authoritative transaction (transactionId + idempotencyRecordId + execution lineage in audit metadata); a failure inside the transaction leaves NO record and NO audit event (buffer discarded on rollback); audit is published only after durable commit; failed commits leave no partial pool state.

### AC-08 — Architecture / out-of-scope regression
The architecture + authority guards pass with all NET-W024 files; frozen `spec/architecture.md` / `spec/architecture-lock.md` remain unchanged (no 17th domain; `/demand` remains the frozen sixteenth home); the work order binds to issue #48 and DEM-001..003; the demand vocabularies are pinned exactly and prior frozen vocabularies are unchanged; `/demand` contains NO economic-authority vocabulary (issueCredits / matureEconomicValue / allocateRewards / recordCashObligation / reputation / risk / workflow-transition machinery) and NO domain imports outside itself; the composition-root wiring is pinned; the NET-W024 file list exists; no secrets are committed.

## §5 Required implementation evidence

Test suites in `tests/demand/` (one-to-one with AC-01..07, names `net-w024-ac-0N-*.test.ts`) plus `tests/regression/net-w024-ac-08-architecture-out-of-scope.test.ts`, built on a shared harness `tests/demand/_net-w024-harness.ts` that wraps the NET-W008 harness (runtime + two persons + organization + seeded demand guard actions + granted memberships). Required test classes: records/provenance/consent; deterministic derivation (digest stability, order independence, threshold boundaries, exclusion semantics); privacy (identifier suppression, floor suppression, group suppression, reconstruction resistance, leak scans over views/logs/audit/errors); threshold explicitness and caller-assertion impossibility; idempotency + 4-way concurrency + conservation; tenancy fail-closed + no existence oracle + HTTP status semantics; atomicity + rollback + audit lineage; economic-bypass and vocabulary containment regressions; the `ac-08-no-premature-domain-logic` skeleton activation for `/demand`.

Mutation checks (targeted, cp-backup + assert-applied + assert-failed + restore + assert-green; driver scripts in /tmp, never committed): (1) privacy-floor removal (aggregates emitted regardless) — CAUGHT by AC-03; (2) below-floor group naming (suppression removed) — CAUGHT by AC-03; (3) consent/membership gate removal — CAUGHT by AC-06; (4) threshold re-derivation removal (qualification always true) — CAUGHT by AC-02/04; (5) tenant-scope check removal (cross-tenant readable) — CAUGHT by AC-06; (6) idempotency key randomization — CAUGHT by AC-05.

Required completion artifacts: `spec/work-orders/NET-W024.md` (this document) and `docs/net-w024-consumer-demand-pools.md` (the evidence ledger).

## §6 Verification gate

```text
implementation complete
+ AC-01..08 suites green
+ mutation checks 6/6 CAUGHT
+ bun run verify (typecheck + arch:check + authority:check + full test suite)
+ configured real PostgreSQL/Redis integration (the CI integration job)
+ exactly one implementation PR (Closes #48)
+ architect review
→ merge
```

Do not merge on green CI alone. Do not merge without recorded architect approval.

## §7 Explicit non-goals

No business procurement pools (NET-W025); no supplier offers, competitive selection or supplier-facing commands (NET-W026); no verified savings, counterfactual baselines or outcome evidence (NET-W027); no Benefit Pools or benefit allocation (NET-W028); no economic ledger, credit, cash, stake, reward or value surface of ANY kind in `/demand`; no reputation, risk, evidence or measurement coupling; no AI/model path; no external payment execution; no decentralized consensus; no new domain boundary; no new architecture version; no changes to frozen spec files; no provider-specific vocabulary in `/demand` (categories/attributes are provider-neutral); no individual-commitment exposure on any supplier-facing route.
