/**
 * NET-W034-AC-01 — Advertiser/campaign authority (issue #69 §5 AC-01).
 *
 * The deterministic advertiser fixture resolves one ACTIVE campaign
 * and one explicit pinned policy version containing the objective,
 * measurement/evidence requirements and clearing rule used by the
 * scenario. Cross-tenant/unauthorized access fails closed. Campaign
 * state is mutated only through /campaigns.
 *  - the ACTIVE campaign + pinned policy v1 with the objective,
 *    outcome policy (view/deterministic), evidence policy (PoV,
 *    ATTESTED, platform) and the clearing rule wired to a REAL reward
 *    policy (all read through /campaigns);
 *  - the advertiser owner authorization (the owner-only gate on every
 *    policy/status mutation — a non-owner fails closed);
 *  - the campaign audit lineage (created → policy_defined →
 *    budget_committed → activated, tx-bound);
 *  - the cross-tenant listing isolation + the DRAFT campaign
 *    fail-closed fixture;
 *  - the structural pin: the W034 surface mutates campaign state only
 *    through /campaigns (the sanctioned composites).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  createAdvertisingCampaign,
  registerScenarioSupply,
  key,
  personCtx,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-01 advertiser/campaign authority", () => {
  test("the deterministic fixture resolves ONE ACTIVE campaign with a pinned policy version", async () => {
    const ctx = harness.operatorCtx("w034-ac01-read");
    const campaign = await harness.runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.id).toBe(scenario.campaignId);
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.organizationScopeId).toBe(harness.organizationScopeId);
    // The advertiser owner is the operator (a real person actor).
    expect(campaign.ownerPersonId).toBe(harness.operatorPersonId);
    // The PINNED policy version: exactly version 1 is current.
    expect(campaign.currentPolicyVersion).toBe(1);
    const versions =
      await harness.runtime.campaignService.listPolicyVersions(
        ctx,
        campaign.id,
      );
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(scenario.campaignPolicyVersion).toBe(1);
  });

  test("the pinned policy version carries the objective + outcome/evidence requirements + the clearing rule the scenario uses", async () => {
    const ctx = harness.operatorCtx("w034-ac01-policy");
    const versions =
      await harness.runtime.campaignService.listPolicyVersions(
        ctx,
        scenario.campaignId,
      );
    const policy = versions[0]!;
    expect(policy.version).toBe(1);
    // The objective.
    expect(policy.objectives.map((o) => o.id)).toEqual(["obj-1"]);
    // The outcome policy: ONE deterministic view requirement — the
    // exact requirement the canonical delivery-notice measurement
    // satisfies.
    expect(policy.outcomePolicy.requirements).toEqual([
      {
        objectiveId: "obj-1",
        outcomeType: "view",
        attributionMode: "deterministic",
        windowDays: 30,
        requiresExperiment: false,
      },
    ]);
    // The evidence policy: a Proof-of-Value, ATTESTED minimum,
    // platform sources.
    expect(policy.evidencePolicy.requirements).toEqual([
      {
        objectiveId: "obj-1",
        requirementKind: "proof_of_value",
        minimumGrade: "ATTESTED",
        qualifyingSourceTypes: ["platform"],
      },
    ]);
    // The clearing rule: wired to a REAL same-scope reward policy.
    expect(policy.clearingRules).toEqual([
      {
        id: "clear-1",
        objectiveId: "obj-1",
        basis: "attributed_outcome",
        drawKind: "reward_allocation",
        rewardPolicyId: scenario.campaignRewardPolicyId,
        maxDrawAmount: 1000,
      },
    ]);
    // The reward policy itself resolves in /settlement (the real
    // lineage the clearing draws through).
    const rewardPolicy =
      await harness.runtime.rewardPolicyService.getPolicyVersion(
        ctx,
        scenario.campaignRewardPolicyId,
        1,
      );
    expect(rewardPolicy.policyId).toBe(scenario.campaignRewardPolicyId);
    // The budget covers the clearing cap (CAMP-002) and the escrow is
    // recorded on the campaign record.
    expect(policy.budget.totalAmount).toBe(1000);
    const campaign = await harness.runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.budget.stakeId).toBeTruthy();
    expect(campaign.budget.committedAmount).toBe(1000);
  });

  test("the campaign audit lineage is complete, ordered and transaction-bound", async () => {
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      resourceType: "campaign",
      resourceId: scenario.campaignId,
    });
    const types = events.map((e) => e.eventType);
    expect(types).toContain("campaign.created");
    expect(types).toContain("campaign.budget_committed");
    expect(types).toContain("campaign.activated");
    expect(types).toContain("campaign.opportunity_published");
    // The committed order: created FIRST, activated AFTER the budget
    // commitment, the opportunity publication AFTER activation, the
    // clearing execution LAST (the campaign bookkeeping joins the
    // clearing transaction through the neutral port).
    const pos = (t: string) => types.indexOf(t);
    expect(pos("campaign.created")).toBeLessThan(
      pos("campaign.budget_committed"),
    );
    expect(pos("campaign.budget_committed")).toBeLessThan(
      pos("campaign.activated"),
    );
    expect(pos("campaign.activated")).toBeLessThan(
      pos("campaign.opportunity_published"),
    );
    expect(pos("campaign.opportunity_published")).toBeLessThan(
      pos("campaign.clearing_executed"),
    );
    // Every material mutation carries the authoritative transaction id.
    for (const event of events) {
      expect(typeof event.metadata?.transactionId).toBe("string");
    }
    // The campaign's own event history is append-only and complete.
    const ctx = harness.operatorCtx("w034-ac01-history");
    const campaign = await harness.runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.events.map((e) => e.event)).toEqual([
      "created",
      "policy_defined",
      "budget_committed",
      "activated",
      "opportunity_published",
      "clearing_executed",
    ]);
  });

  test("the owner-only gate: a NON-owner cannot mutate campaign policy/status (fail closed)", async () => {
    // The creator (a different person in the same org) attempts the
    // owner-only opportunity publication on the scenario campaign.
    const creatorCtx = harness.creatorCtx("w034-ac01-non-owner");
    await expect(
      harness.runtime.campaignService.recordOpportunityPublication(
        creatorCtx,
        {
          campaignId: scenario.campaignId,
          specId: "spec-1",
          policyVersion: 1,
          opportunityId: scenario.opportunityId,
          idempotencyKey: key("w034-ac01-non-owner"),
        },
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_FORBIDDEN" });
    // The campaign record is unchanged (still exactly one published
    // opportunity event).
    const campaign = await harness.runtime.campaignService.getCampaign(
      harness.operatorCtx("w034-ac01-non-owner-read"),
      scenario.campaignId,
    );
    expect(
      campaign.events.filter((e) => e.event === "opportunity_published"),
    ).toHaveLength(1);
  });

  test("a DRAFT (never-activated) campaign fails closed for the lifecycle entry path", async () => {
    // A DRAFT campaign: the policy exists, but activation never ran.
    const { campaign: draft } = await createAdvertisingCampaign(harness, {
      skipActivation: true,
    });
    const ctx = personCtx(harness, harness.operatorPersonId, "w034-ac01-draft");
    // The W011 opportunity-draft resolution requires the ACTIVE
    // publishable status (fail closed).
    await expect(
      harness.runtime.campaignService.resolveOpportunityDraft(
        ctx,
        draft.id,
        "spec-1",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // The W021 match against a DRAFT campaign fails closed too (the
    // ACTIVE-campaign resolution is a hard gate).
    const supply = await registerScenarioSupply(harness);
    await expect(
      harness.runtime.campaignMatchingService.runCampaignMatch(ctx, {
        organizationScopeId: harness.organizationScopeId,
        campaignId: draft.id,
        candidateInventoryItemIds: [supply.id],
        idempotencyKey: key("w034-ac01-draft-match"),
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_MATCH_VALIDATION" });
  });

  test("cross-tenant: a second-org actor cannot see or mutate the scenario campaign (fail closed)", async () => {
    // The tenant-scoped listing: the second org sees ONLY its own
    // campaigns — the scenario campaign is invisible.
    const secondCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w034-ac01-tenant",
    );
    const secondOrgCampaigns =
      await harness.runtime.campaignService.listCampaigns(
        secondCtx,
        harness.secondOrgId,
      );
    expect(
      secondOrgCampaigns.some((c) => c.id === scenario.campaignId),
    ).toBe(false);
    // The second-org actor cannot publish opportunities on the
    // first-org campaign (owner-only + cross-scope — fail closed).
    await expect(
      harness.runtime.campaignService.recordOpportunityPublication(
        secondCtx,
        {
          campaignId: scenario.campaignId,
          specId: "spec-1",
          policyVersion: 1,
          opportunityId: scenario.opportunityId,
          idempotencyKey: key("w034-ac01-cross-tenant"),
        },
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_FORBIDDEN" });
    // The composed clearing eligibility read fails closed for a
    // cross-scope tenant BEFORE any view resolves (the value record
    // is the tenant anchor — no existence oracle, silent NOT_FOUND).
    await expect(
      harness.runtime.apiCommands.evaluateCrossPromotionClearing(
        secondCtx,
        {
          organizationScopeId: harness.secondOrgId,
          sourceContributionId: scenario.contribution.id,
          targetPlacementId: scenario.placementId,
          valueRecordId: scenario.matureValue.id,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
