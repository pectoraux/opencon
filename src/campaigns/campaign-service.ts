/**
 * CampaignService — domain service for campaign policy/configuration
 * (NET-W011 §3.1–3.4).
 *
 * Architecture ref: spec/architecture.md §7 (the Farmable contribution
 * market), §18 (module ownership); spec/architecture-lock.md §5
 * (economic authority: /settlement), §7 (lifecycle authority:
 * /workflows).
 *
 * THE ADMINISTRATIVE STATUS MACHINE (validated here; status is derived
 * from the append-only event history — events are never rewritten):
 *
 * ```text
 * DRAFT ──activate──→ ACTIVE ⇄ pause/resume ⇄ PAUSED
 *   │                    │ │
 *   │                    └──┼── complete ──→ COMPLETED (terminal)
 *   └── cancel ──────────┴── cancel ──→ CANCELLED (terminal)
 * ```
 *
 * This is the CAMPAIGN RECORD's own policy/configuration status — the
 * dispute-record precedent. It is deliberately NOT a workflow
 * lifecycle: contribution OPPORTUNITIES published from a campaign are
 * lifecycle subjects owned exclusively by /workflows.
 *
 * AUTHORITY SEPARATION (the work item's strongest constraint):
 *  - this service owns campaign POLICY/CONFIGURATION decisions only;
 *  - /workflows remains the lifecycle authority: opportunity creation
 *    + every transition are requested through the opportunity and
 *    workflow services at the composition root; `resolveOpportunityDraft`
 *    returns neutral fields and `recordOpportunityPublication` only
 *    VERIFIES the created opportunity through the read-only lookup;
 *  - /settlement remains the economic authority: budget commitments
 *    are ESCROWED through the settlement boundary's stake commands
 *    (`campaign_budget` purpose) orchestrated at the composition root
 *    with compound idempotency keys; `recordBudgetCommitment` only
 *    VERIFIES the settlement record through the read-only stake
 *    lookup, and `recordBudgetRelease` only RECORDS the executed
 *    release — no postings, no balances, no second ledger (AC-03);
 *  - /evidence remains the truth authority and /outcomes the
 *    measurement authority: policies REFERENCE the frozen
 *    vocabularies — never redefined, never evaluated here;
 *  - clearing rules are DECLARED policy consumed by NET-W014 —
 *    executing them is an explicit non-goal.
 *
 * DETERMINISM (CAMP-002): every policy version is immutable and
 * version = latest+1 under the ORGANIZATION-INDEPENDENT lineage mutex
 * `campaign_policy_lineage:{campaignId}` (the NET-W007/008/010
 * pattern — a lineage can never fork across scopes); the activation
 * gate reads only stored records.
 *
 * OWNERSHIP: policy/status/budget mutations are OWNER-ONLY (the
 * campaign owner is the creating person; checked server-side on every
 * mutation — API-002).
 *
 * Atomicity: every mutation commits its campaign record + appended
 * events + idempotency record + audit event in ONE authoritative
 * transaction (IdempotencyStore.applyIdempotent; NET-W004-AC-07).
 *
 * Tier compliance: campaigns domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  CAMPAIGN_BUDGET_STAKE_PURPOSE_KIND,
  CAMPAIGN_POLICY_FORMAT,
  assertCampaignAttributionMode,
  assertCampaignEvidenceGrade,
  assertCampaignEvidenceSourceTypes,
  assertCampaignOutcomeType,
  assertIncrementalAttributionConstraint,
  campaignEligibilityPolicyReference,
  isCampaignEligibilityAttribute,
  isCampaignEligibilityOperator,
  isCampaignClearingBasis,
  isCampaignClearingDrawKind,
  isCampaignEvidenceRequirementKind,
  isCampaignObjectiveKind,
  validateCampaignAmount,
  validateCampaignConfidenceThreshold,
  validateCampaignDisclosureKinds,
  validateCampaignWindowDays,
} from "../core/campaigns.ts";
import type {
  CampaignEvent,
  CampaignEventKind,
  CampaignLookups,
  CampaignOpportunityDraft,
  CampaignPolicy,
  CampaignPolicyRepository,
  CampaignPolicySections,
  CampaignDisclosurePolicy,
  CampaignRecord,
  CampaignRepository,
  CampaignService,
  CreateCampaignInput,
  CreateCampaignResult,
  DefineCampaignPolicyInput,
  DefineCampaignPolicyResult,
  RecordBudgetCommitmentInput,
  RecordBudgetReleaseInput,
  RecordClearingExecutionInput,
  RecordOpportunityPublicationInput,
  CampaignStatusInput,
} from "./port.ts";

const CAMPAIGN_CREATED = "campaign.created" as const;
const CAMPAIGN_POLICY_DEFINED = "campaign.policy_defined" as const;
const CAMPAIGN_ACTIVATED = "campaign.activated" as const;
const CAMPAIGN_PAUSED = "campaign.paused" as const;
const CAMPAIGN_RESUMED = "campaign.resumed" as const;
const CAMPAIGN_COMPLETED = "campaign.completed" as const;
const CAMPAIGN_CANCELLED = "campaign.cancelled" as const;
const CAMPAIGN_BUDGET_COMMITTED = "campaign.budget_committed" as const;
const CAMPAIGN_BUDGET_RELEASED = "campaign.budget_released" as const;
const CAMPAIGN_OPPORTUNITY_PUBLISHED = "campaign.opportunity_published" as const;
const CAMPAIGN_CLEARING_EXECUTED = "campaign.clearing_executed" as const;

export interface CampaignServiceDeps {
  readonly repository: CampaignRepository;
  readonly policyRepository: CampaignPolicyRepository;
  readonly lookups: CampaignLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function campaignValidationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({
    code: "CAMPAIGN_VALIDATION",
    classification: "validation",
    message,
    context,
  });
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw campaignValidationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/** The acting person's id (authorization: only persons act on campaigns). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw campaignValidationError(
      "an authenticated person actor is required (service/system actors cannot manage campaigns)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** The owner-only gate (every policy/status/budget mutation). */
function assertOwner(campaign: CampaignRecord, actorPersonId: string): void {
  if (campaign.ownerPersonId !== actorPersonId) {
    throw new OpenConError({
      code: "CAMPAIGN_FORBIDDEN",
      classification: "authorization",
      message: `person ${actorPersonId} is not the owner of campaign ${campaign.id} (owner: ${campaign.ownerPersonId})`,
      context: {
        campaignId: campaign.id,
        actorPersonId,
        ownerPersonId: campaign.ownerPersonId,
      },
    });
  }
}

/** Build one append-only history event. */
function buildEvent(
  event: CampaignEventKind,
  execution: ExecutionContext,
  actorPersonId: string,
  note: string | null,
  details: Readonly<Record<string, unknown>>,
): CampaignEvent {
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

/** The per-campaign-record serialization lock key (exported for the
 * composition root's clearing bookkeeping port — NET-W020 remediation). */
export function campaignLockKey(campaignId: string): string {
  return `campaign_record:${campaignId}`;
}

/** The org-INDEPENDENT policy-lineage mutex (the NET-W007/008/010 pattern). */
function campaignPolicyLineageLockKey(campaignId: string): string {
  return `campaign_policy_lineage:${campaignId}`;
}

/** Append an event + derive the next record (immutably). */
function withEvent(
  campaign: CampaignRecord,
  event: CampaignEvent,
  patch: Partial<Pick<CampaignRecord, "status" | "currentPolicyVersion" | "budget">>,
): CampaignRecord {
  return Object.freeze({
    ...campaign,
    ...patch,
    events: Object.freeze([...campaign.events, event]),
    updatedAt: event.recordedAt,
  });
}

// ---------------------------------------------------------------------------
// Policy-section validation (pure; the CAMP-002 gate's building blocks)
// ---------------------------------------------------------------------------

function validatePolicySections(
  sections: CampaignPolicySections,
): CampaignPolicySections & {
  /** NET-W018: always materialized (empty when the input omitted it). */
  disclosurePolicy: CampaignDisclosurePolicy;
} {
  if (!sections || typeof sections !== "object") {
    throw campaignValidationError("policy sections are required", {
      field: "policy",
    });
  }

  // --- objectives (CAMP-001): ≥1, closed vocabulary, unique ids.
  if (
    !Array.isArray(sections.objectives) ||
    sections.objectives.length === 0
  ) {
    throw campaignValidationError(
      "policy.objectives requires at least one objective (CAMP-001)",
      { field: "objectives" },
    );
  }
  const objectiveIds = new Set<string>();
  const objectiveKindById = new Map<string, string>();
  for (const objective of sections.objectives) {
    if (!objective?.id?.trim()) {
      throw campaignValidationError("each objective requires a non-empty id", {
        field: "objectives.id",
      });
    }
    if (objectiveIds.has(objective.id)) {
      throw campaignValidationError(
        `objective ids must be unique (duplicate: ${objective.id})`,
        { field: "objectives.id", objectiveId: objective.id },
      );
    }
    if (!isCampaignObjectiveKind(objective.kind)) {
      throw campaignValidationError(
        `objective ${objective.id} kind must be a closed-vocabulary campaign objective kind (got ${String(objective.kind)})`,
        { field: "objectives.kind", objectiveId: objective.id, kind: objective.kind },
      );
    }
    objectiveIds.add(objective.id);
    objectiveKindById.set(objective.id, objective.kind);
  }
  const assertObjectiveRef = (section: string, objectiveId: string): void => {
    if (!objectiveIds.has(objectiveId)) {
      throw campaignValidationError(
        `${section} references unknown objectiveId ${String(objectiveId)}`,
        { field: section, objectiveId },
      );
    }
  };

  // --- eligibility (AC-06): closed attribute/operator vocabularies.
  if (!sections.eligibility || !Array.isArray(sections.eligibility.rules)) {
    throw campaignValidationError(
      "policy.eligibility.rules is required (possibly empty)",
      { field: "eligibility.rules" },
    );
  }
  for (const rule of sections.eligibility.rules) {
    if (!isCampaignEligibilityAttribute(rule.attribute)) {
      throw campaignValidationError(
        `eligibility rule attribute must be a closed-vocabulary neutral attribute (got ${String(rule.attribute)})`,
        { field: "eligibility.rules.attribute", attribute: rule.attribute },
      );
    }
    if (!isCampaignEligibilityOperator(rule.operator)) {
      throw campaignValidationError(
        `eligibility rule operator must be a closed-vocabulary operator (got ${String(rule.operator)})`,
        { field: "eligibility.rules.operator", operator: rule.operator },
      );
    }
    if (
      !Array.isArray(rule.values) ||
      rule.values.length === 0 ||
      rule.values.some((v: string) => typeof v !== "string" || !v.trim())
    ) {
      throw campaignValidationError(
        "eligibility rules require at least one non-empty string value",
        { field: "eligibility.rules.values", attribute: rule.attribute },
      );
    }
  }

  // --- outcome policy: references to the frozen /outcomes vocabulary.
  if (
    !sections.outcomePolicy ||
    !Array.isArray(sections.outcomePolicy.requirements) ||
    sections.outcomePolicy.requirements.length === 0
  ) {
    throw campaignValidationError(
      "policy.outcomePolicy.requirements requires at least one requirement (CAMP-002)",
      { field: "outcomePolicy.requirements" },
    );
  }
  for (const requirement of sections.outcomePolicy.requirements) {
    assertObjectiveRef("outcomePolicy.requirements", requirement.objectiveId);
    assertCampaignOutcomeType(
      "outcomePolicy.requirements.outcomeType",
      requirement.outcomeType,
    );
    assertCampaignAttributionMode(
      "outcomePolicy.requirements.attributionMode",
      requirement.attributionMode,
    );
    validateCampaignWindowDays(
      "outcomePolicy.requirements.windowDays",
      requirement.windowDays,
    );
    if (typeof requirement.requiresExperiment !== "boolean") {
      throw campaignValidationError(
        "outcomePolicy.requirements.requiresExperiment must be an explicit boolean",
        { field: "outcomePolicy.requirements.requiresExperiment" },
      );
    }
  }

  // --- evidence policy: references to the frozen /evidence vocabulary.
  if (
    !sections.evidencePolicy ||
    !Array.isArray(sections.evidencePolicy.requirements) ||
    sections.evidencePolicy.requirements.length === 0
  ) {
    throw campaignValidationError(
      "policy.evidencePolicy.requirements requires at least one requirement (CAMP-002)",
      { field: "evidencePolicy.requirements" },
    );
  }
  for (const requirement of sections.evidencePolicy.requirements) {
    assertObjectiveRef("evidencePolicy.requirements", requirement.objectiveId);
    if (!isCampaignEvidenceRequirementKind(requirement.requirementKind)) {
      throw campaignValidationError(
        `evidence requirement kind must reference an authoritative record kind (got ${String(requirement.requirementKind)})`,
        { field: "evidencePolicy.requirements.requirementKind" },
      );
    }
    if (requirement.minimumGrade !== null) {
      assertCampaignEvidenceGrade(
        "evidencePolicy.requirements.minimumGrade",
        requirement.minimumGrade,
      );
    }
    if (requirement.qualifyingSourceTypes !== null) {
      if (
        !Array.isArray(requirement.qualifyingSourceTypes) ||
        requirement.qualifyingSourceTypes.length === 0
      ) {
        throw campaignValidationError(
          "evidencePolicy.requirements.qualifyingSourceTypes must be non-empty when present",
          { field: "evidencePolicy.requirements.qualifyingSourceTypes" },
        );
      }
      assertCampaignEvidenceSourceTypes(
        "evidencePolicy.requirements.qualifyingSourceTypes",
        requirement.qualifyingSourceTypes,
      );
    }
  }

  // --- disclosure policy (NET-W018 — CRE-006): the declared
  //     required disclosure kinds — closed vocabulary, duplicates
  //     rejected (deterministic derivation downstream). OPTIONAL in
  //     the input; ALWAYS materialized (empty = none declared).
  const disclosureRequiredKinds = validateCampaignDisclosureKinds(
    "disclosurePolicy.requiredKinds",
    sections.disclosurePolicy?.requiredKinds ?? [],
  );

  // --- budget (AC-03): declaration only; frozen economic arithmetic.
  if (
    !sections.budget ||
    typeof sections.budget !== "object" ||
    sections.budget.unit !== "credits"
  ) {
    throw campaignValidationError(
      "policy.budget with unit \"credits\" is required (declaration only — the escrow executes through the settlement authority)",
      { field: "budget.unit" },
    );
  }
  validateCampaignAmount("budget.totalAmount", sections.budget.totalAmount);
  if (!Array.isArray(sections.budget.perObjective)) {
    throw campaignValidationError(
      "policy.budget.perObjective must be an array (possibly empty)",
      { field: "budget.perObjective" },
    );
  }
  let envelopeSum = 0;
  for (const envelope of sections.budget.perObjective) {
    assertObjectiveRef("budget.perObjective", envelope.objectiveId);
    validateCampaignAmount(
      "budget.perObjective.amount",
      envelope.amount,
    );
    envelopeSum += envelope.amount;
  }
  if (envelopeSum > sections.budget.totalAmount) {
    throw campaignValidationError(
      `budget per-objective envelopes (${envelopeSum}) exceed the declared total (${sections.budget.totalAmount})`,
      { field: "budget.perObjective", envelopeSum, totalAmount: sections.budget.totalAmount },
    );
  }

  // --- attribution rules (CAMP-002 confidence policy): frozen modes,
  //     quantified thresholds, the incremental-conversion constraint.
  if (!Array.isArray(sections.attributionRules)) {
    throw campaignValidationError(
      "policy.attributionRules must be an array (possibly empty)",
      { field: "attributionRules" },
    );
  }
  const ruleIds = new Set<string>();
  for (const rule of sections.attributionRules) {
    if (!rule?.id?.trim()) {
      throw campaignValidationError("each attribution rule requires a non-empty id", {
        field: "attributionRules.id",
      });
    }
    if (ruleIds.has(rule.id)) {
      throw campaignValidationError(
        `attribution rule ids must be unique (duplicate: ${rule.id})`,
        { field: "attributionRules.id", ruleId: rule.id },
      );
    }
    ruleIds.add(rule.id);
    assertObjectiveRef("attributionRules", rule.objectiveId);
    assertCampaignAttributionMode("attributionRules.model", rule.model);
    validateCampaignConfidenceThreshold(
      "attributionRules.confidenceThreshold",
      rule.confidenceThreshold,
    );
    validateCampaignWindowDays("attributionRules.windowDays", rule.windowDays);
    if (typeof rule.requiresExperiment !== "boolean") {
      throw campaignValidationError(
        "attributionRules.requiresExperiment must be an explicit boolean",
        { field: "attributionRules.requiresExperiment" },
      );
    }
    assertIncrementalAttributionConstraint(
      objectiveKindById.get(rule.objectiveId) ?? "",
      rule.model,
      rule.requiresExperiment,
    );
  }

  // --- clearing rules (CAMP-005): declared caps within the budget.
  if (!Array.isArray(sections.clearingRules)) {
    throw campaignValidationError(
      "policy.clearingRules must be an array (possibly empty)",
      { field: "clearingRules" },
    );
  }
  const clearingIds = new Set<string>();
  for (const rule of sections.clearingRules) {
    if (!rule?.id?.trim()) {
      throw campaignValidationError("each clearing rule requires a non-empty id", {
        field: "clearingRules.id",
      });
    }
    if (clearingIds.has(rule.id)) {
      throw campaignValidationError(
        `clearing rule ids must be unique (duplicate: ${rule.id})`,
        { field: "clearingRules.id", ruleId: rule.id },
      );
    }
    clearingIds.add(rule.id);
    assertObjectiveRef("clearingRules", rule.objectiveId);
    if (!isCampaignClearingBasis(rule.basis)) {
      throw campaignValidationError(
        `clearing rule basis must be a closed-vocabulary basis (got ${String(rule.basis)})`,
        { field: "clearingRules.basis" },
      );
    }
    if (!isCampaignClearingDrawKind(rule.drawKind)) {
      throw campaignValidationError(
        `clearing rule drawKind must reference a settlement primitive (got ${String(rule.drawKind)})`,
        { field: "clearingRules.drawKind" },
      );
    }
    if (rule.drawKind === "reward_allocation" && !rule.rewardPolicyId?.trim()) {
      throw campaignValidationError(
        "clearing rules drawing through reward_allocation must reference a rewardPolicyId",
        { field: "clearingRules.rewardPolicyId", ruleId: rule.id },
      );
    }
    validateCampaignAmount("clearingRules.maxDrawAmount", rule.maxDrawAmount);
    if (rule.maxDrawAmount <= 0) {
      throw campaignValidationError(
        "clearingRules.maxDrawAmount must be positive",
        { field: "clearingRules.maxDrawAmount", ruleId: rule.id },
      );
    }
  }
  const clearingSum = sections.clearingRules.reduce(
    (sum, rule) => sum + rule.maxDrawAmount,
    0,
  );
  if (clearingSum > sections.budget.totalAmount) {
    throw campaignValidationError(
      `clearing rule caps (${clearingSum}) exceed the declared budget total (${sections.budget.totalAmount})`,
      { field: "clearingRules", clearingSum, totalAmount: sections.budget.totalAmount },
    );
  }

  // --- opportunity specs: neutral templates for composition.
  if (!Array.isArray(sections.opportunitySpecs)) {
    throw campaignValidationError(
      "policy.opportunitySpecs must be an array (activation requires ≥1)",
      { field: "opportunitySpecs" },
    );
  }
  const specIds = new Set<string>();
  for (const spec of sections.opportunitySpecs) {
    if (!spec?.id?.trim()) {
      throw campaignValidationError("each opportunity spec requires a non-empty id", {
        field: "opportunitySpecs.id",
      });
    }
    if (specIds.has(spec.id)) {
      throw campaignValidationError(
        `opportunity spec ids must be unique (duplicate: ${spec.id})`,
        { field: "opportunitySpecs.id", specId: spec.id },
      );
    }
    specIds.add(spec.id);
    if (!spec.title?.trim()) {
      throw campaignValidationError(
        `opportunity spec ${spec.id} requires a non-empty title`,
        { field: "opportunitySpecs.title", specId: spec.id },
      );
    }
    if (!spec.opportunityType?.trim()) {
      throw campaignValidationError(
        `opportunity spec ${spec.id} requires a non-empty opportunityType`,
        { field: "opportunitySpecs.opportunityType", specId: spec.id },
      );
    }
    if (!spec.brief || typeof spec.brief !== "object") {
      throw campaignValidationError(
        `opportunity spec ${spec.id} requires a structured (provider-neutral) brief`,
        { field: "opportunitySpecs.brief", specId: spec.id },
      );
    }
    if (
      !spec.contributionRequirements ||
      typeof spec.contributionRequirements !== "object"
    ) {
      throw campaignValidationError(
        `opportunity spec ${spec.id} requires structured contributionRequirements`,
        { field: "opportunitySpecs.contributionRequirements", specId: spec.id },
      );
    }
    if (
      !Array.isArray(spec.evidenceReferencePlaceholders) ||
      spec.evidenceReferencePlaceholders.some(
        (p: string) => typeof p !== "string" || !p.trim(),
      )
    ) {
      throw campaignValidationError(
        `opportunity spec ${spec.id} requires evidenceReferencePlaceholders (an array of neutral ids, possibly empty)`,
        { field: "opportunitySpecs.evidenceReferencePlaceholders", specId: spec.id },
      );
    }
  }

  return {
    ...sections,
    disclosurePolicy: Object.freeze({
      requiredKinds: disclosureRequiredKinds,
    }),
  };
}

export function createCampaignService(deps: CampaignServiceDeps): CampaignService {
  const {
    repository,
    policyRepository,
    lookups,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /** Load + tenant-scope a campaign. */
  async function loadCampaign(
    organizationScopeId: string | undefined,
    campaignId: string,
  ): Promise<CampaignRecord> {
    const campaign = await repository.findById(campaignId);
    if (!campaign) {
      throw new NotFoundError(`campaign not found: ${campaignId}`, {
        campaignId,
      });
    }
    if (organizationScopeId !== undefined) {
      if (campaign.organizationScopeId !== organizationScopeId) {
        throw new NotFoundError(`campaign not found: ${campaignId}`, {
          campaignId,
          organizationScopeId,
        });
      }
    }
    return campaign;
  }

  /** The current (latest) policy version of a campaign (committed read). */
  async function latestPolicy(
    campaignId: string,
  ): Promise<CampaignPolicy | null> {
    const versions = await policyRepository.listByCampaign(campaignId);
    if (versions.length === 0) return null;
    return versions.reduce((latest, p) => (p.version > latest.version ? p : latest));
  }

  /**
   * The CAMP-002 activation gate: a complete policy version exists with
   * ≥1 opportunity spec, and a positive declared budget is FULLY
   * escrowed through the settlement authority (the recorded commitment
   * must cover the declared total — no activation on credit).
   */
  function assertActivationGate(campaign: CampaignRecord, policy: CampaignPolicy): void {
    if (policy.opportunitySpecs.length === 0) {
      throw campaignValidationError(
        `campaign ${campaign.id} cannot activate: the current policy version ${policy.version} declares no contribution opportunity spec`,
        { campaignId: campaign.id, policyVersion: policy.version },
      );
    }
    if (policy.budget.totalAmount > 0) {
      if (
        campaign.budget.stakeId === null ||
        campaign.budget.committedAmount === null ||
        campaign.budget.committedAmount < policy.budget.totalAmount
      ) {
        throw campaignValidationError(
          `campaign ${campaign.id} cannot activate: the declared budget (${policy.budget.totalAmount} credits) must be committed through the settlement authority before activation (committed: ${campaign.budget.committedAmount ?? 0})`,
          {
            campaignId: campaign.id,
            declaredTotal: policy.budget.totalAmount,
            committedAmount: campaign.budget.committedAmount ?? 0,
          },
        );
      }
    }
  }

  const service: CampaignService = {
    // ------------------------------------------------------------------
    // Create — DRAFT (person actor = owner).
    // ------------------------------------------------------------------
    async createCampaign(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw campaignValidationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.name?.trim()) {
        throw campaignValidationError("name is required", { field: "name" });
      }
      assertIdempotencyKey(input.idempotencyKey);
      const owner = actingPersonId(execution);
      if (!(await lookups.person.exists(owner))) {
        throw campaignValidationError(
          `campaign owner person does not exist: ${owner}`,
          { ownerPersonId: owner },
        );
      }

      const key = `campaign_create:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const now = new Date().toISOString();
          const event = buildEvent(
            "created",
            execution,
            owner,
            null,
            { name: input.name.trim() },
          );
          const campaign: CampaignRecord = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            ownerPersonId: owner,
            name: input.name.trim(),
            description: input.description?.trim() || null,
            status: "DRAFT",
            currentPolicyVersion: null,
            budget: Object.freeze({
              stakeId: null,
              committedAmount: null,
              committedAt: null,
              releasedAt: null,
            }),
            events: Object.freeze([event]),
            createdAt: now,
            updatedAt: now,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await repository.createWithinTx(campaign, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CAMPAIGN_CREATED,
            context: execution,
            actor: owner,
            subject: campaign.id,
            resourceType: "campaign",
            resourceId: campaign.id,
            metadata: {
              organizationScopeId: campaign.organizationScopeId,
              ownerPersonId: owner,
              name: campaign.name,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return campaign;
        },
        execution,
      );
      logger.info("campaign.created", {
        campaignId: applied.result.id,
        created: applied.executed,
      });
      return { campaign: applied.result, created: applied.executed };
    },

    async getCampaign(execution, id) {
      void execution;
      return loadCampaign(undefined, id);
    },

    async listCampaigns(execution, organizationScopeId, statuses) {
      void execution;
      return repository.listByOrganization(organizationScopeId, statuses);
    },

    // ------------------------------------------------------------------
    // Policy versions (CAMP-002; the org-independent lineage mutex).
    // ------------------------------------------------------------------
    async defineCampaignPolicy(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.campaignId?.trim()) {
        throw campaignValidationError("campaignId is required", {
          field: "campaignId",
        });
      }
      const actor = actingPersonId(execution);
      const campaign = await loadCampaign(undefined, input.campaignId);
      assertOwner(campaign, actor);
      if (
        campaign.status === "COMPLETED" ||
        campaign.status === "CANCELLED"
      ) {
        throw new ConflictError(
          `campaign ${campaign.id} is terminal (${campaign.status}) — policy versions can no longer be defined`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      const sections = validatePolicySections(input.policy);

      // Budget-cap consistency: once an escrow is COMMITTED and
      // recorded, a new version may not declare a budget the existing
      // commitment cannot cover (the recorded commitment is the
      // fact; the declaration must stay within it — no silent
      // activation-on-credit through version bumps).
      if (
        campaign.budget.committedAmount !== null &&
        sections.budget.totalAmount > campaign.budget.committedAmount
      ) {
        throw campaignValidationError(
          `policy version declares a budget (${sections.budget.totalAmount}) exceeding the committed escrow (${campaign.budget.committedAmount}) — commit a larger escrow first or stay within the committed amount`,
          {
            campaignId: campaign.id,
            declaredTotal: sections.budget.totalAmount,
            committedAmount: campaign.budget.committedAmount,
          },
        );
      }

      // Reward-policy references in clearing rules must RESOLVE
      // through the neutral settlement lookup, same organization scope
      // (tenant isolation; a campaign can never clear against another
      // org's reward lineage).
      for (const rule of sections.clearingRules) {
        if (rule.rewardPolicyId === null) continue;
        const resolved = await lookups.rewardPolicy.resolvePolicy(
          rule.rewardPolicyId,
        );
        if (!resolved) {
          throw campaignValidationError(
            `clearing rule ${rule.id} references reward policy ${rule.rewardPolicyId} which does not resolve in the settlement authority`,
            { clearingRuleId: rule.id, rewardPolicyId: rule.rewardPolicyId },
          );
        }
        if (
          resolved.organizationScopeId !== campaign.organizationScopeId
        ) {
          throw campaignValidationError(
            `clearing rule ${rule.id} references reward policy ${rule.rewardPolicyId} which belongs to organization scope ${resolved.organizationScopeId}, not ${campaign.organizationScopeId}`,
            {
              clearingRuleId: rule.id,
              rewardPolicyId: rule.rewardPolicyId,
              rewardPolicyScope: resolved.organizationScopeId,
            },
          );
        }
      }

      const key = `campaign_policy:${campaign.organizationScopeId}:${input.idempotencyKey}`;
      // The org-INDEPENDENT lineage mutex: serializes version
      // creation for this campaign so version = latest+1 can never
      // fork (the NET-W007/008/010 lineage pattern). Held through the
      // commit, so the in-tx latest read observes prior commits.
      const applied = await idempotency.withLock(
        campaignPolicyLineageLockKey(campaign.id),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const latest = await policyRepository.findLatestWithinTx(
              campaign.id,
              tx,
            );
            const version = latest === null ? 1 : latest.version + 1;
            const policy: CampaignPolicy = Object.freeze({
              id: randomUUID(),
              campaignId: campaign.id,
              organizationScopeId: campaign.organizationScopeId,
              version,
              formatVersion: CAMPAIGN_POLICY_FORMAT,
              objectives: Object.freeze([...sections.objectives]),
              eligibility: Object.freeze({
                rules: Object.freeze([...sections.eligibility.rules]),
              }),
              outcomePolicy: Object.freeze({
                requirements: Object.freeze([
                  ...sections.outcomePolicy.requirements,
                ]),
              }),
              evidencePolicy: Object.freeze({
                requirements: Object.freeze([
                  ...sections.evidencePolicy.requirements,
                ]),
              }),
              budget: Object.freeze({
                unit: sections.budget.unit,
                totalAmount: sections.budget.totalAmount,
                perObjective: Object.freeze([...sections.budget.perObjective]),
              }),
              attributionRules: Object.freeze([...sections.attributionRules]),
              clearingRules: Object.freeze([...sections.clearingRules]),
              opportunitySpecs: Object.freeze([...sections.opportunitySpecs]),
              // NET-W018: the declared disclosure policy — ALWAYS
              // materialized (empty when the input omitted the
              // section; validatePolicySections normalizes).
              disclosurePolicy: Object.freeze({
                requiredKinds: Object.freeze([
                  ...sections.disclosurePolicy.requiredKinds,
                ]),
              }),
              createdBy: actor,
              createdAt: new Date().toISOString(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await policyRepository.createWithinTx(policy, tx);

            // The campaign record's mirror advances atomically.
            const campaignInTx =
              (await repository.findByIdWithinTx(campaign.id, tx)) ?? campaign;
            const event = buildEvent(
              "policy_defined",
              execution,
              actor,
              null,
              {
                policyVersion: version,
                formatVersion: policy.formatVersion,
                objectiveKinds: policy.objectives.map((o) => o.kind),
                budgetTotal: policy.budget.totalAmount,
                clearingRuleCount: policy.clearingRules.length,
                opportunitySpecCount: policy.opportunitySpecs.length,
              },
            );
            const updated = withEvent(campaignInTx, event, {
              currentPolicyVersion: version,
            });
            await repository.saveWithinTx(updated, tx);

            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: CAMPAIGN_POLICY_DEFINED,
              context: execution,
              actor,
              subject: campaign.id,
              resourceType: "campaign_policy",
              resourceId: policy.id,
              metadata: {
                organizationScopeId: campaign.organizationScopeId,
                campaignId: campaign.id,
                policyVersion: version,
                formatVersion: policy.formatVersion,
                objectiveKinds: policy.objectives.map((o) => o.kind),
                budgetTotal: policy.budget.totalAmount,
                clearingRuleCount: policy.clearingRules.length,
                opportunitySpecCount: policy.opportunitySpecs.length,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return policy;
          }, execution),
      );
      logger.info("campaign.policy_defined", {
        campaignId: applied.result.campaignId,
        version: applied.result.version,
        created: applied.executed,
      });
      return { policy: applied.result, created: applied.executed };
    },

    async getPolicyVersion(execution, campaignId, version) {
      void execution;
      await loadCampaign(undefined, campaignId);
      const policy = await policyRepository.findVersion(campaignId, version);
      if (!policy) {
        throw new NotFoundError(
          `campaign policy not found: ${campaignId} version ${version}`,
          { campaignId, version },
        );
      }
      return policy;
    },

    async listPolicyVersions(execution, campaignId) {
      void execution;
      await loadCampaign(undefined, campaignId);
      const versions = await policyRepository.listByCampaign(campaignId);
      return [...versions].sort((a, b) => a.version - b.version);
    },

    // ------------------------------------------------------------------
    // The administrative status machine (owner-only; serialized per
    // record; append-only events).
    // ------------------------------------------------------------------
    async activateCampaign(execution, input) {
      return statusTransition(execution, input, {
        from: ["DRAFT"],
        to: "ACTIVE",
        event: "activated",
        auditType: CAMPAIGN_ACTIVATED,
        gate: async (campaign) => {
          const policy = await latestPolicy(campaign.id);
          if (policy === null) {
            throw campaignValidationError(
              `campaign ${campaign.id} cannot activate: no policy version is defined (CAMP-002 — outcome, evidence, attribution, confidence and settlement policy must be defined before activation)`,
              { campaignId: campaign.id },
            );
          }
          assertActivationGate(campaign, policy);
        },
      });
    },

    async pauseCampaign(execution, input) {
      return statusTransition(execution, input, {
        from: ["ACTIVE"],
        to: "PAUSED",
        event: "paused",
        auditType: CAMPAIGN_PAUSED,
      });
    },

    async resumeCampaign(execution, input) {
      return statusTransition(execution, input, {
        from: ["PAUSED"],
        to: "ACTIVE",
        event: "resumed",
        auditType: CAMPAIGN_RESUMED,
        gate: async (campaign) => {
          const policy = await latestPolicy(campaign.id);
          if (policy !== null) {
            assertActivationGate(campaign, policy);
          }
        },
      });
    },

    async completeCampaign(execution, input) {
      return statusTransition(execution, input, {
        from: ["ACTIVE", "PAUSED"],
        to: "COMPLETED",
        event: "completed",
        auditType: CAMPAIGN_COMPLETED,
      });
    },

    async cancelCampaign(execution, input) {
      return statusTransition(execution, input, {
        from: ["DRAFT", "ACTIVE", "PAUSED"],
        to: "CANCELLED",
        event: "cancelled",
        auditType: CAMPAIGN_CANCELLED,
      });
    },

    // ------------------------------------------------------------------
    // Budget bookkeeping (references to settlement-executed records).
    // ------------------------------------------------------------------
    async recordBudgetCommitment(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.stakeId?.trim()) {
        throw campaignValidationError("stakeId is required", {
          field: "stakeId",
        });
      }
      const actor = actingPersonId(execution);
      const campaign = await loadCampaign(undefined, input.campaignId);
      assertOwner(campaign, actor);
      if (
        campaign.status === "COMPLETED" ||
        campaign.status === "CANCELLED"
      ) {
        throw new ConflictError(
          `campaign ${campaign.id} is terminal (${campaign.status}) — a budget can no longer be committed`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      if (
        campaign.budget.stakeId !== null &&
        campaign.budget.stakeId !== input.stakeId
      ) {
        throw new ConflictError(
          `campaign ${campaign.id} already carries a budget commitment (stake ${campaign.budget.stakeId}; the settlement authority enforces one COMMITTED stake per purpose)`,
          { campaignId: campaign.id, stakeId: campaign.budget.stakeId },
        );
      }
      const policy = await latestPolicy(campaign.id);
      if (policy === null) {
        throw campaignValidationError(
          `campaign ${campaign.id} has no policy version — the declared budget to commit is undefined`,
          { campaignId: campaign.id },
        );
      }
      if (policy.budget.totalAmount <= 0) {
        throw campaignValidationError(
          `campaign ${campaign.id} declares a zero budget — no commitment is required or allowed`,
          { campaignId: campaign.id, declaredTotal: policy.budget.totalAmount },
        );
      }

      // VERIFY the settlement authority's record (read-only lookup —
      // never a posting path): same scope, owner, purpose linkage,
      // COMMITTED state and the exact declared amount.
      const stake = await lookups.stake.resolveStake(input.stakeId);
      if (!stake) {
        throw new NotFoundError(
          `stake not found: ${input.stakeId}`,
          { stakeId: input.stakeId },
        );
      }
      if (stake.organizationScopeId !== campaign.organizationScopeId) {
        throw campaignValidationError(
          `stake ${input.stakeId} belongs to organization scope ${stake.organizationScopeId}, not ${campaign.organizationScopeId}`,
          { stakeId: input.stakeId, stakeScope: stake.organizationScopeId },
        );
      }
      if (stake.ownerPersonId !== campaign.ownerPersonId) {
        throw campaignValidationError(
          `stake ${input.stakeId} owner ${stake.ownerPersonId} is not the campaign owner ${campaign.ownerPersonId}`,
          { stakeId: input.stakeId, stakeOwner: stake.ownerPersonId },
        );
      }
      if (
        stake.purposeKind !== CAMPAIGN_BUDGET_STAKE_PURPOSE_KIND ||
        stake.purposeId !== campaign.id
      ) {
        throw campaignValidationError(
          `stake ${input.stakeId} purpose must be ${CAMPAIGN_BUDGET_STAKE_PURPOSE_KIND}:${campaign.id} (got ${stake.purposeKind}:${stake.purposeId})`,
          { stakeId: input.stakeId, purposeKind: stake.purposeKind, purposeId: stake.purposeId },
        );
      }
      if (stake.state !== "COMMITTED") {
        throw campaignValidationError(
          `stake ${input.stakeId} is ${stake.state} — only a COMMITTED escrow can be recorded as a campaign budget`,
          { stakeId: input.stakeId, state: stake.state },
        );
      }
      if (stake.unit !== "credits") {
        throw campaignValidationError(
          `stake ${input.stakeId} unit must be credits (got ${stake.unit})`,
          { stakeId: input.stakeId, unit: stake.unit },
        );
      }
      if (stake.amount !== policy.budget.totalAmount) {
        throw campaignValidationError(
          `stake ${input.stakeId} amount (${stake.amount}) must equal the declared budget total (${policy.budget.totalAmount})`,
          { stakeId: input.stakeId, stakeAmount: stake.amount, declaredTotal: policy.budget.totalAmount },
        );
      }

      const key = `campaign_budget_commit:${campaign.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        campaignLockKey(campaign.id),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const inTx =
              (await repository.findByIdWithinTx(campaign.id, tx)) ?? campaign;
            // In-tx re-checks (the record mutex serializes rivals;
            // a same-stake re-run is the idempotent replay path —
            // the committed fast-path above already returned it).
            if (
              inTx.budget.stakeId !== null &&
              inTx.budget.stakeId !== input.stakeId
            ) {
              throw new ConflictError(
                `campaign ${campaign.id} already carries a budget commitment (stake ${inTx.budget.stakeId})`,
                { campaignId: campaign.id, stakeId: inTx.budget.stakeId },
              );
            }
            const event = buildEvent(
              "budget_committed",
              execution,
              actor,
              null,
              {
                stakeId: input.stakeId,
                committedAmount: stake.amount,
                unit: stake.unit,
                policyVersion: policy.version,
                declaredTotal: policy.budget.totalAmount,
              },
            );
            const updated = withEvent(inTx, event, {
              budget: Object.freeze({
                stakeId: input.stakeId,
                committedAmount: stake.amount,
                committedAt: stake.committedAt,
                releasedAt: null,
              }),
            });
            await repository.saveWithinTx(updated, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: CAMPAIGN_BUDGET_COMMITTED,
              context: execution,
              actor,
              subject: campaign.id,
              resourceType: "campaign",
              resourceId: campaign.id,
              metadata: {
                organizationScopeId: campaign.organizationScopeId,
                campaignId: campaign.id,
                stakeId: input.stakeId,
                committedAmount: stake.amount,
                unit: stake.unit,
                policyVersion: policy.version,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return updated;
          }, execution),
      );
      logger.info("campaign.budget_committed", {
        campaignId: applied.result.id,
        stakeId: input.stakeId,
      });
      return applied.result;
    },

    async recordBudgetRelease(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.stakeId?.trim()) {
        throw campaignValidationError("stakeId is required", {
          field: "stakeId",
        });
      }
      const actor = actingPersonId(execution);
      const campaign = await loadCampaign(undefined, input.campaignId);
      assertOwner(campaign, actor);
      if (
        campaign.status !== "COMPLETED" &&
        campaign.status !== "CANCELLED"
      ) {
        throw new ConflictError(
          `campaign ${campaign.id} is ${campaign.status} — the budget may only be released after a terminal status`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      if (campaign.budget.stakeId === null) {
        throw campaignValidationError(
          `campaign ${campaign.id} carries no budget commitment to release`,
          { campaignId: campaign.id },
        );
      }
      if (
        campaign.budget.releasedAt !== null &&
        campaign.budget.stakeId !== input.stakeId
      ) {
        throw new ConflictError(
          `campaign ${campaign.id}'s budget was already released (at ${campaign.budget.releasedAt})`,
          { campaignId: campaign.id, releasedAt: campaign.budget.releasedAt },
        );
      }
      // VERIFY the settlement authority executed the release first
      // (read-only lookup — the composition root sequences release →
      // record).
      const stake = await lookups.stake.resolveStake(input.stakeId);
      if (!stake) {
        throw new NotFoundError(
          `stake not found: ${input.stakeId}`,
          { stakeId: input.stakeId },
        );
      }
      if (stake.state !== "RELEASED") {
        throw campaignValidationError(
          `stake ${input.stakeId} is ${stake.state} — the settlement authority must release the escrow before the release is recorded`,
          { stakeId: input.stakeId, state: stake.state },
        );
      }
      if (input.stakeId !== campaign.budget.stakeId) {
        throw campaignValidationError(
          `stake ${input.stakeId} is not the campaign's committed budget (expected ${campaign.budget.stakeId})`,
          { stakeId: input.stakeId, expected: campaign.budget.stakeId },
        );
      }

      const key = `campaign_budget_release:${campaign.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const inTx =
            (await repository.findByIdWithinTx(campaign.id, tx)) ?? campaign;
          if (
            inTx.budget.releasedAt !== null &&
            inTx.budget.stakeId !== input.stakeId
          ) {
            throw new ConflictError(
              `campaign ${campaign.id}'s budget was already released`,
              { campaignId: campaign.id },
            );
          }
          const event = buildEvent(
            "budget_released",
            execution,
            actor,
            null,
            {
              stakeId: input.stakeId,
              committedAmount: inTx.budget.committedAmount,
              releasedStakeState: stake.state,
            },
          );
          const updated = withEvent(inTx, event, {
            budget: Object.freeze({
              ...inTx.budget,
              releasedAt: event.recordedAt,
            }),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CAMPAIGN_BUDGET_RELEASED,
            context: execution,
            actor,
            subject: campaign.id,
            resourceType: "campaign",
            resourceId: campaign.id,
            metadata: {
              organizationScopeId: campaign.organizationScopeId,
              campaignId: campaign.id,
              stakeId: input.stakeId,
              committedAmount: inTx.budget.committedAmount,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        },
        execution,
      );
      logger.info("campaign.budget_released", {
        campaignId: applied.result.id,
        stakeId: input.stakeId,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // NET-W014 clearing bookkeeping (references to settlement-executed
    // draws — the budget-commitment precedent; REFERENCES ONLY).
    // ------------------------------------------------------------------
    async recordClearingExecution(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.clearingRuleId?.trim()) {
        throw campaignValidationError("clearingRuleId is required", {
          field: "clearingRuleId",
        });
      }
      if (!input.valueRecordId?.trim()) {
        throw campaignValidationError("valueRecordId is required", {
          field: "valueRecordId",
        });
      }
      if (!input.resultId?.trim()) {
        throw campaignValidationError("resultId is required", {
          field: "resultId",
        });
      }
      if (
        input.drawKind !== "reward_allocation" &&
        input.drawKind !== "credit_issuance" &&
        input.drawKind !== "cash_obligation"
      ) {
        throw campaignValidationError(
          `drawKind must be one of reward_allocation | credit_issuance | cash_obligation (got ${String(input.drawKind)})`,
          { drawKind: input.drawKind },
        );
      }
      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw campaignValidationError(
          "amount must be a positive finite number",
          { amount: input.amount },
        );
      }
      const actor = actingPersonId(execution);
      const campaign = await loadCampaign(undefined, input.campaignId);
      assertOwner(campaign, actor);
      if (campaign.status !== "ACTIVE") {
        throw new ConflictError(
          `campaign ${campaign.id} is ${campaign.status} — clearing executions can only be recorded while ACTIVE`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      const policy = await latestPolicy(campaign.id);
      if (policy === null) {
        throw campaignValidationError(
          `campaign ${campaign.id} has no policy version — the clearing rules are undefined`,
          { campaignId: campaign.id },
        );
      }
      const rule = policy.clearingRules.find(
        (r) => r.id === input.clearingRuleId,
      );
      if (!rule) {
        throw new NotFoundError(
          `clearing rule not found: ${input.clearingRuleId} (policy version ${policy.version})`,
          {
            campaignId: campaign.id,
            clearingRuleId: input.clearingRuleId,
            policyVersion: policy.version,
          },
        );
      }

      const key = `campaign_clearing_execution:${campaign.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        campaignLockKey(campaign.id),
        () =>
          idempotency.applyIdempotent(
            key,
            (ctx) =>
              service.recordClearingExecutionWithinTx(execution, input, ctx),
            execution,
          ),
      );
      logger.info("campaign.clearing_executed", {
        campaignId: applied.result.id,
        clearingRuleId: input.clearingRuleId,
        drawKind: input.drawKind,
      });
      return applied.result;
    },

    async recordClearingExecutionWithinTx(execution, input, ctx) {
      // NET-W020 remediation (PR #40 review): the SAME bookkeeping body
      // as the standalone command, on the CALLER'S authoritative
      // transaction (ctx.transaction). No own idempotency apply, no
      // campaign-record lock acquisition — the CALLER holds the
      // campaign lock across the whole composite (the bookkeeping
      // port's lock key) and the caller's transaction IS the atomicity
      // boundary.
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.clearingRuleId?.trim()) {
        throw campaignValidationError("clearingRuleId is required", {
          field: "clearingRuleId",
        });
      }
      if (!input.valueRecordId?.trim()) {
        throw campaignValidationError("valueRecordId is required", {
          field: "valueRecordId",
        });
      }
      if (!input.resultId?.trim()) {
        throw campaignValidationError("resultId is required", {
          field: "resultId",
        });
      }
      if (
        input.drawKind !== "reward_allocation" &&
        input.drawKind !== "credit_issuance" &&
        input.drawKind !== "cash_obligation"
      ) {
        throw campaignValidationError(
          `drawKind must be one of reward_allocation | credit_issuance | cash_obligation (got ${String(input.drawKind)})`,
          { drawKind: input.drawKind },
        );
      }
      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw campaignValidationError(
          "amount must be a positive finite number",
          { amount: input.amount },
        );
      }
      const actor = actingPersonId(execution);
      const campaign = await loadCampaign(undefined, input.campaignId);
      assertOwner(campaign, actor);
      if (campaign.status !== "ACTIVE") {
        throw new ConflictError(
          `campaign ${campaign.id} is ${campaign.status} — clearing executions can only be recorded while ACTIVE`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      const policy = await latestPolicy(campaign.id);
      if (policy === null) {
        throw campaignValidationError(
          `campaign ${campaign.id} has no policy version — the clearing rules are undefined`,
          { campaignId: campaign.id },
        );
      }
      const rule = policy.clearingRules.find(
        (r) => r.id === input.clearingRuleId,
      );
      if (!rule) {
        throw new NotFoundError(
          `clearing rule not found: ${input.clearingRuleId} (policy version ${policy.version})`,
          {
            campaignId: campaign.id,
            clearingRuleId: input.clearingRuleId,
            policyVersion: policy.version,
          },
        );
      }

      const tx = ctx.transaction;
      const inTx =
        (await repository.findByIdWithinTx(campaign.id, tx)) ?? campaign;
      // In-tx re-check (the caller's campaign lock serializes rivals).
      if (inTx.status !== "ACTIVE") {
        throw new ConflictError(
          `campaign ${campaign.id} is ${inTx.status} — clearing executions can only be recorded while ACTIVE`,
          { campaignId: campaign.id, status: inTx.status },
        );
      }
      const event = buildEvent(
        "clearing_executed",
        execution,
        actor,
        input.description?.trim() || null,
        {
          clearingRuleId: rule.id,
          objectiveId: rule.objectiveId,
          basis: rule.basis,
          drawKind: input.drawKind,
          valueRecordId: input.valueRecordId,
          resultId: input.resultId,
          amount: input.amount,
          policyVersion: policy.version,
        },
      );
      const updated = withEvent(inTx, event, {});
      await repository.saveWithinTx(updated, tx);
      const buffer = auditWriter.forTransaction(tx);
      await buffer.append({
        eventType: CAMPAIGN_CLEARING_EXECUTED,
        context: execution,
        actor,
        subject: campaign.id,
        resourceType: "campaign",
        resourceId: campaign.id,
        metadata: {
          organizationScopeId: campaign.organizationScopeId,
          campaignId: campaign.id,
          clearingRuleId: rule.id,
          drawKind: input.drawKind,
          valueRecordId: input.valueRecordId,
          resultId: input.resultId,
          amount: input.amount,
          policyVersion: policy.version,
          idempotencyRecordId: ctx.recordId,
          transactionId: tx.transactionId,
        },
      });
      return updated;
    },

    // ------------------------------------------------------------------
    // Opportunity composition (verify → compose at the root → record).
    // ------------------------------------------------------------------
    async resolveOpportunityDraft(execution, campaignId, specId) {
      void execution;
      const campaign = await loadCampaign(undefined, campaignId);
      if (campaign.status !== "ACTIVE") {
        throw new ConflictError(
          `campaign ${campaign.id} is ${campaign.status} — opportunities can only be published from an ACTIVE campaign`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      const policy = await latestPolicy(campaign.id);
      if (policy === null) {
        throw campaignValidationError(
          `campaign ${campaign.id} has no policy version to publish from`,
          { campaignId: campaign.id },
        );
      }
      const spec = policy.opportunitySpecs.find((s) => s.id === specId);
      if (!spec) {
        throw new NotFoundError(
          `opportunity spec not found: ${specId} (policy version ${policy.version})`,
          { campaignId: campaign.id, specId, policyVersion: policy.version },
        );
      }
      const draft: CampaignOpportunityDraft = Object.freeze({
        campaignId: campaign.id,
        policyVersion: policy.version,
        specId: spec.id,
        organizationScopeId: campaign.organizationScopeId,
        title: spec.title,
        opportunityType: spec.opportunityType,
        brief: spec.brief,
        contributionRequirements: spec.contributionRequirements,
        evidenceReferencePlaceholders: spec.evidenceReferencePlaceholders,
        eligibilityPolicyReference: campaignEligibilityPolicyReference(
          campaign.id,
          policy.version,
          spec.id,
        ),
      });
      return draft;
    },

    async recordOpportunityPublication(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.opportunityId?.trim()) {
        throw campaignValidationError("opportunityId is required", {
          field: "opportunityId",
        });
      }
      const actor = actingPersonId(execution);
      const campaign = await loadCampaign(undefined, input.campaignId);
      assertOwner(campaign, actor);
      if (campaign.status !== "ACTIVE") {
        throw new ConflictError(
          `campaign ${campaign.id} is ${campaign.status} — opportunities can only be published from an ACTIVE campaign`,
          { campaignId: campaign.id, status: campaign.status },
        );
      }
      const policy = await policyRepository.findVersion(
        campaign.id,
        input.policyVersion,
      );
      if (!policy) {
        throw new NotFoundError(
          `campaign policy not found: ${campaign.id} version ${input.policyVersion}`,
          { campaignId: campaign.id, policyVersion: input.policyVersion },
        );
      }
      const spec = policy.opportunitySpecs.find((s) => s.id === input.specId);
      if (!spec) {
        throw new NotFoundError(
          `opportunity spec not found: ${input.specId} (policy version ${input.policyVersion})`,
          { campaignId: campaign.id, specId: input.specId },
        );
      }
      // VERIFY the composed opportunity (read-only lookup over the
      // opportunities boundary): same scope, same type and the EXACT
      // versioned eligibility reference.
      const expectedReference = campaignEligibilityPolicyReference(
        campaign.id,
        policy.version,
        spec.id,
      );
      const opportunity = await lookups.opportunity.resolveOpportunity(
        input.opportunityId,
      );
      if (!opportunity) {
        throw new NotFoundError(
          `opportunity not found: ${input.opportunityId}`,
          { opportunityId: input.opportunityId },
        );
      }
      if (opportunity.organizationScopeId !== campaign.organizationScopeId) {
        throw campaignValidationError(
          `opportunity ${input.opportunityId} belongs to organization scope ${opportunity.organizationScopeId}, not ${campaign.organizationScopeId}`,
          {
            opportunityId: input.opportunityId,
            opportunityScope: opportunity.organizationScopeId,
          },
        );
      }
      if (opportunity.opportunityType !== spec.opportunityType) {
        throw campaignValidationError(
          `opportunity ${input.opportunityId} type ${opportunity.opportunityType} does not match spec ${spec.id} type ${spec.opportunityType}`,
          { opportunityId: input.opportunityId, specId: spec.id },
        );
      }
      if (opportunity.eligibilityPolicyReference !== expectedReference) {
        throw campaignValidationError(
          `opportunity ${input.opportunityId} eligibility reference must be ${expectedReference} (got ${String(opportunity.eligibilityPolicyReference)})`,
          {
            opportunityId: input.opportunityId,
            expectedReference,
            actualReference: opportunity.eligibilityPolicyReference,
          },
        );
      }

      const key = `campaign_publish:${campaign.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const inTx =
            (await repository.findByIdWithinTx(campaign.id, tx)) ?? campaign;
          if (inTx.status !== "ACTIVE") {
            throw new ConflictError(
              `campaign ${campaign.id} is ${inTx.status} — publication can only be recorded while ACTIVE`,
              { campaignId: campaign.id, status: inTx.status },
            );
          }
          const event = buildEvent(
            "opportunity_published",
            execution,
            actor,
            null,
            {
              opportunityId: input.opportunityId,
              specId: spec.id,
              policyVersion: policy.version,
              eligibilityPolicyReference: expectedReference,
            },
          );
          const updated = withEvent(inTx, event, {
            currentPolicyVersion: policy.version,
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CAMPAIGN_OPPORTUNITY_PUBLISHED,
            context: execution,
            actor,
            subject: campaign.id,
            resourceType: "campaign",
            resourceId: campaign.id,
            metadata: {
              organizationScopeId: campaign.organizationScopeId,
              campaignId: campaign.id,
              opportunityId: input.opportunityId,
              specId: spec.id,
              policyVersion: policy.version,
              eligibilityPolicyReference: expectedReference,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        },
        execution,
      );
      logger.info("campaign.opportunity_published", {
        campaignId: applied.result.id,
        opportunityId: input.opportunityId,
      });
      return applied.result;
    },

    async listPublishedOpportunities(execution, campaignId) {
      void execution;
      const campaign = await loadCampaign(undefined, campaignId);
      const published: {
        opportunityId: string;
        specId: string;
        policyVersion: number;
        publishedAt: string;
      }[] = [];
      for (const event of campaign.events) {
        if (event.event !== "opportunity_published") continue;
        published.push({
          opportunityId: String(event.details.opportunityId ?? ""),
          specId: String(event.details.specId ?? ""),
          policyVersion: Number(event.details.policyVersion ?? 0),
          publishedAt: event.recordedAt,
        });
      }
      return published;
    },
  };

  /**
   * The shared status-transition engine: owner-only, per-record mutex,
   * in-tx state re-check, append-only event + atomic audit.
   */
  async function statusTransition(
    execution: ExecutionContext,
    input: CampaignStatusInput,
    spec: {
      readonly from: readonly string[];
      readonly to: string;
      readonly event: CampaignEventKind;
      readonly auditType: string;
      readonly gate?: (campaign: CampaignRecord) => Promise<void>;
    },
  ): Promise<CampaignRecord> {
    assertIdempotencyKey(input.idempotencyKey);
    if (!input.campaignId?.trim()) {
      throw campaignValidationError("campaignId is required", {
        field: "campaignId",
      });
    }
    const actor = actingPersonId(execution);
    const campaign = await loadCampaign(undefined, input.campaignId);
    assertOwner(campaign, actor);
    // Replay tolerance: when the record ALREADY sits in the target
    // state the call may be a same-key idempotent REPLAY — let
    // applyIdempotent decide (the committed fast-path replays the
    // cached record; a FRESH key re-runs fn and the in-tx source
    // check rejects the genuinely illegal transition).
    if (
      !spec.from.includes(campaign.status) &&
      campaign.status !== spec.to
    ) {
      throw new ConflictError(
        `campaign ${campaign.id} cannot transition ${campaign.status} → ${spec.to} (legal source states: ${spec.from.join(", ")})`,
        { campaignId: campaign.id, status: campaign.status, target: spec.to },
      );
    }
    if (spec.gate && spec.from.includes(campaign.status)) {
      await spec.gate(campaign);
    }

    const key = `campaign_${spec.event}:${campaign.organizationScopeId}:${input.idempotencyKey}`;
    const applied = await idempotency.withLock(
      campaignLockKey(campaign.id),
      () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const inTx =
            (await repository.findByIdWithinTx(campaign.id, tx)) ?? campaign;
          if (!spec.from.includes(inTx.status)) {
            throw new ConflictError(
              `campaign ${campaign.id} cannot transition ${inTx.status} → ${spec.to} (concurrent mutation won)`,
              { campaignId: campaign.id, status: inTx.status, target: spec.to },
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
            status: spec.to as CampaignRecord["status"],
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: spec.auditType,
            context: execution,
            actor,
            subject: campaign.id,
            resourceType: "campaign",
            resourceId: campaign.id,
            metadata: {
              organizationScopeId: campaign.organizationScopeId,
              campaignId: campaign.id,
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
    logger.info(`campaign.${spec.event}`, {
      campaignId: applied.result.id,
      status: applied.result.status,
    });
    return applied.result;
  }

  return service;
}
