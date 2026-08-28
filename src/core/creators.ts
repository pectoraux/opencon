/**
 * Shared creator vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/creators` owns creator domain rules — creator identity anchors,
 * platform references, audience metadata, commercial preferences,
 * rights, restrictions, availability), §13 (Provider neutrality);
 * spec/architecture-lock.md §2 (the sixteen frozen core domains —
 * `/creators` is the Phase-4 Creator boundary), §14 (provider
 * neutrality — provider-specific semantics live OUTSIDE the domain).
 *
 * Work order ref: spec/work-orders/NET-W015.md
 *   §3.1 First-class durable creator profile records (organization
 *        scope + canonical person anchor, unique per person per org).
 *   §3.2 Versioned profile sections (platforms, audience, commercial
 *        preferences, rights, restrictions, availability,
 *        participation rules, reputation references) — CRE-001.
 *   §3.3 The privacy/secret boundary (credential-shaped and
 *        raw-audience-shaped key guards, aggregate-only audience).
 *   §3.4 Reputation references (CRE-005 — audience influence and
 *        production reputation carried as SEPARATE canonical
 *        references).
 *
 * Requirements: CRE-001 (creators define platform, audience, topic,
 * language, format, rates, rights and restrictions), CRE-005
 * (separate audience influence from production reputation).
 *
 * THE KEY RULES (work order §2 — authority separation):
 *  - `/identity` remains the person identity authority: the creator
 *    vocabulary carries person REFERENCES only — no identity fields;
 *  - `/reputation` remains the trust-signal authority: the creator
 *    vocabulary carries snapshot REFERENCES only — no scores, no
 *    scoring parameters, no derived trust values;
 *  - `/settlement` remains the economic authority: commercial rates
 *    are DECLARED preferences validated with the shared economic
 *    amount bounds — they are never economic state, and this module
 *    introduces no economic-unit mutation;
 *  - provider-specific platform semantics stay OUTSIDE the creator
 *    domain (AC-06): every vocabulary here is closed and
 *    provider-neutral, and the credential-shaped key guard makes
 *    credential material structurally unable to enter creator
 *    records.
 *
 * This module is data + pure validation ONLY — no I/O, no wall
 * clock reads inside pure helpers, no lifecycle behaviour (the
 * status machine validation lives in the creator service).
 */

import { OpenConError } from "./errors.ts";
import {
  ECONOMIC_DECIMALS,
  ECONOMIC_MAX_AMOUNT,
  ECONOMIC_SCALE,
} from "./economics.ts";
import { isReputationDimension, type ReputationDimension } from "./reputation.ts";

/**
 * The creator profile record's own administrative status machine
 * (work order §3.1 — the campaign-record precedent: this is the
 * RECORD's status, NOT a workflow lifecycle; opportunity/contribution
 * lifecycle states stay with /workflows).
 *
 * ```text
 * DRAFT ──activate──→ ACTIVE ⇄ pause/resume ⇄ PAUSED
 *   │                    │
 *   └── archive ────────┴── archive ──→ ARCHIVED (terminal)
 * ```
 */
export const CREATOR_PROFILE_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
] as const;

export type CreatorProfileStatus = (typeof CREATOR_PROFILE_STATUSES)[number];

export function isCreatorProfileStatus(
  value: string,
): value is CreatorProfileStatus {
  return (CREATOR_PROFILE_STATUSES as readonly string[]).includes(value);
}

/**
 * Connected-platform kinds — the CLOSED, provider-neutral platform
 * taxonomy (AC-06). A platform connection is a REFERENCE to an
 * external presence; the concrete provider (e.g. a specific social
 * network) is identified only through the free-form handle + profile
 * URL on the connection record, NEVER through a provider-client type,
 * token or connection state.
 */
export const CREATOR_PLATFORM_KINDS = [
  "social",
  "video",
  "audio",
  "written",
  "community",
] as const;

export type CreatorPlatformKind = (typeof CREATOR_PLATFORM_KINDS)[number];

export function isCreatorPlatformKind(
  value: string,
): value is CreatorPlatformKind {
  return (CREATOR_PLATFORM_KINDS as readonly string[]).includes(value);
}

/**
 * Content formats a creator can produce or a platform connection can
 * carry as a capability (CRE-001 "format"). Closed and
 * provider-neutral: a short-form vertical video is `short_video`
 * regardless of which provider hosts it.
 */
export const CREATOR_CONTENT_FORMATS = [
  "post",
  "short_video",
  "long_video",
  "audio_episode",
  "article",
  "newsletter",
  "live_stream",
  "image_set",
] as const;

export type CreatorContentFormat = (typeof CREATOR_CONTENT_FORMATS)[number];

export function isCreatorContentFormat(
  value: string,
): value is CreatorContentFormat {
  return (CREATOR_CONTENT_FORMATS as readonly string[]).includes(value);
}

/**
 * Audience size bands — the privacy-minimized representation of
 * audience scale (work order §3.2/§3.3): a BAND, never an exact
 * count, never a member list.
 */
export const CREATOR_AUDIENCE_SIZE_BANDS = [
  "lt_1k",
  "1k_10k",
  "10k_100k",
  "100k_1m",
  "1m_10m",
  "gt_10m",
] as const;

export type CreatorAudienceSizeBand =
  (typeof CREATOR_AUDIENCE_SIZE_BANDS)[number];

export function isCreatorAudienceSizeBand(
  value: string,
): value is CreatorAudienceSizeBand {
  return (CREATOR_AUDIENCE_SIZE_BANDS as readonly string[]).includes(value);
}

/** Audience engagement bands (aggregate, qualitative). */
export const CREATOR_ENGAGEMENT_BANDS = [
  "low",
  "medium",
  "high",
  "very_high",
] as const;

export type CreatorEngagementBand = (typeof CREATOR_ENGAGEMENT_BANDS)[number];

export function isCreatorEngagementBand(
  value: string,
): value is CreatorEngagementBand {
  return (CREATOR_ENGAGEMENT_BANDS as readonly string[]).includes(value);
}

/**
 * Audience age bands for the aggregate age distribution (closed
 * bands; shares are percentages 0–100).
 */
export const CREATOR_AUDIENCE_AGE_BANDS = [
  "13_17",
  "18_24",
  "25_34",
  "35_44",
  "45_54",
  "55_64",
  "65_plus",
] as const;

export type CreatorAudienceAgeBand =
  (typeof CREATOR_AUDIENCE_AGE_BANDS)[number];

export function isCreatorAudienceAgeBand(
  value: string,
): value is CreatorAudienceAgeBand {
  return (CREATOR_AUDIENCE_AGE_BANDS as readonly string[]).includes(value);
}

/** The maximum number of top-geography entries an aggregate may carry. */
export const CREATOR_MAX_TOP_GEOGRAPHIES = 5;

/**
 * Rate units for declared commercial rate cards (CRE-001 "rates").
 * A rate is DECLARED PREFERENCE (`amount` validated with the shared
 * economic bounds) — never an economic commitment, posting or
 * balance.
 */
export const CREATOR_RATE_UNITS = [
  "per_deliverable",
  "per_hour",
  "per_campaign",
] as const;

export type CreatorRateUnit = (typeof CREATOR_RATE_UNITS)[number];

export function isCreatorRateUnit(
  value: string,
): value is CreatorRateUnit {
  return (CREATOR_RATE_UNITS as readonly string[]).includes(value);
}

/**
 * Rights kinds a creator is willing to GRANT (CRE-001 "rights").
 * DECLARED willingness only — rights EXECUTION (licensing,
 * takedown, transfer) is NET-W017.
 */
export const CREATOR_RIGHTS_KINDS = [
  "channel_publication",
  "paid_amplification",
  "reuse_license",
  "exclusivity_window",
  "derivative_works",
] as const;

export type CreatorRightsKind = (typeof CREATOR_RIGHTS_KINDS)[number];

export function isCreatorRightsKind(
  value: string,
): value is CreatorRightsKind {
  return (CREATOR_RIGHTS_KINDS as readonly string[]).includes(value);
}

/**
 * The two creator reputation reference roles (CRE-005: separate
 * audience influence from production reputation). Each role is
 * carried by its OWN canonical `/reputation` snapshot reference —
 * the separation lives in the DATA SHAPE so downstream consumers
 * (NET-W016 matching) can never conflate the two signals.
 */
export const CREATOR_REPUTATION_ROLES = [
  "audience_influence",
  "production",
] as const;

export type CreatorReputationRole = (typeof CREATOR_REPUTATION_ROLES)[number];

export function isCreatorReputationRole(
  value: string,
): value is CreatorReputationRole {
  return (CREATOR_REPUTATION_ROLES as readonly string[]).includes(value);
}

/**
 * The credential-shaped key fragment set (work order §3.3). ANY key
 * matching one of these fragments — at ANY nesting depth of ANY
 * creator section input — is rejected by
 * {@link assertNoCredentialShapedKeys}: credentials and platform
 * auth material never enter creator records (issue invariant 6).
 * The fragment set deliberately mirrors the participants
 * authorization-service redaction set plus platform-auth shapes
 * (access/refresh keys).
 */
export const CREDENTIAL_KEY_FRAGMENTS = [
  "password",
  "token",
  "secret",
  "api-key",
  "apikey",
  "private-key",
  "privatekey",
  "credential",
  "access-key",
  "accesskey",
  "refresh",
  "auth",
] as const;

const CREDENTIAL_KEY_RE = new RegExp(
  CREDENTIAL_KEY_FRAGMENTS.map((f) => f.replace(/[-]/g, "[-_]?")).join("|"),
  "i",
);

/**
 * The raw-audience-shaped key fragment set (work order §3.3). ANY
 * key matching one of these fragments — at ANY nesting depth — is
 * rejected by {@link assertNoRawAudienceKeys}: audience metadata is
 * aggregate/qualified attributes ONLY; individual audience records
 * (members, emails, contacts, device ids, …) can never enter creator
 * records (issue invariant 3).
 */
export const RAW_AUDIENCE_KEY_FRAGMENTS = [
  "member",
  "individual",
  "person",
  "user",
  "email",
  "address",
  "contact",
  "device-id",
  "deviceid",
  "ip-address",
  "ipaddress",
  "raw-record",
  "rawrecord",
  "audience-record",
  "audiencerecord",
] as const;

const RAW_AUDIENCE_KEY_RE = new RegExp(
  RAW_AUDIENCE_KEY_FRAGMENTS.map((f) => f.replace(/[-]/g, "[-_]?")).join("|"),
  "i",
);

/** Validation error for creator vocabulary/shape violations. */
export class InvalidCreatorProfileError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "CREATOR_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Deep-scan a section input for credential-shaped keys. Throws
 * {@link InvalidCreatorProfileError} naming the offending path —
 * fail-closed, applied to EVERY creator section input so credential
 * material has no path into creator records (invariant 6 / AC-03).
 */
export function assertNoCredentialShapedKeys(
  value: unknown,
  path = "section",
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoCredentialShapedKeys(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Readonly<Record<string, unknown>>,
    )) {
      if (CREDENTIAL_KEY_RE.test(key)) {
        throw new InvalidCreatorProfileError(
          `credential-shaped field "${key}" is not permitted in creator records (at ${path}) — credentials stay behind the secret/adapter boundaries`,
          { field: key, path },
        );
      }
      assertNoCredentialShapedKeys(child, `${path}.${key}`);
    }
  }
}

/**
 * Deep-scan a section input for raw-audience-shaped keys. Throws
 * {@link InvalidCreatorProfileError} naming the offending path —
 * fail-closed, applied to the audience section (and defensively to
 * every section) so individual audience data has no path into
 * creator records (invariant 3 / AC-03).
 */
export function assertNoRawAudienceKeys(
  value: unknown,
  path = "section",
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoRawAudienceKeys(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Readonly<Record<string, unknown>>,
    )) {
      if (RAW_AUDIENCE_KEY_RE.test(key)) {
        throw new InvalidCreatorProfileError(
          `raw-audience-shaped field "${key}" is not permitted in creator records (at ${path}) — audience metadata is aggregate/qualified attributes only`,
          { field: key, path },
        );
      }
      assertNoRawAudienceKeys(child, `${path}.${key}`);
    }
  }
}

/**
 * Validate a declared commercial rate amount: finite number > 0
 * (a rate of zero is not a rate — use `negotiable` instead), at most
 * {@link ECONOMIC_DECIMALS} decimals, not larger than
 * {@link ECONOMIC_MAX_AMOUNT}. Mirrors the shared economic amount
 * validator (the campaign-budget declaration precedent) while
 * creating NO economic state.
 */
export function validateCreatorRateAmount(
  field: string,
  amount: number,
): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new InvalidCreatorProfileError(
      `${field} must be a finite number (got ${String(amount)})`,
      { field, amount },
    );
  }
  if (amount <= 0) {
    throw new InvalidCreatorProfileError(
      `${field} must be > 0 (got ${String(amount)}) — declared rates are positive preferences; negotiability is a separate flag`,
      { field, amount },
    );
  }
  if (amount > ECONOMIC_MAX_AMOUNT) {
    throw new InvalidCreatorProfileError(
      `${field} exceeds the maximum representable amount ${String(ECONOMIC_MAX_AMOUNT)} (got ${String(amount)})`,
      { field, amount },
    );
  }
  const minor = Math.round(amount * ECONOMIC_SCALE);
  if (Math.abs(minor / ECONOMIC_SCALE - amount) > Number.EPSILON) {
    throw new InvalidCreatorProfileError(
      `${field} must have at most ${ECONOMIC_DECIMALS} decimals (got ${String(amount)})`,
      { field, amount },
    );
  }
  return amount;
}

/**
 * Validate an aggregate audience share (a percentage): finite
 * number, 0 ≤ share ≤ 100.
 */
export function validateCreatorAudienceShare(
  field: string,
  share: number,
): number {
  if (typeof share !== "number" || !Number.isFinite(share)) {
    throw new InvalidCreatorProfileError(
      `${field} must be a finite number (got ${String(share)})`,
      { field, share },
    );
  }
  if (share < 0 || share > 100) {
    throw new InvalidCreatorProfileError(
      `${field} must be a share between 0 and 100 (got ${String(share)})`,
      { field, share },
    );
  }
  return share;
}

const LANGUAGE_TAG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Validate a language tag: lowercase primary subtag (2–3 letters)
 * optionally followed by subtags (CRE-001 "language").
 */
export function validateCreatorLanguageTag(
  field: string,
  tag: string,
): string {
  if (!LANGUAGE_TAG_RE.test(tag)) {
    throw new InvalidCreatorProfileError(
      `${field} must be a language tag like "en" or "pt-BR" (got ${String(tag)})`,
      { field, tag },
    );
  }
  return tag;
}

const TERRITORY_RE = /^[A-Z]{2}$/;

/**
 * Validate an ISO 3166-1 alpha-2 territory code (uppercase).
 */
export function validateCreatorTerritoryCode(
  field: string,
  code: string,
): string {
  if (!TERRITORY_RE.test(code)) {
    throw new InvalidCreatorProfileError(
      `${field} must be an ISO 3166-1 alpha-2 territory code like "GH" (got ${String(code)})`,
      { field, code },
    );
  }
  return code;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate an ISO 4217-style currency code (3 uppercase letters).
 */
export function validateCreatorCurrencyCode(
  field: string,
  code: string,
): string {
  if (!CURRENCY_RE.test(code)) {
    throw new InvalidCreatorProfileError(
      `${field} must be a 3-letter currency code like "USD" (got ${String(code)})`,
      { field, code },
    );
  }
  return code;
}

/**
 * Validate that a reputation-reference dimension is one of the
 * FROZEN canonical reputation dimensions (the creators domain never
 * defines its own trust dimensions — it references /reputation's).
 */
export function validateCreatorReputationDimension(
  field: string,
  dimension: string,
): ReputationDimension {
  if (!isReputationDimension(dimension)) {
    throw new InvalidCreatorProfileError(
      `${field} must be one of the frozen canonical reputation dimensions (got ${String(dimension)})`,
      { field, dimension },
    );
  }
  return dimension;
}

/**
 * A required-string helper (non-empty after trimming).
 */
export function requireCreatorString(
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidCreatorProfileError(
      `${field} is required (non-empty string)`,
      { field },
    );
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// NET-W016 — creator matching vocabulary (matching is SELECTION, not
// authority; every constant here is data + pure validation only)
// ---------------------------------------------------------------------------

/**
 * The six explicit CRE-002 matching signals. Ranking is BY these
 * signals with explicit weights — the advisory AI path may only
 * blend (bounded) into `relevance` and can never flip eligibility.
 */
export const CREATOR_MATCH_SIGNALS = [
  "relevance",
  "audience_quality",
  "historic_outcomes",
  "safety",
  "price",
  "availability",
] as const;

export type CreatorMatchSignal = (typeof CREATOR_MATCH_SIGNALS)[number];

export function isCreatorMatchSignal(
  value: string,
): value is CreatorMatchSignal {
  return (CREATOR_MATCH_SIGNALS as readonly string[]).includes(value);
}

/**
 * The closed hard-gate reason vocabulary (NET-W016 §3.1). An
 * ineligible candidate carries one or more of these reasons — the
 * complete, machine-readable explanation. Hard restrictions can
 * NEVER be overridden by model ranking (structural).
 */
export const CREATOR_MATCH_GATE_REASONS = [
  "no_profile_version",
  "profile_not_active",
  "not_accepting_work",
  "no_capacity",
  "notice_window_exceeded",
  "direct_campaigns_not_accepted",
  "invitation_required",
  "format_unsupported",
  "format_restricted",
  "language_unsupported",
  "territory_unsupported",
  "territory_restricted",
  "topic_restricted",
  "rights_not_granted",
  "rate_exceeds_ceiling",
  "audience_band_below_minimum",
  "reputation_reference_unresolvable",
  "reputation_below_minimum",
  "active_risk_control",
] as const;

export type CreatorMatchGateReason =
  (typeof CREATOR_MATCH_GATE_REASONS)[number];

export function isCreatorMatchGateReason(
  value: string,
): value is CreatorMatchGateReason {
  return (CREATOR_MATCH_GATE_REASONS as readonly string[]).includes(value);
}

/**
 * The frozen matching-run format lineage (the campaign-policy
 * format precedent): pinned on every match-run record so the
 * contract shape stays reproducible.
 */
export const CREATOR_MATCH_FORMAT = "NET-W016:1" as const;

/** Match weights are integers 0–100 summing to EXACTLY this. */
export const CREATOR_MATCH_WEIGHT_SUM = 100;

/**
 * The maximum advisory blend into the relevance signal
 * (advisoryMaxWeight/100 ≤ 0.25 — AI is advisory, never the
 * eligibility authority, and never dominant in ranking).
 */
export const CREATOR_MATCH_ADVISORY_MAX_BLEND = 0.25;

/** The maximum number of candidates a single match run may rank. */
export const CREATOR_MATCH_MAX_CANDIDATES = 200;

/**
 * Ordinal rank of an audience size band (lt_1k = 0 … gt_10m = 5) —
 * the privacy-preserving scale order used by the audience-band hard
 * gate (a BAND comparison, never an exact-count comparison).
 */
export function creatorAudienceSizeBandRank(
  band: CreatorAudienceSizeBand,
): number {
  const rank = CREATOR_AUDIENCE_SIZE_BANDS.indexOf(band);
  if (rank < 0) {
    throw new InvalidCreatorProfileError(
      `unknown audience size band: ${String(band)}`,
      { band },
    );
  }
  return rank;
}

/** Ordinal rank of an engagement band (low = 0 … very_high = 3). */
export function creatorEngagementBandRank(
  band: CreatorEngagementBand,
): number {
  const rank = CREATOR_ENGAGEMENT_BANDS.indexOf(band);
  if (rank < 0) {
    throw new InvalidCreatorProfileError(
      `unknown engagement band: ${String(band)}`,
      { band },
    );
  }
  return rank;
}

/** Validation error for matching-request violations (NET-W016). */
export class InvalidCreatorMatchError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "CREATOR_MATCH_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * The canonical default weight profile (integers, sum = 100):
 * relevance 30, audienceQuality 20, historicOutcomes 20, safety 10,
 * price 10, availability 10. Explicit weights may override it but
 * must satisfy the same constraints.
 */
export const CREATOR_MATCH_DEFAULT_WEIGHTS = Object.freeze({
  relevance: 30,
  audienceQuality: 20,
  historicOutcomes: 20,
  safety: 10,
  price: 10,
  availability: 10,
} as const);

export interface CreatorMatchWeightsShape {
  readonly relevance: number;
  readonly audienceQuality: number;
  readonly historicOutcomes: number;
  readonly safety: number;
  readonly price: number;
  readonly availability: number;
}

/**
 * Validate a weight profile: six integers 0–100 (inclusive), each
 * signal present, summing to EXACTLY {@link CREATOR_MATCH_WEIGHT_SUM}.
 * Ranking is by explicit signals — the weights are part of the
 * reproducible decision record.
 */
export function validateCreatorMatchWeights(
  weights: CreatorMatchWeightsShape,
): CreatorMatchWeightsShape {
  const entries: readonly (readonly [keyof CreatorMatchWeightsShape, number])[] =
    [
      ["relevance", weights.relevance],
      ["audienceQuality", weights.audienceQuality],
      ["historicOutcomes", weights.historicOutcomes],
      ["safety", weights.safety],
      ["price", weights.price],
      ["availability", weights.availability],
    ];
  let sum = 0;
  for (const [field, value] of entries) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new InvalidCreatorMatchError(
        `weights.${field} must be an integer between 0 and 100 (got ${String(value)})`,
        { field, value },
      );
    }
    sum += value;
  }
  if (sum !== CREATOR_MATCH_WEIGHT_SUM) {
    throw new InvalidCreatorMatchError(
      `match weights must sum to exactly ${String(CREATOR_MATCH_WEIGHT_SUM)} (got ${String(sum)})`,
      { sum },
    );
  }
  return weights;
}

/**
 * Validate the advisory blend bound: 0 ≤ maxWeight ≤
 * CREATOR_MATCH_ADVISORY_MAX_BLEND × 100. The advisory is advisory —
 * its influence on ranking is structurally capped.
 */
export function validateCreatorMatchAdvisoryMaxWeight(
  maxWeight: number,
): number {
  const bound = CREATOR_MATCH_ADVISORY_MAX_BLEND * 100;
  if (
    typeof maxWeight !== "number" ||
    !Number.isFinite(maxWeight) ||
    maxWeight < 0 ||
    maxWeight > bound
  ) {
    throw new InvalidCreatorMatchError(
      `advisory maxWeight must be between 0 and ${String(bound)} (got ${String(maxWeight)}) — AI-assisted matching is bounded, never the ranking authority`,
      { maxWeight, bound },
    );
  }
  return maxWeight;
}

/**
 * Validate a reputation threshold (a minimum canonical score, 0–100).
 */
export function validateCreatorMatchReputationThreshold(
  field: string,
  threshold: number,
): number {
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 100
  ) {
    throw new InvalidCreatorMatchError(
      `${field} must be a number between 0 and 100 (got ${String(threshold)})`,
      { field, threshold },
    );
  }
  return threshold;
}

// ---------------------------------------------------------------------------
// NET-W017 — UGC workflow and rights (engagement / acceptance /
// usage rights / production). Pure vocabulary + validators ONLY; the
// lifecycle authority stays in /workflows (the engagement is a new
// canonical lifecycle subject kind) and NO domain-local status
// machinery is introduced here.
// ---------------------------------------------------------------------------

/**
 * The closed channel vocabulary a usage-rights grant may scope to
 * (work order §3.3). Provider-neutral — no platform names:
 *  - `creator_owned_channel`  — the creator's own channels
 *    (publication there REQUIRES an explicit grant — producing UGC
 *    never confers it);
 *  - `organizer_channel`      — the campaign organizer's own
 *    channels/surfaces;
 *  - `network_channel`        — protocol network surfaces;
 *  - `paid_media`             — paid amplification placements.
 */
export const USAGE_RIGHTS_CHANNELS = [
  "creator_owned_channel",
  "organizer_channel",
  "network_channel",
  "paid_media",
] as const;

export type UsageRightsChannel = (typeof USAGE_RIGHTS_CHANNELS)[number];

export function isUsageRightsChannel(
  value: string,
): value is UsageRightsChannel {
  return (USAGE_RIGHTS_CHANNELS as readonly string[]).includes(value);
}

/**
 * The frozen ownership vocabulary (work order §3.3, invariant 4 —
 * CRE-004): the protocol NEVER takes ownership of creator content or
 * channels merely because UGC is produced through it. Exactly one
 * value exists and ever will — the grant input carries NO ownership
 * field, so there is structurally no code path that transfers
 * ownership.
 */
export const USAGE_RIGHTS_OWNERSHIP = ["creator_retained"] as const;

export type UsageRightsOwnership = (typeof USAGE_RIGHTS_OWNERSHIP)[number];

/**
 * The DERIVED effective-status vocabulary of a usage-rights grant.
 * The status is a pure function over immutable records (grant +
 * optional revocation + the evaluation instant) — it is NEVER a
 * stored/mutated field, so there is no local status machine:
 *  - `REVOKED` — a revocation exists and asOf ≥ its effectiveAt;
 *  - `EXPIRED` — asOf is past the grant's endsAt;
 *  - `ACTIVE`  — otherwise.
 */
export const USAGE_RIGHTS_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
] as const;

export type UsageRightsEffectiveStatus =
  (typeof USAGE_RIGHTS_EFFECTIVE_STATUSES)[number];

export function isUsageRightsEffectiveStatus(
  value: string,
): value is UsageRightsEffectiveStatus {
  return (USAGE_RIGHTS_EFFECTIVE_STATUSES as readonly string[]).includes(
    value,
  );
}

/**
 * The frozen engagement-record format lineage (the match-run
 * precedent): pinned on every engagement-domain record so the
 * contract shape stays reproducible.
 */
export const CREATOR_ENGAGEMENT_FORMAT = "NET-W017:1" as const;

/**
 * The closed auto-accept gate-reason vocabulary (work order §3.2).
 * The evaluation is the conjunction of all gates; the trace carries
 * every gate (passed or failed+reason).
 */
export const AUTO_ACCEPT_GATE_REASONS = [
  "policy_not_auto_accept",
  "policy_not_found",
  "profile_not_active",
  "not_accepting_work",
  "too_many_active_engagements",
  "rate_below_floor",
  "rights_not_auto_grantable",
  "grant_duration_exceeds_policy",
  "active_risk_control",
] as const;

export type AutoAcceptGateReason =
  (typeof AUTO_ACCEPT_GATE_REASONS)[number];

export function isAutoAcceptGateReason(
  value: string,
): value is AutoAcceptGateReason {
  return (AUTO_ACCEPT_GATE_REASONS as readonly string[]).includes(value);
}

/** Max requested/granted usage-rights uses per engagement offer. */
export const USAGE_RIGHTS_MAX_USES = 8;

/** Max channels per usage-rights grant. */
export const USAGE_RIGHTS_MAX_CHANNELS = 4;

/** Max territories per usage-rights grant. */
export const USAGE_RIGHTS_MAX_TERRITORIES = 40;

/** Max formats per usage-rights grant. */
export const USAGE_RIGHTS_MAX_FORMATS = 8;

/** Max exclusions per usage-rights grant. */
export const USAGE_RIGHTS_MAX_EXCLUSIONS = 20;

/** Maximum grant duration in days (explicit license window bound). */
export const USAGE_RIGHTS_MAX_DURATION_DAYS = 3650;

/** Maximum declared acceptance-policy floor amount (economic bounds). */
export const ACCEPTANCE_POLICY_MAX_RATE_FLOOR = 1_000_000;

/** Maximum concurrent engagements declared by an acceptance policy. */
export const ACCEPTANCE_POLICY_MAX_ACTIVE_ENGAGEMENTS = 50;

/** Validation error for engagement/production/rights request
 * violations (NET-W017). */
export class InvalidEngagementError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "ENGAGEMENT_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/** Stable conflict when the engagement unique-anchor is taken
 * (a NON-terminal engagement already exists for the (org, campaign,
 * creator) triple — work order §3.1) or a terminal precondition
 * conflicts. */
export class EngagementConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "ENGAGEMENT_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/** Stable conflict on usage-rights state (e.g. a second revocation
 * for the same grant — work order §3.3). */
export class UsageRightsConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "USAGE_RIGHTS_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * Validate an ISO-8601 instant string (engagement-domain record
 * timestamps + rights windows). Returns the input.
 */
export function validateEngagementInstant(
  field: string,
  value: string,
): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new InvalidEngagementError(
      `${field} must be an ISO-8601 instant (got ${String(value)})`,
      { field, value },
    );
  }
  return value;
}

/**
 * Validate a usage-rights duration window: startsAt < endsAt, both
 * ISO instants, and the span bounded by
 * {@link USAGE_RIGHTS_MAX_DURATION_DAYS}.
 */
export function validateUsageRightsWindow(
  startsAt: string,
  endsAt: string,
): { startsAt: string; endsAt: string } {
  validateEngagementInstant("startsAt", startsAt);
  validateEngagementInstant("endsAt", endsAt);
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (end <= start) {
    throw new InvalidEngagementError(
      "usage-rights window must satisfy endsAt > startsAt",
      { startsAt, endsAt },
    );
  }
  const days = (end - start) / 86_400_000;
  if (days > USAGE_RIGHTS_MAX_DURATION_DAYS) {
    throw new InvalidEngagementError(
      `usage-rights duration must not exceed ${String(USAGE_RIGHTS_MAX_DURATION_DAYS)} days (got ${String(Math.ceil(days))})`,
      { startsAt, endsAt, days: Math.ceil(days) },
    );
  }
  return { startsAt, endsAt };
}

/**
 * Validate a territory code list: non-empty unique strings matching
 * the provider-neutral territory shape (UN M49 / ISO-3166-1 alpha-2
 * style — two uppercase letters), bounded by
 * {@link USAGE_RIGHTS_MAX_TERRITORIES}.
 */
export function validateUsageRightsTerritories(
  territories: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(territories) ||
    territories.length === 0 ||
    territories.length > USAGE_RIGHTS_MAX_TERRITORIES
  ) {
    throw new InvalidEngagementError(
      `territories must be a non-empty list of at most ${String(USAGE_RIGHTS_MAX_TERRITORIES)} codes`,
      { count: territories?.length },
    );
  }
  const seen = new Set<string>();
  for (const code of territories) {
    if (typeof code !== "string" || !/^[A-Z]{2}$/.test(code)) {
      throw new InvalidEngagementError(
        `territory code must be an ISO-3166-1 alpha-2 style code (got ${String(code)})`,
        { code },
      );
    }
    if (seen.has(code)) {
      throw new InvalidEngagementError(
        `duplicate territory code: ${code}`,
        { code },
      );
    }
    seen.add(code);
  }
  return territories;
}

/**
 * Validate a channel list against the closed vocabulary (unique,
 * non-empty, bounded).
 */
export function validateUsageRightsChannels(
  channels: readonly string[],
): readonly UsageRightsChannel[] {
  if (
    !Array.isArray(channels) ||
    channels.length === 0 ||
    channels.length > USAGE_RIGHTS_MAX_CHANNELS
  ) {
    throw new InvalidEngagementError(
      `channels must be a non-empty list of at most ${String(USAGE_RIGHTS_MAX_CHANNELS)} closed-vocabulary channels`,
      { count: channels?.length },
    );
  }
  const seen = new Set<string>();
  for (const channel of channels) {
    if (typeof channel !== "string" || !isUsageRightsChannel(channel)) {
      throw new InvalidEngagementError(
        `unknown usage-rights channel: ${String(channel)} (closed vocabulary: ${USAGE_RIGHTS_CHANNELS.join(", ")})`,
        { channel },
      );
    }
    if (seen.has(channel)) {
      throw new InvalidEngagementError(
        `duplicate channel: ${channel}`,
        { channel },
      );
    }
    seen.add(channel);
  }
  return channels as readonly UsageRightsChannel[];
}

/**
 * Validate a permitted-uses list: unique rights kinds from the frozen
 * CREATOR_RIGHTS_KINDS vocabulary, each with optional human-readable
 * terms, bounded by {@link USAGE_RIGHTS_MAX_USES}.
 */
export function validateUsageRightsUses(
  uses: readonly { kind: string; terms?: string | null }[],
): readonly { kind: CreatorRightsKind; terms: string | null }[] {
  if (!Array.isArray(uses) || uses.length === 0) {
    throw new InvalidEngagementError(
      "uses must be a non-empty list of permitted uses",
      { count: uses?.length },
    );
  }
  if (uses.length > USAGE_RIGHTS_MAX_USES) {
    throw new InvalidEngagementError(
      `uses must carry at most ${String(USAGE_RIGHTS_MAX_USES)} kinds`,
      { count: uses.length },
    );
  }
  const seen = new Set<string>();
  const out: { kind: CreatorRightsKind; terms: string | null }[] = [];
  for (const use of uses) {
    if (!use || typeof use !== "object" || typeof use.kind !== "string") {
      throw new InvalidEngagementError(
        "each use must be an object with a kind",
        { use },
      );
    }
    if (!isCreatorRightsKind(use.kind)) {
      throw new InvalidEngagementError(
        `unknown usage-rights kind: ${String(use.kind)} (frozen vocabulary: ${CREATOR_RIGHTS_KINDS.join(", ")})`,
        { kind: use.kind },
      );
    }
    if (seen.has(use.kind)) {
      throw new InvalidEngagementError(
        `duplicate usage-rights kind: ${use.kind}`,
        { kind: use.kind },
      );
    }
    seen.add(use.kind);
    const terms =
      use.terms === undefined || use.terms === null
        ? null
        : String(use.terms);
    if (terms !== null && terms.length > 500) {
      throw new InvalidEngagementError(
        "use terms must be at most 500 characters",
        { kind: use.kind },
      );
    }
    out.push({ kind: use.kind, terms });
  }
  return out;
}

/**
 * Validate a format list against the frozen
 * {@link CREATOR_CONTENT_FORMATS} vocabulary (unique, bounded).
 */
export function validateUsageRightsFormats(
  formats: readonly string[],
): readonly CreatorContentFormat[] {
  if (!Array.isArray(formats) || formats.length === 0) {
    throw new InvalidEngagementError(
      "formats must be a non-empty list of content formats",
      { count: formats?.length },
    );
  }
  if (formats.length > USAGE_RIGHTS_MAX_FORMATS) {
    throw new InvalidEngagementError(
      `formats must carry at most ${String(USAGE_RIGHTS_MAX_FORMATS)} entries`,
      { count: formats.length },
    );
  }
  const seen = new Set<string>();
  for (const format of formats) {
    if (typeof format !== "string" || !isCreatorContentFormat(format)) {
      throw new InvalidEngagementError(
        `unknown content format: ${String(format)} (frozen vocabulary: ${CREATOR_CONTENT_FORMATS.join(", ")})`,
        { format },
      );
    }
    if (seen.has(format)) {
      throw new InvalidEngagementError(
        `duplicate format: ${format}`,
        { format },
      );
    }
    seen.add(format);
  }
  return formats as readonly CreatorContentFormat[];
}

/**
 * Validate an exclusions list: unique non-empty strings bounded by
 * {@link USAGE_RIGHTS_MAX_EXCLUSIONS} (explicit exclusions a
 * counterparty must respect — work order §3.3).
 */
export function validateUsageRightsExclusions(
  exclusions: readonly string[],
): readonly string[] {
  if (!Array.isArray(exclusions)) {
    throw new InvalidEngagementError("exclusions must be a list", {
      exclusions,
    });
  }
  if (exclusions.length > USAGE_RIGHTS_MAX_EXCLUSIONS) {
    throw new InvalidEngagementError(
      `exclusions must carry at most ${String(USAGE_RIGHTS_MAX_EXCLUSIONS)} entries`,
      { count: exclusions.length },
    );
  }
  const seen = new Set<string>();
  for (const exclusion of exclusions) {
    if (typeof exclusion !== "string" || !exclusion.trim()) {
      throw new InvalidEngagementError(
        "each exclusion must be a non-empty string",
        { exclusion },
      );
    }
    if (seen.has(exclusion)) {
      throw new InvalidEngagementError(
        `duplicate exclusion: ${exclusion}`,
        { exclusion },
      );
    }
    seen.add(exclusion);
  }
  return exclusions;
}

// ---------------------------------------------------------------------------
// NET-W018 — Sponsorship and disclosure vocabulary (creator side)
// ---------------------------------------------------------------------------

/**
 * The closed commercial-relationship kind vocabulary (NET-W018 —
 * DISC-001: "Explicitly represent commercial relationships"). The
 * kind records WHAT the commercial arrangement IS; it is declared
 * data on the relationship record, never an economic instruction:
 *
 *  - `sponsorship`: the sponsor compensates the creator for content.
 *  - `paid_placement`: a one-off paid placement in creator content.
 *  - `gifted_product`: product/benefit provided without payment.
 *  - `brand_ambassador`: an ongoing affiliation arrangement.
 *
 * /settlement remains the economic authority; none of these kinds
 * carries or triggers economic mutation from `/creators`.
 */
export const COMMERCIAL_RELATIONSHIP_KINDS = [
  "sponsorship",
  "paid_placement",
  "gifted_product",
  "brand_ambassador",
] as const;

export type CommercialRelationshipKind =
  (typeof COMMERCIAL_RELATIONSHIP_KINDS)[number];

export function isCommercialRelationshipKind(
  value: string,
): value is CommercialRelationshipKind {
  return (
    (COMMERCIAL_RELATIONSHIP_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Validate a commercial-relationship kind (closed vocabulary).
 */
export function validateCommercialRelationshipKind(
  kind: string,
): CommercialRelationshipKind {
  if (typeof kind !== "string" || !isCommercialRelationshipKind(kind)) {
    throw new InvalidSponsorshipError(
      `commercial relationship kind must be a closed-vocabulary kind (got ${String(kind)})`,
      { kind },
    );
  }
  return kind;
}

/** Max disclosure obligations a single relationship may declare. */
export const COMMERCIAL_RELATIONSHIP_MAX_OBLIGATIONS = 5;

/** Max disclosure declarations per publication (append-only bound). */
export const DISCLOSURE_DECLARATION_MAX_PER_PUBLICATION = 16;

/** Max publication-evidence references per publication verification. */
export const PUBLICATION_MAX_EVIDENCE_REFERENCES = 8;

/** Max disclosure-declaration evidence references per declaration. */
export const DISCLOSURE_DECLARATION_MAX_EVIDENCE_REFERENCES = 8;

/** Max characters of the declaration statement prose. */
export const DISCLOSURE_DECLARATION_MAX_STATEMENT_CHARS = 2000;

/** Max characters of the relationship/termination prose fields. */
export const COMMERCIAL_RELATIONSHIP_MAX_PROSE_CHARS = 2000;

/**
 * The frozen record-format lineages for the NET-W018 creator-side
 * records (the engagement-record precedent): pinned on every record so
 * the contract shape stays reproducible.
 */
export const COMMERCIAL_RELATIONSHIP_FORMAT = "NET-W018:1" as const;
export const DISCLOSURE_DECLARATION_FORMAT = "NET-W018:1" as const;
export const PUBLICATION_RECORD_FORMAT = "NET-W018:1" as const;

/**
 * Validation error for sponsorship/disclosure request violations
 * (NET-W018): malformed relationship/publication/declaration inputs.
 */
export class InvalidSponsorshipError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "SPONSORSHIP_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/** Stable conflict on commercial-relationship state (e.g. a second
 * relationship for the same engagement — one commercial relationship
 * per engagement). */
export class CommercialRelationshipConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "COMMERCIAL_RELATIONSHIP_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * THE disclosure-gate error (NET-W018 invariant 4 / AC-04): raised by
 * the publication verification composite when required disclosure
 * obligations remain unsatisfied — the DRAFT → VERIFIED transition is
 * structurally unreachable until every required disclosure kind has a
 * valid, evidence-bound declaration for THIS publication. The context
 * carries the machine-readable required/satisfied/missing sets so
 * callers can resolve deterministically. There is NO caller input
 * that suppresses this error: it is derived from durable records
 * (campaign policy ∪ relationship obligations), never asserted.
 */
export class DisclosureObligationsUnsatisfiedError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED",
      classification: "validation",
      message,
      context,
    });
  }
}
