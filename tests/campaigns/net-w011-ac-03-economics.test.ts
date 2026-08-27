/**
 * NET-W011-AC-03 — Economic commitments and clearing use the
 * canonical settlement authority; no hidden ledger is introduced.
 *
 * Evidence: the budget commitment is the settlement authority's stake
 * escrow (purpose campaign_budget:{campaignId}, COMMITTED, exact
 * declared amount, credits→stake_escrow postings owned by
 * /settlement); the campaign record carries only REFERENCES; a
 * positive declared budget BLOCKS activation until the escrow is
 * committed; a second commitment is refused; the release flows
 * through settlement first (recording before release is rejected) and
 * only after a terminal status; the campaign domain has NO balances.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW011Harness,
  createCampaign,
  definePolicy,
  commitDefaultBudget,
  releaseDefaultBudget,
  ownerCtx,
  otherCtx,
  key,
  type NetW011Harness,
} from "./_net-w011-harness.ts";
import { ensureCreditsFor } from "../disputes/_net-w010-harness.ts";

let harness: NetW011Harness;

beforeAll(async () => {
  harness = await createNetW011Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W011-AC-03 canonical settlement economics (no hidden ledger)", () => {
  test("the budget commitment IS the settlement stake escrow (campaign_budget purpose)", async () => {
    const campaign = await createCampaign(harness);
    const policy = await definePolicy(harness, campaign, {
      totalAmount: 25,
    });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 25);
    const recorded = await commitDefaultBudget(harness, campaign);

    // The campaign block references the settlement record.
    expect(recorded.budget.stakeId).toBeTruthy();
    expect(recorded.budget.committedAmount).toBe(25);
    expect(recorded.budget.committedAt).toBeTruthy();
    expect(recorded.budget.releasedAt).toBeNull();

    // The SETTLEMENT authority holds the authoritative escrow.
    const stake = await harness.runtime.stakeService.getStake(
      ownerCtx(harness, "w011-ac03-stake"),
      recorded.budget.stakeId!,
    );
    expect(stake.purpose).toEqual({
      kind: "campaign_budget",
      id: campaign.id,
    });
    expect(stake.ownerPersonId).toBe(campaign.ownerPersonId);
    expect(stake.amount).toBe(25);
    expect(stake.unit).toBe("credits");
    expect(stake.state).toBe("COMMITTED");
    expect(stake.organizationScopeId).toBe(harness.organizationScopeId);
    void policy;
  });

  test("a positive declared budget BLOCKS activation until the escrow is committed", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 40 });
    let threw: unknown;
    try {
      await harness.runtime.campaignService.activateCampaign(
        ownerCtx(harness, "w011-ac03-gate"),
        { campaignId: campaign.id, idempotencyKey: key("w011-ac03-gate") },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "must be committed through the settlement authority",
    );
    // Commit the escrow, then activation passes.
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 40);
    await commitDefaultBudget(harness, campaign);
    const activated = await harness.runtime.campaignService.activateCampaign(
      ownerCtx(harness, "w011-ac03-gate2"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac03-gate2") },
    );
    expect(activated.status).toBe("ACTIVE");
  });

  test("the recorded commitment must match the declared total exactly (no partial commitments)", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 60 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 200);
    const ctx = ownerCtx(harness, "w011-ac03-partial");
    // A stake of the WRONG amount (30, not 60).
    const wrongStake = await harness.runtime.stakeService.commitStake(ctx, {
      organizationScopeId: campaign.organizationScopeId,
      ownerPersonId: campaign.ownerPersonId,
      amount: 30,
      purpose: { kind: "campaign_budget", id: campaign.id },
      idempotencyKey: `${key("w011-ac03-wrong")}:stake`,
    });
    let threw: unknown;
    try {
      await harness.runtime.campaignService.recordBudgetCommitment(ctx, {
        campaignId: campaign.id,
        stakeId: wrongStake.stake.id,
        idempotencyKey: key("w011-ac03-partial-record"),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "must equal the declared budget total",
    );
    // Wrong purpose linkage is refused too.
    const foreign = await createCampaign(harness);
    await definePolicy(harness, foreign, { totalAmount: 60 });
    let purposeThrew: unknown;
    try {
      await harness.runtime.campaignService.recordBudgetCommitment(ctx, {
        campaignId: foreign.id,
        stakeId: wrongStake.stake.id,
        idempotencyKey: key("w011-ac03-purpose"),
      });
    } catch (err) {
      purposeThrew = err;
    }
    expect(purposeThrew).toBeDefined();
    expect((purposeThrew as { message?: string }).message).toContain(
      "purpose must be campaign_budget",
    );
  });

  test("one budget commitment per campaign (the second is refused)", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 15 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 100);
    await commitDefaultBudget(harness, campaign);
    let threw: unknown;
    try {
      await commitDefaultBudget(harness, campaign, {
        idempotencyKey: key("w011-ac03-double"),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    // Either the campaign gate or the settlement uniqueness fired.
    const message = (threw as { message?: string }).message ?? "";
    expect(
      message.includes("already carries a budget commitment") ||
        message.includes("already carries a COMMITTED stake"),
    ).toBe(true);
  });

  test("a non-owner cannot record budget bookkeeping", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 10 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 10);
    const ctx = ownerCtx(harness, "w011-ac03-owner");
    const staked = await harness.runtime.stakeService.commitStake(ctx, {
      organizationScopeId: campaign.organizationScopeId,
      ownerPersonId: campaign.ownerPersonId,
      amount: 10,
      purpose: { kind: "campaign_budget", id: campaign.id },
      idempotencyKey: `${key("w011-ac03-owner")}:stake`,
    });
    let threw: unknown;
    try {
      await harness.runtime.campaignService.recordBudgetCommitment(
        otherCtx(harness, "w011-ac03-not-owner"),
        {
          campaignId: campaign.id,
          stakeId: staked.stake.id,
          idempotencyKey: key("w011-ac03-not-owner"),
        },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { code?: string }).code).toBe("CAMPAIGN_FORBIDDEN");
  });

  test("the release flows through settlement FIRST (recording before release is rejected)", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 20 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 20);
    const committed = await commitDefaultBudget(harness, campaign);
    // Cancel to reach a terminal status WITHOUT releasing the escrow.
    const cancelled = await harness.runtime.campaignService.cancelCampaign(
      ownerCtx(harness, "w011-ac03-cancel"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac03-cancel") },
    );
    expect(cancelled.status).toBe("CANCELLED");
    // Attempting to record a release while the escrow is still
    // COMMITTED is refused (settlement must execute first).
    let threw: unknown;
    try {
      await harness.runtime.campaignService.recordBudgetRelease(
        ownerCtx(harness, "w011-ac03-order"),
        {
          campaignId: campaign.id,
          stakeId: committed.budget.stakeId!,
          idempotencyKey: key("w011-ac03-order"),
        },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "settlement authority must release the escrow",
    );
  });

  test("a non-terminal campaign cannot release its budget", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 12 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 12);
    const committed = await commitDefaultBudget(harness, campaign);
    let threw: unknown;
    try {
      await harness.runtime.campaignService.recordBudgetRelease(
        ownerCtx(harness, "w011-ac03-nonterminal"),
        {
          campaignId: campaign.id,
          stakeId: committed.budget.stakeId!,
          idempotencyKey: key("w011-ac03-nonterminal"),
        },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "terminal status",
    );
  });

  test("the full release cycle: terminal → settlement release → recorded → RELEASED escrow", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 18 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 18);
    await commitDefaultBudget(harness, campaign);
    await harness.runtime.campaignService.activateCampaign(
      ownerCtx(harness, "w011-ac03-activate"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac03-activate") },
    );
    await harness.runtime.campaignService.completeCampaign(
      ownerCtx(harness, "w011-ac03-complete"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac03-complete") },
    );
    const released = await releaseDefaultBudget(harness, campaign);
    expect(released.budget.releasedAt).toBeTruthy();
    expect(released.budget.stakeId).toBeTruthy();
    const stake = await harness.runtime.stakeService.getStake(
      ownerCtx(harness, "w011-ac03-released"),
      released.budget.stakeId!,
    );
    expect(stake.state).toBe("RELEASED");
    // Double release is refused.
    let threw: unknown;
    try {
      await releaseDefaultBudget(harness, campaign, {
        idempotencyKey: key("w011-ac03-double-release"),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
  });

  test("a committed escrow caps later policy versions (no silent activation-on-credit)", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, { totalAmount: 20 });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 20);
    await commitDefaultBudget(harness, campaign);
    let threw: unknown;
    try {
      await definePolicy(harness, campaign, { totalAmount: 100 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "exceeding the committed escrow",
    );
  });

  test("clearing rules are declared policy only — settlement reward policies are untouched by campaigns", async () => {
    const campaign = await createCampaign(harness);
    const policy = await definePolicy(harness, campaign, {
      totalAmount: 22,
    });
    // The clearing rule references the reward policy lineage...
    const rule = policy.clearingRules[0]!;
    expect(rule.drawKind).toBe("reward_allocation");
    expect(rule.rewardPolicyId).toBeTruthy();
    // ...and the settlement lineage itself is intact and readable.
    const versions =
      await harness.runtime.rewardPolicyService.listPolicyVersions(
        ownerCtx(harness, "w011-ac03-clearing"),
        rule.rewardPolicyId!,
      );
    expect(versions.length).toBe(1);
    // No campaign draw executed (NET-W014 owns execution).
    const allocations = await harness.runtime.rewardService.listAllocations(
      ownerCtx(harness, "w011-ac03-clearing"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === campaign.id).length,
    ).toBe(0);
  });
});
