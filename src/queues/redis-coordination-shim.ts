/**
 * RedisCoordinationShim — non-authoritative coordination test double.
 *
 * Work order ref: NET-W003 §4.2 (Redis non-authoritative coordination),
 * AC-02 (Redis non-authority), architecture-lock §16 (Redis/caches/
 * queues are NEVER authoritative state).
 *
 * TEST DOUBLE — clearly marked. This is NOT the real Redis client.
 * It is an in-process coordination store that demonstrates the SAME
 * non-authority semantics required by NET-W003:
 *
 *  - Locks and ephemeral values live in process memory only.
 *  - `clear()` destroys ALL coordination state (simulating Redis loss /
 *    `FLUSHDB`). Authoritative state in the `PostgresAuthority` is
 *    UNAFFECTED — that is the non-authority invariant proven in AC-02.
 *  - Locks are TTL-bounded; a holder MAY release early.
 *
 * The REAL Redis client integration lives in
 * `src/adapters/redis/redis-coordination-adapter.ts` (the `ioredis`
 * package; SET NX PX locks + Lua compare-and-delete release + TTL
 * ephemeral values), exercised by
 * `tests/integration/redis-coordination-integration.test.ts` against a
 * real Redis service. This shim remains for deterministic unit tests
 * that do not need a real Redis.
 */

import { randomUUID } from "node:crypto";
import type {
  CoordinationService,
  LockHandle,
} from "../core/coordination.ts";

interface EphemeralEntry {
  value: string;
  expiresAt: number;
}

interface LockEntry {
  token: string;
  expiresAt: number;
}

export interface RedisCoordinationShimOptions {
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
  /** Injectable clock for deterministic TTL tests. */
  readonly now?: () => number;
}

export class RedisCoordinationShim implements CoordinationService {
  private readonly ephemeral = new Map<string, EphemeralEntry>();
  private readonly locks = new Map<string, LockEntry>();
  private readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
  private readonly now: () => number;

  public constructor(opts: RedisCoordinationShimOptions = {}) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  private sweepEphemeral(): void {
    const t = this.now();
    for (const [k, v] of this.ephemeral) {
      if (v.expiresAt <= t) this.ephemeral.delete(k);
    }
  }

  private sweepLocks(): void {
    const t = this.now();
    for (const [k, v] of this.locks) {
      if (v.expiresAt <= t) this.locks.delete(k);
    }
  }

  public async acquireLock(input: {
    readonly key: string;
    readonly ttlMs: number;
    readonly waitMs?: number;
  }): Promise<LockHandle> {
    this.sweepLocks();
    const t = this.now();
    const existing = this.locks.get(input.key);
    if (existing && existing.expiresAt > t) {
      // Lock held by someone else. For the test double we don't block:
      // we return a handle with `acquired: false`. Callers that need
      // to wait can retry. This preserves the non-authority invariant
      // (a lock is coordination, not authority).
      this.logger?.debug("coordination.lock_unavailable", { key: input.key });
      const handle: LockHandle = {
        token: "",
        key: input.key,
        acquired: false,
        release: async () => false,
      };
      return handle;
    }
    const token = randomUUID();
    this.locks.set(input.key, { token, expiresAt: t + input.ttlMs });
    this.logger?.debug("coordination.lock_acquired", { key: input.key, token });
    let released = false;
    const handle: LockHandle = {
      token,
      key: input.key,
      acquired: true,
      release: async () => {
        if (released) return false;
        released = true;
        const current = this.locks.get(input.key);
        if (current && current.token === token) {
          this.locks.delete(input.key);
          return true;
        }
        return false;
      },
    };
    return handle;
  }

  public async setEphemeral(key: string, value: string, ttlMs: number): Promise<void> {
    this.sweepEphemeral();
    const t = this.now();
    this.ephemeral.set(key, { value, expiresAt: t + ttlMs });
  }

  public async getEphemeral(key: string): Promise<string | null> {
    this.sweepEphemeral();
    const e = this.ephemeral.get(key);
    return e ? e.value : null;
  }

  public async hasEphemeral(key: string): Promise<boolean> {
    this.sweepEphemeral();
    return this.ephemeral.has(key);
  }

  public async clear(): Promise<void> {
    // NON-AUTHORITY INVARIANT: destroying coordination state MUST NOT
    // affect authoritative state. This method destroys ONLY locks and
    // ephemeral coordination values. The PostgresAuthority is untouched.
    const locks = this.locks.size;
    const ephem = this.ephemeral.size;
    this.locks.clear();
    this.ephemeral.clear();
    this.logger?.debug("coordination.cleared", { locksCleared: locks, ephemeralCleared: ephem });
  }

  /** Test accessor: count of live locks. */
  _lockCount(): number {
    this.sweepLocks();
    return this.locks.size;
  }

  /** Test accessor: count of live ephemeral entries. */
  _ephemeralCount(): number {
    this.sweepEphemeral();
    return this.ephemeral.size;
  }
}
