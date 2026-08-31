/**
 * CampaignMatchingService — the NET-W021 campaign matching and
 * optimization domain service (hard gates → evidence-backed features
 * → deterministic baseline ranking → bounded AI advisory →
 * explainable ordering + the append-only run record).
 *
 * Architecture ref: spec/architecture.md §7 (campaign matching is a
 * campaign-domain rule), §14 (AI outputs remain recommendations/
 * evidence inputs — never unilateral truth), §18 (module ownership:
 * `/campaigns` owns campaign domain rules), §19 (AI never authorizes
 * state); spec/architecture-lock.md §2 (the frozen core domains),
 * §3 (PostgreSQL authoritative), §12 (execution lineage), §14
 * (provider neutrality).
 *
 * Work order ref: spec/work-orders/NET-W021.md §3.1–§3.5.
 *
 * MATCHING IS SELECTION, NOT AUTHORITY (the work item's strongest
 * constraint, the NET-W016 service precedent):
 *  - the ONLY mutation is the append-only, idempotent,
 *    tenant-scoped match-run record + its `campaign_match.recorded`
 *    audit event (both committed in ONE authoritative transaction);
 *  - NO inventory item/placement mutation, NO campaign record or
 *    policy mutation, NO workflow transition, NO economic unit, NO
 *    reputation input/snapshot, NO risk signal/control, NO outcome
 *    record is ever created or mutated (regression-pinned
 *    structurally + behaviorally);
 *  - supply enumeration, policy-rule evaluation, reputation
 *    resolution, safety reads and outcome-evidence reads happen
 *    through the NEUTRAL lookups (/inventory, /reputation, /disputes
 *    and /outcomes stay the owning authorities);
 *  - the campaign + policy records are the service's OWN domain
 *    state, loaded read-only (the campaign is the matching subject);
 *  - the advisory is an injected provider-neutral port (AI-002 +
 *    AI-003), consulted ONLY for already-eligible candidates,
 *    blending ONLY into the alignment/risk ranking signals under
 *    capped blends — there is NO code path from advisory output to
 *    an eligibility verdict.
 *
 * DETERMINISM: identical inputs produce identical verdicts, scores,
 * orderings and digests (the pure engine rounds every numeric output
 * to 1 decimal and the digest serializes at that fixed precision).
 * A re-run with the same idempotency key replays the COMMITTED
 * record byte-identically (created = false).
 *
 * TENANT ISOLATION: every read resolves records WITHIN an
 * organization scope — including the ID-based reads (a cross-scope
 * run id, item id or policy is indistinguishable from a nonexistent
 * one — NotFoundError, no existence oracle).
 *
 * Atomicity: the run record + idempotency record + audit event
 * commit in ONE authoritative transaction
 * (IdempotencyStore.applyIdempotent; NET-W004-AC-07).
 *
 * Tier compliance: campaigns domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  CAMPAIGN_MATCH_ADVISORY_MAX_BLEND,
  CAMPAIGN_MATCH_DEFAULT_WEIGHTS,
  CAMPAIGN_MATCH_FORMAT,
  CAMPAIGN_MATCH_MAX_CANDIDATES,
  CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE,
  InvalidCampaignMatchError,
  validateCampaignMatchAdvisoryMaxWeight,
  validateCampaignMatchWeights,
  type CampaignMatchWeightsShape,
} from "../core/campaigns.ts";
import {
  isInventoryFormat,
  isInventorySurfaceKind,
} from "../core/inventory.ts";
import type {
  CampaignMatchAdvisoryAssessment,
  CampaignMatchCandidateResult,
  CampaignMatchExcludedCandidate,
  CampaignMatchInventoryItemView,
  CampaignMatchLookups,
  CampaignMatchRunRecord,
  CampaignMatchRunRepository,
  CampaignMatchTargeting,
  CampaignMatchingService,
  CampaignPolicy,
  CampaignRecord,
  CampaignRepository,
  CampaignPolicyRepository,
  ResolvedCampaignMatchReputationScore,
  RunCampaignMatchInput,
  RunCampaignMatchResult,
} from "./port.ts";
import {
  applyAdvisoryBlends,
  buildCandidateResults,
  buildExcludedCandidates,
  computeMatchDigest,
  evaluateEligibility,
  orderCandidates,
  round1,
  scoreBaselineSignals,
  totalScoreOf,
  type CampaignMatchCandidateFacts,
  type ScoredCandidate,
} from "./matching-engine.ts";

const CAMPAIGN_MATCH_RECORDED = "campaign_match.recorded" as const;

/** The default advisory blend weight when enabled but unspecified. */
const DEFAULT_ADVISORY_MAX_WEIGHT = 10;

export interface CampaignMatchingServiceDeps {
  readonly campaignRepository: CampaignRepository;
  readonly campaignPolicyRepository: CampaignPolicyRepository;
  readonly runRepository: CampaignMatchRunRepository;
  readonly lookups: CampaignMatchLookups;
  readonly advisory: CampaignMatchingServiceDepsAdvisory;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/**
 * The advisory port (re-declared here for the deps bag so the
 * bootstrap composition root can inject the LlmPort-backed adapter;
 * shape-identical to the port's CampaignMatchAdvisory).
 */
export interface CampaignMatchingServiceDepsAdvisory {
  assessMatching(input: {
    readonly rubricRef: string;
    readonly neutralFacts: readonly {
      readonly label: string;
      readonly value: string;
    }[];
  }): Promise<CampaignMatchAdvisoryAssessment>;
  assessRisk(input: {
    readonly rubricRef: string;
    readonly neutralFacts: readonly {
      readonly label: string;
      readonly value: string;
    }[];
  }): Promise<CampaignMatchAdvisoryAssessment>;
}

// ---------------------------------------------------------------------------
// Small validation helpers (the W016 service precedent)
// ---------------------------------------------------------------------------

function matchValidationError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
): InvalidCampaignMatchError {
  return new InvalidCampaignMatchError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
    throw matchValidationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
}

function assertOrganizationScopeId(organizationScopeId: string): void {
  if (
    typeof organizationScopeId !== "string" ||
    organizationScopeId.trim() === ""
  ) {
    throw matchValidationError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
}

/** A person actor is required (service/system actors cannot match). */
function actingPersonId(execution: ExecutionContext): string {
  if (
    !execution.actor ||
    execution.actor.kind !== "person" ||
    !execution.actor.id
  ) {
    throw matchValidationError(
      "an authenticated person actor is required to run a campaign match (service/system actors cannot)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/**
 * Validate explicit targeting: closed vocabularies (formats, surface
 * kinds), uppercase territory codes and lowercase-ish language tags
 * (the W016 requirements-validation style — bounded, provider-
 * neutral, explicit).
 */
function validateTargeting(targeting: {
  requiredFormats?: readonly string[];
  requiredSurfaceKinds?: readonly string[];
  targetTerritories?: readonly string[];
  requiredLanguages?: readonly string[];
}): {
  requiredFormats: readonly string[];
  requiredSurfaceKinds: readonly string[];
  targetTerritories: readonly string[];
  requiredLanguages: readonly string[];
} {
  const requiredFormats = targeting.requiredFormats ?? [];
  const requiredSurfaceKinds = targeting.requiredSurfaceKinds ?? [];
  const targetTerritories = targeting.targetTerritories ?? [];
  const requiredLanguages = targeting.requiredLanguages ?? [];
  for (const f of requiredFormats) {
    if (typeof f !== "string" || !isInventoryFormat(f)) {
      throw matchValidationError(
        `targeting.requiredFormats entries must be frozen inventory formats (got ${String(f)})`,
        { field: "targeting.requiredFormats", value: f },
      );
    }
  }
  for (const s of requiredSurfaceKinds) {
    if (typeof s !== "string" || !isInventorySurfaceKind(s)) {
      throw matchValidationError(
        `targeting.requiredSurfaceKinds entries must be frozen inventory surface kinds (got ${String(s)})`,
        { field: "targeting.requiredSurfaceKinds", value: s },
      );
    }
  }
  for (const t of targetTerritories) {
    if (typeof t !== "string" || !/^[A-Z]{2}$/.test(t)) {
      throw matchValidationError(
        `targeting.targetTerritories entries must be ISO-3166-1 alpha-2 territory codes (got ${String(t)})`,
        { field: "targeting.targetTerritories", value: t },
      );
    }
  }
  for (const l of requiredLanguages) {
    if (typeof l !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)) {
      throw matchValidationError(
        `targeting.requiredLanguages entries must be BCP-47 language tags (got ${String(l)})`,
        { field: "targeting.requiredLanguages", value: l },
      );
    }
  }
  return {
    requiredFormats: [...new Set(requiredFormats)],
    requiredSurfaceKinds: [...new Set(requiredSurfaceKinds)],
    targetTerritories: [...new Set(targetTerritories)],
    requiredLanguages: [...new Set(requiredLanguages)],
  };
}

/**
 * The campaign-side derived targeting: the pinned policy's POSITIVE
 * region/language eligibility rules UNION into the explicit targets
 * (the W016 campaign-lookup merge precedent — negative rules stay
 * with the policy-rule gate, evaluated by the /inventory authority's
 * own engine).
 */
function mergeTargeting(
  explicit: CampaignMatchTargeting,
  policy: CampaignPolicy,
): CampaignMatchTargeting {
  const territories = new Set(explicit.targetTerritories);
  const languages = new Set(explicit.requiredLanguages);
  for (const rule of policy.eligibility.rules) {
    if (rule.operator !== "equals" && rule.operator !== "in") continue;
    if (rule.attribute === "region") {
      for (const v of rule.values) territories.add(v);
    } else if (rule.attribute === "language") {
      for (const v of rule.values) languages.add(v);
    }
  }
  return Object.freeze({
    requiredFormats: explicit.requiredFormats,
    requiredSurfaceKinds: explicit.requiredSurfaceKinds,
    targetTerritories: [...territories],
    requiredLanguages: [...languages],
  });
}

/** The outcome types the pinned policy's outcome section demands. */
function requiredOutcomeTypesOf(policy: CampaignPolicy): readonly string[] {
  return [
    ...new Set(policy.outcomePolicy.requirements.map((r) => r.outcomeType)),
  ].sort();
}

/**
 * The privacy-minimized neutral facts for the AI-002 matching
 * assessment: campaign-side requirement labels + the item's PUBLIC
 * aggregate supply facts + evidence PRESENCE (booleans only) — NO
 * owner identity, NO reputation scores, NO evidence values, NO
 * external references (the W013/W016 privacy-minimized
 * advisory-input precedent, regression-pinned bit-for-bit).
 */
function buildMatchingAdvisoryFacts(
  targeting: CampaignMatchTargeting,
  requiredOutcomeTypes: readonly string[],
  facts: CampaignMatchCandidateFacts,
): readonly { label: string; value: string }[] {
  const covered = new Set(
    facts.outcomeEvidence.map((e) => e.outcomeType),
  );
  return [
    ...targeting.requiredFormats.map((f) => ({
      label: "campaign_required_format",
      value: f,
    })),
    ...targeting.requiredSurfaceKinds.map((s) => ({
      label: "campaign_required_surface_kind",
      value: s,
    })),
    ...targeting.targetTerritories.map((t) => ({
      label: "campaign_target_territory",
      value: t,
    })),
    ...targeting.requiredLanguages.map((l) => ({
      label: "campaign_required_language",
      value: l,
    })),
    ...requiredOutcomeTypes.map((t) => ({
      label: "campaign_required_outcome_type",
      value: t,
    })),
    {
      label: "supply_surface_kind",
      value: facts.item.surfaceKind,
    },
    { label: "supply_format", value: facts.item.format },
    {
      label: "supply_territory_count",
      value: String(facts.item.territories.length),
    },
    {
      label: "supply_language_count",
      value: String(facts.item.languages.length),
    },
    ...requiredOutcomeTypes.map((t) => ({
      label: "evidence_present",
      value: `${t}:${covered.has(t) ? "yes" : "no"}`,
    })),
  ];
}

/**
 * The privacy-minimized neutral facts for the AI-003 fraud/risk
 * ANALYSIS assessment: the item's aggregate supply facts + evidence
 * PRESENCE + which canonical reputation dimensions the owner has
 * snapshots for (booleans only — no scores, no identity, no
 * controls detail).
 */
function buildRiskAdvisoryFacts(
  facts: CampaignMatchCandidateFacts,
  requiredOutcomeTypes: readonly string[],
): readonly { label: string; value: string }[] {
  const covered = new Set(
    facts.outcomeEvidence.map((e) => e.outcomeType),
  );
  return [
    { label: "supply_surface_kind", value: facts.item.surfaceKind },
    { label: "supply_format", value: facts.item.format },
    {
      label: "supply_territory_count",
      value: String(facts.item.territories.length),
    },
    {
      label: "supply_language_count",
      value: String(facts.item.languages.length),
    },
    ...requiredOutcomeTypes.map((t) => ({
      label: "evidence_present",
      value: `${t}:${covered.has(t) ? "yes" : "no"}`,
    })),
    {
      label: "owner_has_standing_snapshot",
      value: facts.reputation.standing !== null ? "yes" : "no",
    },
    {
      label: "owner_has_reliability_snapshot",
      value: facts.reputation.reliability !== null ? "yes" : "no",
    },
    {
      label: "owner_has_fraud_resistance_snapshot",
      value: facts.reputation.fraudResistance !== null ? "yes" : "no",
    },
  ];
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function createCampaignMatchingService(
  deps: CampaignMatchingServiceDeps,
): CampaignMatchingService {
  const {
    campaignRepository,
    campaignPolicyRepository,
    runRepository,
    lookups,
    advisory,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function loadCampaignWithinScope(
    organizationScopeId: string,
    campaignId: string,
  ): Promise<CampaignRecord> {
    const campaign = await campaignRepository.findById(campaignId);
    if (campaign === null || campaign.organizationScopeId !== organizationScopeId) {
      // Cross-scope or nonexistent: indistinguishable.
      throw new NotFoundError(`campaign not found: ${campaignId}`, {
        campaignId,
        organizationScopeId,
      });
    }
    return campaign;
  }

  async function loadRunWithinScope(
    organizationScopeId: string,
    id: string,
  ): Promise<CampaignMatchRunRecord> {
    const run = await runRepository.findById(id);
    if (run === null || run.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`campaign match run not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return run;
  }

  async function resolveReputationFacts(
    organizationScopeId: string,
    item: CampaignMatchInventoryItemView,
  ): Promise<{
    standing: ResolvedCampaignMatchReputationScore | null;
    reliability: ResolvedCampaignMatchReputationScore | null;
    fraudResistance: ResolvedCampaignMatchReputationScore | null;
  }> {
    const standingDimension: string =
      CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE[
        item.surfaceKind as "publisher" | "app" | "creator"
      ] ?? "inventory_quality";
    const [standing, reliability, fraudResistance] = await Promise.all([
      lookups.reputation.latestScore(
        organizationScopeId,
        item.ownerPersonId,
        standingDimension,
      ),
      lookups.reputation.latestScore(
        organizationScopeId,
        item.ownerPersonId,
        "measurement_reliability",
      ),
      lookups.reputation.latestScore(
        organizationScopeId,
        item.ownerPersonId,
        "fraud_resistance",
      ),
    ]);
    return { standing, reliability, fraudResistance };
  }

  return {
    async runCampaignMatch(
      execution,
      input,
    ): Promise<RunCampaignMatchResult> {
      assertIdempotencyKey(input.idempotencyKey);
      assertOrganizationScopeId(input.organizationScopeId);
      const actor = actingPersonId(execution);
      const explicitTargeting = validateTargeting(input.targeting ?? {});

      // Weights: explicit (validated) or the canonical default.
      const weights: CampaignMatchWeightsShape =
        input.weights === null || input.weights === undefined
          ? CAMPAIGN_MATCH_DEFAULT_WEIGHTS
          : validateCampaignMatchWeights(input.weights);

      // Advisory configuration: each consultation independently
      // disabled unless explicitly enabled (AI-002 matching, AI-003
      // risk analysis).
      const matchingEnabled = input.advisory?.matching?.enabled === true;
      const matchingMaxWeight = matchingEnabled
        ? validateCampaignMatchAdvisoryMaxWeight(
            input.advisory?.matching?.maxWeight ?? DEFAULT_ADVISORY_MAX_WEIGHT,
          )
        : 0;
      const matchingBlend = matchingEnabled ? matchingMaxWeight / 100 : 0;
      const riskEnabled = input.advisory?.risk?.enabled === true;
      const riskMaxWeight = riskEnabled
        ? validateCampaignMatchAdvisoryMaxWeight(
            input.advisory?.risk?.maxWeight ?? DEFAULT_ADVISORY_MAX_WEIGHT,
          )
        : 0;
      const riskBlend = riskEnabled ? riskMaxWeight / 100 : 0;
      if (matchingBlend > CAMPAIGN_MATCH_ADVISORY_MAX_BLEND) {
        throw matchValidationError("unreachable advisory blend bound", {
          matchingBlend,
        });
      }

      // -- the campaign subject (own domain, read-only) --------------
      const campaign = await loadCampaignWithinScope(
        input.organizationScopeId,
        input.campaignId,
      );

      // CAMP-002 (the run-level hard constraint): matching optimizes
      // placement-ready supply — the campaign must be publishable
      // (ACTIVE) with a resolvable in-scope policy version. Fail
      // closed: no partial run, no candidate consultation.
      if (
        campaign.status !== "ACTIVE"
      ) {
        throw matchValidationError(
          `campaign matching requires a publishable (ACTIVE) campaign — the campaign status is ${campaign.status} (CAMP-002: policy defined and activated before matching)`,
          { reason: "campaign_not_publishable", campaignStatus: campaign.status },
        );
      }
      const policyVersion =
        input.policyVersion ?? campaign.currentPolicyVersion;
      if (policyVersion === null || policyVersion === undefined) {
        throw matchValidationError(
          "campaign matching requires a pinned policy version — the campaign has no current policy version",
          { reason: "policy_version_unresolved", campaignId: campaign.id },
        );
      }
      const policy = await campaignPolicyRepository.findVersion(
        campaign.id,
        policyVersion,
      );
      if (policy === null) {
        throw matchValidationError(
          `policy version ${String(policyVersion)} not found for campaign ${campaign.id}`,
          { reason: "policy_version_unresolved", policyVersion },
        );
      }
      if (policy.organizationScopeId !== input.organizationScopeId) {
        throw matchValidationError(
          "the resolved policy version is outside the caller's organization scope",
          { reason: "policy_scope_out_of_tenant" },
        );
      }

      // The effective targeting: explicit ∪ campaign policy derived.
      const effectiveTargeting = mergeTargeting(explicitTargeting, policy);
      const requiredOutcomeTypes = requiredOutcomeTypesOf(policy);

      // -- candidate enumeration (tenant-scoped) ---------------------
      let items: readonly CampaignMatchInventoryItemView[];
      if (
        input.candidateInventoryItemIds !== null &&
        input.candidateInventoryItemIds !== undefined
      ) {
        if (!Array.isArray(input.candidateInventoryItemIds)) {
          throw matchValidationError(
            "candidateInventoryItemIds must be an array when provided",
            { field: "candidateInventoryItemIds" },
          );
        }
        const narrowed: CampaignMatchInventoryItemView[] = [];
        for (const itemId of input.candidateInventoryItemIds) {
          if (typeof itemId !== "string" || itemId.trim() === "") {
            throw matchValidationError(
              "candidateInventoryItemIds entries must be non-empty strings",
              { field: "candidateInventoryItemIds", itemId },
            );
          }
          const item = await lookups.supply.getItem(
            input.organizationScopeId,
            itemId.trim(),
          );
          if (item === null) {
            // Cross-scope or nonexistent: indistinguishable.
            throw new NotFoundError(
              `inventory item not found: ${itemId.trim()}`,
              { itemId: itemId.trim(), organizationScopeId: input.organizationScopeId },
            );
          }
          narrowed.push(item);
        }
        items = narrowed;
      } else {
        items = await lookups.supply.listCandidateItems(
          input.organizationScopeId,
        );
      }
      if (items.length > CAMPAIGN_MATCH_MAX_CANDIDATES) {
        throw matchValidationError(
          `a campaign match run may evaluate at most ${String(CAMPAIGN_MATCH_MAX_CANDIDATES)} supply candidates (got ${String(items.length)}) — narrow with candidateInventoryItemIds`,
          { candidateCount: items.length },
        );
      }

      // The already-placed set (read-only; explainability).
      const placedItemIds = new Set(
        await lookups.supply.placedItemIds(
          input.organizationScopeId,
          campaign.id,
        ),
      );

      // -- fact assembly (all cross-authority reads happen here) ----
      const factsList: CampaignMatchCandidateFacts[] = [];
      for (const item of items) {
        const eligibility = await lookups.supply.evaluateEligibilityRules(
          policy.eligibility.rules,
          { territories: item.territories, languages: item.languages },
        );
        const reputation = await resolveReputationFacts(
          input.organizationScopeId,
          item,
        );
        const safety = await lookups.safety.activeHold(
          input.organizationScopeId,
          item.ownerPersonId,
        );
        const outcomeEvidence = await lookups.outcomes.listVerifiedOutcomesBySubject(
          execution,
          input.organizationScopeId,
          item.id,
        );
        factsList.push({
          item,
          eligibility,
          reputation,
          safety,
          outcomeEvidence,
        });
      }

      // -- deterministic eligibility (the pure engine) --------------
      const eligibilityByItem = new Map(
        factsList.map((facts) => [
          facts.item.id,
          evaluateEligibility(facts, effectiveTargeting),
        ]),
      );
      const eligibleFacts = factsList.filter(
        (facts) => eligibilityByItem.get(facts.item.id)!.eligible,
      );

      // -- deterministic baseline ranking (advisory-off) ------------
      const baselineSignalsByItem = scoreBaselineSignals(
        eligibleFacts,
        effectiveTargeting,
        requiredOutcomeTypes,
        weights,
      );

      // -- advisory (ONLY for already-eligible candidates) -----------
      // Structural non-authority: hard-gated candidates are excluded
      // BEFORE either advisory is ever consulted; the assessments
      // only blend into the alignment/risk ranking signals.
      const matchingByItem = new Map<
        string,
        CampaignMatchAdvisoryAssessment
      >();
      const riskByItem = new Map<string, CampaignMatchAdvisoryAssessment>();
      if (matchingEnabled) {
        for (const facts of eligibleFacts) {
          const assessment = await advisory.assessMatching({
            rubricRef: `campaign-matching:${CAMPAIGN_MATCH_FORMAT}`,
            neutralFacts: buildMatchingAdvisoryFacts(
              effectiveTargeting,
              requiredOutcomeTypes,
              facts,
            ),
          });
          matchingByItem.set(facts.item.id, assessment);
        }
      }
      if (riskEnabled) {
        for (const facts of eligibleFacts) {
          const assessment = await advisory.assessRisk({
            rubricRef: `campaign-matching-risk:${CAMPAIGN_MATCH_FORMAT}`,
            neutralFacts: buildRiskAdvisoryFacts(
              facts,
              requiredOutcomeTypes,
            ),
          });
          riskByItem.set(facts.item.id, assessment);
        }
      }

      // -- final signals + orderings (the pure engine) --------------
      const scored: ScoredCandidate[] = eligibleFacts.map((facts, index) => {
        const baselineSignals = baselineSignalsByItem[index]!;
        const finalSignals = applyAdvisoryBlends(baselineSignals, {
          matching: matchingByItem.get(facts.item.id) ?? null,
          matchingBlend,
          risk: riskByItem.get(facts.item.id) ?? null,
          riskBlend,
        });
        return {
          facts,
          baselineSignals,
          finalSignals,
          baselineTotalScore: totalScoreOf(baselineSignals),
          totalScore: totalScoreOf(finalSignals),
        };
      });
      const ranked = orderCandidates(scored);
      const results: readonly CampaignMatchCandidateResult[] =
        buildCandidateResults(
          ranked,
          {
            matching: matchingEnabled && ranked.length > 0
              ? (matchingByItem.get(ranked[0]!.facts.item.id) ?? null)
              : null,
            risk: riskEnabled && ranked.length > 0
              ? (riskByItem.get(ranked[0]!.facts.item.id) ?? null)
              : null,
          },
          placedItemIds,
        );
      const excluded: readonly CampaignMatchExcludedCandidate[] =
        buildExcludedCandidates(factsList, (facts) =>
          eligibilityByItem.get(facts.item.id)!,
        );

      // -- the run record + digest ----------------------------------
      const advisoryMeta = Object.freeze({
        config: Object.freeze({
          matching: Object.freeze({
            enabled: matchingEnabled,
            maxWeight: matchingMaxWeight,
          }),
          risk: Object.freeze({
            enabled: riskEnabled,
            maxWeight: riskMaxWeight,
          }),
        }),
        matching: Object.freeze({
          used: matchingEnabled && ranked.length > 0,
          blend: round1(matchingBlend * 100) / 100,
          provider: matchingEnabled && ranked.length > 0
            ? (matchingByItem.get(ranked[0]!.facts.item.id)?.provider ?? null)
            : null,
          modelRef: matchingEnabled && ranked.length > 0
            ? (matchingByItem.get(ranked[0]!.facts.item.id)?.modelRef ?? null)
            : null,
        }),
        risk: Object.freeze({
          used: riskEnabled && ranked.length > 0,
          blend: round1(riskBlend * 100) / 100,
          provider: riskEnabled && ranked.length > 0
            ? (riskByItem.get(ranked[0]!.facts.item.id)?.provider ?? null)
            : null,
          modelRef: riskEnabled && ranked.length > 0
            ? (riskByItem.get(ranked[0]!.facts.item.id)?.modelRef ?? null)
            : null,
        }),
      });

      const core = {
        organizationScopeId: input.organizationScopeId,
        formatVersion: CAMPAIGN_MATCH_FORMAT,
        campaign: Object.freeze({
          campaignId: campaign.id,
          policyVersion: policy.version,
        }),
        targeting: effectiveTargeting,
        requiredOutcomeTypes,
        weights,
        advisory: advisoryMeta,
        candidateCount: factsList.length,
        eligibleCount: ranked.length,
        results,
        excluded,
      };
      const digest = computeMatchDigest(core);

      const key = `campaign_match_run:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const run: CampaignMatchRunRecord = Object.freeze({
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
            eventType: CAMPAIGN_MATCH_RECORDED,
            context: execution,
            actor,
            subject: run.id,
            resourceType: "campaign_match_run",
            resourceId: run.id,
            metadata: {
              organizationScopeId: run.organizationScopeId,
              campaign: run.campaign,
              candidateCount: run.candidateCount,
              eligibleCount: run.eligibleCount,
              digest: run.digest,
              advisoryMatchingUsed: run.advisory.matching.used,
              advisoryRiskUsed: run.advisory.risk.used,
              advisoryProvider: run.advisory.matching.provider,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return run;
        },
        execution,
      );
      logger.info("campaign_match.recorded", {
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

// Re-exported for the bootstrap composition root (tree-shakeable).
export type { OpenConError };
