/**
 * Durable TransactionManager — NET-W003 concrete implementation.
 *
 * Work order ref: NET-W003 §4.5 (Transactions, rollback and recovery),
 * AC-05 (Transaction rollback/recovery).
 *
 * Wraps a {@link PostgresAuthority} so the existing
 * {@link TransactionManager} contract from NET-W001 now carries REAL
 * transaction semantics: uncommitted writes are NOT visible outside
 * the transaction, rollback discards all uncommitted work, and
 * recovery-on-restart restores only committed state.
 *
 * The existing {@link createInMemoryTransactionManager} from NET-W001
 * remains available as a test double for suites that don't need
 * durability. Both sit behind the SAME {@link TransactionManager} port.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type { Transaction, TransactionManager } from "./transaction-manager.ts";

/**
 * A transaction handle that delegates to an {@link AuthorityTransaction}.
 * The underlying authority transaction provides real commit/rollback
 * semantics (buffered writes, atomic apply-on-commit, discard-on-rollback).
 */
class DurableTransaction implements Transaction {
  private letSettled = false;

  public constructor(
    private readonly inner: AuthorityTransaction,
    private readonly onAfterCommit?: (tx: AuthorityTransaction) => Promise<void>,
    private readonly onAfterRollback?: (tx: AuthorityTransaction) => Promise<void>,
  ) {
    // `settled` is derived from the inner transaction's state.
  }

  public get settled(): boolean {
    return this.letSettled || this.inner.settled;
  }

  public get transactionId(): string {
    return this.inner.transactionId;
  }

  public get innerTransaction(): AuthorityTransaction {
    return this.inner;
  }

  public async commit(): Promise<void> {
    if (this.letSettled) return;
    await this.inner.commit();
    this.letSettled = true;
    if (this.onAfterCommit) {
      try {
        await this.onAfterCommit(this.inner);
      } catch {
        // Post-commit hooks (e.g. flushing a transactional audit buffer)
        // must not undo the committed transaction. A failure here is
        // logged by the hook; the transaction remains committed.
      }
    }
  }

  public async rollback(): Promise<void> {
    if (this.letSettled) return;
    await this.inner.rollback();
    this.letSettled = true;
    if (this.onAfterRollback) {
      try {
        await this.onAfterRollback(this.inner);
      } catch {
        // Same rationale as commit: rollback stands.
      }
    }
  }
}

export interface DurableTransactionManagerOptions {
  readonly authority: PostgresAuthority;
  /** Hook fired after a successful commit (e.g. flush transactional audit). */
  readonly onAfterCommit?: (tx: AuthorityTransaction) => Promise<void>;
  /** Hook fired after a rollback (e.g. discard transactional audit buffer). */
  readonly onAfterRollback?: (tx: AuthorityTransaction) => Promise<void>;
}

export function createDurableTransactionManager(
  opts: DurableTransactionManagerOptions,
): TransactionManager {
  const authority = opts.authority;
  return {
    async begin(context: ExecutionContext): Promise<Transaction> {
      const inner = await authority.begin(context);
      return new DurableTransaction(inner, opts.onAfterCommit, opts.onAfterRollback);
    },
    async run<T>(context: ExecutionContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
      const tx = await this.begin(context);
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

/**
 * Type helper to access the underlying {@link AuthorityTransaction} for a
 * {@link Transaction} produced by the durable manager. Returns `null`
 * when the transaction is not a {@link DurableTransaction} (e.g. the
 * NET-W001 in-memory test double). Used by transactional audit/idempotency
 * layers that need to couple their write to the same authoritative tx.
 */
export function asAuthorityTransaction(tx: Transaction): AuthorityTransaction | null {
  if (tx instanceof DurableTransaction) {
    return tx.innerTransaction;
  }
  // Structural duck-typing fallback (for tests that wrap the durable tx).
  const maybe = tx as unknown as { innerTransaction?: AuthorityTransaction };
  return maybe.innerTransaction ?? null;
}
