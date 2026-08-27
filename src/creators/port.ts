/**
 * Creators boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/creators` owns creator domain rules — creator identity anchors,
 * platform references, audience metadata, commercial preferences,
 * rights, restrictions, availability), §13 (Provider neutrality),
 * §19 (AI/model output is never sufficient by itself to authorize
 * reputation state — and never establishes creator eligibility);
 * spec/architecture-lock.md §2 (the sixteen frozen core domains —
 * `/creators` is a frozen Phase-4 boundary), §3 (PostgreSQL
 * authoritative), §12 (execution lineage), §14 (provider
 * neutrality).
 *
 * Work order ref: spec/work-orders/NET-W015.md
 *   §3.1 First-class durable creator profile records (organization
 *        scope + canonical person anchor, unique per person per org).
 *   §3.2 Versioned profile sections (platforms, audience, commercial
 *        preferences, rights, restrictions, availability,
 *        participation rules, reputation references) — CRE-001.
 *   §3.3 The privacy/secret boundary (aggregate-only audience;
 *        credential-shaped + raw-audience-shaped key guards).
 *   §3.4 Reputation references (CRE-005 — audience influence and
 *        production reputation as SEPARATE canonical references).
 *
 * Requirements: CRE-001 (creators define platform, audience, topic,
 * language, format, rates, rights and restrictions), CRE-005
 * (separate audience influence from production reputation), API-002
 * (server-side authorization), AUD-004 (execution lineage).
 *
 * CROSS-BOUNDARY NOTE: this boundary is `domain` tier. The tier
 * allow matrix prohibits domain→infrastructure, domain→adapter and
 * domain→other-domain imports. This port therefore consumes ONLY
 * core contracts. Cross-domain reads (the anchor person, the
 * canonical reputation snapshots) happen through the NEUTRAL
 * structural lookup interfaces declared here — the bootstrap
 * composition root wires thin adapters over the wired repositories
 * of the owning domains (the same dependency-inversion pattern as
 * NET-W005's SubjectLookup, NET-W007's ReputationSubjectLookup and
 * NET-W011's CampaignPersonLookup).
 *
 * THE KEY RULES (work order §2 — authority separation):
 *  - `/identity` remains the person identity authority: a creator
 *    profile ANCHORS to an existing canonical person id (validated
 *    through {@link CreatorPersonLookup}); this boundary never
 *    creates, resolves or mutates identities and carries NO identity
 *    material beyond the person-id reference;
 *  - `/reputation` remains the trust-signal authority: profile
 *    versions carry snapshot REFERENCES ONLY ({role, dimension,
 *    snapshotId, digest} — verified through
 *    {@link CreatorReputationSnapshotLookup}); this boundary never
 *    computes, stores, mints or mutates a score and never duplicates
 *    the scoring engine;
 *  - `/settlement` remains the economic authority: commercial rates
 *    are DECLARED preferences (validated with the shared economic
 *    bounds) — this boundary carries NO economic-unit mutation
 *    methods, NO balances, NO postings;
 *  - `/workflows` remains the lifecycle authority: the profile
 *    status machine is the RECORD's own administrative status (the
 *    campaign-record precedent), never a workflow lifecycle;
 *  - provider-specific platform semantics stay OUTSIDE the creator
 *    domain (AC-06): platform connections are provider-neutral
 *    references; external platform adapters are composition-root
 *    integration points for later work items.
 *
 * Out of scope (work order §5 of NET-W015; NET-W016 now ships the
 * matching service in this SAME port below): UGC production
 * workflow / rights EXECUTION (NET-W017), sponsorship/disclosure
 * EXECUTION (NET-W018), ad inventory or optimization (NET-W019+),
 * external platform EXECUTION, direct reputation scoring, payment
 * execution, blockchain consensus, and any AI/model-driven
 * ELIGIBILITY decision (the NET-W016 advisory is ranking-only,
 * bounded and never flips a hard gate).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { ReputationDimension } from "../core/reputation.ts";
import type { Logger } from "../core/logger.ts";
import type {
  LifecycleState,
  LifecycleSubject,
  TransitionRequest,
  TransitionResult,
} from "../core/workflow.ts";
import type {
  CreatorContentFormat,
  CreatorEngagementBand,
  CreatorPlatformKind,
  CreatorProfileStatus,
  CreatorReputationRole,
  CreatorRightsKind,
  CreatorAudienceSizeBand,
  CreatorAudienceAgeBand,
  CreatorRateUnit,
  CreatorMatchSignal,
  CreatorMatchGateReason,
  CreatorMatchWeightsShape,
  UsageRightsChannel,
  UsageRightsEffectiveStatus,
  UsageRightsOwnership,
  AutoAcceptGateReason,
} from "../core/creators.ts";

// ---------------------------------------------------------------------------
// The append-only profile event history
// ---------------------------------------------------------------------------

/**
 * The creator profile event vocabulary (append-only; the record's
 * derived `status` moves only through these audited events).
 */
export const CREATOR_PROFILE_EVENTS = [
  "created",
  "activated",
  "paused",
  "resumed",
  "archived",
  "profile_version_defined",
] as const;

export type CreatorProfileEventKind = (typeof CREATOR_PROFILE_EVENTS)[number];

export function isCreatorProfileEventKind(
  value: string,
): value is CreatorProfileEventKind {
  return (CREATOR_PROFILE_EVENTS as readonly string[]).includes(value);
}

/**
 * One append-only event in a creator profile's history. Actor
 * identity is the EXECUTION ACTOR (server-side; never
 * caller-asserted). Events are immutable; the derived `status` only
 * ever moves through them.
 */
export interface CreatorProfileEvent {
  readonly id: string;
  readonly event: CreatorProfileEventKind;
  readonly actorPersonId: string;
  readonly note: string | null;
  /** Structured, provider-neutral details (version refs, ids). */
  readonly details: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
  readonly executionId: string;
  readonly correlationId: string;
}

// ---------------------------------------------------------------------------
// The profile anchor record (work order §3.1; AC-01)
// ---------------------------------------------------------------------------

/**
 * A CreatorProfileRecord — a first-class, durable,
 * organization-scoped creator profile ANCHORED to a canonical person
 * identity, with an immutable, append-only event history.
 *
 * Invariants:
 *  - `organizationScopeId` is the tenant/participant scope; every
 *    lookup and mutation validates it (tenant isolation, API-002).
 *  - `creatorPersonId` REFERENCES the canonical person identity
 *    (validated at creation through {@link CreatorPersonLookup});
 *    this boundary never creates a second identity, and a person
 *    holds AT MOST ONE creator profile per organization scope (the
 *    unique-anchor rule, enforced in-transaction at creation).
 *  - `status` is the administrative status machine owned by this
 *    boundary (core/creators.ts) — NOT a workflow lifecycle state.
 *  - `currentVersion` mirrors the latest profile version at the
 *    last mutation (deterministic reproducibility; the authoritative
 *    lineage lives in the version repository).
 *  - `events` is append-only; past events are never rewritten.
 */
export interface CreatorProfileRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The canonical person this creator profile is anchored to. */
  readonly creatorPersonId: string;
  readonly displayName: string;
  readonly status: CreatorProfileStatus;
  readonly currentVersion: number | null;
  readonly events: readonly CreatorProfileEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// The versioned profile sections (work order §3.2; AC-02)
// ---------------------------------------------------------------------------

/**
 * A connected-platform REFERENCE (AC-02/AC-06): a provider-neutral
 * record of the creator's presence on an external platform. Carries
 * the closed platform kind, the platform-specific handle and the
 * public profile URL — and NOTHING else: no credentials, no tokens,
 * no connection state, no provider-client fields (the credential-shaped
 * key guard rejects all of them structurally).
 */
export interface CreatorPlatformConnection {
  /** Closed provider-neutral platform taxonomy (core/creators.ts). */
  readonly platformKind: CreatorPlatformKind;
  /** The creator's public handle on that platform (never a secret). */
  readonly handle: string;
  readonly displayName: string | null;
  /** Public profile URL (https), when the platform exposes one. */
  readonly profileUrl: string | null;
  /** Content formats this connection can carry (closed vocabulary). */
  readonly capabilities: readonly CreatorContentFormat[];
  /** Languages this connection publishes in (validated tags). */
  readonly languages: readonly string[];
}

/**
 * Privacy-minimized audience AGGREGATES (AC-02/AC-03): bands and
 * qualified shares ONLY. There is deliberately NO field that could
 * carry an individual audience record — the raw-audience-shaped key
 * guard rejects any attempt structurally, and every numeric field is
 * a bounded aggregate share.
 */
export interface CreatorAudienceAggregate {
  /** Audience size BAND (never an exact count). */
  readonly sizeBand: CreatorAudienceSizeBand;
  /** Aggregate engagement band. */
  readonly engagementBand: CreatorEngagementBand;
  /** Aggregate age distribution (closed bands; shares 0–100, total ≤ 100). */
  readonly ageDistribution: readonly {
    readonly band: CreatorAudienceAgeBand;
    readonly share: number;
  }[];
  /** Top geographies (ISO 3166-1 alpha-2; ≤ 5 entries; shares 0–100, total ≤ 100). */
  readonly topGeographies: readonly {
    readonly territory: string;
    readonly share: number;
  }[];
}

/**
 * Declared commercial preferences (CRE-001 "rates"): a rate card of
 * format × unit × amount × currency plus negotiability. DECLARED
 * DATA ONLY — a rate creates no economic state, no commitment, no
 * posting and no balance (the campaign-budget declaration
 * precedent); execution is /settlement's authority and never this
 * boundary's.
 */
export interface CreatorCommercialPreferences {
  readonly rates: readonly {
    /** The content format the rate applies to (closed vocabulary). */
    readonly format: CreatorContentFormat;
    /** Closed rate unit (per_deliverable / per_hour / per_campaign). */
    readonly unit: CreatorRateUnit;
    /** Declared amount (validated with the shared economic bounds). */
    readonly amount: number;
    /** ISO 4217-style currency code. */
    readonly currency: string;
  }[];
  readonly negotiable: boolean;
  readonly preferredCurrencies: readonly string[];
}

/**
 * A declared rights GRANT (CRE-001 "rights"): what the creator is
 * willing to grant. DECLARED WILLINGNESS ONLY — rights EXECUTION is
 * NET-W017.
 */
export interface CreatorRightsGrant {
  readonly kind: CreatorRightsKind;
  /** Optional human-readable terms of the granted right. */
  readonly terms: string | null;
}

/**
 * Declared restrictions (CRE-001 "restrictions"): explicit
 * exclusions a counterparty must respect. Topics are free-form
 * strings (the creator's own declarations); formats and territories
 * are validated against closed/standard vocabularies.
 */
export interface CreatorRestrictions {
  readonly restrictedTopics: readonly string[];
  readonly restrictedFormats: readonly CreatorContentFormat[];
  readonly restrictedTerritories: readonly string[];
  /** Whether the creator mandates disclosure labelling (execution: NET-W018). */
  readonly requiresDisclosure: boolean;
}

/**
 * Declared availability (CRE-001): explicit, versioned data —
 * NOT a scheduling engine (NET-W016).
 */
export interface CreatorAvailability {
  readonly acceptingWork: boolean;
  /** Declared concurrent-engagement capacity per week (0–100). */
  readonly weeklyCapacity: number;
  /** Minimum notice in days before an engagement starts (0–365). */
  readonly minimumNoticeDays: number;
}

/**
 * Declared participation rules (explicit versioned data consumed by
 * NET-W016 matching). Auto-match/auto-accept BEHAVIOUR is CRE-003
 * and stays OUT of this work item — these fields only carry the
 * creator's declared preferences.
 */
export interface CreatorParticipationRules {
  readonly acceptsDirectCampaigns: boolean;
  readonly requiresInvitation: boolean;
}

/**
 * A canonical reputation REFERENCE (CRE-005 / AC-04): REFERENCES the
 * `/reputation` authority's snapshot — NEVER a score, NEVER a
 * duplicate. The service verifies through
 * {@link CreatorReputationSnapshotLookup} that the snapshot exists,
 * belongs to this profile's organization scope AND subject person,
 * and carries exactly this digest; the reference then pins WHAT was
 * referenced (ids + digest), so a later mismatch is detectable.
 */
export interface CreatorReputationReference {
  /**
   * The CRE-005 separation: `audience_influence` and `production`
   * are carried as SEPARATE references — one per role, both
   * required, never conflated.
   */
  readonly role: CreatorReputationRole;
  /** A frozen canonical reputation dimension (never redefined here). */
  readonly dimension: ReputationDimension;
  /** The canonical /reputation snapshot id being referenced. */
  readonly snapshotId: string;
  /** The referenced snapshot's digest (pinned at reference time). */
  readonly digest: string;
}

/** The full declared profile (all sections required — AC-02). */
export interface CreatorProfileSections {
  readonly platforms: readonly CreatorPlatformConnection[];
  readonly audience: CreatorAudienceAggregate;
  readonly commercial: CreatorCommercialPreferences;
  readonly rights: readonly CreatorRightsGrant[];
  readonly restrictions: CreatorRestrictions;
  readonly availability: CreatorAvailability;
  readonly participation: CreatorParticipationRules;
  readonly reputationReferences: readonly CreatorReputationReference[];
}

// ---------------------------------------------------------------------------
// The immutable versioned profile (work order §3.2)
// ---------------------------------------------------------------------------

/**
 * A CreatorProfileVersion — an immutable, append-only snapshot of
 * ALL declared profile sections (the campaign-policy precedent).
 *
 * Invariants:
 *  - `profileId` is the owning profile; `version` increases by
 *    exactly 1 (version 1 starts the lineage); a (profileId,
 *    version) pair is unique — existing versions are NEVER
 *    rewritten, so any consumer referencing a version remains
 *    reproducible.
 *  - Every reputation reference was VERIFIED against the canonical
 *    authority before the version committed.
 *  - All versions of a profile share one organizationScopeId.
 */
export interface CreatorProfileVersion {
  readonly id: string;
  readonly profileId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly sections: CreatorProfileSections;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Neutral cross-domain lookups (composition-root wired)
// ---------------------------------------------------------------------------

/**
 * CreatorPersonLookup — structural interface for validating that the
 * profile anchor is an EXISTING canonical person (domain→domain
 * imports are prohibited; the composition root wires an adapter
 * over the identity repository — /identity stays the identity
 * authority).
 */
export interface CreatorPersonLookup {
  exists(personId: string): Promise<boolean>;
}

/**
 * The structural view of a canonical reputation snapshot the
 * creators domain needs to VERIFY a reference (scope, subject,
 * digest). Carries NO scores — the creators domain never even sees
 * the trust values, only the reference metadata. (A canonical
 * snapshot carries ALL eight frozen dimension scores; the reference's
 * `dimension` field selects which one downstream consumers read from
 * the resolved snapshot — the creator record never stores it.)
 */
export interface ResolvedCreatorReputationSnapshot {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly digest: string;
}

/**
 * CreatorReputationSnapshotLookup — structural interface over the
 * NET-W007 reputation domain's snapshot repository (existence +
 * org scope + subject person + dimension + digest for reference
 * verification). /reputation stays the trust-signal authority.
 */
export interface CreatorReputationSnapshotLookup {
  resolve(snapshotId: string): Promise<ResolvedCreatorReputationSnapshot | null>;
}

export interface CreatorLookups {
  readonly person: CreatorPersonLookup;
  readonly reputation: CreatorReputationSnapshotLookup;
}

// ---------------------------------------------------------------------------
// Command / result types
// ---------------------------------------------------------------------------

export interface CreateCreatorProfileInput {
  readonly organizationScopeId: string;
  /**
   * The canonical person to anchor the profile to. MUST exist
   * (validated through the neutral lookup); the acting person must
   * BE this person (a creator profile is self-anchored — no person
   * creates another person's creator profile).
   */
  readonly creatorPersonId: string;
  readonly displayName: string;
  readonly idempotencyKey: string;
}

export interface CreateCreatorProfileResult {
  readonly profile: CreatorProfileRecord;
  /** false when a profile with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface DefineCreatorProfileVersionInput {
  readonly profileId: string;
  readonly sections: CreatorProfileSections;
  readonly idempotencyKey: string;
}

export interface DefineCreatorProfileVersionResult {
  readonly version: CreatorProfileVersion;
  /** false when this idempotency key already defined a version. */
  readonly created: boolean;
}

export interface CreatorProfileStatusInput {
  readonly profileId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Repositories (persistence ports; the authority implementations
// live in this boundary and are wired by the bootstrap root)
// ---------------------------------------------------------------------------

export interface CreatorProfileRepository {
  save(
    profile: CreatorProfileRecord,
    execution: ExecutionContext,
  ): Promise<CreatorProfileRecord>;
  findById(id: string): Promise<CreatorProfileRecord | null>;
  /**
   * The unique-anchor lookup: the profile for a person in an
   * organization scope (null when the person has none there).
   */
  findByPerson(
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<CreatorProfileRecord | null>;
  listByOrganization(
    organizationScopeId: string,
    statuses?: readonly string[],
  ): Promise<readonly CreatorProfileRecord[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileRecord | null>;
  findByPersonWithinTx(
    organizationScopeId: string,
    creatorPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileRecord | null>;
  createWithinTx(
    profile: CreatorProfileRecord,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileRecord>;
  saveWithinTx(
    profile: CreatorProfileRecord,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileRecord>;
}

export interface CreatorProfileVersionRepository {
  findById(id: string): Promise<CreatorProfileVersion | null>;
  findVersion(
    profileId: string,
    version: number,
  ): Promise<CreatorProfileVersion | null>;
  listByProfile(profileId: string): Promise<readonly CreatorProfileVersion[]>;
  findVersionWithinTx(
    profileId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileVersion | null>;
  findLatestWithinTx(
    profileId: string,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileVersion | null>;
  createWithinTx(
    version: CreatorProfileVersion,
    tx: AuthorityTransaction,
  ): Promise<CreatorProfileVersion>;
}

// ---------------------------------------------------------------------------
// The domain service
// ---------------------------------------------------------------------------

export interface CreatorService {
  /**
   * Create a creator profile (self-anchored; DRAFT). Validates the
   * anchor person EXISTS through the neutral lookup and that the
   * person does not already hold a profile in the organization scope
   * (unique anchor — no second identity, no duplicate profiles),
   * then commits atomically with the `creator_profile.created` audit
   * event.
   */
  createProfile(
    execution: ExecutionContext,
    input: CreateCreatorProfileInput,
  ): Promise<CreateCreatorProfileResult>;
  /**
   * Define the next immutable profile version (all sections
   * required). Validates every section (provider neutrality,
   * privacy-minimized aggregates, bounded declared rates, closed
   * vocabularies) and VERIFIES every reputation reference through
   * the neutral lookup (existence + org scope + subject person +
   * digest + frozen dimension), then — under the
   * organization-independent lineage mutex — appends the version
   * (version = latest+1), flips the profile's current-version
   * pointer and commits atomically with the
   * `creator_profile.version_defined` audit event.
   */
  defineProfileVersion(
    execution: ExecutionContext,
    input: DefineCreatorProfileVersionInput,
  ): Promise<DefineCreatorProfileVersionResult>;
  /** Activate (DRAFT/PAUSED → ACTIVE; owner-only, audited). */
  activateProfile(
    execution: ExecutionContext,
    input: CreatorProfileStatusInput,
  ): Promise<CreatorProfileRecord>;
  /** Pause (ACTIVE → PAUSED; owner-only, audited). */
  pauseProfile(
    execution: ExecutionContext,
    input: CreatorProfileStatusInput,
  ): Promise<CreatorProfileRecord>;
  /** Resume (PAUSED → ACTIVE; owner-only, audited). */
  resumeProfile(
    execution: ExecutionContext,
    input: CreatorProfileStatusInput,
  ): Promise<CreatorProfileRecord>;
  /** Archive (any non-terminal → ARCHIVED terminal; owner-only, audited). */
  archiveProfile(
    execution: ExecutionContext,
    input: CreatorProfileStatusInput,
  ): Promise<CreatorProfileRecord>;
  /**
   * Fetch a creator profile by id WITHIN an organization scope
   * (tenant-scoped read — a cross-scope id is indistinguishable from
   * a nonexistent one: NotFoundError, no existence oracle; PR #30
   * review remediation).
   */
  getProfile(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<CreatorProfileRecord>;
  /** The profile for a person in an org scope (the anchor lookup). */
  getProfileByPerson(
    execution: ExecutionContext,
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<CreatorProfileRecord | null>;
  listProfiles(
    execution: ExecutionContext,
    organizationScopeId: string,
    statuses?: readonly string[],
  ): Promise<readonly CreatorProfileRecord[]>;
  /**
   * Fetch one immutable profile version (tenant-scoped read: the
   * profile's organization scope must match, else NotFoundError).
   */
  getProfileVersion(
    execution: ExecutionContext,
    organizationScopeId: string,
    profileId: string,
    version: number,
  ): Promise<CreatorProfileVersion>;
  /**
   * List a profile's immutable version lineage (tenant-scoped read:
   * the profile must resolve in the caller's organization scope,
   * else NotFoundError — a foreign scope cannot enumerate the
   * lineage).
   */
  listProfileVersions(
    execution: ExecutionContext,
    organizationScopeId: string,
    profileId: string,
  ): Promise<readonly CreatorProfileVersion[]>;
}

// ---------------------------------------------------------------------------
// NET-W016 — Creator matching (matching is SELECTION, not authority)
// ---------------------------------------------------------------------------

/**
 * The declared rate ceiling — a provider-neutral hard constraint on
 * the price signal (work order §3.1). DECLARED DATA ONLY: it creates
 * no economic state (the campaign-budget declaration precedent).
 */
export interface CreatorMatchRateCeiling {
  readonly amount: number;
  readonly currency: string;
  readonly unit: CreatorRateUnit;
}

/**
 * The campaign-side creator requirements (work order §3.1/§3.4):
 * explicit, provider-neutral, closed-vocabulary hard constraints.
 * When a campaign is linked, the language/territory rules derived
 * from the pinned campaign policy version are UNIONED into these.
 */
export interface CreatorMatchRequirements {
  /** Every required format must be offered (and not restricted). */
  readonly requiredFormats: readonly CreatorContentFormat[];
  /** Every required language must be published by a connection. */
  readonly requiredLanguages: readonly string[];
  /** Target territories (ISO 3166-1 alpha-2); audience must intersect. */
  readonly targetTerritories: readonly string[];
  /** Campaign topics; an exact (case-insensitive) restricted-topic match gates. */
  readonly campaignTopics: readonly string[];
  /** Every required rights kind must be granted. */
  readonly requiredRightsKinds: readonly CreatorRightsKind[];
  /** The hard price constraint (null = unconstrained). */
  readonly rateCeiling: CreatorMatchRateCeiling | null;
  /** The minimum audience size band (null = unconstrained). */
  readonly minimumAudienceSizeBand: CreatorAudienceSizeBand | null;
  /** Minimum canonical reputation scores per CRE-005 role (null = unconstrained). */
  readonly minimumReputation: {
    readonly audienceInfluence: number | null;
    readonly production: number | null;
  };
  /** The notice window the campaign can provide (days; null = unconstrained). */
  readonly noticeWindowDays: number | null;
}

/** The explicit six-signal weight profile (integers, sum = 100). */
export type CreatorMatchWeights = CreatorMatchWeightsShape;

/** The campaign linkage (resolved read-only through the neutral lookup). */
export interface CreatorMatchCampaignRef {
  readonly campaignId: string;
  /** Omitted → the campaign's latest policy version. */
  readonly policyVersion?: number;
}

/**
 * The provider-neutral view of a campaign policy version derived by
 * the neutral campaign lookup (work order §2: /campaigns stays the
 * campaign policy authority — the matching engine never imports
 * campaign semantics).
 */
export interface ResolvedCampaignCreatorRequirements {
  readonly campaignId: string;
  readonly policyVersion: number;
  readonly organizationScopeId: string;
  /** Languages required by the campaign's language eligibility rules. */
  readonly requiredLanguages: readonly string[];
  /** Territories targeted by the campaign's region eligibility rules. */
  readonly targetTerritories: readonly string[];
  readonly objectiveKinds: readonly string[];
  readonly budgetUnit: "credits";
  readonly budgetTotalAmount: number;
}

/**
 * CreatorMatchCampaignLookup — structural interface over the
 * campaigns domain's policy repository (existence + org scope +
 * pinned version + the derived creator-requirements view). A
 * cross-scope or nonexistent campaign resolves to null (no
 * existence oracle).
 */
export interface CreatorMatchCampaignLookup {
  resolve(
    campaignId: string,
    policyVersion?: number,
  ): Promise<ResolvedCampaignCreatorRequirements | null>;
}

/**
 * The canonical reputation score view the matching boundary needs
 * (reference + the RESOLVED dimension score, read-only through the
 * neutral lookup). The score is the canonical /reputation snapshot
 * value for the reference's dimension — matching never computes,
 * stores or mutates it.
 */
export interface ResolvedCreatorReputationScore {
  readonly snapshotId: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly dimension: ReputationDimension;
  readonly digest: string;
  /** The canonical snapshot's dimension score (0–100). */
  readonly score: number;
}

/**
 * CreatorMatchReputationLookup — structural interface over the
 * NET-W007 reputation snapshot repository (read-only score
 * resolution). /reputation stays the trust-signal authority.
 */
export interface CreatorMatchReputationLookup {
  /**
   * Resolve a snapshot's canonical score for ONE frozen dimension
   * (a canonical snapshot carries all eight; the reference's
   * `dimension` selects which one matching reads). Read-only.
   */
  resolveScore(
    snapshotId: string,
    dimension: ReputationDimension,
  ): Promise<ResolvedCreatorReputationScore | null>;
}

/** The provider-neutral safety view (the risk-control gate read). */
export interface CreatorMatchSafetyView {
  readonly held: boolean;
  readonly controlId: string | null;
  readonly action: string | null;
}

/**
 * CreatorMatchSafetyLookup — structural interface over the disputes
 * domain's active-control registry (`participant_eligibility` gate
 * read). /disputes stays the risk-control authority; matching only
 * READS (an active HOLD/BLOCK is a hard eligibility gate).
 */
export interface CreatorMatchSafetyLookup {
  activeHold(
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<CreatorMatchSafetyView>;
}

/** One neutral fact in an advisory request (label + value strings). */
export interface CreatorMatchAdvisoryFact {
  readonly label: string;
  readonly value: string;
}

/**
 * The privacy-minimized advisory request (work order §3.3): record-
 * level neutral facts ONLY — campaign requirement labels + creator
 * PUBLIC aggregate facts. NO rates, NO restricted topics, NO
 * reputation scores, NO identity material (the W013
 * mention-exclusion precedent, regression-pinned).
 */
export interface CreatorMatchAdvisoryInput {
  readonly rubricRef: string;
  readonly neutralFacts: readonly CreatorMatchAdvisoryFact[];
}

/** An advisory assessment (0–100) with provider identity preserved. */
export interface CreatorMatchAdvisoryAssessment {
  readonly score: number;
  readonly provider: string;
  readonly modelRef: string;
}

/**
 * CreatorMatchAdvisory — the provider-neutral advisory port
 * (AI-002, wired at the composition root over `LlmPort.score` with
 * purpose "matching"). AI output is ADVISORY EVIDENCE ONLY: it can
 * never flip eligibility and only blends (bounded) into the
 * relevance ranking signal.
 */
export interface CreatorMatchAdvisory {
  assess(
    input: CreatorMatchAdvisoryInput,
  ): Promise<CreatorMatchAdvisoryAssessment>;
}

export interface CreatorMatchLookups {
  readonly campaign: CreatorMatchCampaignLookup;
  readonly reputation: CreatorMatchReputationLookup;
  readonly safety: CreatorMatchSafetyLookup;
}

// ---------------------------------------------------------------------------
// Eligibility / ranking / explanation (the deterministic contract)
// ---------------------------------------------------------------------------

/**
 * One hard-gate evaluation. `gate` is the closed gate/reason
 * identifier; `passed` records the outcome; `detail` carries the
 * deterministic context (e.g. the offending value). The trace is
 * complete over every APPLICABLE gate.
 */
export interface CreatorMatchGateEvaluation {
  readonly gate: CreatorMatchGateReason;
  readonly passed: boolean;
  readonly detail: string | null;
}

export interface CreatorMatchEligibility {
  readonly eligible: boolean;
  readonly gates: readonly CreatorMatchGateEvaluation[];
  readonly failedReasons: readonly CreatorMatchGateReason[];
}

/** One explicit-signal score with its weight and input trace. */
export interface CreatorMatchSignalScore {
  readonly signal: CreatorMatchSignal;
  /** 0–100 (1-decimal rounding for deterministic digests). */
  readonly score: number;
  /** The explicit weight (0–100). */
  readonly weight: number;
  /** score × weight / 100 (1-decimal rounding). */
  readonly contribution: number;
  /** The deterministic inputs used (machine-readable explanation). */
  readonly inputs: Readonly<Record<string, unknown>>;
}

/** One ranked candidate (eligible only — hard gates never overridden). */
export interface CreatorMatchCandidateResult {
  readonly profileId: string;
  readonly creatorPersonId: string;
  readonly displayName: string;
  readonly profileVersion: number;
  readonly rank: number;
  readonly totalScore: number;
  readonly signals: readonly CreatorMatchSignalScore[];
  /** The advisory assessment used (null when the advisory was disabled). */
  readonly advisory: {
    readonly score: number;
    readonly provider: string;
    readonly modelRef: string;
  } | null;
}

/** One excluded candidate with the complete failure explanation. */
export interface CreatorMatchExcludedCandidate {
  readonly profileId: string;
  readonly creatorPersonId: string;
  readonly displayName: string;
  readonly profileVersion: number | null;
  readonly failedReasons: readonly CreatorMatchGateReason[];
}

/** The advisory metadata pinned on the run (provider independence). */
export interface CreatorMatchAdvisoryMeta {
  readonly used: boolean;
  /** The blend applied into relevance (0 ≤ blend ≤ 0.25). */
  readonly blend: number;
  readonly provider: string | null;
  readonly modelRef: string | null;
}

/**
 * A CreatorMatchRunRecord — an immutable, append-only decision
 * record for ONE match execution (work order §3.4). It pins the
 * exact requirements, weights, advisory metadata, ranked results,
 * excluded candidates and a deterministic digest — so the selection
 * is reproducible and auditable. It carries NO status machine (a
 * completed decision, not a lifecycle subject) and NO economic,
 * reputation, risk or workflow mutation (matching is selection, not
 * authority).
 */
export interface CreatorMatchRunRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly formatVersion: string;
  readonly campaign: {
    readonly campaignId: string;
    readonly policyVersion: number;
  } | null;
  /** The EFFECTIVE requirements (explicit ∪ campaign-derived). */
  readonly requirements: CreatorMatchRequirements;
  readonly weights: CreatorMatchWeights;
  readonly advisory: CreatorMatchAdvisoryMeta;
  readonly candidateCount: number;
  readonly eligibleCount: number;
  readonly results: readonly CreatorMatchCandidateResult[];
  readonly excluded: readonly CreatorMatchExcludedCandidate[];
  /** SHA-256 over the canonical serialization (deterministic). */
  readonly digest: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// The match-run repository (persistence port; PostgreSQL authority)
// ---------------------------------------------------------------------------

export interface CreatorMatchRunRepository {
  save(
    run: CreatorMatchRunRecord,
    execution: ExecutionContext,
  ): Promise<CreatorMatchRunRecord>;
  findById(id: string): Promise<CreatorMatchRunRecord | null>;
  listByOrganization(
    organizationScopeId: string,
    campaignId?: string,
  ): Promise<readonly CreatorMatchRunRecord[]>;
  createWithinTx(
    run: CreatorMatchRunRecord,
    tx: AuthorityTransaction,
  ): Promise<CreatorMatchRunRecord>;
}

// ---------------------------------------------------------------------------
// The matching domain service
// ---------------------------------------------------------------------------

export interface RunCreatorMatchInput {
  readonly organizationScopeId: string;
  /** Optional campaign linkage (resolved read-only, tenant-scoped). */
  readonly campaign?: CreatorMatchCampaignRef | null;
  readonly requirements: CreatorMatchRequirements;
  /** Explicit candidate narrowing (tenant-scoped profile ids). */
  readonly candidateProfileIds?: readonly string[] | null;
  /** null/omitted → the canonical default weight profile. */
  readonly weights?: CreatorMatchWeights | null;
  /** null/omitted → advisory disabled (pure deterministic ranking). */
  readonly advisory?: {
    readonly enabled: boolean;
    readonly maxWeight?: number;
  } | null;
  readonly idempotencyKey: string;
}

export interface RunCreatorMatchResult {
  readonly run: CreatorMatchRunRecord;
  /** false when a run with the same idempotency key already existed. */
  readonly created: boolean;
}

/**
 * The matching service (work order §3.4). `runMatch` is the ONLY
 * material command: it evaluates deterministic eligibility, ranks
 * the eligible candidate set by explicit signals (optionally blended
 * with the bounded advisory), and persists ONE append-only,
 * idempotent, tenant-scoped run record with the
 * `creator_match.recorded` audit event. It mutates NOTHING else —
 * no workflow, settlement, reputation or risk state (AC-04).
 */
export interface CreatorMatchingService {
  runMatch(
    execution: ExecutionContext,
    input: RunCreatorMatchInput,
  ): Promise<RunCreatorMatchResult>;
  /**
   * Fetch one match run WITHIN an organization scope (tenant-scoped
   * read: a cross-scope id is indistinguishable from a nonexistent
   * one — NotFoundError, no existence oracle).
   */
  getMatchRun(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<CreatorMatchRunRecord>;
  /** List an org's runs (optionally narrowed by campaign). */
  listMatchRuns(
    execution: ExecutionContext,
    organizationScopeId: string,
    campaignId?: string,
  ): Promise<readonly CreatorMatchRunRecord[]>;
}

// ---------------------------------------------------------------------------
// NET-W017 — UGC workflow and rights (engagement / acceptance /
// usage rights / UGC production). The engagement is a NEW canonical
// lifecycle subject kind owned by /workflows (the SOLE lifecycle
// authority — this boundary only validates preconditions and
// REQUESTS transitions through the provider-neutral delegation
// callback below). Every record here is append-only, tenant-scoped,
// idempotent and transactionally audited. NO local status machine
// exists in this boundary: the usage-rights effective status is
// DERIVED (a pure function over immutable records).
// ---------------------------------------------------------------------------

/**
 * The requested usage-rights terms an engagement OFFER carries
 * (work order §3.1): the explicit envelope within which any granted
 * rights must fall. Everything the organizer may ever receive from
 * this engagement is enumerated here — nothing is implicit.
 */
export interface EngagementRequestedRights {
  /** Permitted-use kinds the offer requests (frozen vocabulary). */
  readonly uses: readonly {
    readonly kind: CreatorRightsKind;
    readonly terms: string | null;
  }[];
  /** Channels the offer requests (closed vocabulary). */
  readonly channels: readonly UsageRightsChannel[];
  /** Territories the offer requests (ISO-3166-1 alpha-2 codes). */
  readonly territories: readonly string[];
  /** Media/content scope the offer requests (frozen formats). */
  readonly formats: readonly CreatorContentFormat[];
  /** The requested license window (ISO instants). */
  readonly startsAt: string;
  readonly endsAt: string;
  /** Explicit exclusions a counterparty must respect. */
  readonly exclusions: readonly string[];
}

/**
 * Declared offer compensation — REFERENCE DATA ONLY (work order §2:
 * /settlement stays the economic authority; NET-W017 creates NO
 * economic units, commitments or ledger entries). Optionally pins
 * the reward-policy reference the campaign declared.
 */
export interface EngagementCompensationTerms {
  readonly format: CreatorContentFormat;
  readonly unit: CreatorRateUnit;
  readonly amount: number;
  readonly currency: string;
  /** Optional stable reward-policy reference (data only). */
  readonly rewardPolicyReference: string | null;
}

/**
 * A creator Engagement — the workflow-mediated creator↔campaign work
 * object (work order §3.1). Satisfies the LifecycleSubject contract
 * so the canonical WorkflowService can transition its state; the
 * record is STATIC after creation except the lifecycle fields
 * /workflows owns (the Opportunity/Contribution precedent).
 *
 * Invariants:
 *  - `kind` is always "engagement"; `state` moves ONLY through
 *    /workflows (DRAFT → READY → ASSIGNED → IN_PROGRESS → SUBMITTED
 *    → VERIFIED / REJECTED / CANCELLED).
 *  - `creatorPersonId` + `creatorProfileId` (+ pinned
 *    `creatorProfileVersion`) preserve the creator lineage.
 *  - `campaignId` (+ optional pinned `campaignPolicyVersion`)
 *    references the campaign whose policy governs the offer.
 *  - `matchRunId` (optional) references the NET-W016 run whose
 *    ELIGIBLE candidate produced this engagement (verified at
 *    creation; the run is never mutated here).
 *  - `opportunityId` (optional) preserves opportunity lineage.
 *  - `requestedRights` is the explicit envelope (validated against
 *    the frozen vocabularies).
 */
export interface Engagement extends LifecycleSubject {
  readonly creatorPersonId: string;
  readonly creatorProfileId: string;
  readonly creatorProfileVersion: number | null;
  readonly campaignId: string;
  readonly campaignPolicyVersion: number | null;
  readonly matchRunId: string | null;
  readonly opportunityId: string | null;
  readonly requestedRights: EngagementRequestedRights;
  readonly compensation: EngagementCompensationTerms | null;
  /** Provider-neutral offer brief (opaque structured data). */
  readonly brief: Readonly<Record<string, unknown>> | null;
  readonly formatVersion: string;
}

export interface CreateEngagementInput {
  readonly organizationScopeId: string;
  readonly creatorPersonId: string;
  readonly creatorProfileId?: string | null;
  readonly campaignId: string;
  readonly campaignPolicyVersion?: number | null;
  readonly matchRunId?: string | null;
  readonly opportunityId?: string | null;
  readonly requestedRights: {
    readonly uses: readonly { kind: string; terms?: string | null }[];
    readonly channels: readonly string[];
    readonly territories: readonly string[];
    readonly formats: readonly string[];
    readonly startsAt: string;
    readonly endsAt: string;
    readonly exclusions?: readonly string[];
  };
  readonly compensation?: {
    readonly format: string;
    readonly unit: string;
    readonly amount: number;
    readonly currency: string;
    readonly rewardPolicyReference?: string | null;
  } | null;
  readonly brief?: Readonly<Record<string, unknown>> | null;
  readonly idempotencyKey: string;
}

export interface CreateEngagementResult {
  readonly engagement: Engagement;
  /** false when the idempotency key replayed the committed offer. */
  readonly created: boolean;
}

/** Closed skip reasons of the auto-match batch (work order §3.2). */
export const ENGAGEMENT_BATCH_SKIP_REASONS = [
  "open_engagement_exists",
  "profile_not_active",
] as const;

export type EngagementBatchSkipReason =
  (typeof ENGAGEMENT_BATCH_SKIP_REASONS)[number];

/** One candidate outcome of an auto-match batch. */
export interface EngagementBatchOutcome {
  readonly creatorPersonId: string;
  readonly creatorProfileId: string;
  /** Present when the offer was (or already had been) created. */
  readonly engagementId: string | null;
  readonly created: boolean;
  readonly skipped: EngagementBatchSkipReason | null;
}

/**
 * The auto-match batch record — the auditable decision record of ONE
 * `createEngagementsFromMatch` execution (work order §3.2): which
 * eligible match-run candidates became DRAFT engagement offers and
 * which were skipped (with the closed reason). Append-only; it
 * mutates nothing else.
 */
export interface EngagementBatchRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly matchRunId: string;
  readonly campaignId: string;
  readonly campaignPolicyVersion: number | null;
  readonly candidateCount: number;
  readonly outcomes: readonly EngagementBatchOutcome[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface CreateEngagementsFromMatchInput {
  readonly organizationScopeId: string;
  readonly matchRunId: string;
  /** Maximum offers to create (default: every eligible candidate). */
  readonly limit?: number | null;
  /** The offer template applied to every candidate. */
  readonly offer: {
    readonly requestedRights: {
      readonly uses: readonly { kind: string; terms?: string | null }[];
      readonly channels: readonly string[];
      readonly territories: readonly string[];
      readonly formats: readonly string[];
      readonly startsAt: string;
      readonly endsAt: string;
      readonly exclusions?: readonly string[];
    };
    readonly compensation?: {
      readonly format: string;
      readonly unit: string;
      readonly amount: number;
      readonly currency: string;
      readonly rewardPolicyReference?: string | null;
    } | null;
    readonly brief?: Readonly<Record<string, unknown>> | null;
  };
  readonly idempotencyKey: string;
}

export interface CreateEngagementsFromMatchResult {
  readonly batch: EngagementBatchRecord;
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// The acceptance policy (CRE-003) — versioned, append-only
// ---------------------------------------------------------------------------

/** The acceptance mode (closed vocabulary): manual or auto-accept. */
export type CreatorAcceptanceMode = "manual" | "auto_accept";

/**
 * A creator acceptance policy VERSION — the creator's declared
 * auto-accept rules (work order §3.2). Append-only; the latest
 * version per (organizationScopeId, creatorPersonId) is effective.
 * The policy is DATA — the deterministic evaluation engine in
 * engagement-engine.ts consumes it; the policy itself authorizes
 * nothing.
 */
export interface CreatorAcceptancePolicyRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly creatorPersonId: string;
  /** Monotonic per (org, creator): 1, 2, 3… */
  readonly version: number;
  readonly mode: CreatorAcceptanceMode;
  /** Max concurrent NON-TERMINAL engagements (0–50). */
  readonly maxActiveEngagements: number;
  /**
   * Declared compensation floor: offers below it do not qualify
   * (format/unit/currency matched; an uncompensated offer fails any
   * declared floor). null = no floor.
   */
  readonly rateFloor: {
    readonly format: CreatorContentFormat;
    readonly unit: CreatorRateUnit;
    readonly amount: number;
    readonly currency: string;
  } | null;
  /** Usage-rights kinds the creator is willing to AUTO-GRANT. */
  readonly autoGrantableRights: readonly CreatorRightsKind[];
  /** Max requested grant duration in days (null = unbounded). */
  readonly maxGrantDurationDays: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface SetAcceptancePolicyInput {
  readonly organizationScopeId: string;
  readonly creatorPersonId: string;
  readonly mode: string;
  readonly maxActiveEngagements?: number | null;
  readonly rateFloor?: {
    readonly format: string;
    readonly unit: string;
    readonly amount: number;
    readonly currency: string;
  } | null;
  readonly autoGrantableRights?: readonly string[] | null;
  readonly maxGrantDurationDays?: number | null;
  readonly idempotencyKey: string;
}

export interface SetAcceptancePolicyResult {
  readonly policy: CreatorAcceptancePolicyRecord;
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// Auto-accept evaluation (deterministic, closed reason vocabulary)
// ---------------------------------------------------------------------------

/** One gate outcome of the auto-accept evaluation trace. */
export interface AutoAcceptGateOutcome {
  readonly reason: AutoAcceptGateReason;
  readonly passed: boolean;
  /** Machine-readable evaluation detail (inputs + comparison). */
  readonly detail: Readonly<Record<string, unknown>> | null;
}

/**
 * The deterministic auto-accept evaluation result (work order
 * §3.2). Identical inputs produce identical verdicts + traces; a
 * non-qualifying evaluation performs NO mutation.
 */
export interface AutoAcceptEvaluation {
  readonly qualifies: boolean;
  readonly mode: CreatorAcceptanceMode;
  readonly policyVersion: number | null;
  readonly gates: readonly AutoAcceptGateOutcome[];
}

// ---------------------------------------------------------------------------
// Usage rights — explicit, scoped, revocable (CRE-004)
// ---------------------------------------------------------------------------

/**
 * A UsageRightsGrant — the explicit, durable, auditable license the
 * creator grants for ONE engagement (work order §3.3). Created ONLY
 * by an acceptance (manual or auto); immutable after creation;
 * revocation is a separate append-only record; the effective status
 * is DERIVED (never a stored/mutated field).
 *
 * The ownership boundary (CRE-004): `contentOwnership` is frozen to
 * "creator_retained" — the grant input carries NO ownership field,
 * so there is structurally no code path that transfers ownership of
 * creator content or channels to the protocol. Producing UGC NEVER
 * mints a grant; publication on `creator_owned_channel` requires an
 * explicit grant containing the `channel_publication` use kind
 * scoped to that channel.
 */
export interface UsageRightsGrant {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly engagementId: string;
  /** The granting creator (the engagement's creator person). */
  readonly grantorPersonId: string;
  readonly uses: readonly {
    readonly kind: CreatorRightsKind;
    readonly terms: string | null;
  }[];
  readonly channels: readonly UsageRightsChannel[];
  readonly territories: readonly string[];
  readonly formats: readonly CreatorContentFormat[];
  readonly exclusions: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly contentOwnership: UsageRightsOwnership;
  readonly formatVersion: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** The append-only revocation record of ONE grant. */
export interface UsageRightsRevocation {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly grantId: string;
  readonly revokedBy: string;
  readonly reason: string | null;
  readonly revokedAt: string;
  /** The instant from which the revocation takes effect. */
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * The grant read view: the immutable grant + its (at most one)
 * revocation + the DERIVED effective status evaluated at `viewedAsOf`
 * (REVOKED when a revocation exists and asOf ≥ effectiveAt; EXPIRED
 * when asOf > endsAt; ACTIVE otherwise — work order §3.3).
 */
export interface UsageRightsView {
  readonly grant: UsageRightsGrant;
  readonly revocation: UsageRightsRevocation | null;
  readonly effectiveStatus: UsageRightsEffectiveStatus;
  readonly viewedAsOf: string;
}

export interface AcceptEngagementInput {
  readonly organizationScopeId: string;
  readonly engagementId: string;
  /** The caller's view of the engagement version (optimistic concurrency). */
  readonly expectedVersion: number;
  /** The explicitly granted usage rights (⊆ the requested envelope). */
  readonly grantedRights: {
    readonly uses: readonly { kind: string; terms?: string | null }[];
    readonly channels: readonly string[];
    readonly territories: readonly string[];
    readonly formats: readonly string[];
    readonly startsAt: string;
    readonly endsAt: string;
    readonly exclusions?: readonly string[];
  };
  readonly idempotencyKey: string;
}

export interface AcceptEngagementResult {
  readonly engagement: Engagement;
  readonly grant: UsageRightsGrant;
  readonly transition: TransitionResult;
}

export interface AutoAcceptEngagementInput {
  readonly organizationScopeId: string;
  readonly engagementId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface AutoAcceptEngagementResult {
  /** false when the deterministic evaluation did not qualify. */
  readonly accepted: boolean;
  readonly evaluation: AutoAcceptEvaluation;
  readonly engagement: Engagement;
  readonly grant: UsageRightsGrant | null;
  readonly transition: TransitionResult | null;
}

export interface RevokeUsageRightsInput {
  readonly organizationScopeId: string;
  readonly grantId: string;
  /** Defaults to now when omitted. */
  readonly effectiveAt?: string | null;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

export interface RevokeUsageRightsResult {
  readonly view: UsageRightsView;
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// UGC production / deliverables / submission (AC-02/AC-05)
// ---------------------------------------------------------------------------

/**
 * A UGC production record — first-class, tenant-scoped, append-only
 * (work order §3.4). Opened when production starts; preserves the
 * full lineage: creator, engagement, campaign (+ pinned policy
 * version), match run, opportunity and the optional contribution
 * reference.
 */
export interface UgcProduction {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly engagementId: string;
  readonly creatorPersonId: string;
  readonly creatorProfileId: string;
  readonly campaignId: string;
  readonly campaignPolicyVersion: number | null;
  readonly matchRunId: string | null;
  readonly opportunityId: string | null;
  /** Optional contribution lineage (the /contributions subject). */
  readonly contributionId: string | null;
  readonly formatVersion: string;
  readonly createdBy: string;
  readonly openedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * A provider-neutral external platform reference on a deliverable
 * (work order §3.4/AC-06): opaque strings ONLY — no
 * provider-client semantics in the domain, no credentials (those
 * stay behind secrets/adapters).
 */
export interface UgcExternalPlatformReference {
  readonly provider: string;
  readonly externalId: string;
  readonly url: string | null;
}

/**
 * A UGC deliverable VERSION — immutable, append-only. The version
 * number is the monotonic count per (productionId, deliverableKey)
 * (deterministic versioning — recorded under the production
 * advisory lock so concurrent recordings cannot fork the sequence).
 */
export interface UgcDeliverableVersion {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly productionId: string;
  /** Caller-assigned semantic key (e.g. "hero-video"). */
  readonly deliverableKey: string;
  /** 1, 2, 3… per (productionId, deliverableKey). */
  readonly version: number;
  readonly format: CreatorContentFormat;
  readonly title: string | null;
  /** Provider-neutral content reference (e.g. object-store URI). */
  readonly contentReference: string | null;
  readonly externalPlatform: UgcExternalPlatformReference | null;
  readonly notes: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * A UGC submission — the append-only record of ONE submission act:
 * the tendered deliverable count + the canonical evidence
 * references (every id validated to exist, be tenant-scoped and be
 * subject-bound to THIS production through the canonical
 * /evidence authority — work order §3.4/AC-05).
 */
export interface UgcSubmission {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly productionId: string;
  readonly engagementId: string;
  readonly deliverableCount: number;
  readonly evidenceReferences: readonly string[];
  readonly createdBy: string;
  readonly submittedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface OpenProductionInput {
  readonly organizationScopeId: string;
  readonly engagementId: string;
  readonly expectedVersion: number;
  /** Optional contribution lineage to preserve on the record. */
  readonly contributionId?: string | null;
  readonly idempotencyKey: string;
}

export interface OpenProductionResult {
  readonly production: UgcProduction;
  readonly transition: TransitionResult;
}

export interface RecordDeliverableInput {
  readonly organizationScopeId: string;
  readonly productionId: string;
  readonly deliverableKey: string;
  readonly format: string;
  readonly title?: string | null;
  readonly contentReference?: string | null;
  readonly externalPlatform?: {
    readonly provider: string;
    readonly externalId: string;
    readonly url?: string | null;
  } | null;
  readonly notes?: string | null;
  readonly idempotencyKey: string;
}

export interface RecordDeliverableResult {
  readonly deliverable: UgcDeliverableVersion;
  /** false when the idempotency key replayed the committed version. */
  readonly created: boolean;
}

export interface SubmitProductionInput {
  readonly organizationScopeId: string;
  readonly productionId: string;
  readonly expectedVersion: number;
  /** Canonical evidence ids backing the submission (≥1 required). */
  readonly evidenceReferences: readonly string[];
  readonly idempotencyKey: string;
}

export interface SubmitProductionResult {
  readonly submission: UgcSubmission;
  readonly transition: TransitionResult;
}

// ---------------------------------------------------------------------------
// Neutral cross-domain lookups + the workflow delegation callback
// (composition-root wired; work order §2)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral campaign view the engagement boundary needs
 * (existence + tenant scope + pinned policy version + the
 * administrative status the tender precondition reads). /campaigns
 * stays the campaign policy authority — this is a READ-ONLY view,
 * never campaign semantics.
 */
export interface EngagementCampaignView {
  readonly campaignId: string;
  /** The pinned policy version (null when the campaign has none). */
  readonly policyVersion: number | null;
  readonly organizationScopeId: string;
  /** The campaign's administrative status (e.g. "ACTIVE"). */
  readonly status: string;
}

/**
 * EngagementCampaignLookup — structural interface over the campaigns
 * domain (a thin composition-root adapter). A cross-scope or
 * nonexistent campaign resolves to null (no existence oracle).
 */
export interface EngagementCampaignLookup {
  resolve(
    campaignId: string,
    policyVersion?: number,
  ): Promise<EngagementCampaignView | null>;
}

/**
 * EngagementOpportunityLookup — structural interface over the
 * opportunities domain (existence + org scope), mirroring the
 * contributions boundary's OpportunityLookup precedent.
 */
export interface EngagementOpportunityLookup {
  getOrganizationScope(opportunityId: string): Promise<string | null>;
  exists(opportunityId: string): Promise<boolean>;
}

/**
 * ProductionEvidenceLookup — structural interface over the canonical
 * /evidence authority: resolves an evidence record's tenant scope +
 * subject binding. The UGC boundary NEVER fabricates evidence — it
 * only validates references through this read-only view (AC-05).
 */
export interface ProductionEvidenceView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

export interface ProductionEvidenceLookup {
  resolve(evidenceId: string): Promise<ProductionEvidenceView | null>;
}

/**
 * The sanctioned /workflows delegation callback (the
 * Proof-of-Value/service precedent): the engagement service validates
 * business preconditions and REQUESTS the authorized transition —
 * /workflows stays the SOLE lifecycle authority (AC-01).
 */
export interface EngagementWorkflowPort {
  requestTransition(
    request: TransitionRequest,
    execution: ExecutionContext,
  ): Promise<TransitionResult>;
}

/**
 * EngagementContributionLookup — structural interface over the
 * contributions domain (existence + org scope) so the production
 * record's contribution lineage is a REAL reference, not an opaque
 * string (the opportunity-lookup precedent).
 */
export interface EngagementContributionLookup {
  getOrganizationScope(contributionId: string): Promise<string | null>;
  exists(contributionId: string): Promise<boolean>;
}

export interface CreatorEngagementLookups {
  readonly campaign: EngagementCampaignLookup;
  readonly opportunity: EngagementOpportunityLookup;
  readonly contribution: EngagementContributionLookup;
  readonly safety: CreatorMatchSafetyLookup;
  readonly evidence: ProductionEvidenceLookup;
}

// ---------------------------------------------------------------------------
// The engagement / rights / production repositories
// ---------------------------------------------------------------------------

/**
 * EngagementRepository — persistence port for engagements. Exposes
 * BOTH the domain operations AND the LifecycleRepository structural
 * surface (getByIdWithinTx/saveWithinTx) consumed by the canonical
 * WorkflowService (the ContributionRepository precedent).
 */
export interface EngagementRepository {
  save(
    engagement: Engagement,
    execution: ExecutionContext,
  ): Promise<Engagement>;
  findById(id: string): Promise<Engagement | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<Engagement | null>;
  createWithinTx(
    engagement: Engagement,
    tx: AuthorityTransaction,
  ): Promise<Engagement>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      campaignId?: string;
      creatorPersonId?: string;
      states?: readonly LifecycleState[];
    },
  ): Promise<readonly Engagement[]>;
  /** The creator's NON-TERMINAL engagements in an org (auto-accept gate). */
  listNonTerminalByCreator(
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<readonly Engagement[]>;
  /** The non-terminal engagement for (org, campaign, creator), if any. */
  findNonTerminalWithinTx(
    organizationScopeId: string,
    campaignId: string,
    creatorPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<Engagement | null>;
  /** LifecycleRepository structural surface (WorkflowService). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<Engagement | null>;
  saveWithinTx(
    subject: Engagement,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<Engagement>;
}

export interface CreatorAcceptancePolicyRepository {
  save(
    policy: CreatorAcceptancePolicyRecord,
    execution: ExecutionContext,
  ): Promise<CreatorAcceptancePolicyRecord>;
  findLatest(
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<CreatorAcceptancePolicyRecord | null>;
  findLatestWithinTx(
    organizationScopeId: string,
    creatorPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<CreatorAcceptancePolicyRecord | null>;
  createWithinTx(
    policy: CreatorAcceptancePolicyRecord,
    tx: AuthorityTransaction,
  ): Promise<CreatorAcceptancePolicyRecord>;
}

export interface UsageRightsRepository {
  save(
    grant: UsageRightsGrant,
    execution: ExecutionContext,
  ): Promise<UsageRightsGrant>;
  findById(grantId: string): Promise<UsageRightsGrant | null>;
  findByEngagement(
    organizationScopeId: string,
    engagementId: string,
  ): Promise<UsageRightsGrant | null>;
  findByEngagementWithinTx(
    organizationScopeId: string,
    engagementId: string,
    tx: AuthorityTransaction,
  ): Promise<UsageRightsGrant | null>;
  createWithinTx(
    grant: UsageRightsGrant,
    tx: AuthorityTransaction,
  ): Promise<UsageRightsGrant>;
  saveRevocation(
    revocation: UsageRightsRevocation,
    execution: ExecutionContext,
  ): Promise<UsageRightsRevocation>;
  findRevocation(
    grantId: string,
  ): Promise<UsageRightsRevocation | null>;
  findRevocationWithinTx(
    grantId: string,
    tx: AuthorityTransaction,
  ): Promise<UsageRightsRevocation | null>;
  createRevocationWithinTx(
    revocation: UsageRightsRevocation,
    tx: AuthorityTransaction,
  ): Promise<UsageRightsRevocation>;
  listByOrganization(
    organizationScopeId: string,
    engagementId?: string,
  ): Promise<readonly UsageRightsGrant[]>;
}

export interface UgcProductionRepository {
  save(
    production: UgcProduction,
    execution: ExecutionContext,
  ): Promise<UgcProduction>;
  findById(id: string): Promise<UgcProduction | null>;
  createWithinTx(
    production: UgcProduction,
    tx: AuthorityTransaction,
  ): Promise<UgcProduction>;
  findByEngagement(
    organizationScopeId: string,
    engagementId: string,
  ): Promise<UgcProduction | null>;
  listByOrganization(
    organizationScopeId: string,
    engagementId?: string,
  ): Promise<readonly UgcProduction[]>;
}

export interface UgcDeliverableRepository {
  save(
    deliverable: UgcDeliverableVersion,
    execution: ExecutionContext,
  ): Promise<UgcDeliverableVersion>;
  createWithinTx(
    deliverable: UgcDeliverableVersion,
    tx: AuthorityTransaction,
  ): Promise<UgcDeliverableVersion>;
  listByProduction(
    organizationScopeId: string,
    productionId: string,
  ): Promise<readonly UgcDeliverableVersion[]>;
  countByKeyWithinTx(
    productionId: string,
    deliverableKey: string,
    tx: AuthorityTransaction,
  ): Promise<number>;
}

export interface UgcSubmissionRepository {
  save(
    submission: UgcSubmission,
    execution: ExecutionContext,
  ): Promise<UgcSubmission>;
  createWithinTx(
    submission: UgcSubmission,
    tx: AuthorityTransaction,
  ): Promise<UgcSubmission>;
  findById(id: string): Promise<UgcSubmission | null>;
  listByProduction(
    organizationScopeId: string,
    productionId: string,
  ): Promise<readonly UgcSubmission[]>;
}

export interface EngagementBatchRepository {
  save(
    batch: EngagementBatchRecord,
    execution: ExecutionContext,
  ): Promise<EngagementBatchRecord>;
  createWithinTx(
    batch: EngagementBatchRecord,
    tx: AuthorityTransaction,
  ): Promise<EngagementBatchRecord>;
  findById(id: string): Promise<EngagementBatchRecord | null>;
  listByOrganization(
    organizationScopeId: string,
    matchRunId?: string,
  ): Promise<readonly EngagementBatchRecord[]>;
}

// ---------------------------------------------------------------------------
// The engagement domain service
// ---------------------------------------------------------------------------

export interface CreatorEngagementService {
  /**
   * Record an engagement OFFER (DRAFT). Validates the campaign
   * (existence + tenant scope through the neutral lookup), the
   * creator profile (ACTIVE), the requested-rights envelope (frozen
   * vocabularies) and — when a match run is referenced — that the
   * creator was an ELIGIBLE candidate of that run. Serialized by the
   * advisory-lock unique anchor: at most ONE non-terminal engagement
   * per (org, campaign, creator).
   */
  createEngagement(
    execution: ExecutionContext,
    input: CreateEngagementInput,
  ): Promise<CreateEngagementResult>;
  /**
   * Auto-match orchestration: turn ONE match run's eligible
   * candidates into DRAFT offers (rank order; optional limit).
   * Per-candidate duplicate/conflict outcomes are recorded in the
   * batch record — never silently dropped.
   */
  createEngagementsFromMatch(
    execution: ExecutionContext,
    input: CreateEngagementsFromMatchInput,
  ): Promise<CreateEngagementsFromMatchResult>;
  /**
   * Manual acceptance: validates the granted rights against the
   * requested envelope, records the usage-rights grant, then requests
   * the READY → ASSIGNED transition through /workflows.
   */
  acceptEngagement(
    execution: ExecutionContext,
    input: AcceptEngagementInput,
  ): Promise<AcceptEngagementResult>;
  /**
   * Deterministic auto-accept (CRE-003): evaluates the creator's
   * acceptance policy against the offer (closed gate vocabulary,
   * full trace); a qualifying evaluation records the auto-grant and
   * requests the transition; a non-qualifying evaluation mutates
   * NOTHING.
   */
  autoAcceptEngagement(
    execution: ExecutionContext,
    input: AutoAcceptEngagementInput,
  ): Promise<AutoAcceptEngagementResult>;
  /** Revoke a usage-rights grant (grantor-only; one revocation). */
  revokeUsageRights(
    execution: ExecutionContext,
    input: RevokeUsageRightsInput,
  ): Promise<RevokeUsageRightsResult>;
  /** Set the next acceptance-policy version (append-only). */
  setAcceptancePolicy(
    execution: ExecutionContext,
    input: SetAcceptancePolicyInput,
  ): Promise<SetAcceptancePolicyResult>;
  /** Open UGC production (record + ASSIGNED → IN_PROGRESS). */
  openProduction(
    execution: ExecutionContext,
    input: OpenProductionInput,
  ): Promise<OpenProductionResult>;
  /** Append an immutable deliverable version (deterministic). */
  recordDeliverable(
    execution: ExecutionContext,
    input: RecordDeliverableInput,
  ): Promise<RecordDeliverableResult>;
  /**
   * Submit the production (submission record + IN_PROGRESS →
   * SUBMITTED): requires ≥1 deliverable version and ≥1 canonical
   * evidence reference, every reference subject-bound to THIS
   * production.
   */
  submitProduction(
    execution: ExecutionContext,
    input: SubmitProductionInput,
  ): Promise<SubmitProductionResult>;
  /** Tenant-scoped reads (cross-scope = NotFoundError). */
  getEngagement(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<Engagement>;
  listEngagements(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      campaignId?: string;
      creatorPersonId?: string;
      states?: readonly LifecycleState[];
    },
  ): Promise<readonly Engagement[]>;
  getAcceptancePolicy(
    execution: ExecutionContext,
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<CreatorAcceptancePolicyRecord | null>;
  getUsageRights(
    execution: ExecutionContext,
    organizationScopeId: string,
    grantId: string,
    asOf?: string | null,
  ): Promise<UsageRightsView>;
  listUsageRights(
    execution: ExecutionContext,
    organizationScopeId: string,
    engagementId?: string,
  ): Promise<readonly UsageRightsView[]>;
  getProduction(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<UgcProduction>;
  listProductions(
    execution: ExecutionContext,
    organizationScopeId: string,
    engagementId?: string,
  ): Promise<readonly UgcProduction[]>;
  listDeliverables(
    execution: ExecutionContext,
    organizationScopeId: string,
    productionId: string,
  ): Promise<readonly UgcDeliverableVersion[]>;
  listSubmissions(
    execution: ExecutionContext,
    organizationScopeId: string,
    productionId: string,
  ): Promise<readonly UgcSubmission[]>;
}

export interface CreatorEngagementServiceDeps {
  readonly engagementRepository: EngagementRepository;
  readonly acceptancePolicyRepository: CreatorAcceptancePolicyRepository;
  readonly usageRightsRepository: UsageRightsRepository;
  readonly productionRepository: UgcProductionRepository;
  readonly deliverableRepository: UgcDeliverableRepository;
  readonly submissionRepository: UgcSubmissionRepository;
  readonly batchRepository: EngagementBatchRepository;
  readonly profileRepository: CreatorProfileRepository;
  readonly versionRepository: CreatorProfileVersionRepository;
  readonly runRepository: CreatorMatchRunRepository;
  readonly lookups: CreatorEngagementLookups;
  readonly workflow: EngagementWorkflowPort;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The CreatorsPort describes the boundary's readiness. After
 * NET-W015 it is `"ready"` (the boundary carries the creator
 * identity/preference domain: profile anchors, versioned sections,
 * privacy/secret guards, reputation references). NET-W016 adds the
 * matching service (deterministic eligibility + explicit-signal
 * ranking + bounded advisory) inside the SAME frozen boundary.
 */
export interface CreatorsPort {
  readonly boundary: "creators";
  readonly readiness: "ready";
  /** Audit event types emitted by material creator mutations (AC-05). */
  readonly auditEventTypes: {
    readonly profileCreated: "creator_profile.created";
    readonly profileVersionDefined: "creator_profile.version_defined";
    readonly profileActivated: "creator_profile.activated";
    readonly profilePaused: "creator_profile.paused";
    readonly profileResumed: "creator_profile.resumed";
    readonly profileArchived: "creator_profile.archived";
    /** NET-W016: the (only) material matching mutation — the run record. */
    readonly matchRunRecorded: "creator_match.recorded";
    /** NET-W017: material engagement-domain mutations (append-only records). */
    readonly engagementOfferRecorded: "engagement.offer_recorded";
    readonly engagementBatchRecorded: "engagement.batch_recorded";
    readonly usageRightsGranted: "usage_rights.granted";
    readonly usageRightsRevoked: "usage_rights.revoked";
    readonly acceptancePolicySet: "creator_acceptance_policy.set";
    readonly ugcProductionOpened: "ugc_production.opened";
    readonly ugcDeliverableRecorded: "ugc_production.deliverable_recorded";
    readonly ugcProductionSubmitted: "ugc_production.submitted";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  IdempotencyStore,
  ReputationDimension,
  CreatorContentFormat,
  CreatorEngagementBand,
  CreatorPlatformKind,
  CreatorProfileStatus,
  CreatorReputationRole,
  CreatorRightsKind,
  CreatorAudienceSizeBand,
  CreatorAudienceAgeBand,
  CreatorRateUnit,
  CreatorMatchSignal,
  CreatorMatchGateReason,
  CreatorMatchWeightsShape,
  UsageRightsChannel,
  UsageRightsEffectiveStatus,
  UsageRightsOwnership,
  AutoAcceptGateReason,
  LifecycleState,
  LifecycleSubject,
  TransitionRequest,
  TransitionResult,
};
