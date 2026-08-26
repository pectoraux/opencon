# Work Order — NET-W003

**Work Item:** NET-W003 — Persistence, queues, objects, secrets and observability  
**Architecture:** v1.0 (FROZEN)  
**Status:** READY_FOR_IMPLEMENTATION  
**Implementation Agent:** Z.ai  
**Architect:** OpenCon Architect  
**Created:** 2026-08-26

## 1. Purpose

Establish the production persistence/coordination boundary for Open Contribution Protocol v1.0: PostgreSQL as authoritative persistence, Redis as non-authoritative coordination for workers/locks, durable object-storage references, secret-provider integration, operational observability, recovery/transaction conventions, and material-mutation tracing.

This work item binds to frozen Architecture v1.0. It MUST NOT implement domain economics, downstream product behavior, evidence evaluation, outcomes, reputation, credits, settlement, fraud, demand pools, procurement, benefits, advertising, creator behavior, or blockchain consensus. It provides ONLY the persistence infrastructure required to support later work.

## 2. Authoritative references

Implementation MUST conform to:

- `spec/architecture.md`
- `spec/architecture-lock.md`
- `spec/requirements.md`
- `spec/work-items.md`
- `spec/dependency-graph.md`
- `spec/work-orders/NET-W001.md`
- `spec/work-orders/NET-W002.md`

NET-W001's merged foundation and NET-W002's merged identity/organization/participant model are the implementation baseline. Do not reopen frozen architecture.

## 3. Requirements in scope

- CORE-002 — implement as a modular monolith with asynchronous workers first
- EVID-006 — support cryptographic commitments for sensitive evidence (the durable object-storage reference + content-hash integrity foundation required by later evidence work)
- AUD-001 — append-oriented audit trail (extended here to participate transactionally in material mutations)
- API-004 — make material mutation endpoints idempotent where duplicate delivery/retry is possible (the idempotency primitive established here)

Related acceptance criteria:

- API-AC-03 — duplicate material requests produce one logical mutation (idempotency integration test)

## 4. Scope

### 4.1 PostgreSQL authoritative persistence

Implement a provider-neutral authoritative persistence boundary with:

- durable storage that survives process restart;
- transaction boundaries with real commit/rollback semantics;
- recovery-on-restart that restores only committed state (uncommitted writes are never visible after recovery);
- stable, typed records carrying execution/correlation identifiers where they represent material mutations.

PostgreSQL is the system of record for durable domain state (architecture-lock §3, §16). The provider-neutral `PostgresAuthority` contract lives in `src/core/`; the REAL PostgreSQL driver integration lives behind the adapter boundary at `src/adapters/postgres/` (the `pg` package), and a clearly-marked file-backed test double at `src/persistence/` proves the SAME authority semantics (durability across restart, transactional atomicity, recovery) for deterministic unit tests that do not need a real database. Domain modules consume the authority boundary through the declared `PostgresAuthority` port, never through a driver — the architecture checker permits `pg` ONLY in the adapter tier (`ADAPTER_ALLOWED_EXTERNAL_PACKAGES`). Real-adapter integration evidence (commit/restart/rollback/recovery) is required (see §8 + the architect re-review note below).

### 4.2 Redis non-authoritative coordination

Implement a non-authoritative coordination boundary for:

- distributed/worker locks;
- ephemeral coordination state;
- queue coordination hints.

Redis, caches, queues and worker memory are NEVER authoritative state (architecture-lock §16). Loss of Redis coordination state MUST NOT imply loss of domain truth. The coordination boundary is explicitly recoverable and non-durable: clearing it never corrupts authoritative state.

The provider-neutral `CoordinationService` contract lives in `src/core/`; the REAL Redis client integration lives behind the adapter boundary at `src/adapters/redis/` (the `ioredis` package; SET NX PX locks + Lua compare-and-delete release + TTL ephemeral values), and a clearly-marked in-process test double at `src/queues/` proves the SAME non-authority semantics for deterministic unit tests. The architecture checker permits `ioredis` ONLY in the adapter tier. The non-authority invariant is testable against BOTH: destroying the coordination state leaves PostgreSQL authority intact (proven against the real adapters in `tests/integration/redis-coordination-integration.test.ts`).

### 4.3 Object storage with durable references

Implement durable object storage for large/immutable artifacts:

- the object store holds artifact bytes;
- the authoritative persistence boundary holds durable references (key, bucket, size, content hash, created-at, immutable marker) and metadata, NOT opaque giant blobs;
- content-addressed integrity: retrieval verifies the stored content hash;
- immutability: a put to an existing key with different content is rejected (evidence integrity).

Large/immutable artifacts live outside core relational rows and are referenced durably (architecture-lock §17). The object-storage boundary is the subject of NET-W003's durable reference contract; the existing NET-W001 in-memory ObjectStore remains a test double behind the same port.

### 4.4 SecretProvider boundary

Harden the secret-provider boundary established by NET-W001:

- secret material is resolved ONLY through the SecretProvider at the infrastructure boundary;
- secret material is NEVER logged, NEVER persisted as audit/trace material, and NEVER returned through the ConfigurationProvider;
- a secret-material redactor is provided for arbitrary log/trace fields, redacting credential-shaped keys and values.

Credentials, password hashes, OAuth provider secrets and access tokens MUST NOT be stored in domain modules (NET-W002 §4.4 carries forward). NET-W003 ensures the boundary holds across persistence, observability and audit.

### 4.5 Transactions, rollback and recovery

Implement transaction semantics that are explicit and testable:

- `begin` / `commit` / `rollback` on the authoritative persistence boundary;
- work inside a transaction is NOT visible outside the transaction until commit;
- rollback discards all uncommitted work;
- recovery-on-restart restores committed state only — partial/uncommitted writes from an interrupted transaction are NOT visible after recovery;
- the audit boundary participates transactionally in material mutations: the audit record and the mutation it describes commit atomically (or both roll back).

### 4.6 Idempotency and concurrency safety

Implement an idempotency primitive for material mutations:

- an idempotency-key store backed by the authoritative persistence boundary;
- `applyIdempotent(key, fn)` runs `fn` exactly-once-per-key and caches the result;
- concurrent calls with the same key produce exactly one mutation (the others are deterministic replays returning the cached result);
- sequential replays with the same key do NOT re-invoke `fn` and return the cached result;
- the idempotency store survives restart (it is authoritative, not Redis coordination state).

This is the foundation for API-004 (idempotent material mutation endpoints) consumed by later work items.

### 4.7 Observability: trace and correlation lineage

Extend the NET-W001 structured-logging/execution-context boundary with trace/correlation lineage:

- a trace recorder records spans carrying `executionId`, `correlationId`, `causationId`, actor and timestamp;
- spans propagate across the synchronous→asynchronous boundary (request → enqueue → worker-execute) via `deriveExecutionContext`;
- a request→enqueue→job flow produces a single trace sharing the `correlationId`, with `causationId` linking the job span to the request span;
- the trace recorder is non-authoritative (observability is coordination, not truth).

### 4.8 Audit: material-mutation tracing

Extend the NET-W001/NET-W002 audit boundary so material mutations are traceable to durable state:

- audit records for material mutations reference the durable transaction id (when available);
- audit records reference durable object-store references (when the mutation produced a large artifact);
- the audit write participates in the same transaction as the mutation (atomicity: audit + mutation commit together, or both roll back);
- the append-only / deep-immutability invariant from NET-W001-AC-06 is preserved.

Do not add audit event types for future business domains. Audit events remain structural + the NET-W002 identity/organization/participant/authorization events.

## 5. Explicit non-goals

Do NOT implement:

- advertising campaigns;
- inventory;
- creators marketplace behavior;
- helpfulness scoring;
- evidence evaluation or Proof-of-Value;
- attribution;
- reputation algorithms or score changes;
- Participation Credit issuance;
- cash settlement;
- fraud scoring;
- Demand Pools;
- procurement;
- Benefit Pools;
- blockchain/ledger consensus;
- production external authentication providers;
- production external identity providers;
- downstream business authorization policies;
- real PostgreSQL driver / Redis client coupling into domain code (test doubles behind the same ports only);
- domain state-machine implementation beyond the persistence infrastructure required to support later work.

Do not create placeholder implementations that silently authorize downstream domain actions or silently settle economic value.

## 6. Required interfaces/contracts

At minimum define or extend provider-neutral interfaces for:

```text
PostgresAuthority           (authoritative persistence + transactions)
TransactionManager         (begin/commit/rollback + run + recovery)
CoordinationService        (non-authoritative locks + ephemeral state)
ObjectStore                (durable large/immutable artifacts — extended)
ObjectReferenceRepository  (durable references in PostgreSQL authority)
SecretProvider             (secret isolation — hardened)
SecretMaterialRedactor     (redact credential-shaped values from logs/traces)
IdempotencyStore           (exactly-once-per-key material mutation)
TraceRecorder              (span/trace correlation lineage)
AuditWriter                (transactional + material-mutation tracing — extended)
```

External persistence/coordination drivers remain behind the adapter boundary (`src/adapters/postgres/`, `src/adapters/redis/`); domain modules never import them. The architecture checker permits the concrete provider packages (`pg`, `ioredis`) ONLY in the adapter tier (`ADAPTER_ALLOWED_EXTERNAL_PACKAGES`) — every other tier (core/domain/infrastructure/neutral) importing a provider package is a violation of frozen architecture §14 (provider-specific SDK/types do not cross into core domain modules) and §2/§18 (external providers are integrated through `/adapters`). Clearly-marked test doubles (`PostgresAuthorityShim`, `RedisCoordinationShim`, `DurableObjectStore`) remain for deterministic unit tests that do not need real services; real-adapter integration tests (conditional on provisioned service availability, CI service containers + `docker-compose.yml` for local invocation) prove the SAME authority/non-authority/transaction/idempotency contracts against real PostgreSQL and Redis.

## 7. Acceptance criteria

### NET-W003-AC-01 — PostgreSQL authority
Authoritative state survives process restart; uncommitted writes are not visible after recovery; committed writes are.

**Evidence:** integration test against a file-backed authority test double — committed transaction → restart → data present; rolled-back transaction → restart → data absent.

### NET-W003-AC-02 — Redis non-authority
Loss of Redis coordination state does not lose domain truth; authoritative state remains intact in PostgreSQL.

**Evidence:** integration test acquiring a coordination lock, performing an authoritative mutation, then clearing the coordination state (simulating Redis loss) and confirming authoritative state is unchanged and intact.

### NET-W003-AC-03 — Object-storage reference integrity
Large artifacts live in object storage; the authority records durable references (not opaque blobs); retrieval verifies content integrity.

**Evidence:** integration test storing a large artifact, asserting the authority holds only a reference (no byte blob), retrieving it, verifying the content hash matches, and asserting that a stale/mismatched reference is rejected on retrieval.

### NET-W003-AC-04 — Secret-provider isolation
Secret material is resolved only through the SecretProvider and never appears in logs, audit records, or persisted state.

**Evidence:** integration test configuring a secret, resolving it via the SecretProvider, and asserting that no log line, audit record, or persisted row contains the secret value; the SecretMaterialRedactor redacts credential-shaped values.

### NET-W003-AC-05 — Transaction rollback/recovery
Transactions roll back atomically on error; recovery restores only committed state.

**Evidence:** integration test — begin, write A, write B, throw → rollback → neither A nor B visible; begin, write A, commit, begin, write B, throw → rollback → A visible, B absent; recovery-on-restart restores A only.

### NET-W003-AC-06 — Idempotency/concurrency
A representative material mutation applied twice (concurrently and sequentially) with the same idempotency key produces exactly one mutation.

**Evidence:** integration test — two concurrent `applyIdempotent` calls with the same key invoke `fn` exactly once and both return the same result; a sequential replay does not re-invoke `fn` and returns the cached result; the idempotency record survives restart.

### NET-W003-AC-07 — Observability correlation tracing
A request → enqueue → job-execute flow produces a trace with shared `correlationId`; spans carry `executionId`/`causationId` lineage.

**Evidence:** integration test running a flow through the worker boundary, asserting the trace recorder produced spans sharing `correlationId`, with the job span's `causationId` linking to the request span's `executionId`.

### NET-W003-AC-08 — Architecture/out-of-scope regression
No downstream domain/economic logic is introduced; the architecture check passes; frozen specs remain unchanged.

**Evidence:** regression test asserting the NET-W003 infrastructure modules introduce no forbidden material-operation patterns, no domain-tier leak, the architecture check passes with the new files, and the frozen architecture files remain unchanged.

## 8. Verification requirements

Z.ai MUST provide:

1. PostgreSQL authority/integration evidence;
2. Redis coordination/non-authority evidence;
3. object-storage reference/integrity evidence;
4. secret-provider isolation evidence;
5. transaction + rollback/recovery evidence;
6. idempotency/concurrency evidence;
7. observability/correlation tracing evidence;
8. architecture/out-of-scope regression evidence;
9. changed-files summary mapped to each acceptance criterion;
10. confirmation that no downstream domain/economic behavior was introduced.

All evidence must be reproducible from a clean repository checkout via `bun install && bun run verify`.

## 9. Implementation constraints

- Follow frozen Architecture v1.0 exactly.
- Preserve all NET-W001 architecture enforcement rules (tier matrix, dependency direction, adapter isolation).
- Preserve all NET-W002 identity-boundary remediations (no caller-controlled actor; no raw client-claims in logs).
- Reuse the existing core execution/correlation, logging, audit, API and module contracts where applicable.
- Do not bypass the persistence boundary.
- Do not couple domain code directly to a PostgreSQL driver, Redis client, or object-storage SDK.
- Do not place secrets or credentials in domain modules.
- Do not implement downstream authorization decisions that belong to campaigns, contributions, procurement, benefits or settlement.
- Do not implement economic-material mutations (credit issuance, settlement, reputation mutation, reward creation).
- Any architectural contradiction MUST be escalated as an Architecture Change Request.

## 10. PR requirements

Z.ai must create exactly one implementation PR for NET-W003.

The PR description MUST include:

```text
Work Item: NET-W003
Architecture: v1.0
Requirements: CORE-002, EVID-006, AUD-001, API-004
Acceptance Criteria: NET-W003-AC-01..08
Verification: <commands/results>
Out of Scope: <confirmation>
```

Review is based on repository state and reproducible evidence.

## 11. Completion state

The Work Item may move to verification only when:

- all acceptance criteria have objective evidence;
- required tests pass;
- architecture/static checks pass;
- the implementation PR exists and is the single active PR for NET-W003;
- frozen architecture files remain unchanged;
- no downstream domain/economic behavior is introduced;
- the NET-W001/NET-W002 regression suites still pass unchanged.

Architect review determines whether the item is approved, changes requested, or escalated for architecture change.

## 12. Architect re-review note (PR #6)

The initial PR #6 implementation shipped only clearly-marked test
doubles (`PostgresAuthorityShim`, `RedisCoordinationShim`) and read
the architecture checker's blanket external-package forbid (`only zod
allowed`) as prohibiting the real `pg`/`ioredis` drivers. The architect
re-review corrected that reading: the frozen architecture (§2, §14,
§18, §19) already places external provider integrations behind
`/adapters` with provider-specific SDK/types NOT crossing into core
domain modules. The remediation therefore:

- keeps the provider-neutral `PostgresAuthority` and `CoordinationService`
  contracts in `src/core/` (unchanged) and the shims as test doubles;
- adds the REAL `pg`-backed PostgreSQL adapter at
  `src/adapters/postgres/` and the REAL `ioredis`-backed Redis adapter
  at `src/adapters/redis/`;
- updates the architecture checker (`scripts/lib/architecture.ts`) to
  classify `pg`/`ioredis` as `external-adapter-only`, permitted ONLY in
  the adapter tier and rejected everywhere else (so domain modules
  remain provider-independent);
- adds real-provider integration tests (conditional on provisioned
  service availability — CI service containers + `docker-compose.yml`
  for local invocation);
- hardens recovery: a corrupt committed snapshot now surfaces as a
  `StorageCorruptionError` rather than silently becoming an empty
  store (an authority boundary must never convert corruption into
  data loss).

The frozen architecture (`spec/architecture.md`,
`spec/architecture-lock.md`) is UNCHANGED. No downstream domain or
economic behavior is introduced.
