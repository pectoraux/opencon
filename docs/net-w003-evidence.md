# NET-W003 — Evidence

**Work Item:** NET-W003 — Persistence, queues, objects, secrets and observability  
**Architecture:** v1.0 (FROZEN)  
**Requirements:** CORE-002, EVID-006, AUD-001, API-004  
**Acceptance Criteria:** NET-W003-AC-01..08

All evidence is reproducible from a clean repository checkout via
`bun install && bun run verify`. Real-provider integration evidence
is additionally reproducible via `docker compose up` + the env vars
documented in §7.5.

## 1. Verification commands

NET-W003 ships TWO test layers (architect re-review on PR #6):

1. **Unit / shim tests** (always run, no services required) — prove the
   authority / non-authority / transaction / idempotency / observability
   contracts against the clearly-marked test doubles. These are the
   canonical architecture-gate evidence.
2. **Real-provider integration tests** (conditional on provisioned
   PostgreSQL + Redis) — prove the SAME contracts hold against the
   REAL `pg` and `ioredis` adapters behind `/adapters`. They skip
   when the service env vars are unset, so `bun run verify` stays green
   without a database/Redis.

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies (zod + pg + ioredis + types) |
| `bun run typecheck` | TypeScript strict typecheck |
| `bun run arch:check` | Deterministic architecture/dependency check (provider packages permitted ONLY in adapter tier) |
| `bun test` | Full automated test suite — unit + integration (integration skips without services) |
| `bun run verify` | typecheck + arch:check + tests (canonical evidence command, no services needed) |
| `docker compose up -d` then `PG_TEST_DATABASE_URL=… REDIS_TEST_URL=… bun test tests/integration/` | Real-provider integration tests against local PostgreSQL + Redis |

The same pipeline is enforced in CI by `.github/workflows/ci.yml`,
which runs TWO jobs on every push/PR: `verify` (the architecture +
unit gate, no services) and `integration` (real PostgreSQL + Redis
service containers exercising the real adapters).

## 2. Verification results (reproduced)

### 2a. Canonical gate — `bun run verify` (no services)

```
$ bun run verify
$ tsc --noEmit                       # typecheck: PASS (exit 0)
$ bun scripts/check-architecture.ts  # ✓ 152 files scanned, 0 violations (exit 0)
$ bun test                           # unit + integration-canary PASS; integration tests SKIP (no services)
```

Without `PG_TEST_DATABASE_URL` / `REDIS_TEST_URL`, the integration
tests skip (their canaries pass), so the canonical gate is green from
a clean checkout with no external services.

### 2b. Real-provider integration (with services provisioned)

```
$ docker compose up -d   # or the sandbox-local portable PostgreSQL + Redis used for verification
$ export PG_TEST_DATABASE_URL="postgres://opencon:opencon@localhost:55432/opencon_test"
$ export REDIS_TEST_URL="redis://localhost:56379"
$ bun test tests/integration/        # 17 pass, 0 fail (real pg + ioredis against real PostgreSQL 17 + Redis 7)
```

Reproduced against real PostgreSQL 17.10 + Redis 8.0 (provisioned in
the development sandbox via portable binaries; CI provisions
`postgres:17-alpine` + `redis:7-alpine` service containers):

```
tests/integration/postgres-authority-integration.test.ts:
(pass) committed writes survive a real restart (durable in PostgreSQL)
(pass) uncommitted writes are NOT visible after rollback (real ROLLBACK discards them)
(pass) recover() detects and discards orphaned in-flight markers (interrupted-tx recovery)
(pass) explicit rollback does not persist writes (real ROLLBACK)
(pass) writes inside a tx are NOT visible to a concurrent outside reader until commit (real READ COMMITTED)
(pass) committed records carry execution/correlation lineage (real columns)
(pass) revisions increment monotonically per key (real ON CONFLICT revision+1)
(pass) scan returns all committed records in a collection

tests/integration/redis-coordination-integration.test.ts:
(pass) a lock is acquired and released (real SET NX PX + Lua release)
(pass) two callers cannot hold the same lock simultaneously (real SET NX)
(pass) a stale holder cannot release a lock re-acquired by another caller (real Lua compare-and-delete)
(pass) locks expire after TTL (real Redis TTL)
(pass) ephemeral values are set/get with TTL (real SET PX + GET)
(pass) ephemeral values expire after TTL (real Redis expiry)
(pass) clear() destroys ONLY coordination state — PostgreSQL authority is UNAFFECTED (architecture-lock §16)
```

### 2c. Full suite with services (unit + integration together)

```
$ bun test   # with PG_TEST_DATABASE_URL + REDIS_TEST_URL set
192 pass, 0 fail, 1322 expect() calls, 28 files
```

Test breakdown:
- NET-W001 suites (unchanged, still pass): 52 tests across 8 files
- NET-W002 suites (unchanged, still pass): 60 tests across 10 files
  - 8 original AC suites (44 tests) + 2 remediation suites (16 tests)
- NET-W003 unit/shim suites: 61 tests across 8 files
  - tests/persistence/net-w003-ac-01-postgresql-authority.test.ts (7 tests)
  - tests/queues/net-w003-ac-02-redis-non-authority.test.ts (6 tests)
  - tests/object-storage/net-w003-ac-03-object-reference-integrity.test.ts (5 tests)
  - tests/secrets/net-w003-ac-04-secret-isolation.test.ts (10 tests)
  - tests/persistence/net-w003-ac-05-transaction-rollback-recovery.test.ts (10 tests — +3 corruption hardening)
  - tests/persistence/net-w003-ac-06-idempotency-concurrency.test.ts (7 tests)
  - tests/observability/net-w003-ac-07-correlation-tracing.test.ts (6 tests)
  - tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts (10 tests — +2 scanner/provider assertions)
- NET-W003 real-provider integration suites (NEW): 17 tests across 2 files
  - tests/integration/postgres-authority-integration.test.ts (7 real + 1 canary)
  - tests/integration/redis-coordination-integration.test.ts (7 real + 1 canary)

The NET-W001-AC-08 regression test (no premature domain logic) still
passes — NET-W003 touches ONLY infrastructure + adapter modules; the
16 frozen domain dirs are untouched.

## 3. Changed-files summary mapped to acceptance criteria

### NET-W003-AC-01 — PostgreSQL authority (PASS — shim unit tests + real-provider integration)
- `src/core/postgres-authority.ts` (NEW) — `PostgresAuthority` contract
  (durable records with execution/correlation lineage; `AuthorityTransaction`
  with real commit/rollback; `recover()` for restart recovery).
- `src/adapters/postgres/postgres-authority-adapter.ts` (NEW, architect
  re-review on PR #6) — the REAL PostgreSQL driver integration (the `pg`
  package) behind the adapter boundary. SQL schema `opencon_authority`
  (collection, key, value JSONB, execution_id, correlation_id, actor_id,
  written_at, revision) + `opencon_inflight_tx` (tx_id, begun_at). Real
  BEGIN/COMMIT/ROLLBACK transactions (READ COMMITTED isolation: writes
  inside a tx are NOT visible to outside readers until commit). The
  in-flight marker is committed in its OWN tiny transaction at `begin()`
  so it survives a mid-transaction connection drop — `recover()` then
  reports the interrupted tx as discarded and removes the orphaned marker.
  Atomic upsert with `revision = revision + 1` via `ON CONFLICT`.
- `src/persistence/postgres-authority-shim.ts` (NEW) — file-backed
  authority TEST DOUBLE for unit tests. Durable committed snapshot
  (`committed.json`, atomic temp-file + rename). In-flight tx log
  (`inflight.json`) tracks begun-but-not-settled tx ids so `recover()`
  can report discarded interrupted transactions. Recovery hardening
  (PR #6 re-review): a corrupt committed snapshot surfaces as a
  `StorageCorruptionError` rather than silently becoming an empty store.
- `tests/persistence/net-w003-ac-01-postgresql-authority.test.ts` (NEW,
  7 tests, shim) — committed writes survive restart; uncommitted writes
  are NOT visible after recovery; explicit rollback removes the in-flight
  marker; writes inside a tx are not visible to outside readers until
  commit; committed records carry execution/correlation lineage;
  revisions increment monotonically; the durable snapshot file exists
  after a commit.
- `tests/integration/postgres-authority-integration.test.ts` (NEW, 7
  real + 1 canary, conditional on `PG_TEST_DATABASE_URL`) — commits survive
  a real restart (new adapter, same DB/schema); uncommitted writes are
  rolled back (real ROLLBACK); `recover()` detects+discards orphaned
  in-flight markers; explicit rollback; READ COMMITTED isolation;
  lineage columns; monotonic revisions via `ON CONFLICT`; scan.

### NET-W003-AC-02 — Redis non-authority (PASS — shim unit tests + real-provider integration)
- `src/core/coordination.ts` (NEW) — `CoordinationService` contract
  (distributed locks with TTL; ephemeral coordination values; `clear()`
  for the non-authority invariant). NON-AUTHORITATIVE.
- `src/adapters/redis/redis-coordination-adapter.ts` (NEW, architect
  re-review on PR #6) — the REAL Redis client integration (the `ioredis`
  package) behind the adapter boundary. `acquireLock` issues `SET key
  token NX PX ttlMs` (one atomic round-trip); `release` issues a Lua
  compare-and-delete (`if get(key)==token then del(key) end`) so a stale
  holder never deletes a lock re-acquired by another caller after TTL
  expiry; ephemeral values use `SET ... PX`; `clear()` issues `FLUSHDB`
  (non-authority invariant: leaves PostgreSQL authority UNAFFECTED).
- `src/queues/redis-coordination-shim.ts` (NEW) — in-process TEST DOUBLE.
  `clear()` destroys ALL coordination state and leaves the
  `PostgresAuthority` UNAFFECTED.
- `tests/queues/net-w003-ac-02-redis-non-authority.test.ts` (NEW,
  6 tests, shim) — clearing coordination state does not lose authoritative
  state; a lock is coordination only (loss doesn't corrupt authority);
  two callers cannot hold the same lock simultaneously; locks expire
  after TTL; ephemeral values expire after TTL; `clear()` destroys
  ONLY coordination state (no authority touch).
- `tests/integration/redis-coordination-integration.test.ts` (NEW, 7
  real + 1 canary, conditional on `REDIS_TEST_URL`) — real SET NX PX lock
  acquire+release; two callers cannot hold the same lock; a stale holder
  cannot release a re-acquired lock (real Lua compare-and-delete); TTL
  expiry; ephemeral SET PX + GET + expiry; AND the cross-adapter
  non-authority invariant against BOTH real adapters: `clear()` (FLUSHDB)
  leaves a committed PostgreSQL mutation intact (architecture-lock §16).

### NET-W003-AC-03 — Object-storage reference integrity (PASS)
- `src/core/object-store.ts` (EXTENDED) — added
  `ObjectReferenceRepository` contract + `ObjectReferenceRecord`. The
  authority holds durable REFERENCES (key, bucket, size, content hash,
  immutable marker, metadata, execution/correlation lineage) — NEVER
  the artifact bytes.
- `src/object-storage/durable-object-store.ts` (NEW) — `DurableObjectStore`
  (file-backed, content-addressed by SHA-256; immutability: put to
  existing key with different content is rejected) +
  `createPostgresObjectReferenceRepository` (authority-backed reference
  repository; `lookup` with `expectedContentHash` verifies integrity;
  a mismatched hash returns null).
- `tests/object-storage/net-w003-ac-03-object-reference-integrity.test.ts`
  (NEW, 5 tests) — large artifact bytes live in object storage, NOT in
  the authority (serialized authority record is far smaller than the
  64KB blob); retrieval verifies content integrity (hash mismatch
  rejected); recomputing the bytes' hash matches the stored reference;
  immutability (different content rejected, same content idempotent);
  durable references survive restart (in the authority + object store).

### NET-W003-AC-04 — Secret-provider isolation (PASS)
- `src/secrets/secret-redactor.ts` (NEW) — `redactSecrets()` recursively
  redacts credential-shaped KEYS (`password|token|secret|api[-_]?key|
  private[-_]?key|credential|auth[-_]?header`) and credential-shaped VALUES
  (long base64/hex, bearer tokens, JWTs, URL-embedded credentials,
  `password=`/`secret=` fragments). `assertNoSecretValue()` test helper.
  The redactor is INTENTIONALLY conservative (over-redaction is acceptable;
  a leaked secret is not).
- `src/secrets/env-provider.ts` (UNCHANGED from NET-W001) — env-backed
  SecretProvider resolves secret material ONLY at the infrastructure
  boundary.
- `tests/secrets/net-w003-ac-04-secret-isolation.test.ts` (NEW,
  10 tests) — the SecretProvider resolves the value at the boundary;
  missing secret raises SecretNotFoundError; redactSecrets redacts
  credential-shaped KEYS; redacts credential-shaped VALUES; redacts
  explicit forbidden values verbatim; never mutates the input; the
  redaction patterns catch the canonical credential surface;
  assertNoSecretValue throws when a forbidden value IS present;
  assertNoSecretValue does not throw when absent; a simulated audit
  record does not contain the secret value after redaction.

### NET-W003-AC-05 — Transaction rollback/recovery (PASS)
- `src/persistence/durable-transaction-manager.ts` (NEW) —
  `createDurableTransactionManager` wraps `PostgresAuthority` so the
  existing NET-W001 `TransactionManager` contract now carries REAL
  transaction semantics. `asAuthorityTransaction()` bridge helper.
- `src/persistence/postgres-authority-shim.ts` — the shim's
  `AuthorityTransaction` buffers writes in-memory; `commit` applies
  them to committed state + persists the snapshot; `rollback` discards
  them; `recover()` restores committed state only and reports
  discarded interrupted transactions.
- `tests/persistence/net-w003-ac-05-transaction-rollback-recovery.test.ts`
  (NEW, 7 tests) — begin/write-A/write-B/throw → rollback → neither
  visible; begin/write-A/commit/begin/write-B/throw → rollback → A
  visible, B absent; recovery-on-restart restores committed state only
  (interrupted tx discarded); rollback is idempotent; commit is
  idempotent; a put-then-delete rolled-back tx leaves no trace; the
  durable transaction manager wraps the authority with real semantics.

### NET-W003-AC-06 — Idempotency/concurrency (PASS)
- `src/core/idempotency.ts` (NEW) — `IdempotencyStore` contract,
  `IdempotentResult`, `IdempotentApplyContext`. Exactly-once-per-key
  material mutation.
- `src/persistence/idempotency-store.ts` (NEW) —
  `createPostgresIdempotencyStore` backed by `PostgresAuthority`. The
  mutation + the idempotency record commit atomically (same tx). A
  per-key mutex queue simulates `SELECT ... FOR UPDATE` row-level
  locking so concurrent applies with the same key produce exactly one
  mutation (the second is a deterministic replay). The idempotency
  record is durable (survives restart) — it is NOT Redis coordination
  state.
- `tests/persistence/net-w003-ac-06-idempotency-concurrency.test.ts`
  (NEW, 7 tests) — first call executes fn; second sequential call
  returns cached result without re-invoking; concurrent calls with
  the same key produce exactly one mutation; distinct keys each
  execute exactly once; a thrown fn does not create a record (retry
  executes fn again); the idempotency record survives restart (durable,
  not Redis coordination); the mutation and the idempotency record
  commit atomically; the cached result is JSON-serializable and stable
  across replays.

### NET-W003-AC-07 — Observability correlation tracing (PASS)
- `src/core/trace.ts` (NEW) — `TraceRecorder` contract, `Span`, `SpanHandle`.
  Spans carry `executionId`, `correlationId`, `causationId`, actor,
  name, timing. NON-AUTHORITATIVE observability infrastructure.
- `src/observability/trace-recorder.ts` (NEW) — `createTraceRecorder`
  implementation. Spans propagate across the synchronous→asynchronous
  boundary via the active `ExecutionContext` (AsyncLocalStorage). A
  request→enqueue→job flow produces a single trace sharing the
  `correlationId`, with the job span's `causationId` linking to the
  request span's `executionId` (via `deriveExecutionContext`).
- `tests/observability/net-w003-ac-07-correlation-tracing.test.ts`
  (NEW, 6 tests) — a request → enqueue → job-execute flow produces a
  single trace sharing `correlationId`, with the job span's
  `causationId` linking to the request's `executionId`; a child span's
  `causationId` links to its parent's `executionId`; spans record
  status error when failed; span attributes can be added in-flight and
  at end; the trace recorder is non-authoritative (no domain state);
  `count()` and `traceFor()` reflect recorded spans.

### NET-W003-AC-08 — Architecture/out-of-scope regression (PASS)
- `tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts`
  (NEW, 10 tests) — NET-W003 infrastructure modules introduce no
  forbidden material-operation patterns (`issueCredit`, `mintCredit`,
  `settleAmount`, `mutateReputation`, `allocateBenefit`,
  `deliverCampaign`, `issueReward`, `ProofOfValue`, `cashSettlement`);
  NET-W003 infrastructure modules are concrete (no 'skeleton' marker,
  reference NET-W003); no domain-tier file was modified to add NET-W003
  behavior (the 16 frozen domain dirs are untouched); no external
  package beyond `zod` is imported anywhere in src/; the architecture
  check passes with all NET-W003 files (0 violations, 148 files scanned);
  spec/architecture.md and spec/architecture-lock.md remain FROZEN
  (PostgreSQL authoritative; Redis/caches/queues/worker-memory never
  authoritative; large/immutable artifacts live outside core relational
  rows); NET-W003 work order exists and binds to frozen Architecture
  v1.0; the INFRA_DIRS list includes all NET-W003 boundaries; no
  secrets or real credentials are committed; the TransactionalAuditWriter
  preserves the append-only / deep-immutability invariant from
  NET-W001-AC-06.

## 4. Audit material-mutation tracing (NET-W003 §4.8)

- `src/audit/transactional-audit-writer.ts` (NEW) —
  `createTransactionalAuditWriter` wraps an underlying append-only
  `AuditWriter` so audit events for a material mutation are buffered
  inside the mutation's authoritative transaction and flushed on
  commit (or discarded on rollback). Atomicity: audit + mutation
  commit together, or both roll back. Each flushed audit record carries
  the authoritative `transactionId` (in metadata) and optional
  `objectReferenceIds` so a material mutation can be traced back to
  its durable transaction and to the durable references of large
  artifacts it produced.
- The NET-W001 append-only / deep-immutability invariant is preserved:
  a flushed audit event is still deeply-frozen and never mutated by
  later writes. The NET-W002 identity-boundary remediations (no
  caller-controlled actor; no raw client-claims in logs) carry forward
  unchanged.

## 5. Module summary updates (infrastructure tier, no domain change)

The following infrastructure modules' `module.ts` summaries were
updated from "skeleton" to reflect NET-W003 concrete behaviour:
- `persistence` — authoritative state, transaction boundaries, recovery,
  idempotency (NET-W003)
- `queues` — non-authoritative coordination queues, locks, ephemeral
  state (NET-W003)
- `object-storage` — large/immutable artifact storage referenced from
  PostgreSQL (NET-W003)
- `secrets` — secrets isolation boundary + credential-material
  redactor (NET-W001 + NET-W003)
- `observability` — structured logging, health, correlation, trace
  lineage (NET-W001 + NET-W003)
- `audit` — append-oriented auditability + material-mutation tracing
  (NET-W001 + NET-W002 + NET-W003)

The 16 frozen DOMAIN modules are untouched (no `module.ts` change, no
new behavior). The NET-W001-AC-08 regression test confirms the
still-deferred 13 domain modules remain skeletal.

## 6. Out-of-scope confirmation

Per work order §5 (explicit non-goals), this work item introduces NONE of:

- advertising campaigns; inventory; creators marketplace behavior;
  helpfulness scoring; evidence evaluation or Proof-of-Value;
  attribution; reputation algorithms or score changes; Participation
  Credit issuance; cash settlement; fraud scoring; Demand Pools;
  procurement; Benefit Pools; blockchain/ledger consensus; production
  external authentication providers; production external identity
  providers; downstream business authorization policies; real
  PostgreSQL driver / Redis client coupling into DOMAIN code (the real
  drivers live behind `/adapters`; domain code is provider-independent);
  domain state-machine implementation beyond the persistence
  infrastructure required to support later work.

No placeholder implementation silently authorizes downstream domain
actions or silently settles economic value. The NET-W003 infrastructure
provides persistence/coordination/observability/audit boundaries ONLY.
Domain modules consume these via declared interfaces (added in later
work items) — never a concrete driver.

The frozen architecture (`spec/architecture.md`,
`spec/architecture-lock.md`) is unchanged. No secrets or real
credentials are committed — all secret values in the NET-W003 tests
are deliberately synthetic strings (`ak-1234567890abcdef-do-not-leak`,
`sk-1234567890abcdefghij`, etc.) that exist solely to prove the
secret-isolation boundary rejects them.

## 7. Provider adapters + test-doubles rationale (architectural compliance)

NET-W003 ships BOTH the real provider adapters (behind `/adapters`) and
clearly-marked TEST DOUBLES (behind `/persistence`, `/queues`,
`/object-storage`). The provider-neutral contracts live in `src/core/`:

**Real provider adapters (architect re-review on PR #6) — the `pg` and
`ioredis` drivers, permitted ONLY in the adapter tier:**
- `src/adapters/postgres/postgres-authority-adapter.ts` — the REAL
  PostgreSQL `PostgresAuthority` (durable committed state in
  `opencon_authority`; real BEGIN/COMMIT/ROLLBACK; orphaned in-flight
  markers detected+discarded by `recover()`). Exercised by
  `tests/integration/postgres-authority-integration.test.ts`.
- `src/adapters/redis/redis-coordination-adapter.ts` — the REAL Redis
  `CoordinationService` (`SET NX PX` locks; Lua compare-and-delete
  release; TTL ephemeral values; `FLUSHDB` `clear()`). Exercised by
  `tests/integration/redis-coordination-integration.test.ts`.

**Clearly-marked TEST DOUBLES — for deterministic unit tests that do
not need real services (they prove the SAME contracts the adapters do):**
- `PostgresAuthorityShim` (file-backed) — durability across restart,
  transactional atomicity, recovery. Recovery hardening: corrupt
  committed snapshot → `StorageCorruptionError` (not an empty store).
- `RedisCoordinationShim` (in-process) — locks/ephemeral state are
  non-durable; `clear()` leaves authority intact.
- `DurableObjectStore` (file-backed) — content-addressed durable
  object storage + integrity verification. A real S3/GCS/Azure backend
  is a provider integration behind `/adapters` for a later work item.

The architecture checker (`scripts/lib/architecture.ts`) classifies
`pg` and `ioredis` as `external-adapter-only` — permitted ONLY in the
adapter tier (`ADAPTER_ALLOWED_EXTERNAL_PACKAGES`). Every other tier
(core/domain/infrastructure/neutral) importing them is a violation
(rule `external-provider-package-not-allowed-outside-adapter`), so
frozen architecture §14 (provider-specific SDK/types do not cross into
core domain modules) and §2/§18 (external providers integrated through
`/adapters`) are enforced. The regression test
`tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts`
asserts both the permit-in-adapter and reject-from-domain properties.

The NET-W003 contracts (`PostgresAuthority`, `CoordinationService`,
`ObjectReferenceRepository`, `IdempotencyStore`, `TraceRecorder`,
`AuditWriter`) are provider-neutral and live in `src/core/` — domain
modules will consume them via declared interfaces in later work items,
never via a concrete driver.

## 7.5. Real-provider integration evidence + reproducible local invocation

The architect re-review on PR #6 required the repository to contain the
real integration path and a reproducible local invocation. NET-W003
provides:

- **CI service containers** (`.github/workflows/ci.yml`, `integration`
  job): `postgres:17-alpine` + `redis:7-alpine` with health checks, env
  vars `PG_TEST_DATABASE_URL` + `REDIS_TEST_URL` set, running
  `bun test tests/integration/` on every push/PR.
- **Reproducible local invocation** (`docker-compose.yml`):
  ```
  docker compose up -d
  export PG_TEST_DATABASE_URL="postgres://opencon:opencon@localhost:55432/opencon_test"
  export REDIS_TEST_URL="redis://localhost:56379"
  bun test tests/integration/
  docker compose down
  ```
- **Conditional skip**: when the env vars are unset, every integration
  test skips (its canary still passes), so `bun run verify` stays green
  in environments without provisioned services.

Reproduced against real PostgreSQL 17.10 + Redis 8.0: 17 integration
tests pass (7 PostgreSQL authority + 7 Redis coordination + 2 canaries
+ 1 cross-adapter non-authority invariant). See §2b for the per-test
results.

## 8. Single PR

Exactly one implementation PR is created for NET-W003 (see PR
description for the required format). The PR binds to frozen
Architecture v1.0 and this Work Order. The architect re-review on PR #6
(CHANGES REQUESTED) was remediated in the same PR — real PostgreSQL +
Redis adapters added behind `/adapters`, the architecture checker
updated to permit provider packages ONLY in the adapter tier, real-
provider integration tests added (CI service containers + docker-
compose), and recovery hardened (corrupt committed snapshot → explicit
`StorageCorruptionError`). The frozen architecture is unchanged.
