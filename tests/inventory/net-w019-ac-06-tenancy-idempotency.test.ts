/**
 * NET-W019-AC-06 — idempotency, concurrency, tenancy, PostgreSQL
 * authority and transactional audit lineage hold (issue #37
 * invariant 7).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW019Harness,
  registerInventoryItem,
  createCampaignWithEligibility,
  createPlacement,
  createSupplyEvidence,
  personCtx,
  key,
  type NetW019Harness,
} from "./_net-w019-harness.ts";
import { PlacementConflictError } from "../../src/core/inventory.ts";
import { NotFoundError } from "../../src/core/errors.ts";

let harness: NetW019Harness;

describe("NET-W019-AC-06 tenancy / idempotency / concurrency / audit", () => {
  beforeAll(async () => {
    harness = await createNetW019Harness();
  });
  afterAll(async () => {
    await harness.teardown();
  });

  test("tenant isolation: every ID-based read is org-scoped (cross-scope = NotFoundError; lists stay scoped)", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    const outsider = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w019-ac06-out",
    );
    await expect(
      harness.runtime.inventoryService.getInventoryItem(
        outsider,
        harness.secondOrgId,
        item.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.inventoryService.getPlacement(
        outsider,
        harness.secondOrgId,
        placement.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.inventoryService.getPlacementSettlementReadiness(
        outsider,
        harness.secondOrgId,
        placement.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Lists in the second org see NEITHER record.
    const outsiderItems =
      await harness.runtime.inventoryService.listInventoryItems(
        outsider,
        harness.secondOrgId,
      );
    expect(outsiderItems.find((i) => i.id === item.id)).toBeUndefined();
    const outsiderPlacements =
      await harness.runtime.inventoryService.listPlacements(
        outsider,
        harness.secondOrgId,
      );
    expect(
      outsiderPlacements.find((p) => p.id === placement.id),
    ).toBeUndefined();
    // Cross-scope MUTATIONS are equally blind (retire with the wrong
    // org scope = not found).
    await expect(
      harness.runtime.inventoryService.retireInventoryItem(outsider, {
        organizationScopeId: harness.secondOrgId,
        itemId: item.id,
        idempotencyKey: key("w019-ac06-cross-retire"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("idempotency: same-key replays are deterministic no-ops for every W019 command", async () => {
    // registerInventoryItem.
    const idemKey = key("w019-ac06-idem");
    const first = await harness.runtime.inventoryService.registerInventoryItem(
      personCtx(harness, harness.creatorPersonId, "w019-ac06-idem-1"),
      {
        organizationScopeId: harness.organizationScopeId,
        surfaceKind: "creator",
        format: "native",
        externalReference: null,
        attributes: { territories: ["GH"], languages: ["en"] },
        description: null,
        idempotencyKey: idemKey,
      },
    );
    expect(first.created).toBe(true);
    const replayed =
      await harness.runtime.inventoryService.registerInventoryItem(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-idem-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          surfaceKind: "creator",
          format: "native",
          externalReference: null,
          attributes: { territories: ["GH"], languages: ["en"] },
          description: null,
          idempotencyKey: idemKey,
        },
      );
    expect(replayed.created).toBe(false);
    expect(replayed.item).toEqual(first.item);
    // Exactly ONE audit event for the record.
    const registered = await harness.runtime.auditWriter.query({
      eventType: "inventory_item.registered",
      resourceId: first.item.id,
    });
    expect(registered).toHaveLength(1);

    // retireInventoryItem.
    const retireKey = key("w019-ac06-retire");
    const retired =
      await harness.runtime.inventoryService.retireInventoryItem(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-retire"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: first.item.id,
          reason: "fixture withdrawal",
          idempotencyKey: retireKey,
        },
      );
    const retiredReplay =
      await harness.runtime.inventoryService.retireInventoryItem(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-retire-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: first.item.id,
          reason: "fixture withdrawal",
          idempotencyKey: retireKey,
        },
      );
    expect(retiredReplay.retiredAt).toBe(retired.retiredAt);

    // createPlacement (+ its replay).
    const item2 = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const placementKey = key("w019-ac06-placement");
    const placement = await harness.runtime.inventoryService.createPlacement(
      personCtx(harness, harness.creatorPersonId, "w019-ac06-place"),
      {
        organizationScopeId: harness.organizationScopeId,
        inventoryItemId: item2.id,
        campaignId: campaign.id,
        context: { territories: ["US", "CA"], languages: ["en"] },
        idempotencyKey: placementKey,
      },
    );
    expect(placement.created).toBe(true);
    const placementReplay =
      await harness.runtime.inventoryService.createPlacement(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-place-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          inventoryItemId: item2.id,
          campaignId: campaign.id,
          context: { territories: ["US", "CA"], languages: ["en"] },
          idempotencyKey: placementKey,
        },
      );
    expect(placementReplay.created).toBe(false);
    expect(placementReplay.placement).toEqual(placement.placement);

    // attachSupplyVerification (+ its replay).
    const { evidenceId } = await createSupplyEvidence(harness, item2.id);
    const attachKey = key("w019-ac06-attach");
    const attached =
      await harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-attach"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item2.id,
          evidenceReference: evidenceId,
          idempotencyKey: attachKey,
        },
      );
    const attachReplay =
      await harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-attach-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item2.id,
          evidenceReference: evidenceId,
          idempotencyKey: attachKey,
        },
      );
    expect(attachReplay.verificationEvidenceReference).toBe(
      attached.verificationEvidenceReference,
    );

    // retirePlacement (+ its replay).
    const placementRetireKey = key("w019-ac06-place-retire");
    const placementRetired =
      await harness.runtime.inventoryService.retirePlacement(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-pr"),
        {
          organizationScopeId: harness.organizationScopeId,
          placementId: placement.placement.id,
          idempotencyKey: placementRetireKey,
        },
      );
    const placementRetiredReplay =
      await harness.runtime.inventoryService.retirePlacement(
        personCtx(harness, harness.creatorPersonId, "w019-ac06-pr-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          placementId: placement.placement.id,
          idempotencyKey: placementRetireKey,
        },
      );
    expect(placementRetiredReplay.retiredAt).toBe(placementRetired.retiredAt);
  });

  test("concurrency: two concurrent placements racing the SAME (item, campaign) pair → exactly ONE wins", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const ctx = personCtx(harness, harness.creatorPersonId, "w019-ac06-race");
    const attempts = await Promise.allSettled([
      harness.runtime.inventoryService.createPlacement(ctx, {
        organizationScopeId: harness.organizationScopeId,
        inventoryItemId: item.id,
        campaignId: campaign.id,
        context: { territories: ["US"], languages: ["en"] },
        idempotencyKey: key("w019-ac06-race-a"),
      }),
      harness.runtime.inventoryService.createPlacement(ctx, {
        organizationScopeId: harness.organizationScopeId,
        inventoryItemId: item.id,
        campaignId: campaign.id,
        context: { territories: ["CA"], languages: ["en"] },
        idempotencyKey: key("w019-ac06-race-b"),
      }),
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PlacementConflictError,
    );
    // Exactly ONE active placement exists for the pair.
    const placements = await harness.runtime.inventoryService.listPlacements(
      personCtx(harness, harness.operatorPersonId, "w019-ac06-race-read"),
      harness.organizationScopeId,
      { inventoryItemId: item.id, campaignId: campaign.id },
    );
    const active = placements.filter((p) => p.retiredAt === null);
    expect(active).toHaveLength(1);
  });

  test("transactional audit lineage: every W019 mutation carries execution/correlation/transaction lineage", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    for (const [eventType, resourceId] of [
      ["inventory_item.registered", item.id],
      ["placement.recorded", placement.id],
    ] as const) {
      const events = await harness.runtime.auditWriter.query({
        eventType,
        resourceId,
      });
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.executionId).toBeTruthy();
      expect(event.correlationId).toBeTruthy();
      expect(event.metadata.transactionId).toBeTruthy();
      expect(event.metadata.idempotencyRecordId).toBeTruthy();
      expect(event.metadata.organizationScopeId).toBe(
        harness.organizationScopeId,
      );
    }
    const retired = await harness.runtime.inventoryService.retirePlacement(
      personCtx(harness, harness.creatorPersonId, "w019-ac06-lineage"),
      {
        organizationScopeId: harness.organizationScopeId,
        placementId: placement.id,
        idempotencyKey: key("w019-ac06-lineage"),
      },
    );
    const retiredEvents = await harness.runtime.auditWriter.query({
      eventType: "placement.retired",
      resourceId: retired.id,
    });
    expect(retiredEvents).toHaveLength(1);
    expect(retiredEvents[0]!.metadata.transactionId).toBeTruthy();
  });

  test("PostgreSQL authority: every W019 record persists through the authority (survives independent re-reads)", async () => {
    const item = await registerInventoryItem(harness);
    const campaign = await createCampaignWithEligibility(harness);
    const placement = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
    });
    // Independent reads through the SAME authority-backed repos
    // resolve the records (the authority is the ONLY durable store).
    const rereadItem = await harness.runtime.inventoryService.getInventoryItem(
      personCtx(harness, harness.operatorPersonId, "w019-ac06-pg-item"),
      harness.organizationScopeId,
      item.id,
    );
    expect(rereadItem).toEqual(item);
    const rereadPlacement =
      await harness.runtime.inventoryService.getPlacement(
        personCtx(harness, harness.operatorPersonId, "w019-ac06-pg-place"),
        harness.organizationScopeId,
        placement.id,
      );
    expect(rereadPlacement).toEqual(placement);
    // The authority collections hold the records.
    const itemCount = await harness.runtime.postgresAuthority.count(
      "inventory_items",
    );
    expect(itemCount).toBeGreaterThan(0);
    const placementCount = await harness.runtime.postgresAuthority.count(
      "placements",
    );
    expect(placementCount).toBeGreaterThan(0);
  });
});
