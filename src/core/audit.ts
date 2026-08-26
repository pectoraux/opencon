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
 * buffered and published ONLY after the bound authoritative transaction
 * durably commits. This is the contract the workflow authority uses so
 * an audit record for a material lifecycle mutation is never visible
 * for a mutation that never committed (NET-W004 §4.7 + NET-W003 §4.8
 * atomicity: audit + mutation commit together, or none does).
 *
 * NET-W004-AC-07 remediation (transaction-ordering, architect re-review
 * on PR #8): the buffer has NO publish/flush method of its own. Binding
 * a buffer to a transaction (`TransactionalAuditWriter.forTransaction`)
 * registers the buffer's publication on the transaction's
 * `afterCommit` hook and its discard on the `afterRollback` hook, so:
 *
 * ```text
 * tx.commit() succeeds  → afterCommit → buffer published (audit visible)
 * tx.commit() fails     → afterRollback → buffer discarded (invisible)
 * tx.rollback()         → afterRollback → buffer discarded (invisible)
 * ```
 *
 * There is deliberately NO way to publish the buffer from inside the
 * transaction (before `commit()`): doing so could leave a visible audit
 * record for a mutation that was rolled back when the authoritative
 * commit subsequently failed.
 */
export interface TransactionalAuditBuffer extends AuditWriter {
  /**
   * Buffered event count (for tests). Buffered events are NOT visible
   * through `query`/`count` — they delegate to the underlying committed
   * audit log — until the bound transaction commits.
   */
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
 * records are published STRICTLY AFTER the transaction's durable
 * commit (via the transaction's `afterCommit` lifecycle hook) and
 * discarded when the transaction settles without committing (via
 * `afterRollback`). The buffer's `transactionId` lineage is
 * `tx.transactionId` — the authoritative transaction id, NOT the
 * execution id (correct audit lineage: NET-W004-AC-07).
 *
 * Publication failure recovery (explicit recovery path, NET-W004-AC-07
 * remediation): if the underlying append-only writer fails while the
 * buffer is being published after a successful commit, the publication
 * is retried; when retries are exhausted the UNPUBLISHED events are
 * RETAINED (never discarded, never partially lost) in a pending
 * publication queue for an explicit `retryPendingPublications()`
 * recovery call. The durable commit is never undone — the recovery
 * path can therefore never create "audit exists, mutation doesn't"
 * (retained events always belong to a COMMITTED transaction); it
 * converges the audit trail toward the committed state.
 */
export interface TransactionalAuditWriter extends AuditWriter {
  /**
   * Begin a transactional audit buffer bound to an authoritative
   * transaction. Audit events appended via the returned writer are
   * buffered — invisible through `query`/`count` — until the bound
   * transaction durably commits (the buffer registers its publication
   * on the transaction's `afterCommit` hook and its discard on the
   * transaction's `afterRollback` hook).
   *
   * The buffer records `tx.transactionId` in each published event's
   * metadata so the audit record can be traced back to its durable
   * transaction. Binding to an already-settled transaction is an
   * invariant violation.
   */
  forTransaction(tx: AuthorityTransaction): TransactionalAuditBuffer;
  /**
   * Retry the retained pending audit publications (events whose
   * post-commit publication failed and was retained). Returns the
   * number of events published by this call and the number still
   * remaining (unrecovered). This is the explicit recovery path for
   * audit publication failures — safe to call repeatedly.
   */
  retryPendingPublications(): Promise<{ readonly published: number; readonly remaining: number }>;
  /**
   * Number of audit events retained awaiting publication recovery
   * (for monitoring/tests). Zero means every committed transaction's
   * audit has been published.
   */
  pendingPublicationCount(): number;
}
