/**
 * NET-W001-AC-03 — Async execution.
 *
 * Evidence: integration test output.
 *
 * A representative non-domain test job can be enqueued and executed by
 * a worker while preserving the execution/correlation context. The
 * enqueuing caller's correlationId MUST appear in the worker's logs
 * and the audit record for the completed job (causation chain).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { TransientError } from "../../src/core/errors.ts";

const REPO = join(import.meta.dir, "../..");

let runtime: Runtime;

beforeEach(async () => {
  runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test" },
    port: 0,
  });
  await runtime.initialize();
});

afterEach(async () => {
  await runtime.shutdown();
});

describe("NET-W001-AC-03 async execution", () => {
  test("a non-domain ECHO job is enqueued and executed by the worker", async () => {
    const jobId = await runtime.enqueueEchoJob("hello-ac-03");
    expect(jobId).toBeTruthy();

    const stats = await runtime.workerLoop.drain();
    expect(stats.processed).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(0);

    // The job record is durable: still inspectable after execution.
    const record = await runtime.queue.inspect(jobId);
    expect(record).not.toBeNull();
    expect(record!.state).toBe("completed");
    expect(record!.type).toBe("echo");
  });

  test("execution/correlation context is preserved across the enqueue→execute boundary", async () => {
    const correlationId = "ac03-correlation";
    const callerCtx = createExecutionContext({
      correlationId,
      actor: { id: "caller", kind: "service" },
    });
    const result = await runtime.queue.enqueue(
      "echo",
      { message: "context-preservation" },
      callerCtx,
      { idempotencyKey: "ac03-ctx" },
    );
    expect(result.created).toBe(true);

    await runtime.workerLoop.drain();

    // Audit trail must contain the completed job event carrying the
    // SAME correlationId as the caller's context.
    const audit = await runtime.auditWriter.query({ correlationId });
    expect(audit.length).toBeGreaterThan(0);
    const completed = audit.find((e) => e.eventType === "worker.job_completed");
    expect(completed).toBeDefined();
    expect(completed!.correlationId).toBe(correlationId);
    // Causation: the job's executionId is derived from the durable job
    // id, distinct from the caller's executionId, but shares the
    // correlation id.
    expect(completed!.executionId).toBeTruthy();
    expect(completed!.executionId).not.toBe(callerCtx.executionId);
  });

  test("idempotency key prevents duplicate enqueue", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-idem" });
    const a = await runtime.queue.enqueue(
      "echo",
      { message: "once" },
      ctx,
      { idempotencyKey: "idem-key" },
    );
    const b = await runtime.queue.enqueue(
      "echo",
      { message: "once" },
      ctx,
      { idempotencyKey: "idem-key" },
    );
    expect(a.id).toBe(b.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect((runtime.queue as unknown as { _pendingLength(): number })._pendingLength()).toBe(1);
  });

  test("failing non-domain job dead-letters after retries exhaust", async () => {
    const flakyHandler = {
      type: "flaky",
      handle: async () => {
        throw new TransientError("boom");
      },
    };
    runtime.workerLoop.registerHandler(flakyHandler);
    const ctx = createExecutionContext({ correlationId: "ac03-flaky" });
    const { id } = await runtime.queue.enqueue("flaky", {}, ctx, {
      idempotencyKey: "ac03-flaky",
      retryPolicy: { maxAttempts: 2, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    });
    await runtime.workerLoop.drain();
    const record = await runtime.queue.inspect(id);
    expect(record!.state).toBe("dead_letter");
    expect(record!.attempts).toBe(2);
    const dl = await runtime.queue.deadLetters();
    expect(dl.find((j) => j.id === id)).toBeDefined();
  });
});
