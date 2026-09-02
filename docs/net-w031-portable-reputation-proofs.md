# NET-W031 Evidence Ledger — Portable reputation proofs

**Status:** REMEDIATED (PR #64 architect review — revocation portability flaw fixed) — verification gate GREEN (local) — awaiting architect re-review  
**Issue:** #63  
**Dependencies:** NET-W007 + NET-W029 merged/verified  
**Architecture:** v1.0 frozen (byte-identical)  
**Implementation branch:** `feat/net-w031-portable-reputation-proofs`

## PR #64 architect-review remediation (record of the fix)

The architect review found ONE merge-blocking flaw: `revokedAt`/
`revocationReason` were excluded from the signed canonical facts, so (a) a
revoked artifact could have its revocation fields stripped/reset while
retaining a valid signature, and (b) a portable artifact captured before
revocation remained cryptographically valid after the authoritative proof
was revoked (no tenant-state lookup exists on the portable path to catch
it). The remediation (same branch/PR, work-order constraints kept):

1. **The revocation representation is SIGNED.** The canonical input gains
   `proof:<id>`, `revoked-at:<none|ISO>` and `revocation-reason:<none|JSON>`
   lines — stripping, resetting or altering the revocation fields of a
   sealed artifact fails the signature check (`signature_mismatch`); the
   proof id is tamper-evident on every surface (re-labeling a captured
   artifact with another proof's id fails the signature check).
2. **Revocation RE-SEALS the record.** The one-way field mutation changes
   signed content, so the authority re-signs the canonical input including
   the revocation lines inside the SAME revocation transaction (the
   substantive facts never rewrite; a signer failure rolls the entire
   revocation back; re-revocation is still an idempotent no-op that keeps
   the seal). Every CURRENT presentation of a revoked proof carries an
   unforgeable revoked state.
3. **The presentation-side surface verifies a PRESENTED PAIR.** The holder's
   captured artifact is verified BOUND to the authority's CURRENT sealed
   record of the same proof (an explicit input obtained via the existing
   guarded presentation read — NEVER a verification-time lookup; the
   verification function performs ZERO tenant-state queries). The fixed
   pipeline: the presented artifact's own gates → pair binding
   (identical substantive facts; `proof_pair_mismatch` otherwise) → the
   current record's own gates. **The current record's SIGNED one-way
   revocation state governs: a captured pre-revocation artifact can never
   subsequently return `verified` once the proof is revoked** (the
   architect's demanded acceptance case, covered in AC-03 and end-to-end
   over HTTP in AC-07 and over the real PostgreSQL adapter in the round-trip
   script).

## Evidence plan → evidence delivered

| Area | Required proof | Delivered |
|---|---|---|
| Proof model | derived, self-contained, tenant-scoped portable reputation proofs (aggregate facts + W029 signed envelope) | ✅ AC-01 (8 tests): issuance round-trips through the composed machinery; facts bit-identical to the STORED snapshot values (frozen 8-dimension order); lineage bound; explicit + latest snapshot resolution; re-issuance = NEW record; REAL Ed25519 composition; the six-field aggregate shape |
| Aggregate disclosure | aggregate/scoped facts only; no raw personal activity, no payloads, no cross-tenant data | ✅ AC-02 (7 tests): the stored record, the presented projection AND the canonical input contain no upstream ids / descriptions / occurredAt / decayed weights / execution lineage on the surface; canonical line discipline (exactly 19 lines: header + proof id + facts + 8 dimensions + the two SIGNED revocation lines; closed prefix set); cross-scope + subject-mismatch fail closed; SENSITIVE payload containment; counts-only lineage |
| Verification | deterministic, non-mutating, fail-closed with machine-readable closed-vocabulary reasons | ✅ AC-03 (21 tests): byte-identical repeated verdicts on BOTH surfaces; BOTH check pipelines pinned (the single-artifact authority-side pipeline AND the presentation-side pair pipeline: presented:* gates → pair_binding → current:* gates); the tamper matrix (proof id/subject/scope/score/counts/capped/lineage/issuedAt/signature — guaranteed-different-nibble; algorithm/keyReference/pairing; malformed shapes with field-level detail; revoked; stale; pre-issuance evaluation); **THE PR #64 REMEDIATION CASES** (captured-before-revocation artifact can never subsequently return `verified`; revocation-representation strip/reset → signature_mismatch; mismatched pairs → proof_pair_mismatch; re-labeled ids → signature_mismatch); verification mutates + audits NOTHING; SELF-CONTAINED presentation (a pure derivation over the presented pair — deleting the stored record changes nothing) |
| Non-purchasability | spend/wealth never alters disclosed dimension state through any proof path | ✅ AC-04 (4 tests): the issuance input surface is structurally fact-free (source pin); extra caller fields cannot alter the derivation; issuance mutates NO economic and NO reputation authority state (collection counts); a 1,000,000-unit matured value changes NOTHING about subsequently derived facts |
| Time-decay consistency | disclosed scores equal the authority's own deterministic decayed values at issuance | ✅ AC-05 (4 tests): bit-identical disclosure + digest lineage; one-half-life separation with per-snapshot disclosure; the verification time NEVER enters the signed facts (no `evaluatedAt` line) and never alters the disclosure; the decay anchor flows through the authority's engine exactly; authority-side recompute reproduces the snapshot digest |
| Evidence lineage | proofs reference authoritative input/evidence lineage ids opaquely (REP-004) | ✅ AC-06 (5 tests): counts match the authority's snapshot counts AND the recorded upstream inputs (each with ≥1 verified source); the lineage tuple is BOUND INTO the signature; the ONLY lineage ids are snapshot + policy; supersession = re-issuance (new evidence → new snapshot → NEW proof with incremented counts; the OLD proof unchanged + still verifies); exact policy-version binding |
| Tenancy/auth | tenant-scoped issuance; guard-action authorization; no existence oracles | ✅ AC-07 (8 tests): all five routes deny-by-default (403 unauth + authed); full guarded round-trip via HTTP (issue → read → verify by id → verify presented PAIR → revoke → **the captured pre-revocation copy re-verified over HTTP with the current record → proof_revoked**); cross-tenant reads/revocations fail closed and are indistinguishable from nonexistent ids at BOTH surfaces (W029 message-shape discipline); symmetric isolation; precise subject-binding error; the pair body requires BOTH artifacts (proof + currentProof — precise 400s) |
| Idempotency/atomicity | composite idempotency, one authoritative transaction, transactional audit, fault injection | ✅ AC-08 (10 tests): deterministic same-key replay (one record + one audit event); concurrent same-key → one record; different keys append; SIGNER failure at issuance rolls back entirely (no record/audit/idempotency consumption — retry succeeds); AUDIT-append failure rolls back entirely; ONE-WAY revocation (no-op re-revoke, audited once, concurrent revocations → one event); **revocation RE-SEALS the record** (envelope changes, facts never rewrite, re-revoke keeps the seal — the PR #64 remediation); **SIGNER failure at revocation rolls the ENTIRE revocation back** (the proof stays live and verifiable; the retry re-seals); staleness is verification-time only (verdict flips without store mutation) |
| Mutation evidence | targeted mutations must be caught by acceptance tests | ✅ 15/15 caught (M1 signature-gate bypass; M2 staleness-gate removal; M3 shape-gate removal; M4 revocation-gate removal; M5 tenant-scope removal; M6 issuedAt unsigned; M7 counts unsigned; M8 lineage block unsigned; M9 one-way revocation removal; M10 aggregate-disclosure leak; **M11 revocation lines unsigned (PR #64); M12 re-seal removal (PR #64); M13 pair-governing removal (PR #64); M14 pair-binding removal (PR #64); M15 proof-id line unsigned (PR #64)**) — 18 mutation-target runs, final green over all 9 suites, byte-identical restores, clean tree (driver lives outside the repo, `opencon-tmp/w031-mutation-driver.py`) |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration | ✅ see the verification record below |

## Acceptance map

| AC | Suite (path) | Tests |
|---|---|---|
| AC-01 proof model | `tests/reputation/net-w031-ac-01-proof-model.test.ts` | 8 |
| AC-02 aggregate disclosure | `tests/reputation/net-w031-ac-02-aggregate-disclosure.test.ts` | 7 |
| AC-03 deterministic verification | `tests/reputation/net-w031-ac-03-deterministic-verification.test.ts` | 21 |
| AC-04 non-purchasable | `tests/reputation/net-w031-ac-04-non-purchasable.test.ts` | 4 |
| AC-05 decay consistency | `tests/reputation/net-w031-ac-05-decay-consistency.test.ts` | 4 |
| AC-06 evidence lineage | `tests/reputation/net-w031-ac-06-evidence-lineage.test.ts` | 5 |
| AC-07 tenancy/authorization | `tests/reputation/net-w031-ac-07-tenancy-authorization.test.ts` | 8 |
| AC-08 atomicity/concurrency | `tests/reputation/net-w031-ac-08-atomicity-concurrency.test.ts` | 10 |
| AC-09 architecture/out-of-scope regression | `tests/regression/net-w031-ac-09-architecture-out-of-scope.test.ts` | 13 |
| (harness) | `tests/reputation/_net-w031-harness.ts` | — |

**80 tests** across the nine W031 suites (75 at the original PR head + the 5 remediation tests: AC-03 +3, AC-08 +2).

## Verification record (executed on the remediation head)

- `bun run typecheck` — **PASS** (0 errors, `noUncheckedIndexedAccess` strictness included).
- `bun run arch:check` — **PASS: 312 files scanned, 0 violations.**
- `bun run authority:check` — **PASS: 312 files scanned, 0 violations.**
- `bun run verify` (the canonical local gate) — **PASS: 1996 pass / 15 skip / 0 fail — 2011 tests / 256 files / 25,900 expect()** (baseline before W031: 1916/15/0 / 1931 tests / 247 files ⇒ +80 tests / +9 files, zero regressions; the original PR head: 1991/15/0 / 2006 ⇒ +5 remediation tests; the 15 skips are the service-conditional integration tests).
- Mutation driver — **15/15 caught (18 mutation-target runs — the original M1–M10 plus the PR #64 gates M11–M15); final green over all nine W031 suites; byte-identical restores; clean tree** (never committed; `opencon-tmp/w031-mutation-driver.py`).
- Secret scan — the W031 files carry no key material (AKIA/sk-/ghp_/PEM patterns); **no new secret or configuration surface** (`REQUIRED_IN_PRODUCTION` unchanged: DATABASE_URL, REDIS_URL, OBJECT_STORAGE_BUCKET; no `REPUTATION_PROOF*KEY` names in schema or `.env.example`).
- **Configured real PostgreSQL/Redis integration** — real PostgreSQL 17.11 + Redis 8.0 provisioned locally for this verification run (the docker-compose ports):
  - `bun test tests/integration/` with `PG_TEST_DATABASE_URL` + `REDIS_TEST_URL`: **17 pass / 0 fail** (7 real PG authority + 7 real Redis coordination + 3 canaries) — the exact adapter contract every W031 collection write goes through.
  - **W031-specific real-PostgreSQL end-to-end round-trip, INCLUDING the PR #64 remediation cases** (one-off script, never committed): issuance → idempotent replay over the real idempotency store (same record, `created=false`) → stored verdict `verified` → presented-PAIR verdict `verified` → stale verdict `proof_stale` → one-way revocation **with the re-seal (signature rotates, facts never rewrite)** → post-revocation stored verdict `proof_revoked` → **the CAPTURED pre-revocation artifact paired with the current sealed record → `proof_revoked`** → **the stripped-revocation tamper copy → `signature_mismatch` (as presented AND as current)**. **PASS.** The CI integration job re-provisions the same real services on every push/PR.
- CI — recorded in the PR discussion after the push (verify + integration jobs, both events).

## Design decisions of record

1. **Placement** — W031 extends `/reputation` (the SOLE reputation authority, no 18th domain): `proof-input.ts` (pure canonical discipline), `proof-service.ts` (derivation/presentation/verification), `authority-proof-repository.ts` (`reputation_proofs` collection), plus the additive W031 contract section on the existing port. The W007 engine, services and contracts are untouched.
2. **Composition, never re-implementation** — the reputation port declares the NEUTRAL `ReputationProofSigner` / `ReputationProofVerifier` / `ReputationProofSigningVocabulary` contracts; the bootstrap root is the ONLY join, adapting the SAME `versionedAttestationSigning` pair selected for the W029 surface and injecting W029's frozen vocabularies as data (single source of truth — no mirrored constants to drift; a new algorithm id remains a W029 frozen-vocabulary change).
3. **Two verification surfaces** — authority-side (`verifyProof` by id: the current stored, re-sealed record) and presentation-side (`verifyPresentedProof`: the PRESENTED PAIR — the holder's captured artifact bound to the authority's CURRENT sealed record — ZERO tenant-state queries on the verification path; work order §3.3; the PR #64 remediation). Both share the ONE fixed fail-closed single-artifact pipeline (revocation → shape → algorithm → key-reference → pairing → signature → staleness) and the ONE closed reason vocabulary; the pair surface qualifies its checks (`presented:*`, `pair_binding`, `current:*`) and adds `proof_pair_mismatch` for unbound pairs.
4. **"Grades" interpretation** — W007 defines no grade vocabulary; the disclosed per-dimension authority state is exactly `{score, capped, inputCount, verifiedInputCount, indicatedInputCount}` (the work order's "dimension scores/grades as the authority's own time-decayed values" + "evidence-reference counts as opaque lineage references"). The decayed weight internals are deliberately NOT disclosed (minimal aggregate projection).
5. **Staleness** — a verification-time derivation over the SIGNED issuance timestamp within the frozen 30-day window (`0 <= evaluatedAt - issuedAt <= window`; the pre-issuance direction fails closed too). `evaluatedAt` is an explicit required input — no wall clock anywhere on the verification path (determinism). Supersession of source state is governed by re-issuance + staleness, NOT by tenant-state queries: snapshots are immutable (cannot become invalid), and the self-containment requirement forbids verification-time tenant lookups.
6. **Revocation** — the W029 one-way field-mutation discipline (`revokedAt`/`revocationReason`; idempotent re-revocation; per-record mutex; audited once; not a lifecycle transition; `/workflows` untouched) **with the SIGNED revocation representation and the transactional re-seal (the PR #64 remediation)**: the canonical input signs `proof:<id>` + `revoked-at:` + `revocation-reason:`, and the authority re-seals the record inside the revocation transaction (a signer failure rolls the entire revocation back; the retry re-seals). A revoked proof NEVER verifies again on any surface: by id (authority), and portably (any capture paired with the current sealed record).
7. **Presented-proof transport tolerance** — the API parser normalizes untyped JSON across the typed boundary with fail-closed sentinels (""/-1/non-boolean→false) for BOTH artifacts of the pair (the presented copy AND the current sealed record); the DOMAIN shape validator + signature checks are the authority on malformed/tampered artifacts (`malformed_proof` with field-level detail, never a silent accept); a body missing either artifact is a precise 400.
8. **API surface** — five guarded routes under `/api/reputation/proofs` (create / read / verification / presented-verification / revocation; guard actions `reputationProof.create|read|verify|revoke`; the exact-match presented-verification route is matched BEFORE the `:id` routes). Cross-tenant and nonexistent ids are indistinguishable at every surface.
9. **Sanctioned shared-file amendments** (additive, pinned by AC-09): the W007 harness forwards the attestation adapters (the W005-harness precedent); the snapshot repository gains the in-tx `listBySubjectWithinTx` twin (the committed/in-tx discipline); `module.ts`/`ReputationPort` carry the additive proof vocabulary; `scoring.ts` is byte-identical to its W007 form.

## Architectural invariants

- No second reputation authority; no raw private record transfer (PRIV-001..002).
- No new cryptographic primitives or signing surfaces — the W029 machinery is composed, not extended.
- Aggregate disclosure only under the aggregate disclosure gate (PRIV-003).
- Non-purchasable reputation (REP-002); time decay at derivation (REP-003); evidence lineage via opaque references (REP-004).
- No decentralized validation (W032); no end-to-end flows (W033+).
- Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.
