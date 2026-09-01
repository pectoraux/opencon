# NET-W026 Evidence Ledger — Supplier offers and competitive selection

**Status:** COMPLETE — PR #53 merged
**Issue:** #52 (closed)
**Merge SHA:** `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`
**Architecture:** v1.0 frozen

## Evidence status

| Gate | Status |
|---|---|
| Canonical issue | #52 CLOSED |
| Canonical work order | `spec/work-orders/NET-W026.md` |
| Implementation branch | `feat/net-w026-supplier-offers-competitive-selection` |
| Implementation PR | **#53 MERGED** |
| Architect review | **APPROVED** (architect approval recorded in PR body; formal GitHub review unavailable because PR author equals connected architect account) |
| CI | **GREEN** — verify + integration (real PostgreSQL + Redis) succeeded on BOTH events |
| Mutation suite | **7/7 caught** (privacy, region gate, supplier authorization, tenant scope, tie-break determinism, idempotency, qualified-demand gate) |
| Local full verification | **1675 pass / 15 skip / 0 fail / 19038 expect() / 1690 tests / 214 files**; `arch:check` + `authority:check` **294 files / 0 violations**; typecheck clean |
| Real PostgreSQL/Redis integration | **GREEN** through CI service containers |

## Architectural guardrails (verified)

- `/demand` remains the sole procurement/demand authority — supplier offers and competitive selection live inside the frozen boundary (no 17th domain; frozen architecture unchanged).
- `/settlement` remains the sole economic authority — a selection is a procurement decision, never an economic mutation; zero economic vocabulary exists in the W026 mutation paths.
- NET-W025 qualification and privacy controls remain upstream hard gates; qualified demand is re-derived from current authoritative commitments both pre-flight and in-transaction.
- Buyer commitments remain private; supplier-facing outputs do not reveal buyer identities, commitment identifiers or exact competitor commercial terms.
- Hard eligibility is server-derived; caller assertions cannot authorize qualification, ranking or selection.
- Competitive selection is deterministic and auditable with an explicit versioned policy, stable tie-breaking and explicit evaluation anchor.
- `/workflows` remains lifecycle authority and is untouched by local offer/selection lifecycle machinery.
- W027 savings/counterfactual semantics and W028 Benefit-Pool semantics were explicitly excluded and remain deferred.

## Architectural decision record

1. **Requirement mapping** — DEM-003 + PROC-001 + PROC-003 with PROC-AC-03 as the selection-lineage anchor.
2. **Offer record** — first-class tenant/pool-scoped durable records; acting person becomes the supplier; bounded provider-neutral attributes; server-written competitive-selection consent; explicit validity window; one active offer per pool/supplier; one-way withdrawal.
3. **Qualified-demand gating** — current W025 aggregate is re-derived server-side both before mutation and inside the authoritative transaction; the deliberate twin gate closes the TOCTOU window.
4. **Hard eligibility** — validity, named-region compatibility and active supplier authorization are all server-derived at one anchor; pool qualification and eligible-offer presence are mandatory.
5. **Deterministic selection** — versioned policy orders unit-price band, timing window, capacity and offer id; ranking is input-order independent; digest excludes the anchor.
6. **Selection lineage** — immutable authoritative selection records snapshot the offer set, rationale, policy, pool digest, chosen offer and provenance; per-pool lock serializes concurrent records.
7. **Privacy/competition containment** — offers are supplier-private; selection surfaces are pool-creator-authorized; the W025 aggregate itself is never copied into W026 selection output.
8. **Economic containment** — no economic mutations or second ledger; audit events are transactionally buffered and published after commit.

## Implementation shape

- `src/core/procurement-offer.ts` — record formats, closed consent scope, validity bounds, selection policy, ranking criteria, validators and errors.
- `src/demand/port.ts` — W026 contracts, services, derived selection view, repositories and audit vocabulary.
- `src/demand/authority-procurement-repositories.ts` — in-tx active commitment listing.
- `src/demand/authority-supplier-offer-repositories.ts` — append-only offer and selection persistence.
- `src/demand/competitive-selection-engine.ts` — pure hard-eligibility + deterministic ranking + digest derivation.
- `src/demand/supplier-offer-service.ts` — material commands and derived selection evaluation.
- `src/bootstrap/runtime.ts`, `src/api/port.ts`, `src/api/server.ts` — composition-root wiring and guarded API.
- Tests — W026 harness, AC suites, architecture/out-of-scope regression and mutation driver outside the repository.

## Evidence matrix

| AC | Tests | Result |
|---|---:|---|
| AC-01 offer records | 5 | PASS |
| AC-02 qualified-demand gating | 5 | PASS |
| AC-03 server-derived eligibility | 6 | PASS |
| AC-04 deterministic selection | 7 | PASS |
| AC-05 privacy/competition | 7 | PASS |
| AC-06 idempotency/concurrency/atomicity | 6 | PASS |
| AC-07 economic containment | 3 | PASS |
| AC-08 architecture/out-of-scope | 10 | PASS |

## Mutation evidence

7/7 targeted mutations were caught and restored: aggregate leakage, region-gate removal, supplier authorization removal, tenant-scope removal, reversed deterministic tie-break, randomized idempotency key, and removal of the paired qualified-demand gates.

## Verification record

- `bun run verify`: **1675 pass / 15 skip / 0 fail / 1690 tests**.
- `arch:check` + `authority:check`: **294 files / 0 violations**.
- Staged secret scan: clean.
- Frozen `spec/architecture.md` and `spec/architecture-lock.md`: unchanged.
- Real PostgreSQL + Redis integration: green in CI.

## Review history

- PR #53 opened for NET-W026 and passed all verification gates.
- Architect approval was recorded in the PR body; the formal GitHub review API rejected self-approval because the connected architect account equals the PR author.
- PR #53 was squash-merged; merge SHA `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`.
