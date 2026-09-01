# NET-W029 Evidence Ledger — Cryptographic attestations and commitments

**Status:** ACTIVE (implementation complete — verification green; awaiting architect review + merge)  
**Issue:** #58  
**Dependencies:** NET-W005 + NET-W007 + NET-W008 merged/verified  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w029-cryptographic-attestations`

## Evidence plan

| Area | Required proof |
|---|---|
| Foundation reuse | W005 commitments + the "attestation/v1" canonical-input discipline extended, never rewritten |
| Signed attestations | production asymmetric algorithms (Ed25519 / ECDSA P-256 via node:crypto); closed versioned algorithm + key-reference vocabularies; keys via SecretProvider only, fail closed |
| Coverage | attestations/commitments over evidence + reputation inputs + settlement value records (neutral read lookups) |
| Determinism | identical state ⇒ identical verdicts; reproducible canonical input from STORED digests |
| Tamper evidence | mutated payload/statement/covered-set/signature/algorithm/key fails closed with machine-readable reason |
| Privacy | commitments bind without plaintext; disclosure only under frozen privacy rules (PRIV-003) |
| Tenancy/auth | cross-tenant and unauthorized access fails closed without existence oracles |
| Atomicity | material mutations idempotent, concurrency-safe, atomically audited |
| Authority containment | an attestation never mints/mutates/resurrects authoritative state; PostgreSQL authoritative |
| Mutation evidence | targeted mutations must be caught by acceptance tests |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration |

## Acceptance map

AC-01 — attestation/commitment records over the three authoritative record families  
AC-02 — signed attestations: versioned algorithms + SecretProvider key references  
AC-03 — deterministic verification + tamper detection  
AC-04 — commitment privacy preservation  
AC-05 — privacy + tenancy + authorization  
AC-06 — idempotency/concurrency/atomicity + fault injection  
AC-07 — authority containment (PostgreSQL authoritative; no consensus/external execution)  
AC-08 — architecture/out-of-scope regression and W030+/W031/W032 deferrals

## Architectural invariants

- No new semantic authority; no 17th domain (the SAME frozen `/evidence` boundary W005 created).
- No consensus layer, no blockchain/network validation, no token economics.
- No external payment/settlement adapters; no portable reputation proofs.
- Keys only through `SecretProvider`; no committed key material.
- An attestation never resurrects revoked/invalidated/superseded authoritative state.
- Frozen architecture and lock unchanged.

## Verification summary

| Gate | Result |
|---|---|
| `bun run typecheck` | **GREEN** |
| `bun run arch:check` | **GREEN** (304 files / 0 violations) |
| `bun run authority:check` | **GREEN** (304 files / 0 violations) |
| `bun test` | **GREEN — 1858 pass / 15 skip / 0 fail / 23,556 expect() / 1873 tests / 239 files** (W028 baseline 1783/15/0/1798/231 → +75 tests, +8 files) |
| Secret scan (W029 files + signing + config + .env.example) | **CLEAN** |
| Mutation checks (9 directions) | **9/9 CAUGHT** |
| Real PostgreSQL/Redis integration | CI integration job (postgres:17 + redis:7 service containers) |

## Architectural guardrails (verified)

- `/evidence` is the EXISTING frozen boundary — W029 EXTENDS it; `spec/architecture.md`/`spec/architecture-lock.md` unchanged; 304 files / 0 arch+authority violations; the W005 contracts (`Attestation`/`AttestationSigner`/`AttestationVerifier`, `buildAttestationDigestInput`'s "attestation/v1" discipline, `commitments.ts` salted sha256/sha512 + constant-time comparison) are byte-preserved and behaviorally pinned (AC-08 imports and exercises them).
- `/reputation` and `/settlement` keep their authorities untouched — their records are covered read-only through the neutral `ReputationInputCoverageLookup` / `SettlementValueCoverageLookup` (committed + WithinTx twins) wired at the composition root over the owners' OWN repositories; neither port gains a signed-attestation surface; `/workflows` is not extended (revocation is a ONE-WAY field mutation — the W028 closure precedent).
- Production signature algorithms are REAL asymmetric cryptography — Ed25519 and ECDSA P-256 via `node:crypto`, constructed ONLY in the composition root (`src/bootstrap/attestation-signing.ts`) behind the injected `SignedAttestationSigner`/`SignedAttestationVerifier` interfaces; key material resolves ONLY through the `SecretProvider` (`ATTESTATION_SIGNING_ED25519_PRIVATE_KEY` / `ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY`, PKCS#8 PEM) and is validated at construction (asymmetric key type + a sign/verify probe) so unusable material fails startup, not first-sign.
- Algorithm identifiers (`ed25519/v1`, `ecdsa-p256/v1`, `hmac-sha256/v1`) and key references (`attestation-signing/{ed25519,ecdsa-p256,hmac,dev-insecure}/v1`) form CLOSED, VERSIONED vocabularies with a frozen pairing map — pinned in AC-08; the dev-only HMAC default stays clearly-marked (`attestation-signing/dev-insecure/v1`) and is never selected in production/staging.
- The default production algorithm is `hmac-sha256` (existing configured deployments keep booting unchanged — the W005 remediation contract); operators opt IN to the asymmetric algorithms via `ATTESTATION_SIGNING_ALGORITHM` + the algorithm-specific private-key secret; every unresolvable combination FAILS CLOSED with `ProviderConfigurationError`.
- The canonical input is `"attestation/v2"` (statement + verifier + algorithm + key reference + sorted coverage lines built from the STORED digests) — rebuilt identically at signing and verification, NEVER from plaintext (PRIV-003); the coverage commitments are salted sha256 commitments over the canonical facts of the covered records (the W005 primitive reused).
- The settlement_value coverage facts bind the SUBSTANTIVE content only (beneficiary, amount, sources, maturation, recognition lineage) — the mutable lifecycle bookkeeping (state, version, maturedAt, consumedBy, reversal) AND the per-write lineage stamps are deliberately excluded: legitimate lifecycle progression (PENDING → MATURE → CONSUMED) does not invalidate a sound attestation, while lifecycle invalidation (REVERSED) is caught by the explicit current-state gate with the precise reason `covered_state_invalid` (an attestation never makes invalidated authoritative state verify as current).
- Verification is deterministic and fail-closed with a CLOSED machine-readable reason vocabulary (`SIGNED_ATTESTATION_VERIFICATION_REASONS`): revocation → algorithm vocabulary → key-reference vocabulary → pairing → signature → per-covered-record current-state + integrity re-derivation (constant-time commitment comparison); verification mutates and audits nothing (a derived read-only decision — the W028 evaluate precedent).
- Material mutations follow the established discipline: composite idempotency (`signed_attestation:{scope}:{verifier}:{key}`), ONE authoritative transaction (the applyIdempotent context transaction; the covered digests re-derive IN-tx), transactional audit buffering with post-commit publication, per-attestation mutex + composite-key idempotency for revocation; a failed apply leaves NO record, NO audit event and NO consumed idempotency key (fault-injected).
- Attestations are tenant-scoped: cross-tenant and nonexistent are INDISTINGUISHABLE at every surface (service + HTTP; 404 with the same error code and caller-id-echoing message); creation/verification follow the guard-action pattern (`signedAttestation.create|read|verify|revoke` — server-resolved actor).
- Revocation is ONE-WAY (a field mutation; idempotent; exactly one audit event); a revoked attestation NEVER verifies again.
- W030+ external settlement adapters, W031+ portable reputation proofs, W032+ decentralized validation, external payment execution, consensus, token economics and AI authority are explicitly excluded (source-level bans + frozen vocabulary pins).

## Architectural decision record

1. **Requirement mapping** — EVID-006: the coverage commitments + the v2 canonical-input discipline over the three record families; PRIV-003: salted payload-hiding commitments, no plaintext on any record, no plaintext anywhere on the verification path.
2. **Two independent signing surfaces** — the W005 (v1, `attestation/v1` + `AttestationSigner`/`AttestationVerifier`) and the W029 (v2, `attestation/v2` + `SignedAttestationSigner`/`SignedAttestationVerifier`) surfaces are SEPARATE selections with SEPARATE adapter contracts; both fail closed in production; the default algorithm keeps the W005 HMAC path authoritative so existing deployments boot unchanged (the sanctioned amendment updates the one W005 boot test that supplied only a v1 pair: explicit production adapters now require the versioned pair too — a W005-only pair is incomplete crypto configuration).
3. **Coverage digests are server-derived, in-tx, salted sha256 commitments over canonical facts** — deterministic JSON (sorted keys), explicit per-family substantive projections; the salt is stored beside the digest so verification re-derives the CURRENT digest and compares in constant time (the W005 `verifyEvidenceCommitment` primitive — reused, never rewritten).
4. **The lifecycle/state dichotomy for settlement_value** — substantive content is committed; lifecycle state is GATED (REVERSED fails closed at creation AND at verification with `covered_state_invalid`; PENDING/MATURE/CONSUMED verify as current authoritative states). This is the precise embodiment of "an attestation can never make revoked, invalidated or superseded authoritative state verify as current".
5. **No algorithm/key caller surface** — the caller never asserts algorithms or key references; the ACTIVE pair is server-selected (bootstrap selection), and the service validates the signer's returned triple against the closed vocabularies fail-closed (defense in depth).
6. **Storage** — the `signed_attestations` authority collection; records immutable except the one-way revocation fields; the `evidence` repository gained the additive in-tx twin `findByIdWithinTx` (the only interface amendment to a W005 contract — additive, non-breaking, documented).

## Implementation shape

- `src/evidence/port.ts` — the ADDITIVE W029 contracts: the frozen vocabularies (algorithms, key references, pairing map, coverage families, verification reasons, bounds, record format), the coverage facts/lookup interfaces (reputation_input + settlement_value, committed + WithinTx twins), the `SignedAttestation` record + service + repository contracts, the versioned signer/verifier interfaces, the extended `EvidencePort` audit event types; the W005 contracts untouched; `EvidenceRepository.findByIdWithinTx` added (additive).
- `src/evidence/signed-attestation-input.ts` — the PURE v2 discipline: `canonicalJson` (deterministic serialization), the per-family canonical facts projections, `deriveCoverageCommitment` (the W005 commitment primitive), `buildSignedAttestationDigestInput` ("attestation/v2").
- `src/evidence/signed-attestation-service.ts` — creation (in-tx coverage re-derivation, fail-closed validation, vocabulary-validated signing, composite idempotency, atomic audit), tenant-scoped reads, deterministic fail-closed verification (closed reason vocabulary, per-record current-state + integrity checks), one-way idempotent revocation (per-attestation mutex + composite key).
- `src/evidence/authority-signed-attestation-repository.ts` — the `signed_attestations` authority repository.
- `src/bootstrap/attestation-signing.ts` — the VERSIONED selection: real Ed25519 / ECDSA P-256 signer/verifier factories (node:crypto, key validation + probe at construction), the versioned HMAC path, `selectVersionedAttestationSigning` (explicit adapters → algorithm-specific SecretProvider keys → dev default; fail closed in production/staging); the W005 selector untouched.
- Wiring: `src/bootstrap/runtime.ts` (repository + the two neutral coverage lookups over `reputationInputRepo`/`economicValueRepo` + the service + 4 apiCommands + `Runtime.signedAttestationService` + the extended `attestationSigning` diagnostics), `src/api/port.ts` (4 guarded commands + views), `src/api/server.ts` (4 routes under `/api/evidence/signed-attestations*`), `src/config/schema.ts` + `src/core/config.ts` + `src/config/provider.ts` + `.env.example` (the non-secret algorithm selector + the two classified private-key secrets).
- Tests: `tests/evidence/_net-w029-harness.ts` (W005-harness wrapper; cross-tenant org; REAL Ed25519/ECDSA adapter factories; direct-store tamper helpers) + AC-01..07 suites + `tests/regression/net-w029-ac-08-architecture-out-of-scope.test.ts`; sanctioned additive amendments: the W005 harness forwards versioned adapters, the provider-selection fixture carries the new snapshot field, the attestation-signing boot test pairs the versioned surface.
- The mutation driver lives OUTSIDE the repository (`opencon-tmp/w029-mutation-driver.py`).

## Evidence matrix (AC → suite → result)

| AC | Suite | Tests | Result |
|---|---|---:|---|
| AC-01 coverage records | `tests/evidence/net-w029-ac-01-coverage-records.test.ts` | 10 | PASS |
| AC-02 versioned algorithms + keys | `tests/evidence/net-w029-ac-02-signing-vocabulary.test.ts` | 10 | PASS |
| AC-03 deterministic verification + tamper | `tests/evidence/net-w029-ac-03-deterministic-verification.test.ts` | 14 | PASS |
| AC-04 commitment privacy | `tests/evidence/net-w029-ac-04-commitment-privacy.test.ts` | 7 | PASS |
| AC-05 privacy + tenancy (HTTP) | `tests/evidence/net-w029-ac-05-privacy-tenancy.test.ts` | 7 | PASS |
| AC-06 idempotency/concurrency/fault | `tests/evidence/net-w029-ac-06-idempotency-concurrency.test.ts` | 8 | PASS |
| AC-07 authority containment | `tests/evidence/net-w029-ac-07-authority-containment.test.ts` | 7 | PASS |
| AC-08 architecture/out-of-scope | `tests/regression/net-w029-ac-08-architecture-out-of-scope.test.ts` | 12 | PASS |

## Mutation evidence (9/9 caught)

| # | Mutation | Target | Result |
|---|---|---|---|
| M1 | Coverage digest derivation neutered (digest over empty facts) | AC-03 | CAUGHT |
| M2 | Verify-side algorithm vocabulary check removed | AC-03 | CAUGHT |
| M3 | Key-reference vocabulary + pairing validation removed | AC-03 | CAUGHT |
| M4 | Current-state/integrity re-derivation removed at verification | AC-03/AC-07 | CAUGHT |
| M5 | REVERSED-state containment gate removed | AC-07 | CAUGHT |
| M6 | Composite idempotency key randomized | AC-06 | CAUGHT |
| M7 | Tenant-scope check removed on the tenant-scoped load | AC-05 | CAUGHT |
| M8 | Revocation check removed at verification | AC-07 | CAUGHT |
| M9 | Signature verification bypassed (always valid) | AC-03 | CAUGHT |

Driver: `opencon-tmp/w029-mutation-driver.py` (outside the repository; cp-backup + assert-applied + assert-failed + restore + assert-reverted + final-green; working tree verified clean after each direction).

## Delivery record

(to be completed at PR delivery)

- Implementation head: `<filled at push>`
- PR: `<filled at open>`
- CI: `<filled at green>`
- Verification-status comment: `<filled at post>`
- Architect review decision-of-record: `<filled at review>`
- Post-merge durable state: `spec/PROJECT-STATE.md` + `spec/ROADMAP.md` advanced at the merge checkpoint
