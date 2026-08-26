/**
 * AuditWriter contract — append-oriented auditability foundation.
 *
 * Work order ref: NET-W001 §4.7 (Audit foundation), §6 (AuditWriter),
 * requirement AUD-001 (append-oriented audit trail).
 * NET-W003 §4.5/§4.8 + NET-W004 §4.7: the TransactionalAuditWriter
 * contract is promoted here so domain tiers (workflows) can consume it
 * as a provider-neutral core contract — the concrete implementation
 * (createTransactionalAuditWriter) remains in the audit infrastructure
 * boundary (src/audit/transactional-audit-writer.ts).
 *
 * The audit boundary records administrative/system actions in an
 * append-only log. Records are immutable once written: retrieval MUST
 * never expose a mutated prior entry.
 *
 * NET-W001 does NOT authorize business-specific audit events (§4.7).
 * Only the structural contract and a non-domain system-event example
 * are implemented here.
 */

import type { ExecutionContext } from "./execution-context.ts";
// core→core import: the TransactionalAuditWriter's forTransaction(tx)
// takes an AuthorityTransaction (declared in src/core/postgres-authority.ts).
// This keeps the transactional audit contract provider-neutral — domains
// consume the contract without coupling to the audit infrastructure
// implementation (architecture-lock §14 provider isolation).
import type { AuthorityTransaction } from "./postgres-authority.ts";

export type AuditEventType =
  | "system.startup"
  | "system.shutdown"
  | "system.config_loaded"
  | "module.registered"
  | "module.initialized"
  | "worker.job_completed"
  | "worker.job_dead_lettered";

export interface AuditEvent {
  /** Stable, unique event id. */
  readonly eventId: string;
  readonly eventType: AuditEventType | string;
  readonly actor: string | null;
  readonly subject: string | null;
  readonly correlationId: string;
  readonly executionId: string;
  readonly timestamp: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditQuery {
  readonly correlationId?: string;
  readonly executionId?: string;
  readonly eventType?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface AuditWriter {
  /** Append a single event. Implementation MUST be append-only. */
  append(input: {
    readonly eventType: AuditEventType | string;
    readonly context: ExecutionContext;
    readonly actor?: string | null;
    readonly subject?: string | null;
    readonly resourceType?: string | null;
    readonly resourceId?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<AuditEvent>;
  /** Retrieve events matching a query. Never returns mutated entries. */
  query(query: AuditQuery): Promise<readonly AuditEvent[]>;
  /** Total event count (for integrity tests). */
  count(): Promise<number>;
}

export class AuditMutationError extends Error {
  public constructor(message = "audit entries are append-only and immutable") {
    super(message);
    this.name = "AuditMutationError";
  }
}

/**
 * A transactional audit buffer — an AuditWriter whose appends are
 * buffered until the bound authoritative transaction commits (then
 * flushed to the underlying append-only writer) or rolls back (then
 * discarded). This is the contract the workflow authority uses so an
 * audit record for a material lifecycle mutation is committed
 * atomically with the mutation + the idempotency record (NET-W004 §4.7
 * + NET-W003 §4.8 atomicity: audit + mutation commit together, or both
 * roll back).
 *
 * `commit` flushes the buffered events to the underlying writer; a
 * failure here MUST surface to the caller so the bound transaction
 * rolls back (no committed mutation without committed audit lineage).
 * `rollback` discards the buffered events (the mutation rolled back).
 */
export interface TransactionalAuditBuffer extends AuditWriter {
  /** Flush the buffered events to the underlying writer. Throws on failure. */
  commit(): Promise<void>;
  /** Discard the buffered events (the bound transaction rolled back). */
  rollback(): Promise<void>;
  /** Buffered event count (for tests). */
  pendingCount(): number;
}

/**
 * TransactionalAuditWriter — an AuditWriter that exposes a
 * transaction-scoped buffer. The concrete implementation
 * (createTransactionalAuditWriter) lives in the audit infrastructure
 * boundary; this contract is declared in core so the workflows domain
 * can consume it as a provider-neutral dependency (domain→core is
 * allowed by the tier allow matrix).
 *
 * Outside any transaction, the writer delegates `append`/`query`/
 * `count` to the underlying append-only writer (preserving the
 * NET-W001/NET-W002 immediate-append behaviour for non-transactional
 * audit calls — e.g. opportunity.created).
 *
 * Inside an authoritative transaction, the caller obtains a buffer via
 * `forTransaction(tx)` and appends audit records through it. The
 * records are committed atomically with the transaction (flush on
 * commit, discard on rollback). The buffer's `transactionId` lineage
 * is `tx.transactionId` — the authoritative transaction id, NOT the
 * execution id (correct audit lineage: NET-W004-AC-07).
 */
export interface TransactionalAuditWriter extends AuditWriter {
  /**
   * Begin a transactional audit buffer bound to an authoritative
   * transaction. Audit events appended via the returned writer are
   * buffered until `commit` (flushed to the underlying writer) or
   * `rollback` (discarded).
   *
   * The buffer records `tx.transactionId` in each flushed event's
   * metadata so the audit record can be traced back to its durable
   * transaction.
   */
  forTransaction(tx: AuthorityTransaction): TransactionalAuditBuffer;
}
