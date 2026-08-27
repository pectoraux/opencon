/**
 * NET-W011-AC-04 — Campaign workflow composition preserves
 * `/workflows` lifecycle authority and downstream domain ownership.
 *
 * Evidence: publishing composes a REAL Opportunity through the
 * opportunities boundary (DRAFT, version 0) carrying the exact
 * versioned eligibility reference
 * `campaign_policy:{campaignId}:{version}:{specId}`; publication is
 * recorded with read-only verification (scope/type/reference);
 * publishing requires ACTIVE (DRAFT/PAUSED refused); lifecycle
 * transitions of the published opportunity still flow EXCLUSIVELY
 * through the workflow service (the campaign record gains no
 * lifecycle fields); the campaign references opportunities — it never
 * owns their state.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW011Harness,
  createCampaign,
  definePolicy,
  commitDefaultBudget,
  publishDefaultOpportunity,
  activateReadyCampaign,
  ownerCtx,
  otherCtx,
  key,
  type NetW011Harness,
} from "./_net-w011-harness.ts";
import { ensureCreditsFor } from "../disputes/_net-w010-harness.ts";
import { campaignEligibilityPolicyReference } from "../../src/core/campaigns.ts";

void ensureCreditsFor;

let harness: NetW011Harness;

beforeAll(async () => {
  harness = await createNetW011Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W011-AC-04 /workflows keeps the lifecycle authority", () => {
  test("publishing composes a real opportunity with the exact versioned eligibility reference", async () => {
    const campaign = await createCampaign(harness);
    const policy = await definePolicy(harness, campaign, {
      totalAmount: 10,
    });
    await ensureCreditsFor(harness.w010, harness.ownerPersonId, 10);
    await commitDefaultBudget(harness, campaign);
    await harness.runtime.campaignService.activateCampaign(
      ownerCtx(harness, "w011-ac04-activate"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac04-activate") },
    );

    const { campaign: updated, opportunityId } =
      await publishDefaultOpportunity(harness, campaign);
    // The publication is recorded on the campaign (append-only).
    expect(updated.events.map((e) => e.event)).toContain(
      "opportunity_published",
    );

    // The composed opportunity is a REAL lifecycle subject owned by
    // the opportunities/workflows boundaries.
    const opportunity = await harness.runtime.opportunityService.getOpportunity(
      ownerCtx(harness, "w011-ac04-opp"),
      opportunityId,
    );
    expect(opportunity.state).toBe("DRAFT");
    expect(opportunity.version).toBe(0);
    expect(opportunity.opportunityType).toBe("campaign_contribution");
    expect(opportunity.ownerId).toBe(campaign.ownerPersonId);
    expect(opportunity.eligibilityPolicyReference).toBe(
      campaignEligibilityPolicyReference(campaign.id, policy.version, "spec-1"),
    );
    expect(opportunity.brief).toEqual({
      campaignObjective: "obj-1",
      neutral: true,
    });
  });

  test("the derived listing carries only references (no lifecycle fields)", async () => {
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 10,
    });
    const { opportunityId } = await publishDefaultOpportunity(harness, campaign);
    const listed =
      await harness.runtime.campaignService.listPublishedOpportunities(
        ownerCtx(harness, "w011-ac04-list"),
        campaign.id,
      );
    expect(listed.length).toBe(1);
    expect(listed[0]!.opportunityId).toBe(opportunityId);
    expect(listed[0]!.specId).toBe("spec-1");
    expect(listed[0]!.policyVersion).toBe(1);
    // References only: no state, no version, no lifecycle fields.
    expect(Object.keys(listed[0]!).sort()).toEqual([
      "opportunityId",
      "policyVersion",
      "publishedAt",
      "specId",
    ]);
  });

  test("publishing requires an ACTIVE campaign (DRAFT and PAUSED are refused)", async () => {
    // DRAFT: no policy yet → resolveOpportunityDraft refuses.
    const draft = await createCampaign(harness);
    let draftThrew: unknown;
    try {
      await harness.runtime.campaignService.resolveOpportunityDraft(
        ownerCtx(harness, "w011-ac04-draft"),
        draft.id,
        "spec-1",
      );
    } catch (err) {
      draftThrew = err;
    }
    expect(draftThrew).toBeDefined();

    // PAUSED: full setup, activate, pause, then refuse.
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 10,
    });
    const paused = await harness.runtime.campaignService.pauseCampaign(
      ownerCtx(harness, "w011-ac04-pause"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac04-pause") },
    );
    expect(paused.status).toBe("PAUSED");
    let pausedThrew: unknown;
    try {
      await harness.runtime.campaignService.resolveOpportunityDraft(
        ownerCtx(harness, "w011-ac04-paused"),
        campaign.id,
        "spec-1",
      );
    } catch (err) {
      pausedThrew = err;
    }
    expect(pausedThrew).toBeDefined();
    expect((pausedThrew as { message?: string }).message).toContain("ACTIVE");
    // Resume reopens publishing.
    const resumed = await harness.runtime.campaignService.resumeCampaign(
      ownerCtx(harness, "w011-ac04-resume"),
      { campaignId: campaign.id, idempotencyKey: key("w011-ac04-resume") },
    );
    expect(resumed.status).toBe("ACTIVE");
    const draft2 = await harness.runtime.campaignService.resolveOpportunityDraft(
      ownerCtx(harness, "w011-ac04-resumed"),
      campaign.id,
      "spec-1",
    );
    expect(draft2.specId).toBe("spec-1");
  });

  test("an unknown spec cannot be published", async () => {
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 10,
    });
    let threw: unknown;
    try {
      await harness.runtime.campaignService.resolveOpportunityDraft(
        ownerCtx(harness, "w011-ac04-unknown"),
        campaign.id,
        "spec-does-not-exist",
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { code?: string }).code).toBe("NOT_FOUND");
  });

  test("publication verification refuses a mismatched eligibility reference", async () => {
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 10,
    });
    const ctx = ownerCtx(harness, "w011-ac04-mismatch");
    // An opportunity created with the WRONG reference (simulating a
    // composition root that bypassed the draft).
    const rogue = await harness.runtime.opportunityService.createOpportunity(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: campaign.ownerPersonId,
        opportunityType: "campaign_contribution",
        title: "Rogue",
        brief: { campaignObjective: "obj-1", neutral: true },
        eligibilityPolicyReference: "campaign_policy:wrong:9:spec-1",
        contributionRequirements: { minEffort: "one verified action" },
        evidenceReferencePlaceholders: ["evidence-outcome-claim"],
      },
    );
    let threw: unknown;
    try {
      await harness.runtime.campaignService.recordOpportunityPublication(ctx, {
        campaignId: campaign.id,
        specId: "spec-1",
        policyVersion: 1,
        opportunityId: rogue.id,
        idempotencyKey: key("w011-ac04-mismatch"),
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect((threw as { message?: string }).message).toContain(
      "eligibility reference must be",
    );
  });

  test("a non-owner cannot publish (the RECORD step is owner-gated)", async () => {
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 10,
    });
    // resolveOpportunityDraft is a read (no owner gate) — the RECORD
    // step is the owner-gated mutation.
    const draft = await harness.runtime.campaignService.resolveOpportunityDraft(
      otherCtx(harness, "w011-ac04-not-owner"),
      campaign.id,
      "spec-1",
    );
    const rogue = await harness.runtime.opportunityService.createOpportunity(
      otherCtx(harness, "w011-ac04-not-owner"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: campaign.ownerPersonId,
        opportunityType: draft.opportunityType,
        title: draft.title,
        brief: draft.brief,
        eligibilityPolicyReference: draft.eligibilityPolicyReference,
        contributionRequirements: draft.contributionRequirements,
        evidenceReferencePlaceholders: draft.evidenceReferencePlaceholders,
      },
    );
    let recordThrew: unknown;
    try {
      await harness.runtime.campaignService.recordOpportunityPublication(
        otherCtx(harness, "w011-ac04-not-owner"),
        {
          campaignId: campaign.id,
          specId: "spec-1",
          policyVersion: 1,
          opportunityId: rogue.id,
          idempotencyKey: key("w011-ac04-not-owner"),
        },
      );
    } catch (err) {
      recordThrew = err;
    }
    expect(recordThrew).toBeDefined();
    expect((recordThrew as { code?: string }).code).toBe("CAMPAIGN_FORBIDDEN");
  });

  test("lifecycle transitions of the published opportunity flow ONLY through /workflows", async () => {
    const campaign = await activateReadyCampaign(harness, {
      totalAmount: 10,
    });
    const { opportunityId } = await publishDefaultOpportunity(harness, campaign);

    // The transition goes through the workflow service (the sole
    // lifecycle authority) and succeeds for the opportunity owner.
    const ctx = ownerCtx(harness, "w011-ac04-transition");
    const transition = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opportunityId,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: key("w011-ac04-transition"),
        actorPersonId: campaign.ownerPersonId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(transition.subject.state).toBe("READY");
    expect(transition.subject.version).toBe(1);

    // The campaign record did NOT gain lifecycle knowledge: its event
    // history still ends with the publication event and carries no
    // transition entries.
    const after = await harness.runtime.campaignService.getCampaign(
      ctx,
      campaign.id,
    );
    expect(after.events.map((e) => e.event)).not.toContain("transition");
    expect(after.status).toBe("ACTIVE");
    // And the published listing is unaffected (references only).
    const listed = await harness.runtime.campaignService.listPublishedOpportunities(
      ctx,
      campaign.id,
    );
    expect(listed[0]!.opportunityId).toBe(opportunityId);
  });
});
