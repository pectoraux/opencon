/**
 * NET-W011-AC-02 — Objectives, eligibility, outcome/evidence policy,
 * budgets, attribution, and clearing rules are explicit and versioned.
 *
 * Evidence: policy versions are immutable lineage records (version =
 * latest+1, never rewritten); every section is validated against the
 * frozen vocabularies (closed objective kinds, neutral eligibility
 * attributes/operators, frozen outcome types/attribution modes,
 * frozen evidence grades/source types, economic arithmetic, the
 * incremental-conversion experimental constraint, clearing caps
 * within the budget, reward-policy resolution); the CAMP-002
 * activation gate requires a complete policy with ≥1 opportunity
 * spec.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW011Harness,
  createCampaign,
  definePolicy,
  defaultPolicySections,
  ownerCtx,
  key,
  type NetW011Harness,
} from "./_net-w011-harness.ts";
import type { CampaignPolicySections } from "../../src/campaigns/port.ts";

let harness: NetW011Harness;

beforeAll(async () => {
  harness = await createNetW011Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/**
 * Define sections that MUST be rejected; returns the error. The
 * mutator receives a DEEP-CLONED mutable copy (the real sections are
 * deeply readonly).
 */
async function rejectedDefine(
  mutate: (sections: any) => any,
): Promise<{ code?: string; message?: string }> {
  const campaign = await createCampaign(harness);
  const sections = await defaultPolicySections(harness);
  const mutated = mutate(JSON.parse(JSON.stringify(sections))) as CampaignPolicySections;
  let threw: unknown;
  try {
    await harness.runtime.campaignService.defineCampaignPolicy(
      ownerCtx(harness, "w011-ac02-reject"),
      {
        campaignId: campaign.id,
        policy: mutated,
        idempotencyKey: key("w011-ac02-reject"),
      },
    );
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeDefined();
  return threw as { code?: string; message?: string };
}

describe("NET-W011-AC-02 explicit versioned campaign policy", () => {
  test("a complete policy version stores every section explicitly (CAMP-002)", async () => {
    const campaign = await createCampaign(harness);
    const sections = await defaultPolicySections(harness, {
      totalAmount: 80,
    });
    const { policy, created } =
      await harness.runtime.campaignService.defineCampaignPolicy(
        ownerCtx(harness, "w011-ac02-define"),
        {
          campaignId: campaign.id,
          policy: sections,
          idempotencyKey: key("w011-ac02-define"),
        },
      );
    expect(created).toBe(true);
    expect(policy.version).toBe(1);
    expect(policy.objectives).toEqual(sections.objectives);
    expect(policy.eligibility).toEqual(sections.eligibility);
    expect(policy.outcomePolicy).toEqual(sections.outcomePolicy);
    expect(policy.evidencePolicy).toEqual(sections.evidencePolicy);
    expect(policy.budget.totalAmount).toBe(80);
    expect(policy.attributionRules).toEqual(sections.attributionRules);
    expect(policy.clearingRules).toEqual(sections.clearingRules);
    expect(policy.opportunitySpecs).toEqual(sections.opportunitySpecs);
    // The campaign's mirror advanced.
    const fetched = await harness.runtime.campaignService.getCampaign(
      ownerCtx(harness, "w011-ac02-read"),
      campaign.id,
    );
    expect(fetched.currentPolicyVersion).toBe(1);
  });

  test("versions form an immutable lineage (latest+1, never rewritten)", async () => {
    const campaign = await createCampaign(harness);
    const v1 = await definePolicy(harness, campaign, { totalAmount: 30 });
    const v2 = await definePolicy(harness, campaign, { totalAmount: 30 });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);
    // v1 was NOT rewritten.
    const ctx = ownerCtx(harness, "w011-ac02-lineage");
    const v1Again = await harness.runtime.campaignService.getPolicyVersion(
      ctx,
      campaign.id,
      1,
    );
    expect(v1Again.createdAt).toBe(v1.createdAt);
    expect(v1Again.budget.totalAmount).toBe(30);
    // The lineage lists in order.
    const versions = await harness.runtime.campaignService.listPolicyVersions(
      ctx,
      campaign.id,
    );
    expect(versions.map((p) => p.version)).toEqual([1, 2]);
  });

  test("policy definition is idempotent (replay returns created:false)", async () => {
    const campaign = await createCampaign(harness);
    const idem = key("w011-ac02-idem");
    const sections = await defaultPolicySections(harness);
    const ctx = ownerCtx(harness, "w011-ac02-idem");
    const first = await harness.runtime.campaignService.defineCampaignPolicy(
      ctx,
      { campaignId: campaign.id, policy: sections, idempotencyKey: idem },
    );
    const replay = await harness.runtime.campaignService.defineCampaignPolicy(
      ctx,
      { campaignId: campaign.id, policy: sections, idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.policy.id).toBe(first.policy.id);
  });

  test("validation: unknown objective kinds and duplicate ids are rejected", async () => {
    await rejectedDefine(
      (s) => ((s.objectives[0]!.kind = "viral_splash"), s),
    );
    await rejectedDefine((s) => ((s.objectives[1] = s.objectives[0]), s));
    await rejectedDefine((s) => ((s.objectives = []), s));
  });

  test("validation: eligibility rules obey the closed neutral vocabularies", async () => {
    await rejectedDefine(
      (s) => ((s.eligibility.rules[0]!.attribute = "tiktok_followers"), s),
    );
    await rejectedDefine(
      (s) => ((s.eligibility.rules[0]!.operator = "matches_regex"), s),
    );
    await rejectedDefine(
      (s) => ((s.eligibility.rules[0]!.values = []), s),
    );
  });

  test("validation: outcome/evidence requirements reference the frozen authorities", async () => {
    await rejectedDefine(
      (s) => ((s.outcomePolicy.requirements[0]!.outcomeType = "virality"), s),
    );
    await rejectedDefine(
      (s) => ((s.outcomePolicy.requirements[0]!.attributionMode = "last_touch"), s),
    );
    await rejectedDefine(
      (s) => ((s.outcomePolicy.requirements[0]!.windowDays = 0), s),
    );
    await rejectedDefine(
      (s) => ((s.evidencePolicy.requirements[0]!.minimumGrade = "GOLD"), s),
    );
    await rejectedDefine(
      (s) =>
        ((s.evidencePolicy.requirements[0]!.qualifyingSourceTypes = [
          "platform",
          "scraped",
        ]),
        s),
    );
    await rejectedDefine(
      (s) => ((s.outcomePolicy.requirements[0]!.objectiveId = "obj-9"), s),
    );
  });

  test("validation: budget arithmetic obeys the frozen economic validators", async () => {
    await rejectedDefine(
      (s) => ((s.budget.totalAmount = -5), s),
    );
    await rejectedDefine(
      (s) => ((s.budget.unit = "dollars"), s),
    );
    // Envelope sum exceeding the total.
    await rejectedDefine((s) => ((s.budget.perObjective[0]!.amount = 1000), s));
  });

  test("validation: attribution rules enforce confidence + the incremental constraint", async () => {
    await rejectedDefine(
      (s) => ((s.attributionRules[0]!.confidenceThreshold = 1.5), s),
    );
    await rejectedDefine(
      (s) => ((s.attributionRules[0]!.model = "last_touch"), s),
    );
    // incremental_conversion REQUIRES experimental + experiment.
    await rejectedDefine(
      (s) => ((s.objectives[0]!.kind = "incremental_conversion"), s),
    );
  });

  test("validation: clearing rules cap within the budget and resolve their reward policies", async () => {
    // Caps exceeding the declared total.
    await rejectedDefine(
      (s) => ((s.clearingRules[0]!.maxDrawAmount = 500), s),
    );
    // reward_allocation without a reward policy reference.
    await rejectedDefine(
      (s) => ((s.clearingRules[0]!.rewardPolicyId = null), s),
    );
    // A reward policy from ANOTHER org does not resolve same-scope.
    const foreign = await createCampaign(harness);
    const foreignSections = await defaultPolicySections(harness, {
      rewardPolicyScope: "second-org",
    });
    let foreignThrew: unknown;
    try {
      await harness.runtime.campaignService.defineCampaignPolicy(
        ownerCtx(harness, "w011-ac02-foreign"),
        {
          campaignId: foreign.id,
          policy: foreignSections,
          idempotencyKey: key("w011-ac02-foreign"),
        },
      );
    } catch (err) {
      foreignThrew = err;
    }
    expect(foreignThrew).toBeDefined();
    expect((foreignThrew as { message?: string }).message).toContain(
      "organization scope",
    );
  });

  test("the CAMP-002 activation gate: no policy → no activation", async () => {
    const campaign = await createCampaign(harness);
    let threw: unknown;
    try {
      await harness.runtime.campaignService.activateCampaign(
        ownerCtx(harness, "w011-ac02-gate"),
        { campaignId: campaign.id, idempotencyKey: key("w011-ac02-gate") },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { code?: string }).code).toBe("CAMPAIGN_VALIDATION");
    expect((threw as { message?: string }).message).toContain("CAMP-002");
  });

  test("the activation gate: a policy without opportunity specs cannot activate", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, {
      totalAmount: 0,
      withSpec: false,
    });
    let threw: unknown;
    try {
      await harness.runtime.campaignService.activateCampaign(
        ownerCtx(harness, "w011-ac02-spec-gate"),
        {
          campaignId: campaign.id,
          idempotencyKey: key("w011-ac02-spec-gate"),
        },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "no contribution opportunity spec",
    );
  });

  test("a zero-budget cross-promotion policy needs no escrow (CAMP-004)", async () => {
    const campaign = await createCampaign(harness);
    await definePolicy(harness, campaign, {
      totalAmount: 0,
      objectiveKind: "cross_promotion",
    });
    const activated = await harness.runtime.campaignService.activateCampaign(
      ownerCtx(harness, "w011-ac02-zero"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac02-zero") },
    );
    expect(activated.status).toBe("ACTIVE");
    expect(activated.budget.stakeId).toBeNull();
  });
});
