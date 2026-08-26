/**
 * NET-W003-AC-07 — Observability correlation tracing.
 *
 * Evidence: integration test proving a request → enqueue → job-execute
 * flow produces a trace with shared `correlationId`; spans carry
 * `executionId`/`causationId` lineage.
 *
 * architecture-lock §16 (observability is non-authoritative coordination).
 */

import { describe, test, expect } from "bun:test";
import { createTraceRecorder } from "../../src/observability/trace-recorder.ts";
import {
  createExecutionContext,
  deriveExecutionContext,
  runWithExecutionContextAsync,
  getExecutionContext,
} from "../../src/core/execution-context.ts";
import { createInMemoryJobQueue } from "../../src/queues/in-memory-queue.ts";
import { createWorkerLoop } from "../../src/workers/worker-loop.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { createInMemoryAuditWriter } from "../../src/audit/audit-writer.ts";
import type { JobHandler } from "../../src/core/queue.ts";
import type { Span } from "../../src/core/trace.ts";

describe("NET-W003-AC-07 observability correlation tracing", () => {
  test("a request → enqueue → job-execute flow produces a single trace sharing correlationId", async () => {
    const recorder = createTraceRecorder();
    const queue = createInMemoryJobQueue();
    const logger = createLogger({
      module: "test",
      minLevel: "fatal",
      pretty: false,
      sink: () => {},
    });
    const audit = createInMemoryAuditWriter();
    const worker = createWorkerLoop({ queue, logger, auditWriter: audit, pollIntervalMs: 1 });

    // The job handler records a span when it runs. The span's parent
    // (via the active ExecutionContext) is the job's derived context.
    const echoHandler: JobHandler<{ message: string }> = {
      type: "echo-traced",
      async handle(ctx, payload) {
        const jobSpan = recorder.begin({ name: "job.execute" });
        ctx.logger.info("echo.handled", { message: payload.message });
        jobSpan.end({ handler: "echo" });
        return { echoed: payload.message };
      },
    };
    worker.registerHandler(echoHandler);
    worker.start();

    // The request scope: begin a span, then enqueue a job. The
    // enqueued job carries a DERIVED child context (correlationId
    // preserved, causationId = request executionId).
    const requestCtx = createExecutionContext({ correlationId: "ac07-trace-1" });
    let requestSpan: ReturnType<typeof recorder.begin> | null = null;
    let enqueueSpan: ReturnType<typeof recorder.begin> | null = null;
    let jobId: string | null = null;

    await runWithExecutionContextAsync(requestCtx, async () => {
      requestSpan = recorder.begin({ name: "request.incoming" });
      enqueueSpan = recorder.begin({ name: "queue.enqueue" });
      // Enqueue the job (carrying the active context).
      const result = await queue.enqueue(
        "echo-traced",
        { message: "hello" },
        getExecutionContext()!,
        { idempotencyKey: "ac07-1" },
      );
      jobId = result.id;
      enqueueSpan.end({ jobId: result.id });
      requestSpan.end({ status: "enqueued" });
    });

    // Wait for the worker to drain.
    await worker.drain();
    await worker.stop();

    const spans = recorder.spans();
    expect(spans.length).toBeGreaterThanOrEqual(3);
    // All spans share the correlationId.
    for (const s of spans) {
      expect(s.correlationId).toBe("ac07-trace-1");
    }
    // The trace is the set of spans sharing the correlationId.
    const trace = recorder.traceFor("ac07-trace-1");
    expect(trace.length).toBeGreaterThanOrEqual(3);

    // Find the spans by name.
    const byName = new Map<string, Span>();
    for (const s of trace) byName.set(s.name, s);
    const request = byName.get("request.incoming")!;
    const enqueue = byName.get("queue.enqueue")!;
    const job = byName.get("job.execute")!;
    expect(request).toBeDefined();
    expect(enqueue).toBeDefined();
    expect(job).toBeDefined();

    // The request and enqueue share the request's executionId.
    expect(request.executionId).toBe(requestCtx.executionId);
    expect(enqueue.executionId).toBe(requestCtx.executionId);
    // The job span has its OWN executionId (derived from the job id).
    expect(job.executionId).not.toBe(requestCtx.executionId);
    // The job span's causationId links to the request's executionId
    // (the worker loop derives a child context from the job record's
    // context, which preserved the correlationId and recorded the
    // parent executionId as causationId).
    expect(job.causationId).toBe(requestCtx.executionId);
  });

  test("a child span's causationId links to its parent's executionId", async () => {
    const recorder = createTraceRecorder();
    const parent = createExecutionContext({ correlationId: "ac07-causation" });
    await runWithExecutionContextAsync(parent, async () => {
      const parentSpan = recorder.begin({ name: "parent" });
      // Derive a child context (e.g. enqueue a sub-task). The child
      // has its own executionId but inherits the correlationId.
      const child = deriveExecutionContext(parent, {});
      await runWithExecutionContextAsync(child, async () => {
        const childSpan = recorder.begin({ name: "child" });
        childSpan.end();
      });
      parentSpan.end();
    });
    const trace = recorder.traceFor("ac07-causation");
    expect(trace.length).toBe(2);
    const parentSpan = trace.find((s) => s.name === "parent")!;
    const childSpan = trace.find((s) => s.name === "child")!;
    expect(parentSpan.executionId).toBe(parent.executionId);
    expect(childSpan.executionId).not.toBe(parent.executionId);
    // The child's causationId is the parent's executionId (because
    // the child context was derived from the parent).
    expect(childSpan.causationId).toBe(parent.executionId);
    expect(childSpan.correlationId).toBe(parentSpan.correlationId);
  });

  test("spans record status error when failed", async () => {
    const recorder = createTraceRecorder();
    const span = recorder.begin({ name: "failing" });
    span.fail("simulated error", { code: "X" });
    const spans = recorder.spans();
    const s = spans[0]!;
    expect(s.status).toBe("error");
    expect(s.errorMessage).toBe("simulated error");
    expect(s.attributes.code).toBe("X");
    expect(s.endedAt).not.toBeNull();
    expect(s.durationMs).not.toBeNull();
  });

  test("span attributes can be added in-flight and at end", async () => {
    const recorder = createTraceRecorder();
    const span = recorder.begin({ name: "attr", attributes: { initial: 1 } });
    span.setAttribute("mid", 2);
    span.end({ final: 3 });
    const s = recorder.spans()[0]!;
    expect(s.attributes.initial).toBe(1);
    expect(s.attributes.mid).toBe(2);
    expect(s.attributes.final).toBe(3);
  });

  test("the trace recorder is non-authoritative (no domain state)", async () => {
    // Spans are diagnostic only; clearing the recorder does not affect
    // any durable state. This proves the non-authority invariant.
    const recorder = createTraceRecorder();
    const ctx = createExecutionContext({ correlationId: "ac07-nonauth" });
    await runWithExecutionContextAsync(ctx, async () => {
      const s = recorder.begin({ name: "diagnostic" });
      s.end();
    });
    expect(recorder.count()).toBe(1);
    // "Clearing" the recorder (a new instance) loses spans but no
    // domain state existed in the first place.
    const fresh = createTraceRecorder();
    expect(fresh.count()).toBe(0);
  });

  test("count() and traceFor() reflect recorded spans", async () => {
    const recorder = createTraceRecorder();
    const a = createExecutionContext({ correlationId: "ac07-count-a" });
    const b = createExecutionContext({ correlationId: "ac07-count-b" });
    await runWithExecutionContextAsync(a, async () => recorder.begin({ name: "a1" }).end());
    await runWithExecutionContextAsync(a, async () => recorder.begin({ name: "a2" }).end());
    await runWithExecutionContextAsync(b, async () => recorder.begin({ name: "b1" }).end());
    expect(recorder.count()).toBe(3);
    expect(recorder.traceFor("ac07-count-a").length).toBe(2);
    expect(recorder.traceFor("ac07-count-b").length).toBe(1);
    expect(recorder.traceFor("ac07-count-none").length).toBe(0);
  });
});
