/**
 * NET-W024 AC-02 — Pool membership and qualification are
 * deterministically derived from current authoritative records
 * (issue #48 acceptance criterion 2).
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-02.
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
import { deriveQualifiedDemandAggregate } from "../../src/demand/aggregation-engine.ts";
import type { DemandCommitment, DemandPool } from "../../src/demand/port.ts";
import { DEMAND_CONSENT_SCOPE } from "../../src/core/demand.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** A synthetic commitment fixture for the PURE engine tests. */
function fixtureCommitment(
  index: number,
  overrides: Partial<DemandCommitment> = {},
): DemandCommitment {
  return {
    id: `fixture-commitment-${String(index)}`,
    organizationScopeId: "fixture-org",
    poolId: "fixture-pool",
    consumerPersonId: `fixture-person-${String(index)}`,
    categoryKey: "utilities_energy",
    categoryVersion: "1",
    attributes: {
      region: "NA_EAST",
      quantity: 12,
      budgetBand: null,
    },
    consent: {
      scope: DEMAND_CONSENT_SCOPE,
      version: "NET-W024:1",
      grantedAt: "2026-01-01T00:00:00.000Z",
      grantedBy: `fixture-person-${String(index)}`,
    },
    withdrawnAt: null,
    withdrawalReason: null,
    recordFormat: "NET-W024:1",
    createdAt: `2026-01-0${String((index % 9) + 1)}T00:00:00.000Z`,
    updatedAt: `2026-01-0${String((index % 9) + 1)}T00:00:00.000Z`,
    idempotencyKey: `fixture-key-${String(index)}`,
    executionId: `fixture-exec-${String(index)}`,
    correlationId: "fixture-corr",
    causationId: null,
    ...overrides,
  };
}

/** A synthetic pool fixture for the PURE engine tests. */
function fixturePool(
  overrides: Partial<DemandPool> = {},
): DemandPool {
  return {
    id: "fixture-pool",
    organizationScopeId: "fixture-org",
    createdBy: "fixture-creator",
    name: "Fixture Pool",
    categoryKey: "utilities_energy",
    categoryVersion: "1",
    policy: { version: 1, minimumCommitments: 3 },
    closedAt: null,
    closureReason: null,
    recordFormat: "NET-W024:1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: "fixture-pool-key",
    executionId: "fixture-pool-exec",
    correlationId: "fixture-pool-corr",
    causationId: null,
    ...overrides,
  };
}

describe("NET-W024-AC-02 deterministic qualification derivation", () => {
  test("identical commitment state yields the identical digest across evaluations (anchor excluded)", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    const memberA = await createPerson(harness, {
      displayName: "AC-02 Member A",
      subjectId: "w024-ac02-a@example.com",
      member: true,
    });
    await createCommitment(harness, { poolId: pool.id, quantity: 37 });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(memberA.personId, "w024-ac02-commit-a"),
      quantity: 41,
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac02-commit-supplier"),
      quantity: 53,
    });

    const ctx = supplierCtx(harness, "w024-ac02-eval-1");
    const first = await harness.runtime.demandService.evaluateQualifiedDemand(
      ctx,
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    const second = await harness.runtime.demandService.evaluateQualifiedDemand(
      ctx,
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(first.qualified).toBe(true);
    expect(first.aggregate).not.toBeNull();
    expect(first.aggregate?.commitmentCount).toBe(3);
    // REPRODUCIBILITY: identical state ⇒ identical digest (the
    // anchor differs between the two evaluations but is excluded).
    expect(first.digest).toBe(second.digest);
    expect(second.evaluatedAt >= first.evaluatedAt).toBe(true);
    // The anchor is recorded on every view.
    expect(first.evaluatedAt).toBeTruthy();
  });

  test("PURE ENGINE: commitment input order does not affect the derivation", () => {
    const a = [
      fixtureCommitment(1),
      fixtureCommitment(2, { attributes: { region: "EU_NORTH", quantity: 30, budgetBand: null } }),
      fixtureCommitment(3, { attributes: { region: "EU_NORTH", quantity: 99, budgetBand: "band_c_200_499" } }),
      fixtureCommitment(4, { attributes: { region: "NA_EAST", quantity: 400, budgetBand: "band_b_50_199" } }),
    ];
    const pool = fixturePool();
    const forward = deriveQualifiedDemandAggregate({
      pool,
      commitments: a,
      requestorMembership: "active",
      evaluatedAt: "2026-02-01T00:00:00.000Z",
    });
    const shuffled = deriveQualifiedDemandAggregate({
      pool,
      commitments: [a[2]!, a[0]!, a[3]!, a[1]!],
      requestorMembership: "active",
      evaluatedAt: "2026-03-01T12:00:00.000Z",
    });
    expect(shuffled.digest).toBe(forward.digest);
    expect(shuffled.qualified).toBe(forward.qualified);
    expect(shuffled.aggregate).toEqual(forward.aggregate);
  });

  test("PURE ENGINE: any governing-fact change changes the digest", () => {
    const pool = fixturePool();
    const base = deriveQualifiedDemandAggregate({
      pool,
      commitments: [
        fixtureCommitment(1),
        fixtureCommitment(2),
        fixtureCommitment(3),
      ],
      requestorMembership: "active",
      evaluatedAt: "2026-02-01T00:00:00.000Z",
    });
    // A different commitment multiset.
    const changedSet = deriveQualifiedDemandAggregate({
      pool,
      commitments: [
        fixtureCommitment(1),
        fixtureCommitment(2),
        fixtureCommitment(3),
        fixtureCommitment(4),
      ],
      requestorMembership: "active",
      evaluatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(changedSet.digest).not.toBe(base.digest);
    // A different policy threshold.
    const changedPolicy = deriveQualifiedDemandAggregate({
      pool: fixturePool({ policy: { version: 1, minimumCommitments: 4 } }),
      commitments: [
        fixtureCommitment(1),
        fixtureCommitment(2),
        fixtureCommitment(3),
      ],
      requestorMembership: "active",
      evaluatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(changedPolicy.digest).not.toBe(base.digest);
    // A closed pool.
    const closedPool = deriveQualifiedDemandAggregate({
      pool: fixturePool({ closedAt: "2026-02-02T00:00:00.000Z" }),
      commitments: [
        fixtureCommitment(1),
        fixtureCommitment(2),
        fixtureCommitment(3),
      ],
      requestorMembership: "active",
      evaluatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(closedPool.digest).not.toBe(base.digest);
    expect(closedPool.qualified).toBe(false);
  });

  test("withdrawn commitments are excluded from the derivation immediately", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    await createCommitment(harness, { poolId: pool.id, quantity: 37 });
    const supplierCommitment = await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac02-supplier-commit"),
      quantity: 41,
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(
        (await createPerson(harness, {
          displayName: "AC-02 Member B",
          subjectId: "w024-ac02-b@example.com",
          member: true,
        })).personId,
        "w024-ac02-commit-b",
      ),
      quantity: 53,
    });

    const before = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-eval-before"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(before.aggregate?.commitmentCount).toBe(3);

    // The consumer-side consent revocation: withdrawal.
    await harness.runtime.demandService.withdrawDemandCommitment(
      supplierCtx(harness, "w024-ac02-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: supplierCommitment.id,
        idempotencyKey: key("w024-withdraw"),
      },
    );

    const after = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-eval-after"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    // 2 active commitments: still above the pool threshold (2) but
    // BELOW the frozen privacy floor (3) → no aggregate facts at all.
    expect(after.qualified).toBe(false);
    expect(after.aggregate).toBeNull();
    const floorCheck = after.checks.find(
      (c) => c.check === "privacy_floor_met",
    );
    expect(floorCheck?.satisfied).toBe(false);
    // The digest changed (the governing facts changed).
    expect(after.digest).not.toBe(before.digest);
  });

  test("a closed pool never qualifies (pool_open check) and accepts no new commitments", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac02-close-commit"),
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(
        (await createPerson(harness, {
          displayName: "AC-02 Close Member",
          subjectId: "w024-ac02-close@example.com",
          member: true,
        })).personId,
        "w024-ac02-close-commit-3",
      ),
    });

    const open = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-eval-open"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(open.qualified).toBe(true);

    await harness.runtime.demandService.closeDemandPool(
      consumerCtx(harness, "w024-ac02-close"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "ac-02 closed",
        idempotencyKey: key("w024-close"),
      },
    );

    const closed = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-eval-closed"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(closed.qualified).toBe(false);
    const openCheck = closed.checks.find((c) => c.check === "pool_open");
    expect(openCheck?.satisfied).toBe(false);
    // A closed pool still discloses its (frozen) aggregate above the
    // floor — the historical view — but never qualifies.
    expect(closed.aggregate?.commitmentCount).toBe(3);

    // No new commitments into a closed pool (fail closed).
    const third = await createPerson(harness, {
      displayName: "AC-02 Late Member",
      subjectId: "w024-ac02-late@example.com",
      member: true,
    });
    await expect(
      createCommitment(harness, {
        poolId: pool.id,
        ctx: personCtx(third.personId, "w024-ac02-late-commit"),
      }),
    ).rejects.toThrow();
  });

  test("threshold boundary: qualification flips exactly at the policy threshold", async () => {
    // Threshold 3: two commitments → NOT qualified; three → qualified.
    const pool = await createPool(harness, { minimumCommitments: 3 });
    const m1 = await createPerson(harness, {
      displayName: "AC-02 T1",
      subjectId: "w024-ac02-t1@example.com",
      member: true,
    });
    const m2 = await createPerson(harness, {
      displayName: "AC-02 T2",
      subjectId: "w024-ac02-t2@example.com",
      member: true,
    });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(m1.personId, "w024-ac02-t1-commit"),
    });

    const below = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-t-below"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(below.qualified).toBe(false);
    const thresholdCheck = below.checks.find(
      (c) => c.check === "qualification_threshold_met",
    );
    expect(thresholdCheck?.satisfied).toBe(false);

    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(m2.personId, "w024-ac02-t2-commit"),
    });
    const at = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-t-at"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(at.qualified).toBe(true);
    const atCheck = at.checks.find(
      (c) => c.check === "qualification_threshold_met",
    );
    expect(atCheck?.satisfied).toBe(true);
  });

  test("every check is present, machine-readable and re-derived; the view is frozen", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac02-frozen-commit"),
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(
        (await createPerson(harness, {
          displayName: "AC-02 Frozen Member",
          subjectId: "w024-ac02-frozen@example.com",
          member: true,
        })).personId,
        "w024-ac02-frozen-commit-3",
      ),
    });
    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac02-frozen"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view.checks.map((c) => c.check)).toEqual([
      "pool_open",
      "requestor_membership",
      "commitments_present",
      "privacy_floor_met",
      "qualification_threshold_met",
    ]);
    expect(view.qualified).toBe(true);
    // Frozen derivation output (Object.freeze discipline).
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.checks)).toBe(true);
    // Nothing derived is stored: no pool or commitment record carries
    // qualification/aggregate state.
    const durablePool = await harness.runtime.demandService.getDemandPool(
      consumerCtx(harness, "w024-ac02-durable"),
      harness.organizationScopeId,
      pool.id,
    );
    const serialized = JSON.stringify(durablePool);
    expect(serialized).not.toContain("qualified");
    expect(serialized).not.toContain("aggregate");
    expect(serialized).not.toContain("digest");
  });
});
