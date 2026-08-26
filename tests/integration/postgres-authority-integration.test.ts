/**
 * NET-W003 real-provider integration — PostgreSQL authority.
 *
 * Evidence (architect re-review on PR #6, requirement #3): integration
 * tests exercising the REAL `PostgresAuthorityAdapter` (the `pg`
 * driver) against a real PostgreSQL instance for commit / restart /
 * rollback / recovery semantics.
 *
 * Conditional: these tests run ONLY when `PG_TEST_DATABASE_URL` is set
 * AND a real PostgreSQL is reachable. Without the env var, every test
 * in this file is skipped (so `bun run verify` stays green in
 * environments without a provisioned database). CI provisions a
 * PostgreSQL service container (`.github/workflows/ci.yml`) and sets
 * the env var so these tests execute on every PR. Local developers
 * can run `docker compose up` (see `docker-compose.yml`) and export
 * `PG_TEST_DATABASE_URL` to run them.
 *
 * Each test owns its own adapter instance (and a unique collection
 * name) so there is no cross-test coupling through a shared pool. The
 * "restart" simulation closes one adapter and constructs a second
 * pointed at the SAME schema; PostgreSQL itself is the system of
 * record, so committed state is durable across the pool recreation.
 *
 * The deterministic file-backed `PostgresAuthorityShim` (in
 * `src/persistence/`) covers the same authority contract for unit
 * tests that don't need a real database; this file proves the SAME
 * authority semantics hold against the real PostgreSQL adapter.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PostgresAuthorityAdapter } from "../../src/adapters/postgres/postgres-authority-adapter.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { AuthorityRecord, PostgresAuthority } from "../../src/core/postgres-authority.ts";

const PG_URL = process.env.PG_TEST_DATABASE_URL ?? "";
// Conditional test runner: real tests when the env var is set, skips
// otherwise. CI sets the env var; local runs without a database skip.
const itPg: typeof test = PG_URL ? test : test.skip;

// One shared schema for the whole file (created once, dropped at the
// end). Each test uses a unique collection name so it never touches
// another test's rows.
const schema = `opencon_test_${randomUUID().replace(/-/g, "")}`;
let bootstrap: PostgresAuthorityAdapter | null = null;

beforeAll(async () => {
  if (!PG_URL) return; // skipped
  bootstrap = new PostgresAuthorityAdapter({ connectionString: PG_URL, schema });
  await bootstrap.ensureSchema();
});

afterAll(async () => {
  if (!bootstrap) return;
  try {
    // Drop the isolated test schema so repeated CI runs are clean.
    const pool = (bootstrap as unknown as {
      pool: {
        connect: () => Promise<{
          query: (sql: string) => Promise<unknown>;
          release: () => void;
        }>;
      };
    }).pool;
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      client.release();
    }
  } catch {
    // ignore — best-effort
  }
  try {
    await bootstrap.close();
  } catch {
    // ignore
  }
});

function fresh(): PostgresAuthority {
  return new PostgresAuthorityAdapter({ connectionString: PG_URL, schema });
}

describe("NET-W003 real PostgreSQL authority (integration)", () => {
  itPg("committed writes survive a real restart (durable in PostgreSQL)", async () => {
    const ctx = createExecutionContext({ correlationId: "pgint-commit" });
    const coll = "int_commit";
    {
      const a = fresh();
      await a.recover();
      await a.run(ctx, async (tx) => {
        await tx.put(coll, "w1", { name: "first", value: 100 });
        await tx.put(coll, "w2", { name: "second", value: 200 });
      });
      await a.close();
    }
    // Simulate a restart: construct a new adapter pointed at the SAME
    // schema. PostgreSQL itself is the system of record.
    const b = fresh();
    const result = await b.recover();
    expect(result.recoveredRecords).toBeGreaterThanOrEqual(2);
    expect(result.discardedTransactions).toBe(0);
    const w1 = await b.get<{ name: string; value: number }>(coll, "w1");
    const w2 = await b.get<{ name: string; value: number }>(coll, "w2");
    expect(w1?.value).toEqual({ name: "first", value: 100 });
    expect(w2?.value).toEqual({ name: "second", value: 200 });
    await b.close();
  });

  itPg("uncommitted writes are NOT visible after rollback (real ROLLBACK discards them)", async () => {
    const ctx = createExecutionContext({ correlationId: "pgint-uncommitted" });
    const coll = "int_uncommitted";
    const a = fresh();
    await a.recover();
    // Begin, write, then roll back — the uncommitted write must not
    // be visible to any reader (inside or outside the tx) after
    // rollback, and no orphan in-flight marker may remain.
    const tx = await a.begin(ctx);
    await tx.put(coll, "uncommitted", { name: "should-vanish" });
    await tx.rollback();
    expect(await a.get(coll, "uncommitted")).toBeNull();
    const result = await a.recover();
    expect(result.discardedTransactions).toBe(0);
    await a.close();
  });

  itPg("recover() detects and discards orphaned in-flight markers (interrupted-tx recovery)", async () => {
    // Simulate a process crash that left an in-flight marker behind
    // (its user transaction was auto-rolled-back by PostgreSQL when
    // the connection dropped, but the marker row — committed in its
    // own tiny transaction at begin() — survived). recover() MUST
    // report it as discarded and remove it. This is the real-adapter
    // analogue of the shim's "interrupted tx discarded" recovery test.
    const coll = "int_orphan";
    const ctx = createExecutionContext({ correlationId: "pgint-orphan" });
    // First commit a real record so we can assert recoveredRecords.
    {
      const a = fresh();
      await a.recover();
      await a.run(ctx, async (tx) => {
        await tx.put(coll, "real", { n: 1 });
      });
      await a.close();
    }
    // Inject an orphaned in-flight marker directly (simulating a
    // crashed transaction whose marker survived but whose SQL work
    // was rolled back server-side).
    const pool = (bootstrap as unknown as {
      pool: {
        connect: () => Promise<{
          query: (sql: string, params?: unknown[]) => Promise<unknown>;
          release: () => void;
        }>;
      };
    }).pool;
    const inj = await pool.connect();
    try {
      await inj.query(
        `INSERT INTO "${schema}"."opencon_inflight_tx" (tx_id) VALUES ($1)`,
        ["orphan-" + randomUUID()],
      );
    } finally {
      inj.release();
    }
    // recover() must report the orphan as discarded.
    const b = fresh();
    const result = await b.recover();
    expect(result.recoveredRecords).toBeGreaterThanOrEqual(1);
    expect(result.discardedTransactions).toBe(1);
    // A second recover() reports 0 (the orphan was removed).
    const result2 = await b.recover();
    expect(result2.discardedTransactions).toBe(0);
    // The committed real record is still present.
    expect(await b.get(coll, "real")).not.toBeNull();
    await b.close();
  });

  itPg("explicit rollback does not persist writes (real ROLLBACK)", async () => {
    const ctx = createExecutionContext({ correlationId: "pgint-rollback" });
    const coll = "int_rollback";
    const a = fresh();
    await a.recover();
    await a.run(ctx, async (tx) => {
      await tx.put(coll, "committed", { n: 1 });
    });
    const tx = await a.begin(ctx);
    await tx.put(coll, "rolled-back", { n: 2 });
    await tx.rollback();
    expect(await a.get(coll, "committed")).not.toBeNull();
    expect(await a.get(coll, "rolled-back")).toBeNull();
    // The in-flight marker was removed (no orphan).
    const result = await a.recover();
    expect(result.discardedTransactions).toBe(0);
    await a.close();
  });

  itPg("writes inside a tx are NOT visible to a concurrent outside reader until commit (real READ COMMITTED)", async () => {
    const ctx = createExecutionContext({ correlationId: "pgint-isolation" });
    const coll = "int_isolation";
    const a = fresh();
    await a.recover();
    const tx = await a.begin(ctx);
    await tx.put(coll, "in-flight", { n: 1 });
    // Outside the tx (a fresh pooled read), the write is not visible.
    expect(await a.get(coll, "in-flight")).toBeNull();
    // Inside the tx, it IS visible.
    const within = await tx.get<{ n: number }>(coll, "in-flight");
    expect(within?.value).toEqual({ n: 1 });
    await tx.commit();
    // After commit, outside readers see it.
    const outside = await a.get<{ n: number }>(coll, "in-flight");
    expect(outside?.value).toEqual({ n: 1 });
    await a.close();
  });

  itPg("committed records carry execution/correlation lineage (real columns)", async () => {
    const ctx = createExecutionContext({
      correlationId: "pgint-lineage",
      actor: { id: "person-1", kind: "person" },
    });
    const coll = "int_lineage";
    const a = fresh();
    await a.recover();
    let record: AuthorityRecord<{ x: number }> | null = null;
    await a.run(ctx, async (tx) => {
      record = await tx.put<{ x: number }>(coll, "m1", { x: 42 });
    });
    expect(record).not.toBeNull();
    expect(record!.executionId).toBe(ctx.executionId);
    expect(record!.correlationId).toBe("pgint-lineage");
    expect(record!.actorId).toBe("person-1");
    expect(record!.revision).toBe(1);
    const committed = await a.get<{ x: number }>(coll, "m1");
    expect(committed?.executionId).toBe(ctx.executionId);
    expect(committed?.correlationId).toBe("pgint-lineage");
    expect(committed?.actorId).toBe("person-1");
    await a.close();
  });

  itPg("revisions increment monotonically per key (real ON CONFLICT revision+1)", async () => {
    const ctx = createExecutionContext({ correlationId: "pgint-revisions" });
    const coll = "int_revisions";
    const a = fresh();
    await a.recover();
    let r1: AuthorityRecord;
    let r2: AuthorityRecord;
    await a.run(ctx, async (tx) => {
      r1 = (await tx.put(coll, "c", 1)) as AuthorityRecord;
      expect(r1.revision).toBe(1);
    });
    await a.run(ctx, async (tx) => {
      r2 = (await tx.put(coll, "c", 2)) as AuthorityRecord;
      expect(r2.revision).toBe(2);
    });
    const committed = await a.get(coll, "c");
    expect(committed?.revision).toBe(2);
    await a.close();
  });

  itPg("scan returns all committed records in a collection", async () => {
    const ctx = createExecutionContext({ correlationId: "pgint-scan" });
    const coll = "int_scan";
    const a = fresh();
    await a.recover();
    await a.run(ctx, async (tx) => {
      await tx.put(coll, "a", { i: 1 });
      await tx.put(coll, "b", { i: 2 });
      await tx.put(coll, "c", { i: 3 });
    });
    const all = await a.scan<{ i: number }>(coll);
    expect(all.length).toBe(3);
    const keys = all.map((r) => r.key).sort();
    expect(keys).toEqual(["a", "b", "c"]);
    expect(await a.count(coll)).toBe(3);
    await a.close();
  });
});

// A non-skipped canary so `bun test` always reports at least one entry
// for this file even when the env var is absent (the rest skip).
describe("NET-W003 real PostgreSQL authority (integration canary)", () => {
  test("env var presence is reported (skipped when no database provisioned)", () => {
    if (!PG_URL) {
      expect(PG_URL).toBe("");
      return;
    }
    expect(PG_URL.length).toBeGreaterThan(0);
  });
});
