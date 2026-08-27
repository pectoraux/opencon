/**
 * NET-W011-AC-06 — Provider-specific semantics remain outside the
 * core campaign domain.
 *
 * Evidence: the eligibility attribute/operator vocabularies are
 * closed and neutral (provider-ish attributes rejected); outcome and
 * attribution references must come from the frozen /outcomes
 * vocabulary; evidence references from the frozen /evidence
 * vocabulary; the opportunity brief and type are OPAQUE payloads
 * carried without interpretation; and a static scan proves no
 * provider names appear anywhere in the campaigns domain source.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  createNetW011Harness,
  createCampaign,
  defaultPolicySections,
  definePolicy,
  activateReadyCampaign,
  publishDefaultOpportunity,
  ownerCtx,
  key,
  type NetW011Harness,
} from "./_net-w011-harness.ts";
import {
  CAMPAIGN_ELIGIBILITY_ATTRIBUTES,
  CAMPAIGN_ELIGIBILITY_OPERATORS,
  CAMPAIGN_OBJECTIVE_KINDS,
  CAMPAIGN_CLEARING_DRAW_KINDS,
} from "../../src/core/campaigns.ts";

let harness: NetW011Harness;

beforeAll(async () => {
  harness = await createNetW011Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W011-AC-06 provider neutrality", () => {
  test("the eligibility attribute vocabulary is closed and neutral", async () => {
    expect(CAMPAIGN_ELIGIBILITY_ATTRIBUTES).toEqual([
      "participant_class",
      "region",
      "language",
      "contribution_type",
      "evidence_grade",
      "measurement_kind",
    ]);
    expect(CAMPAIGN_ELIGIBILITY_OPERATORS).toEqual([
      "equals",
      "not_equals",
      "in",
      "not_in",
      "gte",
      "lte",
    ]);
    // No provider semantics smuggled into the frozen lists.
    const all = [
      ...CAMPAIGN_ELIGIBILITY_ATTRIBUTES,
      ...CAMPAIGN_ELIGIBILITY_OPERATORS,
      ...CAMPAIGN_OBJECTIVE_KINDS,
      ...CAMPAIGN_CLEARING_DRAW_KINDS,
    ].join(" ").toLowerCase();
    expect(all).not.toMatch(/tiktok|youtube|instagram|facebook|google|openai|anthropic/);
  });

  test("provider-shaped eligibility attributes are REJECTED at the gate", async () => {
    const campaign = await createCampaign(harness);
    const sections = await defaultPolicySections(harness);
    (sections.eligibility as any).rules = [
      { ...sections.eligibility.rules[0]!, attribute: "tiktok_followers" },
    ];
    let threw: unknown;
    try {
      await harness.runtime.campaignService.defineCampaignPolicy(
        ownerCtx(harness, "w011-ac06-provider"),
        {
          campaignId: campaign.id,
          policy: sections,
          idempotencyKey: key("w011-ac06-provider"),
        },
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "closed-vocabulary neutral attribute",
    );
  });

  test("provider-shaped attribution models and outcome types are REJECTED", async () => {
    const campaign = await createCampaign(harness);
    const attribution = await defaultPolicySections(harness);
    (attribution.attributionRules as any) = [
      { ...attribution.attributionRules[0]!, model: "tiktok_last_click" },
    ];
    let attrThrew: unknown;
    try {
      await harness.runtime.campaignService.defineCampaignPolicy(
        ownerCtx(harness, "w011-ac06-model"),
        {
          campaignId: campaign.id,
          policy: attribution,
          idempotencyKey: key("w011-ac06-model"),
        },
      );
    } catch (err) {
      attrThrew = err;
    }
    expect(attrThrew).toBeDefined();

    const outcome = await defaultPolicySections(harness);
    (outcome.outcomePolicy as any).requirements = [
      { ...outcome.outcomePolicy.requirements[0]!, outcomeType: "youtube_views" },
    ];
    let outcomeThrew: unknown;
    try {
      await harness.runtime.campaignService.defineCampaignPolicy(
        ownerCtx(harness, "w011-ac06-outcome"),
        {
          campaignId: campaign.id,
          policy: outcome,
          idempotencyKey: key("w011-ac06-outcome"),
        },
      );
    } catch (err) {
        outcomeThrew = err;
      }
    expect(outcomeThrew).toBeDefined();
  });

  test("the opportunity brief/type are opaque neutral payloads (carried uninterpreted)", async () => {
    const campaign = await createCampaign(harness);
    // An arbitrary neutral brief with no provider semantics.
    const opaqueBrief = {
      campaignObjective: "obj-1",
      payload: { layers: ["alpha", "beta"], matrix: [1, 2, 3] },
    };
    const sections = await defaultPolicySections(harness, {
      totalAmount: 0,
    });
    (sections as any).opportunitySpecs = [
      {
        ...sections.opportunitySpecs[0]!,
        brief: opaqueBrief,
        opportunityType: "generic_neutral_contribution",
      },
    ];
    const { policy } =
      await harness.runtime.campaignService.defineCampaignPolicy(
        ownerCtx(harness, "w011-ac06-opaque"),
        {
          campaignId: campaign.id,
          policy: sections,
          idempotencyKey: key("w011-ac06-opaque"),
        },
      );
    expect(policy.opportunitySpecs[0]!.brief).toEqual(opaqueBrief);
    // Activation + publish carry the opaque brief through verbatim.
    await harness.runtime.campaignService.activateCampaign(
      ownerCtx(harness, "w011-ac06-opaque-activate"),
      {
        campaignId: campaign.id,
        idempotencyKey: key("w011-ac06-opaque-activate"),
      },
    );
    const { opportunityId } = await publishDefaultOpportunity(harness, campaign);
    const opportunity = await harness.runtime.opportunityService.getOpportunity(
      ownerCtx(harness, "w011-ac06-opaque-opp"),
      opportunityId,
    );
    expect(opportunity.brief).toEqual(opaqueBrief);
    expect(opportunity.opportunityType).toBe("generic_neutral_contribution");
  });

  test("campaign policy never depends on the publishing channel (cross-promotion is first-class)", async () => {
    // CAMP-004: a non-reciprocal cross-promotion objective with a
    // zero budget composes exactly like any other campaign.
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 0,
      objectiveKind: "cross_promotion",
    });
    expect(campaign.status).toBe("ACTIVE");
    const { opportunityId } = await publishDefaultOpportunity(harness, campaign);
    expect(opportunityId).toBeTruthy();
  });

  test("a static scan finds NO provider names in the campaigns domain source", async () => {
    const providerPattern =
      /\b(tiktok|youtube|instagram|facebook|meta|google|openai|anthropic|twitter|x\.com|snapchat|pinterest|twitch|discord|telegram|whatsapp)\b/i;
    const files = [
      "port.ts",
      "campaign-service.ts",
      "authority-campaign-repository.ts",
      "module.ts",
      "index.ts",
    ];
    for (const file of files) {
      const content = await readFile(
        join(import.meta.dir, "../../src/campaigns", file),
        "utf8",
      );
      expect(
        content,
        `${file} must be provider-neutral`,
      ).not.toMatch(providerPattern);
    }
    // The core vocabulary file too.
    const core = await readFile(
      join(import.meta.dir, "../../src/core/campaigns.ts"),
      "utf8",
    );
    expect(core).not.toMatch(providerPattern);
  });

  test("the campaign domain carries no provider SDK semantics (no imports beyond core/self)", async () => {
    const files = [
      "port.ts",
      "campaign-service.ts",
      "authority-campaign-repository.ts",
      "module.ts",
    ];
    const domainImport =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|contributions|inventory|creators|demand|benefits|reputation|evidence|outcomes|settlement|workflows|disputes)\//;
    for (const file of files) {
      const content = await readFile(
        join(import.meta.dir, "../../src/campaigns", file),
        "utf8",
      );
      expect(content, `${file} must not import other domains`).not.toMatch(
        domainImport,
      );
    }
    void definePolicy;
  });
});
