/**
 * TraceRecorder contract — span/trace correlation lineage.
 *
 * Work order ref: NET-W003 §4.7 (Observability: trace and correlation
 * lineage), §6 (TraceRecorder).
 *
 * The trace recorder is NON-AUTHORITATIVE observability infrastructure
 * (architecture-lock §16 — observability is coordination, not truth).
 * A trace is a set of spans sharing a `correlationId`; each span carries
 * its own `executionId`, a `causationId` linking to its parent span
 * (when derived via `deriveExecutionContext`), an actor, a name, and
 * timing. Spans propagate across the synchronous→asynchronous boundary
 * (request → enqueue → worker-execute) so a single flow produces a
 * single traceable lineage.
 *
 * This file defines interfaces ONLY. Concrete implementation lives in
 * src/observability/trace-recorder.ts.
 */

import type { ExecutionContext } from "./execution-context.ts";

export interface Span {
  /** Stable, unique span id. */
  readonly spanId: string;
  /** The executionId of the execution that produced this span. */
  readonly executionId: string;
  /** Shared across a logical flow. */
  readonly correlationId: string;
  /** The executionId that caused this one, if derived. */
  readonly causationId: string | null;
  readonly actorId: string | null;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  /** The span's status: "ok" unless the span was marked failed. */
  readonly status: "ok" | "error";
  readonly errorMessage: string | null;
}

export interface SpanHandle {
  /** The span id (available immediately after begin). */
  readonly spanId: string;
  /** End the span (records `endedAt`, `durationMs`). Idempotent. */
  end(attributes?: Readonly<Record<string, unknown>>): void;
  /** Mark the span as failed and end it. */
  fail(message: string, attributes?: Readonly<Record<string, unknown>>): void;
  /** Add attributes to the in-flight span. */
  setAttribute(key: string, value: unknown): void;
}

export interface TraceRecorder {
  /**
   * Begin a span. When `parent` is omitted the active execution context
   * (from AsyncLocalStorage) is used as the parent, falling back to a
   * new root when none is active. The span's `executionId` comes from
   * `execution` (or the active context). The `causationId` records the
   * parent span's `executionId` when derived.
   */
  begin(input: {
    readonly name: string;
    readonly execution?: ExecutionContext;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }): SpanHandle;
  /** All spans recorded so far (for tests / in-process inspection). */
  spans(): readonly Span[];
  /** Spans sharing a correlationId (one trace). */
  traceFor(correlationId: string): readonly Span[];
  /** Total span count (for integrity tests). */
  count(): number;
}

/**
 * A no-op trace recorder. Used when tracing is disabled (e.g. silent
 * test runs). Records nothing; `spans()` returns `[]`.
 */
export const NOOP_TRACE_RECORDER: TraceRecorder = {
  begin: () => ({
    spanId: "",
    end: () => {},
    fail: () => {},
    setAttribute: () => {},
  }),
  spans: () => [],
  traceFor: () => [],
  count: () => 0,
};
