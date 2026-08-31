/**
 * NET-W020-AC-05 — cross-tenant and stale/withdrawn/retired/
 * ineligible inventory contexts FAIL CLOSED (issue #39 AC-5;
 * invariant 6).
 *
 * The value record anchors the tenant scope; every other reference
 * must resolve same-scope. Cross-scope placements/contributions/
 * campaigns resolve to null → failed checks; cross-scope value records
 * are NotFound; a placement bound to a DIFFERENT campaign is a
 * mismatch; a value amount over the rule cap fails closed.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  evaluateClearingEligibility,
  createCrossPromotionCampaign,
  registerInventoryItem,
  createPlacement,
  operatorCtx,
  creatorCtx,
  key,
  personCtx,
  type NetW020Harness,
} from "./_net-w020-harness.ts";

let harness: NetW020Harness;

beforeAll(async () => {
  harness = await createNetW020Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W020-AC-05 fail-closed contexts", () => {
  test("a CROSS-TENANT placement (second org) never resolves in the clearing scope — no existence oracle", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    // Register supply + a placement in the SECOND ORG (its own
    // campaign + policy, via the inventory service directly so the
    // records genuinely live in the second tenant).
    const ctx2 = personCtx(harness, harness.secondOrgPersonId, "w020-xorg");
    const { campaign: secondCampaign } =
      await harness.runtime.campaignService.createCampaign(ctx2, {
        organizationScopeId: harness.secondOrgId,
        name: "W020 second-org campaign",
        description: "cross-tenant fixture",
        idempotencyKey: key("w020-xorg-campaign"),
      });
    await harness.runtime.campaignService.defineCampaignPolicy(ctx2, {
      campaignId: secondCampaign.id,
      policy: {
        objectives: [
          {
            id: "obj-1",
            kind: "awareness",
            description: "xorg objective",
            successCriteria: null,
          },
        ],
        eligibility: { rules: [] },
        outcomePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              outcomeType: "view",
              attributionMode: "deterministic",
              windowDays: 30,
              requiresExperiment: false,
            },
          ],
        },
        evidencePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              requirementKind: "proof_of_value",
              minimumGrade: "ATTESTED",
              qualifyingSourceTypes: ["platform"],
            },
          ],
        },
        budget: { unit: "credits", totalAmount: 0, perObjective: [] },
        attributionRules: [],
        clearingRules: [],
        opportunitySpecs: [],
      },
      idempotencyKey: key("w020-xorg-policy"),
    });
    const secondItem =
      await harness.runtime.inventoryService.registerInventoryItem(ctx2, {
        organizationScopeId: harness.secondOrgId,
        surfaceKind: "publisher",
        format: "display",
        externalReference: null,
        attributes: { territories: ["US"], languages: ["en"] },
        description: "second-org supply",
        idempotencyKey: key("w020-xorg-item"),
      });
    const secondPlacement = await harness.runtime.inventoryService.createPlacement(
      ctx2,
      {
        organizationScopeId: harness.secondOrgId,
        inventoryItemId: secondItem.item.id,
        campaignId: secondCampaign.id,
        context: { territories: ["US"], languages: ["en"] },
        idempotencyKey: key("w020-xorg-placement"),
      },
    );
    expect(secondPlacement.placement.organizationScopeId).toBe(
      harness.secondOrgId,
    );
    // The FIRST org's clearing referencing the second-org placement:
    // the lookup resolves null (fail-closed; no existence oracle).
    const eligibility = await evaluateClearingEligibility(harness, {
      contribution: world.contribution,
      placement: { id: secondPlacement.placement.id } as never,
      value: world.value,
    } as never);
    expect(eligibility.eligible).toBe(false);
    const failed = eligibility.checks.find(
      (c) => c.check === "placement_settlement_ready",
    );
    expect(failed?.satisfied).toBe(false);
    expect(failed?.reason).toBe("placement_not_ready");
    // The composite refuses identically.
    await expect(
      executeCrossPromotionClearing(harness, {
        contribution: world.contribution,
        placement: secondPlacement.placement,
        value: world.value,
      } as never),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
  });

  test("a CROSS-TENANT value record is NotFound for the other tenant's eligibility view (the scope anchor fails closed)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    await expect(
      harness.runtime.apiCommands.evaluateCrossPromotionClearing(
        personCtx(harness, harness.secondOrgPersonId, "w020-cross-value"),
        {
          organizationScopeId: harness.secondOrgId,
          sourceContributionId: world.contribution.id,
          targetPlacementId: world.placement.id,
          valueRecordId: world.value.id,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("the clearing campaign is bound by the PLACEMENT (a rules-less campaign fails closed) + the pure evaluator's mismatch branch", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    // A placement bound to a campaign WITHOUT clearing rules: the
    // derived campaign context is the PLACEMENT's campaign (never a
    // caller choice) → clearing_rule_not_resolved.
    const { campaignWithRules, campaignWithoutRules } = {
      campaignWithRules: world.campaign,
      campaignWithoutRules: await (async () => {
        const ctx = operatorCtx(harness, "w020-rulesless");
        const { campaign } =
          await harness.runtime.campaignService.createCampaign(ctx, {
            organizationScopeId: harness.organizationScopeId,
            name: "W020 rules-less campaign",
            description: "mismatch fixture",
            idempotencyKey: key("w020-rulesless"),
          });
        await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
          campaignId: campaign.id,
          policy: {
            objectives: [
              {
                id: "obj-1",
                kind: "awareness",
                description: "mismatch objective",
                successCriteria: null,
              },
            ],
            eligibility: { rules: [] },
            outcomePolicy: {
              requirements: [
                {
                  objectiveId: "obj-1",
                  outcomeType: "view",
                  attributionMode: "deterministic",
                  windowDays: 30,
                  requiresExperiment: false,
                },
              ],
            },
            evidencePolicy: {
              requirements: [
                {
                  objectiveId: "obj-1",
                  requirementKind: "proof_of_value",
                  minimumGrade: "ATTESTED",
                  qualifyingSourceTypes: ["platform"],
                },
              ],
            },
            budget: { unit: "credits", totalAmount: 0, perObjective: [] },
            attributionRules: [],
            clearingRules: [],
            opportunitySpecs: [
              {
                id: "spec-1",
                title: "Rules-less fixture opportunity",
                opportunityType: "campaign_contribution",
                brief: { neutral: true },
                contributionRequirements: { deliverables: 1 },
                evidenceReferencePlaceholders: [],
              },
            ],
          },
          idempotencyKey: key("w020-rulesless-policy"),
        });
        return harness.runtime.campaignService.activateCampaign(ctx, {
          campaignId: campaign.id,
          idempotencyKey: key("w020-rulesless-activate"),
        });
      })(),
    };
    void campaignWithRules;
    const item = await registerInventoryItem(harness.w019, {
      territories: ["US"],
      languages: ["en"],
    });
    const otherPlacement = await createPlacement(harness.w019, {
      inventoryItemId: item.id,
      campaignId: campaignWithoutRules.id,
      territories: ["US"],
      languages: ["en"],
    });
    const eligibility = await evaluateClearingEligibility(harness, {
      contribution: world.contribution,
      placement: otherPlacement,
      value: world.value,
    } as never);
    expect(eligibility.eligible).toBe(false);
    expect(
      eligibility.checks.find((c) => c.check === "campaign_clearing_policy")
        ?.reason,
    ).toBe("clearing_rule_not_resolved");

    // The PURE evaluator's placement_campaign_mismatch branch: a
    // placement view bound to campaign X evaluated against campaign
    // view Y (scope-consistent but different ids) fails closed.
    const { evaluateCrossPromotionClearing: pureEvaluate } = await import(
      "../../src/settlement/clearing-eligibility.ts"
    );
    const pure = pureEvaluate({
      organizationScopeId: harness.organizationScopeId,
      sourceContributionId: "c-1",
      targetPlacementId: "p-1",
      valueRecordId: "v-1",
      requestedRuleId: null,
      contribution: {
        contributionId: "c-1",
        organizationScopeId: harness.organizationScopeId,
        lifecycleState: "VERIFIED",
        contributorPersonId: harness.creatorPersonId,
        proofOfHelpfulnessState: "QUALIFIED",
        moderationStatus: "APPROVED",
        qualityBand: null,
      },
      placement: {
        placementId: "p-1",
        organizationScopeId: harness.organizationScopeId,
        campaignId: "campaign-x",
        campaignPolicyVersion: 1,
        ownerPersonId: harness.creatorPersonId,
        settlementReady: true,
      },
      campaign: {
        campaignId: "campaign-y",
        organizationScopeId: harness.organizationScopeId,
        administrativeStatus: "ACTIVE",
        currentPolicyVersion: 1,
        clearingRules: [
          {
            id: "clear-1",
            objectiveId: "obj-1",
            basis: "attributed_outcome",
            drawKind: "reward_allocation",
            rewardPolicyId: "rp-1",
            maxDrawAmount: 100,
          },
        ],
      },
      value: {
        valueRecordId: "v-1",
        organizationScopeId: harness.organizationScopeId,
        state: "MATURE",
        amount: 10,
        beneficiaryPersonId: harness.creatorPersonId,
        sources: [{ kind: "contribution", id: "c-1" }],
      },
      gate: { clear: true, source: null, controlId: null, disputeId: null, detail: {} },
    });
    expect(pure.eligible).toBe(false);
    expect(
      pure.checks.find((c) => c.check === "placement_campaign_bound")
        ?.reason,
    ).toBe("placement_campaign_mismatch");
  });

  test("a value amount OVER the rule cap fails closed (amount_exceeds_cap)", async () => {
    const world = await createCrossPromotionWorld(harness, {
      amount: 500,
      clearingMaxDrawAmount: 200,
    });
    const eligibility = await evaluateClearingEligibility(harness, world);
    expect(eligibility.eligible).toBe(false);
    const failed = eligibility.checks.find(
      (c) => c.check === "value_eligible",
    );
    expect(failed?.satisfied).toBe(false);
    expect(failed?.reason).toBe("amount_exceeds_cap");
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
  });

  test("an unresolvable clearing rule id fails closed (clearing_rule_not_resolved)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const eligibility = await evaluateClearingEligibility(harness, world, {
      clearingRuleId: "does-not-exist",
    });
    expect(eligibility.eligible).toBe(false);
    expect(
      eligibility.checks.find((c) => c.check === "campaign_clearing_policy")
        ?.reason,
    ).toBe("clearing_rule_not_resolved");
  });

  test("a STALE world (retired placement) fails closed at the composite boundary even with a healthy pre-eligibility snapshot", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    // Retire AFTER a healthy eligibility read (the stale-window case).
    const healthy = await evaluateClearingEligibility(harness, world);
    expect(healthy.eligible).toBe(true);
    await harness.runtime.inventoryService.retirePlacement(
      creatorCtx(harness, "w020-stale-retire"),
      {
        organizationScopeId: harness.organizationScopeId,
        placementId: world.placement.id,
        reason: "stale-window fixture",
        idempotencyKey: key("w020-stale-retire"),
      },
    );
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "CROSS_PROMOTION_CLEARING_VALIDATION",
    });
    // The tenant's clearing list stays empty for the contribution.
    const clearings =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-stale-list"),
        harness.organizationScopeId,
      );
    expect(
      clearings.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(0);
  });
});
