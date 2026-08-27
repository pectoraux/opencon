/**
 * CreatorMatchingService — the NET-W016 creator matching domain
 * service (deterministic eligibility + explicit-signal ranking +
 * bounded advisory + the append-only run record).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/creators` owns creator domain rules), §14 (AI outputs remain
 * recommendations/evidence inputs — never unilateral truth), §19
 * (AI never establishes eligibility); spec/architecture-lock.md §2
 * (the frozen core domains), §3 (PostgreSQL authoritative), §12
 * (execution lineage), §14 (provider neutrality).
 *
 * Work order ref: spec/work-orders/NET-W016.md §3.1–§3.5.
 *
 * MATCHING IS SELECTION, NOT AUTHORITY (the work item's strongest
 * constraint):
 *  - the ONLY mutation is the append-only, idempotent,
 *    tenant-scoped match-run record + its `creator_match.recorded`
 *    audit event (both committed in ONE authoritative transaction);
 *  - NO workflow transition, NO economic unit, NO reputation
 *    input/snapshot, NO risk signal/control is ever created or
 *    mutated (regression-pinned structurally + behaviorally);
 *  - reputation is REFERENCED + VERIFIED + RESOLVED READ-ONLY
 *    through the neutral CreatorMatchReputationLookup (/reputation
 *    stays the trust-signal authority);
 *  - safety is READ through the neutral CreatorMatchSafetyLookup
 *    over the risk-control registry's participant_eligibility gate
 *    (/disputes stays the risk-control authority);
 *  - campaign requirements are derived READ-ONLY through the
 *    neutral CreatorMatchCampaignLookup (/campaigns stays the
 *    campaign policy authority);
 *  - the advisory is an injected provider-neutral port (AI-002),
 *    consulted ONLY for already-eligible candidates, blending ONLY
 *    into the relevance signal under a capped weight — there is NO
 *    code path from advisory output to an eligibility verdict.
 *
 * DETERMINISM: identical inputs produce identical verdicts, scores,
 * rankings and digests (the pure engine rounds every numeric output
 * to 1 decimal and the digest serializes at that fixed precision).
 * A re-run with the same idempotency key replays the COMMITTED
 * record byte-identically (created = false).
 *
 * TENANT ISOLATION: every read resolves records WITHIN an
 * organization scope — including the ID-based reads (a cross-scope
 * run id, profile id or campaign is indistinguishable from a
 * nonexistent one — NotFoundError, no existence oracle).
 *
 * Atomicity: the run record + idempotency record + audit event
 * commit in ONE authoritative transaction
 * (IdempotencyStore.applyIdempotent; NET-W004-AC-07).
 *
 * Tier compliance: creators domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  CREATOR_MATCH_ADVISORY_MAX_BLEND,
  CREATOR_MATCH_DEFAULT_WEIGHTS,
  CREATOR_MATCH_FORMAT,
  CREATOR_MATCH_MAX_CANDIDATES,
  InvalidCreatorMatchError,
  assertNoCredentialShapedKeys,
  assertNoRawAudienceKeys,
  isCreatorAudienceSizeBand,
  isCreatorContentFormat,
  isCreatorRightsKind,
  isCreatorRateUnit,
  validateCreatorCurrencyCode,
  validateCreatorLanguageTag,
  validateCreatorMatchAdvisoryMaxWeight,
  validateCreatorMatchReputationThreshold,
  validateCreatorMatchWeights,
  validateCreatorRateAmount,
  validateCreatorTerritoryCode,
  type CreatorMatchWeightsShape,
} from "../core/creators.ts";
import type {
  CreatorMatchAdvisory,
  CreatorMatchAdvisoryAssessment,
  CreatorMatchAdvisoryFact,
  CreatorMatchCandidateResult,
  CreatorMatchExcludedCandidate,
  CreatorMatchLookups,
  CreatorMatchRequirements,
  CreatorMatchRunRecord,
  CreatorMatchRunRepository,
  CreatorMatchingService,
  CreatorProfileRecord,
  CreatorProfileRepository,
  CreatorProfileVersion,
  CreatorProfileVersionRepository,
  CreatorReputationReference,
  ResolvedCampaignCreatorRequirements,
  ResolvedCreatorReputationScore,
  RunCreatorMatchInput,
  RunCreatorMatchResult,
} from "./port.ts";
import {
  buildCandidateResults,
  buildExcludedCandidates,
  computeMatchDigest,
  evaluateEligibility,
  rankCandidates,
  round1,
  scoreCandidate,
  totalScoreOf,
  type CreatorMatchCandidateFacts,
  type CreatorMatchReputationFacts,
  type RankedCandidate,
} from "./matching-engine.ts";

const CREATOR_MATCH_RECORDED = "creator_match.recorded" as const;

/** The default advisory blend weight when enabled but unspecified. */
const DEFAULT_ADVISORY_MAX_WEIGHT = 10;

export interface CreatorMatchingServiceDeps {
  readonly profileRepository: CreatorProfileRepository;
  readonly versionRepository: CreatorProfileVersionRepository;
  readonly runRepository: CreatorMatchRunRepository;
  readonly lookups: CreatorMatchLookups;
  readonly advisory: CreatorMatchAdvisory;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function matchValidationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new InvalidCreatorMatchError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw matchValidationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

function assertOrganizationScopeId(organizationScopeId: string): string {
  if (!organizationScopeId?.trim()) {
    throw matchValidationError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

/** The acting person's id (a person runs a match; recorded as createdBy). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw matchValidationError(
      "an authenticated person actor is required to run a match (service/system actors cannot)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function validateStringArray<T extends string>(
  field: string,
  values: unknown,
  opts: {
    readonly max: number;
    readonly validate: (field: string, value: string) => T;
  },
): T[] {
  const list = values ?? [];
  if (!Array.isArray(list)) {
    throw matchValidationError(`${field} must be an array`, { field });
  }
  if (list.length > opts.max) {
    throw matchValidationError(
      `${field} must carry at most ${String(opts.max)} entries (got ${String(list.length)})`,
      { field, count: list.length },
    );
  }
  const out: T[] = [];
  for (const value of list) {
    if (typeof value !== "string" || !value.trim()) {
      throw matchValidationError(
        `${field} entries must be non-empty strings`,
        { field, value },
      );
    }
    out.push(opts.validate(`${field}[${String(out.length)}]`, value.trim()));
  }
  return [...new Set(out)];
}

/**
 * Validate the provider-neutral requirements against the frozen
 * vocabularies (work order §3.4). Defense in depth: the credential-
 * shaped and raw-audience-shaped key guards also apply to the
 * requirements input.
 */
export function validateMatchRequirements(
  raw: unknown,
): CreatorMatchRequirements {
  if (raw === null || typeof raw !== "object") {
    throw matchValidationError("requirements must be an object", {
      field: "requirements",
    });
  }
  const input = raw as Readonly<Record<string, unknown>>;
  assertNoCredentialShapedKeys(input, "requirements");
  assertNoRawAudienceKeys(input, "requirements");

  const requiredFormats = validateStringArray(
    "requirements.requiredFormats",
    input.requiredFormats,
    {
      max: 8,
      validate: (_f, v) => {
        if (!isCreatorContentFormat(v)) {
          throw matchValidationError(
            `requirements.requiredFormats entries must be creator content formats (got ${v})`,
            { value: v },
          );
        }
        return v;
      },
    },
  );
  const requiredLanguages = validateStringArray(
    "requirements.requiredLanguages",
    input.requiredLanguages,
    { max: 20, validate: validateCreatorLanguageTag },
  );
  const targetTerritories = validateStringArray(
    "requirements.targetTerritories",
    input.targetTerritories,
    { max: 20, validate: validateCreatorTerritoryCode },
  );
  const campaignTopics = validateStringArray(
    "requirements.campaignTopics",
    input.campaignTopics,
    {
      max: 50,
      validate: (_f, v) => {
        if (v.length > 100) {
          throw matchValidationError(
            "requirements.campaignTopics entries must be at most 100 characters",
            { value: v },
          );
        }
        return v;
      },
    },
  );
  const requiredRightsKinds = validateStringArray(
    "requirements.requiredRightsKinds",
    input.requiredRightsKinds,
    {
      max: 5,
      validate: (_f, v) => {
        if (!isCreatorRightsKind(v)) {
          throw matchValidationError(
            `requirements.requiredRightsKinds entries must be creator rights kinds (got ${v})`,
            { value: v },
          );
        }
        return v;
      },
    },
  );

  let rateCeiling: CreatorMatchRequirements["rateCeiling"] = null;
  const rawCeiling = input.rateCeiling ?? null;
  if (rawCeiling !== null) {
    if (typeof rawCeiling !== "object") {
      throw matchValidationError("requirements.rateCeiling must be an object", {
        field: "requirements.rateCeiling",
      });
    }
    const ceiling = rawCeiling as Readonly<Record<string, unknown>>;
    const amount = validateCreatorRateAmount(
      "requirements.rateCeiling.amount",
      ceiling.amount as number,
    );
    const currency = validateCreatorCurrencyCode(
      "requirements.rateCeiling.currency",
      ceiling.currency as string,
    );
    const unit = ceiling.unit;
    if (typeof unit !== "string" || !isCreatorRateUnit(unit)) {
      throw matchValidationError(
        `requirements.rateCeiling.unit must be a creator rate unit (got ${String(unit)})`,
        { unit },
      );
    }
    rateCeiling = Object.freeze({ amount, currency, unit });
  }

  let minimumAudienceSizeBand: CreatorMatchRequirements["minimumAudienceSizeBand"] =
    null;
  const rawBand = input.minimumAudienceSizeBand ?? null;
  if (rawBand !== null) {
    if (typeof rawBand !== "string" || !isCreatorAudienceSizeBand(rawBand)) {
      throw matchValidationError(
        `requirements.minimumAudienceSizeBand must be an audience size band (got ${String(rawBand)})`,
        { value: rawBand },
      );
    }
    minimumAudienceSizeBand = rawBand;
  }

  const rawMinimumReputation =
    (input.minimumReputation ?? {}) as Readonly<Record<string, unknown>>;
  const audienceInfluence =
    rawMinimumReputation.audienceInfluence ?? null;
  const production = rawMinimumReputation.production ?? null;
  const minimumReputation = Object.freeze({
    audienceInfluence:
      audienceInfluence === null
        ? null
        : validateCreatorMatchReputationThreshold(
            "requirements.minimumReputation.audienceInfluence",
            audienceInfluence as number,
          ),
    production:
      production === null
        ? null
        : validateCreatorMatchReputationThreshold(
            "requirements.minimumReputation.production",
            production as number,
          ),
  });

  let noticeWindowDays: CreatorMatchRequirements["noticeWindowDays"] = null;
  const rawNotice = input.noticeWindowDays ?? null;
  if (rawNotice !== null) {
    if (
      typeof rawNotice !== "number" ||
      !Number.isInteger(rawNotice) ||
      rawNotice < 0 ||
      rawNotice > 365
    ) {
      throw matchValidationError(
        `requirements.noticeWindowDays must be an integer between 0 and 365 (got ${String(rawNotice)})`,
        { value: rawNotice },
      );
    }
    noticeWindowDays = rawNotice;
  }

  return Object.freeze({
    requiredFormats: Object.freeze(requiredFormats),
    requiredLanguages: Object.freeze(requiredLanguages),
    targetTerritories: Object.freeze(targetTerritories),
    campaignTopics: Object.freeze(campaignTopics),
    requiredRightsKinds: Object.freeze(requiredRightsKinds),
    rateCeiling,
    minimumAudienceSizeBand,
    minimumReputation,
    noticeWindowDays,
  });
}

/** Union two requirement sets (campaign-derived ∪ explicit; the hard merge). */
function mergeRequirements(
  explicit: CreatorMatchRequirements,
  campaign: ResolvedCampaignCreatorRequirements | null,
): CreatorMatchRequirements {
  if (campaign === null) {
    return explicit;
  }
  return Object.freeze({
    requiredFormats: explicit.requiredFormats,
    requiredLanguages: [
      ...new Set([
        ...explicit.requiredLanguages,
        ...campaign.requiredLanguages,
      ]),
    ],
    targetTerritories: [
      ...new Set([
        ...explicit.targetTerritories,
        ...campaign.targetTerritories,
      ]),
    ],
    campaignTopics: explicit.campaignTopics,
    requiredRightsKinds: explicit.requiredRightsKinds,
    rateCeiling: explicit.rateCeiling,
    minimumAudienceSizeBand: explicit.minimumAudienceSizeBand,
    minimumReputation: explicit.minimumReputation,
    noticeWindowDays: explicit.noticeWindowDays,
  });
}

/**
 * Re-verify a profile version's reputation references at match time
 * (the W015 verification semantics) and resolve their canonical
 * scores READ-ONLY. A reference fails verification when the snapshot
 * is gone, cross-scope, cross-subject, dimension-mismatched or
 * digest-mismatched — the candidate then fails the
 * `reputation_reference_unresolvable` hard gate.
 */
async function resolveReputationFacts(
  profile: CreatorProfileRecord,
  version: CreatorProfileVersion | null,
  lookup: CreatorMatchLookups["reputation"],
): Promise<CreatorMatchReputationFacts> {
  const references = version?.sections.reputationReferences ?? [];
  const byRole = new Map<string, CreatorReputationReference>(
    references.map((ref) => [ref.role, ref]),
  );
  const audienceRef = byRole.get("audience_influence") ?? null;
  const productionRef = byRole.get("production") ?? null;

  const resolveOne = async (
    role: string,
    ref: CreatorReputationReference | null,
  ): Promise<ResolvedCreatorReputationScore | null> => {
    if (ref === null) return null;
    const resolved = await lookup.resolveScore(ref.snapshotId, ref.dimension);
    if (resolved === null) return null;
    if (
      resolved.organizationScopeId !== profile.organizationScopeId ||
      resolved.subjectPersonId !== profile.creatorPersonId ||
      resolved.digest !== ref.digest ||
      resolved.dimension !== ref.dimension
    ) {
      return null;
    }
    return resolved;
  };

  const audienceInfluence = await resolveOne("audience_influence", audienceRef);
  const production = await resolveOne("production", productionRef);

  const verified =
    audienceRef !== null &&
    productionRef !== null &&
    audienceInfluence !== null &&
    production !== null;

  return {
    verified,
    failedRole: verified
      ? null
      : audienceInfluence === null
        ? "audience_influence"
        : "production",
    audienceInfluence,
    production,
  };
}

/**
 * Build the privacy-minimized neutral-fact set for the advisory
 * (work order §3.3): campaign requirement labels + creator PUBLIC
 * aggregate facts ONLY — NO rates, NO restricted topics, NO
 * reputation scores, NO identity material. The label set is the
 * closed advisory vocabulary (regression-pinned).
 */
export function buildAdvisoryFacts(
  requirements: CreatorMatchRequirements,
  facts: CreatorMatchCandidateFacts,
): readonly CreatorMatchAdvisoryFact[] {
  const sections = facts.sections!;
  const value = (v: readonly string[]): string => v.join(",");
  return [
    { label: "campaign_required_formats", value: value(requirements.requiredFormats) },
    { label: "campaign_required_languages", value: value(requirements.requiredLanguages) },
    { label: "campaign_target_territories", value: value(requirements.targetTerritories) },
    { label: "campaign_topics", value: value(requirements.campaignTopics) },
    {
      label: "creator_platform_kinds",
      value: value(sections.platforms.map((p) => p.platformKind)),
    },
    {
      label: "creator_format_capabilities",
      value: value([
        ...new Set(sections.platforms.flatMap((p) => [...p.capabilities])),
      ]),
    },
    {
      label: "creator_languages",
      value: value([...new Set(sections.platforms.flatMap((p) => [...p.languages]))]),
    },
    {
      label: "creator_audience_size_band",
      value: sections.audience.sizeBand,
    },
    {
      label: "creator_audience_engagement_band",
      value: sections.audience.engagementBand,
    },
    {
      label: "creator_audience_top_geographies",
      value: sections.audience.topGeographies
        .map((g) => `${g.territory}:${String(g.share)}`)
        .join(","),
    },
  ];
}

export function createCreatorMatchingService(
  deps: CreatorMatchingServiceDeps,
): CreatorMatchingService {
  const {
    profileRepository,
    versionRepository,
    runRepository,
    lookups,
    advisory,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function loadProfileWithinScope(
    organizationScopeId: string,
    profileId: string,
  ): Promise<CreatorProfileRecord> {
    const profile = await profileRepository.findById(profileId);
    if (
      profile === null ||
      profile.organizationScopeId !== organizationScopeId
    ) {
      // Tenant-scoped ID read: a cross-scope profile id is
      // indistinguishable from a nonexistent one — no existence
      // oracle (the PR #30 review remediation pattern).
      throw new NotFoundError(
        `creator profile not found: ${profileId}`,
        { profileId, organizationScopeId },
      );
    }
    return profile;
  }

  async function loadRunWithinScope(
    organizationScopeId: string,
    id: string,
  ): Promise<CreatorMatchRunRecord> {
    const run = await runRepository.findById(id);
    if (run === null || run.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(
        `creator match run not found: ${id}`,
        { id, organizationScopeId },
      );
    }
    return run;
  }

  return {
    async runMatch(execution, input): Promise<RunCreatorMatchResult> {
      assertIdempotencyKey(input.idempotencyKey);
      assertOrganizationScopeId(input.organizationScopeId);
      const actor = actingPersonId(execution);
      const requirements = validateMatchRequirements(input.requirements);

      // Weights: explicit (validated) or the canonical default.
      const weights: CreatorMatchWeightsShape =
        input.weights === null || input.weights === undefined
          ? CREATOR_MATCH_DEFAULT_WEIGHTS
          : validateCreatorMatchWeights(input.weights);

      // Advisory configuration: disabled unless explicitly enabled.
      const advisoryEnabled = input.advisory?.enabled === true;
      const advisoryMaxWeight = advisoryEnabled
        ? validateCreatorMatchAdvisoryMaxWeight(
            input.advisory?.maxWeight ?? DEFAULT_ADVISORY_MAX_WEIGHT,
          )
        : 0;
      const blend = advisoryEnabled ? advisoryMaxWeight / 100 : 0;

      // -- campaign linkage (read-only, tenant-scoped) ---------------
      let resolvedCampaign: ResolvedCampaignCreatorRequirements | null = null;
      if (input.campaign !== null && input.campaign !== undefined) {
        const campaignId = input.campaign.campaignId;
        if (typeof campaignId !== "string" || !campaignId.trim()) {
          throw matchValidationError(
            "campaign.campaignId is required when a campaign is linked",
            { field: "campaign.campaignId" },
          );
        }
        resolvedCampaign = await lookups.campaign.resolve(
          campaignId.trim(),
          input.campaign.policyVersion,
        );
        if (
          resolvedCampaign === null ||
          resolvedCampaign.organizationScopeId !== input.organizationScopeId
        ) {
          // Cross-scope or nonexistent: indistinguishable.
          throw new NotFoundError(
            `campaign not found: ${campaignId.trim()}`,
            { campaignId: campaignId.trim(), organizationScopeId: input.organizationScopeId },
          );
        }
      }
      const effectiveRequirements = mergeRequirements(
        requirements,
        resolvedCampaign,
      );

      // -- candidate enumeration (tenant-scoped) ---------------------
      let profiles: readonly CreatorProfileRecord[];
      if (
        input.candidateProfileIds !== null &&
        input.candidateProfileIds !== undefined
      ) {
        if (!Array.isArray(input.candidateProfileIds)) {
          throw matchValidationError(
            "candidateProfileIds must be an array when provided",
            { field: "candidateProfileIds" },
          );
        }
        const narrowed: CreatorProfileRecord[] = [];
        for (const profileId of input.candidateProfileIds) {
          if (typeof profileId !== "string" || !profileId.trim()) {
            throw matchValidationError(
              "candidateProfileIds entries must be non-empty strings",
              { field: "candidateProfileIds", profileId },
            );
          }
          narrowed.push(
            await loadProfileWithinScope(
              input.organizationScopeId,
              profileId.trim(),
            ),
          );
        }
        profiles = narrowed;
      } else {
        profiles = await profileRepository.listByOrganization(
          input.organizationScopeId,
          ["ACTIVE"],
        );
      }
      if (profiles.length > CREATOR_MATCH_MAX_CANDIDATES) {
        throw matchValidationError(
          `a match run may evaluate at most ${String(CREATOR_MATCH_MAX_CANDIDATES)} candidates (got ${String(profiles.length)}) — narrow with candidateProfileIds`,
          { candidateCount: profiles.length },
        );
      }

      // -- fact assembly (all cross-authority reads happen here) ----
      const factsList: CreatorMatchCandidateFacts[] = [];
      for (const profile of profiles) {
        const version =
          profile.currentVersion === null
            ? null
            : await versionRepository.findVersion(
                profile.id,
                profile.currentVersion,
              );
        const reputationFacts = await resolveReputationFacts(
          profile,
          version,
          lookups.reputation,
        );
        const safety = await lookups.safety.activeHold(
          profile.organizationScopeId,
          profile.creatorPersonId,
        );
        factsList.push({
          profile,
          version,
          sections: version?.sections ?? null,
          reputation: reputationFacts,
          safety,
        });
      }

      // -- deterministic eligibility (the pure engine) --------------
      const eligibilityByProfile = new Map(
        factsList.map((facts) => [
          facts.profile.id,
          evaluateEligibility(facts, effectiveRequirements),
        ]),
      );

      // -- advisory (ONLY for already-eligible candidates) -----------
      // Structural non-authority: hard-gated candidates are excluded
      // BEFORE the advisory is ever consulted, and the assessment
      // only blends into the relevance ranking signal.
      const advisoryByProfile = new Map<
        string,
        CreatorMatchAdvisoryAssessment
      >();
      if (advisoryEnabled) {
        for (const facts of factsList) {
          if (!eligibilityByProfile.get(facts.profile.id)!.eligible) continue;
          const assessment = await advisory.assess({
            rubricRef: `creator-matching:${CREATOR_MATCH_FORMAT}`,
            neutralFacts: buildAdvisoryFacts(effectiveRequirements, facts),
          });
          advisoryByProfile.set(facts.profile.id, assessment);
        }
      }

      // -- scoring + ranking (the pure engine) ----------------------
      const scored: RankedCandidate[] = [];
      for (const facts of factsList) {
        const eligibility = eligibilityByProfile.get(facts.profile.id)!;
        if (!eligibility.eligible) continue;
        const assessment = advisoryByProfile.get(facts.profile.id) ?? null;
        const signals = scoreCandidate(
          facts,
          effectiveRequirements,
          weights,
          assessment,
          blend,
        );
        scored.push({
          facts,
          signals,
          totalScore: totalScoreOf(signals),
          advisory: assessment,
        });
      }
      const ranked = rankCandidates(scored);
      const results: readonly CreatorMatchCandidateResult[] =
        buildCandidateResults(ranked);
      const excluded: readonly CreatorMatchExcludedCandidate[] =
        buildExcludedCandidates(factsList, (facts) =>
          evaluateEligibility(facts, effectiveRequirements),
        );

      // -- the run record + digest ----------------------------------
      const advisoryMeta = Object.freeze({
        used: advisoryEnabled && ranked.length > 0,
        blend: round1(blend * 100) / 100,
        provider: advisoryEnabled && ranked.length > 0
          ? (ranked[0]?.advisory?.provider ?? null)
          : null,
        modelRef: advisoryEnabled && ranked.length > 0
          ? (ranked[0]?.advisory?.modelRef ?? null)
          : null,
      });

      const core = {
        organizationScopeId: input.organizationScopeId,
        formatVersion: CREATOR_MATCH_FORMAT,
        campaign: resolvedCampaign
          ? {
              campaignId: resolvedCampaign.campaignId,
              policyVersion: resolvedCampaign.policyVersion,
            }
          : null,
        requirements: effectiveRequirements,
        weights,
        advisory: advisoryMeta,
        candidateCount: factsList.length,
        eligibleCount: ranked.length,
        results,
        excluded,
      };
      const digest = computeMatchDigest(core);

      const key = `creator_match_run:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const run: CreatorMatchRunRecord = Object.freeze({
            id: randomUUID(),
            ...core,
            digest,
            createdBy: actor,
            createdAt: new Date().toISOString(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await runRepository.createWithinTx(run, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CREATOR_MATCH_RECORDED,
            context: execution,
            actor,
            subject: run.id,
            resourceType: "creator_match_run",
            resourceId: run.id,
            metadata: {
              organizationScopeId: run.organizationScopeId,
              campaign: run.campaign,
              candidateCount: run.candidateCount,
              eligibleCount: run.eligibleCount,
              digest: run.digest,
              advisoryUsed: run.advisory.used,
              advisoryProvider: run.advisory.provider,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return run;
        },
        execution,
      );
      logger.info("creator_match.recorded", {
        runId: applied.result.id,
        organizationScopeId: applied.result.organizationScopeId,
        eligibleCount: applied.result.eligibleCount,
        created: applied.executed,
      });
      return { run: applied.result, created: applied.executed };
    },

    async getMatchRun(execution, organizationScopeId, id) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return loadRunWithinScope(organizationScopeId, id);
    },

    async listMatchRuns(execution, organizationScopeId, campaignId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return runRepository.listByOrganization(
        organizationScopeId,
        campaignId,
      );
    },
  };
}
