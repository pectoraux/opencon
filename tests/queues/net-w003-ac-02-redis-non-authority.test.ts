/**
 * NET-W003-AC-02 — Redis non-authority.
 *
 * Evidence: integration test proving loss of Redis coordination state
 * does NOT lose domain truth; authoritative state remains intact in
 * the PostgreSQL authority (architecture-lock §16).
 *
 * Scenario: acquire a coordination lock, perform an authoritative
 * mutation via the PostgresAuthority, then `clear()` the coordination
 * store (simulating Redis loss / `FLUSHDB`). Confirm:
 *  - the authoritative mutation is still present;
 *  - the lock is gone (coordination is non-durable);
 *  - a fresh authoritative read returns the committed state;
 *  - the non-authority invariant holds.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { RedisCoordinationShim } from "../../src/queues/redis-coordination-shim.ts";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let dir: string;
let coordination: RedisCoordinationShim;
let authority: PostgresAuthorityShim;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencon-redis-nonauth-"));
  coordination = new RedisCoordinationShim({});
  authority = new PostgresAuthorityShim({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NET-W003-AC-02 Redis non-authority", () => {
  test("clearing coordination state does not lose authoritative state", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-loss" });

    // Acquire a coordination lock (e.g. a worker lock).
    const lock = await coordination.acquireLock({ key: "worker-lock-1", ttlMs: 60_000 });
    expect(lock.acquired).toBe(true);

    // Set an ephemeral coordination value (e.g. a rate-limit counter).
    await coordination.setEphemeral("rate-limit:person-1", "42", 60_000);
    expect(await coordination.hasEphemeral("rate-limit:person-1")).toBe(true);

    // Perform an authoritative mutation via the PostgresAuthority.
    await authority.recover();
    await authority.run(ctx, async (tx) => {
      await tx.put("widgets", "w1", { name: "authoritative", value: 1 });
    });

    // SIMULATE REDIS LOSS — clear all coordination state.
    await coordination.clear();

    // The lock is gone (coordination is non-durable).
    expect(coordination._lockCount()).toBe(0);
    expect(await coordination.hasEphemeral("rate-limit:person-1")).toBe(false);

    // NON-AUTHORITY INVARIANT: authoritative state is UNAFFECTED.
    const w1 = await authority.get<{ name: string; value: number }>("widgets", "w1");
    expect(w1?.value).toEqual({ name: "authoritative", value: 1 });
    expect(await authority.count("widgets")).toBe(1);
  });

  test("a lock is coordination only — losing it does not corrupt authority", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-lock-loss" });
    const lock = await coordination.acquireLock({ key: "worker-lock-2", ttlMs: 60_000 });
    expect(lock.acquired).toBe(true);

    // Authoritative mutation under the lock.
    await authority.recover();
    await authority.run(ctx, async (tx) => {
      await tx.put("widgets", "protected", { x: 1 });
    });

    // Lose the lock (Redis crash).
    await coordination.clear();

    // The authoritative mutation is intact; a fresh caller can read it.
    const w = await authority.get<{ x: number }>("widgets", "protected");
    expect(w?.value).toEqual({ x: 1 });

    // A fresh lock can be re-acquired (the old one is gone).
    const relock = await coordination.acquireLock({ key: "worker-lock-2", ttlMs: 60_000 });
    expect(relock.acquired).toBe(true);
    await relock.release();
  });

  test("two callers cannot hold the same lock simultaneously", async () => {
    const a = await coordination.acquireLock({ key: "shared-lock", ttlMs: 60_000 });
    expect(a.acquired).toBe(true);
    const b = await coordination.acquireLock({ key: "shared-lock", ttlMs: 60_000 });
    expect(b.acquired).toBe(false); // someone else holds it
    await a.release();
    const c = await coordination.acquireLock({ key: "shared-lock", ttlMs: 60_000 });
    expect(c.acquired).toBe(true);
    await c.release();
  });

  test("locks expire after TTL (coordination is ephemeral)", async () => {
    let now = 1_000_000;
    const clocked = new RedisCoordinationShim({ now: () => now });
    const lock = await clocked.acquireLock({ key: "ttl-lock", ttlMs: 1_000 });
    expect(lock.acquired).toBe(true);
    // Advance past TTL.
    now += 2_000;
    const after = await clocked.acquireLock({ key: "ttl-lock", ttlMs: 1_000 });
    expect(after.acquired).toBe(true); // old lock expired
  });

  test("ephemeral values expire after TTL", async () => {
    let now = 1_000_000;
    const clocked = new RedisCoordinationShim({ now: () => now });
    await clocked.setEphemeral("session:1", "abc", 1_000);
    expect(await clocked.getEphemeral("session:1")).toBe("abc");
    now += 2_000;
    expect(await clocked.getEphemeral("session:1")).toBeNull();
  });

  test("clear() destroys ONLY coordination state — no authority touch", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-no-touch" });
    await authority.recover();
    await authority.run(ctx, async (tx) => {
      await tx.put("widgets", "w1", { n: 1 });
    });
    await coordination.setEphemeral("k", "v", 60_000);
    const beforeCount = await authority.count("widgets");
    await coordination.clear();
    const afterCount = await authority.count("widgets");
    expect(afterCount).toBe(beforeCount);
    expect(await authority.get("widgets", "w1")).not.toBeNull();
  });
});
