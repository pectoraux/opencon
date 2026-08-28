/**
 * NET-W019-AC-03 — supply authorization is enforced server-side and
 * cannot be forged by client claims (INV-003; issue #37 invariant 3):
 * supply ownership, placement eligibility and campaign scope are all
 * derived from durable records — never caller-asserted.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW019Harness,
  registerInventoryItem,
  createCampaignWithEligibility,
  createPlacement,
  createSupplyEvidence,
  personCtx,
  key,
  type NetW019Harness,
} from "./_net-w019-harness.ts";
import { AuthorizationError, NotFoundError } from "../../src/core/errors.ts";

let harness: NetW019Harness;

describe("NET-W019-AC-03 supply authorization", () => {
  beforeAll(async () => {
    harness = await createNetW019Harness();
  });
  afterAll(async () => {
    await harness.teardown();
  });

  test("SUPPLY OWNERSHIP is server-enforced: only the registered owner can place their supply", async () => {
    const item = await registerInventoryItem(harness, {
      actorPersonId: harness.creatorPersonId,
    });
    const campaign = await createCampaignWithEligibility(harness);
    // A different person in the SAME org cannot place someone else's
    // supply (ownership is a durable-record fact, not a role).
    await expect(
      createPlacement(harness, {
        inventoryItemId: item.id,
        campaignId: campaign.id,
        actorPersonId: harness.operatorPersonId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // The owner can.
    const placed = await createPlacement(harness, {
      inventoryItemId: item.id,
      campaignId: campaign.id,
      actorPersonId: harness.creatorPersonId,
    });
    expect(placed.sourceContext.ownerPersonId).toBe(
      harness.creatorPersonId,
    );
  });

  test("SUPPLY OWNERSHIP is server-enforced: withdrawal and verification attachment are owner-only", async () => {
    const item = await registerInventoryItem(harness, {
      actorPersonId: harness.creatorPersonId,
    });
    const { evidenceId } = await createSupplyEvidence(harness, item.id);
    await expect(
      harness.runtime.inventoryService.retireInventoryItem(
        personCtx(harness, harness.operatorPersonId, "w019-ac03-a"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          idempotencyKey: key("w019-ac03-a"),
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    await expect(
      harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.operatorPersonId, "w019-ac03-b"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          evidenceReference: evidenceId,
          idempotencyKey: key("w019-ac03-b"),
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    // Placement retirement is owner-only too.
    const placed = await createPlacement(harness);
    await expect(
      harness.runtime.inventoryService.retirePlacement(
        personCtx(harness, harness.operatorPersonId, "w019-ac03-c"),
        {
          organizationScopeId: harness.organizationScopeId,
          placementId: placed.id,
          idempotencyKey: key("w019-ac03-c"),
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
  });

  test("CAMPAIGN SCOPE cannot be fabricated: a cross-scope campaign is indistinguishable from a nonexistent one", async () => {
    const item = await registerInventoryItem(harness);
    // A campaign in ANOTHER org: the neutral lookup resolves it
    // cross-scope → NotFoundError (no existence oracle).
    const secondOrgCampaign = await createCampaignWithEligibility(harness, {
      ownerPersonId: harness.secondOrgPersonId,
    });
    // NOTE: the factory creates campaigns in the HARNESS org; create
    // a genuinely cross-scope campaign through the campaign service
    // with the second org's scope.
    const crossScope = await harness.runtime.campaignService.createCampaign(
      personCtx(harness, harness.secondOrgPersonId, "w019-ac03-cross"),
      {
        organizationScopeId: harness.secondOrgId,
        name: "Other org campaign",
        description: "cross-scope fixture campaign",
        idempotencyKey: key("w019-ac03-cross"),
      },
    );
    await harness.runtime.campaignService.defineCampaignPolicy(
      personCtx(harness, harness.secondOrgPersonId, "w019-ac03-cross"),
      {
        campaignId: crossScope.campaign.id,
        policy: {
          objectives: [
            {
              id: "obj-1",
              kind: "creator_content",
              description: null,
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
              title: "Other org opportunity",
              opportunityType: "campaign_contribution",
              brief: { campaignObjective: "obj-1", neutral: true },
              contributionRequirements: { deliverables: 1 },
              evidenceReferencePlaceholders: ["evidence-ugc-production"],
            },
          ],
        },
        idempotencyKey: key("w019-ac03-cross-policy"),
      },
    );
    void secondOrgCampaign;
    await expect(
      createPlacement(harness, {
        inventoryItemId: item.id,
        campaignId: crossScope.campaign.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A nonexistent campaign id is the same error.
    await expect(
      createPlacement(harness, {
        inventoryItemId: item.id,
        campaignId: "no-such-campaign",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("PLACEMENT ELIGIBILITY cannot be fabricated: non-supply attributes and inapplicable operators evaluate NOT satisfied", async () => {
    // A rule over an attribute inventory supply does not carry
    // (participant_class) is honestly recorded as NOT satisfied —
    // the placement is recorded with derived-ineligible provenance.
    const placement = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "participant_class", operator: "equals", values: ["organization"] },
      ],
    });
    expect(placement.eligibility.eligible).toBe(false);
    expect(placement.eligibility.ruleResults[0]).toMatchObject({
      attribute: "participant_class",
      satisfied: false,
      reason: "attribute_not_carried_by_supply",
    });
    // An ordering operator on an unordered supply attribute is NOT
    // applicable — conservatively not satisfied.
    const ordered = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "region", operator: "gte", values: ["US"] },
      ],
    });
    expect(ordered.eligibility.eligible).toBe(false);
    expect(ordered.eligibility.ruleResults[0]).toMatchObject({
      attribute: "region",
      operator: "gte",
      satisfied: false,
      reason: "operator_not_applicable",
    });
    // A not_in rule every offered value avoids IS satisfied (set
    // semantics: every offered value must satisfy the rule).
    const avoiding = await createPlacement(harness, {
      eligibilityRules: [
        { attribute: "region", operator: "not_in", values: ["KP"] },
      ],
    });
    expect(avoiding.eligibility.eligible).toBe(true);
  });

  test("the supply-verification signal cannot be fabricated: the evidence must be subject-bound to THIS item", async () => {
    const item = await registerInventoryItem(harness);
    const otherItem = await registerInventoryItem(harness);
    // Evidence bound to a DIFFERENT item → rejected.
    const wrongItem = await createSupplyEvidence(harness, otherItem.id);
    await expect(
      harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac03-wrong"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          evidenceReference: wrongItem.evidenceId,
          idempotencyKey: key("w019-ac03-wrong"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    // Evidence with the WRONG subject type → rejected.
    const wrongType = await createSupplyEvidence(harness, item.id, {
      subjectType: "publication",
    });
    await expect(
      harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac03-type"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          evidenceReference: wrongType.evidenceId,
          idempotencyKey: key("w019-ac03-type"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    // Cross-TENANT evidence → rejected.
    const crossScope = await createSupplyEvidence(harness, item.id, {
      organizationScopeId: harness.secondOrgId,
    });
    await expect(
      harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac03-cross"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          evidenceReference: crossScope.evidenceId,
          idempotencyKey: key("w019-ac03-cross"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    // Nonexistent evidence → rejected.
    await expect(
      harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac03-none"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          evidenceReference: "no-such-evidence",
          idempotencyKey: key("w019-ac03-none"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    // The CORRECT subject-bound evidence attaches, one-time.
    const right = await createSupplyEvidence(harness, item.id);
    const attached =
      await harness.runtime.inventoryService.attachSupplyVerification(
        personCtx(harness, harness.creatorPersonId, "w019-ac03-right"),
        {
          organizationScopeId: harness.organizationScopeId,
          itemId: item.id,
          evidenceReference: right.evidenceId,
          idempotencyKey: key("w019-ac03-right"),
        },
      );
    expect(attached.verificationEvidenceReference).toBe(right.evidenceId);
    // A SECOND (different) reference is a stable rejection — the
    // attachment is one-time (stable provenance).
    const another = await createSupplyEvidence(harness, item.id);
    const second = harness.runtime.inventoryService.attachSupplyVerification(
      personCtx(harness, harness.creatorPersonId, "w019-ac03-second"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        evidenceReference: another.evidenceId,
        idempotencyKey: key("w019-ac03-second"),
      },
    );
    // The repo returns the item UNCHANGED (one-time attachment) — the
    // stable provenance direction.
    const settled = await second;
    expect(settled.verificationEvidenceReference).toBe(right.evidenceId);
  });
});
