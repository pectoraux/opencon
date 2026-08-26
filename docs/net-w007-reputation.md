# NET-W007 — Reputation engine: implementation evidence

**Work item:** Issue #13 (NET-W007, READY_FOR_IMPLEMENTATION)
**Architecture:** v1.0 (FROZEN) — binds to `spec/architecture.md` §4/§11/§18/§19 and `spec/architecture-lock.md` invariants 1.3/1.4/1.8/§3/§4/§12/§13.22/§14; changes NEITHER.
**Work order:** `spec/work-orders/NET-W007.md`
**Requirements covered:** REP-001 (dimension vocabulary), REP-002 (not purchasable), REP-003 (time decay), REP-004 (evidence-traced changes), AUD-004 (reputation lineage).
**Dependencies consumed:** NET-W002 (identity/org/authz), NET-W003 (authority/idempotency/audit), NET-W005 (evidence/PoV), NET-W006 (outcomes/measurement), NET-W004 (contributions/workflow).

## 1. What shipped

The `/reputation` domain is the provider-neutral, multidimensional
reputation foundation:

```text
Evidence / Measurement / Verified Contribution   (NET-W005/006/004)
                  ↓  neutral structural lookups (composition root)
          Reputation Inputs                       (immutable, append-only,
                  ↓                                basis DERIVED)
       Deterministic Scoring Policy                (immutable, versioned)
                  ↓
        Time-Decay / Snapshot Engine               (PURE, explicit referenceAt)
                  ↓
       Multidimensional Reputation                 (append-only snapshots/history)
```

**The key rule (work order §2): reputation ≠ purchasable and
reputation ≠ economic ledger.** The input contract carries no field for
advertising spend, deposits, wealth, credits or raw activity volume;
every input requires ≥1 upstream record reference; model/self-only
backing is capped below a fully verified score; the domain issues no
credits, settles nothing, prices nothing, and mutates no other domain.

## 2. Changed files (implementation)

| Area | Files |
|---|---|
| Core vocabulary | `src/core/reputation.ts` (NEW), `src/core/index.ts` (barrel export) |
| Domain port | `src/reputation/port.ts` (entities, repositories ×3, neutral lookups ×5, services ×3) |
| Pure engine | `src/reputation/scoring.ts` (decay, per-dimension scoring, digests) |
| Services | `src/reputation/policy-service.ts`, `input-service.ts`, `snapshot-service.ts` |
| Persistence | `src/reputation/authority-policy-repository.ts`, `authority-input-repository.ts`, `authority-snapshot-repository.ts` (collections `reputation_scoring_policies`, `reputation_inputs`, `reputation_snapshots`) |
| Boundary | `src/reputation/module.ts` (non-skeletal, NET-W007), `index.ts`, `README.md` |
| Composition root | `src/bootstrap/runtime.ts` (5 neutral lookups over the wired identity/evidence/outcomes/contributions repositories; 3 services; 11 ApiCommands; 5 view helpers; Runtime fields) |
| API | `src/api/port.ts` (8 views + 3 inputs + 11 command methods), `src/api/server.ts` (11 routes + 3 parse helpers) |
| Tests | `tests/reputation/_net-w007-harness.ts` + 7 AC suites (53 tests) + `tests/regression/net-w007-ac-08-architecture-out-of-scope.test.ts` (10 tests) |
| Baselines | `tests/regression/ac-08-no-premature-domain-logic.test.ts` (NET_W007_DOMAINS), `net-w004-ac-08` (reputation leaves the deferred set), `net-w006-ac-08` (reputation implemented by NET-W007; settlement still skeletal) |
| Docs | this file + `spec/work-orders/NET-W007.md` |

## 3. Design decisions

1. **No workflow lifecycle for reputation entities.** Inputs, policies
   and snapshots are immutable/append-only — there is no state machine,
   so no `LifecycleSubjectKind` was added and `/workflows` is untouched
   (asserted by AC-08). Version semantics belong to policy lineages,
   not workflow versions.
2. **Idempotency via the NET-W004 primitive.** All three mutations
   (`createPolicyVersion`, `recordInput`, `recordSnapshot`) run through
   `IdempotencyStore.applyIdempotent`: the mutation, its audit record
   and the idempotency record commit in ONE authoritative transaction;
   the per-key lock serializes concurrent same-key calls (exactly-once).
3. **Policy versioning is caller-explicit and tuple-idempotent.** The
   `(policyId, version)` tuple is the idempotency key: retries replay
   the committed record; version must be exactly latest+1 (or 1 for a
   new lineage); a lineage cannot fork across organization scopes;
   existing versions are never rewritten so historical snapshots stay
   bit-for-bit reproducible.
4. **Derived basis (architecture-lock §4 made mechanical).** The input
   service resolves every source through neutral lookups and DERIVES
   `verified` (VERIFIED contribution/PoV/measured outcome, or
   platform/attested/provider evidence) vs `indicated` (model/self
   evidence, non-VERIFIED lifecycle records). Callers cannot assert a
   basis.
5. **The indicated-only cap.** With zero verified inputs a dimension
   scores at most `indicatedOnlyCap < maxScore` (validated) — raw
   activity and model output alone can never reach a fully verified
   score regardless of volume (AC-05/AC-07).
6. **Deterministic engine.** Pure functions; `referenceAt` is an
   explicit input everywhere (no wall clock); inputs after
   `referenceAt` are excluded (temporal scoping); fixed 6-decimal
   rounding; a SHA-256 digest over the canonical serialization makes
   reproducibility assertable.
7. **Neutral lookups over wired repositories.** The reputation domain
   imports core + self only; the composition root wires five thin
   adapters (identity existence, evidence sourceType+scope, PoV
   state+scope, measured-outcome state+scope, contribution
   state+scope) — the same dependency-inversion pattern as
   NET-W005/W006.

## 4. API surface (§3.6)

| Route | Guard | Notes |
|---|---|---|
| `POST /api/reputation/policies` | `reputationPolicy.create` | create a versioned policy |
| `GET /api/reputation/policies/:id` | public | fetch by record id |
| `GET /api/reputation/policies/:policyId/versions` | public | lineage listing |
| `POST /api/reputation/inputs` | `reputationInput.create` | record an input (≥1 source) |
| `GET /api/reputation/inputs/:id` | public | fetch an input |
| `GET /api/reputation/subjects/:personId/inputs` | public | subject listing |
| `GET /api/reputation/subjects/:personId/scores` | public | deterministic compute preview |
| `POST /api/reputation/snapshots` | `reputationSnapshot.create` | record a snapshot |
| `GET /api/reputation/snapshots/:id` | public | fetch a snapshot |
| `GET /api/reputation/subjects/:personId/snapshots` | public | history (oldest → newest) |
| `GET /api/reputation/subjects/:personId/snapshots/latest` | public | latest snapshot |

## 5. Acceptance criteria → automated verification

| AC | Requirement | Test file | Key assertions |
|---|---|---|---|
| AC-01 | Dimensions first-class, independent, reconstructable | `tests/reputation/net-w007-ac-01-dimensions.test.ts` (7 tests) | frozen 8-dimension vocabulary; full-coverage policy validation (partial/duplicate rejected); always-all-eight score emission in vocabulary order; mechanical independence (inputs to one dimension never move another); first-class persisted inputs; snapshot reconstructability from (inputIds, policyVersion, referenceAt) reproducing exact scores + digest; ordered history |
| AC-02 | Deterministic, policy/version aware, reproducible | `tests/reputation/net-w007-ac-02-determinism.test.ts` (7 tests) | bit-identical repeated computations (digest); snapshot digest = pure-engine digest; v2 changes scoring while the v1 snapshot recomputes exactly against version 1; monotonic versioning with tuple-idempotent replay; cross-scope fork rejected; 6-decimal rounding stability (0.5^(1/3) exact); referenceAt part of the digest |
| AC-03 | Evidence/verified-value provenance retained | `tests/reputation/net-w007-ac-03-provenance.test.ts` (7 tests) | empty sources rejected; nonexistent source rejected per kind; cross-org source rejected; exhaustive DERIVED basis table (VERIFIED contribution/PoV/measured outcome/platform/attested/provider vs DRAFT contribution/model/self, mixed); audit events carry sources + basis + inputIds + digest + policyVersion + the AUTHORITATIVE transactionId; material score deltas trace to the exact added inputs |
| AC-04 | Deterministic time decay (no wall-clock races) | `tests/reputation/net-w007-ac-04-decay.test.ts` (9 tests) | exact half-life values (0.5^(elapsed/halfLife)); fail-closed invalid inputs; future-reference clamp; exact decayed scores (90-day-old input at half-life 90 → exactly 0.5 weight); temporal scoping (future inputs excluded); fixed referenceAt math (t0 vs t0+90d → 1 vs 0.5); occurredAt anchor independent of recordedAt; per-dimension versioned half-lives |
| AC-05 | Spend/wealth/raw activity cannot buy reputation | `tests/reputation/net-w007-ac-05-non-purchasable.test.ts` (7 tests) | no economic field in the persisted contract (smuggled spend/wealth/credit fields dropped; exact key set asserted); empty-sources rejection; 80-input raw-activity volume capped at exactly indicatedOnlyCap=10; indicatedOnlyCap < maxScore validated; 12 verified + 80 indicated → exact composed score 32; non-VERIFIED contribution volume capped; score shape is trust-only (no economic units) |
| AC-06 | Authorized, idempotent, concurrent-safe, authoritative, audit-atomic | `tests/reputation/net-w007-ac-06-atomicity-concurrency.test.ts` (10 tests) | deny-by-default API guard on all 3 mutation endpoints (unauthenticated + authenticated-without-policy → 403, with policies → 201); same-key input/snapshot replay (one record, one audit event); concurrent same-key recordings → exactly one mutation; concurrent different-key snapshots → both persist in order; in-tx audit append failure rolls back EVERYTHING (no record, no idempotency record; retry after healing succeeds); post-commit publication failure retains pending audit for recovery (durable commit never undone); authoritative transactionId lineage + revision round-trip through the authority store |
| AC-07 | Provider/model inputs neutral + non-authoritative | `tests/reputation/net-w007-ac-07-neutrality.test.ts` (7 tests) | model evidence → indicated at 0.25 weight; 120 model/self inputs alone capped at 10 (< 100); one verified source upgrades the basis; provider evidence verified-grade with identical scoring for 3 different providers (kind+id refs only); domain imports ONLY core+self; no other domain imports reputation (leaf); model-only inputs stay indicated across dimensions |
| AC-08 | Architecture/out-of-scope regression | `tests/regression/net-w007-ac-08-architecture-out-of-scope.test.ts` (10 tests) | arch:check 0 violations; frozen specs unchanged with the reputation invariants still declared (lock 1.4/1.8/13.22); work order binds to v1.0 + Issue #13 + REP-001..004; non-skeletal module; NO economic-authority patterns (issueCredit…participationCredit); no economic units in the port contract; core+self imports only; settlement still skeletal; NO reputation lifecycle subject added to /workflows; expected boundary files exist; frozen core vocabulary exports |

## 6. Verification summary

`bun run verify` (commit on this branch): exit 0.

- `tsc --noEmit`: PASS.
- `bun run arch:check`: PASS — 199 files scanned, 0 violations.
- `bun test`: **510 pass / 15 skip / 0 fail**, 5268 `expect()` calls,
  525 tests across 63 files (baseline after NET-W006: 445 pass / 460
  tests / 55 files → **+65 NET-W007 tests**, +8 files).
- The 15 skips are the pre-existing real-PostgreSQL/Redis integration
  tests that require service containers (CI runs them).

## 7. Out of scope (work order §5 — none introduced)

No Participation Credits/economic ledger (NET-W008), cash settlement,
ad campaign optimization, creator marketplace behaviour, helpfulness
pipeline (the `helpfulness` DIMENSION exists; the
Proof-of-Helpfulness workflow is NET-W012), fraud decisions
(NET-W009), challenges/disputes (NET-W010), portable reputation proofs
(NET-W031), external payments. Frozen specs untouched; the settlement
domain remains skeletal.
