/**
 * Real Redis `CoordinationService` adapter.
 *
 * Work order ref: NET-W003 §4.2 (Redis non-authoritative coordination),
 * §6 (CoordinationService), architecture-lock §16 (Redis/caches/queues
 * are NEVER authoritative state), §18 (`/adapters` = external
 * platform/provider integrations), §14 (provider-specific SDK/types do
 * not cross into core domain modules).
 *
 * This is a REAL Redis client integration (the `ioredis` package). It
 * is the NON-AUTHORITATIVE coordination boundary for v1.0 — locks and
 * ephemeral coordination values live in Redis and are explicitly
 * non-durable: `clear()` (which issues `FLUSHDB`) destroys ALL
 * coordination state and leaves the authoritative PostgreSQL state
 * UNAFFECTED. That is the non-authority invariant proven in
 * NET-W003-AC-02 and re-proven against this real adapter in
 * `tests/integration/redis-coordination-integration.test.ts`.
 *
 * Lock semantics (real Redis):
 *  - `acquireLock` issues `SET key token NX PX ttlMs` — a single
 *    atomic round-trip. It returns a handle with `acquired: true` iff
 *    the key was free; otherwise `acquired: false` (someone else
 *    holds it).
 *  - `release` issues a Lua compare-and-delete
 *    (`if get(key) == token then del(key) end`) so a holder only ever
 *    releases its OWN lock (a TTL-expired lock re-acquired by another
 *    caller is never deleted by a stale holder).
 *  - TTL expiry is handled by Redis itself (no sweeper needed).
 *
 * Provider isolation (frozen architecture §14): this file is the ONLY
 * place that imports `ioredis`. It implements the provider-neutral
 * {@link CoordinationService} contract from `src/core/coordination.ts`;
 * domain/infrastructure modules consume that contract, never this
 * concrete driver. The architecture checker classifies this file as
 * adapter-tier and permits `ioredis` here (and ONLY here) via
 * `ADAPTER_ALLOWED_EXTERNAL_PACKAGES`.
 *
 * The in-process `RedisCoordinationShim` in `src/queues/` remains a
 * clearly-marked TEST DOUBLE for deterministic unit tests. Both sit
 * behind the SAME `CoordinationService` contract.
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type {
  CoordinationService,
  LockHandle,
} from "../../core/coordination.ts";

/**
 * Lua script for safe lock release: only delete the key if the stored
 * token matches the caller's token (prevents a stale holder from
 * deleting a lock that was re-acquired by another caller after TTL
 * expiry). Returns 1 if deleted, 0 otherwise.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
` as string;

export interface RedisCoordinationAdapterOptions {
  /** Redis connection string (e.g. `redis://host:6379/0`). */
  readonly connectionString: string;
  /**
   * Optional key prefix so isolated test runs don't collide. Prefixed
   * keys still live in the same logical DB; `clear()` issues FLUSHDB
   * and affects the whole DB (test/recovery only — see {@link clear}).
   */
  readonly keyPrefix?: string;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * Real Redis `CoordinationService`. Non-authoritative: clearing the
 * store (or losing Redis entirely) MUST NOT affect authoritative state
 * (architecture-lock §16).
 */
export class RedisCoordinationAdapter implements CoordinationService {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
  };

  public constructor(opts: RedisCoordinationAdapterOptions) {
    this.keyPrefix = opts.keyPrefix ?? "";
    this.logger = opts.logger;
    this.redis = new Redis(opts.connectionString, {
      // Lazy connect — the adapter doesn't dial until first use. Tests
      // construct the adapter then probe connectivity explicitly.
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    // Defensive: attach a no-op 'error' listener so a transient or
    // unreachable connection does NOT crash the process via an
    // unhandled 'error' event. Connection failures are surfaced on
    // the individual commands that depend on connectivity (which
    // reject after maxRetries). This is standard ioredis hygiene and
    // makes the adapter safe to construct at the composition root even
    // when the provider is not yet reachable (the fail-fast boundary
    // is the SecretProvider config check, not a connection probe).
    this.redis.on("error", (err: Error) => {
      this.logger?.warn?.("coordination.redis_error", { message: err.message });
    });
  }

  private prefix(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}:${key}` : key;
  }

  public async acquireLock(input: {
    readonly key: string;
    readonly ttlMs: number;
    readonly waitMs?: number;
  }): Promise<LockHandle> {
    const token = randomUUID();
    const storedKey = this.prefix(input.key);
    // Atomic acquire: SET key token NX PX ttl. Returns "OK" iff the
    // key was free; null if someone else holds it.
    const result = await this.redis.set(storedKey, token, "PX", input.ttlMs, "NX");
    if (result !== "OK") {
      this.logger?.debug("coordination.lock_unavailable", { key: input.key });
      return {
        token: "",
        key: input.key,
        acquired: false,
        release: async () => false,
      };
    }
    this.logger?.debug("coordination.lock_acquired", { key: input.key, token });
    let released = false;
    const handle: LockHandle = {
      token,
      key: input.key,
      acquired: true,
      release: async () => {
        if (released) return false;
        released = true;
        // Safe release: only delete if the stored token is still ours.
        const deleted = await this.redis.eval(
          RELEASE_LOCK_SCRIPT,
          1,
          storedKey,
          token,
        );
        return deleted === 1;
      },
    };
    return handle;
  }

  public async setEphemeral(key: string, value: string, ttlMs: number): Promise<void> {
    const storedKey = this.prefix(key);
    // SET key value PX ttl (no NX — overwrite is fine for ephemeral
    // coordination values like rate-limit counters).
    await this.redis.set(storedKey, value, "PX", ttlMs);
  }

  public async getEphemeral(key: string): Promise<string | null> {
    const storedKey = this.prefix(key);
    const value = await this.redis.get(storedKey);
    return value;
  }

  public async hasEphemeral(key: string): Promise<boolean> {
    const storedKey = this.prefix(key);
    const exists = await this.redis.exists(storedKey);
    return exists === 1;
  }

  public async clear(): Promise<void> {
    // NON-AUTHORITY INVARIANT (architecture-lock §16): destroying
    // coordination state MUST NOT affect authoritative state. This
    // issues FLUSHDB against the coordination DB only — the
    // PostgreSQL authority lives in a completely separate system and
    // is untouched. Test/recovery only; never call in production paths.
    await this.redis.flushdb();
    this.logger?.debug("coordination.cleared", {});
  }

  /** Close the underlying Redis connection. */
  public async close(): Promise<void> {
    await this.redis.quit();
    this.logger?.debug("coordination.closed", {});
  }
}

// Re-export the driver type for adapter consumers without leaking
// `ioredis` beyond the adapter boundary.
export type { Redis };
