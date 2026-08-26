/**
 * File-backed PostgresAuthority shim — authoritative persistence test double.
 *
 * Work order ref: NET-W003 §4.1 (PostgreSQL authoritative persistence),
 * §4.5 (Transactions, rollback and recovery), AC-01 (PostgreSQL
 * authority), AC-05 (Transaction rollback/recovery).
 *
 * TEST DOUBLE — clearly marked. This is NOT the real PostgreSQL
 * driver. It is a file-backed authoritative persistence store that
 * demonstrates the SAME authority semantics required by NET-W003:
 *
 *  - Durability: committed records survive process restart (persisted
 *    to `<dir>/committed.json` via atomic temp-file + rename).
 *  - Transactional atomicity: writes inside a transaction are buffered
 *    in-memory and applied to committed state ONLY on `commit`. Rollback
 *    discards them. Either commits atomically or not at all.
 *  - Recovery-on-restart: `recover()` loads the committed snapshot and
 *    reports any interrupted (begun-but-not-settled) transactions as
 *    discarded. Uncommitted writes are NEVER visible after recovery.
 *
 * The REAL PostgreSQL driver integration lives in
 * `src/adapters/postgres/postgres-authority-adapter.ts` (the `pg`
 * package), exercised by `tests/integration/postgres-authority-integration.test.ts`
 * against a real PostgreSQL service. This shim remains for
 * deterministic unit tests that do not need a real database. Domain
 * code consumes the {@link PostgresAuthority} contract; it never
 * imports this shim directly (only bootstrap/tests do).
 *
 * Recovery hardening (architect re-review on PR #6): a corrupt
 * committed snapshot surfaces as a {@link StorageCorruptionError}
 * rather than silently becoming an empty store — an authority
 * boundary must never convert storage corruption into data loss.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthorityRecord,
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { InvariantError, StorageCorruptionError } from "../core/errors.ts";

/**
 * A committed record as persisted to the snapshot. The execution
 * context fields are carried forward so material mutations are
 * traceable to their execution (NET-W003 §4.8).
 */
interface PersistedRecord {
  readonly collection: string;
  readonly key: string;
  readonly value: unknown;
  readonly executionId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly writtenAt: string;
  readonly revision: number;
}

interface PersistedSnapshot {
  readonly version: 1;
  readonly records: Record<string, Record<string, PersistedRecord>>;
  readonly revisions: Record<string, Record<string, number>>;
}

interface InflightLog {
  readonly version: 1;
  readonly activeTransactionIds: readonly string[];
}

interface BufferedWrite {
  readonly kind: "put" | "delete";
  readonly collection: string;
  readonly key: string;
  readonly record?: PersistedRecord;
}

class ShimTransaction implements AuthorityTransaction {
  private readonly writes: Map<string, BufferedWrite> = new Map();
  private letSettled = false;
  public readonly transactionId: string;
  /** afterCommit hooks — run strictly AFTER the durable commit (NET-W004-AC-07). */
  private readonly commitHooks: Array<() => Promise<void>> = [];
  /** afterRollback hooks — run when the tx settles WITHOUT a durable commit. */
  private readonly rollbackHooks: Array<() => Promise<void>> = [];

  public constructor(
    transactionId: string,
    private readonly context: ExecutionContext,
    private readonly authority: PostgresAuthorityShim,
  ) {
    this.transactionId = transactionId;
  }

  public get settled(): boolean {
    return this.letSettled;
  }

  private bufferKey(collection: string, key: string): string {
    return `${collection}::${key}`;
  }

  public async get<T = unknown>(collection: string, key: string): Promise<AuthorityRecord<T> | null> {
    // Sees uncommitted writes in this tx first, then committed state.
    const buf = this.writes.get(this.bufferKey(collection, key));
    if (buf) {
      if (buf.kind === "delete") return null;
      if (buf.record) return this.authority.toAuthorityRecord<T>(buf.record);
    }
    return this.authority.get<T>(collection, key);
  }

  public async scan<T = unknown>(collection: string): Promise<readonly AuthorityRecord<T>[]> {
    const committed = await this.authority.scan<T>(collection);
    // Apply buffered writes on top of committed state.
    const map = new Map<string, AuthorityRecord<T>>();
    for (const r of committed) map.set(r.key, r);
    for (const [bk, buf] of this.writes) {
      const parts = bk.split("::");
      const coll = parts[0] ?? "";
      const key = parts[1] ?? "";
      if (coll !== collection) continue;
      if (buf.kind === "delete") {
        map.delete(key);
      } else if (buf.record) {
        map.set(key, this.authority.toAuthorityRecord<T>(buf.record));
      }
    }
    return Array.from(map.values());
  }

  public async put<T>(collection: string, key: string, value: T): Promise<AuthorityRecord<T>> {
    if (this.letSettled) throw new InvariantError(`transaction ${this.transactionId} already settled`);
    const revision = await this.authority.nextRevision(collection, key);
    const record: PersistedRecord = {
      collection,
      key,
      value,
      executionId: this.context.executionId,
      correlationId: this.context.correlationId,
      actorId: this.context.actor?.id ?? null,
      writtenAt: new Date().toISOString(),
      revision,
    };
    this.writes.set(this.bufferKey(collection, key), { kind: "put", collection, key, record });
    return this.authority.toAuthorityRecord<T>(record);
  }

  public async delete(collection: string, key: string): Promise<boolean> {
    if (this.letSettled) throw new InvariantError(`transaction ${this.transactionId} already settled`);
    const existed = (await this.authority.get(collection, key)) !== null;
    this.writes.set(this.bufferKey(collection, key), { kind: "delete", collection, key });
    return existed;
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

  /**
   * Run the afterCommit hooks sequentially. A hook failure NEVER fails
   * the (already durable) commit: each hook owns its failure recovery
   * (e.g. the transactional audit writer retries publication, then
   * retains the unpublished events for an explicit recovery path); the
   * authority only logs the hook error.
   */
  private async runCommitHooks(): Promise<void> {
    for (const hook of this.commitHooks) {
      try {
        await hook();
      } catch (err) {
        this.authority.logHookError("afterCommit", this.transactionId, err);
      }
    }
  }

  /**
   * Run the afterRollback hooks sequentially (best-effort: the tx
   * already failed; hook errors are logged and swallowed so cleanup of
   * other hooks still runs).
   */
  private async runRollbackHooks(): Promise<void> {
    for (const hook of this.rollbackHooks) {
      try {
        await hook();
      } catch (err) {
        this.authority.logHookError("afterRollback", this.transactionId, err);
      }
    }
  }

  public async commit(): Promise<void> {
    if (this.letSettled) return;
    this.letSettled = true;
    // NET-W004-AC-07 remediation (transaction-ordering): the durable
    // commit happens FIRST. Only after it succeeds do the afterCommit
    // hooks run — transaction-scoped side effects (transactional audit
    // publication) therefore become visible STRICTLY AFTER the
    // authoritative commit. If the durable commit FAILS, the tx settles
    // as rolled back: afterRollback hooks run so transaction-scoped
    // side effects (buffered audit) are discarded — no audit record can
    // survive for a mutation that never committed.
    try {
      await this.authority.applyCommit(this.transactionId, this.writes);
    } catch (err) {
      await this.runRollbackHooks();
      throw err;
    }
    await this.runCommitHooks();
  }

  public async rollback(): Promise<void> {
    if (this.letSettled) return;
    this.letSettled = true;
    // Discard buffered writes — nothing was persisted to committed state.
    this.writes.clear();
    await this.authority.applyRollback(this.transactionId);
    // Discard transaction-scoped side effects (buffered audit) too.
    await this.runRollbackHooks();
  }
}

export interface PostgresAuthorityShimOptions {
  /** Directory for the durable snapshot + in-flight log. Must exist or be creatable. */
  readonly dir: string;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
    error?(message: string, fields?: Record<string, unknown>): void;
  };
}

export class PostgresAuthorityShim implements PostgresAuthority {
  private readonly committed = new Map<string, Map<string, PersistedRecord>>();
  private readonly revisions = new Map<string, Map<string, number>>();
  private readonly activeTxIds = new Set<string>();
  private readonly dir: string;
  private readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
    error?(message: string, fields?: Record<string, unknown>): void;
  };
  private loaded = false;

  public constructor(opts: PostgresAuthorityShimOptions) {
    this.dir = opts.dir;
    this.logger = opts.logger;
  }

  public toAuthorityRecord<T>(p: PersistedRecord): AuthorityRecord<T> {
    return {
      collection: p.collection,
      key: p.key,
      value: p.value as T,
      executionId: p.executionId,
      correlationId: p.correlationId,
      actorId: p.actorId,
      writtenAt: p.writtenAt,
      revision: p.revision,
    };
  }

  public async nextRevision(collection: string, key: string): Promise<number> {
    await this.ensureLoaded();
    let coll = this.revisions.get(collection);
    if (!coll) {
      coll = new Map();
      this.revisions.set(collection, coll);
    }
    const current = coll.get(key) ?? 0;
    const next = current + 1;
    return next;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    // Ensure the persistence dir exists before reading/writing. The
    // dev/test provider-selection.ts sets the shim dir to a unique
    // subdirectory under the OS tmp dir, which may not exist yet on
    // first use. Without this mkdir, the first `fs.writeFile(tmp, ...)`
    // fails with ENOENT because the parent dir is missing.
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch {
      // If mkdir fails (e.g. permission), the subsequent load/read calls
      // will surface the appropriate error. Don't mask the real failure
      // here with a misleading "could not create dir" error.
    }
    await this.loadCommitted();
    await this.loadInflight();
  }

  private committedPath(): string {
    return join(this.dir, "committed.json");
  }

  private inflightPath(): string {
    return join(this.dir, "inflight.json");
  }

  private async loadCommitted(): Promise<void> {
    const path = this.committedPath();
    if (!existsSync(path)) return;
    // An authority boundary MUST NOT silently convert storage
    // corruption into an empty store — that would turn corruption
    // into data loss. A malformed committed snapshot is surfaced as
    // an explicit `StorageCorruptionError` (invariant / not retryable)
    // so the operator restores from backup rather than running with a
    // silently-wiped authority. (Architect re-review on PR #6.)
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err) {
      throw new StorageCorruptionError(
        `authority committed snapshot is unreadable at ${path}`,
        { path },
        err,
      );
    }
    let snap: PersistedSnapshot;
    try {
      snap = JSON.parse(raw) as PersistedSnapshot;
    } catch (err) {
      throw new StorageCorruptionError(
        `authority committed snapshot is malformed (unparseable JSON) at ${path}`,
        { path, length: raw.length },
        err,
      );
    }
    if (!snap || typeof snap !== "object" || snap.version !== 1) {
      throw new StorageCorruptionError(
        `authority committed snapshot has an unsupported/missing version at ${path}`,
        { path, version: snap?.version },
      );
    }
    try {
      for (const [coll, byKey] of Object.entries(snap.records ?? {})) {
        const map = new Map<string, PersistedRecord>();
        for (const [key, rec] of Object.entries(byKey ?? {})) {
          if (!rec || typeof rec !== "object") {
            throw new StorageCorruptionError(
              `authority committed snapshot has a malformed record for ${coll}/${key}`,
              { path, collection: coll, key },
            );
          }
          map.set(key, rec as PersistedRecord);
        }
        this.committed.set(coll, map);
      }
      for (const [coll, byKey] of Object.entries(snap.revisions ?? {})) {
        const map = new Map<string, number>();
        for (const [key, rev] of Object.entries(byKey ?? {})) {
          map.set(key, rev as number);
        }
        this.revisions.set(coll, map);
      }
    } catch (err) {
      if (err instanceof StorageCorruptionError) throw err;
      throw new StorageCorruptionError(
        `authority committed snapshot is structurally corrupt at ${path}`,
        { path },
        err,
      );
    }
  }

  private async loadInflight(): Promise<void> {
    const path = this.inflightPath();
    if (!existsSync(path)) return;
    // The in-flight log is NON-AUTHORITATIVE coordination metadata —
    // it only records begun-but-not-settled transaction ids so
    // `recover()` can report them as discarded. Corruption here does
    // NOT endanger committed state: the safe recovery posture is to
    // treat ALL possibly-in-flight transactions as interrupted and
    // discard them (which is exactly what `recover()` does). So unlike
    // the committed snapshot, in-flight corruption is logged and
    // treated as "no active txns" rather than surfacing as a hard
    // error — recovery of committed state proceeds normally.
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err) {
      this.logger?.debug("authority.inflight_unreadable", { path });
      return;
    }
    try {
      const log = JSON.parse(raw) as InflightLog;
      if (log && Array.isArray(log.activeTransactionIds)) {
        for (const txId of log.activeTransactionIds) {
          if (typeof txId === "string") this.activeTxIds.add(txId);
        }
      }
    } catch {
      // Corrupt in-flight log — treat as no active txns (safe).
      this.logger?.debug("authority.inflight_corrupt_ignored", { path });
    }
  }

  private async persistCommitted(): Promise<void> {
    const snap: PersistedSnapshot = {
      version: 1,
      records: Object.fromEntries(
        Array.from(this.committed.entries()).map(([coll, map]) => [
          coll,
          Object.fromEntries(map.entries()),
        ]),
      ),
      revisions: Object.fromEntries(
        Array.from(this.revisions.entries()).map(([coll, map]) => [
          coll,
          Object.fromEntries(map.entries()),
        ]),
      ),
    };
    // Use a UNIQUE temp filename per write so concurrent commits/begins
    // cannot race on a shared temp path (the rename target is the same
    // durable file, but each writer stages in its own temp file).
    const tmp = `${this.committedPath()}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snap), "utf8");
    await fs.rename(tmp, this.committedPath());
  }

  private async persistInflight(): Promise<void> {
    const log: InflightLog = {
      version: 1,
      activeTransactionIds: Array.from(this.activeTxIds),
    };
    const tmp = `${this.inflightPath()}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(log), "utf8");
    await fs.rename(tmp, this.inflightPath());
  }

  public async begin(context: ExecutionContext): Promise<AuthorityTransaction> {
    await this.ensureLoaded();
    const txId = randomUUID();
    this.activeTxIds.add(txId);
    await this.persistInflight();
    this.logger?.debug("authority.tx_begin", { txId, executionId: context.executionId });
    return new ShimTransaction(txId, context, this);
  }

  public async run<T>(context: ExecutionContext, work: (tx: AuthorityTransaction) => Promise<T>): Promise<T> {
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
    await this.ensureLoaded();
    const map = this.committed.get(collection);
    if (!map) return null;
    const rec = map.get(key);
    return rec ? this.toAuthorityRecord<T>(rec) : null;
  }

  public async scan<T = unknown>(collection: string): Promise<readonly AuthorityRecord<T>[]> {
    await this.ensureLoaded();
    const map = this.committed.get(collection);
    if (!map) return [];
    return Array.from(map.values()).map((r) => this.toAuthorityRecord<T>(r));
  }

  public async count(collection: string): Promise<number> {
    await this.ensureLoaded();
    return this.committed.get(collection)?.size ?? 0;
  }

  /** Apply a committed transaction's buffered writes to durable state. */
  public async applyCommit(txId: string, writes: Map<string, BufferedWrite>): Promise<void> {
    for (const [, buf] of writes) {
      let map = this.committed.get(buf.collection);
      if (!map) {
        map = new Map();
        this.committed.set(buf.collection, map);
      }
      let revMap = this.revisions.get(buf.collection);
      if (!revMap) {
        revMap = new Map();
        this.revisions.set(buf.collection, revMap);
      }
      if (buf.kind === "delete") {
        map.delete(buf.key);
      } else if (buf.record) {
        map.set(buf.key, buf.record);
        revMap.set(buf.key, buf.record.revision);
      }
    }
    this.activeTxIds.delete(txId);
    // Persist committed snapshot + updated in-flight log atomically-ish.
    await this.persistCommitted();
    await this.persistInflight();
    this.logger?.debug("authority.tx_commit", { txId, writes: writes.size });
  }

  /** Record a rolled-back transaction (discard its buffered writes). */
  public async applyRollback(txId: string): Promise<void> {
    this.activeTxIds.delete(txId);
    await this.persistInflight();
    this.logger?.debug("authority.tx_rollback", { txId });
  }

  public async recover(): Promise<{ recoveredRecords: number; discardedTransactions: number }> {
    await this.ensureLoaded();
    // Count recovered committed records.
    let recovered = 0;
    for (const map of this.committed.values()) recovered += map.size;
    // Discard interrupted transactions (begun but not committed/rolled back).
    const discarded = this.activeTxIds.size;
    this.activeTxIds.clear();
    await this.persistInflight();
    this.logger?.debug("authority.recovered", { recoveredRecords: recovered, discardedTransactions: discarded });
    return { recoveredRecords: recovered, discardedTransactions: discarded };
  }

  public async close(): Promise<void> {
    // Nothing to release for a file-backed shim. Active in-memory txs
    // are recorded in inflight.json and will be reported as discarded
    // on the next recover().
    return;
  }

  /** Test accessor: count of interrupted (active) tx ids in memory. */
  _activeTransactionCount(): number {
    return this.activeTxIds.size;
  }

  /**
   * Log a transaction lifecycle hook failure (NET-W004-AC-07): a hook
   * error never fails or undoes the (already settled) transaction, so
   * it MUST be surfaced through the logger instead. Surfaced as a
   * public method so {@link ShimTransaction} can delegate here without
   * reaching into private state.
   */
  public logHookError(phase: "afterCommit" | "afterRollback", txId: string, err: unknown): void {
    const fields = {
      txId,
      phase,
      error: err instanceof Error ? err.message : String(err),
    };
    // Prefer the structured error level; fall back to debug so test
    // doubles without an error sink still record something.
    if (this.logger?.error) {
      this.logger.error("authority.tx_hook_failed", fields);
    } else {
      this.logger?.debug("authority.tx_hook_failed", fields);
    }
  }
}
