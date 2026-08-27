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
 * Out of scope (work order §5): creator matching/ranking (NET-W016),
 * UGC production workflow / rights EXECUTION (NET-W017),
 * sponsorship/disclosure EXECUTION (NET-W018), ad inventory or
 * optimization (NET-W019+), external platform EXECUTION, direct
 * reputation scoring, payment execution, blockchain consensus, and
 * any AI/model-driven eligibility decision.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { ReputationDimension } from "../core/reputation.ts";
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
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The CreatorsPort describes the boundary's readiness. After
 * NET-W015 it is `"ready"` (the boundary carries the creator
 * identity/preference domain: profile anchors, versioned sections,
 * privacy/secret guards, reputation references).
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
};
