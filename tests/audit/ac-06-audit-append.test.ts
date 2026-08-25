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

// ---------------------------------------------------------------------------
// Deep immutability regression (architect review on PR #2, remediation #3).
// Audit entries must be DEEPLY immutable: nested metadata (objects,
// arrays, and deeper nesting) cannot be mutated by callers, despite the
// earlier shallow Object.freeze leaving nested layers writable.
// ---------------------------------------------------------------------------

describe("NET-W001-AC-06 audit deep immutability", () => {
  test("nested metadata cannot be mutated (deep freeze, in-memory)", async () => {
    const writer = createInMemoryAuditWriter();
    const ctx = createExecutionContext({ correlationId: "ac06-D1" });
    const appended = await writer.append({
      eventType: "system.config_loaded",
      context: ctx,
      metadata: {
        nested: { deep: "original", deeper: { leaf: 1 } },
        arr: [{ x: 1 }, { y: 2 }],
        scalar: "s",
      },
    });

    // The returned event is itself deeply frozen.
    expect(appended.metadata).toEqual({
      nested: { deep: "original", deeper: { leaf: 1 } },
      arr: [{ x: 1 }, { y: 2 }],
      scalar: "s",
    });

    const retrieved = await writer.query({ correlationId: "ac06-D1" });
    expect(retrieved).toHaveLength(1);
    const m = retrieved[0]!.metadata as Record<string, unknown>;

    // Top-level field is frozen.
    expect(() => {
      (m as { scalar: string }).scalar = "tampered";
    }).toThrow();
    // Nested object field is frozen (the previous shallow-freeze gap).
    expect(() => {
      ((m.nested as { deep: string }).deep) = "tampered";
    }).toThrow();
    // Deeper-nested object field is frozen.
    expect(() => {
      (((m.nested as { deeper: { leaf: number } }).deeper).leaf) = 999;
    }).toThrow();
    // Adding a new key to a nested frozen object throws.
    expect(() => {
      (m.nested as Record<string, unknown>).newProp = "x";
    }).toThrow();
    // Array element object field is frozen.
    expect(() => {
      ((m.arr as Array<{ x?: number; y?: number }>)[0]!.x) = 999;
    }).toThrow();
    // Array mutation (push) on a frozen array throws.
    expect(() => {
      (m.arr as unknown[]).push({ z: 3 });
    }).toThrow();

    // Value is unchanged after all attempted mutations.
    expect((m.nested as { deep: string }).deep).toBe("original");
    expect(((m.nested as { deeper: { leaf: number } }).deeper).leaf).toBe(1);
    expect((m.arr as Array<{ x?: number }>).length).toBe(2);
  });

  test("the caller's own metadata input is not frozen in place (deep clone)", async () => {
    const writer = createInMemoryAuditWriter();
    const ctx = createExecutionContext({ correlationId: "ac06-D2" });
    const callerMetadata = { nested: { deep: "v" } };
    await writer.append({
      eventType: "system.startup",
      context: ctx,
      metadata: callerMetadata,
    });
    // The caller can still mutate their own object after append — the
    // writer must not freeze the caller's input in place.
    expect(() => {
      callerMetadata.nested.deep = "mutated-by-caller";
    }).not.toThrow();
    expect(callerMetadata.nested.deep).toBe("mutated-by-caller");

    // ...and the stored event reflects the value at append time, not the
    // caller's later mutation (deep clone, no shared reference).
    const retrieved = await writer.query({ correlationId: "ac06-D2" });
    expect(retrieved[0]!.metadata).toEqual({ nested: { deep: "v" } });
  });

  test("file-backed entries are deeply immutable after reload across instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencon-audit-deep-"));
    try {
      const file = join(dir, "audit.jsonl");
      const w1 = createFileAuditWriter(file);
      const ctx = createExecutionContext({ correlationId: "ac06-D3" });
      await w1.append({
        eventType: "system.startup",
        context: ctx,
        metadata: { nested: { deep: "persisted", arr: [{ x: 1 }] } },
      });

      // New writer instance simulates a restart; loaded entries must be
      // deeply frozen so prior metadata cannot be mutated.
      const w2 = createFileAuditWriter(file);
      const retrieved = await w2.query({ correlationId: "ac06-D3" });
      expect(retrieved).toHaveLength(1);
      const m = retrieved[0]!.metadata as { nested: { deep: string; arr: Array<{ x: number }> } };
      expect(m.nested.deep).toBe("persisted");
      expect(() => {
        m.nested.deep = "tampered";
      }).toThrow();
      expect(() => {
        m.nested.arr[0]!.x = 999;
      }).toThrow();
      expect(() => {
        m.nested.arr.push({ x: 2 });
      }).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

