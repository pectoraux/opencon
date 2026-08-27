/**
 * NET-W012-AC-01 — first-class durable scoped records.
 *
 * Helpful-contribution opportunities and submissions are first-class
 * durable scoped records: the Contribution (W004 lifecycle subject
 * with the structured helpful submission payload) and its 1:1
 * Proof-of-Helpfulness domain aggregate commit atomically, carry
 * organization scope, append-only histories and full lineage, enforce
 * the person-actor gate, replay idempotently and isolate tenants.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  createHelpfulCampaign,
  createHelpfulContribution,
  contributorCtx,
  otherCtx,
  key,
  type NetW012Harness,
} from "./_net-w012-harness.ts";

let harness: NetW012Harness;

beforeAll(async () => {
  harness = await createNetW012Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W012-AC-01 first-class records", () => {
  test("a helpful campaign publishes a HELPFUL-typed opportunity carrying the eligibility reference", async () => {
    const { campaign, opportunityId } = await createHelpfulCampaign(harness);
    expect(campaign.status).toBe("ACTIVE");
    const opportunity = await harness.runtime.opportunityService.getOpportunity(
      harness.bootstrapCtx,
      opportunityId,
    );
    expect(opportunity.opportunityType).toBe("helpful_recommendation");
    expect(opportunity.eligibilityPolicyReference).toMatch(
      /^campaign_policy:.+:1:spec-1$/,
    );
  });

  test("createHelpfulContribution atomically creates the Contribution (DRAFT v0) + the PoH (PENDING) with the pinned policy + eligibility resolution", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness);
    const { contribution, proofOfHelpfulness } = await createHelpfulContribution(
      harness,
      { opportunityId, helpfulnessPolicyId: policy.policyId },
    );

    // The Contribution: a first-class W004 lifecycle record with the
    // structured helpful payload.
    expect(contribution.kind).toBe("contribution");
    expect(contribution.state).toBe("DRAFT");
    expect(contribution.version).toBe(0);
    expect(contribution.organizationScopeId).toBe(harness.organizationScopeId);
    expect(contribution.contributorId).toBe(harness.contributorPersonId);
    expect(contribution.contributionType).toBe("helpful_recommendation");
    const submission = contribution.submission as Record<string, unknown>;
    expect(submission.kind).toBe("helpful");
    expect(submission.helpfulnessPolicyId).toBe(policy.policyId);
    expect(submission.helpfulnessPolicyVersion).toBe(1);

    // The PoH: the 1:1 domain aggregate.
    expect(proofOfHelpfulness.contributionId).toBe(contribution.id);
    expect(proofOfHelpfulness.state).toBe("PENDING");
    expect(proofOfHelpfulness.organizationScopeId).toBe(
      harness.organizationScopeId,
    );
    expect(proofOfHelpfulness.formatVersion).toBe("NET-W012:1");
    expect(proofOfHelpfulness.events).toEqual(["created"]);
    expect(proofOfHelpfulness.publication).toBeNull();
    expect(proofOfHelpfulness.eligibility?.eligible).toBe(true);
    expect(proofOfHelpfulness.eligibility?.campaignStatus).toBe("ACTIVE");
    expect(proofOfHelpfulness.eligibility?.policyVersion).toBe(1);
    expect(proofOfHelpfulness.executionId).toBeTruthy();
    expect(proofOfHelpfulness.correlationId).toBeTruthy();
  });

  test("the 1:1 mapping holds: getProofOfHelpfulness resolves by contribution id", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(poh.contributionId).toBe(contribution.id);
  });

  test("only a person actor acting AS the contributor can create (no on-behalf, no system actor)", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness);
    const submission = {
      claimantAttributes: { participant_class: ["contributor"] },
      mentions: [],
      contentRef: null,
      channel: null,
    } as const;
    // On-behalf creation is rejected (actor ≠ contributor).
    await expect(
      harness.runtime.helpfulnessService.createHelpfulContribution(
        contributorCtx(harness, "w012-ac01-onbehalf"),
        {
          opportunityId,
          contributorId: harness.otherPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "helpful_recommendation",
          submission,
          helpfulnessPolicyId: policy.policyId,
          idempotencyKey: key("w012-ac01-onbehalf"),
        },
      ),
    ).rejects.toThrow(/cannot create a helpful contribution on behalf of/);
    // System actors are rejected.
    await expect(
      harness.runtime.helpfulnessService.createHelpfulContribution(
        {
          correlationId: "w012-ac01-system",
          executionId: "w012-ac01-system",
          actor: { id: "worker-1", kind: "system" },
        } as never,
        {
          opportunityId,
          contributorId: harness.contributorPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "helpful_recommendation",
          submission,
          helpfulnessPolicyId: policy.policyId,
          idempotencyKey: key("w012-ac01-system"),
        },
      ),
    ).rejects.toThrow(/person actor is required/i);
  });

  test("creation replays idempotently (same key → same records, created=false)", async () => {
    const k = key("w012-ac01-replay");
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness);
    const first = await harness.runtime.helpfulnessService.createHelpfulContribution(
      contributorCtx(harness, "w012-ac01-replay"),
      {
        opportunityId,
        contributorId: harness.contributorPersonId,
        organizationScopeId: harness.organizationScopeId,
        contributionType: "helpful_recommendation",
        submission: {
          claimantAttributes: { participant_class: ["contributor"] },
          mentions: [],
          contentRef: null,
          channel: null,
        },
        helpfulnessPolicyId: policy.policyId,
        idempotencyKey: k,
      },
    );
    const second = await harness.runtime.helpfulnessService.createHelpfulContribution(
      contributorCtx(harness, "w012-ac01-replay"),
      {
        opportunityId,
        contributorId: harness.contributorPersonId,
        organizationScopeId: harness.organizationScopeId,
        contributionType: "helpful_recommendation",
        submission: {
          claimantAttributes: { participant_class: ["contributor"] },
          mentions: [],
          contentRef: null,
          channel: null,
        },
        helpfulnessPolicyId: policy.policyId,
        idempotencyKey: k,
      },
    );
    expect(second.created).toBe(false);
    expect(second.contribution.id).toBe(first.contribution.id);
    expect(second.proofOfHelpfulness.id).toBe(first.proofOfHelpfulness.id);
  });

  test("tenant isolation: a second-org contributor cannot create against the first org's opportunity", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness);
    await expect(
      createHelpfulContribution(harness, {
        opportunityId,
        helpfulnessPolicyId: policy.policyId,
        contributorPersonId: harness.secondOrgPersonId,
        organizationScopeId: harness.secondOrgId,
      }),
    ).rejects.toThrow(/belongs to organization scope/);
  });

  test("fail-closed eligibility: a failing rule rejects creation with the failure reasons", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness, {
      eligibilityRule: {
        attribute: "participant_class",
        operator: "equals",
        values: ["expert"],
      },
    });
    await expect(
      createHelpfulContribution(harness, {
        opportunityId,
        helpfulnessPolicyId: policy.policyId,
      }),
    ).rejects.toThrow(/not eligible/);
  });

  test("fail-closed eligibility: an undeclared attribute rejects (absence is never eligibility)", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness, {
      eligibilityRule: {
        attribute: "language",
        operator: "in",
        values: ["en"],
      },
    });
    await expect(
      createHelpfulContribution(harness, {
        opportunityId,
        helpfulnessPolicyId: policy.policyId,
        // claimantAttributes WITHOUT language:
        claimantAttributes: { participant_class: ["contributor"] },
      }),
    ).rejects.toThrow(/did not declare attribute 'language'/);
  });

  test("only HELPFUL-typed opportunities accept helpful contributions (AC-01 explicitness)", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const opp = await harness.runtime.opportunityService.createOpportunity(
      otherCtx(harness, "w012-ac01-plain-opp"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.contributorPersonId,
        opportunityType: "generic_task",
        title: "A generic (non-helpful) opportunity",
        brief: { kind: "test" },
      },
    );
    await expect(
      createHelpfulContribution(harness, {
        opportunityId: opp.id,
        helpfulnessPolicyId: policy.policyId,
      }),
    ).rejects.toThrow(/not a helpful opportunity/);
  });

  test("invalid contributionType / submission shapes are rejected deterministically", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { opportunityId } = await createHelpfulCampaign(harness);
    await expect(
      createHelpfulContribution(harness, {
        opportunityId,
        helpfulnessPolicyId: policy.policyId,
        contributionType: "spam_comment",
      }),
    ).rejects.toThrow(/helpful contribution kind/);
    await expect(
      harness.runtime.helpfulnessService.createHelpfulContribution(
        contributorCtx(harness, "w012-ac01-badsub"),
        {
          opportunityId,
          contributorId: harness.contributorPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "helpful_recommendation",
          submission: {
            claimantAttributes: "not-a-record",
            mentions: [],
          } as never,
          helpfulnessPolicyId: policy.policyId,
          idempotencyKey: key("w012-ac01-badsub"),
        },
      ),
    ).rejects.toThrow(/claimantAttributes/);
  });
});
