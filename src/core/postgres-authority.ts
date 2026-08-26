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
 * driver. Domain and infrastructure modules consume this contract;
 * the concrete implementations sit behind the adapter boundary:
 *
 *  - `src/adapters/postgres/postgres-authority-adapter.ts` — the REAL
 *    PostgreSQL driver integration (the `pg` package), exercised by
 *    `tests/integration/postgres-authority-integration.test.ts`
 *    against a real PostgreSQL (CI service container or
 *    `docker compose up`).
 *  - `src/persistence/postgres-authority-shim.ts` — a clearly-marked
 *    file-backed TEST DOUBLE for deterministic unit tests that do not
 *    need a real database; it demonstrates the SAME authority
 *    semantics (durability across restart, transactional atomicity,
 *    recovery).
 *
 * The architecture checker permits `pg` ONLY in the adapter tier
 * (`ADAPTER_ALLOWED_EXTERNAL_PACKAGES`); it is never imported from
 * core/domain/infrastructure, so domain modules remain
 * provider-independent (frozen architecture §14).
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
 *
 * NET-W004-AC-07 remediation (transaction-ordering, architect re-review
 * on PR #8): transactions expose LIFECYCLE HOOKS so transaction-scoped
 * side effects — transactional audit publication — can NEVER become
 * visible before the authoritative commit succeeds:
 *
 *  - `afterCommit` hooks run STRICTLY AFTER the durable commit
 *    succeeded (they are the only code path allowed to publish
 *    transaction-scoped side effects such as the transactional audit
 *    buffer).
 *  - `afterRollback` hooks run when the transaction settles WITHOUT a
 *    successful durable commit — an explicit `rollback()` OR a
 *    `commit()` whose durable phase failed (the store then treats the
 *    transaction as rolled back: nothing was committed).
 *
 * Commit ordering contract (all implementations MUST honour it):
 *
 * ```text
 * tx.commit()
 *   ├── durable commit fails  → run afterRollback hooks → throw
 *   └── durable commit ok     → run afterCommit hooks (sequentially)
 * ```
 *
 * A failure inside an `afterCommit` hook NEVER fails or undoes the
 * already-durable commit: the authoritative commit is the source of
 * truth, and each hook owns its failure recovery (e.g. the
 * transactional audit writer retries publication, then retains the
 * unpublished events for an explicit recovery path). Implementations
 * surface hook errors through their logger, not through `commit()`
 * throwing after a successful durable commit — throwing would misreport
 * a committed transaction as failed and invite double mutations.
 *
 * `afterRollback` hook errors are swallowed (logged): the transaction
 * already failed; cleanup is best-effort.
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
  /**
   * Register a hook that runs AFTER this transaction durably commits.
   * Hooks run in registration order, strictly after the durable commit.
   * This is the ONLY sanctioned place to publish transaction-scoped
   * side effects (transactional audit publication) — publishing from
   * inside the transaction (before `commit()`) can leave visible side
   * effects for a mutation that never committed.
   *
   * A hook failure never fails or undoes the durable commit; each hook
   * owns its failure recovery. Registering on a settled transaction is
   * an invariant violation (the hook could never run).
   */
  afterCommit(hook: () => Promise<void>): void;
  /**
   * Register a hook that runs when this transaction settles WITHOUT a
   * successful durable commit — an explicit `rollback()` or a failed
   * `commit()`. Hooks discard transaction-scoped side effects (e.g.
   * discard the transactional audit buffer so no audit record survives
   * for a mutation that never committed). Hook errors are swallowed
   * (logged): cleanup after a failed transaction is best-effort.
   *
   * Registering on a settled transaction is an invariant violation.
   */
  afterRollback(hook: () => Promise<void>): void;
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
