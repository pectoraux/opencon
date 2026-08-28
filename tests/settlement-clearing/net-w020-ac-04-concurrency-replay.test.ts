/**
 * NET-W020-AC-04 — concurrent same-clearing attempts cannot duplicate
 * value; same-key replay is deterministic (issue #39 AC-4;
 * invariant 5).
 *
 * The advisory pair mutex serializes the whole composite per
 * (contribution, placement) pair; the pre-flight pair check fails a
 * second DIFFERENT-key attempt BEFORE any economic mutation; the
 * in-tx create-once pair check is the durable backstop. Same-key
 * replays return the IDENTICAL committed result (draw id, clearing
 * id, amounts) with created:false.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  operatorCtx,
  key,
  type NetW020Harness,
} from "./_net-w020-harness.ts";

let harness: NetW020Harness;

beforeAll(async () => {
  harness = await createNetW020Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W020-AC-04 concurrency + replay determinism", () => {
  test("CONCURRENT same-pair attempts with DIFFERENT keys: exactly ONE wins, the other fails with the stable pair conflict — no duplicated value", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const settled = await Promise.allSettled([
      executeCrossPromotionClearing(harness, world, {
        idempotencyKey: key("w020-race-a"),
      }),
      executeCrossPromotionClearing(harness, world, {
        idempotencyKey: key("w020-race-b"),
      }),
    ]);
    const fulfilled = settled.filter(
      (s) => s.status === "fulfilled",
    ) as PromiseFulfilledResult<Record<string, unknown>>[];
    const rejected = settled.filter(
      (s) => s.status === "rejected",
    ) as PromiseRejectedResult[];
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0]!.reason as { code?: string }).code).toBe(
      "CLEARING_CONFLICT",
    );
    // EXACTLY ONE allocation + ONE clearing record for the pair.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-race-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(1);
    const clearings =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-race-clear"),
        harness.organizationScopeId,
      );
    expect(
      clearings.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(1);
  });

  test("CONCURRENT same-pair attempts with the SAME key: BOTH resolve to the IDENTICAL committed clearing (exactly-once)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 80 });
    const theKey = key("w020-same-key");
    const settled = await Promise.allSettled([
      executeCrossPromotionClearing(harness, world, {
        idempotencyKey: theKey,
      }),
      executeCrossPromotionClearing(harness, world, {
        idempotencyKey: theKey,
      }),
    ]);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const results = settled as PromiseFulfilledResult<Record<string, unknown>>[];
    const first = results[0]!.value as { clearing: { id: string }; allocation: { id: string } };
    const second = results[1]!.value as { clearing: { id: string }; allocation: { id: string } };
    expect(second.clearing.id).toBe(first.clearing.id);
    expect(second.allocation.id).toBe(first.allocation.id);
    // EXACTLY ONE allocation regardless of the two callers.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-same-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(1);
  });

  test("SEQUENTIAL same-key replay returns the IDENTICAL committed result with created:false", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 120 });
    const theKey = key("w020-replay");
    const first = await executeCrossPromotionClearing(harness, world, {
      idempotencyKey: theKey,
    });
    expect(first.created).toBe(true);
    const replay = await executeCrossPromotionClearing(harness, world, {
      idempotencyKey: theKey,
    });
    expect(replay.created).toBe(false);
    expect((replay.clearing as { id: string }).id).toBe(
      (first.clearing as { id: string }).id,
    );
    expect((replay.allocation as { id: string }).id).toBe(
      (first.allocation as { id: string }).id,
    );
    expect(
      (replay.allocation as { totalAllocated: number }).totalAllocated,
    ).toBe((first.allocation as { totalAllocated: number }).totalAllocated);
    // The campaign bookkeeping did not duplicate either.
    const campaignAfter = await harness.runtime.campaignService.getCampaign(
      operatorCtx(harness, "w020-replay-campaign"),
      world.campaign.id,
    );
    expect(
      campaignAfter.events.filter((e) => e.event === "clearing_executed")
        .length,
    ).toBe(1);
  });

  test("a replay AFTER a mid-chain failure converges with NO duplicated value (draw committed, record missing)", async () => {
    // Simulate the crash window: execute the DRAW step directly (the
    // composite's first economic mutation) WITHOUT the record step,
    // then run the FULL composite with the same key — it must replay
    // the identical allocation and commit the record (created:false
    // for the draw replay, ONE allocation total).
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const theKey = key("w020-crash");
    // The draw alone (exactly as the composite does).
    const drawn = await harness.runtime.rewardService.allocateRewards(
      operatorCtx(harness, "w020-crash-draw"),
      {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: world.value.id,
        policyId: world.campaign.currentPolicyVersion
          ? (await harness.runtime.campaignService.getPolicyVersion(
              operatorCtx(harness, "w020-crash-policy"),
              world.campaign.id,
              world.campaign.currentPolicyVersion,
            )).clearingRules[0]!.rewardPolicyId!
          : "",
        idempotencyKey: `${theKey}:draw`,
      },
    );
    expect(drawn.created).toBe(true);
    // The full composite with the SAME key: the draw replays (the
    // CONSUMED replay path), the record commits.
    const converged = await executeCrossPromotionClearing(harness, world, {
      idempotencyKey: theKey,
    });
    expect(converged.created).toBe(true);
    expect((converged.allocation as { id: string }).id).toBe(
      drawn.allocation.id,
    );
    // EXACTLY ONE allocation — the replay did NOT draw again.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-crash-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(1);
    // The clearing record exists exactly once.
    const clearings =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-crash-clear"),
        harness.organizationScopeId,
      );
    expect(
      clearings.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(1);
  });
});
