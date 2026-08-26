/**
 * NET-W003-AC-05 — Transaction rollback/recovery.
 *
 * Evidence: integration test proving transactions roll back atomically
 * on error; recovery restores only committed state.
 *
 * architecture-lock §12 (workflow transitions deterministic/idempotent),
 * §16 (Redis/caches never authoritative — transactions live in PostgreSQL).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import { createDurableTransactionManager } from "../../src/persistence/durable-transaction-manager.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { StorageCorruptionError } from "../../src/core/errors.ts";

let dir: string;
let authority: PostgresAuthorityShim;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencon-tx-"));
  authority = new PostgresAuthorityShim({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NET-W003-AC-05 transaction rollback/recovery", () => {
  test("begin, write A, write B, throw → rollback → neither A nor B visible", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-both-rollback" });
    await authority.recover();
    const tm = createDurableTransactionManager({ authority });
    await expect(
      tm.run(ctx, async (tx) => {
        // Use the underlying authority transaction via the bridge.
        // For the contract test, use authority.begin directly through
        // the manager's tx handle.
        // We need access to the authority tx — use the bridge helper.
        const { asAuthorityTransaction } = await import(
          "../../src/persistence/durable-transaction-manager.ts"
        );
        const atx = asAuthorityTransaction(tx);
        if (!atx) throw new Error("authority tx not available");
        await atx.put("widgets", "A", 1);
        await atx.put("widgets", "B", 2);
        throw new Error("simulated failure mid-transaction");
      }),
    ).rejects.toThrow(/simulated failure mid-transaction/);
    expect(await authority.get("widgets", "A")).toBeNull();
    expect(await authority.get("widgets", "B")).toBeNull();
    expect(await authority.count("widgets")).toBe(0);
  });

  test("begin, write A, commit, begin, write B, throw → rollback → A visible, B absent", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-partial" });
    await authority.recover();
    const tm = createDurableTransactionManager({ authority });
    const { asAuthorityTransaction } = await import(
      "../../src/persistence/durable-transaction-manager.ts"
    );
    // First tx commits A.
    await tm.run(ctx, async (tx) => {
      const atx = asAuthorityTransaction(tx)!;
      await atx.put("widgets", "A", 1);
    });
    expect(await authority.get("widgets", "A")).not.toBeNull();
    // Second tx writes B then throws.
    await expect(
      tm.run(ctx, async (tx) => {
        const atx = asAuthorityTransaction(tx)!;
        await atx.put("widgets", "B", 2);
        throw new Error("rollback B");
      }),
    ).rejects.toThrow(/rollback B/);
    expect(await authority.get("widgets", "A")).not.toBeNull();
    expect(await authority.get("widgets", "B")).toBeNull();
    const a = await authority.get<number>("widgets", "A");
    expect(a?.value).toBe(1);
  });

  test("recovery-on-restart restores committed state only (interrupted tx discarded)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-recovery" });
    {
      const a = new PostgresAuthorityShim({ dir });
      await a.recover();
      // Commit A.
      await a.run(ctx, async (tx) => {
        await tx.put("widgets", "A", { n: 1 });
      });
      // Begin a tx that writes B but DO NOT commit (simulate crash).
      const tx = await a.begin(ctx);
      await tx.put("widgets", "B", { n: 2 });
      await a.close();
    }
    // Restart.
    const recovered = new PostgresAuthorityShim({ dir });
    const result = await recovered.recover();
    expect(result.recoveredRecords).toBe(1);
    expect(result.discardedTransactions).toBe(1);
    expect(await recovered.get("widgets", "A")).not.toBeNull();
    expect(await recovered.get("widgets", "B")).toBeNull();
    await recovered.close();
  });

  test("rollback is idempotent (multiple calls do not throw or persist)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-idempotent-rollback" });
    await authority.recover();
    const tx = await authority.begin(ctx);
    await tx.put("widgets", "A", 1);
    await tx.rollback();
    await tx.rollback(); // idempotent — no throw
    await tx.rollback(); // idempotent — no throw
    expect(await authority.get("widgets", "A")).toBeNull();
  });

  test("commit is idempotent (double-commit does not duplicate)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-idempotent-commit" });
    await authority.recover();
    const tx = await authority.begin(ctx);
    await tx.put("widgets", "A", 1);
    await tx.commit();
    await tx.commit(); // idempotent
    expect(await authority.count("widgets")).toBe(1);
  });

  test("a transaction that puts then deletes leaves no trace after rollback", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-put-delete-rollback" });
    await authority.recover();
    // First commit a baseline record.
    await authority.run(ctx, async (tx) => {
      await tx.put("widgets", "baseline", { n: 1 });
    });
    // Tx that puts and then deletes, then rolls back.
    await expect(
      authority.run(ctx, async (tx) => {
        await tx.put("widgets", "new", { n: 2 });
        await tx.delete("widgets", "baseline");
        throw new Error("rollback");
      }),
    ).rejects.toThrow(/rollback/);
    // Baseline survived (the delete was rolled back); new is absent.
    expect(await authority.get("widgets", "baseline")).not.toBeNull();
    expect(await authority.get("widgets", "new")).toBeNull();
  });

  test("the durable transaction manager wraps the authority with real semantics", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-tm-wrap" });
    await authority.recover();
    const tm = createDurableTransactionManager({ authority });
    const { asAuthorityTransaction } = await import(
      "../../src/persistence/durable-transaction-manager.ts"
    );
    // Successful run commits.
    await tm.run(ctx, async (tx) => {
      const atx = asAuthorityTransaction(tx)!;
      await atx.put("widgets", "committed", { v: 1 });
    });
    expect(await authority.get("widgets", "committed")).not.toBeNull();
    // Failed run rolls back.
    await expect(
      tm.run(ctx, async (tx) => {
        const atx = asAuthorityTransaction(tx)!;
        await atx.put("widgets", "rolled-back", { v: 2 });
        throw new Error("fail");
      }),
    ).rejects.toThrow(/fail/);
    expect(await authority.get("widgets", "rolled-back")).toBeNull();
  });

  test("a corrupt committed snapshot surfaces as StorageCorruptionError (not an empty store)", async () => {
    // Architect re-review on PR #6: corrupt persisted state must NOT
    // silently become an empty database — that would convert storage
    // corruption into data loss. Recovery surfaces an explicit error.
    const ctx = createExecutionContext({ correlationId: "ac05-corrupt-committed" });
    {
      const a = new PostgresAuthorityShim({ dir });
      await a.recover();
      await a.run(ctx, async (tx) => {
        await tx.put("widgets", "A", { n: 1 });
        await tx.put("widgets", "B", { n: 2 });
      });
      await a.close();
    }
    // Corrupt the committed snapshot on disk.
    writeFileSync(join(dir, "committed.json"), "{not valid json", "utf8");
    const corrupt = new PostgresAuthorityShim({ dir });
    await expect(corrupt.recover()).rejects.toThrow(StorageCorruptionError);
    // Also: a direct read must NOT silently return an empty store —
    // it must surface the same corruption error (the authority is
    // unavailable, not wiped).
    const corrupt2 = new PostgresAuthorityShim({ dir });
    await expect(corrupt2.get("widgets", "A")).rejects.toThrow(StorageCorruptionError);
  });

  test("a snapshot with an unsupported version surfaces as StorageCorruptionError", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-bad-version" });
    {
      const a = new PostgresAuthorityShim({ dir });
      await a.recover();
      await a.run(ctx, async (tx) => {
        await tx.put("widgets", "A", { n: 1 });
      });
      await a.close();
    }
    // Parseable JSON, but the version field is wrong (not 1).
    writeFileSync(
      join(dir, "committed.json"),
      JSON.stringify({ version: 999, records: {}, revisions: {} }),
      "utf8",
    );
    const corrupt = new PostgresAuthorityShim({ dir });
    await expect(corrupt.recover()).rejects.toThrow(StorageCorruptionError);
  });

  test("a corrupt in-flight log is safely discarded (committed state still recovers)", async () => {
    // The in-flight log is NON-AUTHORITATIVE coordination metadata.
    // Corruption there must NOT block recovery of committed state —
    // the safe posture is to treat all possibly-in-flight txns as
    // interrupted and discard them (which recover() does anyway).
    const ctx = createExecutionContext({ correlationId: "ac05-corrupt-inflight" });
    {
      const a = new PostgresAuthorityShim({ dir });
      await a.recover();
      await a.run(ctx, async (tx) => {
        await tx.put("widgets", "A", { n: 1 });
      });
      await a.close();
    }
    writeFileSync(join(dir, "inflight.json"), "{not valid json", "utf8");
    const recovered = new PostgresAuthorityShim({ dir });
    const result = await recovered.recover();
    // Committed state is intact.
    expect(result.recoveredRecords).toBe(1);
    // No in-flight txns were known (the corrupt log was discarded).
    expect(result.discardedTransactions).toBe(0);
    const a = await recovered.get<{ n: number }>("widgets", "A");
    expect(a?.value).toEqual({ n: 1 });
    await recovered.close();
  });
});
