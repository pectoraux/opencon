/**
 * NET-W019-AC-02 — placement context is explicit, provenance-aware
 * and policy-scoped (INV-002; issue #37 invariant 2).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW019Harness,
  registerInventoryItem,
  createCampaignWithEligibility,
  createPlacement,
  personCtx,
  key,
  type NetW019Harness,
} from "./_net-w019-harness.ts";
import { PlacementConflictError } from "../../src/core/inventory.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { PLACEMENT_RECORD_FORMAT } from "../../src/core/inventory.ts";

let harness: NetW019Harness;

describe("NET-W019-AC-02 placement context", () => {
  beforeAll(async () => {
    harness = await createNetW019Harness();
  });
  afterAll(async () => {
    await harness.teardown();
  });

  test("the placement is an EXPLICIT record carrying the pinned policy scope + declared context", async () => {
    const item = await registerInventoryItem(harness, {
      territories: ["US", "CA", "GH"],
      languages: ["en", "fr"],
    });
    const campaign = await createCampaignWithEligibility(harness, {
      rules: [
        { attribute: "region", operator: "in", values: ["US", "CA", "GH"] },
      ],
    });
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
      territories: ["US", "CA"],
      languages: ["en"],
    });
    expect(placement.id).toBeTruthy();
    expect(placement.organizationScopeId).toBe(harness.organizationScopeId);
    expect(placement.inventoryItemId).toBe(item.id);
    expect(placement.campaignId).toBe(campaign.id);
    expect(placement.campaignPolicyVersion).toBe(1);
    expect([...placement.context.territories]).toEqual(["US", "CA"]);
    expect([...placement.context.languages]).toEqual(["en"]);
    expect(placement.retiredAt).toBeNull();
    expect(placement.formatVersion).toBe(PLACEMENT_RECORD_FORMAT);
  });

  test("POLICY-SCOPED: the source context pins the campaign policy version (explicit pin + latest-at-creation)", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    // Latest-at-creation (no explicit pin) resolves version 1.
    const latest = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    expect(latest.campaignPolicyVersion).toBe(1);
    // An EXPLICIT pin of a nonexistent version fails (no fabricated
    // campaign scope).
    await expect(
      createPlacement(harness, {
        inventoryItemId: item.id,
        campaignId: campaign.id,
        campaignPolicyVersion: 99,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PROVENANCE-AWARE: the source context is the server-written durable-identity snapshot", async () => {
    const item = await registerInventoryItem(harness, {
      surfaceKind: "app",
      format: "video",
      territories: ["GH"],
      languages: ["en"],
    });
    const campaign = await createCampaignWithEligibility(harness);
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
      territories: ["GH"],
      languages: ["en"],
    });
    // The snapshot mirrors the DURABLE records — there is no caller
    // input for any source-context field.
    expect(placement.sourceContext).toEqual({
      inventoryItemId: item.id,
      ownerPersonId: item.ownerPersonId,
      surfaceKind: "app",
      format: "video",
      externalReference: item.externalReference,
      campaignId: campaign.id,
      campaignPolicyVersion: 1,
    });
  });

  test("the placement context may only NARROW the item's declared supply attributes", async () => {
    const item = await registerInventoryItem(harness, {
      territories: ["US", "CA"],
      languages: ["en"],
    });
    const campaign = await createCampaignWithEligibility(harness);
    await expect(
      createPlacement(harness, {
        inventoryItemId: item.id,
        campaignId: campaign.id,
        territories: ["GH"],
        languages: ["en"],
      }),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    await expect(
      createPlacement(harness, {
        inventoryItemId: item.id,
        campaignId: campaign.id,
        territories: ["US"],
        languages: ["fr"],
      }),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
  });

  test("ONE ACTIVE placement per (item, campaign): create-once conflict; retirement re-opens the pair", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const first = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    // A second ACTIVE placement for the same pair conflicts.
    const conflict = createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    await expect(conflict).rejects.toBeInstanceOf(PlacementConflictError);
    await expect(conflict).rejects.toMatchObject({
      code: "PLACEMENT_CONFLICT",
      context: { existingPlacementId: first.id },
    });
    // Retiring the first re-opens the pair (a RETIRED placement never
    // blocks re-placement).
    const retired = await harness.runtime.inventoryService.retirePlacement(
      personCtx(harness, harness.creatorPersonId, "w019-ac02-retire"),
      {
        organizationScopeId: harness.organizationScopeId,
        placementId: first.id,
        reason: "campaign ended",
        idempotencyKey: key("w019-ac02-retire"),
      },
    );
    expect(retired.retiredAt).toBeTruthy();
    const second = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    expect(second.id).not.toBe(first.id);
  });

  test("the DERIVED eligibility evaluation is RECORDED (deterministic snapshot, machine-readable rules)", async () => {
    const placement = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "region", operator: "in", values: ["US", "CA", "GH"] },
        { attribute: "language", operator: "equals", values: ["en"] },
      ],
      territories: ["US", "CA"],
      languages: ["en"],
    });
    expect(placement.eligibility.eligible).toBe(true);
    expect(placement.eligibility.ruleResults).toHaveLength(2);
    expect(placement.eligibility.ruleResults[0]).toMatchObject({
      attribute: "region",
      operator: "in",
      satisfied: true,
      reason: "satisfied",
    });
    expect(placement.eligibility.ruleResults[1]).toMatchObject({
      attribute: "language",
      operator: "equals",
      satisfied: true,
      reason: "satisfied",
    });
    expect(placement.eligibility.evaluatedAt).toBeTruthy();
    // An ineligible placement is recorded HONESTLY (provenance — the
    // eligibility is derived, never fabricated): a region rule the
    // placement does not satisfy is recorded NOT satisfied.
    const ineligible = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "region", operator: "equals", values: ["GH"] },
      ],
      territories: ["US", "CA"],
      languages: ["en"],
    });
    expect(ineligible.eligibility.eligible).toBe(false);
    expect(ineligible.eligibility.ruleResults[0]).toMatchObject({
      attribute: "region",
      operator: "equals",
      satisfied: false,
      reason: "offered_value_outside_rule",
    });
  });

  test("the snapshot NEVER DRIFTS: the live readiness re-derivation equals the recorded evaluation", async () => {
    const placement = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "region", operator: "in", values: ["US", "CA"] },
      ],
      territories: ["US", "CA"],
      languages: ["en"],
    });
    const readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        personCtx(harness, harness.operatorPersonId, "w019-ac02-derive"),
        harness.organizationScopeId,
        placement.id,
      );
    expect(readiness.eligible).toBe(true);
    const eligibilityCheck = readiness.checks.find(
      (c) => c.check === "eligibility_satisfied",
    )!;
    expect(eligibilityCheck.satisfied).toBe(placement.eligibility.eligible);
    const ruleResults = eligibilityCheck.detail.ruleResults as readonly {
      attribute: string;
      satisfied: boolean;
      reason: string;
    }[];
    expect(ruleResults.map((r) => r.satisfied)).toEqual(
      placement.eligibility.ruleResults.map((r) => r.satisfied),
    );
    expect(ruleResults.map((r) => r.reason)).toEqual(
      placement.eligibility.ruleResults.map((r) => r.reason),
    );
  });

  test("placement recording is AUDITED with the full provenance + lineage", async () => {
    const placement = await createPlacement(harness);
    const events = await harness.runtime.auditWriter.query({
      eventType: "placement.recorded",
      resourceId: placement.id,
    });
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.organizationScopeId).toBe(harness.organizationScopeId);
    expect(metadata.inventoryItemId).toBe(placement.inventoryItemId);
    expect(metadata.campaignId).toBe(placement.campaignId);
    expect(metadata.campaignPolicyVersion).toBe(
      placement.campaignPolicyVersion,
    );
    expect(metadata.ownerPersonId).toBe(placement.sourceContext.ownerPersonId);
    expect(metadata.eligibility).toMatchObject({
      eligible: placement.eligibility.eligible,
    });
    expect(metadata.transactionId).toBeTruthy();
    expect(metadata.idempotencyRecordId).toBeTruthy();
  });
});
