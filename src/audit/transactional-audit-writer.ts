/**
 * TransactionalAuditWriter — audit writes participate in the material
 * mutation's transaction (atomicity: audit + mutation commit together
 * or both roll back).
 *
 * Work order ref: NET-W003 §4.5 (Transactions, rollback and recovery),
 * §4.8 (Audit: material-mutation tracing), AC-05, AC-08,
 * architecture-lock §12 (workflow transitions deterministic/idempotent),
 * AUD-001 (append-oriented audit trail).
 *
 * The existing `createInMemoryAuditWriter` / `createFileAuditWriter`
 * from NET-W001 write audit events immediately (append-only). NET-W003
 * adds a transactional wrapper so that an audit record for a material
 * mutation is committed ONLY when the mutation's transaction commits.
 * If the mutation rolls back, the audit record is discarded — the
 * append-only log is not polluted with descriptions of mutations that
 * never happened.
 *
 * Material-mutation tracing: when the audit record describes a
 * durable-state mutation, the record's `metadata` carries the
 * authoritative transaction id (so the mutation can be traced back to
 * its durable transaction) and any object-store reference ids (so a
 * large artifact produced by the mutation can be traced to its durable
 * reference).
 *
 * The append-only / deep-immutability invariant from NET-W001-AC-06 is
 * preserved: a flushed audit event is still deeply-frozen and never
 * mutated by later writes.
 */

import type {
  AuditEvent,
  AuditQuery,
  AuditWriter,
} from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";

/**
 * A buffered audit event (pending until its transaction commits or
 * rolls back). Carries the same shape as a committed AuditEvent plus
 * the optional durable transaction id and object-reference ids for
 * material-mutation tracing.
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

export interface TransactionalAuditWriter extends AuditWriter {
  /**
   * Begin a transactional audit buffer bound to an authoritative
   * transaction. Audit events appended via the returned writer are
   * buffered until `commit` (then flushed to the underlying writer) or
   * `rollback` (then discarded).
   *
   * The `transactionId` is recorded in each flushed event's metadata
   * so the audit record can be traced back to its durable transaction.
   */
  forTransaction(tx: AuthorityTransaction): AuditWriter & {
    /** Flush the buffered events to the underlying writer. */
    commit(): Promise<void>;
    /** Discard the buffered events (mutation rolled back). */
    rollback(): Promise<void>;
    /** Buffered event count (for tests). */
    pendingCount(): number;
  };
}

export interface TransactionalAuditWriterOptions {
  readonly underlying: AuditWriter;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createTransactionalAuditWriter(
  opts: TransactionalAuditWriterOptions,
): TransactionalAuditWriter {
  const underlying = opts.underlying;

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
    forTransaction(tx: AuthorityTransaction) {
      const buffer: BufferedAuditEvent[] = [];
      let settled = false;

      const txWriter: AuditWriter & {
        commit(): Promise<void>;
        rollback(): Promise<void>;
        pendingCount(): number;
      } = {
        async append(input) {
          if (settled) {
            throw new Error(
              "transactional audit buffer is settled; cannot append after commit/rollback",
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
          // lineage fields. The event is not yet durable until commit.
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
          // query (they are not durable yet). Delegate to underlying.
          return underlying.query(query);
        },
        async count(): Promise<number> {
          return underlying.count();
        },
        async commit(): Promise<void> {
          if (settled) return;
          settled = true;
          // Flush buffered events to the underlying append-only writer.
          for (const ev of buffer) {
            await underlying.append({
              eventType: ev.eventType,
              context: ev.context,
              actor: ev.actor,
              subject: ev.subject,
              resourceType: ev.resourceType,
              resourceId: ev.resourceId,
              metadata: {
                ...(ev.metadata ?? {}),
                transactionId: tx.transactionId,
                ...(ev.objectReferenceIds && ev.objectReferenceIds.length > 0
                  ? { objectReferenceIds: ev.objectReferenceIds }
                  : {}),
              },
            });
          }
          opts.logger?.debug("audit.tx_commit", {
            transactionId: tx.transactionId,
            flushed: buffer.length,
          });
          buffer.length = 0;
        },
        async rollback(): Promise<void> {
          if (settled) return;
          settled = true;
          const discarded = buffer.length;
          buffer.length = 0;
          opts.logger?.debug("audit.tx_rollback", {
            transactionId: tx.transactionId,
            discarded,
          });
        },
        pendingCount(): number {
          return buffer.length;
        },
      };
      return txWriter;
    },
  });

  return self;
}
