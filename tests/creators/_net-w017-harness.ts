/**
 * NET-W017 shared test harness.
 *
 * Wraps the NET-W016 harness (runtime + creator/match candidate
 * factories + campaign factory + risk-control factory) and adds:
 *  - the NET-W017 guard actions (engagement/production/rights
 *    commands) + ALLOW policies for every engagement transition
 *    policy action (seeded for the harness persons, scoped to the
 *    harness organization — the W004 harness pattern);
 *  - an ACTIVATED campaign factory (the tender precondition's
 *    publishable-status target);
 *  - the requested/granted usage-rights fixtures (valid envelopes);
 *  - the acceptance-policy factory;
 *  - the canonical-evidence factory (subject-bound to a
 *    ugc_production subject through the canonical evidence service);
 *  - the golden-path engagement flow helpers (create → tender →
 *    accept → production → deliverable → evidence → submit).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW016Harness,
  key as w016Key,
  matchCtx,
  type NetW016Harness,
} from "./_net-w016-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import { ENGAGEMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import type {
  AcceptEngagementInput,
  CreateEngagementInput,
  Engagement,
  EngagementRequestedRights,
  UgcProduction,
  UsageRightsGrant,
  UsageRightsView,
} from "../../src/creators/port.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";
import type { ApiRequestTransitionInput } from "../../src/api/port.ts";

export interface NetW017Harness {
  readonly w016: NetW016Harness;
  readonly runtime: NetW016Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The creator person (the engagement's creator/grantor). */
  readonly creatorPersonId: string;
  /** A different person in the same org (the operator/organizer). */
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "creators.engagements.create",
  "creators.engagements.createFromMatch",
  "creators.engagements.accept",
  "creators.engagements.autoAccept",
  "creators.usageRights.revoke",
  "creators.acceptancePolicy.set",
  "creators.productions.open",
  "creators.productions.deliverable",
  "creators.productions.submit",
];

export async function createNetW017Harness(): Promise<NetW017Harness> {
  const w016 = await createNetW016Harness();
  const runtime = w016.runtime;
  const bootstrapCtx = w016.bootstrapCtx;

  // An ACTIVE creator profile for the default creator person (the
  // engagement creator/grantor — the W015 profile fixture).
  const { createActiveCreatorProfile } = await import(
    "./_net-w015-harness.ts"
  );
  await createActiveCreatorProfile(w016.w015, {
    creatorPersonId: w016.creatorPersonId,
  });

  // The API guard actions for the composed engagement commands.
  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }
  // Per-transition ALLOW policies for the engagement subject kind
  // (scoped to the harness person + operator on the harness org, the
  // W004 harness pattern: the workflow service's per-subject
  // authorizer checks the subject's org scope against the policy's
  // resource).
  for (const personId of [w016.creatorPersonId, w016.operatorPersonId]) {
    for (const rule of ENGAGEMENT_TRANSITION_TABLE) {
      await runtime.policyService.createPolicy(bootstrapCtx, {
        subject: personId,
        action: rule.policyAction,
        resource: w016.organizationScopeId,
        effect: "allow",
        createdBy: "bootstrap",
      });
    }
  }

  return {
    w016,
    runtime,
    bootstrapCtx,
    creatorPersonId: w016.creatorPersonId,
    operatorPersonId: w016.operatorPersonId,
    organizationScopeId: w016.organizationScopeId,
    secondOrgId: w016.secondOrgId,
    secondOrgPersonId: w016.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person's execution context. */
export function personCtx(
  harness: NetW017Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The creator's execution context. */
export function creatorCtx(
  harness: NetW017Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.creatorPersonId, correlationId);
}

/** The operator's execution context. */
export function operatorCtx(
  harness: NetW017Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.operatorPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { w016Key, matchCtx };

// ---------------------------------------------------------------------------
// The activated-campaign factory
// ---------------------------------------------------------------------------

/**
 * A campaign + policy version carrying an opportunity spec (the
 * CAMP-002 activation gate's requirement) ACTIVATED in the harness
 * organization. Zero budget → no escrow needed.
 */
export async function createActiveCampaign(
  harness: NetW017Harness,
  opts: { readonly ownerPersonId?: string } = {},
): Promise<CampaignRecord> {
  const owner = opts.ownerPersonId ?? harness.operatorPersonId;
  const ctx = personCtx(harness, owner, "w017-campaign");
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      name: "W017 Engagement Campaign",
      description: "UGC engagement fixture campaign",
      idempotencyKey: key("w017-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "creator_content",
          description: "creator content objective",
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
          title: "Produce UGC for the campaign",
          opportunityType: "campaign_contribution",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-ugc-production"],
        },
      ],
    },
    idempotencyKey: key("w017-policy"),
  });
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w017-activate"),
    },
  );
  return activated;
}

// ---------------------------------------------------------------------------
// The usage-rights fixtures
// ---------------------------------------------------------------------------

/** A valid requested-rights envelope (the offer's terms). */
export function requestedRightsFixture(): {
  uses: { kind: string; terms: string | null }[];
  channels: string[];
  territories: string[];
  formats: string[];
  startsAt: string;
  endsAt: string;
  exclusions: string[];
} {
  const now = Date.now();
  return {
    uses: [
      { kind: "reuse_license", terms: "organic reuse on organizer surfaces" },
      { kind: "paid_amplification", terms: null },
    ],
    channels: ["organizer_channel", "network_channel"],
    territories: ["GH", "NG"],
    formats: ["short_video", "post"],
    startsAt: new Date(now - 86_400_000).toISOString(),
    endsAt: new Date(now + 30 * 86_400_000).toISOString(),
    exclusions: ["political advertising"],
  };
}

/** A granted-rights fixture WITHIN the requested envelope. */
export function grantedRightsFixture(): {
  uses: { kind: string; terms: string | null }[];
  channels: string[];
  territories: string[];
  formats: string[];
  startsAt: string;
  endsAt: string;
  exclusions: string[];
} {
  const requested = requestedRightsFixture();
  return {
    uses: [{ kind: "reuse_license", terms: null }],
    channels: ["organizer_channel"],
    territories: ["GH"],
    formats: ["short_video"],
    startsAt: requested.startsAt,
    endsAt: new Date(
      Date.parse(requested.endsAt) - 86_400_000,
    ).toISOString(),
    exclusions: ["political advertising", "gambling"],
  };
}

// ---------------------------------------------------------------------------
// The engagement command wrappers
// ---------------------------------------------------------------------------

export interface EngagementOverrides {
  readonly campaignId?: string;
  readonly creatorPersonId?: string;
  readonly matchRunId?: string | null;
  readonly opportunityId?: string | null;
  readonly requestedRights?: EngagementRequestedRights | Record<string, unknown>;
  readonly compensation?: Record<string, unknown> | null;
}

/** Create an engagement offer (DRAFT) through the wired service. */
export async function createEngagement(
  harness: NetW017Harness,
  opts: EngagementOverrides & { readonly idempotencyKey?: string } = {},
): Promise<{ engagement: Engagement; created: boolean }> {
  const ctx = personCtx(harness, harness.operatorPersonId, "w017-create");
  const input = {
    organizationScopeId: harness.organizationScopeId,
    creatorPersonId: opts.creatorPersonId ?? harness.creatorPersonId,
    campaignId: opts.campaignId ?? (await createActiveCampaign(harness)).id,
    matchRunId: opts.matchRunId ?? null,
    opportunityId: opts.opportunityId ?? null,
    requestedRights:
      (opts.requestedRights as Record<string, unknown>) ??
      requestedRightsFixture(),
    compensation:
      opts.compensation === undefined
        ? {
            format: "short_video",
            unit: "per_deliverable",
            amount: 500,
            currency: "USD",
            rewardPolicyReference: null,
          }
        : opts.compensation,
    brief: { note: "w017 fixture offer" },
    idempotencyKey: opts.idempotencyKey ?? key("w017-engagement"),
  } as unknown as CreateEngagementInput;
  return harness.runtime.creatorEngagementService.createEngagement(ctx, input);
}

/** Request a PURE lifecycle transition through the workflow service. */
export async function transitionEngagement(
  harness: NetW017Harness,
  input: {
    readonly engagementId: string;
    readonly from: string;
    readonly to: string;
    readonly expectedVersion: number;
    readonly actorPersonId?: string;
    readonly idempotencyKey?: string;
  },
): Promise<{ state: string; version: number; executed: boolean }> {
  const ctx = personCtx(
    harness,
    input.actorPersonId ?? harness.operatorPersonId,
    "w017-transition",
  );
  const apiInput: ApiRequestTransitionInput = {
    subjectId: input.engagementId,
    subjectKind: "engagement",
    targetState: input.to,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey ?? key("w017-transition"),
    policyAction: policyActionFor(
      "engagement",
      input.from as Parameters<typeof policyActionFor>[1],
      input.to as Parameters<typeof policyActionFor>[2],
    ),
  };
  const result = await harness.runtime.apiCommands.requestTransition(
    ctx,
    input.actorPersonId ?? harness.operatorPersonId,
    apiInput,
  );
  return {
    state: result.state,
    version: result.version,
    executed: result.executed,
  };
}

/** Tender an offer (DRAFT → READY) through the workflow authority. */
export async function tenderEngagement(
  harness: NetW017Harness,
  engagementId: string,
  expectedVersion: number,
): Promise<{ state: string; version: number }> {
  return transitionEngagement(harness, {
    engagementId,
    from: "DRAFT",
    to: "READY",
    expectedVersion,
  });
}

/** Manually accept a tendered offer (grant + READY → ASSIGNED). */
export async function acceptEngagement(
  harness: NetW017Harness,
  engagementId: string,
  expectedVersion: number,
  opts: {
    readonly grantedRights?: Record<string, unknown>;
    readonly actorPersonId?: string;
    readonly idempotencyKey?: string;
  } = {},
): Promise<{ engagement: Engagement; grant: UsageRightsGrant }> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.creatorPersonId,
    "w017-accept",
  );
  const input: AcceptEngagementInput = {
    organizationScopeId: harness.organizationScopeId,
    engagementId,
    expectedVersion,
    grantedRights:
      (opts.grantedRights as AcceptEngagementInput["grantedRights"]) ??
      grantedRightsFixture(),
    idempotencyKey: opts.idempotencyKey ?? key("w017-accept"),
  };
  const result =
    await harness.runtime.creatorEngagementService.acceptEngagement(ctx, input);
  return { engagement: result.engagement, grant: result.grant };
}

/** Set the creator's acceptance policy (append-only versions). */
export async function setAcceptancePolicy(
  harness: NetW017Harness,
  opts: {
    readonly creatorPersonId?: string;
    readonly mode?: string;
    readonly rateFloor?: {
      format: string;
      unit: string;
      amount: number;
      currency: string;
    } | null;
    readonly autoGrantableRights?: string[];
    readonly maxActiveEngagements?: number;
    readonly maxGrantDurationDays?: number | null;
  } = {},
): Promise<{ policyId: string; version: number }> {
  const creator = opts.creatorPersonId ?? harness.creatorPersonId;
  const ctx = personCtx(harness, creator, "w017-policy");
  const result =
    await harness.runtime.creatorEngagementService.setAcceptancePolicy(ctx, {
      organizationScopeId: harness.organizationScopeId,
      creatorPersonId: creator,
      mode: opts.mode ?? "auto_accept",
      maxActiveEngagements: opts.maxActiveEngagements ?? 5,
      rateFloor:
        opts.rateFloor === undefined
          ? {
              format: "short_video",
              unit: "per_deliverable",
              amount: 300,
              currency: "USD",
            }
          : opts.rateFloor,
      autoGrantableRights:
        opts.autoGrantableRights ?? ["reuse_license", "paid_amplification"],
      maxGrantDurationDays: opts.maxGrantDurationDays ?? 90,
      idempotencyKey: key("w017-acceptance"),
    });
  return { policyId: result.policy.id, version: result.policy.version };
}

/** Open production (record + ASSIGNED → IN_PROGRESS). */
export async function openProduction(
  harness: NetW017Harness,
  engagementId: string,
  expectedVersion: number,
  opts: { readonly contributionId?: string | null } = {},
): Promise<{ production: UgcProduction; engagementVersion: number }> {
  const ctx = personCtx(harness, harness.creatorPersonId, "w017-production");
  const result = await harness.runtime.creatorEngagementService.openProduction(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      engagementId,
      expectedVersion,
      contributionId: opts.contributionId ?? null,
      idempotencyKey: key("w017-production"),
    },
  );
  return {
    production: result.production,
    engagementVersion: result.transition.subject.version,
  };
}

/** Record a deliverable version. */
export async function recordDeliverable(
  harness: NetW017Harness,
  productionId: string,
  opts: {
    readonly deliverableKey?: string;
    readonly format?: string;
    readonly externalPlatform?: Record<string, unknown> | null;
  } = {},
) {
  const ctx = personCtx(harness, harness.creatorPersonId, "w017-deliverable");
  return harness.runtime.creatorEngagementService.recordDeliverable(ctx, {
    organizationScopeId: harness.organizationScopeId,
    productionId,
    deliverableKey: opts.deliverableKey ?? "hero-video",
    format: opts.format ?? "short_video",
    title: "Hero video",
    contentReference: "object-store://w017/hero-video-v1",
    externalPlatform:
      (opts.externalPlatform as never) ??
      ({
        provider: "example-platform",
        externalId: "ext-123",
        url: "https://example.com/ext-123",
      } as never),
    notes: "first cut",
    idempotencyKey: key("w017-deliverable"),
  });
}

/** Create a canonical evidence record bound to a ugc_production. */
export async function createProductionEvidence(
  harness: NetW017Harness,
  productionId: string,
  opts: { readonly subjectType?: string; readonly subjectId?: string } = {},
): Promise<{ evidenceId: string }> {
  const ctx = personCtx(harness, harness.creatorPersonId, "w017-evidence");
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: {
      subjectType: opts.subjectType ?? "ugc_production",
      subjectId: opts.subjectId ?? productionId,
    },
    provenance: {
      sourceType: "platform",
      sourceId: "example-platform",
      method: "w017 fixture capture",
      collectedAt: new Date().toISOString(),
      collectorId: harness.creatorPersonId,
    },
    confidence: {
      point: 0.9,
      lower: 0.8,
      upper: 0.95,
    },
    sensitivity: "standard",
    payload: { kind: "ugc_production_capture", productionId },
  });
  return { evidenceId: evidence.id };
}

/** Submit the production (record + IN_PROGRESS → SUBMITTED). */
export async function submitProduction(
  harness: NetW017Harness,
  productionId: string,
  expectedVersion: number,
  evidenceReferences: readonly string[],
): Promise<{ submissionId: string; engagementVersion: number }> {
  const ctx = personCtx(harness, harness.creatorPersonId, "w017-submit");
  const result = await harness.runtime.creatorEngagementService.submitProduction(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      productionId,
      expectedVersion,
      evidenceReferences: [...evidenceReferences],
      idempotencyKey: key("w017-submit"),
    },
  );
  return {
    submissionId: result.submission.id,
    engagementVersion: result.transition.subject.version,
  };
}

/** The full golden path: offer → tender → accept → production →
 * deliverable → evidence → submission. Returns the terminal state. */
export async function goldenPathEngagement(
  harness: NetW017Harness,
  opts: { readonly campaignId?: string } = {},
): Promise<{
  engagement: Engagement;
  grant: UsageRightsGrant;
  production: UgcProduction;
  submissionId: string;
  evidenceId: string;
}> {
  const campaignId = opts.campaignId ?? (await createActiveCampaign(harness)).id;
  const { engagement } = await createEngagement(harness, { campaignId });
  await tenderEngagement(harness, engagement.id, engagement.version);
  const accepted = await acceptEngagement(harness, engagement.id, 1);
  const opened = await openProduction(harness, accepted.engagement.id, 2);
  await recordDeliverable(harness, opened.production.id);
  const { evidenceId } = await createProductionEvidence(
    harness,
    opened.production.id,
  );
  const submitted = await submitProduction(
    harness,
    opened.production.id,
    opened.engagementVersion,
    [evidenceId],
  );
  const final = await harness.runtime.creatorEngagementService.getEngagement(
    personCtx(harness, harness.operatorPersonId, "w017-final"),
    harness.organizationScopeId,
    accepted.engagement.id,
  );
  return {
    engagement: final,
    grant: accepted.grant,
    production: opened.production,
    submissionId: submitted.submissionId,
    evidenceId,
  };
}

/** Read a usage-rights view (derived status evaluated at asOf). */
export async function getUsageRightsView(
  harness: NetW017Harness,
  grantId: string,
  asOf?: string | null,
): Promise<UsageRightsView> {
  return harness.runtime.creatorEngagementService.getUsageRights(
    personCtx(harness, harness.operatorPersonId, "w017-rights"),
    harness.organizationScopeId,
    grantId,
    asOf ?? null,
  );
}
