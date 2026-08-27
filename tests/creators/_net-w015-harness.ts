/**
 * NET-W015 shared test harness.
 *
 * Wraps the NET-W013 harness (runtime + the full helpful-contribution
 * chain incl. the qualified PoH fixture — a canonical reputation
 * input source) and adds:
 *  - the creator guard actions (6 mutations);
 *  - the canonical reputation snapshot factory (a scoring policy +
 *    an evidence-backed input sourced from a QUALIFIED contribution +
 *    a recorded snapshot — the reference target for CRE-005);
 *  - the default profile sections factory (all eight sections,
 *    provider-neutral, privacy-minimized);
 *  - the creator profile + version + activation helpers (exactly as
 *    the runtime apiCommands execute them).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW013Harness,
  createQualifiedContribution,
  key as w013Key,
  type NetW013Harness,
} from "../contributions/_net-w013-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { ReputationSnapshot } from "../../src/reputation/port.ts";
import type {
  CreatorProfileRecord,
  CreatorProfileSections,
  CreatorProfileVersion,
} from "../../src/creators/port.ts";

export interface NetW015Harness {
  /** The wrapped NET-W013 harness (all its factories work unchanged). */
  readonly w013: NetW013Harness;
  readonly runtime: NetW013Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The creator person (the profile anchor/owner). */
  readonly creatorPersonId: string;
  /** A different person in the same org (non-owner proofs). */
  readonly otherPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "creators.profile.create",
  "creators.version.define",
  "creators.status.activate",
  "creators.status.pause",
  "creators.status.resume",
  "creators.status.archive",
];

/** The default scoring rules (all eight frozen dimensions). */
const SCORING_RULES = [
  "helpfulness",
  "content_quality",
  "creator_performance",
  "inventory_quality",
  "measurement_reliability",
  "commerce_reliability",
  "fraud_resistance",
  "fulfillment_reliability",
].map((dimension) => ({
  dimension,
  inputWeight: 1,
  decayHalfLifeDays: 90,
  maxScore: 100,
  indicatedWeightFactor: 0.25,
  indicatedOnlyCap: 10,
}));

export async function createNetW015Harness(): Promise<NetW015Harness> {
  const w013 = await createNetW013Harness();
  const runtime = w013.runtime;
  const bootstrapCtx = w013.bootstrapCtx;

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
    w013,
    runtime,
    bootstrapCtx,
    creatorPersonId: w013.contributorPersonId,
    otherPersonId: w013.moderatorPersonId,
    organizationScopeId: w013.organizationScopeId,
    secondOrgId: w013.secondOrgId,
    secondOrgPersonId: w013.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person's execution context. */
export function personCtx(
  harness: NetW015Harness,
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
  harness: NetW015Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.creatorPersonId, correlationId);
}

/** A different person's execution context (same org). */
export function otherCtx(
  harness: NetW015Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.otherPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { w013Key };

// ---------------------------------------------------------------------------
// Fresh-person factory (each test anchors its own canonical person so
// the unique-anchor rule never collides across tests)
// ---------------------------------------------------------------------------

/** Create a fresh canonical person identity in the harness org. */
export async function createFreshPerson(
  harness: NetW015Harness,
  label = "person",
): Promise<string> {
  const person = await harness.runtime.identityService.createIdentity(
    harness.bootstrapCtx,
    {
      displayName: `W015 ${label}`,
      subjectReferences: [
        {
          subjectId: `w015-${label}-${key("subject")}@example.com`,
          providerKind: "internal",
        },
      ],
    },
  );
  return person.id;
}

/** A fresh person's execution context. */
export function freshPersonCtx(
  harness: NetW015Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, personId, correlationId);
}

// ---------------------------------------------------------------------------
// The canonical reputation snapshot factory (the reference target)
// ---------------------------------------------------------------------------

/**
 * Record a canonical /reputation snapshot for a subject person. The
 * input is sourced from a QUALIFIED helpful contribution (the W013
 * factory) in the same org, the dimension is creator_performance and
 * the policy is the default deterministic rule set.
 */
export async function createReputationSnapshot(
  harness: NetW015Harness,
  opts: {
    readonly subjectPersonId?: string;
    readonly dimension?: string;
    readonly policyId?: string;
  } = {},
): Promise<ReputationSnapshot> {
  const subjectPersonId = opts.subjectPersonId ?? harness.creatorPersonId;
  const dimension = opts.dimension ?? "creator_performance";
  const policyId = opts.policyId ?? `policy-w015-${key("rep")}`;
  const ctx = personCtx(harness, subjectPersonId, "w015-reputation-policy");

  // A scoring policy for the subject's org (lineage fresh per call).
  await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId,
    version: 1,
    rules: SCORING_RULES,
  });

  // An evidence-backed input: a QUALIFIED contribution as the source.
  // (Only needed when the subject IS the harness contributor — a
  // different subject gets an empty-input snapshot, which is still a
  // canonical, digest-carrying record.)
  if (subjectPersonId === harness.creatorPersonId) {
    const { contribution } = await createQualifiedContribution(harness.w013);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId,
      dimension,
      sources: [{ kind: "contribution", id: contribution.id }],
      description: "qualified helpful contribution (NET-W015 fixture)",
      occurredAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: key("w015-rep-input"),
    });
  }

  // The snapshot (the canonical, digest-carrying reference target).
  const result = await harness.runtime.reputationSnapshotService.recordSnapshot(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId,
      policyId,
      referenceAt: "2026-01-02T00:00:00.000Z",
      idempotencyKey: key("w015-rep-snapshot"),
    },
  );
  return result.snapshot;
}

// ---------------------------------------------------------------------------
// The default profile sections factory (all eight sections)
// ---------------------------------------------------------------------------

/**
 * Build the default provider-neutral, privacy-minimized profile
 * sections. The reputation references point at two canonical
 * snapshots (audience_influence + production — the CRE-005 roles)
 * recorded for the SUBJECT person.
 */
export async function createDefaultSections(
  harness: NetW015Harness,
  opts: {
    readonly subjectPersonId?: string;
    readonly audienceSnapshot?: ReputationSnapshot;
    readonly productionSnapshot?: ReputationSnapshot;
  } = {},
): Promise<CreatorProfileSections> {
  const subjectPersonId = opts.subjectPersonId ?? harness.creatorPersonId;
  const audienceSnapshot =
    opts.audienceSnapshot ??
    (await createReputationSnapshot(harness, {
      subjectPersonId,
      dimension: "content_quality",
    }));
  const productionSnapshot =
    opts.productionSnapshot ??
    (await createReputationSnapshot(harness, {
      subjectPersonId,
      dimension: "creator_performance",
    }));
  return {
    platforms: [
      {
        platformKind: "video",
        handle: "@fixture-creator",
        displayName: "Fixture Creator",
        profileUrl: "https://example.com/fixture-creator",
        capabilities: ["short_video", "long_video"],
        languages: ["en"],
      },
      {
        platformKind: "written",
        handle: "@fixture-writer",
        displayName: null,
        profileUrl: null,
        capabilities: ["article", "newsletter"],
        languages: ["en", "fr"],
      },
    ],
    audience: {
      sizeBand: "10k_100k",
      engagementBand: "high",
      ageDistribution: [
        { band: "18_24", share: 30 },
        { band: "25_34", share: 45 },
        { band: "35_44", share: 15 },
      ],
      topGeographies: [
        { territory: "GH", share: 40 },
        { territory: "NG", share: 25 },
      ],
    },
    commercial: {
      rates: [
        { format: "short_video", unit: "per_deliverable", amount: 750.5, currency: "USD" },
        { format: "article", unit: "per_deliverable", amount: 300, currency: "USD" },
        { format: "live_stream", unit: "per_hour", amount: 120, currency: "EUR" },
      ],
      negotiable: true,
      preferredCurrencies: ["USD", "EUR"],
    },
    rights: [
      { kind: "channel_publication", terms: "organic channel publication only" },
      { kind: "paid_amplification", terms: null },
    ],
    restrictions: {
      restrictedTopics: ["gambling", "adult"],
      restrictedFormats: ["post"],
      restrictedTerritories: ["ZZ"],
      requiresDisclosure: true,
    },
    availability: {
      acceptingWork: true,
      weeklyCapacity: 3,
      minimumNoticeDays: 7,
    },
    participation: {
      acceptsDirectCampaigns: true,
      requiresInvitation: false,
    },
    reputationReferences: [
      {
        role: "audience_influence",
        dimension: "content_quality",
        snapshotId: audienceSnapshot.id,
        digest: audienceSnapshot.digest,
      },
      {
        role: "production",
        dimension: "creator_performance",
        snapshotId: productionSnapshot.id,
        digest: productionSnapshot.digest,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The creator profile helpers (exactly as the runtime apiCommands run)
// ---------------------------------------------------------------------------

export async function createCreatorProfile(
  harness: NetW015Harness,
  opts: {
    readonly organizationScopeId?: string;
    readonly creatorPersonId?: string;
    readonly displayName?: string;
    readonly idempotencyKey?: string;
    readonly ctx?: ExecutionContext;
  } = {},
): Promise<{ profile: CreatorProfileRecord; created: boolean }> {
  const ctx = opts.ctx ?? creatorCtx(harness, "w015-create-profile");
  return harness.runtime.creatorService.createProfile(ctx, {
    organizationScopeId: opts.organizationScopeId ?? harness.organizationScopeId,
    creatorPersonId: opts.creatorPersonId ?? harness.creatorPersonId,
    displayName: opts.displayName ?? "Fixture Creator",
    idempotencyKey: opts.idempotencyKey ?? key("w015-profile"),
  });
}

export async function defineCreatorProfileVersion(
  harness: NetW015Harness,
  profileId: string,
  opts: {
    readonly sections?: CreatorProfileSections;
    readonly subjectPersonId?: string;
    readonly idempotencyKey?: string;
    readonly ctx?: ExecutionContext;
  } = {},
): Promise<{ version: CreatorProfileVersion; created: boolean }> {
  const ctx =
    opts.ctx ??
    creatorCtx(harness, "w015-define-version");
  const subjectPersonId = opts.subjectPersonId ?? harness.creatorPersonId;
  return harness.runtime.creatorService.defineProfileVersion(ctx, {
    profileId,
    sections:
      opts.sections ??
      (await createDefaultSections(harness, { subjectPersonId })),
    idempotencyKey: opts.idempotencyKey ?? key("w015-version"),
  });
}

/** A complete ACTIVE creator profile with one version (the fixture). */
export async function createActiveCreatorProfile(
  harness: NetW015Harness,
  opts: {
    readonly creatorPersonId?: string;
    readonly ctx?: ExecutionContext;
  } = {},
): Promise<{
  profile: CreatorProfileRecord;
  version: CreatorProfileVersion;
}> {
  const creatorPersonId = opts.creatorPersonId ?? harness.creatorPersonId;
  const ctx =
    opts.ctx ?? personCtx(harness, creatorPersonId, "w015-activate");
  const { profile } = await createCreatorProfile(harness, {
    creatorPersonId,
    ctx,
  });
  const { version } = await defineCreatorProfileVersion(harness, profile.id, {
    subjectPersonId: creatorPersonId,
    ctx,
  });
  const activated = await harness.runtime.creatorService.activateProfile(
    ctx,
    { profileId: profile.id, idempotencyKey: key("w015-activate") },
  );
  return { profile: activated, version };
}
