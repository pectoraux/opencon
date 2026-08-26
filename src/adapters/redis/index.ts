/**
 * Redis provider adapter boundary.
 *
 * Architecture ref: spec/architecture.md §18 (`/adapters` = external
 * platform/provider integrations), §19 (Redis/queues/caches are
 * coordination infrastructure and are never authoritative),
 * architecture-lock §16, §14 (provider-specific SDK/types do not
 * cross into core domain modules).
 *
 * This is the ONLY place `ioredis` is imported. The adapter implements
 * the provider-neutral {@link CoordinationService} contract from
 * `src/core/coordination.ts`; domain/infrastructure modules consume
 * that contract, never this concrete driver. The
 * `RedisCoordinationShim` in `src/queues/` remains a clearly marked
 * TEST DOUBLE for unit tests that don't need a real Redis.
 *
 * The real integration path is exercised by
 * `tests/integration/redis-coordination-integration.test.ts`.
 */

export * from "./redis-coordination-adapter.ts";
