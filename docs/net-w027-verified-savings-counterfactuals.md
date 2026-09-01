# NET-W027 Evidence Ledger — Verified savings and counterfactuals

**Status:** COMPLETE — implementation + verification green; PR #55 open with green CI, awaiting architect review  
**Issue:** #54 (open — READY_FOR_IMPLEMENTATION)  
**Dependency:** NET-W026 merged at `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`; NET-W006 merged (the `/outcomes` measurement authority)  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w027-verified-savings-counterfactuals`  
**Implementation PR:** #55 (`Closes #54`; heads `e2b2b2c` → `c80edac` (ledger) → `f05cae5` (legacy-flake remediation))

## Evidence status

| Gate | Status |
|---|---|
| Canonical issue | #54 OPEN (READY_FOR_IMPLEMENTATION) |
| Canonical work order | `spec/work-orders/NET-W027.md` (authored on activation) |
| Implementation branch | `feat/net-w027-verified-savings-counterfactuals` (prepared from merged W026 baseline at `6b8d842`, fast-forwarded through the W027 activation docs at `640ffe6`) |
| Implementation PR | **#55 OPEN** (head `f05cae5`; verification-status comment id 5489976046) |
| Architect review | PENDING (approval to be recorded in the PR — the same-account limitation precedent) |
| CI | **GREEN** — 4/4 checks on BOTH events at head `f05cae5`: `verify` (typecheck + architecture + authority + unit tests) + `integration` (real PostgreSQL 17 + Redis 7); `mergeable_state: clean` (also 4/4 green at the implementation head `e2b2b2c`) |
| Mutation suite | **7/7 caught** (counterfactual-interval, qualifying-source, anchor-in-digest, unsupported-record, tenant-scope, idempotency, staleness/supersession) |
| Local full verification | **1727 pass / 15 skip / 0 fail / 20861 expect() / 1742 tests / 223 files**; `arch:check` + `authority:check` **298 files / 0 violations**; typecheck clean |
| Real PostgreSQL/Redis integration | **GREEN** (CI integration job with postgres:17 + redis:7 service containers, both events) |

## Architectural guardrails (verified)

- `/demand` remains the sole procurement authority — baselines, counterfactual representations and savings decisions live INSIDE the frozen boundary (no 17th domain; `architecture.md`/`architecture-lock.md` unchanged; 298 files / 0 arch+authority violations).
- `/outcomes` remains the normalized measurement authority — observed savings facts are consumed read-only as `OutcomeObservation` records (outcome type `savings`, subject `(procurement_pool, poolId)`) through the neutral `ProcurementSavingsOutcomeLookup` wired at the composition root (supersession computed over the authority's correction index); W027 fabricates no measurements and adds no method to the `/outcomes` port.
- `/evidence` remains the provenance/truth authority — baseline claims carry ≥1 subject-bound evidence references resolved through the neutral `ProcurementSavingsEvidenceLookup`; the qualifying source-type rule (platform/attested/provider — architecture-lock §4) is a frozen separate constant.
- `/settlement` remains the sole economic authority — a verified savings claim is a MEASUREMENT DECISION, never an economic mutation; zero economic vocabulary in the W027 paths; `ECONOMIC_VALUE_SOURCES` unchanged (no savings/procurement source kind).
- Uncertainty is first-class — confidence intervals preserved and conservatively combined (MIN point + envelope, `conservative-savings-derivation`); a `counterfactual` baseline REQUIRES a quantified interval (the NET-W006 rule, enforced at creation AND re-derived at every anchor); unsupported exact claims fail closed.
- Derivation is deterministic and anchor-aware — identical authoritative state ⇒ identical digest (canonical id-ordered observations; input-order independent); the anchor is recorded, never digested; every governing-fact change changes the digest.
- Invalid, stale, missing or insufficient evidence fails closed for the authoritative record (one-way invalidation, supersession, source quality, the frozen 365-day staleness bound, mixed units); the derived evaluation is the current-verdict surface for economically authoritative consumers.
- All W027 surfaces are pool-creator-only (server-resolved membership + creator gates); cross-tenant references are indistinguishable from nonexistent.
- The W026 offer/selection context enters ONLY as neutral validated lineage (scope + pool match; the digest is invariant to it — offer price is never savings truth).
- W028 Benefit Pool semantics are explicitly excluded (source-level bans + frozen vocabulary pins).

## Architectural decision record

1. **Requirement mapping** — PROC-002 (savings require evidence-supported counterfactual/baseline) + PROC-AC-01 (the future settlement-side gate — W027 supplies it) + OUT-004/EVID-005 alignment (counterfactual savings measurement; preserved uncertainty — the `BaselineKind`/`ConfidenceEstimate`/evidence-source vocabularies are REUSED from the NET-W005/NET-W006 core contracts, never redefined).
2. **Baseline record** (`procurement_baselines`) — first-class, tenant/pool-scoped, durable; explicit kind (`baseline` | `counterfactual`), closed method vocabulary (4 methods) + required methodVersion, bounded HISTORICAL comparison window (1..365 days, ending no later than submission), bounded population, value + unit, validated confidence (counterfactual ⇒ quantified interval), measurement provenance, 1..8 subject-bound evidence references; immutable except the ONE-WAY invalidation (4 closed reasons; a fresh-key re-invalidation is a stable conflict).
3. **Realized-outcome linkage** — observations are `/outcomes` `OutcomeObservation` records resolved through the neutral composition-root lookup; existence/scope resolve hard (NotFoundError, indistinguishable), while subject binding, outcome type, chain-head position, source type and freshness are DERIVATION checks (fail closed through the machine-readable verdict — the derived-vs-authoritative split).
4. **Deterministic derivation** (`savings-engine.ts`) — versioned server-owned policy (version 1, `baseline-minus-observed-conservative`, 12 explicit criteria); observed value = SUM of chain-head values (unit-consistent); confidence = MIN point over baseline + observations with the conservative envelope; savings = baseline − observed (server-owned; honest negative dis-savings); digest excludes the anchor and covers every governing fact (policy, baseline identity/kind/method/value/confidence, evidence ids + source types, per-observation governing facts, checks, derived values).
5. **Fail-closed sufficiency** — twelve machine-readable checks; `supported` is the conjunction; the RECORD command fails closed with the failing checks in machine-readable context; the DERIVED evaluation is a 200 decision for every outcome.
6. **Mutation lineage** (`procurement_savings`) — immutable authoritative snapshots of supported derivations, executed by the pool creator inside ONE authoritative transaction (in-tx pool + baseline re-reads; neutral-lookup evidence/observation facts at the one in-tx anchor) with the per-pool lock and atomic audit.
7. **Economic containment** — zero economic vocabulary/settlement coupling; W028 excluded (bans in the W027 files + the regression suite).
8. **Sanctioned shared-file amendment** — the W025/W026 ac-08 `counterfactual`/savings-identifier bans on the SHARED `/demand` port/module are narrowed to the W025/W026-OWNED files (the NET-W005/W006 + W020/W021 amendment precedent, with "NET-W027 UPDATE" comments): the shared boundary carries the sanctioned NET-W027 contracts while W025/W026's own files keep the full historical bans (pinned by the AC-09 amendment-scoping test). The no-premature suite activates `NET_W027_DOMAINS = ["demand"]` inside the SAME boundary.

## Implementation shape

- `src/core/procurement-savings.ts` — record formats (`NET-W027:1`), closed method/invalidation vocabularies, frozen bounds (window 1..365d, ≤8 evidence refs, ≤8 observations, 365-day staleness, value domain, unit/methodVersion lengths), the qualifying source-type set, the derivation policy (version/method/12 criteria), the subject type, validators and errors (`InvalidProcurementSavingsError`, `ProcurementSavingsConflictError`).
- `src/demand/port.ts` — W027 records, inputs/results, derived view + 12-check contract, the neutral `ProcurementSavingsEvidenceLookup`/`ProcurementSavingsOutcomeLookup` + facts shapes, repositories, service + deps, audit vocabulary (+3 events), type re-exports (additive).
- `src/demand/authority-savings-repositories.ts` — append-only `procurement_baselines` (one-way invalidation twin) + immutable `procurement_savings` lineage (newest-first).
- `src/demand/savings-engine.ts` — the PURE deterministic, uncertainty-preserving derivation + canonical digest (anchor excluded, canonical observation order).
- `src/demand/savings-service.ts` — material commands + derived evaluation (tenant anchor first, membership + pool-creator gates, neutral-lookup fact resolution, composite idempotency, per-pool lock for savings records, one authoritative transaction, transactional audit buffers).
- Wiring: `src/bootstrap/runtime.ts` (repos + the two neutral lookups over the /evidence + /outcomes repositories + service + 6 apiCommands + 4 view shapers + Runtime field), `src/api/port.ts` (6 guarded commands), `src/api/server.ts` (6 guarded routes), module/README amendments.
- Tests: `tests/demand/_net-w027-harness.ts` (guard actions + evidence/observation/baseline factories over the REAL /evidence + /outcomes services + the supported savings seed), AC-01..08 suites, `tests/regression/net-w027-ac-09-architecture-out-of-scope.test.ts`, the no-premature amendment, the W025/W026 ac-08 shared-file ban amendments, and the mutation driver outside the repository.

## Evidence matrix (AC → suite → result)

| AC | Suite | Tests | Result |
|---|---|---:|---|
| AC-01 baseline records | `tests/demand/net-w027-ac-01-baseline-records.test.ts` | 5 | PASS |
| AC-02 counterfactual representation | `tests/demand/net-w027-ac-02-counterfactual-representation.test.ts` | 5 | PASS |
| AC-03 authoritative derivation only | `tests/demand/net-w027-ac-03-authoritative-derivation.test.ts` | 6 | PASS |
| AC-04 deterministic/anchor-aware derivation | `tests/demand/net-w027-ac-04-deterministic-derivation.test.ts` | 5 | PASS |
| AC-05 uncertainty + fail-closed evidence | `tests/demand/net-w027-ac-05-uncertainty-fail-closed.test.ts` | 6 | PASS |
| AC-06 tenancy/authorization | `tests/demand/net-w027-ac-06-tenancy-authorization.test.ts` | 4 | PASS |
| AC-07 idempotency/concurrency/atomicity | `tests/demand/net-w027-ac-07-idempotency-concurrency.test.ts` | 3 | PASS |
| AC-08 economic containment | `tests/demand/net-w027-ac-08-economic-containment.test.ts` | 6 | PASS |
| AC-09 architecture/out-of-scope | `tests/regression/net-w027-ac-09-architecture-out-of-scope.test.ts` (+ no-premature amendment + W025/W026 ac-08 amendments) | 11 | PASS |

## Mutation evidence (7/7 caught)

| # | Mutation | Target | Result |
|---|---|---|---|
| M1 | Counterfactual interval requirement bypassed (point-only counterfactual accepted) | AC-02 | CAUGHT |
| M2 | Qualifying source-type gate removed (model/self evidence becomes authoritative) | AC-05 | CAUGHT |
| M3 | Evaluation anchor included in the digest (identical state no longer digests identically) | AC-04 | CAUGHT |
| M4 | Unsupported derivations recorded (the authoritative fail-closed gate removed) | AC-03 | CAUGHT |
| M5 | Tenant-scope check removed from the pool anchor (cross-tenant no longer fails closed) | AC-06 | CAUGHT |
| M6 | Composite idempotency key randomized (same-key replay no longer exactly-once) | AC-07 | CAUGHT |
| M7 | Derived staleness + supersession re-derivation bypassed (stale/superseded evidence becomes authoritative) | AC-05 | CAUGHT |

Driver: `opencon-tmp/w027-mutation-driver.py` outside the repository; never committed. Every mutated build failed its target suite (assert-applied + assert-failed) and every restored build re-ran green (assert-reverted + assert-green); the working tree was verified clean afterward (no `.w027-mutbak` leftovers).

## Verification record

- `bun run verify`: **1727 pass / 15 skip / 0 fail / 20861 expect() / 1742 tests / 223 files** (W026 baseline: 1675/15/0/19038/1690/214 — +52 tests: 51 W027 tests + 1 no-premature amendment test).
- `arch:check` + `authority:check`: **298 files / 0 violations** (both inside `bun run verify` and standalone).
- Staged secret scan: clean; no W027 credentials/config secrets (the AC-09 suite pins `PROCUREMENT_SAVINGS_|PROCUREMENT_BASELINE_|SAVINGS_VERIFICATION_` absent from `src/config/schema.ts` + `.env.example`).
- Frozen `spec/architecture.md` + `spec/architecture-lock.md`: unchanged (AC-09 pins: FROZEN markers, the `/demand` module-ownership line, no 17th-domain entries; §13's counterfactual-savings-measurement + uncertainty contract already covers W027).
- Real PostgreSQL/Redis integration: pending in configured CI (the integration job with postgres:17 + redis:7 service containers).

## Review history

- Implementation + local verification complete on `feat/net-w027-verified-savings-counterfactuals` (work order authored on activation per `spec/PROJECT-STATE.md`'s current action; implementation commit `e2b2b2c`).
- The single canonical PR **#55** opened (`Closes #54`) with the full authority-model, implementation-shape, design-decision and verification description.
- CI GREEN on BOTH events at head `e2b2b2c`: `verify` (typecheck + architecture + authority + unit tests) success + `integration` (real PostgreSQL + Redis) success — 4/4 checks; `mergeable_state: clean`.
- The verification-status comment posted (id 5489976046) with the complete local gate table, mutation table and boundary-compliance record.
- CI flake remediated ON THE SAME BRANCH: the ledger-only head `c80edac` hit a PRE-EXISTING latent timeout flake in the legacy W007 suite (`net-w007-ac-07-neutrality`'s 120-iteration loop crossed the 5s default per-test timeout at 5002ms on a slow shared runner — the identical tree was green at `e2b2b2c` and 5x green locally; unrelated to W027). Remediation: an explicit 60s timeout on that single legacy test (`f05cae5`, documented in the commit); the full gate re-ran green locally (1727/0) and CI re-ran 4/4 GREEN at `f05cae5` with `mergeable_state: clean`.
- PR #55 left UNMERGED per the standing protocol, awaiting architect review. On APPROVED: merge, update `spec/PROJECT-STATE.md` + roadmap pointers with the merge SHA, activate NET-W028 (Benefit Pools). On CHANGES REQUESTED: remediate on the SAME branch/PR.
