/**
 * NET-W003-AC-01 — PostgreSQL authority.
 *
 * Evidence: integration test against a file-backed authority test double.
 *
 * Authoritative state survives process restart; uncommitted writes are
 * NOT visible after recovery; committed writes ARE.
 *
 * The test simulates "restart" by closing the PostgresAuthorityShim and
 * constructing a new one pointing at the same durable directory, then
 * calling `recover()`. This mirrors how a real PostgreSQL connection
 * would re-read WAL/committed state on restart.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { AuthorityRecord } from "../../src/core/postgres-authority.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencon-pg-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NET-W003-AC-01 PostgreSQL authority", () => {
  test("committed writes survive process restart (durable snapshot persists)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-commit" });
    {
      const authority = new PostgresAuthorityShim({ dir });
      await authority.recover();
      await authority.run(ctx, async (tx) => {
        await tx.put("widgets", "w1", { name: "first", value: 100 });
        await tx.put("widgets", "w2", { name: "second", value: 200 });
      });
      await authority.close();
    }
    // New shim pointing at the same durable dir = "restart".
    const recovered = new PostgresAuthorityShim({ dir });
    const result = await recovered.recover();
    expect(result.recoveredRecords).toBeGreaterThanOrEqual(2);
    expect(result.discardedTransactions).toBe(0);
    const w1 = await recovered.get<{ name: string; value: number }>("widgets", "w1");
    const w2 = await recovered.get<{ name: string; value: number }>("widgets", "w2");
    expect(w1?.value).toEqual({ name: "first", value: 100 });
    expect(w2?.value).toEqual({ name: "second", value: 200 });
    await recovered.close();
  });

  test("uncommitted writes are NOT visible after recovery (rollback discards)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-rollback" });
    {
      const authority = new PostgresAuthorityShim({ dir });
      await authority.recover();
      // Begin, write, but DO NOT commit — leave the tx unsettled to
      // simulate a process crash mid-transaction.
      const tx = await authority.begin(ctx);
      await tx.put("widgets", "uncommitted", { name: "should-vanish" });
      // Note: we do NOT call commit() OR rollback() — the tx is in-flight.
      // The in-flight log records the active tx id.
      await authority.close();
    }
    // Restart: recover() should report the interrupted tx as discarded.
    const recovered = new PostgresAuthorityShim({ dir });
    const result = await recovered.recover();
    expect(result.discardedTransactions).toBe(1);
    // The uncommitted write is NOT in committed state.
    const w = await recovered.get("widgets", "uncommitted");
    expect(w).toBeNull();
    await recovered.close();
  });

  test("explicit rollback does not persist the in-flight marker", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-explicit-rollback" });
    const authority = new PostgresAuthorityShim({ dir });
    await authority.recover();
    await authority.run(ctx, async (tx) => {
      await tx.put("widgets", "committed", { n: 1 });
    });
    // Now a tx that rolls back.
    const tx = await authority.begin(ctx);
    await tx.put("widgets", "rolled-back", { n: 2 });
    await tx.rollback();
    // Restart.
    await authority.close();
    const recovered = new PostgresAuthorityShim({ dir });
    const result = await recovered.recover();
    expect(result.discardedTransactions).toBe(0); // explicit rollback removed the marker
    expect(await recovered.get("widgets", "committed")).not.toBeNull();
    expect(await recovered.get("widgets", "rolled-back")).toBeNull();
    await recovered.close();
  });

  test("writes inside a tx are NOT visible to a concurrent outside reader until commit", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-isolation" });
    const authority = new PostgresAuthorityShim({ dir });
    await authority.recover();
    const tx = await authority.begin(ctx);
    await tx.put("widgets", "in-flight", { n: 1 });
    // Outside the tx, the write is not visible.
    expect(await authority.get("widgets", "in-flight")).toBeNull();
    // Inside the tx, it IS visible.
    const within = await tx.get("widgets", "in-flight");
    expect(within?.value).toEqual({ n: 1 });
    await tx.commit();
    // After commit, outside readers see it.
    const outside = await authority.get("widgets", "in-flight");
    expect(outside?.value).toEqual({ n: 1 });
    await authority.close();
  });

  test("committed records carry execution/correlation lineage for material-mutation tracing", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac01-lineage",
      actor: { id: "person-1", kind: "person" },
    });
    const authority = new PostgresAuthorityShim({ dir });
    await authority.recover();
    let record: AuthorityRecord<{ x: number }> | null = null;
    await authority.run(ctx, async (tx) => {
      record = await tx.put<{ x: number }>("mutations", "m1", { x: 42 });
    });
    expect(record).not.toBeNull();
    expect(record!.executionId).toBe(ctx.executionId);
    expect(record!.correlationId).toBe("ac01-lineage");
    expect(record!.actorId).toBe("person-1");
    expect(record!.revision).toBe(1);
    // The committed record preserves the lineage.
    const committed = await authority.get<{ x: number }>("mutations", "m1");
    expect(committed?.executionId).toBe(ctx.executionId);
    expect(committed?.correlationId).toBe("ac01-lineage");
    expect(committed?.actorId).toBe("person-1");
    await authority.close();
  });

  test("revision numbers increment monotonically per key", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-revisions" });
    const authority = new PostgresAuthorityShim({ dir });
    await authority.recover();
    let r1: AuthorityRecord;
    let r2: AuthorityRecord;
    await authority.run(ctx, async (tx) => {
      r1 = await tx.put("counters", "c", 1);
      expect(r1.revision).toBe(1);
    });
    await authority.run(ctx, async (tx) => {
      r2 = await tx.put("counters", "c", 2);
      expect(r2.revision).toBe(2);
    });
    const committed = await authority.get("counters", "c");
    expect(committed?.revision).toBe(2);
    await authority.close();
  });

  test("the durable snapshot file exists after a commit (proves persistence)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-snapshot" });
    const authority = new PostgresAuthorityShim({ dir });
    await authority.recover();
    expect(existsSync(join(dir, "committed.json"))).toBe(false);
    await authority.run(ctx, async (tx) => {
      await tx.put("widgets", "w1", { n: 1 });
    });
    expect(existsSync(join(dir, "committed.json"))).toBe(true);
    expect(existsSync(join(dir, "inflight.json"))).toBe(true);
    await authority.close();
  });
});
