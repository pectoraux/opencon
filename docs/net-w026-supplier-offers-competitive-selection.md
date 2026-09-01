# NET-W026 Evidence Ledger — Supplier offers and competitive selection

**Status:** COMPLETE — PR #53 merged  
**Issue:** #52 (closed)  
**Dependency:** NET-W025 merged at `bcaf81b82088688af701f1a90242cc61b1fdd094`  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w026-supplier-offers-competitive-selection`  
**Implementation PR:** #53 (`Closes #52`; head `41a3f3c18e496ff87d08e07c749b3dacce110cf8`; squash-merged as `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`)

## Evidence status

| Gate | Status |
|---|---|
| Canonical issue | #52 CLOSED |
| Canonical work order | `spec/work-orders/NET-W026.md` |
| Implementation branch | `feat/net-w026-supplier-offers-competitive-selection` |
| Implementation PR | **#53 MERGED** |
| Architect review | **APPROVED** (architect approval recorded in PR body; formal GitHub review unavailable because PR author equals connected architect account) |
| CI | **GREEN** — `verify` + `integration` (real PostgreSQL + Redis) succeeded on both events |
| Mutation suite | **7/7 caught** (privacy, region gate, supplier authorization, tenant scope, tie-break determinism, idempotency, qualified-demand gate) |
| Local full verification | **1675 pass / 15 skip / 0 fail / 19038 expect() / 1690 tests / 214 files**; `arch:check` + `authority:check` **294 files / 0 violations**; typecheck clean |
| Real PostgreSQL/Redis integration | **GREEN** (CI integration job with postgres:17 + redis:7 service containers) |

## Architectural guardrails (verified)

- `/demand` remains the sole procurement/demand authority — supplier offers and competitive selection live INSIDE the frozen boundary (no 17th domain; `architecture.md`/`architecture-lock.md` unchanged).
- `/settlement` remains the sole economic authority — a selection is a PROCUREMENT DECISION, never an economic mutation; zero economic vocabulary in the W026 paths.
- NET-W025 qualification and privacy controls remain upstream hard gates — the qualified aggregate is re-derived from CURRENT records at every gate (submission pre-flight AND in-tx; selection derivation and record).
- Buyer commitments remain private — no buyer person ids, buyer-organization ids, commitment ids, exact quantities or aggregate facts cross into W026 surfaces.
- Hard eligibility is server-derived — caller-asserted eligibility/qualification/ranking/selection fields do not exist as inputs.
- Competitive ranking/selection is deterministic and auditable — identical state + anchor ⇒ identical ranking/digest; explicit stable tie-break; atomic audit lineage.
- The authorized-supplier gate is ACTIVE tenant membership resolved through the neutral composition-root lookup.
- `/workflows` remains untouched — offer withdrawal is a one-way field mutation; expiry is derived from the recorded validity window at the evaluation anchor.
- W027 savings semantics and W028 Benefit-Pool semantics are explicitly excluded.

## Architectural decision record

1. **Requirement mapping** — DEM-003 + PROC-001 + PROC-003; PROC-AC-03 provides the selection-lineage anchor.
2. **Offer record** (`procurement_offers`) — first-class, tenant/pool-scoped, durable; acting person becomes supplier; bounded provider-neutral attributes reuse W025 vocabularies; server-written `competitive_selection` consent is required; validity window is explicit and bounded; one ACTIVE offer per (pool, supplier); withdrawal is one-way.
3. **Qualified-demand gating** — offers only compete against CURRENTLY qualified W025 demand; aggregate is re-derived SERVER-SIDE pre-flight AND inside the authoritative transaction using the `listActiveByPoolWithinTx` repository twin. The twin gates are deliberately redundant; mutation testing removes BOTH to prove the concept is load-bearing. Existing offers survive pool closure/withdrawal but never re-enter selection.
4. **Hard eligibility (one explicit anchor)** — offer validity, named-region compatibility, active supplier authorization, pool qualification and eligible-offer presence are all evaluated from server-authoritative state.
5. **Deterministic competitive selection** — versioned server-owned policy (`SUPPLIER_OFFER_SELECTION_POLICY_VERSION = 1`) orders unit-price band ascending → timing window ascending → capacity descending → offer id ascending. Ranking is input-order independent. Digest excludes the anchor, following W021/W024/W025 precedent.
6. **Selection lineage** (`procurement_selections`) — immutable authoritative record executed by pool creator; derivation runs inside the authoritative transaction; considered offer ids, rationale, selected offer, digest, policy snapshot and provenance are persisted; per-pool lock serializes concurrent records.
7. **Privacy/competition containment** — offers/mine is the only supplier offer read surface; selection surfaces are pool-creator-only; W025 aggregate facts are not copied into W026 output.
8. **Economic containment** — zero economic vocabulary and zero settlement coupling; W026 only records procurement decisions and corresponding audit events.

## Implementation shape

- `src/core/procurement-offer.ts` — record formats, closed consent scope, validity bounds, selection policy/ranking rules, validators and errors.
- `src/demand/port.ts` — W026 contracts, services, derived selection view, repositories, and audit vocabulary; includes the in-tx active-commitment listing twin.
- `src/demand/authority-procurement-repositories.ts` — current active W025 commitment listing inside an authoritative transaction.
- `src/demand/authority-supplier-offer-repositories.ts` — append-only offer/selection persistence.
- `src/demand/competitive-selection-engine.ts` — pure eligibility and deterministic ranking/digest derivation.
- `src/demand/supplier-offer-service.ts` — material commands and derived selection evaluation using established tenant/auth/idempotency/concurrency/atomicity conventions.
- Wiring: `src/bootstrap/runtime.ts`, `src/api/port.ts`, `src/api/server.ts`, module/README amendments.
- Tests: W026 harness, AC suites, architecture/out-of-scope regression, and mutation driver outside repository.

## Evidence matrix (AC → suite → result)

| AC | Suite | Tests | Result |
|---|---|---:|---|
| AC-01 offer records | `net-w026-ac-01-supplier-offer-records.test.ts` | 5 | PASS |
| AC-02 qualified-demand gating | `net-w026-ac-02-qualified-demand-gating.test.ts` | 5 | PASS |
| AC-03 server-derived eligibility | `net-w026-ac-03-server-derived-eligibility.test.ts` | 6 | PASS |
| AC-04 deterministic selection | `net-w026-ac-04-deterministic-selection.test.ts` | 7 | PASS |
| AC-05 privacy/competition | `net-w026-ac-05-privacy-competition.test.ts` | 7 | PASS |
| AC-06 idempotency/concurrency/atomicity | `net-w026-ac-06-idempotency-concurrency.test.ts` | 6 | PASS |
| AC-07 economic containment | `net-w026-ac-07-economic-containment.test.ts` | 3 | PASS |
| AC-08 architecture/out-of-scope | `tests/regression/net-w026-ac-08-architecture-out-of-scope.test.ts` (+ shared no-premature amendment) | 10 | PASS |

## Mutation evidence (7/7 caught)

| # | Mutation | Target | Result |
|---|---|---|---|
| M1 | Leak W025 aggregate facts through selection view | AC-05 | CAUGHT |
| M2 | Remove region-served hard gate | AC-03 | CAUGHT |
| M3 | Remove supplier-authorization re-derivation | AC-03 | CAUGHT |
| M4 | Remove tenant-scope check from pool anchor | AC-03 | CAUGHT |
| M5 | Reverse offer-id tie-break | AC-04 | CAUGHT |
| M6 | Randomize offer composite idempotency key | AC-06 | CAUGHT |
| M7 | Remove both submission-time qualified-demand gates | AC-02 | CAUGHT |

Driver: `opencon-tmp/w026-mutation-driver.mjs` outside the repository; never committed. Every mutated build failed its target suite and every restored build re-ran green.

## Verification record

- `bun run verify`: **1675 pass / 15 skip / 0 fail / 19038 expect() / 1690 tests / 214 files**.
- `arch:check` + `authority:check`: **294 files / 0 violations**.
- Staged secret scan: clean; no W026 credentials/config secrets.
- Frozen `spec/architecture.md` + `spec/architecture-lock.md`: unchanged.
- Real PostgreSQL/Redis integration: green in configured CI.

## Review history

- PR #53 opened for NET-W026 and passed all verification gates.
- Architect approval was recorded in the PR body because the connected architect account equals the PR author and GitHub disallows self-approval.
- PR #53 squash-merged into `main`; merge SHA `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`.
