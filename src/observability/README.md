# `observability` boundary

**Tier:** infrastructure  
**Authority:** structured logging, health/readiness/liveness, correlation,
trace/span lineage. **NON-AUTHORITATIVE** (coordination, not truth).  
**Architecture ref:** `spec/architecture.md` §18, §19;
`spec/architecture-lock.md` §16 (observability is never authoritative)  
**Concrete behaviour:** NET-W001 (logger + execution context + health) +
NET-W003 (trace recorder)

## Scope in NET-W003

NET-W003 extends the NET-W001 structured-logging/execution-context
boundary with trace/correlation lineage:

- **`TraceRecorder` contract** (`src/core/trace.ts`) — provider-neutral
  span/trace port. A trace is a set of spans sharing a `correlationId`;
  each span carries its own `executionId`, a `causationId` linking to
  its parent span, an actor, a name and timing.
- **`TraceRecorderImpl`** (`src/observability/trace-recorder.ts`) —
  records spans. Spans propagate across the synchronous→asynchronous
  boundary (request → enqueue → worker-execute) via the active
  `ExecutionContext` (AsyncLocalStorage). A request→enqueue→job flow
  produces a single trace sharing the `correlationId`, with the job
  span's `causationId` linking to the request span's `executionId`.

The NET-W001 structured logger, execution-context, and health aggregator
are unchanged.

## Non-authority invariant

Observability is coordination, not truth (architecture-lock §16).
Spans are non-durable and recoverable; losing the trace recorder does
not lose domain state. The trace recorder is a diagnostic/lineage tool.
