/**
 * TransactionalAuditWriter — audit publication participates in the
 * material mutation's transaction LIFECYCLE (atomicity: audit becomes
 * visible only after the mutation's transaction commits; discarded when
 * it does not).
 *
 * Work order ref: NET-W003 §4.5 (Transactions, rollback and recovery),
 * §4.8 (Audit: material-mutation tracing), AC-05, AC-08,
 * architecture-lock §12 (workflow transitions deterministic/idempotent),
 * AUD-001 (append-oriented audit trail).
 *
 * NET-W004-AC-07 REMEDIATION (transaction-ordering, architect
 * re-review on PR #8): the previous design flushed the transactional
 * audit buffer from INSIDE the mutation flow (before the authoritative
 * `tx.commit()`), so a failed authoritative commit could leave a
 * published audit record for a mutation that never committed
 * ("audit exists, mutation doesn't"). The corrected design:
 *
 * ```text
 * applyIdempotent()
 *     ↓
 * create tx (IdempotencyStore)
 *     ↓
 * create audit buffer bound to tx  (forTransaction)
 *     → registers tx.afterCommit(publish) + tx.afterRollback(discard)
 *     ↓
 * perform mutation + audit append   (buffered, invisible)
 *     ↓
 * write completed idempotency record
 *     ↓
 * tx.commit()
 *     ├── durable commit ok    → afterCommit → publish audit buffer
 *     └── durable commit fails → afterRollback → discard audit buffer
 * ```
 *
 * The buffer has NO publish method of its own — there is deliberately
 * no way to publish audit from inside the transaction. The ONLY code
 * path to the underlying append-only writer for buffered events is the
 * transaction's `afterCommit` hook, which every `AuthorityTransaction`
 * implementation runs STRICTLY AFTER its durable commit succeeded
 * (commit ordering contract in src/core/postgres-authority.ts).
 *
 * Publication failure recovery (explicit recovery path, required by
 * the architect decision): publication happens after the durable
 * commit, so a publication failure can no longer roll the mutation
 * back — instead the publication is retried, and when retries are
 * exhausted the UNPUBLISHED events are RETAINED in a pending
 * publication queue (`pendingPublications`, keyed by the committed
 * transaction id) for an explicit `retryPendingPublications()`
 * recovery call. Because retained events always belong to a COMMITTED
 * transaction, the recovery path can never create "audit exists,
 * mutation doesn't" — it converges the audit trail toward the already
 * committed state and never publishes anything for a rolled-back
 * transaction.
 *
 * The append-only / deep-immutability invariant from NET-W001-AC-06 is
 * preserved: a published audit event is deeply-frozen by the underlying
 * writer and never mutated by later writes.
 */

import type {
  AuditEvent,
  AuditQuery,
  AuditWriter,
  TransactionalAuditBuffer,
  TransactionalAuditWriter,
} from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import { InvariantError } from "../core/errors.ts";

/**
 * A buffered audit event (pending until its transaction commits or
 * settles without committing). Carries the same shape as a committed
 * AuditEvent plus the optional durable transaction id and
 * object-reference ids for material-mutation tracing.
 */
export interface BufferedAuditEvent {
  readonly eventType: string;
  readonly context: ExecutionContext;
  readonly actor?: string | null;
  readonly subject?: string | null;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** The authoritative transaction id this audit record belongs to. */
  readonly transactionId?: string;
  /** Object-store reference ids for large artifacts produced by the mutation. */
  readonly objectReferenceIds?: readonly string[];
}

/**
 * A retained pending publication — an event whose post-commit
 * publication failed after all retries. Belongs to a COMMITTED
 * transaction (retention happens only on the afterCommit path).
 */
interface PendingPublication {
  readonly transactionId: string;
  readonly event: BufferedAuditEvent;
  readonly retainedAt: string;
  readonly attempts: number;
}

// Re-export the core contracts so existing consumers (tests, bootstrap)
// can keep importing them from this boundary. The contracts themselves
// live in src/core/audit.ts so domain tiers can consume them without
// coupling to the audit infrastructure implementation.
export type { TransactionalAuditBuffer, TransactionalAuditWriter };

export interface TransactionalAuditWriterOptions {
  readonly underlying: AuditWriter;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn?(message: string, fields?: Record<string, unknown>): void;
    error?(message: string, fields?: Record<string, unknown>): void;
  };
  /**
   * Publication attempts per buffered event when the afterCommit
   * publication runs (>= 1). Default 3. Retries are bounded so a
   * persistently failing underlying writer cannot stall the commit
   * path indefinitely — exhaustion retains the event for the explicit
   * recovery path instead.
   */
  readonly publicationAttempts?: number;
  /**
   * Base backoff in milliseconds between publication attempts
   * (linear: attempt n waits `publicationBackoffMs * n`). Default 20.
   */
  readonly publicationBackoffMs?: number;
}

const DEFAULT_PUBLICATION_ATTEMPTS = 3;
const DEFAULT_PUBLICATION_BACKOFF_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTransactionalAuditWriter(
  opts: TransactionalAuditWriterOptions,
): TransactionalAuditWriter {
  const underlying = opts.underlying;
  const logger = opts.logger;
  const publicationAttempts = Math.max(1, opts.publicationAttempts ?? DEFAULT_PUBLICATION_ATTEMPTS);
  const publicationBackoffMs = Math.max(0, opts.publicationBackoffMs ?? DEFAULT_PUBLICATION_BACKOFF_MS);

  /**
   * Retained pending publications, in retention order. Events here
   * ALWAYS belong to a committed transaction: they are only retained
   * from the afterCommit publication path after retries were
   * exhausted. `retryPendingPublications()` drains this queue.
   */
  const pendingPublications: PendingPublication[] = [];

  function toAppendInput(ev: BufferedAuditEvent) {
    return {
      eventType: ev.eventType,
      context: ev.context,
      actor: ev.actor,
      subject: ev.subject,
      resourceType: ev.resourceType,
      resourceId: ev.resourceId,
      metadata: {
        ...(ev.metadata ?? {}),
        transactionId: ev.transactionId,
        ...(ev.objectReferenceIds && ev.objectReferenceIds.length > 0
          ? { objectReferenceIds: ev.objectReferenceIds }
          : {}),
      },
    };
  }

  /**
   * Append one event to the underlying writer, retrying up to
   * `publicationAttempts` times with linear backoff. Returns true on
   * success, false when attempts were exhausted (the caller retains
   * the event for the explicit recovery path — never discards it).
   */
  async function appendWithRetry(ev: BufferedAuditEvent): Promise<boolean> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= publicationAttempts; attempt += 1) {
      try {
        await underlying.append(toAppendInput(ev));
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < publicationAttempts && publicationBackoffMs > 0) {
          await delay(publicationBackoffMs * attempt);
        }
      }
    }
    logger?.warn?.("audit.publication_attempt_failed", {
      transactionId: ev.transactionId,
      eventType: ev.eventType,
      attempts: publicationAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return false;
  }

  // The default (non-transactional) append path delegates directly to
  // the underlying writer — preserving the NET-W001/NET-W002 behavior
  // for audit calls outside any transaction.
  const baseWriter: AuditWriter = {
    async append(input) {
      return underlying.append(input);
    },
    async query(query: AuditQuery): Promise<readonly AuditEvent[]> {
      return underlying.query(query);
    },
    async count(): Promise<number> {
      return underlying.count();
    },
  };

  const self: TransactionalAuditWriter = Object.assign(baseWriter, {
    forTransaction(tx: AuthorityTransaction): TransactionalAuditBuffer {
      if (tx.settled) {
        throw new InvariantError(
          "cannot bind a transactional audit buffer to a settled transaction",
        );
      }

      const buffer: BufferedAuditEvent[] = [];
      // The buffer settles together with the transaction. `settled`
      // guards BOTH append (no appends after the tx settled) and the
      // hooks (publish/discard run at most once).
      let settled = false;

      /**
       * Publish the buffered events to the underlying append-only
       * writer. Registered as the transaction's afterCommit hook — it
       * runs ONLY after the durable commit succeeded, so published
       * audit can never describe a mutation that did not commit.
       *
       * This hook OWNS its failure recovery and never throws (a throw
       * could not undo the already-durable commit): each event is
       * retried; an event whose retries are exhausted — together with
       * every event after it — is RETAINED for the explicit
       * `retryPendingPublications()` recovery path. Publication stops
       * at the first exhaustion so events are retained (and later
       * republished) in their original buffered order.
       */
      const publish = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        const events = buffer.splice(0, buffer.length);
        for (let i = 0; i < events.length; i += 1) {
          const ev = events[i]!;
          const published = await appendWithRetry(ev);
          if (!published) {
            // RETAIN this event and every remaining event (in order)
            // for the explicit recovery path. These events belong to a
            // COMMITTED transaction — the afterCommit hook only runs
            // after the durable commit — so republishing them later
            // can never create "audit exists, mutation doesn't".
            for (let j = i; j < events.length; j += 1) {
              pendingPublications.push({
                transactionId: tx.transactionId,
                event: events[j]!,
                retainedAt: new Date().toISOString(),
                attempts: publicationAttempts,
              });
            }
            logger?.error?.("audit.publication_failed_events_retained", {
              transactionId: tx.transactionId,
              retained: events.length - i,
              pendingTotal: pendingPublications.length,
              recovery: "retryPendingPublications()",
            });
            return;
          }
        }
        logger?.debug("audit.tx_commit_published", {
          transactionId: tx.transactionId,
          published: events.length,
        });
      };

      /**
       * Discard the buffered events. Registered as the transaction's
       * afterRollback hook — it runs when the transaction settles
       * WITHOUT a successful durable commit (explicit rollback OR a
       * failed commit), so no audit record survives for a mutation
       * that never committed.
       */
      const discard = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        const discarded = buffer.length;
        buffer.length = 0;
        logger?.debug("audit.tx_rollback_discarded", {
          transactionId: tx.transactionId,
          discarded,
        });
      };

      // Bind the buffer to the transaction's lifecycle. This is the
      // ONLY registration: publication/discard is driven exclusively
      // by the transaction settling, never by the caller.
      tx.afterCommit(publish);
      tx.afterRollback(discard);

      const txWriter: TransactionalAuditBuffer = {
        async append(input) {
          if (settled) {
            throw new Error(
              "transactional audit buffer is settled; cannot append after the transaction settled",
            );
          }
          const event: BufferedAuditEvent = {
            eventType: input.eventType,
            context: input.context,
            actor: input.actor,
            subject: input.subject,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            metadata: {
              ...(input.metadata ?? {}),
              transactionId: tx.transactionId,
            },
            transactionId: tx.transactionId,
          };
          buffer.push(event);
          // Return a placeholder event shape so the caller can read
          // lineage fields. The event is not durable until the bound
          // transaction commits (then it is published via afterCommit).
          return {
            eventId: `pending:${event.eventType}`,
            eventType: event.eventType,
            actor: event.actor ?? event.context.actor?.id ?? null,
            subject: event.subject ?? event.context.subject?.id ?? null,
            correlationId: event.context.correlationId,
            executionId: event.context.executionId,
            timestamp: new Date().toISOString(),
            resourceType: event.resourceType ?? null,
            resourceId: event.resourceId ?? null,
            metadata: event.metadata ?? {},
          } as AuditEvent;
        },
        async query(query: AuditQuery): Promise<readonly AuditEvent[]> {
          // A transactional buffer does not expose buffered events via
          // query (they are not durable until the bound tx commits and
          // the afterCommit hook publishes them). Delegate to the
          // underlying committed audit log.
          return underlying.query(query);
        },
        async count(): Promise<number> {
          return underlying.count();
        },
        pendingCount(): number {
          return buffer.length;
        },
      };
      return txWriter;
    },

    /**
     * Explicit recovery path for audit publication failures
     * (NET-W004-AC-07 remediation): retry the retained pending
     * publications in retention order. Each event gets a fresh
     * `publicationAttempts` budget; a still-failing event stays
     * retained (never discarded) so a later call can retry again.
     * Safe to call repeatedly; converges the audit trail toward the
     * committed state.
     */
    async retryPendingPublications(): Promise<{ published: number; remaining: number }> {
      let published = 0;
      // Retry in order; stop at the first still-failing event to keep
      // ordering (events retained behind it stay retained).
      while (pendingPublications.length > 0) {
        const next = pendingPublications[0]!;
        const ok = await appendWithRetry(next.event);
        if (!ok) break;
        pendingPublications.shift();
        published += 1;
      }
      if (pendingPublications.length > 0) {
        logger?.error?.("audit.publication_retry_incomplete", {
          remaining: pendingPublications.length,
          recovery: "retryPendingPublications()",
        });
      } else {
        logger?.debug("audit.publication_retry_drained", { published });
      }
      return { published, remaining: pendingPublications.length };
    },

    pendingPublicationCount(): number {
      return pendingPublications.length;
    },
  });

  return self;
}
