/**
 * NET-W020-AC-01 — qualifying source contributions and
 * settlement-ready placements can enter a deterministic
 * cross-promotion clearing operation (issue #39 AC-1).
 *
 * The golden path: a VERIFIED contribution (the W014 qualification
 * bar) whose recognized value is MATURE, an ACTIVE campaign declaring
 * a clearing rule, and a settlement-ready placement bound to that
 * campaign — through the deterministic eligibility view and the
 * composition-root composite, drawing through each canonical
 * /settlement primitive (reward allocation / credit issuance / cash
 * obligation).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  evaluateClearingEligibility,
  operatorCtx,
  key,
  type NetW020Harness,
} from "./_net-w020-harness.ts";
import type { RewardAllocation } from "../../src/settlement/port.ts";

let harness: NetW020Harness;

beforeAll(async () => {
  harness = await createNetW020Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W020-AC-01 qualifying entries", () => {
  test("the golden path: VERIFIED contribution + settlement-ready placement enter the deterministic clearing (reward draw)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    // The deterministic eligibility view — every check satisfied.
    const eligibility = await evaluateClearingEligibility(harness, world);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.checks.map((c) => c.check).sort()).toEqual([
      "campaign_clearing_policy",
      "placement_campaign_bound",
      "placement_settlement_ready",
      "risk_dispute_gate",
      "source_contribution_qualified",
      "value_eligible",
    ]);
    expect(eligibility.checks.every((c) => c.satisfied)).toBe(true);
    expect(eligibility.resolvedRule).toMatchObject({
      id: "clear-1",
      basis: "attributed_outcome",
      drawKind: "reward_allocation",
    });
    // The composite: the draw through the canonical primitive.
    const result = await executeCrossPromotionClearing(harness, world);
    expect(result.drawKind).toBe("reward_allocation");
    expect(result.created).toBe(true);
    const allocation = result.allocation as unknown as RewardAllocation;
    expect(allocation.totalAllocated).toBe(100);
    expect(
      allocation.shares.reduce((sum, s) => sum + s.amount, 0),
    ).toBe(100);
    expect(allocation.sourceValueRecordId).toBe(world.value.id);
    // The clearing record binds BOTH canonical references.
    const clearing = result.clearing as Record<string, unknown>;
    expect(clearing.sourceContributionId).toBe(world.contribution.id);
    expect(clearing.targetPlacementId).toBe(world.placement.id);
    expect(clearing.campaignId).toBe(world.campaign.id);
    expect(clearing.valueRecordId).toBe(world.value.id);
    expect(clearing.drawKind).toBe("reward_allocation");
    expect(clearing.status).toBe("cleared");
    // The value record is consumed exactly once by the draw.
    const value = result.value as {
      state: string;
      consumedBy: { kind: string; id: string } | null;
    };
    expect(value.state).toBe("CONSUMED");
    expect(value.consumedBy).toEqual({
      kind: "reward_allocation",
      id: allocation.id,
    });
  });

  test("a credit-issuance rule draws Participation Credits through the canonical primitive", async () => {
    const {
      createVerifiedSettledContribution,
      recognizeContributionValue,
      matureValue,
      createCrossPromotionCampaign,
      registerInventoryItem,
      createPlacement,
    } = await import("./_net-w020-harness.ts");
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withProofOfValueBasis: true,
    });
    const recognized = await recognizeContributionValue(
      harness,
      contribution.id,
      { amount: 60 },
    );
    const value = await matureValue(harness, recognized.value.id);
    const campaign = await createCrossPromotionCampaign(harness, {
      clearingDrawKind: "credit_issuance",
      clearingBasis: "measured_value",
    });
    const item = await registerInventoryItem(harness.w019, {
      territories: ["US"],
      languages: ["en"],
    });
    const placement = await createPlacement(harness.w019, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
      territories: ["US"],
      languages: ["en"],
    });
    const result = await executeCrossPromotionClearing(harness, {
      contribution,
      placement,
      value,
    }, { creditsPerValueUnit: 2 });
    expect(result.drawKind).toBe("credit_issuance");
    const issuance = result.issuance as Record<string, unknown>;
    expect(issuance.creditAmount).toBe(120);
    expect(issuance.sourceValueRecordId).toBe(value.id);
    expect((result.clearing as Record<string, unknown>).drawKind).toBe(
      "credit_issuance",
    );
  });

  test("a cash-obligation rule books an internal payable (NO external payment execution)", async () => {
    const world = await createCrossPromotionWorld(harness, {
      amount: 80,
      clearingDrawKind: "cash_obligation",
    });
    const result = await executeCrossPromotionClearing(harness, world, {
      counterpartyPersonId: harness.operatorPersonId,
      cashAmount: 50,
    });
    expect(result.drawKind).toBe("cash_obligation");
    const obligation = result.obligation as Record<string, unknown>;
    expect(obligation.kind).toBe("payable");
    expect(obligation.amount).toBe(50);
    expect(obligation.status).toBe("recognized");
    // Cash draws never consume the value record.
    expect((result.value as { state: string }).state).toBe("MATURE");
    // The clearing record carries the cash lineage.
    const clearing = result.clearing as Record<string, unknown>;
    expect(clearing.drawKind).toBe("cash_obligation");
    expect(clearing.amount).toBe(50);
  });

  test("a NON-qualifying contribution (not VERIFIED) can never enter clearing — machine-readable reason", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    // A SECOND, non-verified contribution (created but NOT driven to
    // VERIFIED) — the eligibility view itself proves the bar.
    const w012 = harness.w012;
    const { createHelpfulnessPolicy, createHelpfulContribution } = await import(
      "../contributions/_net-w012-harness.ts"
    );
    const policy = await createHelpfulnessPolicy(w012);
    const { contribution } = await createHelpfulContribution(w012, {
      helpfulnessPolicyId: policy.policyId,
    });
    const eligibility = await evaluateClearingEligibility(harness, {
      contribution: { id: contribution.id },
      placement: { id: world.placement.id },
      value: { id: world.value.id },
    } as never);
    expect(eligibility.eligible).toBe(false);
    const failed = eligibility.checks.find(
      (c) => c.check === "source_contribution_qualified",
    );
    expect(failed?.satisfied).toBe(false);
    expect(failed?.reason).toBe("contribution_not_verified");
    // And the composite refuses with the same deterministic bar.
    await expect(
      executeCrossPromotionClearing(harness, {
        contribution: { id: contribution.id } as never,
        placement: world.placement,
        value: world.value,
      } as never),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
  });

  test("a settlement-NOT-ready placement can never enter clearing", async () => {
    // A placement whose supply violates the campaign eligibility
    // rules (region outside the rule's values) → readiness false.
    const world = await createCrossPromotionWorld(harness, {
      amount: 100,
      rules: [{ attribute: "region", operator: "in", values: ["GH"] }],
    });
    // The item's supply is US/CA — NOT eligible for a GH-only rule.
    expect(world.readiness.eligible).toBe(false);
    const eligibility = await evaluateClearingEligibility(harness, world);
    expect(eligibility.eligible).toBe(false);
    const failed = eligibility.checks.find(
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
});
