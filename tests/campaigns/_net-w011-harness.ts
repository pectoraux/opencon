/**
 * NET-W011 shared test harness.
 *
 * Wraps the NET-W010 harness (runtime + persons + organizations + the
 * risk/dispute guard actions + the credit-issuance factories) and
 * adds:
 *  - the campaign guard actions (10 mutations);
 *  - the campaign owner context (the harness person — they hold
 *    Participation Credits through the W010 credit factories, so the
 *    budget escrow's conservation guard can pass);
 *  - the default campaign + policy factories (a complete CAMP-002
 *    policy: objective, eligibility rule, outcome/evidence
 *    requirements, budget, attribution rule, clearing rule wired to a
 *    REAL settlement reward policy, opportunity spec);
 *  - the composition-root sequences (budget commit/release, publish)
 *    exactly as the runtime apiCommands execute them.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW010Harness,
  ensureCreditsFor,
  personCtx as w010PersonCtx,
  type NetW008HarnessOptions,
  type NetW010Harness,
} from "../disputes/_net-w010-harness.ts";
export type { NetW008HarnessOptions };
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  CampaignPolicy,
  CampaignPolicySections,
  CampaignRecord,
} from "../../src/campaigns/port.ts";

export interface NetW011Harness {
  /** The wrapped NET-W010 harness (all its factories work unchanged). */
  readonly w010: NetW010Harness;
  readonly runtime: NetW010Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The campaign owner (the harness person; holds credits). */
  readonly ownerPersonId: string;
  /** A different person in the same org (non-owner proofs). */
  readonly otherPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

export async function createNetW011Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW011Harness> {
  const w010 = await createNetW010Harness(opts);
  const runtime = w010.runtime;
  const bootstrapCtx = w010.bootstrapCtx;

  // Seed ALLOW policies for the NET-W011 campaign guard actions.
  const guardActions = [
    "campaign.create",
    "campaign.policy",
    "campaign.activate",
    "campaign.pause",
    "campaign.resume",
    "campaign.complete",
    "campaign.cancel",
    "campaign.budget.commit",
    "campaign.budget.release",
    "campaign.opportunity.publish",
  ];
  for (const action of guardActions) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w010,
    runtime,
    bootstrapCtx,
    ownerPersonId: w010.personId,
    otherPersonId: w010.challengerPersonId,
    organizationScopeId: w010.organizationScopeId,
    secondOrgId: w010.secondOrgId,
    secondOrgPersonId: w010.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** An execution context for a specific person. */
export function personCtx(
  harness: NetW011Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The campaign owner's context. */
export function ownerCtx(
  harness: NetW011Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.ownerPersonId, correlationId);
}

/** A non-owner person's context (same org). */
export function otherCtx(
  harness: NetW011Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.otherPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Campaign + policy factories
// ---------------------------------------------------------------------------

export interface CreateCampaignOptions {
  readonly name?: string;
  readonly ownerPersonId?: string;
  readonly organizationScopeId?: string;
  readonly idempotencyKey?: string;
}

/** A fresh DRAFT campaign owned by the harness person. */
export async function createCampaign(
  harness: NetW011Harness,
  opts: CreateCampaignOptions = {},
): Promise<CampaignRecord> {
  const ctx = personCtx(
    harness,
    opts.ownerPersonId ?? harness.ownerPersonId,
    "w011-create",
  );
  const result = await harness.runtime.campaignService.createCampaign(ctx, {
    organizationScopeId:
      opts.organizationScopeId ?? harness.organizationScopeId,
    name: opts.name ?? "Test Campaign",
    description: "a provider-neutral test campaign",
    idempotencyKey: opts.idempotencyKey ?? key("w011-campaign"),
  });
  return result.campaign;
}

export interface PolicySectionsOptions {
  readonly totalAmount?: number;
  readonly objectiveKind?: string;
  readonly rewardPolicyId?: string;
  readonly specId?: string;
  readonly withSpec?: boolean;
  readonly rewardPolicyScope?: "same" | "second-org";
}

/**
 * Create a REAL settlement reward policy in the harness org and
 * return its id (clearing rules must reference a resolvable lineage).
 */
export async function createRewardPolicy(
  harness: NetW011Harness,
  opts: { readonly organizationScopeId?: string } = {},
): Promise<string> {
  const policyId = key("w011-reward-policy");
  await harness.runtime.rewardPolicyService.createPolicyVersion(
    harness.bootstrapCtx,
    {
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      policyId,
      version: 1,
      description: "test campaign clearing policy",
      allocations: [
        { beneficiaryPersonId: harness.ownerPersonId, weight: 1 },
      ],
    },
  );
  return policyId;
}

/**
 * A complete, valid CAMP-002 policy: one objective (default
 * `awareness`), one eligibility rule, outcome + evidence requirements
 * referencing the frozen vocabularies, a credits budget, an
 * attribution rule, a clearing rule wired to a REAL reward policy,
 * and one opportunity spec.
 */
export async function defaultPolicySections(
  harness: NetW011Harness,
  opts: PolicySectionsOptions = {},
): Promise<CampaignPolicySections> {
  const rewardPolicyId =
    opts.rewardPolicyId ??
    (await createRewardPolicy(harness, {
      organizationScopeId:
        opts.rewardPolicyScope === "second-org"
          ? harness.secondOrgId
          : undefined,
    }));
  const totalAmount = opts.totalAmount ?? 50;
  const objectiveKind = opts.objectiveKind ?? "awareness";
  const incremental = objectiveKind === "incremental_conversion";
  return {
    objectives: [
      {
        id: "obj-1",
        kind: objectiveKind as CampaignPolicySections["objectives"][number]["kind"],
        description: "the primary objective",
        successCriteria: "measured outcome meets the target",
      },
    ],
    eligibility: {
      rules: [
        {
          attribute: "participant_class",
          operator: "equals",
          values: ["contributor"],
        },
      ],
    },
    outcomePolicy: {
      requirements: [
        {
          objectiveId: "obj-1",
          outcomeType: incremental ? "purchase" : "view",
          attributionMode: incremental ? "experimental" : "deterministic",
          windowDays: 30,
          requiresExperiment: incremental,
        },
      ],
    },
    evidencePolicy: {
      requirements: [
        {
          objectiveId: "obj-1",
          requirementKind: "proof_of_value",
          minimumGrade: "ATTESTED",
          qualifyingSourceTypes: ["platform", "attested"],
        },
      ],
    },
    budget: {
      unit: "credits",
      totalAmount,
      perObjective:
        totalAmount > 0 ? [{ objectiveId: "obj-1", amount: totalAmount }] : [],
    },
    attributionRules: [
      {
        id: "attr-1",
        objectiveId: "obj-1",
        model: incremental ? "experimental" : "deterministic",
        confidenceThreshold: 0.9,
        windowDays: 30,
        requiresExperiment: incremental,
      },
    ],
    clearingRules:
      totalAmount > 0
        ? [
            {
              id: "clear-1",
              objectiveId: "obj-1",
              basis: "attributed_outcome",
              drawKind: "reward_allocation",
              rewardPolicyId,
              maxDrawAmount: totalAmount,
            },
          ]
        : [],
    opportunitySpecs:
      opts.withSpec === false
        ? []
        : [
            {
              id: opts.specId ?? "spec-1",
              title: "Contribute to the campaign",
              opportunityType: "campaign_contribution",
              brief: { campaignObjective: "obj-1", neutral: true },
              contributionRequirements: { minEffort: "one verified action" },
              evidenceReferencePlaceholders: ["evidence-outcome-claim"],
            },
          ],
  };
}

export interface DefinePolicyOptions extends PolicySectionsOptions {
  readonly actorPersonId?: string;
  readonly idempotencyKey?: string;
}

/** Define the next policy version (default: the valid default policy). */
export async function definePolicy(
  harness: NetW011Harness,
  campaign: CampaignRecord,
  opts: DefinePolicyOptions = {},
): Promise<CampaignPolicy> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.ownerPersonId,
    "w011-policy",
  );
  const sections = await defaultPolicySections(harness, opts);
  const result = await harness.runtime.campaignService.defineCampaignPolicy(
    ctx,
    {
      campaignId: campaign.id,
      policy: sections,
      idempotencyKey: opts.idempotencyKey ?? key("w011-policy"),
    },
  );
  return result.policy;
}

/**
 * The composition-root budget-commit sequence: the stake through the
 * SETTLEMENT authority, then the campaign bookkeeping record.
 */
export async function commitDefaultBudget(
  harness: NetW011Harness,
  campaign: CampaignRecord,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<CampaignRecord> {
  const k = opts.idempotencyKey ?? key("w011-budget");
  const ctx = ownerCtx(harness, "w011-budget");
  const policies = await harness.runtime.campaignService.listPolicyVersions(
    ctx,
    campaign.id,
  );
  const policy = policies[policies.length - 1]!;
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: campaign.organizationScopeId,
    ownerPersonId: campaign.ownerPersonId,
    amount: policy.budget.totalAmount,
    purpose: { kind: "campaign_budget", id: campaign.id },
    description: `campaign budget escrow for campaign ${campaign.id}`,
    idempotencyKey: `${k}:stake`,
  });
  return harness.runtime.campaignService.recordBudgetCommitment(ctx, {
    campaignId: campaign.id,
    stakeId: staked.stake.id,
    idempotencyKey: `${k}:record`,
  });
}

/**
 * The composition-root release sequence: the release through the
 * SETTLEMENT authority, then the campaign bookkeeping record.
 */
export async function releaseDefaultBudget(
  harness: NetW011Harness,
  campaign: CampaignRecord,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<CampaignRecord> {
  const k = opts.idempotencyKey ?? key("w011-release");
  const ctx = ownerCtx(harness, "w011-release");
  const latest = await harness.runtime.campaignService.getCampaign(
    ctx,
    campaign.id,
  );
  const released = await harness.runtime.stakeService.releaseStake(ctx, {
    stakeId: latest.budget.stakeId!,
    reason: `campaign ${campaign.id} terminal — budget release`,
    idempotencyKey: `${k}:release`,
  });
  return harness.runtime.campaignService.recordBudgetRelease(ctx, {
    campaignId: campaign.id,
    stakeId: released.id,
    idempotencyKey: `${k}:record`,
  });
}

/**
 * The composition-root publish sequence: resolve the draft, compose
 * the opportunity through the opportunities boundary, record the
 * publication.
 */
export async function publishDefaultOpportunity(
  harness: NetW011Harness,
  campaign: CampaignRecord,
  opts: {
    readonly specId?: string;
    readonly idempotencyKey?: string;
  } = {},
): Promise<{ campaign: CampaignRecord; opportunityId: string }> {
  const k = opts.idempotencyKey ?? key("w011-publish");
  const ctx = ownerCtx(harness, "w011-publish");
  const draft = await harness.runtime.campaignService.resolveOpportunityDraft(
    ctx,
    campaign.id,
    opts.specId ?? "spec-1",
  );
  const opportunity =
    await harness.runtime.opportunityService.createOpportunity(ctx, {
      organizationScopeId: draft.organizationScopeId,
      ownerId: campaign.ownerPersonId,
      opportunityType: draft.opportunityType,
      title: draft.title,
      brief: draft.brief,
      eligibilityPolicyReference: draft.eligibilityPolicyReference,
      contributionRequirements: draft.contributionRequirements,
      evidenceReferencePlaceholders: draft.evidenceReferencePlaceholders,
    });
  const updated =
    await harness.runtime.campaignService.recordOpportunityPublication(ctx, {
      campaignId: campaign.id,
      specId: draft.specId,
      policyVersion: draft.policyVersion,
      opportunityId: opportunity.id,
      idempotencyKey: `${k}:record`,
    });
  return { campaign: updated, opportunityId: opportunity.id };
}

/**
 * A fully activated campaign: created + policy v1 + credits ensured +
 * budget escrowed + recorded + activated (ACTIVE).
 */
export async function activateReadyCampaign(
  harness: NetW011Harness,
  opts: DefinePolicyOptions & { readonly skipBudget?: boolean } = {},
): Promise<CampaignRecord> {
  const campaign = await createCampaign(harness);
  const policy = await definePolicy(harness, campaign, opts);
  if (policy.budget.totalAmount > 0 && !opts.skipBudget) {
    await ensureCreditsFor(
      harness.w010,
      harness.ownerPersonId,
      policy.budget.totalAmount,
    );
    await commitDefaultBudget(harness, campaign);
  }
  const ctx = ownerCtx(harness, "w011-activate");
  return harness.runtime.campaignService.activateCampaign(ctx, {
    campaignId: campaign.id,
    idempotencyKey: key("w011-activate"),
  });
}

export { w010PersonCtx };
