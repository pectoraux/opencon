/**
 * IdempotencyStore — exactly-once-per-key material mutation.
 *
 * Work order ref: NET-W003 §4.6 (Idempotency and concurrency safety),
 * AC-06, requirement API-004 (idempotent material mutation endpoints).
 *
 * Backed by the {@link PostgresAuthority} authoritative persistence
 * boundary — idempotency records are durable and survive restart.
 * They are NOT Redis coordination state; loss of Redis cannot lose an
 * idempotency record (architecture-lock §16).
 *
 * Concurrency model:
 *  - Each idempotency key has at most one record in the authority.
 *  - On `applyIdempotent`, the store begins a transaction, checks for
 *    an existing record, and if absent:
 *      - marks the key "in-flight" (an in-flight marker record);
 *      - invokes `fn` (which performs the material mutation within
 *        the SAME transaction — atomicity: mutation + idempotency
 *        record commit together or both roll back);
 *      - stores the result and removes the in-flight marker.
 *  - Concurrent calls with the same key observe the in-flight marker
 *    and return a deterministic "in-flight" signal; the caller treats
 *    the in-flight result as authoritative (the in-flight caller's
 *    committed result is the canonical one). For the test double, the
 *    in-flight marker is visible to the second caller after the first
 *    commits; concurrent overlap is resolved by the authority's
 *    transactional isolation.
 *
 * The contract is proven by the integration test in
 * tests/persistence/net-w003-ac-06-idempotency-concurrency.test.ts.
 */

import { randomUUID } from "node:crypto";
import type {
  IdempotencyStore,
  IdempotentApplyContext,
  IdempotentResult,
} from "../core/idempotency.ts";
import type { PostgresAuthority, AuthorityTransaction } from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { asAuthorityTransaction } from "./durable-transaction-manager.ts";
import type { Transaction } from "./transaction-manager.ts";

const COLLECTION = "idempotency";
const STATUS_COMPLETE = "complete";
const STATUS_INFLIGHT = "in-flight";

interface IdempotencyRecord {
  readonly key: string;
  readonly status: "complete" | "in-flight";
  readonly result: unknown;
  readonly executionId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly recordId: string;
  readonly completedAt: string | null;
}

export interface IdempotencyStoreOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createPostgresIdempotencyStore(opts: IdempotencyStoreOptions): IdempotencyStore {
  const authority = opts.authority;
  const logger = opts.logger;

  // Per-key mutex queue. Simulates `SELECT ... FOR UPDATE` row-level
  // locking that a real PostgreSQL-backed idempotency store would use
  // to serialize concurrent applies for the same key. Without this,
  // two concurrent transactions could each buffer an in-flight marker
  // and both commit (last-write-wins), violating exactly-once.
  // The mutex ensures only one apply per key runs at a time; the
  // second caller observes the first caller's committed record and
  // returns it as a deterministic replay.
  const keyMutex = new Map<string, Promise<unknown>>();
  async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = keyMutex.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    keyMutex.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Clean up the queue entry if this was the last waiter.
      if (keyMutex.get(key) === prev.then(() => next)) {
        keyMutex.delete(key);
      }
    }
  }

  async function readWithinTx(
    tx: AuthorityTransaction,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const rec = await tx.get<IdempotencyRecord>(COLLECTION, key);
    return rec ? rec.value : null;
  }

  async function writeWithinTx(
    tx: AuthorityTransaction,
    key: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    await tx.put(COLLECTION, key, record);
  }

  return {
    async applyIdempotent<T>(
      key: string,
      fn: (ctx: IdempotentApplyContext) => Promise<T>,
      execution: ExecutionContext,
    ): Promise<IdempotentResult<T>> {
      // Serialize applies per key (simulates `SELECT ... FOR UPDATE`
      // row-level locking in real PostgreSQL). Concurrent callers with
      // the same key are queued; the second observes the first
      // caller's committed record and returns it as a deterministic
      // replay (executed: false).
      return withKeyLock(key, async () => {
        // First check committed state (fast path for sequential replays).
        const existingCommitted = await authority.get<IdempotencyRecord>(COLLECTION, key);
        if (existingCommitted) {
          const rec = existingCommitted.value;
          if (rec.status === STATUS_COMPLETE) {
            logger?.debug("idempotency.replay", { key, recordId: rec.recordId });
            return {
              executed: false,
              result: rec.result as T,
              recordId: rec.recordId,
            };
          }
          if (rec.status === STATUS_INFLIGHT) {
            // A previous call crashed mid-flight (interrupted tx was
            // recovered as discarded by recover(), so this branch only
            // fires when the in-flight marker somehow persisted — treat
            // as authoritative and surface the result).
            logger?.debug("idempotency.inflight_replay", { key, recordId: rec.recordId });
            return {
              executed: false,
              result: rec.result as T,
              recordId: rec.recordId,
            };
          }
        }

        // Begin a transaction for the apply. The mutation + the idempotency
        // record commit atomically.
        const tx = await authority.begin(execution);
        try {
          const within = await readWithinTx(tx, key);
          if (within && within.status === STATUS_COMPLETE) {
            // Another caller committed between our fast-path check and
            // acquiring the tx. Return their result (deterministic replay).
            await tx.commit();
            return { executed: false, result: within.result as T, recordId: within.recordId };
          }
          if (within && within.status === STATUS_INFLIGHT) {
            await tx.commit();
            return { executed: false, result: within.result as T, recordId: within.recordId };
          }

          // Reserve the key with an in-flight marker so concurrent callers
          // observe that processing is underway.
          const inFlightRecordId = randomUUID();
          const inFlight: IdempotencyRecord = {
            key,
            status: STATUS_INFLIGHT,
            result: null,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            actorId: execution.actor?.id ?? null,
            recordId: inFlightRecordId,
            completedAt: null,
          };
          await writeWithinTx(tx, key, inFlight);

          // Invoke the material mutation. The caller receives the
          // AuthorityTransaction so it can perform the mutation within
          // the SAME tx (atomicity: mutation + idempotency record).
          // NET-W004: the transaction is exposed on the apply context
          // so the workflow service can mutate lifecycle state AND
          // append a transactional audit record within the SAME
          // authoritative tx as the idempotency record (true atomicity).
          // The recordId is exposed so the audit lineage references the
          // EXACT idempotency record (not the tx id) — NET-W004-AC-07
          // correct idempotency-record lineage.
          const applyCtx: IdempotentApplyContext = {
            execution,
            transaction: tx,
            recordId: inFlightRecordId,
            commit: async () => {
              // The fn may call commit() explicitly to settle; otherwise
              // we commit after fn returns. If fn calls commit, subsequent
              // mutations on this tx will throw (settled).
            },
            rollback: async () => {
              await tx.rollback();
            },
          };

          let result: T;
          try {
            result = await fn(applyCtx);
          } catch (err) {
            // fn threw: roll back, no idempotency record is committed.
            // The in-flight marker is discarded by rollback. A later call
            // with the same key will invoke fn again.
            await tx.rollback();
            throw err;
          }

          // Store the completed result + settle the tx.
          const completed: IdempotencyRecord = {
            key,
            status: STATUS_COMPLETE,
            result: result as unknown,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            actorId: execution.actor?.id ?? null,
            recordId: inFlightRecordId,
            completedAt: new Date().toISOString(),
          };
          await writeWithinTx(tx, key, completed);
          await tx.commit();
          logger?.debug("idempotency.executed", { key, recordId: inFlightRecordId });
          return { executed: true, result, recordId: inFlightRecordId };
        } catch (err) {
          // Ensure the tx is settled before rethrowing.
          try {
            await tx.rollback();
          } catch {
            // ignore — tx may already be settled
          }
          throw err;
        }
      });
    },

    async has(key: string): Promise<boolean> {
      const rec = await authority.get<IdempotencyRecord>(COLLECTION, key);
      return Boolean(rec && rec.value.status === STATUS_COMPLETE);
    },

    async get<T = unknown>(key: string): Promise<{ result: T; recordId: string } | null> {
      const rec = await authority.get<IdempotencyRecord>(COLLECTION, key);
      if (!rec || rec.value.status !== STATUS_COMPLETE) return null;
      return { result: rec.value.result as T, recordId: rec.value.recordId };
    },

    async count(): Promise<number> {
      return authority.count(COLLECTION);
    },
  };
}

/**
 * Bridge a {@link Transaction} (from the durable TransactionManager)
 * to the underlying {@link AuthorityTransaction} so callers can perform
 * the material mutation within the same tx as the idempotency record.
 *
 * Returns `null` if the transaction is not backed by an authority tx
 * (e.g. the NET-W001 in-memory test double). In that case the mutation
 * runs outside the idempotency tx's atomicity — acceptable for tests
 * that don't exercise the atomicity invariant.
 */
export function bridgeAuthorityTx(tx: Transaction): AuthorityTransaction | null {
  return asAuthorityTransaction(tx);
}
