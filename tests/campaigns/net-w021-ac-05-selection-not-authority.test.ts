/**
 * NET-W021 AC-05 — Selection, not authority.
 *
 * Proves: a match run mutates NO campaign, inventory, workflow,
 * settlement, reputation, risk or outcome state (before/after
 * counts + state assertions); the ONLY writes are the append-only
 * run record + its single `campaign_match.recorded` audit event;
 * idempotent re-runs are side-effect-free.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW021Harness,
  createMatchCampaign,
  registerSupplyItem,
  createVerifiedItemOutcome,
  placeSupplyOnCampaign,
  runCampaignMatch,
  key,
  operatorCtx,
  type NetW021Harness,
} from "./_net-w021-harness.ts";

let harness: NetW021Harness;

beforeAll(async () => {
  harness = await createNetW021Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Query the audit ledger (the universal mutation witness). */
async function auditEvents(): Promise<
  readonly {
    eventType: string;
    resourceType: string;
    resourceId: string;
    actor: string;
    metadata: Record<string, unknown>;
  }[]
> {
  return harness.runtime.auditWriter.query({ limit: 1_000_000 }) as never;
}

/** Count the audit events of a type. */
async function auditCount(eventType: string): Promise<number> {
  const events = await auditEvents();
  return events.filter((e) => e.eventType === eventType).length;
}

describe("NET-W021 AC-05: selection, not authority", () => {
  test("a run writes ONLY the run record + one audit event (every other state unchanged)", async () => {
    // The fixture: campaign + verified supply + a placement + a
    // verified outcome (state to be proven untouched).
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    await placeSupplyOnCampaign(harness, item.id, campaign.id);
    await createVerifiedItemOutcome(harness, item.id, { value: 42 });

    // BEFORE snapshots of every mutable surface.
    const before = {
      campaigns: (
        await harness.runtime.campaignService.listCampaigns(
          operatorCtx(harness, "w021-ac05-before"),
          harness.organizationScopeId,
        )
      ).length,
      campaignStatus: campaign.status,
      campaignEvents: campaign.events.length,
      campaignBudget: JSON.stringify(campaign.budget),
      policyVersions: (
        await harness.runtime.campaignService.listPolicyVersions(
          operatorCtx(harness, "w021-ac05-before-policy"),
          campaign.id,
        )
      ).length,
      items: (
        await harness.runtime.inventoryService.listInventoryItems(
          operatorCtx(harness, "w021-ac05-before-items"),
          harness.organizationScopeId,
        )
      ).length,
      itemVerification: harness.w019.w017.w016.w015.w013.runtime ===
          harness.runtime
        ? item.verificationEvidenceReference
        : null,
      placements: (
        await harness.runtime.inventoryService.listPlacements(
          operatorCtx(harness, "w021-ac05-before-placements"),
          harness.organizationScopeId,
          { campaignId: campaign.id },
        )
      ).length,
      matchRuns: (
        await harness.runtime.campaignMatchingService.listMatchRuns(
          operatorCtx(harness, "w021-ac05-before-runs"),
          harness.organizationScopeId,
        )
      ).length,
      auditRuns: await auditCount("campaign_match.recorded"),
      auditCreated: await auditCount("campaign.created"),
      auditPlacements: await auditCount("inventory.placement.created"),
      auditOutcomes: await auditCount("measured_outcome.created"),
      auditSnapshots: await auditCount("reputation.snapshot_recorded"),
    };

    const { run, created } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac05-authority"),
    });
    expect(created).toBe(true);

    // AFTER: exactly one new run record + one new audit event.
    const afterRuns = (
      await harness.runtime.campaignMatchingService.listMatchRuns(
        operatorCtx(harness, "w021-ac05-after-runs"),
        harness.organizationScopeId,
      )
    ).length;
    expect(afterRuns).toBe(before.matchRuns + 1);
    expect(await auditCount("campaign_match.recorded")).toBe(
      before.auditRuns + 1,
    );

    // The campaign record is untouched (status/version/events/budget).
    const campaignAfter = await harness.runtime.campaignService.getCampaign(
      operatorCtx(harness, "w021-ac05-after"),
      campaign.id,
    );
    expect(campaignAfter.status).toBe(before.campaignStatus);
    expect(campaignAfter.events).toHaveLength(before.campaignEvents);
    expect(JSON.stringify(campaignAfter.budget)).toBe(before.campaignBudget);
    expect(
      (
        await harness.runtime.campaignService.listPolicyVersions(
          operatorCtx(harness, "w021-ac05-after-policy"),
          campaign.id,
        )
      ).length,
    ).toBe(before.policyVersions);
    expect(
      (
        await harness.runtime.campaignService.listCampaigns(
          operatorCtx(harness, "w021-ac05-after-campaigns"),
          harness.organizationScopeId,
        )
      ).length,
    ).toBe(before.campaigns);

    // Inventory: no new items, no new placements, no mutations.
    expect(
      (
        await harness.runtime.inventoryService.listInventoryItems(
          operatorCtx(harness, "w021-ac05-after-items"),
          harness.organizationScopeId,
        )
      ).length,
    ).toBe(before.items);
    expect(
      (
        await harness.runtime.inventoryService.listPlacements(
          operatorCtx(harness, "w021-ac05-after-placements"),
          harness.organizationScopeId,
          { campaignId: campaign.id },
        )
      ).length,
    ).toBe(before.placements);
    expect(await auditCount("inventory.placement.created")).toBe(
      before.auditPlacements,
    );

    // Outcomes/reputation: no new measurements or snapshots.
    expect(await auditCount("measured_outcome.created")).toBe(
      before.auditOutcomes,
    );
    expect(await auditCount("reputation.snapshot_recorded")).toBe(
      before.auditSnapshots,
    );
    expect(await auditCount("campaign.created")).toBe(before.auditCreated);

    // The run's own lineage is complete (execution/correlation/
    // causation + the audit event references the run).
    expect(run.executionId).toBeTruthy();
    expect(run.correlationId).toBeTruthy();
    const events = (await auditEvents()).filter(
      (e) => e.eventType === "campaign_match.recorded",
    );
    const event = events.find((e) => e.resourceId === run.id);
    expect(event).toBeDefined();
    expect(event!.resourceType).toBe("campaign_match_run");
    expect(event!.actor).toBe(harness.operatorPersonId);
    expect(event!.metadata.digest).toBe(run.digest);
  });

  test("an idempotent replay is side-effect-free (byte-identical record, no new audit event)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const idempotencyKey = key("w021-ac05-replay");
    const first = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey,
    });
    expect(first.created).toBe(true);
    const runsAfterFirst = (
      await harness.runtime.campaignMatchingService.listMatchRuns(
        operatorCtx(harness, "w021-ac05-replay-1"),
        harness.organizationScopeId,
      )
    ).length;
    const auditAfterFirst = await auditCount("campaign_match.recorded");

    const replay = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey,
    });
    expect(replay.created).toBe(false);
    // Byte-identical record.
    expect(JSON.stringify(replay.run)).toBe(JSON.stringify(first.run));
    // No new run record, no new audit event.
    const runsAfterReplay = (
      await harness.runtime.campaignMatchingService.listMatchRuns(
        operatorCtx(harness, "w021-ac05-replay-2"),
        harness.organizationScopeId,
      )
    ).length;
    expect(runsAfterReplay).toBe(runsAfterFirst);
    expect(await auditCount("campaign_match.recorded")).toBe(auditAfterFirst);

    // A DIFFERENT key creates a new run — still no cross-domain state.
    const second = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac05-second"),
    });
    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
    expect(
      (
        await harness.runtime.inventoryService.listPlacements(
          operatorCtx(harness, "w021-ac05-second-placements"),
          harness.organizationScopeId,
          { campaignId: campaign.id },
        )
      ).length,
    ).toBe(0);
  });

  test("the matching boundary carries no mutation surface beyond the run record (structural scan)", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/campaigns/matching-engine.ts",
      "src/campaigns/matching-service.ts",
      "src/campaigns/authority-match-run-repository.ts",
    ];
    const FORBIDDEN = [
      "createPlacement",
      "retirePlacement",
      "retireInventoryItem",
      "registerInventoryItem",
      "attachSupplyVerification",
      "activateCampaign",
      "pauseCampaign",
      "completeCampaign",
      "cancelCampaign",
      "defineCampaignPolicy",
      "recordBudgetCommitment",
      "recordClearingExecution",
      "requestTransition",
      "recordSnapshot",
      "recordInput",
      "activateControl",
      "postEntry",
      "allocateRewards",
      "issueCredits",
      "recordCashObligation",
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(
          content.includes(pattern),
          `${file} must not call ${pattern}`,
        ).toBe(false);
      }
    }
  });
});
