/**
 * AuditWriter contract — append-oriented auditability foundation.
 *
 * Work order ref: NET-W001 §4.7 (Audit foundation), §6 (AuditWriter),
 * requirement AUD-001 (append-oriented audit trail).
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
