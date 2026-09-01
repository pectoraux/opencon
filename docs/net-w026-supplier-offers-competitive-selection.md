# NET-W026 Evidence Ledger — Supplier offers and competitive selection

**Status:** IMPLEMENTED — PR #53 open, CI green, awaiting architect review  
**Issue:** #52  
**Dependency:** NET-W025 merged at `bcaf81b82088688af701f1a90242cc61b1fdd094`  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w026-supplier-offers-competitive-selection`  
**Implementation PR:** #53 (`Closes #52`; head `41a3f3c18e496ff87d08e07c749b3dacce110cf8`; 1 commit, 22 files, +6161/−42)

## Evidence status

| Gate | Status |
|---|---|
| Canonical issue | #52 OPEN |
| Canonical work order | `spec/work-orders/NET-W026.md` |
| Implementation branch | `feat/net-w026-supplier-offers-competitive-selection` (prepared at `6e2fd45`, fast-forwarded to main) |
| Implementation PR | **#53 OPEN** (mergeable_state: clean) |
| Architect review | Pending (verification-status comment posted: id 5487891091) |
| CI | **GREEN 4/4** — `verify` + `integration` (real PostgreSQL + Redis) succeeded on BOTH events at head `41a3f3c` |
| Mutation suite | **7/7 caught** (privacy, region gate, supplier authorization, tenant scope, tie-break determinism, idempotency, qualified-demand gate — every mutated build failed its target AC suite; every restored build green) |
| Local full verification | **1675 pass / 15 skip / 0 fail / 19038 expect() / 1690 tests / 214 files** (baseline 1625/1640/206 — +50 tests); `arch:check` + `authority:check` **294 files / 0 violations**; typecheck clean |
| Real PostgreSQL/Redis integration | **GREEN** (CI `integration` job: postgres:17 + redis:7 service containers, both events) |

## Architectural guardrails (verified)

- `/demand` remains the sole procurement/demand authority — supplier offers and competitive selection live INSIDE the frozen boundary (no 17th domain; `architecture.md`/`architecture-lock.md` byte-pinned unchanged by the AC-08 regression).
- `/settlement` remains the sole economic authority — a selection is a PROCUREMENT DECISION, never an economic mutation; zero economic vocabulary in the W026 paths (AC-07 + AC-08 bans).
- NET-W025 qualification and privacy controls remain upstream hard gates — the qualified aggregate is re-derived from CURRENT records at every gate (submission pre-flight AND in-tx; selection derivation and record).
- Buyer commitments remain private — no buyer person ids, buyer-organization ids, commitment ids, exact quantities or aggregate facts ever cross into any W026 surface (AC-05 JSON scans + exact key surfaces).
- Hard eligibility is server-derived — caller-asserted eligibility/qualification/ranking/selection fields do not exist as inputs and are ignored (AC-03).
- Competitive ranking/selection is deterministic and auditable — identical state + anchor ⇒ identical ranking/digest; explicit stable tie-break; atomic audit lineage (AC-04/AC-06).
- The authorized-supplier gate is the ACTIVE tenant membership resolved through the same neutral composition-root lookup (no client claims; the participant-role vocabulary stays unconsumed).
- `/workflows` remains untouched — offer withdrawal is a one-way field mutation; expiry is DERIVED from the recorded validity window at the evaluation anchor.
- W027 savings semantics and W028 Benefit-Pool semantics are explicitly excluded (AC-08 vocabulary bans).

## Architectural decision record

1. **Requirement mapping** — DEM-003 (competitive supplier offers) + PROC-001 (bounded to the offer/selection surface) + PROC-003 (prevent unlawful exchange of commercially sensitive competitor information); PROC-AC-03 ("supplier selection records the offer set and selection rationale") is the lineage-record anchor.
2. **Offer record** (`procurement_offers` collection) — first-class, tenant/pool-scoped, durable; the acting person BECOMES the supplier (no supplierPersonId input); bounded provider-neutral attributes from the SAME closed W025 vocabularies (region + unit-price band + delivery-timing window + capacity bucket — all required, so every offer is comparable); the SERVER-WRITTEN consent grant with exactly ONE closed scope (`competitive_selection` — an offer cannot exist without explicit consent to compete); the explicit validity window (`validFrom` server-set, `validUntil` bounded optional ≤ 365 days; expiry derived, never mutated); ONE ACTIVE offer per (pool, supplier); one-way withdrawal.
3. **Qualified-demand gating** — offers may only be submitted against CURRENTLY qualified W025 demand: the aggregate is re-derived SERVER-SIDE pre-flight AND inside the authoritative transaction from tx-scanned commitments (a NEW `listActiveByPoolWithinTx` commitment-repository twin — the TOCTOU closure). The twin gates are deliberately redundant (defense in depth); the mutation check removes BOTH to prove the concept is load-bearing. Existing offers SURVIVE pool closure/withdrawal (durable) but never re-enter selection (re-derived); the RECORD command fails closed on unqualified demand while the DERIVED view returns the decision (200 for every outcome).
4. **Hard eligibility (server-derived, at ONE explicit anchor)** — per offer: `offer_validity` (the anchor falls inside the recorded window), `region_served` (the offer's region appears in the qualified aggregate's NAMED, above-floor region groups — below-floor regions are never named, so they can never be targeted: the W025 floor contract stays intact on the competition surface), `supplier_authorized` (ACTIVE tenant membership re-resolved at the anchor — a revoked supplier's offer becomes ineligible, never an error). Pool-level: `pool_qualified` (the re-derived W025 qualification at the same anchor) + `eligible_offers_present`.
5. **Deterministic competitive selection** — the explicit, versioned, server-owned policy (`SUPPLIER_OFFER_SELECTION_POLICY_VERSION = 1`; criteria: unit-price band ascending → timing window ascending → capacity descending → offer id ascending, recorded on every surface). The ranking re-sorts over the policy (input order never leaks). The digest covers the decision facts and EXCLUDES the anchor (identical state ⇒ identical digest — the W021/W024/W025 precedent; two records over unchanged state share the digest). No AI path exists (a future advisory signal may only blend in AFTER hard eligibility).
6. **Selection lineage** (`procurement_selections` collection) — the AUTHORITATIVE immutable record: the pool creator (server-gated) executes the selection; the derivation runs INSIDE the authoritative transaction (in-tx pool + commitments + offers; anchor set once inside); the record snapshots the offer set (`consideredOfferIds`), the rationale (checks + per-offer evaluations + ranking + policy snapshot + pool digest), the selected offer, the digest and full provenance. Per-pool lock serializes concurrent records; each stays deterministic at its own anchor.
7. **Privacy/competition containment** — offers are private to their supplier (offers/mine is the ONLY offer read surface, actor-scoped); selection surfaces (derived view + records + lineage listing) are POOL-CREATOR-ONLY — supplier commercial terms never cross to other pool participants (PROC-AC-02 "by default" containment); the selection view links the demand state through the pool digest ONLY (aggregate facts never cross); ranking entries carry supplier/offer facts only.
8. **Economic containment** — zero economic vocabulary, zero settlement coupling, zero lifecycle machinery; audit events `procurement_offer.recorded` / `procurement_offer.withdrawn` / `procurement_selection.recorded` on ONE authoritative transaction with transactional audit buffers.

## Implementation shape

- `src/core/procurement-offer.ts` (NEW) — record formats, the closed consent scope, validity bounds, the selection-policy version + ranking criteria + ordinal tables (reusing the W025 vocabularies; capacity pre-reversed), `InvalidSupplierOfferError` / `SupplierOfferConflictError`, pure validators (`validateSupplierOfferAttributes`, `validateSupplierOfferValidity`).
- `src/demand/port.ts` (EXTENDED additively) — `SupplierOffer`, `CompetitiveSelection`, inputs/results, the derived `CompetitiveSelectionView` + check/evaluation/rank types, `SupplierOfferRepository` / `CompetitiveSelectionRepository`, `SupplierOfferService` + deps, the `DemandPort` audit vocabulary extension, and the commitment-repository `listActiveByPoolWithinTx` twin.
- `src/demand/authority-procurement-repositories.ts` (EXTENDED) — the in-tx active-commitment listing.
- `src/demand/authority-supplier-offer-repositories.ts` (NEW) — the `procurement_offers` / `procurement_selections` append-only collections (create-once guards; one-way withdrawal; immutable lineage records).
- `src/demand/competitive-selection-engine.ts` (NEW) — the PURE derivation: hard eligibility → deterministic ranking → anchor-excluded digest.
- `src/demand/supplier-offer-service.ts` (NEW) — the material commands + derived evaluation, following the full W003/W004/W008/W019/W020/W025 convention set (tenant anchor first; membership/creator gates; composite idempotency keys; per-pool advisory locks; ONE authoritative transaction; in-tx TOCTOU re-derivation; transactional audit buffers).
- Wiring: `src/bootstrap/runtime.ts` (repos + service over the SAME membership lookup and procurement repositories; Runtime field; view shapers; 6 apiCommands) + `src/api/port.ts` (6 guarded commands) + `src/api/server.ts` (6 routes: POST pools/:id/offers 201, POST offers/:id/withdrawal 200, POST offers/mine 200, POST pools/:id/competitive-selection 200 derived, POST pools/:id/selection-records 201, POST pools/:id/selections 200) + module/README amendments.
- Tests: `tests/demand/_net-w026-harness.ts` (3 supplier actors + creator ctx + factories + seeds) + 7 AC suites (37 tests) + `tests/regression/net-w026-ac-08-architecture-out-of-scope.test.ts` (10 tests) + the `ac-08-no-premature` NET_W026_DOMAINS amendment.

## Evidence matrix (AC → suite → result)

| AC | Suite | Tests | Result |
|---|---|---|---|
| AC-01 offer records | `net-w026-ac-01-supplier-offer-records.test.ts` | 5 | PASS |
| AC-02 qualified-demand gating | `net-w026-ac-02-qualified-demand-gating.test.ts` | 5 | PASS |
| AC-03 server-derived eligibility | `net-w026-ac-03-server-derived-eligibility.test.ts` | 6 | PASS |
| AC-04 deterministic selection | `net-w026-ac-04-deterministic-selection.test.ts` | 7 | PASS |
| AC-05 privacy/competition | `net-w026-ac-05-privacy-competition.test.ts` | 7 | PASS |
| AC-06 idempotency/concurrency/atomicity | `net-w026-ac-06-idempotency-concurrency.test.ts` | 6 | PASS |
| AC-07 economic containment | `net-w026-ac-07-economic-containment.test.ts` | 3 | PASS |
| AC-08 architecture/out-of-scope | `tests/regression/net-w026-ac-08-architecture-out-of-scope.test.ts` (+ the shared no-premature amendment) | 10 | PASS |

## Mutation evidence (7/7 caught)

| # | Mutation (direction) | Target suite | Result |
|---|---|---|---|
| M1 | The selection view leaks the W025 aggregate facts | AC-05 | CAUGHT |
| M2 | The region-served hard gate is removed | AC-03 | CAUGHT |
| M3 | The supplier-authorization re-derivation is removed | AC-03 | CAUGHT |
| M4 | The tenant-scope check is removed from the pool anchor | AC-03 | CAUGHT |
| M5 | The offer-id tie-break is reversed (nondeterminism) | AC-04 | CAUGHT |
| M6 | The offer composite idempotency key is randomized | AC-06 | CAUGHT |
| M7 | BOTH submission-time qualified-demand gates removed | AC-02 | CAUGHT |

Driver: `opencon-tmp/w026-mutation-driver.mjs` (outside the repository; never committed). Every mutated build failed its target suite; every restored build re-ran green.

## Verification record

- `bun run verify` (typecheck + `arch:check` + `authority:check` + full suite): **1675 pass / 15 skip / 0 fail / 19038 expect() / 1690 tests / 214 files**.
- `arch:check` + `authority:check`: **294 files / 0 violations**.
- Staged secret scan: clean (no key material; no new configuration entries — `schema.ts`/`.env.example` pinned free of W026 vocabulary).
- Working tree clean after the mutation runs (no `.bak` leftovers).
- Real PostgreSQL/Redis integration: exercised by the configured CI `integration` job on the PR.

## Review history

- 2026-09-01: PR #53 opened at head `41a3f3c` with the full verification record; CI green 4/4 (verify + real PostgreSQL/Redis integration, both events); mergeable_state clean; verification-status comment posted (id 5487891091). Awaiting architect review — unmerged per the standing protocol.
