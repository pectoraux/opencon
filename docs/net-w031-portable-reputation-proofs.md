# NET-W031 Evidence Ledger — Portable reputation proofs

**Status:** IMPLEMENTED — verification gate GREEN (local) — PR pending architect review  
**Issue:** #63  
**Dependencies:** NET-W007 + NET-W029 merged/verified  
**Architecture:** v1.0 frozen (byte-identical)  
**Implementation branch:** `feat/net-w031-portable-reputation-proofs`

## Evidence plan → evidence delivered

| Area | Required proof | Delivered |
|---|---|---|
| Proof model | derived, self-contained, tenant-scoped portable reputation proofs (aggregate facts + W029 signed envelope) | ✅ AC-01 (8 tests): issuance round-trips through the composed machinery; facts bit-identical to the STORED snapshot values (frozen 8-dimension order); lineage bound; explicit + latest snapshot resolution; re-issuance = NEW record; REAL Ed25519 composition; the six-field aggregate shape |
| Aggregate disclosure | aggregate/scoped facts only; no raw personal activity, no payloads, no cross-tenant data | ✅ AC-02 (7 tests): the stored record, the presented projection AND the canonical input contain no upstream ids / descriptions / occurredAt / decayed weights / execution lineage on the surface; canonical line discipline (exactly 16 lines, sanctioned prefixes); cross-scope + subject-mismatch fail closed; SENSITIVE payload containment; counts-only lineage |
| Verification | deterministic, non-mutating, fail-closed with machine-readable closed-vocabulary reasons | ✅ AC-03 (18 tests): byte-identical repeated verdicts on BOTH surfaces; checks pipeline pinned (revocation → proof_shape → algorithm → key-reference → pairing → signature → staleness); the tamper matrix (subject/scope/score/counts/capped/lineage/issuedAt/signature — guaranteed-different-nibble; algorithm/keyReference/pairing; malformed shapes with field-level detail; revoked; stale; pre-issuance evaluation); verification mutates + audits NOTHING; SELF-CONTAINED presentation (deleting the stored record changes nothing for the presented verdict) |
| Non-purchasability | spend/wealth never alters disclosed dimension state through any proof path | ✅ AC-04 (4 tests): the issuance input surface is structurally fact-free (source pin); extra caller fields cannot alter the derivation; issuance mutates NO economic and NO reputation authority state (collection counts); a 1,000,000-unit matured value changes NOTHING about subsequently derived facts |
| Time-decay consistency | disclosed scores equal the authority's own deterministic decayed values at issuance | ✅ AC-05 (4 tests): bit-identical disclosure + digest lineage; one-half-life separation with per-snapshot disclosure; the verification time NEVER enters the signed facts (no `evaluatedAt` line) and never alters the disclosure; the decay anchor flows through the authority's engine exactly; authority-side recompute reproduces the snapshot digest |
| Evidence lineage | proofs reference authoritative input/evidence lineage ids opaquely (REP-004) | ✅ AC-06 (5 tests): counts match the authority's snapshot counts AND the recorded upstream inputs (each with ≥1 verified source); the lineage tuple is BOUND INTO the signature; the ONLY lineage ids are snapshot + policy; supersession = re-issuance (new evidence → new snapshot → NEW proof with incremented counts; the OLD proof unchanged + still verifies); exact policy-version binding |
| Tenancy/auth | tenant-scoped issuance; guard-action authorization; no existence oracles | ✅ AC-07 (8 tests): all five routes deny-by-default (403 unauth + authed); full guarded round-trip via HTTP (issue → read → verify by id → verify presented → revoke); cross-tenant reads/revocations fail closed and are indistinguishable from nonexistent ids at BOTH surfaces (W029 message-shape discipline); symmetric isolation; precise subject-binding error |
| Idempotency/atomicity | composite idempotency, one authoritative transaction, transactional audit, fault injection | ✅ AC-08 (8 tests): deterministic same-key replay (one record + one audit event); concurrent same-key → one record; different keys append; SIGNER failure rolls back entirely (no record/audit/idempotency consumption — retry succeeds); AUDIT-append failure rolls back entirely; ONE-WAY revocation (no-op re-revoke, audited once, concurrent revocations → one event); staleness is verification-time only (verdict flips without store mutation) |
| Mutation evidence | targeted mutations must be caught by acceptance tests | ✅ 10/10 caught (M1 signature-gate bypass; M2 staleness-gate removal; M3 shape-gate removal; M4 revocation-gate removal; M5 tenant-scope removal; M6 issuedAt unsigned; M7 counts unsigned; M8 lineage block unsigned; M9 one-way revocation removal; M10 aggregate-disclosure leak) — final green over all 9 suites, byte-identical restores, clean tree (driver lives outside the repo, `opencon-tmp/w031-mutation-driver.py`) |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration | ✅ see the verification record below |

## Acceptance map

| AC | Suite (path) | Tests |
|---|---|---|
| AC-01 proof model | `tests/reputation/net-w031-ac-01-proof-model.test.ts` | 8 |
| AC-02 aggregate disclosure | `tests/reputation/net-w031-ac-02-aggregate-disclosure.test.ts` | 7 |
| AC-03 deterministic verification | `tests/reputation/net-w031-ac-03-deterministic-verification.test.ts` | 18 |
| AC-04 non-purchasable | `tests/reputation/net-w031-ac-04-non-purchasable.test.ts` | 4 |
| AC-05 decay consistency | `tests/reputation/net-w031-ac-05-decay-consistency.test.ts` | 4 |
| AC-06 evidence lineage | `tests/reputation/net-w031-ac-06-evidence-lineage.test.ts` | 5 |
| AC-07 tenancy/authorization | `tests/reputation/net-w031-ac-07-tenancy-authorization.test.ts` | 8 |
| AC-08 atomicity/concurrency | `tests/reputation/net-w031-ac-08-atomicity-concurrency.test.ts` | 8 |
| AC-09 architecture/out-of-scope regression | `tests/regression/net-w031-ac-09-architecture-out-of-scope.test.ts` | 13 |
| (harness) | `tests/reputation/_net-w031-harness.ts` | — |

**75 tests / 1,518 expect() calls** across the nine W031 suites.

## Verification record (executed on the implementation head)

- `bun run typecheck` — **PASS** (0 errors, `noUncheckedIndexedAccess` strictness included).
- `bun run arch:check` — **PASS: 312 files scanned, 0 violations.**
- `bun run authority:check` — **PASS: 312 files scanned, 0 violations.**
- `bun run verify` (the canonical local gate) — **PASS: 1991 pass / 15 skip / 0 fail — 2006 tests / 256 files** (baseline before W031: 1916/15/0 / 1931 tests / 247 files ⇒ +75 tests / +9 files, zero regressions; the 15 skips are the service-conditional integration tests).
- Mutation driver — **10/10 caught; final green over all nine W031 suites; byte-identical restores; clean tree** (never committed; `opencon-tmp/w031-mutation-driver.py`).
- Secret scan — the W031 files carry no key material (AKIA/sk-/ghp_/PEM patterns); **no new secret or configuration surface** (`REQUIRED_IN_PRODUCTION` unchanged: DATABASE_URL, REDIS_URL, OBJECT_STORAGE_BUCKET; no `REPUTATION_PROOF*KEY` names in schema or `.env.example`).
- **Configured real PostgreSQL/Redis integration** — real PostgreSQL 17.11 + Redis provisioned locally for this verification run (the docker-compose ports):
  - `bun test tests/integration/` with `PG_TEST_DATABASE_URL` + `REDIS_TEST_URL`: **17 pass / 0 fail** (7 real PG authority + 7 real Redis coordination + 3 canaries) — the exact adapter contract every W031 collection write goes through.
  - **W031-specific real-PostgreSQL end-to-end round-trip** (one-off script, never committed): issuance → idempotent replay over the real idempotency store (same record, `created=false`) → stored verdict `verified` → presented verdict `verified` → stale verdict `proof_stale` → one-way revocation → post-revocation verdict `proof_revoked`. **PASS.** The CI integration job re-provisions the same real services on every push/PR.
- CI — recorded in the PR discussion after the push (verify + integration jobs, both events).

## Design decisions of record

1. **Placement** — W031 extends `/reputation` (the SOLE reputation authority, no 18th domain): `proof-input.ts` (pure canonical discipline), `proof-service.ts` (derivation/presentation/verification), `authority-proof-repository.ts` (`reputation_proofs` collection), plus the additive W031 contract section on the existing port. The W007 engine, services and contracts are untouched.
2. **Composition, never re-implementation** — the reputation port declares the NEUTRAL `ReputationProofSigner` / `ReputationProofVerifier` / `ReputationProofSigningVocabulary` contracts; the bootstrap root is the ONLY join, adapting the SAME `versionedAttestationSigning` pair selected for the W029 surface and injecting W029's frozen vocabularies as data (single source of truth — no mirrored constants to drift; a new algorithm id remains a W029 frozen-vocabulary change).
3. **Two verification surfaces** — authority-side (`verifyProof` by id: current stored revocation state) and presentation-side (`verifyPresentedProof`: the self-contained portable artifact, ZERO tenant-state queries — work order §3.3). Both share ONE fixed fail-closed pipeline and ONE closed reason vocabulary.
4. **"Grades" interpretation** — W007 defines no grade vocabulary; the disclosed per-dimension authority state is exactly `{score, capped, inputCount, verifiedInputCount, indicatedInputCount}` (the work order's "dimension scores/grades as the authority's own time-decayed values" + "evidence-reference counts as opaque lineage references"). The decayed weight internals are deliberately NOT disclosed (minimal aggregate projection).
5. **Staleness** — a verification-time derivation over the SIGNED issuance timestamp within the frozen 30-day window (`0 <= evaluatedAt - issuedAt <= window`; the pre-issuance direction fails closed too). `evaluatedAt` is an explicit required input — no wall clock anywhere on the verification path (determinism). Supersession of source state is governed by re-issuance + staleness, NOT by tenant-state queries: snapshots are immutable (cannot become invalid), and the self-containment requirement forbids verification-time tenant lookups.
6. **Revocation** — the W029 one-way field-mutation discipline (`revokedAt`/`revocationReason`; idempotent re-revocation; per-record mutex; audited once). Not a lifecycle transition; `/workflows` untouched.
7. **Presented-proof transport tolerance** — the API parser normalizes untyped JSON across the typed boundary with fail-closed sentinels (""/-1/non-boolean→false); the DOMAIN shape validator + signature check are the authority on malformed/tampered artifacts (`malformed_proof` with field-level detail, never a silent accept).
8. **API surface** — five guarded routes under `/api/reputation/proofs` (create / read / verification / presented-verification / revocation; guard actions `reputationProof.create|read|verify|revoke`; the exact-match presented-verification route is matched BEFORE the `:id` routes). Cross-tenant and nonexistent ids are indistinguishable at every surface.
9. **Sanctioned shared-file amendments** (additive, pinned by AC-09): the W007 harness forwards the attestation adapters (the W005-harness precedent); the snapshot repository gains the in-tx `listBySubjectWithinTx` twin (the committed/in-tx discipline); `module.ts`/`ReputationPort` carry the additive proof vocabulary; `scoring.ts` is byte-identical to its W007 form.

## Architectural invariants

- No second reputation authority; no raw private record transfer (PRIV-001..002).
- No new cryptographic primitives or signing surfaces — the W029 machinery is composed, not extended.
- Aggregate disclosure only under the aggregate disclosure gate (PRIV-003).
- Non-purchasable reputation (REP-002); time decay at derivation (REP-003); evidence lineage via opaque references (REP-004).
- No decentralized validation (W032); no end-to-end flows (W033+).
- Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.
