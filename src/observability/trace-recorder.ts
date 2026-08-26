/**
 * TraceRecorder — span/trace correlation lineage implementation.
 *
 * Work order ref: NET-W003 §4.7 (Observability: trace and correlation
 * lineage), AC-07. NON-AUTHORITATIVE observability infrastructure
 * (architecture-lock §16 — observability is coordination, not truth).
 *
 * Records spans carrying `executionId`, `correlationId`, `causationId`,
 * actor, name and timing. Spans propagate across the synchronous→
 * asynchronous boundary (request → enqueue → worker-execute) via the
 * active `ExecutionContext` (AsyncLocalStorage). A request→enqueue→job
 * flow produces a single trace sharing the `correlationId`, with the
 * job span's `causationId` linking to the request span's `executionId`.
 */

import { randomUUID } from "node:crypto";
import type {
  Span,
  SpanHandle,
  TraceRecorder,
} from "../core/trace.ts";
import {
  getExecutionContext,
  type ExecutionContext,
} from "../core/execution-context.ts";

interface MutableSpan extends Span {
  endedAt: string | null;
  durationMs: number | null;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
  errorMessage: string | null;
}

class SpanImpl implements SpanHandle {
  private letEnded = false;
  public readonly spanId: string;

  public constructor(
    private readonly span: MutableSpan,
    private readonly recorder: TraceRecorderImpl,
  ) {
    this.spanId = span.spanId;
  }

  public end(attributes?: Readonly<Record<string, unknown>>): void {
    if (this.letEnded) return;
    this.letEnded = true;
    const end = Date.now();
    const start = Date.parse(this.span.startedAt);
    this.span.endedAt = new Date(end).toISOString();
    this.span.durationMs = end - start;
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        this.span.attributes[k] = v;
      }
    }
  }

  public fail(message: string, attributes?: Readonly<Record<string, unknown>>): void {
    if (this.letEnded) return;
    this.letEnded = true;
    const end = Date.now();
    const start = Date.parse(this.span.startedAt);
    this.span.endedAt = new Date(end).toISOString();
    this.span.durationMs = end - start;
    this.span.status = "error";
    this.span.errorMessage = message;
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        this.span.attributes[k] = v;
      }
    }
  }

  public setAttribute(key: string, value: unknown): void {
    if (this.letEnded) return;
    this.span.attributes[key] = value;
  }
}

export interface TraceRecorderOptions {
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
  /** Injectable clock for deterministic timing tests. */
  readonly now?: () => number;
}

export class TraceRecorderImpl implements TraceRecorder {
  private readonly _spans: MutableSpan[] = [];
  private readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
  private readonly now: () => number;

  public constructor(opts: TraceRecorderOptions = {}) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  public begin(input: {
    readonly name: string;
    readonly execution?: ExecutionContext;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }): SpanHandle {
    const ctx = input.execution ?? getExecutionContext() ?? null;
    const spanId = randomUUID();
    const executionId = ctx?.executionId ?? spanId;
    const correlationId = ctx?.correlationId ?? executionId;
    const causationId = ctx?.causationId ?? null;
    const actorId = ctx?.actor?.id ?? null;
    const span: MutableSpan = {
      spanId,
      executionId,
      correlationId,
      causationId,
      actorId,
      name: input.name,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
      durationMs: null,
      attributes: { ...(input.attributes ?? {}) },
      status: "ok",
      errorMessage: null,
    };
    this._spans.push(span);
    this.logger?.debug("trace.span_begin", { name: input.name, spanId, correlationId });
    return new SpanImpl(span, this);
  }

  public spans(): readonly Span[] {
    return this._spans.map((s) => Object.freeze({ ...s, attributes: Object.freeze({ ...s.attributes }) }));
  }

  public traceFor(correlationId: string): readonly Span[] {
    return this._spans
      .filter((s) => s.correlationId === correlationId)
      .map((s) => Object.freeze({ ...s, attributes: Object.freeze({ ...s.attributes }) }));
  }

  public count(): number {
    return this._spans.length;
  }
}

/**
 * Convenience factory matching the NET-W001 logger factory style.
 */
export function createTraceRecorder(opts: TraceRecorderOptions = {}): TraceRecorder {
  return new TraceRecorderImpl(opts);
}
