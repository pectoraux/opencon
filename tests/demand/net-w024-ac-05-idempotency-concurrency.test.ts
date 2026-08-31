/**
 * NET-W024 AC-05 — Same-key replay and concurrent submissions are
 * exactly-once and preserve aggregate conservation (issue #48
 * acceptance criterion 5).
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-05.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW024Harness,
  createPool,
  createCommitment,
  createPerson,
  consumerCtx,
  supplierCtx,
  personCtx,
  key,
  type NetW024Harness,
} from "./_net-w024-harness.ts";
import { DemandCommitmentConflictError } from "../../src/core/demand.ts";
import type { DemandCommitment } from "../../src/demand/port.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

async function members(n: number, tag: string) {
  const persons: { personId: string }[] = [];
  for (let i = 0; i < n; i++) {
    persons.push(
      await createPerson(harness, {
        displayName: `AC-05 ${tag} ${String(i)}`,
        subjectId: `w024-ac05-${tag}-${String(i)}@example.com`,
        member: true,
      }),
    );
  }
  return persons;
}

describe("NET-W024-AC-05 idempotency, concurrency, conservation", () => {
  test("same-key commitment replay is exactly-once: one record, one audit event", async () => {
    const pool = await createPool(harness, { minimumCommitments: 1 });
    const idempotencyKey = key("w024-ac05-replay");
    const ctx = consumerCtx(harness, "w024-ac05-replay");

    const first = await harness.runtime.demandService.createDemandCommitment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey,
      },
    );
    expect(first.created).toBe(true);

    // The SAME key replays the committed record: created false, the
    // identical id, and NO second audit event.
    const replay = await harness.runtime.demandService.createDemandCommitment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "EU_NORTH", quantity: 99 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey,
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.commitment.id).toBe(first.commitment.id);
    expect(replay.commitment.attributes).toEqual(
      first.commitment.attributes,
    );

    const commitments = await harness.runtime.demandService.listDemandCommitments(
      ctx,
      harness.organizationScopeId,
      { poolId: pool.id },
    );
    expect(commitments.length).toBe(1);

    const events = await harness.runtime.auditWriter.query({
      eventType: "demand_commitment.recorded",
    });
    const forPool = events.filter(
      (e) =>
        (e.metadata as Record<string, unknown>)["poolId"] === pool.id,
    );
    expect(forPool.length).toBe(1);
  });

  test("4-way CONCURRENT same-key submissions yield exactly one commitment", async () => {
    const pool = await createPool(harness, { minimumCommitments: 1 });
    const idempotencyKey = key("w024-ac05-concurrent-same");
    const ctx = consumerCtx(harness, "w024-ac05-concurrent-same");
    const make = () =>
      harness.runtime.demandService.createDemandCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey,
      });
    const results = await Promise.all([make(), make(), make(), make()]);
    expect(results.filter((r) => r.created).length).toBe(1);
    const ids = new Set(results.map((r) => r.commitment.id));
    expect(ids.size).toBe(1);

    const commitments = await harness.runtime.demandService.listDemandCommitments(
      ctx,
      harness.organizationScopeId,
      { poolId: pool.id },
    );
    expect(commitments.length).toBe(1);
  });

  test("4-way CONCURRENT distinct consumers all commit and the derived count is CONSERVED", async () => {
    const pool = await createPool(harness, { minimumCommitments: 4 });
    const others = await members(3, "conc");
    const actors = [
      consumerCtx(harness, "w024-ac05-conc-c"),
      supplierCtx(harness, "w024-ac05-conc-s"),
      personCtx(others[0]!.personId, "w024-ac05-conc-1"),
      personCtx(others[1]!.personId, "w024-ac05-conc-2"),
    ];
    const results = await Promise.all(
      actors.map((ctx, i) =>
        harness.runtime.demandService.createDemandCommitment(ctx, {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          attributes: {
            region: "NA_EAST",
            quantity: 10 + i,
          },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key(`w024-ac05-conc-${String(i)}`),
        }),
      ),
    );
    expect(results.every((r) => r.created)).toBe(true);

    // AGGREGATE CONSERVATION: the derived count equals the number of
    // distinct committed consumers — exactly, no lost/double writes.
    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac05-conc-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view.aggregate?.commitmentCount).toBe(4);
    expect(view.qualified).toBe(true);
  });

  test("withdrawal is exactly-once and idempotent (replay returns the withdrawn record unchanged)", async () => {
    const pool = await createPool(harness, { minimumCommitments: 1 });
    const commitment = await createCommitment(harness, { poolId: pool.id });
    const ctx = consumerCtx(harness, "w024-ac05-withdraw");
    const idempotencyKey = key("w024-ac05-withdraw");

    const first = await harness.runtime.demandService.withdrawDemandCommitment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey,
      },
    );
    expect(first.withdrawnAt).not.toBeNull();

    const replay = await harness.runtime.demandService.withdrawDemandCommitment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey,
      },
    );
    expect(replay.withdrawnAt).toBe(first.withdrawnAt);

    const events = await harness.runtime.auditWriter.query({
      eventType: "demand_commitment.withdrawn",
      resourceId: commitment.id,
    });
    expect(events.length).toBe(1);
  });

  test("ONE active commitment per (pool, consumer): a stable conflict; withdrawal frees re-commitment", async () => {
    const pool = await createPool(harness, { minimumCommitments: 1 });
    const first = await createCommitment(harness, { poolId: pool.id });
    const ctx = consumerCtx(harness, "w024-ac05-conflict");

    // Same consumer, DIFFERENT key → the one-active constraint is a
    // stable conflict (machine-readable existingCommitmentId).
    let conflict: unknown;
    try {
      await harness.runtime.demandService.createDemandCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 20 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac05-conflict"),
      });
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeInstanceOf(DemandCommitmentConflictError);
    const err = conflict as DemandCommitmentConflictError;
    expect(err.classification).toBe("conflict");
    expect((err.context as Record<string, unknown>)["existingCommitmentId"]).toBe(
      first.id,
    );
    // The failed attempt left no second record.
    const listed = await harness.runtime.demandService.listDemandCommitments(
      ctx,
      harness.organizationScopeId,
      { poolId: pool.id },
    );
    expect(listed.length).toBe(1);

    // Withdraw, then re-commit: a NEW record (the withdrawn one never
    // blocks re-commitment).
    await harness.runtime.demandService.withdrawDemandCommitment(ctx, {
      organizationScopeId: harness.organizationScopeId,
      commitmentId: first.id,
      idempotencyKey: key("w024-ac05-reconf-w"),
    });
    const second: DemandCommitment =
      await harness.runtime.demandService.createDemandCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 20 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac05-recommit"),
      }).then((r) => r.commitment);
    expect(second.id).not.toBe(first.id);

    // Conservation again: exactly ONE active commitment.
    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac05-reconf-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    // 1 active < floor 3 → count suppressed, but the active listing
    // shows exactly one record for this consumer.
    const active = await harness.runtime.demandService.listDemandCommitments(
      ctx,
      harness.organizationScopeId,
      { poolId: pool.id, withdrawn: false },
    );
    expect(active.length).toBe(1);
    expect(active[0]?.id).toBe(second.id);
    expect(view.qualified).toBe(false);
  });

  test("pool creation replays exactly-once (same key → same record, created false, one audit event)", async () => {
    const idempotencyKey = key("w024-ac05-pool-replay");
    const ctx = consumerCtx(harness, "w024-ac05-pool-replay");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      name: "AC-05 Replay Pool",
      categoryKey: "software_tools",
      qualificationPolicy: { minimumCommitments: 2 },
      idempotencyKey,
    };
    const first = await harness.runtime.demandService.createDemandPool(
      ctx,
      input,
    );
    expect(first.created).toBe(true);
    const replay = await harness.runtime.demandService.createDemandPool(
      ctx,
      input,
    );
    expect(replay.created).toBe(false);
    expect(replay.pool.id).toBe(first.pool.id);

    const events = await harness.runtime.auditWriter.query({
      eventType: "demand_pool.created",
      resourceId: first.pool.id,
    });
    expect(events.length).toBe(1);
  });
});
