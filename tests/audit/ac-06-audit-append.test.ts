/**
 * NET-W001-AC-06 — Audit append boundary.
 *
 * Evidence: audit persistence test.
 *
 * A representative system event can be appended to the audit interface
 * and retrieved without mutation of prior entries. The file-backed
 * writer proves append-only persistence across "restarts".
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createInMemoryAuditWriter,
  createFileAuditWriter,
} from "../../src/audit/audit-writer.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencon-audit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NET-W001-AC-06 audit append boundary", () => {
  test("a representative system event can be appended and retrieved", async () => {
    const writer = createInMemoryAuditWriter();
    const ctx = createExecutionContext({ correlationId: "ac06-1" });
    const event = await writer.append({
      eventType: "system.startup",
      context: ctx,
      metadata: { env: "test" },
    });
    expect(event.eventId).toBeTruthy();
    expect(event.eventType).toBe("system.startup");
    expect(event.correlationId).toBe("ac06-1");
    expect(event.executionId).toBe(ctx.executionId);

    const retrieved = await writer.query({ correlationId: "ac06-1" });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]!.eventId).toBe(event.eventId);
  });

  test("prior entries are not mutated by later appends (in-memory)", async () => {
    const writer = createInMemoryAuditWriter();
    const ctxA = createExecutionContext({ correlationId: "ac06-A" });
    const a = await writer.append({
      eventType: "module.registered",
      context: ctxA,
      metadata: { v: 1 },
    });
    const ctxB = createExecutionContext({ correlationId: "ac06-B" });
    await writer.append({
      eventType: "module.initialized",
      context: ctxB,
      metadata: { v: 2 },
    });

    const all = await writer.query({ limit: 100 });
    expect(all).toHaveLength(2);
    // First entry unchanged.
    expect(all[0]!.eventId).toBe(a.eventId);
    expect(all[0]!.metadata).toEqual({ v: 1 });

    // Mutation of a retrieved (frozen) entry throws — append-only.
    expect(() => {
      (all[0] as { actor: string | null }).actor = "tampered";
    }).toThrow();
  });

  test("file-backed audit persists append-only across writer instances", async () => {
    const file = join(dir, "audit.jsonl");

    const w1 = createFileAuditWriter(file);
    const ctxA = createExecutionContext({ correlationId: "ac06-P1" });
    const a = await w1.append({
      eventType: "system.config_loaded",
      context: ctxA,
      metadata: { phase: "first" },
    });
    expect(existsSync(file)).toBe(true);

    // Simulate a restart: a brand-new writer on the same file.
    const w2 = createFileAuditWriter(file);
    const ctxB = createExecutionContext({ correlationId: "ac06-P2" });
    await w2.append({
      eventType: "system.startup",
      context: ctxB,
      metadata: { phase: "second" },
    });

    const all = await w2.query({ limit: 100 });
    expect(all).toHaveLength(2);
    // Prior entry preserved exactly (append-only; first line never rewritten).
    expect(all[0]!.eventId).toBe(a.eventId);
    expect(all[0]!.metadata).toEqual({ phase: "first" });
    expect(all[1]!.metadata).toEqual({ phase: "second" });

    // Raw file contains exactly two lines (append, not rewrite).
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("audit query filters by event type and resource", async () => {
    const writer = createInMemoryAuditWriter();
    const ctx = createExecutionContext({ correlationId: "ac06-Q" });
    await writer.append({ eventType: "worker.job_completed", context: ctx, resourceType: "job", resourceId: "j1", metadata: {} });
    await writer.append({ eventType: "worker.job_dead_lettered", context: ctx, resourceType: "job", resourceId: "j2", metadata: {} });
    await writer.append({ eventType: "module.initialized", context: ctx, metadata: {} });

    const completed = await writer.query({ eventType: "worker.job_completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.resourceId).toBe("j1");

    const jobs = await writer.query({ resourceType: "job" });
    expect(jobs).toHaveLength(2);

    const all = await writer.query({ limit: 100 });
    expect(all).toHaveLength(3);
    expect(await writer.count()).toBe(3);
  });
});
