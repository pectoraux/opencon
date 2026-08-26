/**
 * IdempotencyStore contract — exactly-once-per-key material mutation.
 *
 * Work order ref: NET-W003 §4.6 (Idempotency and concurrency safety),
 * requirement API-004 (idempotent material mutation endpoints), §6
 * (IdempotencyStore).
 *
 * The idempotency store is backed by the authoritative persistence
 * boundary (PostgreSQL authority) — it is NOT Redis coordination
 * state. Idempotency records survive restart and are never lost when
 * Redis is cleared.
 *
 * Contract:
 *  - `applyIdempotent(key, fn)` runs `fn` exactly-once-per-key.
 *  - Concurrent calls with the same key produce exactly one mutation;
 *    the others are deterministic replays returning the cached result.
 *  - Sequential replays do NOT re-invoke `fn` and return the cached result.
 *  - `fn` receives a transaction-scoped context so the mutation and the
 *    idempotency record commit atomically (or both roll back).
 *
 * This file defines interfaces ONLY. Concrete implementation lives in
 * src/persistence/idempotency-store.ts.
 */

import type { ExecutionContext } from "./execution-context.ts";

/**
 * The outcome of an idempotent apply. The stored `result` is the cached
 * return value of `fn` for the first execution; replays receive the same
 * value without re-invoking `fn`.
 */
export interface IdempotentResult<T = unknown> {
  /** True iff `fn` was actually invoked for this call. */
  readonly executed: boolean;
  /** The cached result of the first execution (returned on replays too). */
  readonly result: T;
  /** Stable record id for audit/trace lineage. */
  readonly recordId: string;
}

/**
 * Context passed to the apply callback. The caller MAY use the
 * execution context for audit/trace lineage. The transaction is the
 * authoritative scope in which both the mutation and the idempotency
 * record are committed atomically.
 */
export interface IdempotentApplyContext {
  readonly execution: ExecutionContext;
  /** Commit the apply (records the idempotency entry + the mutation). */
  readonly commit: () => Promise<void>;
  /** Roll back the apply (discards the mutation + the idempotency entry). */
  readonly rollback: () => Promise<void>;
}

export interface IdempotencyStore {
  /**
   * Apply `fn` exactly-once-per-key. The first call with a given key
   * invokes `fn`, stores the result, and returns `{ executed: true }`.
   * Subsequent calls (concurrent or sequential) with the same key do
   * NOT invoke `fn` and return `{ executed: false, result: <cached> }`.
   *
   * `fn` MUST return a JSON-serializable value (it is persisted as the
   * cached result). `fn` MAY throw; in that case no idempotency record
   * is created and a later call with the same key will invoke `fn` again.
   */
  applyIdempotent<T>(
    key: string,
    fn: (ctx: IdempotentApplyContext) => Promise<T>,
    execution: ExecutionContext,
  ): Promise<IdempotentResult<T>>;
  /** Inspect whether a key has a cached result (for tests). */
  has(key: string): Promise<boolean>;
  /** Read the cached result for a key (for tests). Returns null if absent. */
  get<T = unknown>(key: string): Promise<{ readonly result: T; readonly recordId: string } | null>;
  /** Total record count (for integrity tests). */
  count(): Promise<number>;
}

export class IdempotencyConflictError extends Error {
  public constructor(key: string) {
    super(
      `idempotency key "${key}" is already being processed by another caller; ` +
        `the caller should retry or treat the in-flight result as authoritative.`,
    );
    this.name = "IdempotencyConflictError";
  }
}
