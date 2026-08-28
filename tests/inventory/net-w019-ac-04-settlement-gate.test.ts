/**
 * NET-W019-AC-04 — settlement-affecting consumers require valid
 * inventory source context; no bypass to /settlement (INV-004; issue
 * #37 invariant 4). The settlement gate is the DERIVED
 * PlacementSettlementReadiness view — re-derived from CURRENT durable
 * records on every read; there is NO command that asserts, stores or
 * waives readiness, and the inventory boundary carries NO economic
 * surface at all.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW019Harness,
  registerInventoryItem,
  createCampaignWithEligibility,
  createPlacement,
  personCtx,
  key,
  goldenPathPlacement,
  type NetW019Harness,
} from "./_net-w019-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";

let harness: NetW019Harness;

function findCheck(
  readiness: Awaited<
    ReturnType<
      typeof harness.runtime.inventoryService.getPlacementSettlementReadiness
    >
  >,
  check: string,
) {
  const found = readiness.checks.find((c) => c.check === check);
  expect(found).toBeDefined();
  return found!;
}

describe("NET-W019-AC-04 settlement gate", () => {
  beforeAll(async () => {
    harness = await createNetW019Harness();
  });
  afterAll(async () => {
    await harness.teardown();
  });

  test("the golden path: every check passes → ELIGIBLE with the validated source context", async () => {
    const golden = await goldenPathPlacement(harness);
    expect(golden.readiness.eligible).toBe(true);
    for (const check of golden.readiness.checks) {
      expect(check.satisfied).toBe(true);
    }
    // The source context is the consumer contract: the durable
    // supply identity + the policy-scope pin.
    expect(golden.readiness.sourceContext).toEqual(
      golden.placement.sourceContext,
    );
    // The INV-003 ecosystem signal is reported (where available).
    expect(golden.readiness.verificationEvidenceReference).toBe(
      golden.evidenceId,
    );
  });

  test("an UNREGISTERED owner/source (item not in scope) blocks settlement", async () => {
    const placement = await createPlacement(harness);
    await expect(
      harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.secondOrgPersonId, "w019-ac04-cross"),
        harness.secondOrgId,
        placement.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("WITHDRAWN supply blocks settlement (supply_available fails; re-derives live)", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    let readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-live"),
        harness.organizationScopeId,
        placement.id,
      );
    expect(readiness.eligible).toBe(true);
    // Withdraw the supply → the SAME placement flips to not eligible
    // (re-derived from CURRENT durable records — never stored).
    await harness.runtime.inventoryService.retireInventoryItem(
      personCtx(harness, harness.creatorPersonId, "w019-ac04-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        idempotencyKey: key("w019-ac04-withdraw"),
      },
    );
    readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-live2"),
        harness.organizationScopeId,
        placement.id,
      );
    expect(readiness.eligible).toBe(false);
    expect(findCheck(readiness, "supply_available").satisfied).toBe(false);
    expect(
      (findCheck(readiness, "supply_available").detail as Record<string, unknown>)
        .reason,
    ).toBe("supply_withdrawn");
  });

  test("a RETIRED placement blocks settlement (placement_active fails)", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    await harness.runtime.inventoryService.retirePlacement(
      personCtx(harness, harness.creatorPersonId, "w019-ac04-retire"),
      {
        organizationScopeId: harness.organizationScopeId,
        placementId: placement.id,
        idempotencyKey: key("w019-ac04-retire"),
      },
    );
    const readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-retired"),
        harness.organizationScopeId,
        placement.id,
      );
    expect(readiness.eligible).toBe(false);
    expect(findCheck(readiness, "placement_active").satisfied).toBe(false);
    expect(
      (findCheck(readiness, "placement_active").detail as Record<string, unknown>)
        .reason,
    ).toBe("placement_retired");
  });

  test("a NON-PUBLISHABLE campaign policy scope blocks settlement (DRAFT/PAUSED/COMPLETED)", async () => {
    // DRAFT (never activated).
    const draftCampaign = await createCampaignWithEligibility(harness, {
      activate: false,
    });
    const itemA = await registerInventoryItem(harness);
    const onDraft = await createPlacement(harness, {
      inventoryItemId: itemA.id,
      campaignId: draftCampaign.id,
    });
    const draftReadiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-draft"),
        harness.organizationScopeId,
        onDraft.id,
      );
    expect(draftReadiness.eligible).toBe(false);
    const scope = findCheck(draftReadiness, "policy_scope");
    expect(scope.satisfied).toBe(false);
    expect((scope.detail as Record<string, unknown>).campaignStatus).toBe(
      "DRAFT",
    );

    // ACTIVE → PAUSED blocks; resumed re-opens (live re-derivation).
    const pausedCampaign = await createCampaignWithEligibility(harness);
    const itemB = await registerInventoryItem(harness);
    const onActive = await createPlacement(harness, {
      inventoryItemId: itemB.id,
      campaignId: pausedCampaign.id,
    });
    const ownerCtx = personCtx(
      harness,
      harness.operatorPersonId,
      "w019-ac04-pause",
    );
    await harness.runtime.campaignService.pauseCampaign(ownerCtx, {
      campaignId: pausedCampaign.id,
      idempotencyKey: key("w019-ac04-pause"),
    });
    const pausedReadiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-paused"),
        harness.organizationScopeId,
        onActive.id,
      );
    expect(pausedReadiness.eligible).toBe(false);
    expect(
      (findCheck(pausedReadiness, "policy_scope").detail as Record<string, unknown>)
        .campaignStatus,
    ).toBe("PAUSED");
    await harness.runtime.campaignService.resumeCampaign(ownerCtx, {
      campaignId: pausedCampaign.id,
      idempotencyKey: key("w019-ac04-resume"),
    });
    const resumedReadiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-resumed"),
        harness.organizationScopeId,
        onActive.id,
      );
    expect(resumedReadiness.eligible).toBe(true);

    // COMPLETED (terminal) blocks permanently.
    const completedCampaign = await createCampaignWithEligibility(harness);
    const itemC = await registerInventoryItem(harness);
    const onCompletable = await createPlacement(harness, {
      inventoryItemId: itemC.id,
      campaignId: completedCampaign.id,
    });
    await harness.runtime.campaignService.completeCampaign(
      personCtx(harness, harness.operatorPersonId, "w019-ac04-complete"),
      {
        campaignId: completedCampaign.id,
        idempotencyKey: key("w019-ac04-complete"),
      },
    );
    const completedReadiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-completed"),
        harness.organizationScopeId,
        onCompletable.id,
      );
    expect(completedReadiness.eligible).toBe(false);
    expect(
      (findCheck(completedReadiness, "policy_scope").detail as Record<string, unknown>)
        .campaignStatus,
    ).toBe("COMPLETED");
  });

  test("an INELIGIBLE placement blocks settlement (eligibility re-derivation fails with machine-readable rules)", async () => {
    const placement = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "region", operator: "equals", values: ["GH"] },
        { attribute: "participant_class", operator: "equals", values: ["organization"] },
      ],
      territories: ["US", "CA"],
      languages: ["en"],
    });
    const readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac04-ineligible"),
        harness.organizationScopeId,
        placement.id,
      );
    expect(readiness.eligible).toBe(false);
    const eligibility = findCheck(readiness, "eligibility_satisfied");
    expect(eligibility.satisfied).toBe(false);
    const ruleResults = (eligibility.detail as Record<string, unknown>)
      .ruleResults as readonly { reason: string; satisfied: boolean }[];
    expect(ruleResults.map((r) => r.reason)).toEqual([
      "offered_value_outside_rule",
      "attribute_not_carried_by_supply",
    ]);
  });

  test("NO BYPASS: the readiness view is a PURE read — no mutation, no audit, no state change", async () => {
    const golden = await goldenPathPlacement(harness);
    const before = await harness.runtime.inventoryService.getPlacement(
      personCtx(harness, harness.operatorPersonId, "w019-ac04-before"),
      harness.organizationScopeId,
      golden.placement.id,
    );
    const auditBefore = (
      await harness.runtime.auditWriter.query({
        eventType: "placement.recorded",
      })
    ).length;
    for (let i = 0; i < 3; i++) {
      const readiness =
        await harness.runtime.inventoryService.getPlacementSettlementReadiness(
          personCtx(harness, harness.operatorPersonId, `w019-ac04-pure-${i}`),
          harness.organizationScopeId,
          golden.placement.id,
        );
      expect(readiness.eligible).toBe(true);
    }
    const after = await harness.runtime.inventoryService.getPlacement(
      personCtx(harness, harness.operatorPersonId, "w019-ac04-after"),
      harness.organizationScopeId,
      golden.placement.id,
    );
    expect(after).toEqual(before);
    const auditAfter = (
      await harness.runtime.auditWriter.query({
        eventType: "placement.recorded",
      })
    ).length;
    expect(auditAfter).toBe(auditBefore);
  });

  test("NO BYPASS: the inventory surface carries NO settlement command (the derived view is the ONLY settlement-relevant surface)", async () => {
    // Structural: the InventoryService interface exposes exactly the
    // W019 surface — no economic mutation exists on it (the method
    // list is pinned; adding a settlement-affecting method changes
    // this pin).
    const methods = Object.keys(
      harness.runtime.inventoryService,
    ).sort();
    expect(methods).toEqual([
      "attachSupplyVerification",
      "createPlacement",
      "getInventoryItem",
      "getPlacement",
      "getPlacementSettlementReadiness",
      "listInventoryItems",
      "listPlacements",
      "registerInventoryItem",
      "retireInventoryItem",
      "retirePlacement",
    ]);
    for (const method of methods) {
      // The derived READ (getPlacementSettlementReadiness) is the
      // sanctioned surface; no economic MUTATION verb exists.
      expect(method).not.toMatch(
        /^(settle|issueCredit|issueCredits|allocateReward|allocateRewards|postLedger|recordCash|recordCashObligation|clear|executePayment|processPayout)/i,
      );
    }
  });
});
