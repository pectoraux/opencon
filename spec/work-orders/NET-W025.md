# NET-W025 — Business procurement pools

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` MUST remain unchanged)
**Requirements:** DEM-001..003, PROC-001..003
**Dependencies:** NET-W024, NET-W008 — VERIFIED/MERGED
**Tracking:** GitHub issue #50
**Implementation branch:** `feat/net-w025-business-procurement-pools`

## §1 Objective

Aggregate business procurement demand while minimizing disclosure of competitively sensitive information (DEM-001 bounded to business demand, DEM-002 privacy-preserving aggregation, PROC-003 prevention of unlawful exchange of commercially sensitive competitor information; PROC-001 bounded to the demand → qualification → supplier-discovery surface — offers, selection, fulfillment and savings verification are NET-W026/W027), without creating a second demand/procurement authority, a parallel economic authority, or a supplier-selection authority.

Definition of done: `/demand` (the SAME frozen boundary NET-W024 activated) additionally carries the business procurement-pool domain — procurement pools, private business commitments with explicit buyer-organization/actor authorization, the versioned provider-neutral procurement category/attribute vocabulary, competition-policy-governed deterministic aggregation with the frozen commitment floor AND the frozen distinct-organization floor, and the derived supplier-facing minimized demand view — while `/settlement` remains the sole economic authority (zero economic mutation surface in `/demand`), `/identity`//`organizations`//`participants` remain the membership/authorization authorities, and no W026–W028 semantics leak in.

## §2 Architecture decision of record

```text
business demand (tenant-scoped; acting person authorized by BOTH the
tenant organization AND the named buyer organization — server-resolved)
        ↓
/demand procurement pools (tenant-scoped, versioned procurement category +
qualification/competition policy) — the SAME frozen boundary, NOT a 17th domain
        ↓
private business commitments (bounded provider-neutral attributes;
server-written aggregate_disclosure consent; one-way withdrawal)
        ↓
deterministic privacy/competition-policy aggregation engine (pure derivation;
frozen commitment floor AND frozen distinct-organization floor;
bands/buckets/windows only — never exact quantities, prices, budgets, timing)
        ↓
supplier-facing minimized demand view (derived at evaluation time —
never stored, never caller-asserted)
        ↓
bootstrap composition root ONLY (neutral membership lookup over /organizations)
        ↓
zero economic mutation (supplier offers/selection are W026; savings are W027)
```

### Authority rules

- `/demand` owns the procurement POOL and business COMMITMENT records, the closed versioned procurement category/attribute vocabulary, the privacy/competition-policy aggregation and qualification derivation, and the supplier-facing minimized demand contract. There is NO second demand or procurement authority (issue #50: `/demand` remains the demand/aggregate semantic authority established by NET-W024; a second domain would require an explicit Architecture Change Request).
- `/settlement` remains the economic authority: NO ledger entries, credits, cash obligations, stakes, rewards or value records are created by procurement pools; business commitments mint nothing and create no balances.
- `/identity`, `/organizations`, `/participants` remain the identity/membership/authorization authorities: the acting person must hold ACTIVE membership in the tenant organization AND in the named buyer organization, resolved server-side through the NEUTRAL membership lookup (the NET-W002 structural-interface dependency-inversion precedent — wired at the bootstrap root); client claims never fabricate buyer eligibility, membership or qualification.
- `/workflows` remains the sole lifecycle authority and is UNTOUCHED: procurement pools and commitments carry NO lifecycle subject kind and NO transition machinery. Pool closure and commitment withdrawal are ONE-WAY field mutations (the NET-W019/W024 retirement precedent).
- `/evidence`, `/outcomes`, `/reputation`, `/disputes`, `/campaigns`, `/inventory`, `/adapters`: ZERO coupling. No procurement surface reads or writes them (reputation/spend/activity cannot influence qualification — issue #50 invariant).
- NO AI path exists anywhere in this surface; if one is ever introduced it is advisory only and can never authorize membership, privacy release, qualification, supplier selection or economic mutation.

## §3 Scope

### §3.1 Neutral vocabulary (core contracts, `src/core/procurement.ts`)

A closed, bounded, provider-neutral, versioned vocabulary: procurement category keys (8 business verticals, category version "1"); commitment attribute vocabulary — region codes (the 12 neutral macro-regions REUSED from `src/core/demand.ts`), committed quantity (bounded integer 1..1000000 mapped to 5 fixed business-scale buckets), budget bands (5 business-scale currency-neutral bands), unit-price bands (5 currency-neutral bands — prices cross ONLY as bands, never exact values), delivery-timing windows (5 coarse windows); TWO frozen floors — the commitment disclosure floor AND the distinct-organization disclosure floor (CONSTANTS — no pool policy or caller input can lower either); consent scope (exactly `aggregate_disclosure`) + consent version; record-format lineage constants (`NET-W025:1`); prose bounds; `InvalidProcurementError` (validation) and `ProcurementCommitmentConflictError` (conflict) per the core error taxonomy. Data + pure validation only — no I/O, no wall clock inside pure helpers.

### §3.2 Records (`/demand` own durable state)

- **ProcurementPool**: first-class, tenant-scoped, durable: id, organizationScopeId, createdBy (the acting person — there is no creatorPersonId input), bounded name, procurement categoryKey + categoryVersion, qualification/competition policy `{ version, minimumCommitments, minimumOrganizations }` (each bounded 1..10000, versioned — the distinct-organization threshold is the competition-policy dimension), one-way `closedAt`/`closureReason` (null while open), record format, idempotency/execution lineage fields. Static after creation except the one-way closure — creator-only, audited.
- **ProcurementCommitment**: first-class, tenant-scoped, durable: id, organizationScopeId, poolId, `buyerOrganizationId` (the organization on whose behalf the demand is committed — the acting person must hold ACTIVE membership there, server-resolved), `submittedBy` (the acting person — there is no submittedBy input), category snapshot, bounded attributes `{ region, quantity, budgetBand?, unitPriceBand?, timingWindow? }`, the SERVER-WRITTEN consent grant `{ scope: "aggregate_disclosure", version, grantedAt, grantedBy }` (the input may only name the closed consent scope — any other value fails closed), one-way `withdrawnAt`/`withdrawalReason`, record format, idempotency/execution lineage fields. Static after creation except the one-way withdrawal — submitter-only, audited. ONE ACTIVE (non-withdrawn) commitment per (pool, buyerOrganizationId) — a stable conflict otherwise; withdrawal then re-commitment is a NEW record.

### §3.3 Material mutations (the NET-W003/004/008/019/020/024 conventions)

Every material command follows: validation (closed vocabularies, bounds, fail-closed) → server-resolved acting person → pre-flight tenant-anchored reads (cross-tenant = NotFoundError, no existence oracle) → membership gates (tenant membership for pools; tenant + buyer-organization membership for commitments — the buyer-org failure is indistinguishable from a nonexistent organization) → owner gates (creator-only closure, submitter-only withdrawal) → composite idempotency key (`procurement_pool:{org}:{key}`, `procurement_pool_close:{org}:{poolId}:{key}`, `procurement_commitment:{org}:{poolId}:{buyerOrg}:{key}`, `procurement_commitment_withdraw:{org}:{commitmentId}:{key}`) → per-pool advisory lock (`procurement_pool_commitment:{org}:{poolId}`) for commitment writes (conservation under concurrency) → `applyIdempotent` on ONE authoritative transaction → IN-TX fresh reads + gate re-derivation (TOCTOU closure) → `...WithinTx` repository writes → transactional audit buffer append (`procurement_pool.created`, `procurement_pool.closed`, `procurement_commitment.recorded`, `procurement_commitment.withdrawn` — metadata carries organizationScopeId, pool/commitment identity, buyer organization, category, bounded attributes, idempotencyRecordId, transactionId) → COMMIT. Same-key replay returns the committed record (`created: false`) with NO second audit event. Failed commits leave no partial procurement-pool state (buffer discarded on rollback).

### §3.4 Derived aggregate (never stored, never caller-asserted)

`evaluateQualifiedProcurementDemand` re-derives from CURRENT durable records on every call: the pool (tenant-anchored), the ACTIVE commitments (withdrawn excluded, consent re-checked, deterministically ordered by (createdAt, id)), the requestor's membership (neutral lookup), ONE explicit evaluation anchor (the NET-W021/W024 anchor precedent — no wall clock inside the derivation), then the PURE engine:

- checks (machine-readable, every one re-derived): `pool_open`, `requestor_membership` (active), `commitments_present`, `privacy_floor_met` (activeCount ≥ frozen commitment floor), `organization_floor_met` (distinct buyer organizations ≥ frozen organization floor), `qualification_thresholds_met` (activeCount ≥ pool policy minimumCommitments AND distinctOrgs ≥ pool policy minimumOrganizations). `qualified` = every check satisfied.
- aggregate facts (emitted ONLY when the commitment floor AND the organization floor are met AND the requestor is an active member): commitmentCount; organizationCount (the DISTINCT buyer-organization count — the only organization datum that ever crosses, itself floor-gated); quantity-bucket distribution (5 fixed buckets); region-group distribution; budget-band distribution; unit-price-band distribution; timing-window distribution; `suppressedGroups` (the COUNT of below-floor non-empty groups — never named). All groups sorted deterministically; below-floor groups are suppressed, never listed.
- deterministic digest: SHA-256 over the canonical (sorted-key) serialization of the aggregate decision facts, EXCLUDING the anchor — identical commitment state yields the identical digest across evaluations; any change to the governing facts changes the digest.
- when either floor is NOT met, the view carries NO aggregate facts and NO commitment/organization counts (even the counts are suppressed below the floors).
- NO mutation, NO audit event, NO stored result — a derived 200 decision.

### §3.5 Composition root and API surface

- Bootstrap wires: authority repositories (PostgresAuthority-backed, append-only collections `procurement_pools` / `procurement_commitments`), the SAME neutral membership lookup (reused over the /organizations membership repository — the W002/W024 pattern), and `createProcurementService` (the /demand procurement-pool service). Runtime exposes `procurementService`.
- API commands (guard actions seeded as policies): `demand.procurement.pools.create` (POST /api/demand/procurement/pools → 201), `demand.procurement.pools.close` (POST /api/demand/procurement/pools/:id/closure → 200), `demand.procurement.commitments.create` (POST /api/demand/procurement/commitments → 201), `demand.procurement.commitments.withdraw` (POST /api/demand/procurement/commitments/:id/withdrawal → 200), `demand.procurement.aggregates.evaluate` (POST /api/demand/procurement/pools/:id/qualified-aggregate → 200 derived decision), `demand.procurement.commitments.read` (POST /api/demand/procurement/commitments/mine → 200 — the ONLY commitment read surface, actor-scoped server-side: the submitter is the authenticated actor; individual business commitments are never exposed through any other route). Public tenant-scoped reads: GET /api/demand/procurement/pools/:id and GET /api/demand/procurement/pools (pool metadata only — category, policy, creator, timestamps; no commitment data). Status semantics: 201 create / 200 read + derived decision / 400 validation / 403 guard deny / 404 not-found / 409 conflict.
- No secrets, no new configuration, no new external packages.

## §4 Acceptance criteria

### AC-01 — First-class records

Business procurement pools and commitments are first-class, tenant-scoped, durable records with explicit provenance (execution/correlation/causation lineage), explicit buyer-organization references and server-written authorization/consent grants; the closed procurement category/attribute/consent vocabularies are versioned and fail closed on invalid input; the acting person BECOMES the owner (no owner input exists).

### AC-02 — Deterministic qualification

Procurement-pool qualification and the aggregate view are deterministically DERIVED from current authoritative records at evaluation time: identical commitment state produces the identical digest across evaluations; commitment order does not affect the derivation; withdrawn commitments are excluded; closed pools fail the `pool_open` check; threshold boundaries behave exactly at threshold−1/threshold on BOTH the commitment and the distinct-organization thresholds; the evaluation anchor is recorded; nothing derived is stored or trusted from storage.

### AC-03 — Privacy/competition-preserving aggregation

Supplier-facing output is aggregate-only: no person ids, no commitment ids, no buyer-organization ids, no exact per-organization quantities, unit prices, budgets or timing in any view; aggregates (including the commitment count and the organization count) are emitted ONLY above the frozen commitment floor AND the frozen organization floor; below-floor distribution groups are suppressed (counted, never named); withdrawn commitments vanish immediately from aggregates; the normal output contract does not permit reconstructing individual commitments or attributing any fact to a single organization; privacy-relevant fields never leak into logs, audit or error payloads beyond approved aggregates.

### AC-04 — Explicit, unassertable thresholds and floors

Qualification/competition policy is explicit and versioned on the pool record (both thresholds); policy bounds are validated fail-closed; both floors are frozen constants no pool policy can lower or bypass; there is NO command surface input for aggregates, counts or qualification outcomes (extra caller fields are ignored — the evaluation re-derives everything); raw activity, spend, wealth or reputation inputs do not exist anywhere in the qualification path.

### AC-05 — Idempotency, concurrency, conservation

Same-key replays are exactly-once (one record, one audit event); concurrent same-key submissions yield exactly one commitment; concurrent distinct-key submissions all commit and the derived count is conserved; commitment withdrawal is exactly-once and idempotent; ONE active commitment per (pool, buyer organization) conflicts deterministically (stable conflict error); withdrawal then re-commitment creates a new record; pool creation replays exactly-once.

### AC-06 — Tenancy and authorization fail closed

Cross-tenant pool/commitment/evaluation references resolve as not-found with NO existence oracle (a cross-scope pool is indistinguishable from a nonexistent one); actors who are not members of the tenant cannot create commitments or pools; actors who are not members of the named buyer organization cannot commit on its behalf (and that failure is indistinguishable from a nonexistent organization); non-submitters cannot withdraw commitments and non-creators cannot close pools; non-members receive suppressed (non-member) aggregate views; unauthorized HTTP calls receive 403; malformed input receives 400; the derived evaluation is a 200 decision.

### AC-07 — Atomicity and audit lineage

Procurement-pool/commitment mutations and their audit events commit atomically on ONE authoritative transaction (transactionId + idempotencyRecordId + execution lineage in audit metadata); a failure inside the transaction leaves NO record and NO audit event (buffer discarded on rollback); audit is published only after durable commit; failed commits leave no partial procurement-pool state.

### AC-08 — Architecture / out-of-scope regression

The architecture + authority guards pass with all NET-W025 files; frozen `spec/architecture.md` / `spec/architecture-lock.md` remain unchanged (no 17th domain; `/demand` remains the frozen home of BOTH consumer demand pools and business procurement pools); the work order binds to issue #50 and DEM-001..003 + PROC-001..003; the procurement vocabularies are pinned exactly and prior frozen vocabularies (including the W024 demand vocabularies) are unchanged; `/demand` contains NO economic-authority vocabulary (issueCredits / matureEconomicValue / allocateRewards / recordCashObligation / reputation / risk / workflow-transition machinery), NO supplier-offer/selection vocabulary (W026), NO savings/counterfactual vocabulary (W027) and NO Benefit-Pool vocabulary (W028), and no domain imports outside itself/core; the composition-root wiring is pinned; the NET-W025 file list exists; no secrets are committed; no new configuration.

## §5 Required implementation evidence

Test suites in `tests/demand/` (one-to-one with AC-01..07, names `net-w025-ac-0N-*.test.ts`) plus `tests/regression/net-w025-ac-08-architecture-out-of-scope.test.ts`, built on a shared harness `tests/demand/_net-w025-harness.ts` that wraps the NET-W024 harness (runtime + persons + organization + seeded procurement guard actions + granted tenant and buyer-organization memberships across at least three buyer organizations). Required test classes: records/provenance/consent/buyer-organization authorization; deterministic derivation (digest stability, order independence, dual threshold boundaries, exclusion semantics); privacy/competition (identifier + organization suppression, dual-floor suppression, group suppression, reconstruction resistance, competitor-term leak scans over views/logs/audit/errors); threshold/floor explicitness and caller-assertion impossibility; idempotency + 4-way concurrency + conservation; tenancy fail-closed + dual-membership fail-closed + no existence oracle + HTTP status semantics; atomicity + rollback + audit lineage; economic-bypass and vocabulary containment regressions; the `ac-08-no-premature-domain-logic` amendment recording that `/demand` now also carries NET-W025 (the module description + comment update).

Mutation checks (targeted, cp-backup + assert-applied + assert-failed + restore + assert-green; driver scripts in /tmp, never committed): (1) organization-floor removal (aggregates emitted regardless of distinct organizations) — CAUGHT by AC-03/04; (2) commitment-floor removal — CAUGHT by AC-03; (3) below-floor group naming (suppression removed) — CAUGHT by AC-03; (4) buyer-organization membership gate removal — CAUGHT by AC-06; (5) tenant-scope check removal (cross-tenant readable) — CAUGHT by AC-06; (6) idempotency key randomization — CAUGHT by AC-05.

Required completion artifacts: `spec/work-orders/NET-W025.md` (this document) and `docs/net-w025-business-procurement-pools.md` (the evidence ledger).

## §6 Verification gate

```text
implementation complete
+ AC-01..08 suites green
+ mutation checks 6/6 CAUGHT
+ bun run verify (typecheck + arch:check + authority:check + full test suite)
+ configured real PostgreSQL/Redis integration (the CI integration job)
+ exactly one implementation PR (Closes #50)
+ architect review
→ merge
```

Do not merge on green CI alone. Do not merge without recorded architect approval.

## §7 Explicit non-goals

No supplier offers, competitive selection, supplier-facing commands or selection criteria (NET-W026); no verified savings, counterfactual baselines or outcome evidence (NET-W027); no Benefit Pools or benefit allocation (NET-W028); no economic ledger, credit, cash, stake, reward or value surface of ANY kind in `/demand`; no second demand or procurement domain/ledger/authority (issue #50 forbids it absent an Architecture Change Request); no reputation, risk, evidence or measurement coupling; no AI/model path; no external payment execution; no decentralized consensus; no new architecture version; no changes to frozen spec files; no provider-specific vocabulary in `/demand` (procurement categories/attributes are provider-neutral); no individual-commitment or buyer-organization exposure on any supplier-facing route; no exact quantity, unit-price, budget or timing disclosure through any normal aggregate view.
