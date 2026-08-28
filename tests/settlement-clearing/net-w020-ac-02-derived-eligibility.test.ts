/**
 * NET-W020-AC-02 — clearing eligibility is re-derived from CURRENT
 * authoritative records and cannot be caller-asserted (issue #39
 * AC-2; invariant 1).
 *
 * Every state change in an OWNING authority flips the derived view on
 * the NEXT read (a paused campaign blocks; resume re-opens; a retired
 * placement / withdrawn supply blocks), and the AUTHORITATIVE record
 * command re-derives the same bar in-transaction — there is no input
 * anywhere that can assert, store or waive eligibility.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  evaluateClearingEligibility,
  operatorCtx,
  creatorCtx,
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

describe("NET-W020-AC-02 derived eligibility (re-derived from current records)", () => {
  test("a PAUSED campaign blocks eligibility; RESUME re-opens it (re-derived on every read)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const before = await evaluateClearingEligibility(harness, world);
    expect(before.eligible).toBe(true);

    await harness.runtime.campaignService.pauseCampaign(
      operatorCtx(harness, "w020-pause"),
      {
        campaignId: world.campaign.id,
        reason: "fixture pause",
        idempotencyKey: key("w020-pause"),
      },
    );
    const paused = await evaluateClearingEligibility(harness, world);
    expect(paused.eligible).toBe(false);
    const failed = paused.checks.find(
      (c) => c.check === "campaign_clearing_policy",
    );
    expect(failed?.satisfied).toBe(false);
    expect(failed?.reason).toBe("campaign_not_active");
    // The composite refuses while paused.
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
      context: expect.objectContaining({
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            check: "campaign_clearing_policy",
            reason: "campaign_not_active",
          }),
        ]),
      }),
    });

    await harness.runtime.campaignService.resumeCampaign(
      operatorCtx(harness, "w020-resume"),
      {
        campaignId: world.campaign.id,
        reason: "fixture resume",
        idempotencyKey: key("w020-resume"),
      },
    );
    const resumed = await evaluateClearingEligibility(harness, world);
    expect(resumed.eligible).toBe(true);
    // And the clearing succeeds after resume.
    const result = await executeCrossPromotionClearing(harness, world);
    expect(result.created).toBe(true);
  });

  test("a RETIRED placement blocks eligibility (the W019 derived gate, consumed live)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    expect(
      (await evaluateClearingEligibility(harness, world)).eligible,
    ).toBe(true);
    await harness.runtime.inventoryService.retirePlacement(
      creatorCtx(harness, "w020-retire-placement"),
      {
        organizationScopeId: harness.organizationScopeId,
        placementId: world.placement.id,
        reason: "fixture retirement",
        idempotencyKey: key("w020-retire-placement"),
      },
    );
    const after = await evaluateClearingEligibility(harness, world);
    expect(after.eligible).toBe(false);
    const failed = after.checks.find(
      (c) => c.check === "placement_settlement_ready",
    );
    expect(failed?.satisfied).toBe(false);
    expect(failed?.reason).toBe("placement_not_ready");
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
  });

  test("WITHDRAWN supply (a retired inventory item) blocks eligibility", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    expect(
      (await evaluateClearingEligibility(harness, world)).eligible,
    ).toBe(true);
    await harness.runtime.inventoryService.retireInventoryItem(
      creatorCtx(harness, "w020-retire-item"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: world.item.id,
        reason: "fixture withdrawal",
        idempotencyKey: key("w020-retire-item"),
      },
    );
    const after = await evaluateClearingEligibility(harness, world);
    expect(after.eligible).toBe(false);
    expect(
      after.checks.find((c) => c.check === "placement_settlement_ready")
        ?.reason,
    ).toBe("placement_not_ready");
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
  });

  test("the AUTHORITATIVE record command re-derives eligibility IN-TX (a stale pre-flight cannot slip a record through)", async () => {
    // A world where eligibility holds — then the placement is retired
    // BEFORE the record command runs (simulating a stale pre-flight:
    // the draw has NOT happened, so we invoke the record command
    // directly with a fabricated draw reference; the in-tx
    // re-derivation must refuse).
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    await harness.runtime.inventoryService.retirePlacement(
      creatorCtx(harness, "w020-retire-2"),
      {
        organizationScopeId: harness.organizationScopeId,
        placementId: world.placement.id,
        reason: "fixture retirement before record",
        idempotencyKey: key("w020-retire-2"),
      },
    );
    await expect(
      harness.runtime.crossPromotionClearingService.recordCrossPromotionClearing(
        operatorCtx(harness, "w020-record-refused"),
        {
          organizationScopeId: harness.organizationScopeId,
          sourceContributionId: world.contribution.id,
          targetPlacementId: world.placement.id,
          valueRecordId: world.value.id,
          clearingRuleId: "clear-1",
          drawKind: "reward_allocation",
          drawResultId: "00000000-0000-0000-0000-000000000000",
          idempotencyKey: key("w020-record-refused"),
        },
      ),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
    // NOTHING was recorded (the fail-closed read).
    const listed =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-record-list"),
        harness.organizationScopeId,
      );
    expect(
      listed.filter((c) => c.sourceContributionId === world.contribution.id)
        .length,
    ).toBe(0);
  });

  test("NO caller-asserted eligibility input exists anywhere in the surface (structural pin)", async () => {
    // The composite + record + view inputs carry ONLY references —
    // there is no eligibility/ready/assert/waive field on any input.
    const { readFile } = await import("node:fs/promises");
    const port = await readFile("src/settlement/port.ts", "utf8");
    const recordInputRegion = port.slice(
      port.indexOf("RecordCrossPromotionClearingInput"),
      port.indexOf("RecordCrossPromotionClearingResult"),
    );
    expect(recordInputRegion).not.toMatch(/eligib|ready|assert|waive/i);
    const viewInputRegion = port.slice(
      port.indexOf("EvaluateCrossPromotionClearingInput"),
      port.indexOf("CrossPromotionClearingRepository"),
    );
    expect(viewInputRegion).not.toMatch(/eligib|ready|assert|waive/i);
  });
});
