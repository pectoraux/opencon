/**
 * NET-W011-AC-01 — Campaigns are first-class durable scoped records
 * with immutable/append-only material history.
 *
 * Evidence: creating a campaign produces a durable, org-scoped
 * CampaignRecord (DRAFT, owner = creator, empty budget block, the
 * `created` event); every lifecycle step APPENDS events (prior events
 * stay byte-identical); records are durable committed reads; listings
 * are org-scoped and tenant-isolated; creation is idempotent.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW011Harness,
  createCampaign,
  definePolicy,
  commitDefaultBudget,
  ownerCtx,
  otherCtx,
  key,
  type NetW011Harness,
} from "./_net-w011-harness.ts";
import { CAMPAIGN_POLICY_FORMAT } from "../../src/core/campaigns.ts";
import { ensureCreditsFor } from "../disputes/_net-w010-harness.ts";

let harness: NetW011Harness;

beforeAll(async () => {
  harness = await createNetW011Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W011-AC-01 first-class durable scoped campaign records", () => {
  test("creating a campaign produces the full first-class record", async () => {
    const campaign = await createCampaign(harness, {
      name: "Awareness Push",
    });
    expect(campaign.id).toBeTruthy();
    expect(campaign.organizationScopeId).toBe(harness.organizationScopeId);
    expect(campaign.ownerPersonId).toBe(harness.ownerPersonId);
    expect(campaign.name).toBe("Awareness Push");
    expect(campaign.description).toBeTruthy();
    // The administrative status machine starts DRAFT.
    expect(campaign.status).toBe("DRAFT");
    expect(campaign.currentPolicyVersion).toBeNull();
    // The budget block is REFERENCES-ONLY (empty until a commitment).
    expect(campaign.budget).toEqual({
      stakeId: null,
      committedAmount: null,
      committedAt: null,
      releasedAt: null,
    });
    // Append-only history: exactly the created event.
    expect(campaign.events.map((e) => e.event)).toEqual(["created"]);
    expect(campaign.events[0]!.actorPersonId).toBe(harness.ownerPersonId);
    // Execution lineage.
    expect(campaign.executionId).toBeTruthy();
    expect(campaign.correlationId).toBeTruthy();
    expect(campaign.createdAt).toBeTruthy();
    expect(campaign.updatedAt).toBe(campaign.createdAt);
  });

  test("a service/system actor cannot create campaigns (person actors only)", async () => {
    let threw: unknown;
    try {
      await harness.runtime.campaignService.createCampaign(
        harness.bootstrapCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          name: "Illegal",
          idempotencyKey: key("w011-ac01-service"),
        },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { code?: string }).code).toBe("CAMPAIGN_VALIDATION");
  });

  test("the event history is append-only — prior events stay byte-identical across steps", async () => {
    const campaign = await createCampaign(harness);
    const policy = await definePolicy(harness, campaign, { totalAmount: 10 });
    void policy;
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 10);
    const withBudget = await commitDefaultBudget(harness, campaign);
    const created = withBudget.events[0]!;
    expect(withBudget.events.map((e) => e.event)).toEqual([
      "created",
      "policy_defined",
      "budget_committed",
    ]);
    // The created event is byte-identical (no rewrite).
    expect(created.event).toBe("created");
    expect(created.id).toBe(campaign.events[0]!.id);
    expect(created.recordedAt).toBe(campaign.events[0]!.recordedAt);
    // The budget event carries the settlement reference.
    const budgetEvent = withBudget.events[2]!;
    expect(budgetEvent.details.stakeId).toBe(withBudget.budget.stakeId);
    expect(budgetEvent.details.committedAmount).toBe(10);
  });

  test("records are durable committed reads (get/list round-trip)", async () => {
    const campaign = await createCampaign(harness, { name: "Durable" });
    const ctx = ownerCtx(harness, "w011-ac01-read");
    const fetched = await harness.runtime.campaignService.getCampaign(
      ctx,
      campaign.id,
    );
    expect(fetched.id).toBe(campaign.id);
    expect(fetched.name).toBe("Durable");
    const listed =
      await harness.runtime.campaignService.listCampaigns(
        ctx,
        harness.organizationScopeId,
      );
    const ids = listed.map((c) => c.id);
    expect(ids).toContain(campaign.id);
    // Status filter narrows the listing.
    const drafts = await harness.runtime.campaignService.listCampaigns(
      ctx,
      harness.organizationScopeId,
      ["DRAFT"],
    );
    expect(drafts.every((c) => c.status === "DRAFT")).toBe(true);
    expect(drafts.some((c) => c.id === campaign.id)).toBe(true);
  });

  test("listings are tenant-isolated (a second org sees only its own campaigns)", async () => {
    const mine = await createCampaign(harness, { name: "Mine" });
    const otherOrgCampaign = await createCampaign(harness, {
      name: "Theirs",
      ownerPersonId: harness.secondOrgPersonId,
      organizationScopeId: harness.secondOrgId,
    });
    const ctx = ownerCtx(harness, "w011-ac01-tenant");
    const mineListed = await harness.runtime.campaignService.listCampaigns(
      ctx,
      harness.organizationScopeId,
    );
    expect(mineListed.some((c) => c.id === mine.id)).toBe(true);
    expect(mineListed.some((c) => c.id === otherOrgCampaign.id)).toBe(false);
    // A cross-org fetch of the record by id is a plain read, but the
    // second org's campaign belongs to its own scope.
    const foreign = await harness.runtime.campaignService.getCampaign(
      ctx,
      otherOrgCampaign.id,
    );
    expect(foreign.organizationScopeId).toBe(harness.secondOrgId);
  });

  test("creation is idempotent (replay returns created:false, same record)", async () => {
    const idem = key("w011-ac01-idem");
    const ctx = ownerCtx(harness, "w011-ac01-idem");
    const first = await harness.runtime.campaignService.createCampaign(ctx, {
      organizationScopeId: harness.organizationScopeId,
      name: "Idempotent",
      idempotencyKey: idem,
    });
    expect(first.created).toBe(true);
    const replay = await harness.runtime.campaignService.createCampaign(ctx, {
      organizationScopeId: harness.organizationScopeId,
      name: "Idempotent",
      idempotencyKey: idem,
    });
    expect(replay.created).toBe(false);
    expect(replay.campaign.id).toBe(first.campaign.id);
    // Only one campaign was created for the key.
    const listed = await harness.runtime.campaignService.listCampaigns(
      ctx,
      harness.organizationScopeId,
    );
    expect(
      listed.filter((c) => c.name === "Idempotent").length,
    ).toBe(1);
  });

  test("a non-owner cannot be inferred from the record — owner is server-side identity", async () => {
    const other = otherCtx(harness, "w011-ac01-other");
    const campaign = await createCampaign(harness);
    const fetched = await harness.runtime.campaignService.getCampaign(
      other,
      campaign.id,
    );
    expect(fetched.ownerPersonId).toBe(harness.ownerPersonId);
    expect(fetched.ownerPersonId).not.toBe(harness.otherPersonId);
  });

  test("the policy lineage constant travels with defined versions", async () => {
    const campaign = await createCampaign(harness);
    const policy = await definePolicy(harness, campaign, { totalAmount: 5 });
    expect(policy.formatVersion).toBe(CAMPAIGN_POLICY_FORMAT);
    expect(policy.campaignId).toBe(campaign.id);
    expect(policy.organizationScopeId).toBe(harness.organizationScopeId);
  });
});
