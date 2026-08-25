/**
 * ExecutionContext — the correlation spine of the OpenCon runtime.
 *
 * Every HTTP request and every worker job carries one. It is propagated
 * across boundaries so structured logs, audit records and downstream
 * commands share stable execution/correlation identifiers.
 *
 * Work order ref: NET-W001 §4.4 (Execution and correlation context).
 * Architecture ref: architecture-lock.md §2 (infrastructure boundaries),
 * §7 (workflow authority — context required for authorized transitions).
 */

import { randomUUID } from "node:crypto";

/**
 * The immutable identity of a single execution (one request or one job).
 * `executionId`  — unique per execution.
 * `correlationId` — shared across a logical flow (may equal executionId
 *                   when no parent correlation was provided).
 * `causationId`   — the executionId that caused this one, if any.
 */
export interface ExecutionContext {
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly actor: ActorRef | null;
  readonly subject: ActorRef | null;
  readonly timestamp: string;
  /** Free-form key/value bag for cross-cutting propagation (e.g. tenant). */
  readonly metadata: Readonly<Record<string, string | undefined>>;
}

export interface ActorRef {
  readonly id: string;
  readonly kind: "person" | "service" | "system" | "external-agent";
}

export interface ExecutionContextInit {
  readonly correlationId?: string;
  readonly causationId?: string | null;
  readonly actor?: ActorRef | null;
  readonly subject?: ActorRef | null;
  readonly executionId?: string;
  readonly metadata?: Readonly<Record<string, string | undefined>>;
  readonly timestamp?: string;
}

/**
 * Create a new execution context. When `correlationId` is omitted it
 * defaults to a fresh id (a new flow root). When `causationId` is omitted
 * it is `null` (no parent execution).
 */
export function createExecutionContext(
  init: ExecutionContextInit = {},
): ExecutionContext {
  const executionId = init.executionId ?? randomUUID();
  const correlationId = init.correlationId ?? executionId;
  return {
    executionId,
    correlationId,
    causationId: init.causationId ?? null,
    actor: init.actor ?? null,
    subject: init.subject ?? null,
    timestamp: init.timestamp ?? new Date().toISOString(),
    metadata: init.metadata ?? {},
  };
}

/**
 * Derive a child execution context (e.g. when a request enqueues a job).
 * The child gets its own executionId but inherits the correlationId and
 * records the parent executionId as its causationId — preserving the
 * causal chain across the synchronous→asynchronous boundary.
 */
export function deriveExecutionContext(
  parent: ExecutionContext,
  overrides: ExecutionContextInit = {},
): ExecutionContext {
  return createExecutionContext({
    correlationId: overrides.correlationId ?? parent.correlationId,
    causationId: overrides.causationId ?? parent.executionId,
    actor: overrides.actor ?? parent.actor,
    subject: overrides.subject ?? parent.subject,
    metadata: { ...parent.metadata, ...overrides.metadata },
    executionId: overrides.executionId,
    timestamp: overrides.timestamp,
  });
}

/**
 * Async-local context propagation. The HTTP middleware and the worker
 * loop both run an execution within an {@link runWithExecutionContext}
 * scope so downstream code (loggers, audit writers, job enqueuers) can
 * recover the active context without threading it through every call.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const executionContextStorage = new AsyncLocalStorage<ExecutionContext>();

export function runWithExecutionContext<T>(
  ctx: ExecutionContext,
  fn: () => T,
): T {
  return executionContextStorage.run(ctx, fn);
}

export async function runWithExecutionContextAsync<T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return executionContextStorage.run(ctx, fn);
}

/**
 * Returns the currently active execution context, or `null` when called
 * outside any request/job scope. Callers that need guaranteed context
 * should accept it explicitly as a parameter; this accessor is a
 * convenience for infrastructure glue only.
 */
export function getExecutionContext(): ExecutionContext | null {
  return executionContextStorage.getStore() ?? null;
}

/**
 * Require an active context or throw. Used by infrastructure that MUST
 * be inside a request/job scope (e.g. the audit writer).
 */
export function requireExecutionContext(): ExecutionContext {
  const ctx = getExecutionContext();
  if (!ctx) {
    throw new Error(
      "ExecutionContext is required but none is active in this scope. " +
        "Ensure the code runs inside runWithExecutionContext().",
    );
  }
  return ctx;
}
