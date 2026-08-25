/**
 * NET-W001-AC-05 — Structured observability.
 *
 * Evidence: automated logging/integration test.
 *
 * A representative HTTP request AND a worker execution emit structured
 * (JSON) logs containing execution and correlation identifiers.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import type { LogEntry } from "../../src/core/logger.ts";

const REPO = join(import.meta.dir, "../..");

let runtime: Runtime;

beforeEach(async () => {
  runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "info" },
    port: 0,
  });
  await runtime.initialize();
  await runtime.api.start();
});

afterEach(async () => {
  await runtime.shutdown();
});

function isStructured(entry: unknown): entry is LogEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "level" in entry &&
    "message" in entry &&
    "executionId" in entry &&
    "correlationId" in entry &&
    "timestamp" in entry
  );
}

describe("NET-W001-AC-05 structured observability", () => {
  test("an HTTP request emits a structured log with execution+correlation IDs", async () => {
    const before = runtime.logSink.entries.length;
    const res = await fetch(`http://127.0.0.1:${runtime.api.port}/live`, {
      headers: { "x-correlation-id": "ac05-http" },
    });
    expect(res.status).toBe(200);
    // Response must propagate the correlation id back to the caller.
    expect(res.headers.get("x-correlation-id")).toBe("ac05-http");
    expect(res.headers.get("x-execution-id")).toBeTruthy();

    // Allow the event loop to flush synchronous logs.
    await new Promise((r) => setTimeout(r, 10));

    const newEntries = runtime.logSink.entries.slice(before);
    const completed = newEntries.find(
      (e) => (e as { message?: string }).message === "api.request_completed",
    );
    expect(completed, "expected api.request_completed log").toBeDefined();
    expect(isStructured(completed)).toBe(true);
    const ce = completed as LogEntry;
    expect(ce.correlationId).toBe("ac05-http");
    expect(ce.executionId).toBeTruthy();
    expect(ce.level).toBe("info");
    expect(ce.module).toBe("api");
  });

  test("a worker execution emits a structured log with execution+correlation IDs", async () => {
    const before = runtime.logSink.entries.length;
    // Enqueue under a request-scoped context via the API endpoint.
    const res = await fetch(`http://127.0.0.1:${runtime.api.port}/api/echo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac05-worker",
      },
      body: JSON.stringify({ message: "from-ac05" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBeTruthy();

    await runtime.workerLoop.drain();
    await new Promise((r) => setTimeout(r, 10));

    const newEntries = runtime.logSink.entries.slice(before);
    const handled = newEntries.find(
      (e) => (e as { message?: string }).message === "echo.handled",
    );
    expect(handled, "expected echo.handled worker log").toBeDefined();
    expect(isStructured(handled)).toBe(true);
    const he = handled as LogEntry;
    // Worker context shares the correlationId propagated from the HTTP
    // request that enqueued the job.
    expect(he.correlationId).toBe("ac05-worker");
    expect(he.executionId).toBeTruthy();
  });

  test("structured logs are valid JSON objects (not opaque strings)", () => {
    // Collector stores parsed JSON objects; verify one entry's shape.
    const any = runtime.logSink.entries[0];
    if (any) {
      expect(typeof any).toBe("object");
      expect(typeof (any as LogEntry).timestamp).toBe("string");
    }
  });
});
