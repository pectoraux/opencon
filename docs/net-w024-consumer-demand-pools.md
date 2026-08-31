# NET-W024 — Consumer Demand Pools

**Status:** IMPLEMENTED on `feat/net-w024-consumer-demand-pools` — full local gate green; PR submitted for architect review
**GitHub issue:** #48
**Work order:** `spec/work-orders/NET-W024.md`
**Architecture:** v1.0 FROZEN
**Dependencies:** NET-W002 + NET-W008 merged

## Purpose

This document is the durable evidence ledger for NET-W024. It allows an architect or reviewer with no conversation history to verify — from the repository alone — that consumer demand pools are implemented inside the frozen `/demand` boundary with privacy-preserving aggregation, server-enforced consent/authorization, deterministic qualification, tenant isolation, idempotency/concurrency/atomicity conventions, and zero economic-authority surface.

## Architectural decision record

NET-W024 introduces NO second authority. The authority split of record:

- **`/demand` owns** the demand POOL records (tenant-scoped, versioned category + qualification policy, one-way closure), the private consumer COMMITMENT records (bounded provider-neutral attributes + server-written `aggregate_disclosure` consent grants + one-way withdrawal), the closed versioned vocabularies (`src/core/demand.ts`), the pure privacy-preserving aggregation engine, and the derived qualified-aggregate contract.
- **`/settlement` stays the sole economic authority**: there is NO economic mutation surface in `/demand` (no ledger, credits, cash, stakes, rewards, value records). Commitments mint nothing; supplier competition on the aggregate is NET-W025/W026.
- **`/identity`, `/organizations`, `/participants` stay the membership/authorization authorities**: commitment/pool authorization resolves server-side through the NEUTRAL `DemandMembershipLookup` (a thin read-only adapter over the /organizations membership repository, wired at the bootstrap root — the W002 structural-lookup precedent). Client claims never fabricate demand membership or qualification.
- **`/workflows` is untouched**: pools and commitments carry NO lifecycle subject kind; closure and withdrawal are ONE-WAY field mutations (the W019 retirement precedent).
- **No coupling** to `/evidence`, `/outcomes`, `/reputation`, `/disputes`, `/campaigns`, `/inventory`, `/adapters`: qualification cannot be influenced by activity, spend, wealth or reputation — no such input exists.

## Implementation shape (the decision of record, as shipped)

1. **Neutral vocabulary** — `src/core/demand.ts` (core tier, NEW): `DEMAND_CATEGORY_KEYS` (8 provider-neutral consumer verticals, `DEMAND_CATEGORY_VERSION "1"`); `DEMAND_REGION_CODES` (12 neutral macro-regions); `DEMAND_BUDGET_BANDS` (5 currency-neutral bands); quantity bounds 1..10000 + `DEMAND_QUANTITY_BUCKETS` (5 fixed buckets) + `demandQuantityBucket`; **`DEMAND_PRIVACY_MINIMUM_COMMITMENTS = 3` (the frozen disclosure floor — no policy or caller can lower it)**; `DEMAND_CONSENT_SCOPE "aggregate_disclosure"` + `DEMAND_CONSENT_VERSION`; policy bounds; prose bounds; record formats `NET-W024:1`; `InvalidDemandError` (DEMAND_VALIDATION/validation) + `DemandCommitmentConflictError` (DEMAND_COMMITMENT_CONFLICT/conflict); pure validators (`validateDemandAttributes`, `validateDemandPoolName`, `validateQualificationPolicy`). Data + pure validation only.
2. **Port** — `src/demand/port.ts` (domain tier, REWRITTEN from the W001 skeleton): records (`DemandPool`, `DemandCommitment`, `DemandConsentGrant`), inputs/results, derived view types (`QualifiedDemandAggregate`, `DemandAggregateFacts`, `DemandAggregateCheck`, `DemandDistributionGroup`), the neutral `DemandMembershipLookup`, repository interfaces with `...WithinTx` twins, `DemandService` + deps, `DemandPort` readiness "ready" + the closed audit-event vocabulary. Contracts only (no function bodies — the port pin).
3. **Authority repositories** — `src/demand/authority-demand-repositories.ts` (NEW): PostgresAuthority-backed append-only collections `demand_pools` / `demand_commitments`; one-way `closeWithinTx` / `withdrawWithinTx`; `findActiveByPoolAndConsumerWithinTx` (the create-once constraint); `listActiveByPool` (the derivation input); deterministic (createdAt, id) ordering.
4. **The pure aggregation engine** — `src/demand/aggregation-engine.ts` (NEW): `deriveQualifiedDemandAggregate` (no I/O, no wall clock — the anchor arrives as an argument) emits the five re-derived checks (`pool_open`, `requestor_membership`, `commitments_present`, `privacy_floor_met`, `qualification_threshold_met`), the minimized aggregate facts (count + quantity buckets + region groups + budget-band groups + `suppressedGroups` — counts/ranges only), group suppression at the frozen floor (below-floor groups counted, NEVER named), aggregate emission gated on (floor met AND requestor an active member), the deterministic SHA-256 digest over the canonical sorted-key decision facts (anchor EXCLUDED — identical state ⇒ identical digest), and `hasValidAggregateConsent`. Counts in check details are disclosed only under the same gate as the aggregate facts.
5. **The domain service** — `src/demand/demand-service.ts` (NEW): material commands (pool create/close, commitment create/withdraw) follow the full convention set — validation → server-resolved acting person → TENANT ANCHOR FIRST (cross-tenant = NotFoundError, no existence oracle) → membership/owner gates → composite idempotency keys (`demand_pool:{org}:{key}`, `demand_pool_close:{org}:{poolId}:{key}`, `demand_commitment:{org}:{poolId}:{consumer}:{key}`, `demand_commitment_withdraw:{org}:{commitmentId}:{key}`) → per-pool advisory lock `demand_pool_commitment:{org}:{poolId}` (conservation under concurrency) → `applyIdempotent` on ONE authoritative transaction → in-tx fresh reads + gate re-derivation (TOCTOU closure) → `...WithinTx` writes → transactional audit buffer (`demand_pool.created|closed`, `demand_commitment.recorded|withdrawn`) → COMMIT. The derived `evaluateQualifiedDemand` mutates and audits NOTHING (a derived 200 decision).
6. **Bootstrap** — `src/bootstrap/runtime.ts` (MODIFIED, additive): demand repositories + the neutral membership lookup (over `membershipRepo.findByPersonAndOrganization`) + `createDemandService` wiring; `Runtime.demandService`; eight apiCommands methods with view shapers.
7. **API** — `src/api/port.ts` + `src/api/server.ts` (MODIFIED, additive): guard actions `demand.pools.create|close`, `demand.commitments.create|withdraw|read`, `demand.aggregates.evaluate`; routes POST /api/demand/pools (201), POST /api/demand/pools/:id/closure (200), POST /api/demand/pools/:id/qualified-aggregate (200 derived decision), POST /api/demand/commitments (201), POST /api/demand/commitments/:id/withdrawal (200), POST /api/demand/commitments/mine (200 — the ONLY commitment read surface, actor-scoped server-side), GET /api/demand/pools/:id + GET /api/demand/pools (public tenant-scoped pool metadata only). Status semantics 201/200/400/403/404/409.
8. **Tests** — `tests/demand/` (harness + 7 AC suites, 45 tests) + `tests/regression/net-w024-ac-08-architecture-out-of-scope.test.ts` (10 tests) + the skeleton-activation amendments (`ac-08-no-premature-domain-logic.test.ts` + the historical `net-w004-ac-08` DEFERRED list — the established per-work-item pattern).

## Evidence matrix

| AC | Required evidence | Status |
|---|---|---|
| AC-01 first-class records with provenance + consent | `tests/demand/net-w024-ac-01-demand-records.test.ts` — 7 tests: durable pool + commitment records, provenance/lineage fields, server-written consent grant, closed vocabularies (category/region/quantity/band/consent) fail closed, name/prose bounds, tenant-scoped listings | GREEN |
| AC-02 deterministic qualification | `tests/demand/net-w024-ac-02-deterministic-qualification.test.ts` — 7 tests: identical-state digest reproducibility (anchor excluded), PURE-ENGINE order independence, governing-fact digest sensitivity, withdrawn exclusion, closed-pool semantics, threshold boundary, complete check set + frozen outputs + nothing-derived-stored | GREEN |
| AC-03 privacy-preserving aggregation | `tests/demand/net-w024-ac-03-privacy-aggregation.test.ts` — 8 tests: no id-shaped strings beyond the pool/org references, no exact per-person quantities (bucket-only), below-floor group suppression (counted, never named), full aggregate + count suppression below the floor, end-to-end consent/withdrawal immediacy, EXACT minimized fact contract (reconstruction resistance), zero mutation/audit side effects on evaluation, error contexts carry no private attribute material | GREEN |
| AC-04 explicit unassertable thresholds | `tests/demand/net-w024-ac-04-threshold-policy.test.ts` — 5 tests: versioned policy on the record + view, policy bounds fail closed, the frozen floor cannot be lowered by pool policy, caller-asserted aggregates/qualification ignored (smuggled fields), no activity/spend/wealth/reputation input exists | GREEN |
| AC-05 idempotency, concurrency, conservation | `tests/demand/net-w024-ac-05-idempotency-concurrency.test.ts` — 6 tests: same-key replay exactly-once (one record, one audit event), 4-way concurrent same-key exactly-one, 4-way concurrent distinct consumers conserved, withdrawal exactly-once, one-active conflict + withdraw-recommit, pool replay | GREEN |
| AC-06 tenancy + authorization fail closed | `tests/demand/net-w024-ac-06-tenancy-authorization.test.ts` — 7 tests: cross-tenant not-found with existence-oracle parity, cross-tenant create/evaluate fail closed, non-member mutations denied, non-member suppressed views, owner-only withdraw + creator-only close, full HTTP status semantics (403/400/201/200/404/409/403), deny-by-default on the bare runtime | GREEN |
| AC-07 atomicity + audit lineage | `tests/demand/net-w024-ac-07-atomicity-audit.test.ts` — 5 tests: atomic commit with transactionId/idempotencyRecordId/execution lineage, FAILURE INJECTION (no record + no audit on rollback, replayable key), withdrawal/closure audit events, creation event metadata, closed-world audit vocabulary (evaluations audit nothing) | GREEN |
| AC-08 architecture / out-of-scope | `tests/regression/net-w024-ac-08-architecture-out-of-scope.test.ts` — 10 tests: both guards 0 violations (≥286 files), frozen specs (no 17th domain; `/demand` already frozen), work-order binding (v1.0 FROZEN, DEM-001..003, #48), vocabulary pins (all new + frozen vocabularies exact), NO economic/lifecycle/reputation machinery + no cross-domain imports in /demand, privacy containment (actor-scoped-only commitment surface; no demand vocabulary in other domains), economic + lifecycle authorities untouched, composition-root wiring pins, complete file list, no secrets + no new configuration | GREEN |

## Mutation evidence

Six targeted mutations (cp-backup + assert-applied + assert-failed-with-expected-regression + restore + assert-green; driver script in /tmp only, never committed):

1. **Privacy-floor removal** (aggregate emitted regardless of the floor) — CAUGHT by AC-03 (below-floor suppression test failed).
2. **Group-suppression removal** (below-floor groups named) — CAUGHT by AC-03 (suppressed-group test failed).
3. **Membership-gate removal** (non-members may mutate) — CAUGHT by AC-06 (non-member mutation tests failed).
4. **Threshold-derivation removal** (`thresholdMet` always true) — CAUGHT by AC-02 (threshold-boundary test failed).
5. **Tenant-scope removal** (cross-tenant pool readable) — CAUGHT by AC-06 (cross-tenant not-found tests failed).
6. **Idempotency randomization** (composite key randomized) — CAUGHT by AC-05 (same-key replay test failed).

All six restored green after each check (the driver verified the suite passed again after every restore).

## Privacy evidence

- Individual commitments are PRIVATE records: the ONLY commitment read surface is the actor-scoped `POST /api/demand/commitments/mine` (the consumer is the server-resolved authenticated actor — there is no consumerPersonId input anywhere) plus the owner's own mutation results. No other route returns individual commitment data.
- The supplier-facing view (`QualifiedDemandAggregate`) carries ONLY: pool identity/scope, category + policy (public), the five machine-readable checks, the minimized aggregate facts (count + three bounded distributions + suppressed-group count), the deterministic digest, and the single evaluation anchor. AC-03 proves structurally: no UUID-shaped strings beyond the explicit pool/org references, no exact per-person quantities (bucket distributions only), no per-commitment timestamps, exactly the five-key aggregate contract.
- The frozen privacy floor (`DEMAND_PRIVACY_MINIMUM_COMMITMENTS = 3`) suppresses ALL aggregate facts — including the commitment count in check details — below the floor, and suppresses every below-floor distribution group (counted in `suppressedGroups`, never named). Counts are disclosed only when the aggregate is disclosable to THAT requestor (floor met AND active member).
- Withdrawal is the consent revocation and takes effect on the very next evaluation (no retention). Evaluations mutate nothing and audit nothing.
- Error contexts on the demand surface carry only field/id/reason lineage — never private attribute or consent payloads (AC-03).
- No secrets, no configuration, no key material exist in this work item (deterministic derivation only); the config schema and `.env.example` are untouched.

## Final verification record

- `bun run verify` (typecheck + `arch:check` + `authority:check` + full suite): **1565 pass / 15 skip / 0 fail / 17006 expect() / 1580 tests / 198 files** (post-W023 baseline: 1509 pass / 1524 tests — +56).
- `arch:check` + `authority:check`: **286 files / 0 violations** (baseline 281 — the five new source files).
- Mutation checks: **6/6 CAUGHT**, restored green after each.
- Integration: the demand material path runs on the SAME PostgreSQL authority + IdempotencyStore + transactional-audit machinery exercised by the configured real PostgreSQL/Redis integration job (CI `integration`); the domain introduces no new provider.
- W024 acceptance tests: 55 (45 demand + 10 regression) + 1 amended skeleton-activation test = 56 new passing tests.
- Staged-diff secret scan: clean (no credential patterns; no new configuration entries).
- PR: the single canonical implementation PR for issue #48 (Closes #48), opened from `feat/net-w024-consumer-demand-pools`.
- Review state: awaiting architect review — **NOT merged** (merge only on green CI AND recorded architect approval).
- Merge SHA: PENDING.

## Completion rule

Merge only after implementation, acceptance coverage, mutation checks, full verification, green CI, and recorded architect approval. After merge, update `spec/PROJECT-STATE.md` and the roadmap pointers with the merge SHA before advancing to NET-W025.
