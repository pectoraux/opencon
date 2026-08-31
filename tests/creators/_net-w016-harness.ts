/**
 * NET-W016 shared test harness.
 *
 * Wraps the NET-W015 harness (runtime + creator profile factories +
 * the canonical reputation snapshot factory) and adds:
 *  - the creator matching guard action (`creators.matching.run`);
 *  - a campaign factory (a campaign + policy version carrying
 *    language/region eligibility rules — the neutral campaign
 *    lookup's resolution target);
 *  - a MATCH CANDIDATE factory (a fresh canonical person + ACTIVE
 *    creator profile with customizable sections);
 *  - a risk-control factory (policy → assessment → an ACTIVE
 *    participant_eligibility HOLD — the safety gate's target);
 *  - the baseline matching requirements + the runMatch wrapper.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createDefaultSections,
  createNetW015Harness,
  key as w015Key,
  personCtx,
  type NetW008HarnessOptions,
  type NetW015Harness,
} from "./_net-w015-harness.ts";
export type { NetW008HarnessOptions };
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  CampaignPolicy,
  CampaignRecord,
} from "../../src/campaigns/port.ts";
import type {
  CreatorMatchRequirements,
  CreatorMatchRunRecord,
  CreatorProfileRecord,
  CreatorProfileSections,
  CreatorProfileVersion,
  RunCreatorMatchInput,
} from "../../src/creators/port.ts";

export interface NetW016Harness {
  /** The wrapped NET-W015 harness (all its factories work unchanged). */
  readonly w015: NetW015Harness;
  readonly runtime: NetW015Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The default creator (nonzero canonical reputation scores). */
  readonly creatorPersonId: string;
  /** A different person in the same org (the match operator). */
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = ["creators.matching.run"];

export async function createNetW016Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW016Harness> {
  const w015 = await createNetW015Harness(opts);
  const runtime = w015.runtime;
  const bootstrapCtx = w015.bootstrapCtx;

  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w015,
    runtime,
    bootstrapCtx,
    creatorPersonId: w015.creatorPersonId,
    operatorPersonId: w015.otherPersonId,
    organizationScopeId: w015.organizationScopeId,
    secondOrgId: w015.secondOrgId,
    secondOrgPersonId: w015.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person's execution context. */
export function matchCtx(
  harness: NetW016Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The match operator's execution context. */
export function operatorCtx(
  harness: NetW016Harness,
  correlationId: string,
): ExecutionContext {
  return matchCtx(harness, harness.operatorPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { w015Key };

// ---------------------------------------------------------------------------
// The match-candidate factory (fresh person + ACTIVE creator profile)
// ---------------------------------------------------------------------------

export interface CandidateOverrides {
  /** Platform connection capabilities (formats offered). */
  readonly capabilities?: readonly string[];
  /** Platform connection languages. */
  readonly languages?: readonly string[];
  /** Audience size band. */
  readonly sizeBand?: string;
  /** Audience engagement band. */
  readonly engagementBand?: string;
  /** Audience top geographies (territory → share). */
  readonly topGeographies?: readonly { readonly territory: string; readonly share: number }[];
  /** Declared commercial rates. */
  readonly rates?: readonly {
    readonly format: string;
    readonly unit: string;
    readonly amount: number;
    readonly currency: string;
  }[];
  /** Granted rights kinds. */
  readonly rights?: readonly string[];
  /** Restricted topics (lowercased matching is exercised in tests). */
  readonly restrictedTopics?: readonly string[];
  /** Restricted formats. */
  readonly restrictedFormats?: readonly string[];
  /** Restricted territories. */
  readonly restrictedTerritories?: readonly string[];
  readonly acceptingWork?: boolean;
  readonly weeklyCapacity?: number;
  readonly minimumNoticeDays?: number;
  readonly acceptsDirectCampaigns?: boolean;
  readonly requiresInvitation?: boolean;
  /** Skip activation (leave the profile DRAFT/PAUSED for gate tests). */
  readonly skipActivation?: boolean;
  /** Skip the version definition (no sections — the no_profile_version gate). */
  readonly skipVersion?: boolean;
  /** Use the W015 default sections verbatim (no overrides applied). */
  readonly defaultSections?: boolean;
  readonly subjectPersonId?: string;
}

export interface MatchCandidate {
  readonly personId: string;
  readonly profile: CreatorProfileRecord;
  readonly version: CreatorProfileVersion | null;
}

/**
 * Create a fresh match candidate: a NEW canonical person with an
 * ACTIVE creator profile whose sections default to the W015 fixture
 * shape (overridable). The reputation references point at canonical
 * snapshots recorded for the subject person (empty-input snapshots —
 * deterministic zero scores; the DEFAULT harness creator is the
 * nonzero-score fixture).
 */
export async function createMatchCandidate(
  harness: NetW016Harness,
  opts: CandidateOverrides = {},
): Promise<MatchCandidate> {
  const personId =
    opts.subjectPersonId ??
    (await (async () => {
      const person = await harness.runtime.identityService.createIdentity(
        harness.bootstrapCtx,
        {
          displayName: "W016 Candidate",
          subjectReferences: [
            {
              subjectId: `w016-candidate-${key("subject")}@example.com`,
              providerKind: "internal",
            },
          ],
        },
      );
      return person.id;
    })());
  const ctx = matchCtx(harness, personId, "w016-candidate");

  const { profile } = await harness.runtime.creatorService.createProfile(ctx, {
    organizationScopeId: harness.organizationScopeId,
    creatorPersonId: personId,
    displayName: "W016 Candidate",
    idempotencyKey: key("w016-profile"),
  });

  let version: CreatorProfileVersion | null = null;
  if (!opts.skipVersion) {
    const base = await createDefaultSections(harness.w015, {
      subjectPersonId: personId,
    });
    const sections: CreatorProfileSections = opts.defaultSections
      ? base
      : {
          ...base,
          // Capability/language overrides apply to EVERY platform
          // connection (the gates evaluate the UNION across
          // connections — an override must not be silently undone by
          // a non-overridden connection).
          platforms: base.platforms.map((platform) => ({
            ...platform,
            capabilities: (opts.capabilities ??
              platform.capabilities) as CreatorProfileSections["platforms"][number]["capabilities"],
            languages: (opts.languages ??
              platform.languages) as CreatorProfileSections["platforms"][number]["languages"],
          })),
          audience: {
            ...base.audience,
            ...(opts.sizeBand ? { sizeBand: opts.sizeBand as never } : {}),
            ...(opts.engagementBand
              ? { engagementBand: opts.engagementBand as never }
              : {}),
            ...(opts.topGeographies
              ? { topGeographies: opts.topGeographies }
              : {}),
          },
          commercial: {
            ...base.commercial,
            ...(opts.rates ? { rates: opts.rates as never } : {}),
          },
          rights: (opts.rights
            ? (opts.rights.map((kind) => ({ kind, terms: null })) as never)
            : base.rights),
          restrictions: {
            ...base.restrictions,
            ...(opts.restrictedTopics
              ? { restrictedTopics: opts.restrictedTopics }
              : {}),
            ...(opts.restrictedFormats
              ? { restrictedFormats: opts.restrictedFormats as never }
              : {}),
            ...(opts.restrictedTerritories
              ? { restrictedTerritories: opts.restrictedTerritories }
              : {}),
          },
          availability: {
            ...base.availability,
            ...(opts.acceptingWork !== undefined
              ? { acceptingWork: opts.acceptingWork }
              : {}),
            ...(opts.weeklyCapacity !== undefined
              ? { weeklyCapacity: opts.weeklyCapacity }
              : {}),
            ...(opts.minimumNoticeDays !== undefined
              ? { minimumNoticeDays: opts.minimumNoticeDays }
              : {}),
          },
          participation: {
            ...base.participation,
            ...(opts.acceptsDirectCampaigns !== undefined
              ? { acceptsDirectCampaigns: opts.acceptsDirectCampaigns }
              : {}),
            ...(opts.requiresInvitation !== undefined
              ? { requiresInvitation: opts.requiresInvitation }
              : {}),
          },
        };
    const defined = await harness.runtime.creatorService.defineProfileVersion(
      ctx,
      {
        profileId: profile.id,
        sections,
        idempotencyKey: key("w016-version"),
      },
    );
    version = defined.version;
  }

  if (!opts.skipActivation) {
    const activated = await harness.runtime.creatorService.activateProfile(
      ctx,
      { profileId: profile.id, idempotencyKey: key("w016-activate") },
    );
    return { personId, profile: activated, version };
  }
  return { personId, profile, version };
}

// ---------------------------------------------------------------------------
// The campaign factory (language/region eligibility rules)
// ---------------------------------------------------------------------------

export interface CampaignFactoryOptions {
  /** Eligibility rules overriding the default language/region set. */
  readonly eligibilityRules?: readonly {
    readonly attribute: "participant_class" | "region" | "language" | "contribution_type" | "evidence_grade" | "measurement_kind";
    readonly operator: "equals" | "not_equals" | "in" | "not_in" | "gte" | "lte";
    readonly values: readonly string[];
  }[];
  readonly ownerPersonId?: string;
  readonly organizationScopeId?: string;
}

/**
 * A campaign + policy version 1 carrying language/region eligibility
 * rules (the neutral campaign lookup derives requiredLanguages /
 * targetTerritories from them). The budget is zero so no clearing
 * rules or reward policies are needed.
 */
export async function createCampaignWithRules(
  harness: NetW016Harness,
  opts: CampaignFactoryOptions = {},
): Promise<{ campaign: CampaignRecord; policy: CampaignPolicy }> {
  const ctx = matchCtx(
    harness,
    opts.ownerPersonId ?? harness.operatorPersonId,
    "w016-campaign",
  );
  const organizationScopeId =
    opts.organizationScopeId ?? harness.organizationScopeId;
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId,
      name: "W016 Match Campaign",
      description: "creator matching fixture campaign",
      idempotencyKey: key("w016-campaign"),
    },
  );
  const result = await harness.runtime.campaignService.defineCampaignPolicy(
    ctx,
    {
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
        eligibility: {
          rules: opts.eligibilityRules ?? [
            { attribute: "language", operator: "equals", values: ["en"] },
            { attribute: "region", operator: "in", values: ["GH", "NG"] },
          ],
        },
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
        opportunitySpecs: [],
      },
      idempotencyKey: key("w016-policy"),
    },
  );
  return { campaign, policy: result.policy };
}

// ---------------------------------------------------------------------------
// The risk-control factory (an ACTIVE participant_eligibility HOLD)
// ---------------------------------------------------------------------------

/**
 * Activate an ACTIVE participant_eligibility HOLD control on a person
 * (policy → assessment → control — the minimal evidence-backed
 * chain). Returns the control id (the safety gate's target).
 */
export async function activateEligibilityHold(
  harness: NetW016Harness,
  subjectPersonId: string,
): Promise<string> {
  const ctx = matchCtx(harness, harness.operatorPersonId, "w016-risk");
  const policyId = `w016-risk-policy-${key("p")}`;
  await harness.runtime.riskPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId,
    version: 1,
    description: "NET-W016 test risk policy",
    rules: [
      {
        category: "identity",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
    ],
    thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
    criticalFloorState: "HOLD",
    advisoryOnlyCapState: "REVIEW",
    requiredCategories: ["identity"],
    missingDataState: "HOLD",
  });
  const { assessment } =
    await harness.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId,
      policyId,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: key("w016-assessment"),
    });
  const { control } = await harness.runtime.riskControlService.activateControl(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass: "participant_eligibility",
      action: "HOLD",
      subjectPersonId,
      originAssessmentId: assessment.id,
      reasonCodes: ["w016_test_hold"],
      description: "NET-W016 eligibility hold fixture",
      idempotencyKey: key("w016-control"),
    },
  );
  return control.id;
}

// ---------------------------------------------------------------------------
// The baseline requirements + the runMatch wrapper
// ---------------------------------------------------------------------------

/** The permissive baseline requirements (no hard constraints). */
export function baselineRequirements(): CreatorMatchRequirements {
  return {
    requiredFormats: [],
    requiredLanguages: [],
    targetTerritories: [],
    campaignTopics: [],
    requiredRightsKinds: [],
    rateCeiling: null,
    minimumAudienceSizeBand: null,
    minimumReputation: { audienceInfluence: null, production: null },
    noticeWindowDays: null,
  };
}

/** Run a match through the wired service (the operator acts). */
export async function runMatch(
  harness: NetW016Harness,
  input: Partial<RunCreatorMatchInput> & { readonly idempotencyKey: string },
): Promise<{ run: CreatorMatchRunRecord; created: boolean }> {
  const ctx =
    (input as { readonly _ctx?: ExecutionContext })._ctx ??
    operatorCtx(harness, "w016-run-match");
  return harness.runtime.creatorMatchingService.runMatch(ctx, {
    organizationScopeId: harness.organizationScopeId,
    requirements: baselineRequirements(),
    ...input,
  } as RunCreatorMatchInput);
}
