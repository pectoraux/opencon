/**
 * NET-W019-AC-01 — inventory records are first-class, durable,
 * tenant-scoped and ownership-aware (INV-001; issue #37 invariant 1).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW019Harness,
  registerInventoryItem,
  personCtx,
  key,
  type NetW019Harness,
} from "./_net-w019-harness.ts";
import { InvalidInventoryError } from "../../src/core/inventory.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { INVENTORY_ITEM_FORMAT } from "../../src/core/inventory.ts";

let harness: NetW019Harness;

describe("NET-W019-AC-01 inventory records", () => {
  beforeAll(async () => {
    harness = await createNetW019Harness();
  });
  afterAll(async () => {
    await harness.teardown();
  });

  test("registration makes supply FIRST-CLASS: a durable, re-readable record with the closed vocabularies", async () => {
    const item = await registerInventoryItem(harness, {
      surfaceKind: "publisher",
      format: "sponsored_content",
      territories: ["US", "CA", "GH"],
      languages: ["en", "pt-BR"],
    });
    expect(item.id).toBeTruthy();
    expect(item.organizationScopeId).toBe(harness.organizationScopeId);
    expect(item.surfaceKind).toBe("publisher");
    expect(item.format).toBe("sponsored_content");
    expect([...item.attributes.territories]).toEqual(["US", "CA", "GH"]);
    expect([...item.attributes.languages]).toEqual(["en", "pt-BR"]);
    expect(item.externalReference).toEqual({
      provider: "example-ad-network",
      externalId: "supply-ext-1",
      url: "https://example.com/supply-ext-1",
    });
    expect(item.retiredAt).toBeNull();
    expect(item.formatVersion).toBe(INVENTORY_ITEM_FORMAT);
    // DURABLE: the read back returns the same record.
    const reread = await harness.runtime.inventoryService.getInventoryItem(
      personCtx(harness, harness.operatorPersonId, "w019-ac01-reread"),
      harness.organizationScopeId,
      item.id,
    );
    expect(reread).toEqual(item);
  });

  test("EXPLICIT OWNERSHIP: the registered owner IS the acting person (there is no owner input to fabricate)", async () => {
    const byCreator = await registerInventoryItem(harness, {
      actorPersonId: harness.creatorPersonId,
    });
    expect(byCreator.ownerPersonId).toBe(harness.creatorPersonId);
    expect(byCreator.createdBy).toBe(harness.creatorPersonId);
    const byOperator = await registerInventoryItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    expect(byOperator.ownerPersonId).toBe(harness.operatorPersonId);
  });

  test("the closed vocabularies are enforced (surface kinds + formats)", async () => {
    await expect(
      registerInventoryItem(harness, { surfaceKind: "billboard" }),
    ).rejects.toMatchObject({
      code: "INVENTORY_VALIDATION",
      classification: "validation",
    });
    await expect(
      registerInventoryItem(harness, { format: "interactive_tv" }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
  });

  test("the declared supply attributes are validated (territories/languages)", async () => {
    await expect(
      registerInventoryItem(harness, { territories: ["us"] }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, { territories: ["US", "US"] }),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    await expect(
      registerInventoryItem(harness, { territories: [] }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, { languages: ["ENGLISH"] }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, { languages: ["en", "en"] }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, {
        territories: Array.from(
          { length: 41 },
          (_, i) => `T${String(i).padStart(1, "0")}`.slice(0, 2),
        ).map((c) => (c.length < 2 ? c + "X" : c)),
      }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
  });

  test("the provider-neutral external reference is bounded (no oversized descriptors)", async () => {
    await expect(
      registerInventoryItem(harness, {
        externalReference: { provider: "", externalId: "x" },
      }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, {
        externalReference: {
          provider: "p".repeat(65),
          externalId: "x",
        },
      }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, {
        externalReference: {
          provider: "ok",
          externalId: "x".repeat(201),
        },
      }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    await expect(
      registerInventoryItem(harness, {
        externalReference: {
          provider: "ok",
          externalId: "x",
          url: "u".repeat(1001),
        },
      }),
    ).rejects.toBeInstanceOf(InvalidInventoryError);
    // A NULL external reference is legitimate (supply not yet linked
    // to an external platform).
    const unlinked = await registerInventoryItem(harness, {
      externalReference: null,
    });
    expect(unlinked.externalReference).toBeNull();
  });

  test("supply withdrawal is ONE-WAY and owner-only; a retired item stays retired", async () => {
    const item = await registerInventoryItem(harness);
    await expect(
      harness.runtime.inventoryService.retireInventoryItem(
        personCtx(harness, harness.operatorPersonId, "w019-ac01-notowner"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          reason: "not the owner",
          idempotencyKey: key("w019-ac01-notowner"),
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    const retired = await harness.runtime.inventoryService.retireInventoryItem(
      personCtx(harness, harness.creatorPersonId, "w019-ac01-retire"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        reason: "supply withdrawn",
        idempotencyKey: key("w019-ac01-retire"),
      },
    );
    expect(retired.retiredAt).toBeTruthy();
    expect(retired.retirementReason).toBe("supply withdrawn");
    // Withdrawn supply cannot be placed (the conservative direction).
    const campaign = await (
      await import("./_net-w019-harness.ts")
    ).createCampaignWithEligibility(harness);
    await expect(
      harness.runtime.inventoryService.createPlacement(
        personCtx(harness, harness.creatorPersonId, "w019-ac01-place"),
        {
          organizationScopeId: harness.organizationScopeId,
          inventoryItemId: retired.id,
          campaignId: campaign.id,
          context: { territories: ["US"], languages: ["en"] },
          idempotencyKey: key("w019-ac01-place"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
  });

  test("tenant isolation: a cross-scope id is indistinguishable from a nonexistent one", async () => {
    const item = await registerInventoryItem(harness);
    await expect(
      harness.runtime.inventoryService.getInventoryItem(
        personCtx(harness, harness.secondOrgPersonId, "w019-ac01-cross"),
        harness.secondOrgId,
        item.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.inventoryService.getInventoryItem(
        personCtx(harness, harness.creatorPersonId, "w019-ac01-missing"),
        harness.organizationScopeId,
        "no-such-item",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("material mutations are AUDITED with lineage (inventory_item.registered / inventory_item.retired)", async () => {
    const item = await registerInventoryItem(harness);
    const registered = await harness.runtime.auditWriter.query({
      eventType: "inventory_item.registered",
      resourceId: item.id,
    });
    expect(registered).toHaveLength(1);
    expect(registered[0]!.metadata.organizationScopeId).toBe(
      harness.organizationScopeId,
    );
    expect(registered[0]!.metadata.ownerPersonId).toBe(item.ownerPersonId);
    expect(registered[0]!.metadata.transactionId).toBeTruthy();
    expect(registered[0]!.metadata.idempotencyRecordId).toBeTruthy();
    expect(registered[0]!.executionId).toBeTruthy();
    expect(registered[0]!.correlationId).toBeTruthy();
    const retired = await harness.runtime.inventoryService.retireInventoryItem(
      personCtx(harness, harness.creatorPersonId, "w019-ac01-audit"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        idempotencyKey: key("w019-ac01-audit"),
      },
    );
    const retiredEvents = await harness.runtime.auditWriter.query({
      eventType: "inventory_item.retired",
      resourceId: retired.id,
    });
    expect(retiredEvents).toHaveLength(1);
    expect(retiredEvents[0]!.metadata.transactionId).toBeTruthy();
  });
});
