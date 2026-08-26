/**
 * CoordinationService contract — non-authoritative coordination boundary.
 *
 * Work order ref: NET-W003 §4.2 (Redis non-authoritative coordination),
 * §6 (CoordinationService), architecture-lock §16 (Redis/caches/queues
 * are NEVER authoritative state).
 *
 * This boundary provides distributed/worker locks and ephemeral
 * coordination state. It is explicitly NON-AUTHORITATIVE and
 * NON-DURABLE: clearing the coordination state (e.g. losing Redis)
 * MUST NOT lose domain truth. Authoritative state lives in the
 * PostgreSQL persistence boundary.
 *
 * The non-authority invariant is testable: destroying the coordination
 * state leaves PostgreSQL authority intact.
 *
 * This file defines interfaces ONLY. Concrete implementation lives in
 * src/queues/redis-coordination-shim.ts (a clearly-marked test double
 * that demonstrates the SAME non-authority semantics).
 */

export interface LockHandle {
  /** The lock token. Stable for the lifetime of the lock. */
  readonly token: string;
  /** The key being locked. */
  readonly key: string;
  /** True iff the lock was acquired (false = someone else holds it). */
  readonly acquired: boolean;
  /** Release the lock. Idempotent. Returns true if this call released it. */
  release(): Promise<boolean>;
}

export interface CoordinationService {
  /**
   * Acquire a named lock with a time-to-live. Returns a handle whose
   * `acquired` is true iff the lock was obtained. A lock holder MAY
   * release early; otherwise it expires after `ttlMs`.
   *
   * Non-authority invariant: a lock is coordination only — losing the
   * coordination store cannot corrupt authoritative state.
   */
  acquireLock(input: {
    readonly key: string;
    readonly ttlMs: number;
    readonly waitMs?: number;
  }): Promise<LockHandle>;
  /** Set an ephemeral coordination value (lost when the store is cleared). */
  setEphemeral(key: string, value: string, ttlMs: number): Promise<void>;
  /** Read an ephemeral coordination value. Returns null if absent/expired. */
  getEphemeral(key: string): Promise<string | null>;
  /**
   * TEST/RECOVERY ONLY — clear ALL coordination state. Used to prove the
   * non-authority invariant: after `clear()`, authoritative state must
   * remain intact. Real Redis would `FLUSHDB`; the test double clears its
   * in-process maps.
   */
  clear(): Promise<void>;
  /** True iff the coordination store currently holds a value for `key`. */
  hasEphemeral(key: string): Promise<boolean>;
}
