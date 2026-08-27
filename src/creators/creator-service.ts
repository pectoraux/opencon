/**
 * CreatorService — domain service for creator identity and
 * preferences (NET-W015 §3.1–§3.6).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership),
 * §13 (Provider neutrality), §19 (AI never establishes eligibility);
 * spec/architecture-lock.md §2 (/creators is a frozen core domain),
 * §3 (PostgreSQL authoritative), §12 (execution lineage), §14
 * (provider neutrality).
 *
 * THE ADMINISTRATIVE STATUS MACHINE (validated here; status is
 * derived from the append-only event history — events are never
 * rewritten):
 *
 * ```text
 * DRAFT ──activate──→ ACTIVE ⇄ pause/resume ⇄ PAUSED
 *   │                    │
 *   └── archive ────────┴── archive ──→ ARCHIVED (terminal)
 * ```
 *
 * This is the CREATOR PROFILE RECORD's own status — the
 * campaign-record precedent. It is deliberately NOT a workflow
 * lifecycle: engagements/opportunities that may later reference a
 * creator profile are lifecycle subjects owned exclusively by
 * /workflows.
 *
 * AUTHORITY SEPARATION (the work item's strongest constraint):
 *  - /identity remains the person identity authority: profiles
 *    ANCHOR to an existing canonical person (validated through the
 *    neutral CreatorPersonLookup) and are SELF-ANCHORED (the acting
 *    person must be the anchor person); the unique-anchor rule keeps
 *    one profile per person per organization scope — no second
 *    identity authority can form;
 *  - /reputation remains the trust-signal authority: every
 *    reputation reference is VERIFIED through the neutral
 *    CreatorReputationSnapshotLookup (existence + org scope +
 *    subject person + digest) and stored as a REFERENCE ONLY — no
 *    score is ever computed, stored or accepted here (CRE-005's
 *    audience_influence/production roles are separate references);
 *  - /settlement remains the economic authority: commercial rates
 *    are DECLARED preferences validated with the shared economic
 *    bounds — this service carries NO economic mutation path at all;
 *  - /workflows remains the lifecycle authority: the status machine
 *    above is the record's own administrative status;
 *  - provider-specific platform semantics stay OUTSIDE the domain:
 *    platform connections are provider-neutral references, and the
 *    credential-shaped/raw-audience-shaped key guards make secret
 *    and raw-audience material structurally unable to enter profile
 *    versions.
 *
 * DETERMINISM: every profile version is immutable and version =
 * latest+1 under the ORGANIZATION-INDEPENDENT lineage mutex
 * `creator_profile_lineage:{profileId}` (the NET-W007/008/010/011
 * pattern — a lineage can never fork across scopes); profile
 * CREATION is serialized per (organization scope, person) under the
 * unique-anchor mutex `creator_profile_anchor:{organizationScopeId}
 * :{creatorPersonId}` (the NET-W007 subject-mutex pattern), so the
 * one-profile-per-(scope, person) invariant holds even for
 * concurrent callers with DIFFERENT idempotency keys; the
 * activation gate reads only stored records.
 *
 * TENANT ISOLATION: every read resolves records WITHIN an
 * organization scope — including the ID-based reads (a profile
 * fetched by id, its versions and its reputation resolution are all
 * scope-guarded; a cross-scope id is indistinguishable from a
 * nonexistent one — no existence oracle). Mutations are
 * OWNER-ONLY (person-level authorization subsumes tenancy: the
 * acting person must BE the anchor person).
 *
 * OWNERSHIP: profile/version/status mutations are OWNER-ONLY (the
 * profile owner is the anchor person; checked server-side on every
 * mutation — API-002).
 *
 * Atomicity: every mutation commits its profile record + appended
 * events + idempotency record + audit event in ONE authoritative
 * transaction (IdempotencyStore.applyIdempotent; NET-W004-AC-07).
 *
 * Tier compliance: creators domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  CREATOR_MAX_TOP_GEOGRAPHIES,
  InvalidCreatorProfileError,
  assertNoCredentialShapedKeys,
  assertNoRawAudienceKeys,
  isCreatorAudienceAgeBand,
  isCreatorAudienceSizeBand,
  isCreatorContentFormat,
  isCreatorEngagementBand,
  isCreatorPlatformKind,
  isCreatorRateUnit,
  isCreatorReputationRole,
  isCreatorRightsKind,
  requireCreatorString,
  validateCreatorAudienceShare,
  validateCreatorCurrencyCode,
  validateCreatorLanguageTag,
  validateCreatorRateAmount,
  validateCreatorReputationDimension,
  validateCreatorTerritoryCode,
} from "../core/creators.ts";
import type {
  CreatorLookups,
  CreatorParticipationRules,
  CreatorProfileEvent,
  CreatorProfileEventKind,
  CreatorProfileRecord,
  CreatorProfileRepository,
  CreatorProfileSections,
  CreatorProfileVersion,
  CreatorProfileVersionRepository,
  CreatorReputationReference,
  CreatorRestrictions,
  CreatorAvailability,
  CreatorCommercialPreferences,
  CreatorAudienceAggregate,
  CreatorService,
  CreatorProfileStatusInput,
  CreateCreatorProfileInput,
  CreateCreatorProfileResult,
  DefineCreatorProfileVersionInput,
  DefineCreatorProfileVersionResult,
} from "./port.ts";

const CREATOR_PROFILE_CREATED = "creator_profile.created" as const;
const CREATOR_PROFILE_VERSION_DEFINED =
  "creator_profile.version_defined" as const;
const CREATOR_PROFILE_ACTIVATED = "creator_profile.activated" as const;
const CREATOR_PROFILE_PAUSED = "creator_profile.paused" as const;
const CREATOR_PROFILE_RESUMED = "creator_profile.resumed" as const;
const CREATOR_PROFILE_ARCHIVED = "creator_profile.archived" as const;

export interface CreatorServiceDeps {
  readonly repository: CreatorProfileRepository;
  readonly versionRepository: CreatorProfileVersionRepository;
  readonly lookups: CreatorLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function creatorValidationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new InvalidCreatorProfileError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw creatorValidationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/**
 * The tenant-isolation gate on every read: creator records resolve
 * ONLY within an organization scope (PR #30 review remediation —
 * the ID-based reads carry the same boundary as by-person/list).
 */
function assertOrganizationScopeId(organizationScopeId: string): string {
  if (!organizationScopeId?.trim()) {
    throw creatorValidationError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

/** The acting person's id (authorization: only persons act on profiles). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw creatorValidationError(
      "an authenticated person actor is required (service/system actors cannot manage creator profiles)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** The owner-only gate (every profile/version/status mutation). */
function assertOwner(
  profile: CreatorProfileRecord,
  actorPersonId: string,
): void {
  if (profile.creatorPersonId !== actorPersonId) {
    throw new OpenConError({
      code: "CREATOR_FORBIDDEN",
      classification: "authorization",
      message: `person ${actorPersonId} is not the owner of creator profile ${profile.id} (owner: ${profile.creatorPersonId})`,
      context: {
        profileId: profile.id,
        actorPersonId,
        ownerPersonId: profile.creatorPersonId,
      },
    });
  }
}

/** Build one append-only history event. */
function buildEvent(
  event: CreatorProfileEventKind,
  execution: ExecutionContext,
  actorPersonId: string,
  note: string | null,
  details: Readonly<Record<string, unknown>>,
): CreatorProfileEvent {
  return Object.freeze({
    id: randomUUID(),
    event,
    actorPersonId,
    note,
    details: Object.freeze({ ...details }),
    recordedAt: new Date().toISOString(),
    executionId: execution.executionId,
    correlationId: execution.correlationId,
  });
}

/** Per-record serialization lock (status-machine check-then-act). */
function profileLockKey(profileId: string): string {
  return `creator_profile_record:${profileId}`;
}

/**
 * The unique-anchor serialization mutex: serializes concurrent
 * profile creations for the SAME (organization scope, person) even
 * under DIFFERENT idempotency keys. The idempotency key alone is
 * too narrow — the unique-anchor rule guards the ANCHOR IDENTITY,
 * not the caller's key (the same check-then-act reasoning as the
 * NET-W007 dispute-open subject mutex and the NET-W012 transaction
 * boundary gates). Held through the commit, so the in-tx anchor
 * re-check always observes the prior creator's COMMITTED profile —
 * "one profile per (organization scope, person)" is structurally
 * guaranteed, never snapshot-race-dependent (PR #30 review).
 */
function creatorProfileAnchorLockKey(
  organizationScopeId: string,
  creatorPersonId: string,
): string {
  return `creator_profile_anchor:${organizationScopeId}:${creatorPersonId}`;
}

/** The org-INDEPENDENT version-lineage mutex (the NET-W007/008/010/011 pattern). */
function profileVersionLineageLockKey(profileId: string): string {
  return `creator_profile_lineage:${profileId}`;
}

/** Append an event + derive the next record (immutably). */
function withEvent(
  profile: CreatorProfileRecord,
  event: CreatorProfileEvent,
  patch: Partial<Pick<CreatorProfileRecord, "status" | "currentVersion">>,
): CreatorProfileRecord {
  return Object.freeze({
    ...profile,
    ...patch,
    events: Object.freeze([...profile.events, event]),
    updatedAt: event.recordedAt,
  });
}

// ---------------------------------------------------------------------------
// Section validation (pure; work order §3.2–§3.4)
// ---------------------------------------------------------------------------

function validateStringArray(
  field: string,
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw creatorValidationError(`${field} must be an array`, { field });
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string" || !entry.trim()) {
      throw creatorValidationError(
        `${field}[${String(i)}] must be a non-empty string`,
        { field, index: i },
      );
    }
    out.push(entry.trim());
  }
  return Object.freeze(out);
}

/** Validate an array whose entries must all be closed-vocabulary members. */
function validateClosedVocabularyArray<T extends string>(
  field: string,
  value: unknown,
  guard: (entry: string) => entry is T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw creatorValidationError(`${field} must be an array`, { field });
  }
  const out: T[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string" || !guard(entry)) {
      throw creatorValidationError(
        `${field}[${String(i)}] must be one of the closed vocabulary values`,
        { field, index: i },
      );
    }
    out.push(entry);
  }
  return Object.freeze(out);
}

function validatePlatforms(
  raw: unknown,
): CreatorProfileSections["platforms"] {
  if (!Array.isArray(raw)) {
    throw creatorValidationError("platforms must be an array", {
      field: "platforms",
    });
  }
  if (raw.length === 0) {
    throw creatorValidationError(
      "at least one connected platform is required (a creator profile without a platform reference is not matchable)",
      { field: "platforms" },
    );
  }
  const seen = new Set<string>();
  return Object.freeze(
    raw.map((entry, index) => {
      const field = `platforms[${String(index)}]`;
      if (entry === null || typeof entry !== "object") {
        throw creatorValidationError(`${field} must be an object`, { field });
      }
      const obj = entry as Readonly<Record<string, unknown>>;
      const platformKind = requireCreatorString(
        `${field}.platformKind`,
        obj.platformKind,
      );
      if (!isCreatorPlatformKind(platformKind)) {
        throw creatorValidationError(
          `${field}.platformKind must be one of the closed platform kinds`,
          { field: `${field}.platformKind`, platformKind },
        );
      }
      const handle = requireCreatorString(`${field}.handle`, obj.handle);
      if (handle.length > 200) {
        throw creatorValidationError(
          `${field}.handle must be at most 200 characters`,
          { field: `${field}.handle` },
        );
      }
      const displayName =
        obj.displayName === undefined || obj.displayName === null
          ? null
          : requireCreatorString(`${field}.displayName`, obj.displayName);
      const profileUrl =
        obj.profileUrl === undefined || obj.profileUrl === null
          ? null
          : (() => {
              const url = requireCreatorString(
                `${field}.profileUrl`,
                obj.profileUrl,
              );
              if (!/^https:\/\//.test(url)) {
                throw creatorValidationError(
                  `${field}.profileUrl must be an https URL`,
                  { field: `${field}.profileUrl` },
                );
              }
              return url;
            })();
      const capabilities = validateClosedVocabularyArray(
        `${field}.capabilities`,
        obj.capabilities,
        isCreatorContentFormat,
      );
      if (capabilities.length === 0) {
        throw creatorValidationError(
          `${field}.capabilities must list at least one content format`,
          { field: `${field}.capabilities` },
        );
      }
      const languages = validateStringArray(`${field}.languages`, obj.languages);
      if (languages.length === 0) {
        throw creatorValidationError(
          `${field}.languages must list at least one language tag`,
          { field: `${field}.languages` },
        );
      }
      for (let i = 0; i < languages.length; i += 1) {
        validateCreatorLanguageTag(
          `${field}.languages[${String(i)}]`,
          languages[i]!,
        );
      }
      // The unique-connection rule: one reference per platform kind —
      // a duplicate kind is ambiguous provider state, not a
      // reference list.
      if (seen.has(platformKind)) {
        throw creatorValidationError(
          `${field}.platformKind ${platformKind} appears more than once — one connected-platform reference per platform kind`,
          { field, platformKind },
        );
      }
      seen.add(platformKind);
      return Object.freeze({
        platformKind,
        handle,
        displayName,
        profileUrl,
        capabilities,
        languages,
      });
    }),
  );
}

function validateAudience(
  raw: unknown,
): CreatorAudienceAggregate {
  if (raw === null || typeof raw !== "object") {
    throw creatorValidationError("audience must be an object", {
      field: "audience",
    });
  }
  const obj = raw as Readonly<Record<string, unknown>>;
  const sizeBand = requireCreatorString("audience.sizeBand", obj.sizeBand);
  if (!isCreatorAudienceSizeBand(sizeBand)) {
    throw creatorValidationError(
      "audience.sizeBand must be one of the closed audience size bands",
      { field: "audience.sizeBand", sizeBand },
    );
  }
  const engagementBand = requireCreatorString(
    "audience.engagementBand",
    obj.engagementBand,
  );
  if (!isCreatorEngagementBand(engagementBand)) {
    throw creatorValidationError(
      "audience.engagementBand must be one of the closed engagement bands",
      { field: "audience.engagementBand", engagementBand },
    );
  }
  if (!Array.isArray(obj.ageDistribution)) {
    throw creatorValidationError(
      "audience.ageDistribution must be an array of aggregate band shares",
      { field: "audience.ageDistribution" },
    );
  }
  const ageBands = new Set<string>();
  let ageTotal = 0;
  const ageDistribution = Object.freeze(
    (obj.ageDistribution as unknown[]).map((entry, index) => {
      const field = `audience.ageDistribution[${String(index)}]`;
      if (entry === null || typeof entry !== "object") {
        throw creatorValidationError(`${field} must be an object`, { field });
      }
      const bandObj = entry as Readonly<Record<string, unknown>>;
      const band = requireCreatorString(`${field}.band`, bandObj.band);
      if (!isCreatorAudienceAgeBand(band)) {
        throw creatorValidationError(
          `${field}.band must be one of the closed audience age bands`,
          { field: `${field}.band`, band },
        );
      }
      if (ageBands.has(band)) {
        throw creatorValidationError(
          `${field}.band ${band} appears more than once`,
          { field, band },
        );
      }
      ageBands.add(band);
      const share = validateCreatorAudienceShare(
        `${field}.share`,
        Number(bandObj.share),
      );
      ageTotal += share;
      return Object.freeze({ band, share });
    }),
  );
  if (ageTotal > 100 + Number.EPSILON) {
    throw creatorValidationError(
      `audience.ageDistribution shares sum to ${String(ageTotal)} — aggregate shares must not exceed 100`,
      { field: "audience.ageDistribution", total: ageTotal },
    );
  }
  if (!Array.isArray(obj.topGeographies)) {
    throw creatorValidationError(
      "audience.topGeographies must be an array of aggregate territory shares",
      { field: "audience.topGeographies" },
    );
  }
  if ((obj.topGeographies as unknown[]).length > CREATOR_MAX_TOP_GEOGRAPHIES) {
    throw creatorValidationError(
      `audience.topGeographies may carry at most ${String(CREATOR_MAX_TOP_GEOGRAPHIES)} entries`,
      { field: "audience.topGeographies" },
    );
  }
  const territories = new Set<string>();
  let geoTotal = 0;
  const topGeographies = Object.freeze(
    (obj.topGeographies as unknown[]).map((entry, index) => {
      const field = `audience.topGeographies[${String(index)}]`;
      if (entry === null || typeof entry !== "object") {
        throw creatorValidationError(`${field} must be an object`, { field });
      }
      const geoObj = entry as Readonly<Record<string, unknown>>;
      const territory = validateCreatorTerritoryCode(
        `${field}.territory`,
        String(geoObj.territory),
      );
      if (territories.has(territory)) {
        throw creatorValidationError(
          `${field}.territory ${territory} appears more than once`,
          { field, territory },
        );
      }
      territories.add(territory);
      const share = validateCreatorAudienceShare(
        `${field}.share`,
        Number(geoObj.share),
      );
      geoTotal += share;
      return Object.freeze({ territory, share });
    }),
  );
  if (geoTotal > 100 + Number.EPSILON) {
    throw creatorValidationError(
      `audience.topGeographies shares sum to ${String(geoTotal)} — aggregate shares must not exceed 100`,
      { field: "audience.topGeographies", total: geoTotal },
    );
  }
  return Object.freeze({
    sizeBand,
    engagementBand,
    ageDistribution,
    topGeographies,
  });
}

function validateCommercial(
  raw: unknown,
): CreatorCommercialPreferences {
  if (raw === null || typeof raw !== "object") {
    throw creatorValidationError("commercial must be an object", {
      field: "commercial",
    });
  }
  const obj = raw as Readonly<Record<string, unknown>>;
  if (!Array.isArray(obj.rates)) {
    throw creatorValidationError(
      "commercial.rates must be an array of declared rate entries",
      { field: "commercial.rates" },
    );
  }
  const seen = new Set<string>();
  const rates = Object.freeze(
    (obj.rates as unknown[]).map((entry, index) => {
      const field = `commercial.rates[${String(index)}]`;
      if (entry === null || typeof entry !== "object") {
        throw creatorValidationError(`${field} must be an object`, { field });
      }
      const rateObj = entry as Readonly<Record<string, unknown>>;
      const format = requireCreatorString(`${field}.format`, rateObj.format);
      if (!isCreatorContentFormat(format)) {
        throw creatorValidationError(
          `${field}.format must be one of the closed content formats`,
          { field: `${field}.format`, format },
        );
      }
      const unit = requireCreatorString(`${field}.unit`, rateObj.unit);
      if (!isCreatorRateUnit(unit)) {
        throw creatorValidationError(
          `${field}.unit must be one of the closed rate units`,
          { field: `${field}.unit`, unit },
        );
      }
      // One declared rate per (format × unit): the rate card is a
      // set, not a history.
      const dedupe = `${format}:${unit}`;
      if (seen.has(dedupe)) {
        throw creatorValidationError(
          `${field} duplicates the declared rate for ${dedupe}`,
          { field, format, unit },
        );
      }
      seen.add(dedupe);
      const amount = validateCreatorRateAmount(
        `${field}.amount`,
        Number(rateObj.amount),
      );
      const currency = validateCreatorCurrencyCode(
        `${field}.currency`,
        String(rateObj.currency),
      );
      return Object.freeze({ format, unit, amount, currency });
    }),
  );
  if (rates.length === 0) {
    throw creatorValidationError(
      "commercial.rates must declare at least one rate (a creator profile without declared commercial preferences is not matchable)",
      { field: "commercial.rates" },
    );
  }
  const preferredCurrencies = validateStringArray(
    "commercial.preferredCurrencies",
    obj.preferredCurrencies,
  );
  for (let i = 0; i < preferredCurrencies.length; i += 1) {
    validateCreatorCurrencyCode(
      `commercial.preferredCurrencies[${String(i)}]`,
      preferredCurrencies[i]!,
    );
  }
  const negotiable = obj.negotiable;
  if (typeof negotiable !== "boolean") {
    throw creatorValidationError(
      "commercial.negotiable must be a boolean",
      { field: "commercial.negotiable" },
    );
  }
  return Object.freeze({ rates, negotiable, preferredCurrencies });
}

function validateRights(
  raw: unknown,
): readonly CreatorProfileSections["rights"][number][] {
  if (!Array.isArray(raw)) {
    throw creatorValidationError("rights must be an array", {
      field: "rights",
    });
  }
  const seen = new Set<string>();
  return Object.freeze(
    raw.map((entry, index) => {
      const field = `rights[${String(index)}]`;
      if (entry === null || typeof entry !== "object") {
        throw creatorValidationError(`${field} must be an object`, { field });
      }
      const obj = entry as Readonly<Record<string, unknown>>;
      const kind = requireCreatorString(`${field}.kind`, obj.kind);
      if (!isCreatorRightsKind(kind)) {
        throw creatorValidationError(
          `${field}.kind must be one of the closed rights kinds`,
          { field: `${field}.kind`, kind },
        );
      }
      if (seen.has(kind)) {
        throw creatorValidationError(
          `${field}.kind ${kind} appears more than once`,
          { field, kind },
        );
      }
      seen.add(kind);
      const terms =
        obj.terms === undefined || obj.terms === null
          ? null
          : requireCreatorString(`${field}.terms`, obj.terms);
      return Object.freeze({ kind, terms });
    }),
  );
}

function validateRestrictions(raw: unknown): CreatorRestrictions {
  if (raw === null || typeof raw !== "object") {
    throw creatorValidationError("restrictions must be an object", {
      field: "restrictions",
    });
  }
  const obj = raw as Readonly<Record<string, unknown>>;
  const restrictedTopics = validateStringArray(
    "restrictions.restrictedTopics",
    obj.restrictedTopics,
  );
  for (let i = 0; i < restrictedTopics.length; i += 1) {
    if (restrictedTopics[i]!.length > 200) {
      throw creatorValidationError(
        `restrictions.restrictedTopics[${String(i)}] must be at most 200 characters`,
        { field: `restrictions.restrictedTopics[${String(i)}]` },
      );
    }
  }
  const restrictedFormats = validateClosedVocabularyArray(
    "restrictions.restrictedFormats",
    obj.restrictedFormats,
    isCreatorContentFormat,
  );
  const restrictedTerritories = validateStringArray(
    "restrictions.restrictedTerritories",
    obj.restrictedTerritories,
  );
  for (let i = 0; i < restrictedTerritories.length; i += 1) {
    validateCreatorTerritoryCode(
      `restrictions.restrictedTerritories[${String(i)}]`,
      restrictedTerritories[i]!,
    );
  }
  if (typeof obj.requiresDisclosure !== "boolean") {
    throw creatorValidationError(
      "restrictions.requiresDisclosure must be a boolean",
      { field: "restrictions.requiresDisclosure" },
    );
  }
  return Object.freeze({
    restrictedTopics,
    restrictedFormats,
    restrictedTerritories,
    requiresDisclosure: obj.requiresDisclosure,
  });
}

function validateAvailability(raw: unknown): CreatorAvailability {
  if (raw === null || typeof raw !== "object") {
    throw creatorValidationError("availability must be an object", {
      field: "availability",
    });
  }
  const obj = raw as Readonly<Record<string, unknown>>;
  if (typeof obj.acceptingWork !== "boolean") {
    throw creatorValidationError(
      "availability.acceptingWork must be a boolean",
      { field: "availability.acceptingWork" },
    );
  }
  const weeklyCapacity = Number(obj.weeklyCapacity);
  if (
    !Number.isFinite(weeklyCapacity) ||
    weeklyCapacity < 0 ||
    weeklyCapacity > 100 ||
    !Number.isInteger(weeklyCapacity)
  ) {
    throw creatorValidationError(
      "availability.weeklyCapacity must be an integer between 0 and 100",
      { field: "availability.weeklyCapacity" },
    );
  }
  const minimumNoticeDays = Number(obj.minimumNoticeDays);
  if (
    !Number.isFinite(minimumNoticeDays) ||
    minimumNoticeDays < 0 ||
    minimumNoticeDays > 365 ||
    !Number.isInteger(minimumNoticeDays)
  ) {
    throw creatorValidationError(
      "availability.minimumNoticeDays must be an integer between 0 and 365",
      { field: "availability.minimumNoticeDays" },
    );
  }
  return Object.freeze({
    acceptingWork: obj.acceptingWork,
    weeklyCapacity,
    minimumNoticeDays,
  });
}

function validateParticipation(raw: unknown): CreatorParticipationRules {
  if (raw === null || typeof raw !== "object") {
    throw creatorValidationError("participation must be an object", {
      field: "participation",
    });
  }
  const obj = raw as Readonly<Record<string, unknown>>;
  if (typeof obj.acceptsDirectCampaigns !== "boolean") {
    throw creatorValidationError(
      "participation.acceptsDirectCampaigns must be a boolean",
      { field: "participation.acceptsDirectCampaigns" },
    );
  }
  if (typeof obj.requiresInvitation !== "boolean") {
    throw creatorValidationError(
      "participation.requiresInvitation must be a boolean",
      { field: "participation.requiresInvitation" },
    );
  }
  return Object.freeze({
    acceptsDirectCampaigns: obj.acceptsDirectCampaigns,
    requiresInvitation: obj.requiresInvitation,
  });
}

/**
 * Validate + normalize the reputation references (work order §3.4;
 * CRE-005 / AC-04). PURE part: shape + closed roles + frozen
 * dimensions + the structural separation rule (EXACTLY ONE
 * reference per role — both roles required, never conflated). The
 * canonical-authority VERIFICATION (existence + scope + subject +
 * digest) runs separately against the neutral lookup so this stays a
 * pure function.
 */
function validateReputationReferences(
  raw: unknown,
): readonly CreatorReputationReference[] {
  if (!Array.isArray(raw)) {
    throw creatorValidationError(
      "reputationReferences must be an array",
      { field: "reputationReferences" },
    );
  }
  const byRole = new Map<string, CreatorReputationReference>();
  for (let i = 0; i < raw.length; i += 1) {
    const field = `reputationReferences[${String(i)}]`;
    const entry = raw[i];
    if (entry === null || typeof entry !== "object") {
      throw creatorValidationError(`${field} must be an object`, { field });
    }
    const obj = entry as Readonly<Record<string, unknown>>;
    // STRICT shape: a reference is EXACTLY {role, dimension,
    // snapshotId, digest} — any other key (a smuggled score, a
    // computed trust value, provider state) is rejected fail-closed.
    const allowedKeys = ["role", "dimension", "snapshotId", "digest"];
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.includes(key)) {
        throw creatorValidationError(
          `${field}.${key} is not a permitted reputation-reference field — references are exactly {role, dimension, snapshotId, digest}`,
          { field: `${field}.${key}` },
        );
      }
    }
    const role = requireCreatorString(`${field}.role`, obj.role);
    if (!isCreatorReputationRole(role)) {
      throw creatorValidationError(
        `${field}.role must be one of the closed creator reputation roles (audience_influence | production)`,
        { field: `${field}.role`, role },
      );
    }
    if (byRole.has(role)) {
      throw creatorValidationError(
        `${field}.role ${role} appears more than once — CRE-005 carries audience influence and production reputation as SEPARATE single references`,
        { field, role },
      );
    }
    const dimension = validateCreatorReputationDimension(
      `${field}.dimension`,
      String(obj.dimension),
    );
    const snapshotId = requireCreatorString(
      `${field}.snapshotId`,
      obj.snapshotId,
    );
    const digest = requireCreatorString(`${field}.digest`, obj.digest);
    const reference = Object.freeze({
      role,
      dimension,
      snapshotId,
      digest,
    });
    byRole.set(role, reference);
  }
  for (const role of ["audience_influence", "production"] as const) {
    if (!byRole.has(role)) {
      throw creatorValidationError(
        `reputationReferences is missing the required ${role} reference — a creator profile carries BOTH canonical reputation roles (CRE-005)`,
        { field: "reputationReferences", role },
      );
    }
  }
  return Object.freeze([...byRole.values()]);
}

/**
 * Validate ALL sections (work order §3.2–§3.3): shapes, closed
 * vocabularies, bounded values — and the privacy/secret boundary
 * (the credential-shaped and raw-audience-shaped key guards run over
 * EVERY section input, at ANY nesting depth, fail-closed).
 */
function validateSections(
  raw: Readonly<Record<string, unknown>>,
): CreatorProfileSections {
  // §3.3 — the privacy/secret boundary FIRST: no credential-shaped
  // or raw-audience-shaped key survives validation, in any section,
  // at any depth.
  assertNoCredentialShapedKeys(raw, "sections");
  assertNoRawAudienceKeys(raw, "sections");
  return Object.freeze({
    platforms: validatePlatforms(raw.platforms),
    audience: validateAudience(raw.audience),
    commercial: validateCommercial(raw.commercial),
    rights: validateRights(raw.rights),
    restrictions: validateRestrictions(raw.restrictions),
    availability: validateAvailability(raw.availability),
    participation: validateParticipation(raw.participation),
    reputationReferences: validateReputationReferences(
      raw.reputationReferences,
    ),
  });
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function createCreatorService(deps: CreatorServiceDeps): CreatorService {
  const { repository, versionRepository, lookups, idempotency, auditWriter } =
    deps;
  const logger = deps.logger;

  async function loadProfile(
    organizationScopeId: string | undefined,
    profileId: string,
  ): Promise<CreatorProfileRecord> {
    const profile = await repository.findById(profileId);
    if (!profile) {
      throw new NotFoundError(`creator profile not found: ${profileId}`, {
        profileId,
      });
    }
    if (organizationScopeId !== undefined) {
      if (profile.organizationScopeId !== organizationScopeId) {
        throw new NotFoundError(`creator profile not found: ${profileId}`, {
          profileId,
          organizationScopeId,
        });
      }
    }
    return profile;
  }

  async function verifyReputationReferences(
    organizationScopeId: string,
    creatorPersonId: string,
    references: readonly CreatorReputationReference[],
  ): Promise<void> {
    for (const reference of references) {
      const snapshot = await lookups.reputation.resolve(
        reference.snapshotId,
      );
      if (!snapshot) {
        throw creatorValidationError(
          `reputation reference (role ${reference.role}) does not resolve in the canonical reputation authority: snapshot ${reference.snapshotId}`,
          {
            role: reference.role,
            snapshotId: reference.snapshotId,
          },
        );
      }
      if (snapshot.organizationScopeId !== organizationScopeId) {
        throw creatorValidationError(
          `reputation reference (role ${reference.role}) resolves to a snapshot in organization scope ${snapshot.organizationScopeId}, not ${organizationScopeId}`,
          {
            role: reference.role,
            snapshotId: reference.snapshotId,
            snapshotScope: snapshot.organizationScopeId,
            profileScope: organizationScopeId,
          },
        );
      }
      if (snapshot.subjectPersonId !== creatorPersonId) {
        throw creatorValidationError(
          `reputation reference (role ${reference.role}) resolves to a snapshot for subject person ${snapshot.subjectPersonId}, not the profile's anchor person ${creatorPersonId}`,
          {
            role: reference.role,
            snapshotId: reference.snapshotId,
            snapshotSubject: snapshot.subjectPersonId,
            creatorPersonId,
          },
        );
      }
      if (snapshot.digest !== reference.digest) {
        throw creatorValidationError(
          `reputation reference (role ${reference.role}) digest mismatch: the canonical snapshot ${reference.snapshotId} carries digest ${snapshot.digest}, the reference declares ${reference.digest}`,
          {
            role: reference.role,
            snapshotId: reference.snapshotId,
            canonicalDigest: snapshot.digest,
            declaredDigest: reference.digest,
          },
        );
      }
    }
  }

  async function statusTransition(
    execution: ExecutionContext,
    input: CreatorProfileStatusInput,
    spec: {
      readonly from: readonly string[];
      readonly to: string;
      readonly event: CreatorProfileEventKind;
      readonly auditType: string;
      readonly gate?: (profile: CreatorProfileRecord) => Promise<void>;
    },
  ): Promise<CreatorProfileRecord> {
    assertIdempotencyKey(input.idempotencyKey);
    if (!input.profileId?.trim()) {
      throw creatorValidationError("profileId is required", {
        field: "profileId",
      });
    }
    const actor = actingPersonId(execution);
    const profile = await loadProfile(undefined, input.profileId);
    assertOwner(profile, actor);
    // Replay tolerance: when the record ALREADY sits in the target
    // state the call may be a same-key idempotent REPLAY — let
    // applyIdempotent decide (the committed fast-path replays the
    // cached record; a FRESH key re-runs fn and the in-tx source
    // check rejects the genuinely illegal transition).
    if (!spec.from.includes(profile.status) && profile.status !== spec.to) {
      throw new ConflictError(
        `creator profile ${profile.id} cannot transition ${profile.status} → ${spec.to} (legal source states: ${spec.from.join(", ")})`,
        { profileId: profile.id, status: profile.status, target: spec.to },
      );
    }
    if (spec.gate && spec.from.includes(profile.status)) {
      await spec.gate(profile);
    }

    const key = `creator_profile_${spec.event}:${profile.organizationScopeId}:${input.idempotencyKey}`;
    const applied = await idempotency.withLock(
      profileLockKey(profile.id),
      () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx =
            (await repository.findByIdWithinTx(profile.id, tx)) ?? profile;
          if (!spec.from.includes(inTx.status)) {
            throw new ConflictError(
              `creator profile ${profile.id} cannot transition ${inTx.status} → ${spec.to} (concurrent mutation won)`,
              {
                profileId: profile.id,
                status: inTx.status,
                target: spec.to,
              },
            );
          }
          const event = buildEvent(
            spec.event,
            execution,
            actor,
            input.reason?.trim() || null,
            { from: inTx.status, to: spec.to },
          );
          const updated = withEvent(inTx, event, {
            status: spec.to as CreatorProfileRecord["status"],
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: spec.auditType,
            context: execution,
            actor,
            subject: profile.id,
            resourceType: "creator_profile",
            resourceId: profile.id,
            metadata: {
              organizationScopeId: profile.organizationScopeId,
              profileId: profile.id,
              from: inTx.status,
              to: spec.to,
              reason: input.reason ?? null,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        }, execution),
    );
    logger.info(`creator_profile.${spec.event}`, {
      profileId: applied.result.id,
      status: applied.result.status,
    });
    return applied.result;
  }

  return {
    async createProfile(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw creatorValidationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.displayName?.trim()) {
        throw creatorValidationError("displayName is required", {
          field: "displayName",
        });
      }
      if (input.displayName.trim().length > 200) {
        throw creatorValidationError(
          "displayName must be at most 200 characters",
          { field: "displayName" },
        );
      }
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Self-anchor: a creator profile is always the acting person's
      // OWN profile — no person creates another person's creator
      // profile (a second identity authority can never form).
      if (input.creatorPersonId !== actor) {
        throw new OpenConError({
          code: "CREATOR_FORBIDDEN",
          classification: "authorization",
          message: `creator profiles are self-anchored — person ${actor} cannot create a profile anchored to person ${input.creatorPersonId}`,
          context: {
            actorPersonId: actor,
            creatorPersonId: input.creatorPersonId,
          },
        });
      }
      // The canonical identity authority validates the anchor: the
      // person must EXIST (the neutral lookup; /identity stays the
      // identity authority — no identity is created here).
      if (!(await lookups.person.exists(input.creatorPersonId))) {
        throw creatorValidationError(
          `creator profile anchor person does not exist: ${input.creatorPersonId}`,
          { creatorPersonId: input.creatorPersonId },
        );
      }

      const key = `creator_profile_create:${input.organizationScopeId}:${input.idempotencyKey}`;
      // The UNIQUE-ANCHOR mutex wraps the whole authoritative apply
      // (anchor-mutex → idempotency-key-mutex, never reversed — the
      // same lock-ordering discipline as the policy lineages). Two
      // callers racing with DIFFERENT idempotency keys for the same
      // (organization scope, person) serialize here; the second
      // caller's in-tx anchor re-check then observes the first
      // caller's COMMITTED profile and is rejected — the duplicate
      // is structurally impossible, not snapshot-luck (PR #30
      // review remediation).
      const applied = await idempotency.withLock(
        creatorProfileAnchorLockKey(
          input.organizationScopeId,
          input.creatorPersonId,
        ),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              // The unique-anchor rule, in-transaction: one profile per
              // (organization scope, person). A duplicate anchor is the
              // identity-duplication guard — rejected with ConflictError.
              // (Serialized by the anchor mutex above, so this read
              // observes prior COMMITTED profiles.)
              const existing = await repository.findByPersonWithinTx(
                input.organizationScopeId,
                input.creatorPersonId,
                tx,
              );
              if (existing) {
                throw new ConflictError(
                  `person ${input.creatorPersonId} already holds a creator profile (${existing.id}) in organization scope ${input.organizationScopeId}`,
                  {
                    profileId: existing.id,
                    creatorPersonId: input.creatorPersonId,
                    organizationScopeId: input.organizationScopeId,
                  },
                );
              }
              const now = new Date().toISOString();
              const event = buildEvent(
                "created",
                execution,
                actor,
                null,
                { displayName: input.displayName.trim() },
              );
              const profile: CreatorProfileRecord = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                creatorPersonId: input.creatorPersonId,
                displayName: input.displayName.trim(),
                status: "DRAFT",
                currentVersion: null,
                events: Object.freeze([event]),
                createdAt: now,
                updatedAt: now,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await repository.createWithinTx(profile, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: CREATOR_PROFILE_CREATED,
                context: execution,
                actor,
                subject: profile.id,
                resourceType: "creator_profile",
                resourceId: profile.id,
                metadata: {
                  organizationScopeId: profile.organizationScopeId,
                  creatorPersonId: profile.creatorPersonId,
                  displayName: profile.displayName,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return profile;
            },
            execution,
          ),
      );
      logger.info("creator_profile.created", {
        profileId: applied.result.id,
        created: applied.executed,
      });
      return { profile: applied.result, created: applied.executed };
    },

    async getProfile(execution, organizationScopeId, id) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      // Tenant-scoped ID read: a cross-scope profile id is
      // indistinguishable from a nonexistent one — no existence
      // oracle, no cross-tenant profile data (PR #30 review).
      return loadProfile(organizationScopeId, id);
    },

    async getProfileByPerson(execution, organizationScopeId, creatorPersonId) {
      void execution;
      return repository.findByPerson(organizationScopeId, creatorPersonId);
    },

    async listProfiles(execution, organizationScopeId, statuses) {
      void execution;
      return repository.listByOrganization(organizationScopeId, statuses);
    },

    // ------------------------------------------------------------------
    // Versioned profile sections (work order §3.2; the lineage mutex).
    // ------------------------------------------------------------------
    async defineProfileVersion(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.profileId?.trim()) {
        throw creatorValidationError("profileId is required", {
          field: "profileId",
        });
      }
      const actor = actingPersonId(execution);
      const profile = await loadProfile(undefined, input.profileId);
      assertOwner(profile, actor);
      if (profile.status === "ARCHIVED") {
        throw new ConflictError(
          `creator profile ${profile.id} is terminal (ARCHIVED) — profile versions can no longer be defined`,
          { profileId: profile.id, status: profile.status },
        );
      }
      const sections = validateSections(
        input.sections as unknown as Readonly<Record<string, unknown>>,
      );
      // §3.4 — canonical-authority verification: EVERY reference
      // resolves in /reputation, same scope, same subject person,
      // digest intact (BEFORE the version commits).
      await verifyReputationReferences(
        profile.organizationScopeId,
        profile.creatorPersonId,
        sections.reputationReferences,
      );

      const key = `creator_profile_version:${profile.organizationScopeId}:${input.idempotencyKey}`;
      // The org-INDEPENDENT lineage mutex: serializes version
      // creation for this profile so version = latest+1 can never
      // fork (the NET-W007/008/010/011 pattern). Held through the
      // commit, so the in-tx latest read observes prior commits.
      const applied = await idempotency.withLock(
        profileVersionLineageLockKey(profile.id),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const latest = await versionRepository.findLatestWithinTx(
              profile.id,
              tx,
            );
            const version = latest === null ? 1 : latest.version + 1;
            const profileVersion: CreatorProfileVersion = Object.freeze({
              id: randomUUID(),
              profileId: profile.id,
              version,
              organizationScopeId: profile.organizationScopeId,
              sections,
              createdBy: actor,
              createdAt: new Date().toISOString(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await versionRepository.createWithinTx(profileVersion, tx);
            // The current-version pointer flips in the SAME
            // transaction (the append-only event history records
            // the definition).
            const inTx =
              (await repository.findByIdWithinTx(profile.id, tx)) ?? profile;
            const event = buildEvent(
              "profile_version_defined",
              execution,
              actor,
              null,
              {
                version,
                versionRecordId: profileVersion.id,
                reputationReferences: sections.reputationReferences.map(
                  (reference) => ({
                    role: reference.role,
                    snapshotId: reference.snapshotId,
                    dimension: reference.dimension,
                  }),
                ),
              },
            );
            const updated = withEvent(inTx, event, {
              currentVersion: version,
            });
            await repository.saveWithinTx(updated, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: CREATOR_PROFILE_VERSION_DEFINED,
              context: execution,
              actor,
              subject: profile.id,
              resourceType: "creator_profile",
              resourceId: profile.id,
              metadata: {
                organizationScopeId: profile.organizationScopeId,
                profileId: profile.id,
                version,
                versionRecordId: profileVersion.id,
                reputationReferences: sections.reputationReferences.map(
                  (reference) => ({
                    role: reference.role,
                    snapshotId: reference.snapshotId,
                    dimension: reference.dimension,
                  }),
                ),
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return profileVersion;
          }, execution),
      );
      logger.info("creator_profile.version_defined", {
        profileId: applied.result.profileId,
        version: applied.result.version,
        created: applied.executed,
      });
      return { version: applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // The administrative status machine (owner-only; the campaign
    // record precedent).
    // ------------------------------------------------------------------
    async activateProfile(execution, input) {
      return statusTransition(execution, input, {
        from: ["DRAFT", "PAUSED"],
        to: "ACTIVE",
        event: "activated",
        auditType: CREATOR_PROFILE_ACTIVATED,
        gate: async (profile) => {
          // A profile cannot activate without ANY version: the
          // declared sections are the profile's substance (the
          // CAMP-002 defined-before-activation precedent).
          if (profile.currentVersion === null) {
            throw creatorValidationError(
              `creator profile ${profile.id} cannot activate: no profile version is defined (the platform/audience/commercial sections must be defined before activation)`,
              { profileId: profile.id },
            );
          }
          const current = await versionRepository.findVersion(
            profile.id,
            profile.currentVersion,
          );
          if (current === null) {
            throw creatorValidationError(
              `creator profile ${profile.id} cannot activate: the current version pointer (${String(profile.currentVersion)}) does not resolve`,
              { profileId: profile.id, currentVersion: profile.currentVersion },
            );
          }
        },
      });
    },

    async pauseProfile(execution, input) {
      return statusTransition(execution, input, {
        from: ["ACTIVE"],
        to: "PAUSED",
        event: "paused",
        auditType: CREATOR_PROFILE_PAUSED,
      });
    },

    async resumeProfile(execution, input) {
      return statusTransition(execution, input, {
        from: ["PAUSED"],
        to: "ACTIVE",
        event: "resumed",
        auditType: CREATOR_PROFILE_RESUMED,
      });
    },

    async archiveProfile(execution, input) {
      return statusTransition(execution, input, {
        from: ["DRAFT", "ACTIVE", "PAUSED"],
        to: "ARCHIVED",
        event: "archived",
        auditType: CREATOR_PROFILE_ARCHIVED,
      });
    },

    // ------------------------------------------------------------------
    // Reads (committed reads through the repositories — every read
    // is tenant-scoped; a cross-scope id is indistinguishable from
    // an absent one).
    // ------------------------------------------------------------------
    async getProfileVersion(
      execution,
      organizationScopeId,
      profileId,
      version,
    ) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const record = await versionRepository.findVersion(profileId, version);
      if (!record || record.organizationScopeId !== organizationScopeId) {
        // Cross-scope version reads are indistinguishable from
        // absent ones (the version carries its profile's scope).
        throw new NotFoundError(
          `creator profile version not found: ${profileId} v${String(version)}`,
          { profileId, version },
        );
      }
      return record;
    },

    async listProfileVersions(execution, organizationScopeId, profileId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      // Tenant-scoped enumeration: the profile must resolve IN the
      // caller's organization scope first — a foreign scope cannot
      // even learn that a version lineage exists.
      await loadProfile(organizationScopeId, profileId);
      const versions = await versionRepository.listByProfile(profileId);
      // Defense in depth: a version's scope is copied from its
      // profile at commit, so only this scope's versions can return.
      return versions.filter(
        (v) => v.organizationScopeId === organizationScopeId,
      );
    },
  };
}
