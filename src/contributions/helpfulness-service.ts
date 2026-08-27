/**
 * HelpfulnessService — the NET-W012 helpful-contribution domain
 * service.
 *
 * Work order ref: spec/work-orders/NET-W012.md §3.2–§3.5.
 *
 * Tier compliance: this file is in the `contributions` domain
 * boundary. It imports ONLY:
 *   - its own port + repository + engine (self, same dir — allowed);
 *   - core contracts (`../core/*`, allowed).
 * It does NOT import infrastructure or any other domain. Every
 * cross-boundary read goes through the NEUTRAL read-only lookups
 * declared in the port and wired by the bootstrap composition root.
 *
 * Authority separation (work order §4 invariant 6 — mechanical):
 *  - this service NEVER mutates lifecycle state: publication
 *    transitions are requested by the composition root through the
 *    WorkflowService; `recordPublication` only RECORDS what the
 *    workflow authority already executed;
 *  - this service never posts ledger movements, never creates
 *    evidence/outcomes/campaigns/reputation records — it READS the
 *    truth authorities through lookups and VERIFIES references;
 *  - every material mutation runs through the NET-W004
 *    IdempotencyStore primitive (exactly-once atomic commit +
 *    transactional audit lineage), with per-record mutexes and in-tx
 *    state re-checks.
 */

import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { Logger } from "../core/logger.ts";
import {
  HELPFULNESS_POLICY_FORMAT,
  evaluateCampaignEligibility,
  isDisclosureRelationshipKind,
  isHelpfulAdvisoryKind,
  isHelpfulContributionKind,
  isHelpfulnessBasisKind,
  isQualifyingHelpfulnessSourceType,
  validateHelpfulnessAdvisoryWeight,
  validateHelpfulnessConfidence,
  validateHelpfulnessCount,
  assertHelpfulnessEvidenceGrade,
  assertHelpfulnessOutcomeTypes,
  assertHelpfulnessSourceTypes,
} from "../core/contributions.ts";
import type { HelpfulEligibilityRule } from "../core/contributions.ts";
import { EVIDENCE_GRADE_RANK } from "../core/evidence.ts";
import { CONTRIBUTIONS_COLLECTION } from "./authority-contribution-repository.ts";
import {
  evaluateProofOfHelpfulness,
  type PohBasisInput,
  type PohBasisResolution,
  type PohPolicyView,
} from "./poh-engine.ts";
import type {
  CommercialDisclosureRecord,
  CommercialDisclosureRepository,
  Contribution,
  ContributionRepository,
  CreateHelpfulContributionInput,
  CreateHelpfulContributionResult,
  DeclareDisclosureInput,
  DefineHelpfulnessPolicyInput,
  DefineHelpfulnessPolicyResult,
  EvaluateHelpfulnessInput,
  HelpfulnessLookups,
  HelpfulnessPolicy,
  HelpfulnessPolicyRepository,
  HelpfulnessPolicySections,
  HelpfulnessService,
  HelpfulSubmission,
  PrepareRecommendationInput,
  ProofOfHelpfulness,
  ProofOfHelpfulnessRepository,
  RecordPublicationInput,
  AttachAdvisoryScoreInput,
  AttachBasisInput,
  RetractDisclosureInput,
} from "./port.ts";

const HELPFUL_CONTRIBUTION_CREATED = "helpful_contribution.created" as const;
const HELPFUL_RECOMMENDATION_PREPARED = "helpful_recommendation.prepared" as const;
const HELPFUL_CONTRIBUTION_PUBLISHED = "helpful_contribution.published" as const;
const HELPFUL_DISCLOSURE_DECLARED = "helpful_disclosure.declared" as const;
const HELPFUL_DISCLOSURE_RETRACTED = "helpful_disclosure.retracted" as const;
const HELPFULNESS_POLICY_DEFINED = "helpfulness_policy.defined" as const;
const HELPFULNESS_BASIS_ATTACHED = "helpfulness_basis.attached" as const;
const HELPFULNESS_ADVISORY_RECORDED = "helpfulness_advisory.recorded" as const;
const PROOF_OF_HELPFULNESS_EVALUATED = "proof_of_helpfulness.evaluated" as const;

/** The publication milestone (the user-controlled gate's target). */
const PUBLISHED_STATE = "SUBMITTED";

/** States at or beyond which a contribution counts as published. */
const LIFECYCLE_ORDER = [
  "DRAFT",
  "READY",
  "ASSIGNED",
  "IN_PROGRESS",
  "SUBMITTED",
  "MEASURING",
  "EVALUATING",
  "CHALLENGE_WINDOW",
  "SETTLING",
  "SETTLED",
  "VERIFIED",
] as readonly string[];

function isPublished(state: string): boolean {
  return LIFECYCLE_ORDER.indexOf(state) >= LIFECYCLE_ORDER.indexOf(PUBLISHED_STATE);
}

function helpfulnessError(
  code: string,
  classification: "validation" | "authorization",
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({ code, classification, message, context });
}

function validationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return helpfulnessError(
    "HELPFUL_CONTRIBUTION_VALIDATION",
    "validation",
    message,
    context,
  );
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw validationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/** The acting person's id (mutations that require a person actor). */
function actingPersonId(execution: ExecutionContext, what: string): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw helpfulnessError(
      "HELPFUL_CONTRIBUTION_FORBIDDEN",
      "authorization",
      `an authenticated person actor is required to ${what} (service/system actors cannot)`,
      { actorKind: execution.actor?.kind ?? null, action: what },
    );
  }
  return execution.actor.id;
}

/** The acting actor's id (any kind — advisory/basis recording). */
function actingActorId(execution: ExecutionContext): string {
  return execution.actor?.id ?? "anonymous";
}

function pohLockKey(proofOfHelpfulnessId: string): string {
  return `proof_of_helpfulness:${proofOfHelpfulnessId}`;
}

function disclosureLockKey(disclosureId: string): string {
  return `commercial_disclosure:${disclosureId}`;
}

function helpfulnessPolicyLineageLockKey(policyId: string): string {
  return `helpfulness_policy_lineage:${policyId}`;
}

/** Validate the structured helpful submission (pure shape checks). */
function validateSubmission(submission: HelpfulSubmission): void {
  if (!submission || typeof submission !== "object") {
    throw validationError("submission is required", { field: "submission" });
  }
  if (
    submission.claimantAttributes === null ||
    typeof submission.claimantAttributes !== "object" ||
    Array.isArray(submission.claimantAttributes)
  ) {
    throw validationError(
      "submission.claimantAttributes must be a record of attribute → string[]",
      { field: "claimantAttributes" },
    );
  }
  for (const [attribute, values] of Object.entries(
    submission.claimantAttributes,
  )) {
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
      throw validationError(
        `claimantAttributes.${attribute} must be a string array`,
        { field: `claimantAttributes.${attribute}` },
      );
    }
  }
  if (!Array.isArray(submission.mentions)) {
    throw validationError("submission.mentions must be an array", {
      field: "mentions",
    });
  }
  for (const [i, mention] of submission.mentions.entries()) {
    if (!mention || typeof mention !== "object") {
      throw validationError(`mentions[${String(i)}] must be an object`, {
        field: `mentions[${String(i)}]`,
      });
    }
    if (!mention.productRef?.trim()) {
      throw validationError(
        `mentions[${String(i)}].productRef is required`,
        { field: `mentions[${String(i)}].productRef` },
      );
    }
    if (typeof mention.disclosed !== "boolean") {
      throw validationError(
        `mentions[${String(i)}].disclosed must be a boolean`,
        { field: `mentions[${String(i)}].disclosed` },
      );
    }
    if (
      mention.commercialRelationshipRef !== null &&
      !mention.commercialRelationshipRef?.trim()
    ) {
      throw validationError(
        `mentions[${String(i)}].commercialRelationshipRef must be a non-empty key or null`,
        { field: `mentions[${String(i)}].commercialRelationshipRef` },
      );
    }
  }
}

/** Validate the helpfulness policy sections (deterministic criteria). */
function validatePolicySections(sections: HelpfulnessPolicySections): HelpfulnessPolicySections {
  if (!sections || typeof sections !== "object") {
    throw validationError("policy sections are required", { field: "sections" });
  }
  if (
    !Array.isArray(sections.qualifyingBasisKinds) ||
    sections.qualifyingBasisKinds.length === 0 ||
    !sections.qualifyingBasisKinds.every(isHelpfulnessBasisKind)
  ) {
    throw validationError(
      "qualifyingBasisKinds must be a non-empty subset of the frozen basis kinds (proof_of_value, measured_outcome, evidence_record)",
      { field: "qualifyingBasisKinds" },
    );
  }
  assertHelpfulnessEvidenceGrade("minimumGrade", sections.minimumGrade);
  // Lower rank = STRONGER (MEASURED=1 … SELF_REPORTED=5). The policy
  // minimum must be an actually-qualifying grade: MEASURED, ATTESTED
  // or PROVIDER_REPORTED — MODEL_ASSESSED and SELF_REPORTED evidence
  // are advisory-only and can never be the policy minimum.
  if (EVIDENCE_GRADE_RANK[sections.minimumGrade] > EVIDENCE_GRADE_RANK.PROVIDER_REPORTED) {
    throw validationError(
      `minimumGrade must be MEASURED, ATTESTED or PROVIDER_REPORTED (got ${String(sections.minimumGrade)}) — MODEL_ASSESSED and SELF_REPORTED evidence are advisory-only and can never be the policy minimum`,
      { field: "minimumGrade", minimumGrade: sections.minimumGrade },
    );
  }
  if (
    !Array.isArray(sections.qualifyingSourceTypes) ||
    sections.qualifyingSourceTypes.length === 0
  ) {
    throw validationError(
      "qualifyingSourceTypes must be a non-empty array",
      { field: "qualifyingSourceTypes" },
    );
  }
  assertHelpfulnessSourceTypes("qualifyingSourceTypes", sections.qualifyingSourceTypes);
  for (const sourceType of sections.qualifyingSourceTypes) {
    if (!isQualifyingHelpfulnessSourceType(sourceType)) {
      throw validationError(
        `qualifyingSourceTypes includes '${String(sourceType)}' — model and self evidence NEVER qualify (AI is advisory)`,
        { field: "qualifyingSourceTypes", sourceType },
      );
    }
  }
  if (
    !Array.isArray(sections.qualifyingOutcomeTypes) ||
    sections.qualifyingOutcomeTypes.length === 0
  ) {
    throw validationError(
      "qualifyingOutcomeTypes must be a non-empty array of standard outcome types",
      { field: "qualifyingOutcomeTypes" },
    );
  }
  assertHelpfulnessOutcomeTypes("qualifyingOutcomeTypes", sections.qualifyingOutcomeTypes);
  validateHelpfulnessConfidence("minimumConfidence", sections.minimumConfidence);
  validateHelpfulnessCount("minimumIndependentSources", sections.minimumIndependentSources);
  validateHelpfulnessCount("minimumQualifyingBases", sections.minimumQualifyingBases);
  if (
    !sections.advisory ||
    typeof sections.advisory !== "object" ||
    !Array.isArray(sections.advisory.allowedKinds) ||
    !sections.advisory.allowedKinds.every(isHelpfulAdvisoryKind)
  ) {
    throw validationError(
      "advisory.allowedKinds must be an array of advisory kinds (model_score, heuristic_score)",
      { field: "advisory.allowedKinds" },
    );
  }
  validateHelpfulnessAdvisoryWeight(
    "advisory.maxAdvisoryWeight",
    sections.advisory.maxAdvisoryWeight,
  );
  if (typeof sections.requiresDisclosure !== "boolean") {
    throw validationError("requiresDisclosure must be a boolean", {
      field: "requiresDisclosure",
    });
  }
  if (typeof sections.description !== "string" || !sections.description.trim()) {
    throw validationError("description is required", { field: "description" });
  }
  return sections;
}

export interface HelpfulnessServiceDeps {
  readonly contributionRepository: ContributionRepository;
  readonly policyRepository: HelpfulnessPolicyRepository;
  readonly pohRepository: ProofOfHelpfulnessRepository;
  readonly disclosureRepository: CommercialDisclosureRepository;
  readonly lookups: HelpfulnessLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createHelpfulnessService(
  deps: HelpfulnessServiceDeps,
): HelpfulnessService {
  const {
    contributionRepository,
    policyRepository,
    pohRepository,
    disclosureRepository,
    lookups,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /** Load a contribution (any actor; tenant checks at mutation). */
  async function loadContribution(id: string): Promise<Contribution> {
    const found = await contributionRepository.findById(id);
    if (!found) {
      throw new NotFoundError(`contribution not found: ${id}`, {
        contributionId: id,
      });
    }
    return found;
  }

  /** Load the (1:1) Proof-of-Helpfulness for a contribution. */
  async function loadPoh(contributionId: string): Promise<ProofOfHelpfulness> {
    const found = await pohRepository.findByContributionId(contributionId);
    if (!found) {
      throw new NotFoundError(
        `proof-of-helpfulness not found for contribution ${contributionId}`,
        { contributionId },
      );
    }
    return found;
  }

  /** Load the pinned policy version for a PoH. */
  async function loadPinnedPolicy(poh: ProofOfHelpfulness): Promise<HelpfulnessPolicy> {
    const policy = await policyRepository.findVersion(
      poh.helpfulnessPolicyId,
      poh.helpfulnessPolicyVersion,
    );
    if (!policy) {
      throw new NotFoundError(
        `pinned helpfulness policy ${poh.helpfulnessPolicyId}:v${String(poh.helpfulnessPolicyVersion)} not found`,
        {
          policyId: poh.helpfulnessPolicyId,
          version: poh.helpfulnessPolicyVersion,
        },
      );
    }
    return policy;
  }

  /**
   * Disclosure compliance: every mention carrying a commercial
   * relationship key must resolve to a DECLARED (non-retracted)
   * disclosure on the same contribution, same organization, filed by
   * the contributor, whose relationshipRef equals the key.
   */
  async function computeDisclosureCompliance(
    poh: ProofOfHelpfulness,
  ): Promise<{ compliant: boolean; hasCommercialMentions: boolean; missing: readonly string[] }> {
    const commercialKeys = poh.mentions
      .map((m) => m.commercialRelationshipRef)
      .filter((k): k is string => k !== null);
    if (commercialKeys.length === 0) {
      return { compliant: true, hasCommercialMentions: false, missing: [] };
    }
    const disclosures = await disclosureRepository.listByContribution(
      poh.contributionId,
    );
    const active = new Set(
      disclosures
        .filter(
          (d) =>
            d.state === "DECLARED" &&
            d.organizationScopeId === poh.organizationScopeId &&
            d.contributorId === poh.contributorId,
        )
        .map((d) => d.relationshipRef),
    );
    const missing = commercialKeys.filter((k) => !active.has(k));
    return {
      compliant: missing.length === 0,
      hasCommercialMentions: true,
      missing,
    };
  }

  /** Resolve one basis into the engine's resolution view (lookup). */
  async function resolveBasis(
    kind: AttachBasisInput["kind"],
    referenceId: string,
  ): Promise<PohBasisResolution | null> {
    switch (kind) {
      case "evidence_record": {
        const r = await lookups.evidence.resolveEvidence(referenceId);
        if (!r) return null;
        return {
          organizationScopeId: r.organizationScopeId,
          subjectId: r.subjectId,
          subjectType: r.subjectType,
          sourceType: r.sourceType,
          grade: r.grade,
          confidencePoint: r.confidence.point,
          provenanceKey: r.provenanceSourceId ?? referenceId,
        };
      }
      case "measured_outcome": {
        const r = await lookups.measurement.resolveMeasuredOutcome(referenceId);
        if (!r) return null;
        return {
          organizationScopeId: r.organizationScopeId,
          subjectId: r.subjectId,
          subjectType: r.subjectType,
          outcomeType: r.outcomeType,
          state: r.state,
          rollupConfidencePoint: r.rollupConfidence?.point ?? null,
        };
      }
      case "proof_of_value": {
        const r = await lookups.proofOfValue.resolveProofOfValue(referenceId);
        if (!r) return null;
        return {
          organizationScopeId: r.organizationScopeId,
          subjectId: r.subjectId,
          subjectType: r.subjectType,
          state: r.state,
        };
      }
      default:
        return null;
    }
  }

  const service: HelpfulnessService = {
    // ------------------------------------------------------------------
    // Helpfulness policy lineage (deterministic criteria).
    // ------------------------------------------------------------------
    async defineHelpfulnessPolicy(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.policyId?.trim()) {
        throw validationError("policyId is required", { field: "policyId" });
      }
      const actor = actingPersonId(execution, "define helpfulness policies");
      const sections = validatePolicySections(input.sections);

      const key = `helpfulness_policy:${input.organizationScopeId}:${input.idempotencyKey}`;
      // The org-INDEPENDENT lineage mutex (the NET-W007/008/010/011
      // pattern): serializes version creation so version = latest+1
      // can never fork — INCLUDING across organization scopes (the
      // cross-scope fork rejection below).
      const applied = await idempotency.withLock(
        helpfulnessPolicyLineageLockKey(input.policyId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const latest = await policyRepository.findLatestWithinTx(
              input.policyId,
              tx,
            );
            if (latest !== null && latest.organizationScopeId !== input.organizationScopeId) {
              throw helpfulnessError(
                "HELPFULNESS_POLICY_VALIDATION",
                "validation",
                `helpfulness policy lineage ${input.policyId} already belongs to organization scope ${latest.organizationScopeId} (cross-scope lineage fork rejected, including the first version)`,
                {
                  policyId: input.policyId,
                  existingScope: latest.organizationScopeId,
                  requestedScope: input.organizationScopeId,
                },
              );
            }
            const version = latest === null ? 1 : latest.version + 1;
            const policy: HelpfulnessPolicy = Object.freeze({
              id: randomUUID(),
              policyId: input.policyId,
              organizationScopeId: input.organizationScopeId,
              version,
              formatVersion: HELPFULNESS_POLICY_FORMAT,
              sections: Object.freeze({
                ...sections,
                qualifyingBasisKinds: Object.freeze([
                  ...sections.qualifyingBasisKinds,
                ]),
                qualifyingSourceTypes: Object.freeze([
                  ...sections.qualifyingSourceTypes,
                ]),
                qualifyingOutcomeTypes: Object.freeze([
                  ...sections.qualifyingOutcomeTypes,
                ]),
                advisory: Object.freeze({
                  allowedKinds: Object.freeze([
                    ...sections.advisory.allowedKinds,
                  ]),
                  maxAdvisoryWeight: sections.advisory.maxAdvisoryWeight,
                }),
              }),
              createdBy: actor,
              createdAt: new Date().toISOString(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await policyRepository.createWithinTx(policy, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: HELPFULNESS_POLICY_DEFINED,
              context: execution,
              actor,
              subject: policy.id,
              resourceType: "helpfulness_policy",
              resourceId: policy.id,
              metadata: {
                policyId: policy.policyId,
                version: policy.version,
                organizationScopeId: policy.organizationScopeId,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return policy;
          }, execution),
      );
      logger.info("helpfulness_policy.defined", {
        policyId: applied.result.policyId,
        version: applied.result.version,
        created: applied.executed,
      });
      return { policy: applied.result, created: applied.executed };
    },

    async getPolicyVersion(_execution, policyId, version) {
      const policy = await policyRepository.findVersion(policyId, version);
      if (!policy) {
        throw new NotFoundError(
          `helpfulness policy version not found: ${policyId}:v${String(version)}`,
          { policyId, version },
        );
      }
      return policy;
    },

    async listPolicyVersions(_execution, policyId) {
      return policyRepository.listByPolicyId(policyId);
    },

    // ------------------------------------------------------------------
    // Helpful contribution creation (Contribution + PoH atomically).
    // ------------------------------------------------------------------
    async createHelpfulContribution(
      execution,
      input,
    ): Promise<CreateHelpfulContributionResult> {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.opportunityId?.trim()) {
        throw validationError("opportunityId is required", {
          field: "opportunityId",
        });
      }
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!isHelpfulContributionKind(input.contributionType ?? "")) {
        throw validationError(
          `contributionType must be a helpful contribution kind (helpful_recommendation, helpful_guidance, helpful_answer, helpful_comparison — got ${String(input.contributionType)})`,
          { field: "contributionType", contributionType: input.contributionType },
        );
      }
      if (!input.helpfulnessPolicyId?.trim()) {
        throw validationError("helpfulnessPolicyId is required", {
          field: "helpfulnessPolicyId",
        });
      }
      validateSubmission(input.submission);
      const contributor = actingPersonId(
        execution,
        "create helpful contributions",
      );
      if (contributor !== input.contributorId) {
        throw helpfulnessError(
          "HELPFUL_CONTRIBUTION_FORBIDDEN",
          "authorization",
          `person ${contributor} cannot create a helpful contribution on behalf of ${input.contributorId} (the contributor is the actor)`,
          { actorPersonId: contributor, contributorId: input.contributorId },
        );
      }

      // The opportunity must resolve, same org, helpful-typed.
      const opportunity = await lookups.opportunity.resolveOpportunity(
        input.opportunityId,
      );
      if (opportunity === null) {
        throw new NotFoundError(
          `opportunity not found: ${input.opportunityId}`,
          { opportunityId: input.opportunityId },
        );
      }
      if (opportunity.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `opportunity ${input.opportunityId} belongs to organization scope ${opportunity.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            opportunityId: input.opportunityId,
            opportunityScope: opportunity.organizationScopeId,
            contributionScope: input.organizationScopeId,
          },
        );
      }
      // AC-01: helpful-contribution OPPORTUNITY types are explicit.
      if (
        !isHelpfulContributionKind(opportunity.opportunityType)
      ) {
        throw validationError(
          `opportunity ${input.opportunityId} is not a helpful opportunity (type '${opportunity.opportunityType}'; expected a helpful_* type)`,
          {
            opportunityId: input.opportunityId,
            opportunityType: opportunity.opportunityType,
          },
        );
      }

      // The FIRST consumer of the NET-W011 eligibility-policy
      // reference: fail-closed enforcement (work order §3.1).
      let eligibility: ProofOfHelpfulness["eligibility"] = null;
      if (opportunity.eligibilityPolicyReference !== null) {
        const resolved = await lookups.campaign.resolveEligibilityPolicy(
          opportunity.eligibilityPolicyReference,
        );
        if (resolved === null) {
          throw validationError(
            `the opportunity's eligibility policy reference '${opportunity.eligibilityPolicyReference}' does not resolve in the campaign authority (fail-closed)`,
            {
              eligibilityPolicyReference:
                opportunity.eligibilityPolicyReference,
            },
          );
        }
        if (resolved.organizationScopeId !== input.organizationScopeId) {
          throw validationError(
            `the eligibility policy reference belongs to organization scope ${resolved.organizationScopeId}, not ${input.organizationScopeId} (fail-closed)`,
            { eligibilityPolicyReference: opportunity.eligibilityPolicyReference },
          );
        }
        if (resolved.campaignStatus !== "ACTIVE") {
          throw validationError(
            `the referencing campaign is not ACTIVE (${resolved.campaignStatus}) — contributions against its opportunities are not eligible (fail-closed)`,
            {
              campaignStatus: resolved.campaignStatus,
              eligibilityPolicyReference:
                opportunity.eligibilityPolicyReference,
            },
          );
        }
        const evaluation = evaluateCampaignEligibility(
          resolved.rules as readonly HelpfulEligibilityRule[],
          input.submission.claimantAttributes,
        );
        eligibility = Object.freeze({
          eligibilityPolicyReference: opportunity.eligibilityPolicyReference,
          campaignId: resolved.campaignId,
          policyVersion: resolved.policyVersion,
          specId: resolved.specId,
          campaignStatus: resolved.campaignStatus,
          evaluatedAt: new Date().toISOString(),
          eligible: evaluation.eligible,
          failures: Object.freeze([...evaluation.failures]),
        });
        if (!evaluation.eligible) {
          throw validationError(
            `claimant is not eligible for this opportunity: ${evaluation.failures.join("; ")} (fail-closed)`,
            {
              eligibilityPolicyReference:
                opportunity.eligibilityPolicyReference,
              failures: evaluation.failures,
            },
          );
        }
      }

      // The helpfulness policy must exist in the same org; the LATEST
      // version is pinned at creation (re-read in-tx below).
      const latestPolicy = await policyRepository.listByPolicyId(
        input.helpfulnessPolicyId,
      );
      const sameOrg = latestPolicy.find(
        (p) => p.organizationScopeId === input.organizationScopeId,
      );
      if (latestPolicy.length === 0 || !sameOrg) {
        throw validationError(
          `helpfulness policy ${input.helpfulnessPolicyId} does not resolve in organization scope ${input.organizationScopeId}`,
          { policyId: input.helpfulnessPolicyId },
        );
      }

      const key = `helpful_contribution_create:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const now = new Date().toISOString();
          // Pin the policy version in-tx (consistency under racing
          // policy definitions).
          const pinned =
            (await policyRepository.findLatestWithinTx(
              input.helpfulnessPolicyId,
              tx,
            )) ?? sameOrg;
          const contributionId = randomUUID();
          const submissionPayload = Object.freeze({
            kind: "helpful",
            claimantAttributes: Object.freeze({
              ...input.submission.claimantAttributes,
            }),
            mentions: Object.freeze([...input.submission.mentions]),
            contentRef: input.submission.contentRef ?? null,
            channel: input.submission.channel ?? null,
            helpfulnessPolicyId: input.helpfulnessPolicyId,
            helpfulnessPolicyVersion: pinned.version,
          });
          const contribution: Contribution = Object.freeze({
            id: contributionId,
            kind: "contribution",
            state: "DRAFT",
            version: 0,
            organizationScopeId: input.organizationScopeId,
            ownerId: contributor,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            createdAt: now,
            updatedAt: now,
            opportunityId: input.opportunityId,
            contributorId: input.contributorId,
            contributionType: input.contributionType,
            submission: submissionPayload,
            evidenceReferencePlaceholders: [],
          });
          // The Contribution (workflow lifecycle subject, DRAFT v0)
          // and the PoH (domain aggregate, PENDING) commit in ONE
          // transaction (atomicity — work order §4 invariant 7).
          await tx.put(CONTRIBUTIONS_COLLECTION, contribution.id, contribution);
          const poh: ProofOfHelpfulness = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            contributionId: contribution.id,
            contributorId: contributor,
            helpfulnessPolicyId: pinned.policyId,
            helpfulnessPolicyVersion: pinned.version,
            formatVersion: HELPFULNESS_POLICY_FORMAT,
            eligibility,
            mentions: Object.freeze([...input.submission.mentions]),
            disclosureIds: Object.freeze([]),
            advisoryScores: Object.freeze([]),
            bases: Object.freeze([]),
            evaluations: Object.freeze([]),
            recommendations: Object.freeze([]),
            publication: null,
            state: "PENDING",
            events: Object.freeze(["created"]),
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            createdAt: now,
            updatedAt: now,
          });
          await pohRepository.createWithinTx(poh, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: HELPFUL_CONTRIBUTION_CREATED,
            context: execution,
            actor: contributor,
            subject: poh.id,
            resourceType: "proof_of_helpfulness",
            resourceId: poh.id,
            metadata: {
              contributionId: contribution.id,
              opportunityId: contribution.opportunityId,
              contributorId: contributor,
              organizationScopeId: input.organizationScopeId,
              contributionType: input.contributionType,
              mentionCount: input.submission.mentions.length,
              eligible: eligibility?.eligible ?? null,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return { contribution, proofOfHelpfulness: poh };
        },
        execution,
      );
      logger.info("helpful_contribution.created", {
        contributionId: applied.result.contribution.id,
        pohId: applied.result.proofOfHelpfulness.id,
        created: applied.executed,
      });
      return { ...applied.result, created: applied.executed };
    },

    async getHelpfulContribution(_execution, contributionId) {
      const contribution = await loadContribution(contributionId);
      const poh = await loadPoh(contributionId);
      return { contribution, proofOfHelpfulness: poh };
    },

    async getProofOfHelpfulness(_execution, contributionId) {
      return loadPoh(contributionId);
    },

    // ------------------------------------------------------------------
    // Protocol-prepared recommendations (never publishes).
    // ------------------------------------------------------------------
    async prepareRecommendation(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!input.preparedContentRef?.trim()) {
        throw validationError("preparedContentRef is required", {
          field: "preparedContentRef",
        });
      }
      const actor = actingPersonId(execution, "prepare recommendations");
      const contribution = await loadContribution(input.contributionId);
      const poh = await loadPoh(input.contributionId);

      const key = `helpful_recommendation:${poh.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(pohLockKey(poh.id), () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx = await pohRepository.findByIdWithinTx(poh.id, tx);
          if (!inTx) {
            throw new NotFoundError(
              `proof-of-helpfulness not found: ${poh.id}`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          const current = await contributionRepository.getByIdWithinTx(
            contribution.id,
            tx,
          );
          const state = current?.state ?? contribution.state;
          // INVARIANT 4 (publication is user-controlled): preparing a
          // recommendation NEVER transitions lifecycle state — and is
          // only meaningful BEFORE publication.
          if (isPublished(state)) {
            throw new ConflictError(
              `contribution ${contribution.id} is already published (${state}) — recommendations can only be prepared before publication`,
              { contributionId: contribution.id, state },
            );
          }
          const now = new Date().toISOString();
          const updated: ProofOfHelpfulness = Object.freeze({
            ...inTx,
            recommendations: Object.freeze([
              ...inTx.recommendations,
              Object.freeze({
                preparedContentRef: input.preparedContentRef.trim(),
                rationale: input.rationale?.trim() || null,
                preparedAt: now,
                preparedBy: actor,
              }),
            ]),
            events: Object.freeze([...inTx.events, "recommendation_prepared"]),
            updatedAt: now,
          });
          await pohRepository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: HELPFUL_RECOMMENDATION_PREPARED,
            context: execution,
            actor,
            subject: updated.id,
            resourceType: "proof_of_helpfulness",
            resourceId: updated.id,
            metadata: {
              contributionId: contribution.id,
              preparedContentRef: input.preparedContentRef,
              contributionState: state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        }, execution),
      );
      logger.info("helpful_recommendation.prepared", {
        contributionId: contribution.id,
        pohId: applied.result.id,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Commercial disclosures (first-class, auditable).
    // ------------------------------------------------------------------
    async declareDisclosure(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!isDisclosureRelationshipKind(input.relationshipKind ?? "")) {
        throw validationError(
          `relationshipKind must be a frozen commercial-relationship kind (got ${String(input.relationshipKind)})`,
          { field: "relationshipKind", relationshipKind: input.relationshipKind },
        );
      }
      if (!input.relationshipRef?.trim()) {
        throw validationError("relationshipRef is required", {
          field: "relationshipRef",
        });
      }
      if (!input.counterpartyRef?.trim()) {
        throw validationError("counterpartyRef is required", {
          field: "counterpartyRef",
        });
      }
      const actor = actingPersonId(execution, "declare disclosures");
      const contribution = await loadContribution(input.contributionId);
      const poh = await loadPoh(input.contributionId);
      if (actor !== contribution.contributorId) {
        throw helpfulnessError(
          "HELPFUL_CONTRIBUTION_FORBIDDEN",
          "authorization",
          `person ${actor} is not the contributor of contribution ${contribution.id} (only the contributor declares its commercial disclosures)`,
          { actorPersonId: actor, contributorId: contribution.contributorId },
        );
      }
      if (contribution.organizationScopeId !== poh.organizationScopeId) {
        throw validationError("organization scope mismatch", {
          contributionId: contribution.id,
        });
      }

      const key = `helpful_disclosure:${poh.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(pohLockKey(poh.id), () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx = await pohRepository.findByIdWithinTx(poh.id, tx);
          if (!inTx) {
            throw new NotFoundError(
              `proof-of-helpfulness not found: ${poh.id}`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          const now = new Date().toISOString();
          const disclosure: CommercialDisclosureRecord = Object.freeze({
            id: randomUUID(),
            organizationScopeId: inTx.organizationScopeId,
            contributionId: contribution.id,
            contributorId: contribution.contributorId,
            relationshipKind: input.relationshipKind,
            relationshipRef: input.relationshipRef.trim(),
            productRef: input.productRef?.trim() || null,
            counterpartyRef: input.counterpartyRef.trim(),
            description: input.description?.trim() || null,
            state: "DECLARED",
            events: Object.freeze(["declared"]),
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            createdAt: now,
            updatedAt: now,
          });
          await disclosureRepository.createWithinTx(disclosure, tx);
          const updated: ProofOfHelpfulness = Object.freeze({
            ...inTx,
            disclosureIds: Object.freeze([
              ...inTx.disclosureIds,
              disclosure.id,
            ]),
            events: Object.freeze([
              ...inTx.events,
              "disclosure_declared",
            ]),
            updatedAt: now,
          });
          await pohRepository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: HELPFUL_DISCLOSURE_DECLARED,
            context: execution,
            actor,
            subject: disclosure.id,
            resourceType: "commercial_disclosure",
            resourceId: disclosure.id,
            metadata: {
              contributionId: contribution.id,
              relationshipKind: disclosure.relationshipKind,
              relationshipRef: disclosure.relationshipRef,
              counterpartyRef: disclosure.counterpartyRef,
              organizationScopeId: disclosure.organizationScopeId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return disclosure;
        }, execution),
      );
      logger.info("helpful_disclosure.declared", {
        disclosureId: applied.result.id,
        contributionId: contribution.id,
      });
      return applied.result;
    },

    async retractDisclosure(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.disclosureId?.trim()) {
        throw validationError("disclosureId is required", {
          field: "disclosureId",
        });
      }
      const actor = actingPersonId(execution, "retract disclosures");
      const disclosure = await disclosureRepository.findById(
        input.disclosureId,
      );
      if (!disclosure) {
        throw new NotFoundError(
          `disclosure not found: ${input.disclosureId}`,
          { disclosureId: input.disclosureId },
        );
      }
      if (actor !== disclosure.contributorId) {
        throw helpfulnessError(
          "HELPFUL_CONTRIBUTION_FORBIDDEN",
          "authorization",
          `person ${actor} is not the contributor who declared disclosure ${disclosure.id}`,
          { actorPersonId: actor, contributorId: disclosure.contributorId },
        );
      }

      const key = `helpful_disclosure_retract:${disclosure.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disclosureLockKey(disclosure.id),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const inTx = await disclosureRepository.findByIdWithinTx(
              disclosure.id,
              tx,
            );
            if (!inTx) {
              throw new NotFoundError(
                `disclosure not found: ${disclosure.id}`,
                { disclosureId: disclosure.id },
              );
            }
            if (inTx.state === "RETRACTED") {
              // Replay tolerance: an already-retracted disclosure is
              // idempotently returned for a fresh key only via this
              // explicit pass-through error contract.
              throw new ConflictError(
                `disclosure ${inTx.id} is already RETRACTED (terminal)`,
                { disclosureId: inTx.id },
              );
            }
            const now = new Date().toISOString();
            const updated: CommercialDisclosureRecord = Object.freeze({
              ...inTx,
              state: "RETRACTED",
              events: Object.freeze([...inTx.events, "retracted"]),
              updatedAt: now,
            });
            await disclosureRepository.saveWithinTx(updated, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: HELPFUL_DISCLOSURE_RETRACTED,
              context: execution,
              actor,
              subject: updated.id,
              resourceType: "commercial_disclosure",
              resourceId: updated.id,
              metadata: {
                contributionId: updated.contributionId,
                relationshipRef: updated.relationshipRef,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return updated;
          }, execution),
      );
      logger.info("helpful_disclosure.retracted", {
        disclosureId: applied.result.id,
      });
      return applied.result;
    },

    async listDisclosures(_execution, contributionId) {
      return disclosureRepository.listByContribution(contributionId);
    },

    // ------------------------------------------------------------------
    // Advisory scores (AI is advisory — never qualifying).
    // ------------------------------------------------------------------
    async attachAdvisoryScore(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!isHelpfulAdvisoryKind(input.kind ?? "")) {
        throw validationError(
          `kind must be an advisory kind (model_score, heuristic_score — got ${String(input.kind)})`,
          { field: "kind", kind: input.kind },
        );
      }
      if (!input.methodRef?.trim() || !input.methodVersion?.trim()) {
        throw validationError(
          "methodRef AND methodVersion are required (model/method identity is never collapsed — the frozen measurement rule)",
          { field: "methodRef/methodVersion" },
        );
      }
      if (
        typeof input.score !== "number" ||
        !Number.isFinite(input.score) ||
        input.score < 0 ||
        input.score > 1
      ) {
        throw validationError("score must be a number in [0, 1]", {
          field: "score",
          score: input.score,
        });
      }
      const actor = actingActorId(execution);
      const poh = await loadPoh(input.contributionId);
      const policy = await loadPinnedPolicy(poh);
      if (!policy.sections.advisory.allowedKinds.includes(input.kind)) {
        throw validationError(
          `advisory kind '${String(input.kind)}' is not allowed by the pinned policy (allowed: ${policy.sections.advisory.allowedKinds.join(", ")})`,
          { kind: input.kind, allowedKinds: policy.sections.advisory.allowedKinds },
        );
      }

      const key = `helpful_advisory:${poh.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(pohLockKey(poh.id), () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx = await pohRepository.findByIdWithinTx(poh.id, tx);
          if (!inTx) {
            throw new NotFoundError(
              `proof-of-helpfulness not found: ${poh.id}`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          const now = new Date().toISOString();
          const updated: ProofOfHelpfulness = Object.freeze({
            ...inTx,
            advisoryScores: Object.freeze([
              ...inTx.advisoryScores,
              Object.freeze({
                id: randomUUID(),
                kind: input.kind,
                methodRef: input.methodRef.trim(),
                methodVersion: input.methodVersion.trim(),
                score: input.score,
                recordedAt: now,
                recordedBy: actor,
              }),
            ]),
            events: Object.freeze([...inTx.events, "advisory_recorded"]),
            updatedAt: now,
          });
          await pohRepository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: HELPFULNESS_ADVISORY_RECORDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: updated.id,
            resourceType: "proof_of_helpfulness",
            resourceId: updated.id,
            metadata: {
              contributionId: updated.contributionId,
              kind: input.kind,
              methodRef: input.methodRef,
              methodVersion: input.methodVersion,
              score: input.score,
              advisoryOnly: true,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        }, execution),
      );
      logger.info("helpfulness_advisory.recorded", {
        pohId: applied.result.id,
        kind: input.kind,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Qualifying bases (lookup-verified at attach).
    // ------------------------------------------------------------------
    async attachBasis(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!isHelpfulnessBasisKind(input.kind ?? "")) {
        throw validationError(
          `kind must be a basis kind (proof_of_value, measured_outcome, evidence_record — got ${String(input.kind)})`,
          { field: "kind", kind: input.kind },
        );
      }
      if (!input.referenceId?.trim()) {
        throw validationError("referenceId is required", {
          field: "referenceId",
        });
      }
      const actor = actingActorId(execution);
      const poh = await loadPoh(input.contributionId);
      const policy = await loadPinnedPolicy(poh);
      if (!policy.sections.qualifyingBasisKinds.includes(input.kind)) {
        throw validationError(
          `basis kind '${String(input.kind)}' is not a qualifying kind under the pinned policy (${policy.sections.qualifyingBasisKinds.join(", ")})`,
          { kind: input.kind },
        );
      }
      // Cheap attach-time verification (existence + scope + subject);
      // the AUTHORITATIVE re-resolution happens at evaluation time.
      const resolution = await resolveBasis(input.kind, input.referenceId);
      if (resolution === null) {
        throw validationError(
          `basis ${input.referenceId} does not resolve in its truth authority`,
          { referenceId: input.referenceId, kind: input.kind },
        );
      }
      if (resolution.organizationScopeId !== poh.organizationScopeId) {
        throw validationError(
          `basis ${input.referenceId} belongs to organization scope ${resolution.organizationScopeId}, not ${poh.organizationScopeId}`,
          { referenceId: input.referenceId },
        );
      }
      if (
        resolution.subjectType !== "contribution" ||
        resolution.subjectId !== poh.contributionId
      ) {
        throw validationError(
          `basis ${input.referenceId} does not reference this contribution (${resolution.subjectType}:${resolution.subjectId})`,
          { referenceId: input.referenceId },
        );
      }

      const key = `helpful_basis:${poh.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(pohLockKey(poh.id), () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx = await pohRepository.findByIdWithinTx(poh.id, tx);
          if (!inTx) {
            throw new NotFoundError(
              `proof-of-helpfulness not found: ${poh.id}`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          const now = new Date().toISOString();
          const updated: ProofOfHelpfulness = Object.freeze({
            ...inTx,
            bases: Object.freeze([
              ...inTx.bases,
              Object.freeze({
                id: randomUUID(),
                kind: input.kind,
                referenceId: input.referenceId.trim(),
                attachedAt: now,
                attachedBy: actor,
              }),
            ]),
            events: Object.freeze([...inTx.events, "basis_attached"]),
            updatedAt: now,
          });
          await pohRepository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: HELPFULNESS_BASIS_ATTACHED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: updated.id,
            resourceType: "proof_of_helpfulness",
            resourceId: updated.id,
            metadata: {
              contributionId: updated.contributionId,
              basisKind: input.kind,
              referenceId: input.referenceId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        }, execution),
      );
      logger.info("helpfulness_basis.attached", {
        pohId: applied.result.id,
        kind: input.kind,
        referenceId: input.referenceId,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // The deterministic evaluation (the Proof-of-Helpfulness gate).
    // ------------------------------------------------------------------
    async evaluateHelpfulness(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      const poh = await loadPoh(input.contributionId);
      if (poh.state === "QUALIFIED") {
        // Replay tolerance for the SAME idempotency key is handled by
        // applyIdempotent; a FRESH key against a terminal QUALIFIED
        // claim is a conflict — final claims are never rewritten
        // (challenge them through /disputes).
        throw new ConflictError(
          `proof-of-helpfulness ${poh.id} is QUALIFIED (terminal) — final claims are never re-evaluated; challenge through /disputes`,
          { proofOfHelpfulnessId: poh.id, state: poh.state },
        );
      }
      const policy = await loadPinnedPolicy(poh);
      const contribution = await loadContribution(poh.contributionId);
      if (contribution.organizationScopeId !== poh.organizationScopeId) {
        throw validationError("organization scope mismatch", {
          contributionId: contribution.id,
        });
      }
      const disclosure = await computeDisclosureCompliance(poh);

      // Re-resolve EVERY basis through the truth authorities NOW —
      // the engine consumes only fresh resolutions.
      const basisInputs: PohBasisInput[] = [];
      for (const basis of poh.bases) {
        basisInputs.push({
          kind: basis.kind,
          referenceId: basis.referenceId,
          resolution: await resolveBasis(basis.kind, basis.referenceId),
        });
      }
      const policyView: PohPolicyView = {
        qualifyingBasisKinds: policy.sections.qualifyingBasisKinds,
        minimumGrade: policy.sections.minimumGrade,
        qualifyingSourceTypes: policy.sections.qualifyingSourceTypes,
        qualifyingOutcomeTypes: policy.sections.qualifyingOutcomeTypes,
        minimumConfidence: policy.sections.minimumConfidence,
        minimumIndependentSources: policy.sections.minimumIndependentSources,
        minimumQualifyingBases: policy.sections.minimumQualifyingBases,
        requiresDisclosure: policy.sections.requiresDisclosure,
      };
      const engineResult = evaluateProofOfHelpfulness({
        policy: policyView,
        bases: basisInputs,
        advisoryCount: poh.advisoryScores.length,
        disclosureCompliant: disclosure.compliant,
        hasCommercialMentions: disclosure.hasCommercialMentions,
        contributionState: contribution.state,
        organizationScopeId: poh.organizationScopeId,
        contributionId: poh.contributionId,
      });

      const key = `helpful_evaluate:${poh.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(pohLockKey(poh.id), () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx = await pohRepository.findByIdWithinTx(poh.id, tx);
          if (!inTx) {
            throw new NotFoundError(
              `proof-of-helpfulness not found: ${poh.id}`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          if (inTx.state === "QUALIFIED") {
            throw new ConflictError(
              `proof-of-helpfulness ${poh.id} became QUALIFIED concurrently (terminal)`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          const now = new Date().toISOString();
          const outcome =
            engineResult.outcome === "QUALIFIED" ? "QUALIFIED" : "NOT_QUALIFIED";
          const updated: ProofOfHelpfulness = Object.freeze({
            ...inTx,
            state: outcome,
            evaluations: Object.freeze([
              ...inTx.evaluations,
              Object.freeze({
                evaluatedAt: now,
                outcome,
                reasons: Object.freeze([...engineResult.reasons]),
                qualifyingBasisCount: engineResult.qualifyingBasisCount,
                independentSourceCount: engineResult.independentSourceCount,
                advisoryCount: poh.advisoryScores.length,
                evaluator: "deterministic_policy_v1" as const,
              }),
            ]),
            events: Object.freeze([...inTx.events, "evaluated"]),
            updatedAt: now,
          });
          await pohRepository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: PROOF_OF_HELPFULNESS_EVALUATED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: updated.id,
            resourceType: "proof_of_helpfulness",
            resourceId: updated.id,
            metadata: {
              contributionId: updated.contributionId,
              outcome,
              reasons: engineResult.reasons,
              qualifyingBasisCount: engineResult.qualifyingBasisCount,
              independentSourceCount: engineResult.independentSourceCount,
              advisoryCount: poh.advisoryScores.length,
              disclosureCompliant: disclosure.compliant,
              contributionState: contribution.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        }, execution),
      );
      logger.info("proof_of_helpfulness.evaluated", {
        pohId: applied.result.id,
        outcome: applied.result.state,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // The user-controlled publication gate (composition-root use).
    // ------------------------------------------------------------------
    async assertPublishable(execution, contributionId) {
      if (!contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      // INVARIANT 4: ONLY a person actor == the contributor may
      // publish. The protocol (service/system actors) can prepare,
      // recommend, attach advisory scores — never publish.
      const actor = actingPersonId(execution, "publish helpful contributions");
      const contribution = await loadContribution(contributionId);
      if (actor !== contribution.contributorId) {
        throw helpfulnessError(
          "HELPFUL_CONTRIBUTION_FORBIDDEN",
          "authorization",
          `person ${actor} is not the contributor of contribution ${contribution.id} (publication is user-controlled — only the contributor may publish)`,
          {
            actorPersonId: actor,
            contributorId: contribution.contributorId,
            contributionId: contribution.id,
          },
        );
      }
      if (isPublished(contribution.state)) {
        // Replay tolerance: already published → nothing to assert.
        return;
      }
      const poh = await loadPoh(contributionId);
      const policy = await loadPinnedPolicy(poh);
      if (policy.sections.requiresDisclosure) {
        const disclosure = await computeDisclosureCompliance(poh);
        if (!disclosure.compliant) {
          throw validationError(
            `contribution ${contribution.id} cannot be published: commercial mentions without compliant active disclosures (missing relationship keys: ${disclosure.missing.join(", ")})`,
            {
              contributionId: contribution.id,
              missingRelationshipRefs: disclosure.missing,
            },
          );
        }
      }
    },

    async recordPublication(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      const actor = actingPersonId(execution, "record publications");
      const poh = await loadPoh(input.contributionId);
      if (actor !== poh.contributorId) {
        throw helpfulnessError(
          "HELPFUL_CONTRIBUTION_FORBIDDEN",
          "authorization",
          `person ${actor} is not the contributor (publication recording follows the user-controlled publication)`,
          { actorPersonId: actor, contributorId: poh.contributorId },
        );
      }
      const now = new Date().toISOString();
      const key = `helpful_publish_record:${poh.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(pohLockKey(poh.id), () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx = await pohRepository.findByIdWithinTx(poh.id, tx);
          if (!inTx) {
            throw new NotFoundError(
              `proof-of-helpfulness not found: ${poh.id}`,
              { proofOfHelpfulnessId: poh.id },
            );
          }
          if (inTx.publication !== null) {
            // Replay tolerance: publication already recorded.
            return inTx;
          }
          const updated: ProofOfHelpfulness = Object.freeze({
            ...inTx,
            publication: Object.freeze({
              publishedAt: now,
              publishedBy: actor,
              workflowState: input.workflowState,
            }),
            events: Object.freeze([...inTx.events, "published"]),
            updatedAt: now,
          });
          await pohRepository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: HELPFUL_CONTRIBUTION_PUBLISHED,
            context: execution,
            actor,
            subject: updated.id,
            resourceType: "proof_of_helpfulness",
            resourceId: updated.id,
            metadata: {
              contributionId: updated.contributionId,
              workflowState: input.workflowState,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        }, execution),
      );
      logger.info("helpful_contribution.published", {
        contributionId: input.contributionId,
        pohId: applied.result.id,
      });
      return applied.result;
    },
  };

  return service;
}

export {
  HELPFUL_CONTRIBUTION_CREATED,
  HELPFUL_RECOMMENDATION_PREPARED,
  HELPFUL_CONTRIBUTION_PUBLISHED,
  HELPFUL_DISCLOSURE_DECLARED,
  HELPFUL_DISCLOSURE_RETRACTED,
  HELPFULNESS_POLICY_DEFINED,
  HELPFULNESS_BASIS_ATTACHED,
  HELPFULNESS_ADVISORY_RECORDED,
  PROOF_OF_HELPFULNESS_EVALUATED,
  isPublished as isContributionPublished,
};

export type { AuditWriter };
