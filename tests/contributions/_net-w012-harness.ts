/**
 * NET-W012 shared test harness.
 *
 * Wraps the NET-W011 harness (runtime + persons + organizations + the
 * campaign factories incl. the composition-root budget/publish
 * sequences) and adds:
 *  - the helpful-contribution guard actions (9 mutations) + the
 *    contribution forward-transition policies (the publication walk's
 *    /workflows authorization);
 *  - the helpfulness-policy factory (a complete deterministic
 *    criteria policy);
 *  - the helpful-campaign factory (an ACTIVE campaign publishing a
 *    HELPFUL-typed opportunity spec with an eligibility rule — the
 *    first fail-closed consumer of the NET-W011 eligibility
 *    reference);
 *  - the helpful-contribution factory (Contribution + PoH created
 *    atomically through the service);
 *  - the evidence/observation basis factories (REAL /evidence and
 *    /outcomes records with the contribution as their subject);
 *  - the publication composite (assertPublishable → the workflow
 *    walk → recordPublication) exactly as the runtime apiCommand
 *    executes it.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW011Harness,
  createCampaign as w011CreateCampaign,
  defaultPolicySections as w011DefaultPolicySections,
  publishDefaultOpportunity as w011PublishDefaultOpportunity,
  ownerCtx,
  personCtx as w011PersonCtx,
  key as w011Key,
  type NetW008HarnessOptions,
  type NetW011Harness,
} from "../campaigns/_net-w011-harness.ts";
export type { NetW008HarnessOptions };
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  CommercialDisclosureRecord,
  HelpfulnessPolicy,
  HelpfulnessPolicySections,
  ProofOfHelpfulness,
} from "../../src/contributions/port.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";

export interface NetW012Harness {
  /** The wrapped NET-W011 harness (all its factories work unchanged). */
  readonly w011: NetW011Harness;
  readonly runtime: NetW011Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The contributor (the harness person; also the campaign owner). */
  readonly contributorPersonId: string;
  /** A different person in the same org (non-contributor proofs). */
  readonly otherPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "helpfulness.policy",
  "helpful_contribution.create",
  "helpful_recommendation.prepare",
  "helpful_contribution.publish",
  "helpful_disclosure.declare",
  "helpful_disclosure.retract",
  "helpful_advisory.record",
  "helpful_poh.basis",
  "helpful_poh.evaluate",
];

// The publication walk's forward transitions (authorized for any
// actor at the policy layer — the USER-CONTROLLED gate is the domain's
// person-actor == contributor check, which is what the tests prove).
const PUBLICATION_TRANSITIONS = [
  "contribution.transition.draft_to_ready",
  "contribution.transition.ready_to_assigned",
  "contribution.transition.assigned_to_in_progress",
  "contribution.transition.in_progress_to_submitted",
];

export async function createNetW012Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW012Harness> {
  const w011 = await createNetW011Harness(opts);
  const runtime = w011.runtime;
  const bootstrapCtx = w011.bootstrapCtx;

  for (const action of [...GUARD_ACTIONS, ...PUBLICATION_TRANSITIONS]) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w011,
    runtime,
    bootstrapCtx,
    contributorPersonId: w011.ownerPersonId,
    otherPersonId: w011.otherPersonId,
    organizationScopeId: w011.organizationScopeId,
    secondOrgId: w011.secondOrgId,
    secondOrgPersonId: w011.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** An execution context for a specific person. */
export function personCtx(
  harness: NetW012Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The contributor's context. */
export function contributorCtx(
  harness: NetW012Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.contributorPersonId, correlationId);
}

/** A non-contributor person's context (same org). */
export function otherCtx(
  harness: NetW012Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.otherPersonId, correlationId);
}

/** A system-actor context (the protocol — can NEVER publish). */
export function systemCtx(correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: "system-worker", kind: "system" },
  });
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Helpfulness policy factory
// ---------------------------------------------------------------------------

export interface PolicySectionsOptions {
  readonly minimumGrade?: string;
  readonly minimumConfidence?: number;
  readonly minimumQualifyingBases?: number;
  readonly minimumIndependentSources?: number;
  readonly qualifyingSourceTypes?: readonly string[];
  readonly qualifyingOutcomeTypes?: readonly string[];
  readonly qualifyingBasisKinds?: readonly string[];
  readonly requiresDisclosure?: boolean;
  readonly maxAdvisoryWeight?: number;
}

/**
 * A complete, valid deterministic helpfulness policy: evidence-record
 * + measured-outcome + PoV bases, ATTESTED minimum grade, platform/
 * attested sources, helpfulness outcome type, confidence 0.7, one
 * qualifying basis + one independent source, advisory model scores
 * capped at weight 1.0 (recorded, never qualifying), disclosure
 * required.
 */
export function defaultPolicySections(
  opts: PolicySectionsOptions = {},
): HelpfulnessPolicySections {
  return {
    qualifyingBasisKinds: (opts.qualifyingBasisKinds ?? [
      "evidence_record",
      "measured_outcome",
      "proof_of_value",
    ]) as HelpfulnessPolicySections["qualifyingBasisKinds"],
    minimumGrade: (opts.minimumGrade ?? "ATTESTED") as HelpfulnessPolicySections["minimumGrade"],
    qualifyingSourceTypes: (opts.qualifyingSourceTypes ?? [
      "platform",
      "attested",
    ]) as HelpfulnessPolicySections["qualifyingSourceTypes"],
    qualifyingOutcomeTypes: (opts.qualifyingOutcomeTypes ?? [
      "helpfulness",
    ]) as HelpfulnessPolicySections["qualifyingOutcomeTypes"],
    minimumConfidence: opts.minimumConfidence ?? 0.7,
    minimumIndependentSources: opts.minimumIndependentSources ?? 1,
    minimumQualifyingBases: opts.minimumQualifyingBases ?? 1,
    advisory: {
      allowedKinds: ["model_score", "heuristic_score"],
      maxAdvisoryWeight: opts.maxAdvisoryWeight ?? 1,
    },
    requiresDisclosure: opts.requiresDisclosure ?? true,
    description: "deterministic helpfulness criteria (test policy)",
  };
}

export interface CreatePolicyOptions extends PolicySectionsOptions {
  readonly policyId?: string;
  readonly actorPersonId?: string;
  readonly organizationScopeId?: string;
  readonly idempotencyKey?: string;
}

/** Define helpfulness policy version 1 (or the requested version). */
export async function createHelpfulnessPolicy(
  harness: NetW012Harness,
  opts: CreatePolicyOptions = {},
): Promise<HelpfulnessPolicy> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.contributorPersonId,
    "w012-policy",
  );
  const result = await harness.runtime.helpfulnessService.defineHelpfulnessPolicy(
    ctx,
    {
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      policyId: opts.policyId ?? key("w012-policy"),
      sections: defaultPolicySections(opts),
      idempotencyKey: opts.idempotencyKey ?? key("w012-policy"),
    },
  );
  return result.policy;
}

// ---------------------------------------------------------------------------
// Helpful campaign factory (an ACTIVE campaign publishing a HELPFUL
// opportunity with an eligibility rule)
// ---------------------------------------------------------------------------

export interface CreateHelpfulCampaignOptions {
  readonly eligibilityRule?: {
    readonly attribute: string;
    readonly operator: string;
    readonly values: readonly string[];
  };
  readonly totalAmount?: number;
}

/**
 * A fully activated campaign whose spec-1 publishes a
 * HELPFUL_RECOMMENDATION opportunity (the eligibility reference's
 * first consuming path). Returns the published opportunity id.
 */
export async function createHelpfulCampaign(
  harness: NetW012Harness,
  opts: CreateHelpfulCampaignOptions = {},
): Promise<{ campaign: CampaignRecord; opportunityId: string }> {
  const campaign = await w011CreateCampaign(harness.w011, {
    name: "Helpful contributions campaign",
  });
  const sections = await w011DefaultPolicySections(harness.w011, {
    totalAmount: opts.totalAmount ?? 0,
    objectiveKind: "engagement",
  });
  const helpfulSections = {
    ...sections,
    eligibility: {
      rules: [
        opts.eligibilityRule ?? {
          attribute: "participant_class",
          operator: "equals",
          values: ["contributor"],
        },
      ],
    },
    opportunitySpecs: [
      {
        id: "spec-1",
        title: "Recommend something genuinely useful",
        opportunityType: "helpful_recommendation",
        brief: { campaignObjective: "obj-1", neutral: true },
        contributionRequirements: { minEffort: "one evidenced action" },
        evidenceReferencePlaceholders: ["evidence-outcome-claim"],
      },
    ],
  };
  // Define the HELPFUL policy explicitly (the W011 factory cannot
  // carry custom sections through its options).
  const ctx = ownerCtx(harness.w011, "w012-campaign-policy");
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: helpfulSections as unknown as Parameters<
      typeof harness.runtime.campaignService.defineCampaignPolicy
    >[1]["policy"],
    idempotencyKey: key("w012-campaign-policy"),
  });
  // Zero-budget campaign: no escrow needed; activate directly.
  const activated = await harness.runtime.campaignService.activateCampaign(
    ownerCtx(harness.w011, "w012-activate"),
    { campaignId: campaign.id, idempotencyKey: key("w012-activate") },
  );
  const published = await w011PublishDefaultOpportunity(
    harness.w011,
    activated,
    { specId: "spec-1" },
  );
  return { campaign: published.campaign, opportunityId: published.opportunityId };
}

// ---------------------------------------------------------------------------
// Helpful contribution factory
// ---------------------------------------------------------------------------

export interface CreateContributionOptions {
  readonly opportunityId?: string;
  readonly contributorPersonId?: string;
  readonly organizationScopeId?: string;
  readonly contributionType?: string;
  readonly mentions?: readonly {
    readonly productRef: string;
    readonly disclosed: boolean;
    readonly commercialRelationshipRef: string | null;
  }[];
  readonly claimantAttributes?: Readonly<Record<string, readonly string[]>>;
  readonly helpfulnessPolicyId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Create a helpful contribution + its Proof-of-Helpfulness through the
 * domain service (the same path the apiCommand takes).
 */
export async function createHelpfulContribution(
  harness: NetW012Harness,
  opts: CreateContributionOptions = {},
): Promise<{
  contribution: Contribution;
  proofOfHelpfulness: ProofOfHelpfulness;
}> {
  const ctx = personCtx(
    harness,
    opts.contributorPersonId ?? harness.contributorPersonId,
    "w012-create",
  );
  // Auto-provision the dependencies when not supplied (the typical
  // happy-path fixture: an ACTIVE helpful campaign + a policy v1).
  const opportunityId =
    opts.opportunityId ??
    (await createHelpfulCampaign(harness)).opportunityId;
  const helpfulnessPolicyId =
    opts.helpfulnessPolicyId ??
    (await createHelpfulnessPolicy(harness)).policyId;
  const result = await harness.runtime.helpfulnessService.createHelpfulContribution(
    ctx,
    {
      opportunityId,
      contributorId: opts.contributorPersonId ?? harness.contributorPersonId,
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      contributionType: (opts.contributionType ??
        "helpful_recommendation") as "helpful_recommendation",
      submission: {
        claimantAttributes: opts.claimantAttributes ?? {
          participant_class: ["contributor"],
          region: ["test-region"],
        },
        mentions: opts.mentions ?? [],
        contentRef: "content://drafts/test-helpful-draft",
        channel: "test-channel",
      },
      helpfulnessPolicyId,
      idempotencyKey: opts.idempotencyKey ?? key("w012-create"),
    },
  );
  return {
    contribution: result.contribution,
    proofOfHelpfulness: result.proofOfHelpfulness,
  };
}

// ---------------------------------------------------------------------------
// Disclosure + evidence + publication factories
// ---------------------------------------------------------------------------

export async function declareDefaultDisclosure(
  harness: NetW012Harness,
  contributionId: string,
  opts: { readonly relationshipRef?: string } = {},
): Promise<CommercialDisclosureRecord> {
  const ctx = contributorCtx(harness, "w012-disclosure");
  return harness.runtime.helpfulnessService.declareDisclosure(ctx, {
    contributionId,
    contributorPersonId: harness.contributorPersonId,
    relationshipKind: "affiliate",
    relationshipRef: opts.relationshipRef ?? "rel-acme",
    productRef: "product:acme-widget",
    counterpartyRef: "org:acme",
    description: "affiliate relationship with acme",
    idempotencyKey: key("w012-disclosure"),
  });
}

export interface EvidenceBasisOptions {
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
  readonly sourceId?: string;
  readonly point?: number;
}

/**
 * Create a REAL /evidence record with the contribution as its subject
 * and attach it as an evidence_record basis.
 */
export async function attachEvidenceBasis(
  harness: NetW012Harness,
  contributionId: string,
  opts: EvidenceBasisOptions = {},
): Promise<{ evidenceId: string; poh: ProofOfHelpfulness }> {
  const ctx = contributorCtx(harness, "w012-evidence");
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.contributorPersonId,
    subjectReference: { subjectId: contributionId, subjectType: "contribution" },
    provenance: {
      sourceType: opts.sourceType ?? "attested",
      ...(opts.sourceId !== undefined
        ? { sourceId: opts.sourceId }
        : { sourceId: `src-${key("w012")}` }),
      method: "community-attestation",
    },
    confidence: {
      point: opts.point ?? 0.9,
      lower: 0.8,
      upper: 0.95,
    },
    sensitivity: "standard",
    payload: { helpful: true, signals: ["resolved-question"] },
  });
  const poh = await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId,
    kind: "evidence_record",
    referenceId: evidence.id,
    idempotencyKey: key("w012-basis"),
  });
  return { evidenceId: evidence.id, poh };
}

/**
 * The publication composite EXACTLY as the runtime apiCommand executes
 * it: assertPublishable → the workflow walk → recordPublication.
 */
export async function publishHelpfulContribution(
  harness: NetW012Harness,
  contributionId: string,
  opts: { readonly actorPersonId?: string; readonly idempotencyKey?: string } = {},
): Promise<{
  contribution: Contribution;
  proofOfHelpfulness: ProofOfHelpfulness;
}> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.contributorPersonId,
    "w012-publish",
  );
  const result = await harness.runtime.apiCommands.publishHelpfulContribution(
    ctx,
    opts.actorPersonId ?? harness.contributorPersonId,
    {
      contributionId,
      idempotencyKey: opts.idempotencyKey ?? key("w012-publish"),
    },
  );
  return {
    contribution: result.contribution as unknown as Contribution,
    proofOfHelpfulness: result.proofOfHelpfulness as unknown as ProofOfHelpfulness,
  };
}

export { w011PersonCtx, w011Key };
