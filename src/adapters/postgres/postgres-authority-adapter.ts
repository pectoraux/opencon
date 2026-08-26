/**
 * Real PostgreSQL `PostgresAuthority` adapter.
 *
 * Work order ref: NET-W003 §4.1 (PostgreSQL authoritative persistence),
 * §4.5 (Transactions, rollback and recovery), §6 (PostgresAuthority),
 * architecture-lock §3 (PostgreSQL is authoritative application state
 * in v1.0), §14 (provider-specific SDK/types do not cross into core
 * domain modules), §18 (`/adapters` = external platform/provider
 * integrations).
 *
 * This is a REAL PostgreSQL driver integration (the `pg` package). It
 * is the authoritative application-state boundary for v1.0 — committed
 * writes here survive process restart because they are persisted in
 * PostgreSQL's durable storage (WAL + heap). Transactions use real
 * PostgreSQL `BEGIN`/`COMMIT`/`ROLLBACK` semantics: under the default
 * READ COMMITTED isolation, writes inside a transaction are NOT
 * visible to outside readers until `COMMIT`; `ROLLBACK` discards all
 * uncommitted work.
 *
 * Recovery-on-restart: PostgreSQL is itself the system of record, so
 * committed state is already durable. The adapter additionally tracks
 * begun-but-not-settled transactions in a small `opencon_inflight_tx`
 * table; on `recover()` it reports any orphaned in-flight rows
 * (whose underlying SQL transaction was auto-rolled-back when the
 * connection dropped) as discarded and removes them. Uncommitted
 * writes are NEVER visible after recovery.
 *
 * Provider isolation (frozen architecture §14): this file is the ONLY
 * place that imports the `pg` driver. It implements the provider-neutral
 * {@link PostgresAuthority} contract from `src/core/postgres-authority.ts`;
 * domain and infrastructure modules consume that contract — they never
 * import `pg` directly. The architecture checker classifies this file
 * as adapter-tier and permits `pg` here (and ONLY here) via
 * `ADAPTER_ALLOWED_EXTERNAL_PACKAGES`.
 *
 * The file-backed `PostgresAuthorityShim` in `src/persistence/` remains
 * a clearly-marked TEST DOUBLE for deterministic unit tests that do not
 * need a real database. Both sit behind the SAME `PostgresAuthority`
 * contract. The real integration path is exercised by
 * `tests/integration/postgres-authority-integration.test.ts` (runs
 * when a real PostgreSQL is reachable via `PG_TEST_DATABASE_URL`).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type {
  AuthorityRecord,
  AuthorityTransaction,
  PostgresAuthority,
} from "../../core/postgres-authority.ts";
import type { ExecutionContext } from "../../core/execution-context.ts";
import { InvariantError } from "../../core/errors.ts";

/**
 * Connection string (e.g.
 * `postgres://user:pass@host:5432/db?schema=opencon`). Resolve through
 * the {@link SecretProvider} at the bootstrap boundary; this adapter
 * receives the already-resolved string and never reads env directly.
 */
export interface PostgresAuthorityAdapterOptions {
  /** PostgreSQL connection string (libpq URI). */
  readonly connectionString: string;
  /**
   * Optional schema/namespace prefix for the authority tables. Defaults
   * to `public`. Tests may set a unique schema to isolate parallel runs.
   */
  readonly schema?: string;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
    error?(message: string, fields?: Record<string, unknown>): void;
  };
}

const AUTHORITY_TABLE = "opencon_authority";
const INFLIGHT_TABLE = "opencon_inflight_tx";

function fqTable(schema: string, table: string): string {
  // Quote both identifiers so caller-controlled schema/table names are
  // never interpolated raw into SQL (SQL-injection hygiene).
  return `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
}

/**
 * A row of the `opencon_authority` table as returned by the driver.
 * `value` is stored as JSONB; we round-trip via JSON.stringify/string.
 */
interface AuthorityRow extends QueryResultRow {
  collection: string;
  key: string;
  value: string;
  execution_id: string;
  correlation_id: string;
  actor_id: string | null;
  written_at: Date | string;
  revision: string | number;
}

function toAuthorityRecord<T>(row: AuthorityRow): AuthorityRecord<T> {
  const value = row.value == null ? null : JSON.parse(row.value as string);
  const writtenAt =
    row.written_at instanceof Date
      ? row.written_at.toISOString()
      : (row.written_at as string);
  return {
    collection: row.collection,
    key: row.key,
    value: value as T,
    executionId: row.execution_id,
    correlationId: row.correlation_id,
    actorId: row.actor_id,
    writtenAt,
    revision: Number(row.revision),
  };
}

/**
 * A real PostgreSQL transaction. The driver's BEGIN/COMMIT/ROLLBACK
 * provide genuine atomicity and isolation: writes inside this
 * transaction are buffered server-side and are NOT visible to other
 * transactions (or to outside readers) until COMMIT.
 *
 * NET-W004-AC-07 remediation (transaction-ordering): the transaction
 * exposes afterCommit/afterRollback lifecycle hooks. afterCommit hooks
 * (transactional audit publication) run STRICTLY AFTER the SQL COMMIT
 * succeeded — transaction-scoped side effects can never become visible
 * for a mutation that never committed. If the SQL COMMIT itself fails,
 * PostgreSQL has already rolled the transaction back, so afterRollback
 * hooks run to discard transaction-scoped side effects before the
 * error surfaces. A hook failure never fails or undoes the already
 * durable COMMIT: each hook owns its failure recovery; the adapter
 * logs the hook error.
 */
class PostgresAuthorityTransaction implements AuthorityTransaction {
  private letSettled = false;
  public readonly transactionId: string;
  private clientExecutionContext:
    | { executionId: string; correlationId: string; actorId: string | null }
    | null = null;
  /** afterCommit hooks — run strictly AFTER the durable SQL COMMIT. */
  private readonly commitHooks: Array<() => Promise<void>> = [];
  /** afterRollback hooks — run when the tx settles WITHOUT a durable commit. */
  private readonly rollbackHooks: Array<() => Promise<void>> = [];

  public constructor(
    transactionId: string,
    private readonly client: PoolClient,
    private readonly schema: string,
    private readonly logger?: {
      debug(message: string, fields?: Record<string, unknown>): void;
      warn?(message: string, fields?: Record<string, unknown>): void;
      error?(message: string, fields?: Record<string, unknown>): void;
    },
  ) {
    this.transactionId = transactionId;
  }

  public get settled(): boolean {
    return this.letSettled;
  }

  /** Called by the adapter at begin() to bind the execution context. */
  public bindExecutionContext(ctx: ExecutionContext): void {
    this.clientExecutionContext = {
      executionId: ctx.executionId,
      correlationId: ctx.correlationId,
      actorId: ctx.actor?.id ?? null,
    };
  }

  public afterCommit(hook: () => Promise<void>): void {
    if (this.letSettled) {
      throw new InvariantError(
        `transaction ${this.transactionId} already settled; cannot register an afterCommit hook`,
      );
    }
    this.commitHooks.push(hook);
  }

  public afterRollback(hook: () => Promise<void>): void {
    if (this.letSettled) {
      throw new InvariantError(
        `transaction ${this.transactionId} already settled; cannot register an afterRollback hook`,
      );
    }
    this.rollbackHooks.push(hook);
  }

  /** Run afterCommit hooks sequentially; log (never throw) on failure. */
  private async runCommitHooks(): Promise<void> {
    for (const hook of this.commitHooks) {
      try {
        await hook();
      } catch (err) {
        this.logHookError("afterCommit", err);
      }
    }
  }

  /** Run afterRollback hooks sequentially; log (never throw) on failure. */
  private async runRollbackHooks(): Promise<void> {
    for (const hook of this.rollbackHooks) {
      try {
        await hook();
      } catch (err) {
        this.logHookError("afterRollback", err);
      }
    }
  }

  private logHookError(phase: "afterCommit" | "afterRollback", err: unknown): void {
    const fields = {
      txId: this.transactionId,
      phase,
      error: err instanceof Error ? err.message : String(err),
    };
    if (this.logger?.error) {
      this.logger.error("authority.tx_hook_failed", fields);
    } else {
      this.logger?.debug("authority.tx_hook_failed", fields);
    }
  }

  public async get<T = unknown>(collection: string, key: string): Promise<AuthorityRecord<T> | null> {
    const table = fqTable(this.schema, AUTHORITY_TABLE);
    const res = await this.client.query<AuthorityRow>(
      `SELECT collection, key, value::text AS value, execution_id, correlation_id, actor_id, written_at, revision
       FROM ${table}
       WHERE collection = $1 AND key = $2`,
      [collection, key],
    );
    if (res.rowCount === 0) return null;
    return toAuthorityRecord<T>(res.rows[0]!);
  }

  public async scan<T = unknown>(collection: string): Promise<readonly AuthorityRecord<T>[]> {
    const table = fqTable(this.schema, AUTHORITY_TABLE);
    const res = await this.client.query<AuthorityRow>(
      `SELECT collection, key, value::text AS value, execution_id, correlation_id, actor_id, written_at, revision
       FROM ${table}
       WHERE collection = $1`,
      [collection],
    );
    return res.rows.map((r) => toAuthorityRecord<T>(r));
  }

  public async put<T>(collection: string, key: string, value: T): Promise<AuthorityRecord<T>> {
    if (this.letSettled) {
      throw new InvariantError(`transaction ${this.transactionId} already settled`);
    }
    const table = fqTable(this.schema, AUTHORITY_TABLE);
    const ctx = this.clientExecutionContext ?? {
      executionId: "",
      correlationId: "",
      actorId: null,
    };
    // Atomic upsert with monotonic revision: revision is incremented
    // server-side via the ON CONFLICT branch (revision + 1), or set to
    // 1 on first insert. RETURNING yields the authoritative revision.
    const res = await this.client.query<AuthorityRow>(
      `INSERT INTO ${table}
         (collection, key, value, execution_id, correlation_id, actor_id, written_at, revision)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, statement_timestamp(), 1)
       ON CONFLICT (collection, key) DO UPDATE
         SET value = EXCLUDED.value,
             execution_id = EXCLUDED.execution_id,
             correlation_id = EXCLUDED.correlation_id,
             actor_id = EXCLUDED.actor_id,
             written_at = EXCLUDED.written_at,
             revision = ${table}.revision + 1
       RETURNING collection, key, value::text AS value, execution_id, correlation_id, actor_id, written_at, revision`,
      [
        collection,
        key,
        JSON.stringify(value),
        ctx.executionId,
        ctx.correlationId,
        ctx.actorId,
      ],
    );
    this.logger?.debug("authority.tx_put", {
      txId: this.transactionId,
      collection,
      key,
      revision: Number(res.rows[0]?.revision ?? 0),
    });
    return toAuthorityRecord<T>(res.rows[0]!);
  }

  public async delete(collection: string, key: string): Promise<boolean> {
    if (this.letSettled) {
      throw new InvariantError(`transaction ${this.transactionId} already settled`);
    }
    const table = fqTable(this.schema, AUTHORITY_TABLE);
    const res = await this.client.query(
      `DELETE FROM ${table} WHERE collection = $1 AND key = $2`,
      [collection, key],
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async commit(): Promise<void> {
    if (this.letSettled) return;
    this.letSettled = true;
    // NET-W004-AC-07 remediation (transaction-ordering): the durable
    // SQL COMMIT happens FIRST. Only after it succeeds do the
    // afterCommit hooks run — transaction-scoped side effects
    // (transactional audit publication) become visible STRICTLY AFTER
    // the authoritative commit. If the SQL COMMIT fails, PostgreSQL
    // has already rolled the transaction back: afterRollback hooks run
    // so transaction-scoped side effects (buffered audit) are
    // discarded — no audit record can survive for a mutation that
    // never committed.
    try {
      await this.client.query("COMMIT");
    } catch (err) {
      // COMMIT failed: PostgreSQL already rolled back. Best-effort
      // cleanup of the in-flight marker, then discard tx-scoped side
      // effects (buffered audit) via the afterRollback hooks.
      try {
        await this.client.query("ROLLBACK");
      } catch {
        // ignore
      }
      try {
        await this.client.query(
          `DELETE FROM ${fqTable(this.schema, INFLIGHT_TABLE)} WHERE tx_id = $1`,
          [this.transactionId],
        );
      } catch {
        // ignore — recover() will report the orphaned marker on restart
      }
      await this.runRollbackHooks();
      this.client.release();
      throw err;
    }
    // The durable COMMIT succeeded. The in-flight marker cleanup is
    // POST-commit bookkeeping: its failure must NOT misreport the
    // durable commit as failed (that could make a caller retry a
    // committed mutation); recover() reports orphaned markers instead.
    try {
      await this.client.query(
        `DELETE FROM ${fqTable(this.schema, INFLIGHT_TABLE)} WHERE tx_id = $1`,
        [this.transactionId],
      );
    } catch (err) {
      this.logger?.warn?.("authority.inflight_marker_cleanup_failed", {
        txId: this.transactionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.client.release();
    // Durable commit + bookkeeping done → publish tx-scoped side
    // effects (transactional audit). Hook errors are logged by
    // runCommitHooks and never fail the durable commit.
    await this.runCommitHooks();
    this.logger?.debug("authority.tx_commit", { txId: this.transactionId });
  }

  public async rollback(): Promise<void> {
    if (this.letSettled) return;
    this.letSettled = true;
    try {
      await this.client.query("ROLLBACK");
      // Remove the in-flight marker (the user's tx was discarded, so
      // the marker is no longer needed).
      await this.client.query(
        `DELETE FROM ${fqTable(this.schema, INFLIGHT_TABLE)} WHERE tx_id = $1`,
        [this.transactionId],
      );
    } finally {
      this.client.release();
    }
    // Discard transaction-scoped side effects (buffered audit) —
    // best-effort: hook errors are logged, never thrown.
    await this.runRollbackHooks();
    this.logger?.debug("authority.tx_rollback", { txId: this.transactionId });
  }
}

/**
 * Real PostgreSQL `PostgresAuthority`. Durability, atomicity and
 * recovery are provided by PostgreSQL itself. Construct with a
 * connection string resolved through the SecretProvider; call
 * `ensureSchema()` (or `recover()`, which calls it) once on startup.
 */
export class PostgresAuthorityAdapter implements PostgresAuthority {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
    error?(message: string, fields?: Record<string, unknown>): void;
  };
  private schemaReady = false;

  public constructor(opts: PostgresAuthorityAdapterOptions) {
    this.schema = opts.schema ?? "public";
    this.logger = opts.logger;
    this.pool = new pg.Pool({ connectionString: opts.connectionString });
  }

  /** Create the authority tables if they do not yet exist. Idempotent. */
  public async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const client = await this.pool.connect();
    try {
      // Create the schema if a non-public schema was requested (so
      // isolated test runs can each use their own namespace).
      if (this.schema !== "public") {
        await client.query(
          `CREATE SCHEMA IF NOT EXISTS "${this.schema.replace(/"/g, '""')}"`,
        );
      }
      const table = fqTable(this.schema, AUTHORITY_TABLE);
      const inflight = fqTable(this.schema, INFLIGHT_TABLE);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          collection      text        NOT NULL,
          key             text        NOT NULL,
          value           jsonb       NOT NULL,
          execution_id    text        NOT NULL,
          correlation_id  text        NOT NULL,
          actor_id        text,
          written_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
          revision        bigint      NOT NULL,
          PRIMARY KEY (collection, key)
        );
        CREATE TABLE IF NOT EXISTS ${inflight} (
          tx_id    text PRIMARY KEY,
          begun_at timestamptz NOT NULL DEFAULT statement_timestamp()
        );
      `);
      this.schemaReady = true;
      this.logger?.debug("authority.schema_ready", { schema: this.schema });
    } finally {
      client.release();
    }
  }

  public async begin(context: ExecutionContext): Promise<AuthorityTransaction> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    const txId = randomUUID();
    try {
      // Commit the in-flight marker in its OWN transaction BEFORE the
      // user's transaction begins. If the marker were inside the user's
      // BEGIN..COMMIT, a mid-transaction crash would roll it back too,
      // and recover() could not report the interrupted transaction.
      // With the marker committed separately, a connection-drop leaves
      // the marker row behind (PostgreSQL auto-rolls-back the user's
      // open transaction, but the marker survives) so recover() can
      // detect and report it as discarded.
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${fqTable(this.schema, INFLIGHT_TABLE)} (tx_id) VALUES ($1)`,
        [txId],
      );
      await client.query("COMMIT");
      // Now begin the USER's transaction.
      await client.query("BEGIN");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — best-effort cleanup
      } finally {
        client.release();
      }
      throw err;
    }
    const tx = new PostgresAuthorityTransaction(txId, client, this.schema, this.logger);
    tx.bindExecutionContext(context);
    this.logger?.debug("authority.tx_begin", { txId, executionId: context.executionId });
    return tx;
  }

  public async run<T>(
    context: ExecutionContext,
    work: (tx: AuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    const tx = await this.begin(context);
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  public async get<T = unknown>(collection: string, key: string): Promise<AuthorityRecord<T> | null> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      const res = await client.query<AuthorityRow>(
        `SELECT collection, key, value::text AS value, execution_id, correlation_id, actor_id, written_at, revision
         FROM ${fqTable(this.schema, AUTHORITY_TABLE)}
         WHERE collection = $1 AND key = $2`,
        [collection, key],
      );
      if (res.rowCount === 0) return null;
      return toAuthorityRecord<T>(res.rows[0]!);
    } finally {
      client.release();
    }
  }

  public async scan<T = unknown>(collection: string): Promise<readonly AuthorityRecord<T>[]> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      const res = await client.query<AuthorityRow>(
        `SELECT collection, key, value::text AS value, execution_id, correlation_id, actor_id, written_at, revision
         FROM ${fqTable(this.schema, AUTHORITY_TABLE)}
         WHERE collection = $1`,
        [collection],
      );
      return res.rows.map((r) => toAuthorityRecord<T>(r));
    } finally {
      client.release();
    }
  }

  public async count(collection: string): Promise<number> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      const res = await client.query<QueryResultRow>(
        `SELECT COUNT(*)::text AS count FROM ${fqTable(this.schema, AUTHORITY_TABLE)} WHERE collection = $1`,
        [collection],
      );
      return Number(res.rows[0]?.count ?? 0);
    } finally {
      client.release();
    }
  }

  public async recover(): Promise<{ recoveredRecords: number; discardedTransactions: number }> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      // PostgreSQL is itself durable; committed records are already
      // present. We count them as recovered.
      const committed = await client.query<QueryResultRow>(
        `SELECT COUNT(*)::text AS count FROM ${fqTable(this.schema, AUTHORITY_TABLE)}`,
      );
      const recoveredRecords = Number(committed.rows[0]?.count ?? 0);

      // Any rows left in the in-flight table belong to transactions
      // whose connection dropped before COMMIT/ROLLBACK. PostgreSQL
      // already rolled back their SQL work; only the marker row
      // (committed in its own tiny transaction at begin()) remains.
      // Discard the markers and report them as interrupted txns.
      const inflight = await client.query<QueryResultRow>(
        `SELECT COUNT(*)::text AS count FROM ${fqTable(this.schema, INFLIGHT_TABLE)}`,
      );
      const discarded = Number(inflight.rows[0]?.count ?? 0);
      if (discarded > 0) {
        await client.query(`DELETE FROM ${fqTable(this.schema, INFLIGHT_TABLE)}`);
      }
      this.logger?.debug("authority.recovered", {
        recoveredRecords,
        discardedTransactions: discarded,
      });
      return { recoveredRecords, discardedTransactions: discarded };
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
    this.logger?.debug("authority.closed", {});
  }
}

// Re-export the driver types for adapter consumers (composition root,
// integration tests) without leaking `pg` beyond the adapter boundary.
export type { Pool, PoolClient, QueryResult, QueryResultRow };
