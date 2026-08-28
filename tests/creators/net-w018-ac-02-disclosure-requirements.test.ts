/**
 * NET-W018-AC-02 — disclosure requirements are explicit,
 * deterministic, tenant-scoped and auditable (issue #35 AC-02;
 * invariant 2 — derived from explicit campaign/engagement policy,
 * never caller claims).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW018Harness,
  createCampaignWithDisclosurePolicy,
  createVerifiedEngagement,
  createCommercialRelationship,
  createPublication,
  declareKind,
  key,
  operatorCtx,
  personCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";
import { InvalidCampaignPolicyError } from "../../src/core/campaigns.ts";
import {
  deriveRequiredDisclosures,
  evaluateDisclosureObligations,
} from "../../src/creators/disclosure-engine.ts";
import { CAMPAIGN_DISCLOSURE_KINDS } from "../../src/core/campaigns.ts";

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W018-AC-02 disclosure requirements", () => {
  test("the campaign policy section is EXPLICIT and durable: every stored version materializes it (absent input → EMPTY)", async () => {
    const campaign = await createCampaignWithDisclosurePolicy(harness, {
      requiredKinds: ["material_connection", "genuine_experience"],
    });
    const ctx = operatorCtx(harness, "w018-ac02-policy");
    const versions = await harness.runtime.campaignService.listPolicyVersions(
      ctx,
      campaign.id,
    );
    expect(versions).toHaveLength(1);
    // The section is materialized EXPLICITLY on the stored version.
    expect(versions[0]!.disclosurePolicy.requiredKinds).toEqual([
      "material_connection",
      "genuine_experience",
    ]);

    // A pre-W018-style policy definition (NO disclosure section)
    // stores as the EXPLICIT empty stance (format-compatible).
    const { campaign: legacy } =
      await harness.runtime.campaignService.createCampaign(ctx, {
        organizationScopeId: harness.organizationScopeId,
        name: "W018 legacy campaign",
        idempotencyKey: key("w018-ac02-legacy"),
      });
    await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
      campaignId: legacy.id,
      policy: {
        objectives: [
          { id: "obj-1", kind: "creator_content", description: null, successCriteria: null },
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
        budget: { unit: "credits", totalAmount: 0, perObjective: [] },
        attributionRules: [
          {
            id: "attr-1",
            objectiveId: "obj-1",
            model: "deterministic",
            confidenceThreshold: 0.9,
            windowDays: 30,
            requiresExperiment: false,
          },
        ],
        clearingRules: [],
        opportunitySpecs: [
          {
            id: "spec-1",
            title: "Produce UGC",
            opportunityType: "campaign_contribution",
            brief: { neutral: true },
            contributionRequirements: { deliverables: 1 },
            evidenceReferencePlaceholders: [],
          },
        ],
      },
      idempotencyKey: key("w018-ac02-legacy-policy"),
    });
    const legacyVersions =
      await harness.runtime.campaignService.listPolicyVersions(
        ctx,
        legacy.id,
      );
    expect(legacyVersions[0]!.disclosurePolicy.requiredKinds).toEqual([]);

    // The policy definition is AUDITED (the policy_defined event —
    // resourceId is the POLICY id; the metadata carries the campaign).
    const events = await harness.runtime.auditWriter.query({
      eventType: "campaign.policy_defined",
      resourceId: versions[0]!.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.campaignId).toBe(campaign.id);
  });

  test("the disclosure vocabulary is CLOSED: unknown and duplicate kinds are rejected deterministically", async () => {
    const ctx = operatorCtx(harness, "w018-ac02-closed");
    const { campaign } = await harness.runtime.campaignService.createCampaign(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        name: "W018 invalid campaign",
        idempotencyKey: key("w018-ac02-invalid"),
      },
    );
    const baseSections = {
      objectives: [
        { id: "obj-1", kind: "creator_content", description: null, successCriteria: null },
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
      budget: { unit: "credits", totalAmount: 0, perObjective: [] },
      attributionRules: [
        {
          id: "attr-1",
          objectiveId: "obj-1",
          model: "deterministic",
          confidenceThreshold: 0.9,
          windowDays: 30,
          requiresExperiment: false,
        },
      ],
      clearingRules: [],
      opportunitySpecs: [
        {
          id: "spec-1",
          title: "Produce UGC",
          opportunityType: "campaign_contribution",
          brief: { neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: [],
        },
      ],
    } as const;

    // Unknown kind → rejected.
    await expect(
      harness.runtime.campaignService.defineCampaignPolicy(ctx, {
        campaignId: campaign.id,
        policy: {
          ...baseSections,
          disclosurePolicy: { requiredKinds: ["sponsored_post"] },
        } as never,
        idempotencyKey: key("w018-ac02-unknown"),
      }),
    ).rejects.toBeInstanceOf(InvalidCampaignPolicyError);
    // Duplicate kind → rejected (canonical derivation downstream).
    await expect(
      harness.runtime.campaignService.defineCampaignPolicy(ctx, {
        campaignId: campaign.id,
        policy: {
          ...baseSections,
          disclosurePolicy: {
            requiredKinds: ["material_connection", "material_connection"],
          },
        } as never,
        idempotencyKey: key("w018-ac02-dup"),
      }),
    ).rejects.toBeInstanceOf(InvalidCampaignPolicyError);
    // Relationship obligations obey the SAME closed vocabulary.
    const verified = await createVerifiedEngagement(harness);
    await expect(
      createCommercialRelationship(harness, {
        engagementId: verified.engagementId,
        campaignId: verified.campaignId,
        disclosureObligations: ["fabricated_kind"],
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("the pure derivation is DETERMINISTIC: union in frozen vocabulary order (engine-level proof)", () => {
    expect(CAMPAIGN_DISCLOSURE_KINDS).toEqual([
      "material_connection",
      "paid_partnership",
      "gifted_product",
      "genuine_experience",
      "brand_affiliation",
    ]);
    // The union deduplicates + orders by the frozen vocabulary.
    expect(
      deriveRequiredDisclosures(
        ["genuine_experience", "material_connection"],
        ["material_connection", "brand_affiliation"],
      ),
    ).toEqual([
      "material_connection",
      "genuine_experience",
      "brand_affiliation",
    ]);
    // A relationship can only ADD obligations (never remove the
    // campaign's).
    expect(
      deriveRequiredDisclosures(["material_connection"], []),
    ).toEqual(["material_connection"]);
    expect(deriveRequiredDisclosures([], ["gifted_product"])).toEqual([
      "gifted_product",
    ]);
    // Empty policy + no relationship = no obligations (the declared
    // stance).
    expect(deriveRequiredDisclosures([], null)).toEqual([]);
  });

  test("the derived status exposes provenance: each obligation carries its policy/relationship sources", () => {
    const obligations = evaluateDisclosureObligations({
      requiredKinds: ["material_connection", "genuine_experience"],
      policyVersion: 3,
      relationship: {
        id: "rel-1",
        disclosureObligations: ["genuine_experience"],
      } as never,
      declarations: [],
    });
    expect(obligations).toHaveLength(2);
    expect(obligations[0]!.kind).toBe("material_connection");
    expect(obligations[0]!.sources).toEqual([
      { source: "campaign_policy", policyVersion: 3, relationshipId: null },
    ]);
    expect(obligations[0]!.satisfied).toBe(false);
    expect(obligations[1]!.kind).toBe("genuine_experience");
    expect(obligations[1]!.sources).toEqual([
      { source: "campaign_policy", policyVersion: 3, relationshipId: null },
      {
        source: "commercial_relationship",
        policyVersion: null,
        relationshipId: "rel-1",
      },
    ]);
  });

  test("the INTEGRATED derivation: the publication's derived status is the durable-record union with satisfaction state", async () => {
    // Campaign requires material_connection; the relationship adds
    // genuine_experience + brand_affiliation.
    const campaign = await createCampaignWithDisclosurePolicy(harness, {
      requiredKinds: ["material_connection"],
    });
    const verified = await createVerifiedEngagement(harness, {
      campaignId: campaign.id,
    });
    const relationship = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: campaign.id,
      disclosureObligations: ["genuine_experience", "brand_affiliation"],
    });
    const publication = await createPublication(harness, {
      engagementId: verified.engagementId,
      productionId: verified.productionId,
    });
    const ctx = personCtx(harness, harness.operatorPersonId, "w018-ac02-int");
    const status =
      await harness.runtime.creatorSponsorshipService.getPublicationDisclosureStatus(
        ctx,
        harness.organizationScopeId,
        publication.id,
      );
    expect(status.publicationId).toBe(publication.id);
    expect(status.state).toBe("DRAFT");
    expect(status.satisfied).toBe(false);
    expect(status.obligations.map((o) => o.kind)).toEqual([
      "material_connection",
      "genuine_experience",
      "brand_affiliation",
    ]);
    // The union's provenance: campaign source pins the policy
    // version; the relationship source pins the relationship id.
    const material = status.obligations[0]!;
    expect(material.sources).toEqual([
      {
        source: "campaign_policy",
        policyVersion: 1,
        relationshipId: null,
      },
    ]);
    const genuine = status.obligations[1]!;
    expect(genuine.sources).toEqual([
      { source: "campaign_policy", policyVersion: 1, relationshipId: null },
      {
        source: "commercial_relationship",
        policyVersion: null,
        relationshipId: relationship.id,
      },
    ]);

    // Satisfaction flips per-kind as declarations land (the caller
    // NEVER asserts it).
    await declareKind(harness, publication.id, "genuine_experience");
    const afterOne =
      await harness.runtime.creatorSponsorshipService.getPublicationDisclosureStatus(
        ctx,
        harness.organizationScopeId,
        publication.id,
      );
    expect(afterOne.obligations.find((o) => o.kind === "genuine_experience")!.satisfied).toBe(true);
    expect(afterOne.obligations.find((o) => o.kind === "material_connection")!.satisfied).toBe(false);
    expect(afterOne.satisfied).toBe(false);
    // The satisfying declaration's id is exposed (provenance).
    expect(
      afterOne.obligations.find((o) => o.kind === "genuine_experience")!
        .declarationIds,
    ).toHaveLength(1);
  });

  test("tenant scoping: the derived status resolves ONLY same-scope records", async () => {
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection"],
    });
    await expect(
      harness.runtime.creatorSponsorshipService.getPublicationDisclosureStatus(
        personCtx(harness, harness.secondOrgPersonId, "w018-ac02-cross"),
        harness.secondOrgId,
        publication.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
