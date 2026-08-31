/**
 * NET-W024 AC-04 — Threshold/qualification rules are explicit,
 * versioned where policy is mutable, and cannot be caller-asserted
 * (issue #48 acceptance criterion 4).
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-04.
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
  type NetW024Harness,
} from "./_net-w024-harness.ts";
import {
  InvalidDemandError,
  DEMAND_POLICY_VERSION,
  DEMAND_PRIVACY_MINIMUM_COMMITMENTS,
  DEMAND_MIN_QUALIFICATION_COMMITMENTS,
  DEMAND_MAX_QUALIFICATION_COMMITMENTS,
} from "../../src/core/demand.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W024-AC-04 explicit, versioned, unassertable thresholds", () => {
  test("the qualification policy is explicit and versioned on the durable pool record", async () => {
    const pool = await createPool(harness, { minimumCommitments: 7 });
    expect(pool.policy).toEqual({
      version: DEMAND_POLICY_VERSION,
      minimumCommitments: 7,
    });
    // The derived view carries the policy snapshot (public policy —
    // not private commitment data).
    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac04-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view.policy).toEqual({
      version: DEMAND_POLICY_VERSION,
      minimumCommitments: 7,
    });
  });

  test("policy bounds fail closed at creation (0, negative, non-integer, above max)", async () => {
    const base = {
      organizationScopeId: harness.organizationScopeId,
      name: "AC-04 Bounds Pool",
      categoryKey: "utilities_energy",
    };
    for (const bad of [0, -1, 2.5, DEMAND_MAX_QUALIFICATION_COMMITMENTS + 1]) {
      await expect(
        harness.runtime.demandService.createDemandPool(
          consumerCtx(harness, "w024-ac04-bounds"),
          {
            ...base,
            qualificationPolicy: { minimumCommitments: bad },
            idempotencyKey: `w024-ac04-bounds-${String(bad)}`,
          },
        ),
      ).rejects.toBeInstanceOf(InvalidDemandError);
    }
    expect(DEMAND_MIN_QUALIFICATION_COMMITMENTS).toBe(1);
    expect(DEMAND_MAX_QUALIFICATION_COMMITMENTS).toBe(10000);
  });

  test("the privacy floor is a FROZEN constant no pool policy can lower or bypass", async () => {
    expect(DEMAND_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    // A pool whose policy threshold is 1 (the minimum) still cannot
    // disclose aggregates below the frozen floor.
    const pool = await createPool(harness, { minimumCommitments: 1 });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac04-low2"),
    });

    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac04-lowfloor"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    // The threshold check passes at count 2 ≥ 1, but the floor does
    // not — and the floor cannot be bypassed by the low threshold.
    const thresholdCheck = view.checks.find(
      (c) => c.check === "qualification_threshold_met",
    );
    expect(thresholdCheck?.satisfied).toBe(true);
    const floorCheck = view.checks.find((c) => c.check === "privacy_floor_met");
    expect(floorCheck?.satisfied).toBe(false);
    expect(view.aggregate).toBeNull();
    expect(view.qualified).toBe(false);
  });

  test("caller-asserted aggregates/qualification are IMPOSSIBLE: extra input fields are ignored and the derivation decides", async () => {
    const pool = await createPool(harness, { minimumCommitments: 5 });
    // Only ONE active commitment — far below the threshold.
    await createCommitment(harness, { poolId: pool.id });

    // A caller tries to smuggle aggregate facts and a qualification
    // assertion into the evaluation input. The command surface has NO
    // such fields: everything beyond scope/pool identity is ignored
    // and the derivation re-derives from authoritative records.
    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac04-smuggle"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        ...({
          commitmentCount: 9999,
          qualified: true,
          aggregate: { commitmentCount: 9999 },
          minimumCommitments: 0,
          privacyMinimum: 0,
        } as Record<string, unknown>),
      },
    );
    // The derivation's truth wins: 1 commitment < threshold 5 (and
    // below the floor). Nothing caller-asserted qualified.
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    expect(view.policy.minimumCommitments).toBe(5);
    const thresholdCheck = view.checks.find(
      (c) => c.check === "qualification_threshold_met",
    );
    expect(thresholdCheck?.satisfied).toBe(false);
  });

  test("qualification cannot be influenced by activity, spend, wealth or reputation: no such input exists", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    // Give the consumer a rich settlement/reputation-side history via
    // the W008 harness surface: credits, values... none of it can
    // reach the demand derivation.
    const view1 = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac04-noeco-1"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view1.qualified).toBe(false);
    // Even the consumer's OWN economic identity (a W008 subject)
    // changes nothing: the derivation input is the commitment set.
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac04-noeco-s"),
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(
        (
          await createPerson(harness, {
            displayName: "AC-04 Third Member",
            subjectId: "w024-ac04-third@example.com",
            member: true,
          })
        ).personId,
        "w024-ac04-third-commit",
      ),
    });
    const view2 = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac04-noeco-2"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view2.qualified).toBe(true);
    // The view carries ONLY demand facts: no spend, wealth, activity
    // or reputation vocabulary exists anywhere in the contract.
    const serialized = JSON.stringify(view2);
    for (const forbidden of [
      "spend",
      "wealth",
      "reputation",
      "activity",
      "credit",
      "ledger",
      "balance",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});
