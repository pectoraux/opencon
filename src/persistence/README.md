# `persistence` boundary

**Tier:** infrastructure  
**Authority:** authoritative state (PostgreSQL in v1.0); transaction
boundaries; recovery; idempotency  
**Architecture ref:** `spec/architecture.md` §18 (Module ownership),
§19 (PostgreSQL authoritative); `spec/architecture-lock.md` §3, §16  
**Concrete behaviour:** NET-W003

## Scope in NET-W003

NET-W003 promotes this boundary from "skeleton" to "concrete". It ships:

- **`PostgresAuthority` contract** (`src/core/postgres-authority.ts`) —
  the provider-neutral authoritative persistence port: durable records
  with execution/correlation lineage, transactions with real
  commit/rollback, and recovery-on-restart.
- **`PostgresAuthorityShim`** (`src/persistence/postgres-authority-shim.ts`) —
  a file-backed test double that demonstrates the SAME authority
  semantics as PostgreSQL: durability across restart, transactional
  atomicity (buffered writes, atomic apply-on-commit, discard-on-rollback),
  recovery reporting interrupted (begun-but-not-settled) transactions.
  Clearly marked as a test double; a real `pg` driver is forbidden by
  the architecture check (only `zod` is an allowed external package) and
  is an adapter concern for a later work item.
- **`TransactionManager`** — the NET-W001 contract is preserved; a new
  `createDurableTransactionManager` wraps the `PostgresAuthority` so the
  contract now carries REAL transaction semantics.
- **`IdempotencyStore`** (`src/core/idempotency.ts` +
  `src/persistence/idempotency-store.ts`) — exactly-once-per-key
  material mutation, backed by the authority. The mutation and the
  idempotency record commit atomically.

## Non-authority

Redis, caches, queues and worker memory are NEVER authoritative state
(architecture-lock §16). The `persistence` boundary is the ONLY
authoritative persistence surface. Coordination (locks, ephemeral state)
lives in the `queues` boundary (`CoordinationService`), which is
explicitly non-authoritative.

## Dependencies

`core` contracts only. Domain modules consume persistence through
declared interfaces (added in later work items) — never a concrete
driver. The architecture check enforces this.
