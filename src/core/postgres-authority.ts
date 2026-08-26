/**
 * PostgresAuthority contract — authoritative persistence boundary.
 *
 * Work order ref: NET-W003 §4.1 (PostgreSQL authoritative persistence),
 * §4.5 (Transactions, rollback and recovery), §6 (PostgresAuthority),
 * architecture-lock §3 (PostgreSQL is authoritative application state
 * in v1.0), §16 (Redis/caches/queues are never authoritative).
 *
 * This is the system-of-record boundary. Writes here are durable across
 * process restart. Transactions have REAL commit/rollback semantics:
 * uncommitted writes are NOT visible outside the transaction, rollback
 * discards all uncommitted work, and recovery-on-restart restores only
 * committed state.
 *
 * The authority is a typed, relation-oriented key/value store
 * sufficient to prove the authority contract (durable records, atomic
 * transactions, recovery) without coupling domain code to a PostgreSQL
 * driver. The concrete implementation in src/persistence/ uses a
 * clearly-marked file-backed test double that demonstrates the SAME
 * authority semantics — a real `pg` driver is forbidden by the
 * architecture check (only `zod` external package is allowed) and is
 * an adapter concern for a later work item.
 *
 * Material mutations written through this boundary carry
 * execution/correlation identifiers (architecture-lock §12, NET-W003
 * §4.8) so audit lineage can trace durable state changes.
 */

import type { ExecutionContext } from "./execution-context.ts";

/**
 * A durable record in the authoritative store. The `value` is
 * JSON-serializable. `executionId` / `correlationId` are recorded at
 * write time so material mutations are traceable to their execution.
 */
export interface AuthorityRecord<T = unknown> {
  readonly collection: string;
  readonly key: string;
  readonly value: T;
  readonly executionId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly writtenAt: string;
  /** Stable revision number for optimistic concurrency. */
  readonly revision: number;
}

/**
 * A transaction on the authoritative store. Work done inside the
 * transaction is NOT visible outside it until `commit`. `rollback`
 * discards all uncommitted work. Either commits atomically or not at all.
 */
export interface AuthorityTransaction {
  /** Collection-scoped read (sees uncommitted writes in this tx). */
  get<T = unknown>(collection: string, key: string): Promise<AuthorityRecord<T> | null>;
  /** Collection-scoped scan (sees uncommitted writes in this tx). */
  scan<T = unknown>(collection: string): Promise<readonly AuthorityRecord<T>[]>;
  /** Write a record (visible to this tx immediately; others after commit). */
  put<T>(collection: string, key: string, value: T): Promise<AuthorityRecord<T>>;
  /** Delete a record (visible to this tx immediately; others after commit). */
  delete(collection: string, key: string): Promise<boolean>;
  /** Commit the transaction. Throws on failure. */
  commit(): Promise<void>;
  /** Roll back the transaction. Idempotent. */
  rollback(): Promise<void>;
  /** True once the transaction has been committed or rolled back. */
  readonly settled: boolean;
  /** Stable transaction id (for audit lineage). */
  readonly transactionId: string;
}

export interface PostgresAuthority {
  /**
   * Begin a transaction. The provided ExecutionContext is propagated so
   * the audit boundary can correlate the transaction with its execution.
   */
  begin(context: ExecutionContext): Promise<AuthorityTransaction>;
  /**
   * Run `work` inside a transaction. Commits on success, rolls back on
   * error, and rethrows. Guarantees at-most-once side effects in the
   * absence of internal retries.
   */
  run<T>(context: ExecutionContext, work: (tx: AuthorityTransaction) => Promise<T>): Promise<T>;
  /** Read committed state (outside any transaction). */
  get<T = unknown>(collection: string, key: string): Promise<AuthorityRecord<T> | null>;
  /** Scan committed state (outside any transaction). */
  scan<T = unknown>(collection: string): Promise<readonly AuthorityRecord<T>[]>;
  /** Count committed records in a collection. */
  count(collection: string): Promise<number>;
  /**
   * Recover durable state on (re)start. Restores ONLY committed
   * records. Uncommitted writes from an interrupted transaction are
   * discarded. Idempotent.
   */
  recover(): Promise<{ readonly recoveredRecords: number; readonly discardedTransactions: number }>;
  /** Close the authority (release resources). */
  close(): Promise<void>;
}
