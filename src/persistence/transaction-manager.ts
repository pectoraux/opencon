/**
 * Persistence boundary — authoritative state interface.
 *
 * Work order ref: NET-W001 §4.1 (`/persistence`), architecture-lock.md
 * §3 (PostgreSQL is authoritative application state in v1.0), §16
 * (Redis/caches/queues are never authoritative).
 *
 * NET-W001 ships ONLY the contract and a skeletal in-memory transaction
 * manager sufficient to prove the boundary. A real PostgreSQL backend
 * is the subject of NET-W003. This interface deliberately exposes
 * transaction boundaries (§4.2) without committing to a driver.
 */

import type { ExecutionContext } from "../core/execution-context.ts";

export interface Transaction {
  /** Commit the transaction. Throws on failure. */
  commit(): Promise<void>;
  /** Rollback the transaction. Idempotent. */
  rollback(): Promise<void>;
  /** True once the transaction has been committed or rolled back. */
  readonly settled: boolean;
}

export interface TransactionManager {
  /**
   * Begin a transaction. The provided ExecutionContext is propagated so
   * the audit boundary can correlate the transaction with its execution.
   */
  begin(context: ExecutionContext): Promise<Transaction>;
  /**
   * Run `work` inside a transaction. Commits on success, rolls back on
   * error, and rethrows. Guarantees at-most-once side effects in the
   * absence of internal retries.
   */
  run<T>(context: ExecutionContext, work: (tx: Transaction) => Promise<T>): Promise<T>;
}

/**
 * Skeletal in-memory TransactionManager. Proves the contract; no real
 * isolation semantics. Real persistence lives in NET-W003.
 */
export function createInMemoryTransactionManager(): TransactionManager {
  return {
    async begin() {
      let settled = false;
      return {
        commit: async () => {
          settled = true;
        },
        rollback: async () => {
          settled = true;
        },
        get settled() {
          return settled;
        },
      };
    },
    async run(_context, work) {
      const tx = await this.begin(_context);
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    },
  };
}
