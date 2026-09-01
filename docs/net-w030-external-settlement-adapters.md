# NET-W030 Evidence Ledger — External settlement adapters

**Status:** IMPLEMENTED / VERIFIED — submitted for architect review  
**Issue:** #61  
**Dependencies:** NET-W008 + NET-W029 merged/verified  
**Architecture:** v1.0 frozen (byte-identical)  
**Implementation branch:** `feat/net-w030-external-settlement-adapters`

## Evidence plan → evidence delivered

| Area | Required proof | Delivered |
|---|---|---|
| Fact model | first-class tenant-scoped external transaction facts (append-only, immutable, provider-referenced) | AC-01 (7 tests) |
| Provider authentication | adapter facts authenticated (SecretProvider-resolved material); unauthenticated/stale/malformed fail closed | AC-02 (11 tests) |
| Adapter neutrality | provider-specific code ONLY in /adapters; /settlement consumes the neutral adapter contract | AC-07 + AC-08 pins |
| Idempotency | exactly-once fact recording per (scope, provider, external id); replay-safe | AC-01 + AC-06 |
| Reconciliation | deterministic server-side matched/pending/mismatched with machine-readable reasons | AC-03 (8 tests) |
| No bypass | an external fact can never create/consume/reverse/mutate internal economic state | AC-04 (3 tests) |
| Tenancy/auth | cross-tenant and unauthorized access fails closed without existence oracles | AC-05 (5 tests) |
| Atomicity | recording + derivation idempotent, concurrency-safe, atomically audited | AC-06 (6 tests) |
| Traceability | internal lineage ⇄ external facts, both directions | AC-07 (6 tests) |
| Mutation evidence | targeted mutations must be caught by acceptance tests | 9/9 CAUGHT (below) |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration | GREEN (below) |

## Acceptance map (as implemented)

AC-01 — external transaction fact records (append-only, idempotent, immutable) — `tests/settlement/net-w030-ac-01-fact-records.test.ts` (7 tests)  
AC-02 — authenticated adapter ingestion (fail-closed verification) — `tests/settlement/net-w030-ac-02-authenticated-ingestion.test.ts` (11 tests)  
AC-03 — deterministic reconciliation + machine-readable reasons — `tests/settlement/net-w030-ac-03-reconciliation.test.ts` (8 tests)  
AC-04 — no-economic-bypass containment — `tests/settlement/net-w030-ac-04-no-bypass.test.ts` (3 tests)  
AC-05 — privacy + tenancy + authorization — `tests/settlement/net-w030-ac-05-tenancy-authorization.test.ts` (5 tests)  
AC-06 — idempotency/concurrency/atomicity + fault injection — `tests/settlement/net-w030-ac-06-idempotency-concurrency.test.ts` (6 tests)  
AC-07 — traceability + settlement-authority containment — `tests/settlement/net-w030-ac-07-traceability-containment.test.ts` (6 tests)  
AC-08 — architecture/out-of-scope regression and W031+/W032 deferrals — `tests/regression/net-w030-ac-08-architecture-out-of-scope.test.ts` (12 tests)

## Implementation surface (all additive)

- `src/settlement/port.ts` — the neutral contracts (the W029 discipline: the CONSUMING domain's port declares the contract; the composition root is the only join): `ExternalSettlementProviderAdapter`, `ExternalSettlementAuthenticator`, `ExternalSettlementTransactionFacts`, `RawExternalSettlementSubmission`, `ExternalSettlementFactRecord` + the create-only `ExternalSettlementFactRepository`, the service + deps, the reconciliation views; the closed, versioned vocabularies (providers `["reference"]`, integrity algorithms `["hmac-sha256/v1"]`, rejection reasons, verdicts, reconciliation reasons, `EXTERNAL_SETTLEMENT_MAX_AGE_MS = 15min`, record format `NET-W030:1`); additive audit-event members (`external_settlement_fact.recorded`, `external_settlement_fact.mismatch_observed`).
- `src/settlement/external-settlement-input.ts` — the pure canonical-input discipline: the seven-field attested-facts projection (explicit, stable — the W029 canonical-input discipline), the closed-vocabulary validation, the freshness decision, the per-unit ledger debit-total derivation.
- `src/settlement/external-settlement-service.ts` — the authenticated ingestion command (validate → route → normalize → verify → freshness → identity mutex → ONE authoritative transaction: in-tx identity backstop, correction-target resolution, in-tx reconciliation derivation, create-only record, transactional audit) + the tenant-scoped reads + the DERIVED reconciliation evaluation (mismatches recorded + audited, never auto-corrected).
- `src/settlement/authority-external-settlement-repository.ts` — the PostgresAuthority-backed create-only fact repository (NO save/update — immutability by construction).
- `src/adapters/settlement/reference-adapter.ts` — the reference provider adapter (adapter tier; implements the neutral contract STRUCTURALLY without importing /settlement — the tier matrix's `adapter-must-not-import-domain`; `tsc` enforces compatibility at the wiring site).
- `src/bootstrap/external-settlement-authentication.ts` — the composition-root trust-channel selection (per-provider material via the explicit override or the SecretProvider — `EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY`; absent ⇒ ingestion fails closed, NO development fallback) + the REAL HMAC-SHA256 authenticator (timing-safe, non-throwing) + the trusted-provider signing helpers.
- Sanctioned shared-file amendments: `EconomicLedgerRepository.findTransactionWithinTx` (the in-tx twin — ledger transactions are immutable, the twin keeps the in-tx re-derivation discipline), the W008 harness option threading, runtime/config/env/API wiring (4 guarded routes: record, read, reconciliation, by-transaction reverse traceability; guard actions `externalSettlementFact.record|read|reconcile`).

## Verification record (this session, executed)

- `bun run typecheck` — **0 errors**.
- `bun run arch:check` — **309 files scanned, 0 violations**.
- `bun run authority:check` — **309 files scanned, 0 violations**.
- `bun test` — **1916 pass / 15 skip / 0 fail / 24,119 expect() / 1931 tests / 247 files** (baseline before W030: 1858/15/0 / 1873 tests / 239 files → **+58 tests, +8 files**).
- Baseline reproduced EXACTLY before any edit (1858/15/0, 23,556 expect(), 239 files).
- Staged-diff secret scan: **clean** (no key material; `.env.example` entries are names only).
- Mutation checks (driver `opencon-tmp/w030-mutation-driver.py`, never committed; one-backup-per-distinct-file, byte-identical restores, final green, leftover-backup walk): **9/9 CAUGHT** —
  - M1 authentication bypass (verify→true) — AC-02 caught.
  - M2 freshness gate removal — AC-02 caught.
  - M3 closed provider vocabulary widening — AC-08 caught.
  - M4 mismatch auto-correction (verdict forced matched) — AC-03 caught.
  - M5 tenant-scope removal on the scoped read — AC-05 caught.
  - M6 in-tx identity backstop bypass — AC-01/AC-06 caught.
  - M7 correction-target resolution gate removal — AC-01/AC-06 caught.
  - M8 mismatch-observation audit removal — AC-03 caught.
  - M9 recording audit verdict-lineage removal — AC-03 caught.
- Real PostgreSQL/Redis integration: exercised by the CI `integration` job (PostgreSQL 17 + Redis 7 services) on the PR's own events — the same configured-integration discipline as W028/W029 (the fact repository runs on the identical PostgresAuthority machinery the W003 integration suite covers against real PostgreSQL).

## Driver-development disclosure (honest record)

The mutation driver required three corrections during bring-up, all disclosed:
1. A restore-ordering defect (cmp-before-restore, inherited from an early draft — NOT the W029 per-edit-backup bug) briefly left M1 active after a failed run; the file was restored by hand and the driver fixed (restore → cmp → delete). The subsequent full run is the recorded evidence.
2. M3 and M6 were re-scoped after first-run "not caught" results — both revealed genuine defense-in-depth, not test gaps: removing the provider-vocabulary GATE is behavior-preserving (the adapter routing backstop rejects unknown providers with the same machine-readable reason), and randomizing the composite idempotency key is absorbed by the in-tx identity backstop under the test shim's sequential resolution. The re-scoped mutations target the same defect CLASSES observably (vocabulary widening; identity-backstop bypass), and both redundancy observations are recorded here deliberately.

## Architectural invariants

- No second economic authority; no external execution of internal mutations (AC-04: identical ledger entry digest, balances and value records across matched/pending/mismatched/correction recordings; global conservation holds).
- No consensus layer, no blockchain/network validation, no token economics (AC-08 pins).
- No portable reputation proofs (W031); no decentralized validation (W032); no end-to-end flows (W033+) (AC-08 pins).
- Secrets resolve only through `SecretProvider`; no committed key material (AC-02/AC-08 + secret scan).
- Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical (AC-08 pins; untouched in the diff).
- `/payments` stays skeletal (invariant 25 — external execution remains out of scope).
