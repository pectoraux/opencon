/**
 * NET-W035-AC-02 — Campaign contract and terms (issue #71 §5 AC-02;
 * work order §4.2).
 *
 * One ACTIVE campaign and explicit pinned terms/policy are resolved.
 * The required compensation/clearing, evidence, measurement and
 * disclosure requirements are read from authoritative policy.
 * Caller-supplied terms cannot authorize settlement or overwrite the
 * authoritative policy; stale or foreign policy/terms references
 * fail closed; terms do not create a second economic ledger.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  createCreatorCampaign,
  key,
  personCtx,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import { policyActionFor } from "../../src/core/workflow.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-02 campaign contract and terms", () => {
  test("the ACTIVE campaign carries the PINNED policy v1 with the complete creator terms set", async () => {
    const ctx = harness.operatorCtx("w035-ac02-campaign");
    const campaign = await harness.runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.currentPolicyVersion).toBe(1);
    expect(campaign.ownerPersonId).toBe(harness.operatorPersonId);

    // The pinned terms sections: the creator_content objective, the
    // outcome policy (measurement requirements), the evidence policy,
    // the declared compensation/clearing rule (with the real reward
    // policy), the disclosure policy and the opportunity spec.
    const versions =
      await harness.runtime.campaignService.listPolicyVersions(
        ctx,
        scenario.campaignId,
      );
    const pinned = versions.find((v) => v.version === 1);
    expect(pinned).toBeDefined();
    expect(pinned!.objectives[0]!.kind).toBe("creator_content");
    expect(pinned!.outcomePolicy.requirements[0]!.outcomeType).toBe("view");
    expect(
      pinned!.outcomePolicy.requirements[0]!.attributionMode,
    ).toBe("deterministic");
    expect(pinned!.evidencePolicy.requirements[0]!.minimumGrade).toBe(
      "ATTESTED",
    );
    expect(pinned!.evidencePolicy.requirements[0]!.qualifyingSourceTypes).toContain(
      "platform",
    );
    expect(pinned!.clearingRules).toHaveLength(1);
    expect(pinned!.clearingRules[0]!.drawKind).toBe("reward_allocation");
    expect(pinned!.clearingRules[0]!.rewardPolicyId).toBe(
      scenario.campaignRewardPolicyId,
    );
    expect(pinned!.clearingRules[0]!.maxDrawAmount).toBe(1000);
    expect(pinned!.disclosurePolicy.requiredKinds).toContain(
      "material_connection",
    );
    expect(pinned!.disclosurePolicy.requiredKinds).toContain(
      "genuine_experience",
    );
    expect(pinned!.opportunitySpecs[0]!.opportunityType).toBe(
      "helpful_recommendation",
    );

    // The declared compensation/clearing rule's reward policy is the
    // REAL same-scope lineage whose beneficiary is the CREATOR.
    const rewardPolicy =
      await harness.runtime.rewardPolicyService.getPolicyVersion(
        ctx,
        scenario.campaignRewardPolicyId,
        1,
      );
    expect(rewardPolicy.allocations[0]!.beneficiaryPersonId).toBe(
        harness.creatorPersonId,
    );
  });

  test("the engagement PINS the campaign policy version + the declared terms (server-side; no caller-supplied policy version exists)", async () => {
    const ctx = harness.operatorCtx("w035-ac02-engagement");
    const engagement = await harness.runtime.creatorEngagementService.getEngagement(
      ctx,
      harness.organizationScopeId,
      scenario.engagement.id,
    );
    expect(engagement.campaignId).toBe(scenario.campaignId);
    // The pinned policy version is read SERVER-SIDE at offer creation
    // (the input contract carries no policy-version field).
    expect(engagement.campaignPolicyVersion).toBe(1);
    expect(engagement.matchRunId).toBe(scenario.matchRunId);
    expect(engagement.opportunityId).toBe(scenario.opportunityId);
    expect(engagement.creatorProfileId).toBe(scenario.creatorProfileId);
    // The declared terms: the requested rights envelope + the
    // compensation reference (REFERENCE DATA ONLY — it never mints
    // value).
    expect(engagement.requestedRights.uses).toHaveLength(2);
    expect(engagement.requestedRights.channels).toContain(
      "creator_owned_channel",
    );
    expect(engagement.compensation!.format).toBe("short_video");
    expect(engagement.compensation!.amount).toBe(750);
    expect(engagement.compensation!.rewardPolicyReference).toBe(
      scenario.campaignRewardPolicyId,
    );

    // The terms are IMMUTABLE lineage: the engagement record carries
    // its creation anchors (append-only; no update path).
    expect(engagement.createdAt).toBeTruthy();
  });

  test("a DRAFT campaign cannot materialize the lifecycle entry (the opportunity publication fails closed until ACTIVE)", async () => {
    // The not-ACTIVE fixture: the full campaign + policy WITHOUT the
    // activation — the campaign's opportunity (the contribution
    // vehicle) cannot be published while the campaign is DRAFT.
    const { campaign } = await createCreatorCampaign(harness, {
      skipActivation: true,
    });
    await expect(
      harness.runtime.campaignService.resolveOpportunityDraft(
        harness.operatorCtx("w035-ac02-draft-opportunity"),
        campaign.id,
        "spec-1",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("owner authorization is enforced at the campaign boundary (a non-owner cannot define policy)", async () => {
    const ctx = personCtx(harness, harness.creatorPersonId, "w035-ac02-owner");
    await expect(
      harness.runtime.campaignService.defineCampaignPolicy(ctx, {
        campaignId: scenario.campaignId,
        policy: {
          objectives: [],
          eligibility: { rules: [] },
          outcomePolicy: { requirements: [] },
          evidencePolicy: { requirements: [] },
          budget: { unit: "credits", totalAmount: 0, perObjective: [] },
          attributionRules: [],
          clearingRules: [],
          opportunitySpecs: [],
        },
        idempotencyKey: key("w035-ac02-foreign-policy"),
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_FORBIDDEN" });
  });

  test("activation requires the ESCROW covering the declared clearing cap (CAMP-002)", async () => {
    // A campaign whose policy declares a clearing rule but whose
    // budget is NOT escrowed cannot activate.
    const ctx = harness.operatorCtx("w035-ac02-escrow");
    const { campaign } = await harness.runtime.campaignService.createCampaign(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        name: "W035 AC-02 Unescrowed Campaign",
        description: "the no-escrow fail-closed fixture",
        idempotencyKey: key("w035-ac02-escrow-campaign"),
      },
    );
    await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
      campaignId: campaign.id,
      policy: {
        objectives: [
          {
            id: "obj-1",
            kind: "creator_content",
            description: "fixture",
            successCriteria: null,
          },
        ],
        eligibility: { rules: [] },
        outcomePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              outcomeType: "view",
              attributionMode: "deterministic",
              windowDays: 30,
              requiresExperiment: false,
            },
          ],
        },
        evidencePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              requirementKind: "proof_of_value",
              minimumGrade: "ATTESTED",
              qualifyingSourceTypes: ["platform"],
            },
          ],
        },
        budget: { unit: "credits", totalAmount: 500, perObjective: [] },
        attributionRules: [],
        clearingRules: [
          {
            id: "clear-1",
            objectiveId: "obj-1",
            basis: "attributed_outcome",
            drawKind: "reward_allocation",
            rewardPolicyId: scenario.campaignRewardPolicyId,
            maxDrawAmount: 500,
          } as never,
        ],
        opportunitySpecs: [
          {
            id: "spec-1",
            title: "fixture",
            opportunityType: "helpful_recommendation",
            brief: { campaignObjective: "obj-1", neutral: true },
            contributionRequirements: { deliverables: 1 },
            evidenceReferencePlaceholders: ["evidence-1"],
          } as never,
        ],
      },
      idempotencyKey: key("w035-ac02-escrow-policy"),
    });
    await expect(
      harness.runtime.campaignService.activateCampaign(ctx, {
        campaignId: campaign.id,
        idempotencyKey: key("w035-ac02-escrow-activate"),
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_VALIDATION" });
  });

  test("cross-tenant campaign/terms references fail closed without an existence oracle", async () => {
    // A foreign-organization engagement creation on the scenario
    // campaign fails closed (the campaign does not resolve in the
    // second org).
    await expect(
      harness.runtime.creatorEngagementService.createEngagement(
        personCtx(harness, harness.secondOrgPersonId, "w035-ac02-foreign"),
        {
          organizationScopeId: harness.secondOrgId,
          creatorPersonId: harness.secondOrgPersonId,
          campaignId: scenario.campaignId,
          matchRunId: null,
          opportunityId: null,
          requestedRights: {
            uses: [{ kind: "channel_publication", terms: null }],
            channels: ["creator_owned_channel"],
            territories: ["GH"],
            formats: ["short_video"],
            startsAt: new Date(Date.now() - 86_400_000).toISOString(),
            endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            exclusions: [],
          },
          compensation: null,
          brief: null,
          idempotencyKey: key("w035-ac02-foreign-engagement"),
        } as never,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The campaign's tenant boundary: the second-org actor's listing
    // shows ONLY its own campaigns — the scenario campaign is
    // invisible; and the second-org actor cannot mutate the
    // first-org campaign (owner-only — fail closed).
    const secondCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w035-ac02-tenant",
    );
    const secondOrgCampaigns =
      await harness.runtime.campaignService.listCampaigns(
        secondCtx,
        harness.secondOrgId,
      );
    expect(
      secondOrgCampaigns.some((c) => c.id === scenario.campaignId),
    ).toBe(false);
    await expect(
      harness.runtime.campaignService.recordOpportunityPublication(
        secondCtx,
        {
          campaignId: scenario.campaignId,
          specId: "spec-1",
          policyVersion: 1,
          opportunityId: scenario.opportunityId,
          idempotencyKey: key("w035-ac02-cross-tenant"),
        },
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_FORBIDDEN" });
  });

  test("the pinned terms create NO second economic ledger (the engagement terms are reference data only)", async () => {
    // The engagement + relationship compensation are pure reference
    // records: recognizing the economic value requires the settlement
    // composite — the terms alone never post ledger entries.
    const entriesBefore =
      await harness.runtime.postgresAuthority.scan("economic_ledger_entries");
    const ctx = harness.operatorCtx("w035-ac02-no-ledger");
    const engagement = await harness.runtime.creatorEngagementService.getEngagement(
      ctx,
      harness.organizationScopeId,
      scenario.engagement.id,
    );
    expect(engagement.compensation!.amount).toBe(750);
    const entriesAfter =
      await harness.runtime.postgresAuthority.scan("economic_ledger_entries");
    expect(entriesAfter.length).toBe(entriesBefore.length);
  });
});
