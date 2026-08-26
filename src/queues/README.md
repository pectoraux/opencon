# `queues` boundary

**Tier:** infrastructure  
**Authority:** non-authoritative coordination queues, distributed/worker
locks, ephemeral coordination state  
**Architecture ref:** `spec/architecture.md` §18, §19 (Redis/queues/caches
are coordination, NEVER authoritative); `spec/architecture-lock.md` §16  
**Concrete behaviour:** NET-W003

## Scope in NET-W003

NET-W003 promotes this boundary from "skeleton" to "concrete" for
coordination. It ships:

- **`CoordinationService` contract** (`src/core/coordination.ts`) —
  the provider-neutral non-authoritative coordination port: distributed
  locks with TTL, ephemeral coordination values, and a `clear()` method
  for the non-authority invariant.
- **`RedisCoordinationShim`** (`src/queues/redis-coordination-shim.ts`) —
  an in-process test double that demonstrates the SAME non-authority
  semantics: locks and ephemeral values live in process memory only;
  `clear()` destroys ALL coordination state and leaves the
  `PostgresAuthority` UNAFFECTED.
- The NET-W001 `JobQueue` contract + `createInMemoryJobQueue` remain —
  the durable Redis-backed queue is the same boundary; the contract is
  preserved.

## Non-authority invariant

Redis, caches, queues and worker memory are NEVER authoritative state
(architecture-lock §16). The `queues` boundary is explicitly
recoverable and non-durable: `RedisCoordinationShim.clear()` proves
this — authoritative state in `persistence` is untouched.

A real Redis client is forbidden by the architecture check (only `zod`
is an allowed external package) and is an adapter concern for a later
work item.

## Dependencies

`core` contracts only. The architecture check enforces that domain
modules never import a concrete driver from this boundary.
