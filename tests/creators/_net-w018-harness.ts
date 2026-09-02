/**
 * NET-W018 shared test harness.
 *
 * Wraps the NET-W017 harness (runtime + engagement flow factories)
 * and adds:
 *  - the NET-W018 guard actions (commercial-relationship /
 *    publication / declaration / verification commands) + ALLOW
 *    policies for every publication transition policy action
 *    (seeded for the harness persons, scoped to the harness
 *    organization — the W004/W017 harness pattern);
 *  - a campaign factory whose policy version DECLARES a disclosure
 *    policy (required disclosure kinds);
 *  - the VERIFIED-engagement factory (the W017 golden path + the
 *    SUBMITTED → VERIFIED workflow transition);
 *  - the commercial-relationship factory;
 *  - the publication factory (DRAFT records on verified
 *    engagements);
 *  - the publication-evidence factory (canonical evidence records
 *    subject-bound to a publication through the canonical evidence
 *    service);
 *  - the disclosure-declaration factory;
 *  - the golden-path sponsorship flow helper (relationship →
 *    publication → declarations → verification).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW017Harness,
  createActiveCampaign as createW017ActiveCampaign,
  createEngagement as createW017Engagement,
  tenderEngagement as tenderW017Engagement,
  acceptEngagement as acceptW017Engagement,
  openProduction as openW017Production,
  recordDeliverable as recordW017Deliverable,
  createProductionEvidence as createW017ProductionEvidence,
  submitProduction as submitW017Production,
  key as w017Key,
  creatorCtx as w017CreatorCtx,
  operatorCtx as w017OperatorCtx,
  personCtx as w017PersonCtx,
  type NetW008HarnessOptions,
  type NetW017Harness,
} from "./_net-w017-harness.ts";
export type { NetW008HarnessOptions };
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import {
  PUBLICATION_TRANSITION_TABLE,
  PUBLICATION_SANCTIONED_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";
import type {
  CommercialRelationship,
  DisclosureDeclaration,
  PublicationRecord,
} from "../../src/creators/port.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";
import type { ApiRequestTransitionInput } from "../../src/api/port.ts";

export interface NetW018Harness {
  readonly w017: NetW017Harness;
  readonly runtime: NetW017Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  readonly creatorPersonId: string;
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "creators.commercialRelationships.create",
  "creators.commercialRelationships.terminate",
  "creators.publications.create",
  "creators.publications.declareDisclosure",
  "creators.publications.verify",
];

export async function createNetW018Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW018Harness> {
  // NET-W035 test-harness adjustment (declared in the W035 evidence
  // ledger's changed-file policy): forward the PRE-EXISTING
  // NetW008HarnessOptions (the W015/W016/W017 chain already threads
  // them down to createRuntime) so the W035 composition harness can
  // wire the REAL measurement provider registry (the NET-W006
  // createRuntime option) + the NET-W030 external-settlement trust
  // keys. Tests-only; no production source is touched — the same
  // pattern as the NET-W034 measurement threading.
  const w017 = await createNetW017Harness(opts);
  const runtime = w017.runtime;
  const bootstrapCtx = w017.bootstrapCtx;

  // The API guard actions for the composed sponsorship commands.
  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }
  // Per-transition ALLOW policies for the publication subject kind
  // (the W004/W017 harness pattern). BOTH tables: the generic
  // publication transitions AND the SANCTIONED verification edge —
  // the harness persons are deliberately AUTHORIZED for
  // `publication.transition.draft_to_verified` so tests can prove
  // the PR #36 remediation's structural point: an AUTHORIZED caller
  // requesting the verification transition through the GENERIC
  // workflow path is STILL rejected (the edge is absent from the
  // generic table) — authorization is not the gate; the sanction is.
  for (const personId of [w017.creatorPersonId, w017.operatorPersonId]) {
    const publicationRules: readonly {
      readonly policyAction: string;
    }[] = [
      ...PUBLICATION_TRANSITION_TABLE,
      ...PUBLICATION_SANCTIONED_TRANSITION_TABLE,
    ];
    for (const rule of publicationRules) {
      await runtime.policyService.createPolicy(bootstrapCtx, {
        subject: personId,
        action: rule.policyAction,
        resource: w017.organizationScopeId,
        effect: "allow",
        createdBy: "bootstrap",
      });
    }
  }

  return {
    w017,
    runtime,
    bootstrapCtx,
    creatorPersonId: w017.creatorPersonId,
    operatorPersonId: w017.operatorPersonId,
    organizationScopeId: w017.organizationScopeId,
    secondOrgId: w017.secondOrgId,
    secondOrgPersonId: w017.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person's execution context. */
export function personCtx(
  harness: NetW018Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The creator's execution context. */
export function creatorCtx(harness: NetW018Harness, correlationId: string) {
  return w017CreatorCtx(harness.w017, correlationId);
}

/** The operator's execution context. */
export function operatorCtx(harness: NetW018Harness, correlationId: string) {
  return w017OperatorCtx(harness.w017, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return w017Key(prefix);
}

export {
  w017PersonCtx as personContext,
  createW017ActiveCampaign,
  createW017Engagement,
  tenderW017Engagement,
  acceptW017Engagement,
  openW017Production,
  recordW017Deliverable,
  createW017ProductionEvidence,
  submitW017Production,
};

// ---------------------------------------------------------------------------
// The disclosure-declaring campaign factory
// ---------------------------------------------------------------------------

/**
 * A campaign + policy version whose DECLARED disclosure policy
 * requires the given disclosure kinds (NET-W018 — the campaign-policy
 * section). ACTIVATED in the harness organization; zero budget → no
 * escrow needed.
 */
export async function createCampaignWithDisclosurePolicy(
  harness: NetW018Harness,
  opts: {
    readonly requiredKinds?: readonly string[];
    readonly ownerPersonId?: string;
  } = {},
): Promise<CampaignRecord> {
  const owner = opts.ownerPersonId ?? harness.operatorPersonId;
  const ctx = personCtx(harness, owner, "w018-campaign");
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      name: "W018 Sponsorship Campaign",
      description: "sponsorship/disclosure fixture campaign",
      idempotencyKey: key("w018-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "creator_content",
          description: "sponsored creator content objective",
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
          title: "Produce sponsored UGC for the campaign",
          opportunityType: "campaign_contribution",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-ugc-production"],
        },
      ],
      // THE NET-W018 SECTION: the declared disclosure policy.
      disclosurePolicy: {
        requiredKinds: [
          ...(opts.requiredKinds ?? ["material_connection"]),
        ] as never,
      },
    },
    idempotencyKey: key("w018-policy"),
  });
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w018-activate"),
    },
  );
  return activated;
}

// ---------------------------------------------------------------------------
// The VERIFIED-engagement factory (the W017 golden path + SUBMITTED
// → VERIFIED through the canonical workflow authority)
// ---------------------------------------------------------------------------

export interface VerifiedEngagement {
  readonly engagementId: string;
  readonly productionId: string;
  readonly campaignId: string;
  readonly submissionId: string;
  readonly evidenceId: string;
  /** The engagement's version AFTER verification (2 transitions). */
  readonly version: number;
}

/** The full golden path: offer → tender → accept → production →
 * deliverable → evidence → submission → VERIFICATION. */
export async function createVerifiedEngagement(
  harness: NetW018Harness,
  opts: {
    readonly campaignId?: string;
    readonly requiredKinds?: readonly string[];
  } = {},
): Promise<VerifiedEngagement> {
  const campaignId =
    opts.campaignId ??
    (
      await createCampaignWithDisclosurePolicy(harness, {
        requiredKinds: opts.requiredKinds,
      })
    ).id;
  const { engagement } = await createW017Engagement(harness.w017, {
    campaignId,
  });
  await tenderW017Engagement(harness.w017, engagement.id, engagement.version);
  const accepted = await acceptW017Engagement(harness.w017, engagement.id, 1);
  const opened = await openW017Production(
    harness.w017,
    accepted.engagement.id,
    2,
  );
  await recordW017Deliverable(harness.w017, opened.production.id);
  const { evidenceId } = await createW017ProductionEvidence(
    harness.w017,
    opened.production.id,
  );
  const submitted = await submitW017Production(
    harness.w017,
    opened.production.id,
    opened.engagementVersion,
    [evidenceId],
  );
  // SUBMITTED → VERIFIED through the canonical workflow authority
  // (the pure transition; the harness seeds the ALLOW policies for
  // the operator person + harness organization above — inherited
  // from the W017 harness's ENGAGEMENT_TRANSITION_TABLE seeding).
  const ctx = operatorCtx(harness, "w018-verify-engagement");
  const apiInput: ApiRequestTransitionInput = {
    subjectId: accepted.engagement.id,
    subjectKind: "engagement",
    targetState: "VERIFIED",
    expectedVersion: submitted.engagementVersion,
    idempotencyKey: key("w018-verify-engagement"),
    policyAction: policyActionFor("engagement", "SUBMITTED", "VERIFIED"),
  };
  const verified = await harness.runtime.apiCommands.requestTransition(
    ctx,
    harness.operatorPersonId,
    apiInput,
  );
  return {
    engagementId: accepted.engagement.id,
    productionId: opened.production.id,
    campaignId,
    submissionId: submitted.submissionId,
    evidenceId,
    version: verified.version,
  };
}

// ---------------------------------------------------------------------------
// The commercial-relationship factory
// ---------------------------------------------------------------------------

export interface CommercialRelationshipOverrides {
  readonly engagementId?: string;
  readonly campaignId?: string;
  readonly sponsorPersonId?: string;
  readonly kind?: string;
  readonly disclosureObligations?: readonly string[];
  readonly compensation?: Record<string, unknown> | null;
  readonly requiredKinds?: readonly string[];
}

/** Record the commercial relationship for a (fresh or given) verified engagement. */
export async function createCommercialRelationship(
  harness: NetW018Harness,
  opts: CommercialRelationshipOverrides & { readonly idempotencyKey?: string } = {},
): Promise<CommercialRelationship> {
  const verified =
    opts.engagementId !== undefined && opts.campaignId !== undefined
      ? null
      : await createVerifiedEngagement(harness, {
          requiredKinds: opts.requiredKinds,
        });
  const engagementId = opts.engagementId ?? verified!.engagementId;
  const campaignId = opts.campaignId ?? verified!.campaignId;
  const ctx = operatorCtx(harness, "w018-relationship");
  const result =
    await harness.runtime.creatorSponsorshipService.createCommercialRelationship(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        engagementId,
        campaignId,
        sponsorPersonId: opts.sponsorPersonId ?? harness.operatorPersonId,
        kind: opts.kind ?? "sponsorship",
        disclosureObligations: opts.disclosureObligations ?? [
          "genuine_experience",
        ],
        compensation:
          opts.compensation === undefined
            ? {
                format: "short_video",
                unit: "per_deliverable",
                amount: 750,
                currency: "USD",
                rewardPolicyReference: null,
              }
            : (opts.compensation as never),
        idempotencyKey: opts.idempotencyKey ?? key("w018-relationship"),
      },
    );
  return result.relationship;
}

// ---------------------------------------------------------------------------
// The publication factory
// ---------------------------------------------------------------------------

export interface PublicationOverrides {
  readonly engagementId?: string;
  readonly productionId?: string | null;
  readonly channel?: Record<string, unknown>;
  readonly requiredKinds?: readonly string[];
  readonly actorPersonId?: string;
  readonly idempotencyKey?: string;
}

/** Create a DRAFT publication (a fresh verified engagement unless given). */
export async function createPublication(
  harness: NetW018Harness,
  opts: PublicationOverrides = {},
): Promise<PublicationRecord> {
  const verified =
    opts.engagementId !== undefined
      ? null
      : await createVerifiedEngagement(harness, {
          requiredKinds: opts.requiredKinds,
        });
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.creatorPersonId,
    "w018-publication",
  );
  const result = await harness.runtime.creatorSponsorshipService.createPublication(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      engagementId: opts.engagementId ?? verified!.engagementId,
      productionId:
        opts.productionId !== undefined
          ? opts.productionId
          : (verified?.productionId ?? null),
      channel:
        (opts.channel as never) ?? {
          kind: "creator_owned_channel",
          externalPlatform: {
            provider: "example-platform",
            externalId: "pub-ext-1",
            url: "https://example.com/pub-ext-1",
          },
        },
      idempotencyKey: opts.idempotencyKey ?? key("w018-publication"),
    },
  );
  return result.publication;
}

// ---------------------------------------------------------------------------
// The publication-evidence factory (canonical, subject-bound)
// ---------------------------------------------------------------------------

/** Create a canonical evidence record bound to a PUBLICATION subject. */
export async function createPublicationEvidence(
  harness: NetW018Harness,
  publicationId: string,
  opts: {
    readonly subjectType?: string;
    readonly subjectId?: string;
    readonly organizationScopeId?: string;
    readonly ownerId?: string;
  } = {},
): Promise<{ evidenceId: string }> {
  const ctx = creatorCtx(harness, "w018-pub-evidence");
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId:
      opts.organizationScopeId ?? harness.organizationScopeId,
    ownerId: opts.ownerId ?? harness.creatorPersonId,
    subjectReference: {
      subjectType: opts.subjectType ?? "publication",
      subjectId: opts.subjectId ?? publicationId,
    },
    provenance: {
      sourceType: "platform",
      sourceId: "example-platform",
      method: "w018 fixture publication capture",
      collectedAt: new Date().toISOString(),
      collectorId: harness.creatorPersonId,
    },
    confidence: {
      point: 0.9,
      lower: 0.8,
      upper: 0.95,
    },
    sensitivity: "standard",
    payload: { kind: "publication_capture", publicationId },
  });
  return { evidenceId: evidence.id };
}

// ---------------------------------------------------------------------------
// The disclosure-declaration factory
// ---------------------------------------------------------------------------

export interface DeclarationOverrides {
  readonly kind?: string;
  readonly statement?: string;
  readonly evidenceReferences?: readonly string[];
  readonly actorPersonId?: string;
  readonly idempotencyKey?: string;
}

/** Append a disclosure declaration to a DRAFT publication. */
export async function recordDeclaration(
  harness: NetW018Harness,
  publicationId: string,
  opts: DeclarationOverrides = {},
): Promise<DisclosureDeclaration> {
  const kind = opts.kind ?? "material_connection";
  const evidenceReferences =
    opts.evidenceReferences !== undefined
      ? [...opts.evidenceReferences]
      : [(await createPublicationEvidence(harness, publicationId)).evidenceId];
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.creatorPersonId,
    "w018-declaration",
  );
  const result =
    await harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId,
        kind,
        statement:
          opts.statement ?? `#${kind.replace("_", "-")} fixture statement`,
        evidenceReferences: [...evidenceReferences],
        idempotencyKey: opts.idempotencyKey ?? key("w018-declaration"),
      },
    );
  return result.declaration;
}

/** Declare one disclosure kind with fresh subject-bound evidence. */
export async function declareKind(
  harness: NetW018Harness,
  publicationId: string,
  kind: string,
): Promise<DisclosureDeclaration> {
  const { evidenceId } = await createPublicationEvidence(
    harness,
    publicationId,
  );
  return recordDeclaration(harness, publicationId, {
    kind,
    evidenceReferences: [evidenceId],
  });
}

// ---------------------------------------------------------------------------
// The golden-path sponsorship flow
// ---------------------------------------------------------------------------

export interface GoldenPathSponsorship {
  readonly engagementId: string;
  readonly campaignId: string;
  readonly relationship: CommercialRelationship;
  readonly publication: PublicationRecord;
  readonly declarations: readonly DisclosureDeclaration[];
  readonly verifiedPublication: PublicationRecord;
  readonly publicationEvidenceId: string;
}

/**
 * The full golden path: verified engagement → commercial
 * relationship → publication → declarations for every required kind
 * → VERIFICATION (the disclosure gate passes). `requiredKinds` drives
 * BOTH the campaign policy and the relationship obligations when
 * `splitSources` is true (policy gets the first half, the
 * relationship the second — proving the UNION derivation).
 */
export async function goldenPathSponsorship(
  harness: NetW018Harness,
  opts: {
    readonly requiredKinds?: readonly string[];
    readonly splitSources?: boolean;
  } = {},
): Promise<GoldenPathSponsorship> {
  const requiredKinds = opts.requiredKinds ?? [
    "material_connection",
    "genuine_experience",
  ];
  const policyKinds = opts.splitSources
    ? requiredKinds.slice(0, Math.ceil(requiredKinds.length / 2))
    : requiredKinds;
  const relationshipKinds = opts.splitSources
    ? requiredKinds.slice(Math.ceil(requiredKinds.length / 2))
    : ["genuine_experience"];

  const campaign = await createCampaignWithDisclosurePolicy(harness, {
    requiredKinds: policyKinds,
  });
  const verified = await createVerifiedEngagement(harness, {
    campaignId: campaign.id,
  });
  const relationship = await createCommercialRelationship(harness, {
    engagementId: verified.engagementId,
    campaignId: campaign.id,
    disclosureObligations: relationshipKinds,
  });
  const publication = await createPublication(harness, {
    engagementId: verified.engagementId,
    productionId: verified.productionId,
  });
  const declarations: DisclosureDeclaration[] = [];
  for (const kind of new Set([...policyKinds, ...relationshipKinds])) {
    declarations.push(await declareKind(harness, publication.id, kind));
  }
  const { evidenceId } = await createPublicationEvidence(
    harness,
    publication.id,
  );
  const ctx = operatorCtx(harness, "w018-verify");
  const result = await harness.runtime.creatorSponsorshipService.verifyPublication(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      publicationId: publication.id,
      expectedVersion: publication.version,
      evidenceReferences: [evidenceId],
      idempotencyKey: key("w018-verify"),
    },
  );
  return {
    engagementId: verified.engagementId,
    campaignId: campaign.id,
    relationship,
    publication,
    declarations,
    verifiedPublication: result.publication,
    publicationEvidenceId: evidenceId,
  };
}
