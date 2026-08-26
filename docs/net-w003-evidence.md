# NET-W003 — Evidence

**Work Item:** NET-W003 — Persistence, queues, objects, secrets and observability  
**Architecture:** v1.0 (FROZEN)  
**Requirements:** CORE-002, EVID-006, AUD-001, API-004  
**Acceptance Criteria:** NET-W003-AC-01..08

All evidence is reproducible from a clean repository checkout via
`bun install && bun run verify`.

## 1. Verification commands

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies (zod) |
| `bun run typecheck` | TypeScript strict typecheck |
| `bun run arch:check` | Deterministic architecture/dependency check |
| `bun test` | Full automated test suite (26 files, 170 tests) |
| `bun run verify` | typecheck + arch:check + tests (canonical evidence command) |

The same pipeline is enforced in CI by `.github/workflows/ci.yml`
(inherited from NET-W001), so the architecture/dependency checks and
the test suite both gate every push and PR targeting `main`.

## 2. Verification results (reproduced)

```
$ bun run verify
$ tsc --noEmit                       # typecheck: PASS (exit 0)
$ bun scripts/check-architecture.ts  # ✓ 148 files scanned, 0 violations (exit 0)
$ bun test                           # 170 pass, 0 fail, 1242 expect() calls, 26 files (exit 0)
```

Test breakdown:
- NET-W001 suites (unchanged, still pass): 52 tests across 8 files
- NET-W002 suites (unchanged, still pass): 60 tests across 10 files
  - 8 original AC suites (44 tests) + 2 remediation suites (16 tests)
- NET-W003 suites (new): 58 tests across 8 files
  - tests/persistence/net-w003-ac-01-postgresql-authority.test.ts (7 tests)
  - tests/queues/net-w003-ac-02-redis-non-authority.test.ts (6 tests)
  - tests/object-storage/net-w003-ac-03-object-reference-integrity.test.ts (5 tests)
  - tests/secrets/net-w003-ac-04-secret-isolation.test.ts (10 tests)
  - tests/persistence/net-w003-ac-05-transaction-rollback-recovery.test.ts (7 tests)
  - tests/persistence/net-w003-ac-06-idempotency-concurrency.test.ts (7 tests)
  - tests/observability/net-w003-ac-07-correlation-tracing.test.ts (6 tests)
  - tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts (10 tests)

The NET-W001-AC-08 regression test (no premature domain logic) still
passes — NET-W003 touches ONLY infrastructure modules; the 16 frozen
domain dirs are untouched.

## 3. Changed-files summary mapped to acceptance criteria

### NET-W003-AC-01 — PostgreSQL authority (PASS)
- `src/core/postgres-authority.ts` (NEW) — `PostgresAuthority` contract
  (durable records with execution/correlation lineage; `AuthorityTransaction`
  with real commit/rollback; `recover()` for restart recovery).
- `src/persistence/postgres-authority-shim.ts` (NEW) — file-backed
  authority test double. Durable committed snapshot (`committed.json`,
  atomic temp-file + rename). In-flight tx log (`inflight.json`) tracks
  begun-but-not-settled tx ids so `recover()` can report discarded
  interrupted transactions. Clearly marked TEST DOUBLE — a real `pg`
  driver is forbidden by the architecture check (only `zod` external
  package allowed) and is an adapter concern for a later work item.
- `tests/persistence/net-w003-ac-01-postgresql-authority.test.ts` (NEW,
  7 tests) — committed writes survive restart; uncommitted writes are
  NOT visible after recovery; explicit rollback removes the in-flight
  marker; writes inside a tx are not visible to outside readers until
  commit; committed records carry execution/correlation lineage;
  revisions increment monotonically; the durable snapshot file exists
  after a commit.

### NET-W003-AC-02 — Redis non-authority (PASS)
- `src/core/coordination.ts` (NEW) — `CoordinationService` contract
  (distributed locks with TTL; ephemeral coordination values; `clear()`
  for the non-authority invariant). NON-AUTHORITATIVE.
- `src/queues/redis-coordination-shim.ts` (NEW) — in-process test
  double. `clear()` destroys ALL coordination state and leaves the
  `PostgresAuthority` UNAFFECTED. Clearly marked TEST DOUBLE — a real
  Redis client (`ioredis`/`node-redis`) is forbidden by the architecture
  check.
- `tests/queues/net-w003-ac-02-redis-non-authority.test.ts` (NEW,
  6 tests) — clearing coordination state does not lose authoritative
  state; a lock is coordination only (loss doesn't corrupt authority);
  two callers cannot hold the same lock simultaneously; locks expire
  after TTL; ephemeral values expire after TTL; `clear()` destroys
  ONLY coordination state (no authority touch).

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
  PostgreSQL driver / Redis client coupling into domain code (test
  doubles behind the same ports only); domain state-machine
  implementation beyond the persistence infrastructure required to
  support later work.

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

## 7. Test-doubles rationale (architectural compliance)

NET-W003 ships clearly-marked TEST DOUBLES, not real drivers:
- `PostgresAuthorityShim` — file-backed, demonstrates the SAME
  authority semantics as PostgreSQL (durability across restart,
  transactional atomicity, recovery). A real `pg` driver is an adapter
  concern for a later work item.
- `RedisCoordinationShim` — in-process, demonstrates the SAME
  non-authority semantics as Redis (locks/ephemeral state are
  non-durable; `clear()` leaves authority intact). A real Redis client
  is an adapter concern.
- `DurableObjectStore` — file-backed, demonstrates content-addressed
  durable object storage + integrity verification. A real S3/GCS/Azure
  backend is an adapter concern.

This complies with the architecture check (only `zod` external package
allowed; infrastructure modules import `core` + infrastructure + Node
built-ins only). The NET-W003 contracts (`PostgresAuthority`,
`CoordinationService`, `ObjectReferenceRepository`, `IdempotencyStore`,
`TraceRecorder`, `AuditWriter`) are provider-neutral and live in
`src/core/` — domain modules will consume them via declared interfaces
in later work items, never via a concrete driver.

## 8. Single PR

Exactly one implementation PR is created for NET-W003 (see PR
description for the required format). The PR binds to frozen
Architecture v1.0 and this Work Order.
