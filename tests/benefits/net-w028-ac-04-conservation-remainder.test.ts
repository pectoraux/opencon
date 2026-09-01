/**
 * NET-W028 AC-04 — Conservation and deterministic remainder handling:
 * no allocation exceeds the authoritative funding envelope; the
 * scaled-integer arithmetic never drifts; remainders are explicit
 * and conserved (last_member_absorbs: Σ === source EXACTLY;
 * retained_in_pool: the remainder stays inside the pool's available
 * envelope — never lost) (issue #56 key invariant 3).
 *
 * Work order: spec/work-orders/NET-W028.md §3.5 / §6 AC-04.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW028Harness,
  createBenefitPolicy,
  createBenefitPool,
  seedValueFundedPool,
  seedSavingsFundedPool,
  allocateBenefits,
  evaluateAllocation,
  key,
  type NetW028Harness,
} from "./_net-w028-harness.ts";
import { computeBenefitAllocationPlan } from "../../src/benefits/allocation-engine.ts";
import { assertGlobalConservation } from "../../src/settlement/ledger.ts";
import type { EconomicLedgerEntry } from "../../src/settlement/port.ts";

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W028-AC-04 conservation and deterministic remainder handling", () => {
  test("last_member_absorbs: Σ shares === source EXACTLY for awkward amounts (no dust, no drift)", async () => {
    // 33.333333 value split 3/2/1: floor division leaves a remainder
    // the LAST share absorbs (the settlement semantics).
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac04-awkward",
      amount: 33.333333,
    });
    const result = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
    });
    const total = result.allocation.shares.reduce((sum, s) => sum + s.amount, 0);
    // EXACT conservation in scaled-integer minor units (the sum
    // never drifts — floating-point representation noise is removed
    // deterministically by the same Math.round discipline the
    // settlement engine uses).
    const scaledTotal = result.allocation.shares.reduce(
      (sum, s) => sum + Math.round(s.amount * 1_000_000),
      0,
    );
    expect(scaledTotal).toBe(Math.round(33.333333 * 1_000_000));
    expect(total).toBeCloseTo(33.333333, 9);
    expect(result.allocation.totalAllocated).toBeCloseTo(33.333333, 9);
    expect(result.allocation.remainderAmount).toBe(0);
  });

  test("retained_in_pool: the remainder is EXPLICIT and stays available (conserved, never lost)", async () => {
    // A savings-funded pool with a 200 usd envelope; allocate 10
    // across 3/2/1 members → floored shares + an explicit remainder
    // that REMAINS in the envelope for the next allocation.
    const scenario = await seedSavingsFundedPool(harness, {
      policyId: "ac04-retained",
    });
    const first = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      amount: 10,
    });
    // Floored shares at 6-decimal MINOR-UNIT precision (the
    // ECONOMIC_SCALE discipline — the floor is per-share, never a
    // whole-unit round): p1 = 10 × 3/6 = 5, p2 = floor(10 × 2/6) =
    // 3.333333, p3 = floor(10 × 1/6) = 1.666666 → Σ = 9.999999;
    // remainder = 0.000001 EXPLICIT (never lost to rounding).
    expect(first.allocation.shares.map((s) => s.amount)).toEqual([
      5, 3.333333, 1.666666,
    ]);
    expect(first.allocation.totalAllocated).toBe(9.999999);
    expect(first.allocation.remainderAmount).toBe(0.000001);
    expect(first.allocation.remainderDisposition).toBe("retained_in_pool");
    // Σ shares + remainder === 10 EXACTLY at scaled-integer
    // precision (the conservation proof).
    const conservedScaled =
      first.allocation.shares.reduce(
        (sum, s) => sum + Math.round(s.amount * 1_000_000),
        0,
      ) + Math.round(first.allocation.remainderAmount * 1_000_000);
    expect(conservedScaled).toBe(10_000_000);
    // The envelope still holds 190.000001 for future allocations
    // (200 − 9.999999; the conserved remainder stays inside it).
    const view = await evaluateAllocation(harness, {
      poolId: scenario.pool.id,
    });
    expect(view.availableFunding).toBe(200);
    expect(view.priorAllocatedTotal).toBe(9.999999);
    expect(
      Math.round(
        (view.availableFunding - view.priorAllocatedTotal) * 1_000_000,
      ),
    ).toBe(190_000_001);
    // A second allocation CAN use the remaining envelope (incl. the
    // conserved remainder).
    const second = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      amount: 1,
      idempotencyKey: key("ac04-second"),
    });
    expect(second.allocation.totalAllocated).toBe(0.999999);
    expect(second.allocation.remainderAmount).toBe(0.000001);
    // The envelope after two allocations: 200 − 9.999999 − 0.999999
    // = 189.000002 (prior + this allocation consumed from the
    // envelope; both remainders conserved inside it).
    const remainingScaled =
      Math.round(view.availableFunding * 1_000_000) -
      Math.round(second.allocation.priorAllocatedTotal * 1_000_000) -
      Math.round(second.allocation.totalAllocated * 1_000_000);
    expect(remainingScaled).toBe(189_000_002);
  });

  test("no allocation can exceed the authoritative funding envelope (conservation rejects the mutation)", async () => {
    const scenario = await seedSavingsFundedPool(harness, {
      policyId: "ac04-overdraft",
    });
    // 200 available; requesting 201 fails closed.
    await expect(
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        amount: 201,
      }),
    ).rejects.toThrow(/exceed the authoritative funding envelope/i);
    // No allocation record was created.
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac04-overdraft"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      },
    );
    expect(allocations).toHaveLength(0);
    // Exhaust the envelope, then a further allocation fails closed.
    await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      amount: 200,
    });
    await expect(
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        amount: 1,
        idempotencyKey: key("ac04-exhausted"),
      }),
    ).rejects.toThrow(/exceed the authoritative funding envelope/i);
  });

  test("a zero-remainder plan is impossible for retained disposition when the amount divides evenly (Σ floor === amount)", () => {
    // 12 across 3/2/1: floors are 6/4/2 → Σ = 12 → remainder 0 (the
    // arithmetic degenerates gracefully — no artificial remainder).
    const plan = computeBenefitAllocationPlan(
      12,
      [
        { personId: "p1", weight: 3 },
        { personId: "p2", weight: 2 },
        { personId: "p3", weight: 1 },
      ],
      "retained_in_pool",
    );
    expect(plan.shares.map((s) => s.amount)).toEqual([6, 4, 2]);
    expect(plan.remainderAmount).toBe(0);
    expect(plan.totalAllocated).toBe(12);
  });

  test("a plan that would starve a member to a non-positive share fails closed", () => {
    // A tiny amount across wide weights: one member's floored share
    // would be 0 → rejected (conservation with honest shares).
    expect(() =>
      computeBenefitAllocationPlan(
        0.000001,
        [
          { personId: "p1", weight: 3 },
          { personId: "p2", weight: 2 },
          { personId: "p3", weight: 1 },
        ],
        "last_member_absorbs",
      ),
    ).toThrow(/non-positive share/i);
  });

  test("the value-funded draw consumes the record exactly-once and the ledger stays conserved", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac04-draw",
    });
    await allocateBenefits(harness, { poolId: scenario.pool.id });
    const after = await harness.runtime.economicValueService.getValue(
      harness.poolCreatorCtx("ac04-draw"),
      scenario.value.id,
    );
    expect(after.state).toBe("CONSUMED");
    // The draw's transaction is globally balanced (the settlement
    // posting layer guarantees it; the proof replays the invariant).
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac04-draw"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      },
    );
    const reward = await harness.runtime.rewardService.getAllocation(
      harness.poolCreatorCtx("ac04-draw"),
      allocations[0]!.draw!.resultId,
    );
    const transaction = await harness.runtime.economicLedgerService.getTransaction(
      harness.poolCreatorCtx("ac04-draw"),
      reward.transactionId,
    );
    expect(transaction.entries.length).toBeGreaterThan(0);
    // Per-unit balance (the posting layer validated it at write
    // time; the proof re-asserts the invariant).
    expect(() => assertGlobalConservation(transaction.entries)).not.toThrow();
    // Σ shares === the value record amount EXACTLY at scaled-integer
    // precision (the float display sum can carry representation
    // noise; the settlement engine's minor-unit arithmetic never
    // drifts — the net-w008-ac-05 precedent).
    const scaledTotal = reward.shares.reduce(
      (sum, s) => sum + Math.round(s.amount * 1_000_000),
      0,
    );
    expect(scaledTotal).toBe(100_000_000);
    const total = reward.shares.reduce((sum, s) => sum + s.amount, 0);
    expect(total).toBeCloseTo(100, 9);
  });
});
