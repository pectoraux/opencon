/**
 * Campaigns boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §7 (Farmable contribution
 * market), §18 (Module ownership: `/campaigns` owns campaign domain
 * rules — campaign policy/configuration); spec/architecture-lock.md
 * §2 (the sixteen frozen core domains), §5 (economic authority —
 * every economic commitment/clearing goes through `/settlement`),
 * §7 (`/workflows` is the sole lifecycle authority).
 *
 * Work order ref: spec/work-orders/NET-W011.md
 *   §3.1 First-class durable campaign records (organization/
 *        participant scope, administrative status, append-only
 *        history, auditability).
 *   §3.2 Versioned campaign policy: objectives, eligibility,
 *        outcome/evidence policy, budget, attribution rules,
 *        clearing rules, opportunity specs (CAMP-002: defined
 *        BEFORE activation).
 *   §3.3 Budget commitments + clearing rules CONSUME /settlement
 *        (no hidden balances, no parallel ledger).
 *   §3.4 Campaign-to-opportunity composition through /workflows
 *        (campaigns never become a second lifecycle authority).
 *
 * Requirements: CAMP-001..005, API-002 (server-side authorization).
 *
 * CROSS-BOUNDARY NOTE: this boundary is `domain` tier. The tier allow
 * matrix prohibits domain→infrastructure, domain→adapter and
 * domain→other-domain imports. This port therefore consumes ONLY core
 * contracts. Cross-domain reads (settlement stakes, reward policies,
 * opportunities, persons) happen through the NEUTRAL structural
 * lookup interfaces declared here — the bootstrap composition root
 * wires thin adapters over the wired repositories of the owning
 * domains (the same dependency-inversion pattern as NET-W005's
 * SubjectLookup, NET-W006's OutcomeClaimLookup, NET-W007's five
 * reputation lookups and NET-W009/010's dispute lookups).
 *
 * THE KEY RULES (work order §4 — authority separation):
 *  - `/campaigns` owns campaign POLICY/CONFIGURATION only;
 *  - `/workflows` owns the opportunity/contribution lifecycle:
 *    publishing COMPOSES an opportunity through the opportunity
 *    service at the composition root; the campaign domain never
 *    mutates a lifecycle state and carries no lifecycle fields;
 *  - `/settlement` owns the economics: budget commitments are
 *    ESCROWED through the settlement authority's stake commands with
 *    the `campaign_budget` purpose; the campaign record only carries
 *    REFERENCES (the NET-W010 stake-block precedent) — no balances,
 *    no postings, no second ledger (AC-03);
 *  - `/evidence` remains the truth authority and `/outcomes` the
 *    measurement authority: policies REFERENCE the frozen
 *    vocabularies — they never redefine or evaluate them;
 *  - `/reputation` remains the trust-signal authority: eligibility
 *    policy may REFERENCE neutral reputation tiers later; nothing
 *    here mutates reputation;
 *  - clearing rules are DECLARED policy consumed by NET-W014;
 *    executing them is an explicit NET-W011 non-goal.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type {
  CampaignClearingBasis,
  CampaignClearingDrawKind,
  CampaignEligibilityAttribute,
  CampaignEligibilityOperator,
  CampaignEvidenceRequirementKind,
  CampaignObjectiveKind,
  CampaignStatus,
} from "../core/campaigns.ts";
import type {
  AttributionMode,
} from "../core/measurement.ts";
import type { OutcomeType } from "../core/evidence.ts";

// ---------------------------------------------------------------------------
// Campaign records + the administrative status machine (work order §3.1)
// ---------------------------------------------------------------------------

/** The append-only campaign history events. */
export const CAMPAIGN_EVENTS = [
  "created",
  "policy_defined",
  "activated",
  "paused",
  "resumed",
  "completed",
  "cancelled",
  "budget_committed",
  "budget_released",
  "opportunity_published",
] as const;

export type CampaignEventKind = (typeof CAMPAIGN_EVENTS)[number];

export function isCampaignEventKind(value: string): value is CampaignEventKind {
  return (CAMPAIGN_EVENTS as readonly string[]).includes(value);
}

/**
 * One append-only event in a campaign's history. Actor identity is
 * the EXECUTION ACTOR (server-side; never caller-asserted). Event
 * content is immutable; the derived `status` only ever moves forward
 * through these audited events.
 */
export interface CampaignEvent {
  readonly id: string;
  readonly event: CampaignEventKind;
  readonly actorPersonId: string;
  readonly note: string | null;
  /** Structured, provider-neutral details (version refs, ids, amounts). */
  readonly details: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
  readonly executionId: string;
  readonly correlationId: string;
}

/**
 * The campaign's budget bookkeeping — REFERENCES ONLY (the exact
 * NET-W010 DisputeStakeBlock precedent). The DECLARED budget lives in
 * the pinned policy version (the source of truth); this block records
 * WHAT THE SETTLEMENT AUTHORITY EXECUTED: the escrowed stake's id,
 * the committed amount and, after a terminal release, the release
 * reference. The campaign domain never posts, never holds balances
 * and never computes remaining funds (AC-03 — no hidden ledger).
 */
export interface CampaignBudgetBlock {
  readonly stakeId: string | null;
  readonly committedAmount: number | null;
  readonly committedAt: string | null;
  readonly releasedAt: string | null;
}

/**
 * A CampaignRecord — a first-class, durable, organization-scoped
 * campaign with an immutable, append-only event history (AC-01).
 *
 * Invariants:
 *  - `organizationScopeId` is the tenant/participant scope; every
 *    mutation validates it (tenant isolation, API-002).
 *  - `ownerPersonId` is the campaign owner (the creator); policy +
 *    status + budget mutations are owner-only (server-side).
 *  - `status` is the administrative status machine owned by this
 *    boundary (core/campaigns.ts) — NOT a workflow lifecycle state.
 *  - `currentPolicyVersion` mirrors the latest policy version at the
 *    last mutation (deterministic reproducibility; the authoritative
 *    lineage lives in the policy repository).
 *  - `events` is append-only; past events are never rewritten.
 */
export interface CampaignRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerPersonId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: CampaignStatus;
  readonly currentPolicyVersion: number | null;
  readonly budget: CampaignBudgetBlock;
  readonly events: readonly CampaignEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Versioned campaign policy (work order §3.2; CAMP-001/002)
// ---------------------------------------------------------------------------

/** A campaign objective (CAMP-001): a closed-vocabulary kind + prose. */
export interface CampaignObjective {
  /** Spec-local stable id (referenced by requirements/rules). */
  readonly id: string;
  readonly kind: CampaignObjectiveKind;
  readonly description: string | null;
  /** Provider-neutral success statement (optional prose). */
  readonly successCriteria: string | null;
}

/**
 * One provider-neutral eligibility rule (AC-06): a closed-vocabulary
 * attribute, a closed-vocabulary operator and explicit values. NOT
 * evaluated by the campaign domain — published opportunities carry
 * the versioned reference; enforcement belongs to the consuming
 * boundaries (NET-W012+).
 */
export interface CampaignEligibilityRule {
  readonly attribute: CampaignEligibilityAttribute;
  readonly operator: CampaignEligibilityOperator;
  readonly values: readonly string[];
}

export interface CampaignEligibilityPolicy {
  readonly rules: readonly CampaignEligibilityRule[];
}

/**
 * One outcome requirement: what must be MEASURED for an objective —
 * referencing the frozen /outcomes vocabulary (standard outcome
 * types + attribution modes). The campaign domain never measures.
 */
export interface CampaignOutcomeRequirement {
  readonly objectiveId: string;
  readonly outcomeType: OutcomeType;
  readonly attributionMode: AttributionMode;
  readonly windowDays: number;
  readonly requiresExperiment: boolean;
}

export interface CampaignOutcomePolicy {
  readonly requirements: readonly CampaignOutcomeRequirement[];
}

/**
 * One evidence requirement: what PROOF an objective demands —
 * referencing the frozen /evidence vocabulary (requirement record
 * kind, minimum grade, qualifying source types). The campaign domain
 * never grades or verifies evidence.
 */
export interface CampaignEvidenceRequirement {
  readonly objectiveId: string;
  readonly requirementKind: CampaignEvidenceRequirementKind;
  readonly minimumGrade: string | null;
  readonly qualifyingSourceTypes: readonly string[] | null;
}

export interface CampaignEvidencePolicy {
  readonly requirements: readonly CampaignEvidenceRequirement[];
}

/**
 * The declared budget — POLICY ONLY (AC-03): a total amount in the
 * `credits` unit plus optional per-objective envelopes. The amount is
 * a DECLARATION: the actual encumbrance is the settlement escrow
 * committed through the composition root; no balances live here.
 */
export interface CampaignBudgetPolicy {
  readonly unit: "credits";
  readonly totalAmount: number;
  readonly perObjective: readonly {
    readonly objectiveId: string;
    readonly amount: number;
  }[];
}

/**
 * One attribution rule: how attributed credit is assigned for an
 * objective — referencing the frozen /outcomes attribution modes and
 * a quantified confidence threshold (CAMP-002 confidence policy).
 * Attribution COMPUTATION is /outcomes authority (NET-W006); rules
 * declared here are consumed downstream (NET-W014).
 */
export interface CampaignAttributionRule {
  readonly id: string;
  readonly objectiveId: string;
  readonly model: AttributionMode;
  /** Confidence threshold in [0, 1] that attribution must meet. */
  readonly confidenceThreshold: number;
  readonly windowDays: number;
  readonly requiresExperiment: boolean;
}

/**
 * One clearing rule (CAMP-005 multilateral clearing): the declared
 * basis and the settlement primitive through which cleared value may
 * be drawn, with a hard cap. EXECUTION is NET-W014 (explicit
 * non-goal); `rewardPolicyId` must reference an existing settlement
 * reward-policy lineage when `drawKind` is `reward_allocation`.
 */
export interface CampaignClearingRule {
  readonly id: string;
  readonly objectiveId: string;
  readonly basis: CampaignClearingBasis;
  readonly drawKind: CampaignClearingDrawKind;
  /** Required (and resolved same-scope) for reward_allocation draws. */
  readonly rewardPolicyId: string | null;
  readonly maxDrawAmount: number;
}

/**
 * One contribution-opportunity specification — the provider-neutral
 * template the composition root materializes into a real Opportunity
 * (owned by /opportunities, lifecycle-owned by /workflows) when
 * publishing (work order §3.4).
 */
export interface CampaignOpportunitySpec {
  readonly id: string;
  readonly title: string;
  readonly opportunityType: string;
  readonly brief: Readonly<Record<string, unknown>>;
  readonly contributionRequirements: Readonly<Record<string, unknown>>;
  readonly evidenceReferencePlaceholders: readonly string[];
}

/**
 * A CampaignPolicy — an immutable, versioned record of the campaign's
 * complete declared policy (CAMP-002). Version lineage: `version`
 * increases by exactly 1 (version 1 starts the lineage); a
 * (campaignId, version) pair is unique; existing versions are NEVER
 * rewritten; all versions share the campaign's organization scope
 * (serialized under the ORGANIZATION-INDEPENDENT mutex
 * `campaign_policy_lineage:{campaignId}` — the NET-W007/008/010
 * policy-lineage pattern).
 */
export interface CampaignPolicy {
  readonly id: string;
  readonly campaignId: string;
  readonly organizationScopeId: string;
  readonly version: number;
  /** The frozen policy-format lineage (core: CAMPAIGN_POLICY_FORMAT). */
  readonly formatVersion: string;
  readonly objectives: readonly CampaignObjective[];
  readonly eligibility: CampaignEligibilityPolicy;
  readonly outcomePolicy: CampaignOutcomePolicy;
  readonly evidencePolicy: CampaignEvidencePolicy;
  readonly budget: CampaignBudgetPolicy;
  readonly attributionRules: readonly CampaignAttributionRule[];
  readonly clearingRules: readonly CampaignClearingRule[];
  readonly opportunitySpecs: readonly CampaignOpportunitySpec[];
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
 * Structural view of a settlement stake resolved through the NEUTRAL
 * stake lookup (read-only over the settlement boundary's stake
 * repository — the same dependency inversion as the NET-W010 dispute
 * stake lookup). The campaign domain never posts or mutates stakes;
 * it only VERIFIES the linkage when recording a budget commitment.
 */
export interface CampaignResolvedStake {
  readonly organizationScopeId: string;
  readonly ownerPersonId: string;
  readonly amount: number;
  readonly unit: string;
  readonly state: string;
  readonly purposeKind: string;
  readonly purposeId: string;
  readonly committedAt: string;
}

/** Over the settlement boundary's stake records (read-only). */
export interface CampaignStakeLookup {
  resolveStake(id: string): Promise<CampaignResolvedStake | null>;
}

/**
 * Structural view of a reward-allocation policy lineage resolved
 * through the NEUTRAL reward-policy lookup (read-only over the
 * settlement boundary's reward-policy repository). Clearing rules
 * referencing a reward policy must resolve same-scope.
 */
export interface CampaignResolvedRewardPolicy {
  readonly organizationScopeId: string;
  readonly latestVersion: number;
}

/** Over the settlement boundary's reward-policy records (read-only). */
export interface CampaignRewardPolicyLookup {
  resolvePolicy(policyId: string): Promise<CampaignResolvedRewardPolicy | null>;
}

/**
 * Structural view of a published opportunity resolved through the
 * NEUTRAL opportunity lookup (read-only over the opportunities
 * boundary's repository). The publication bookkeeping verifies the
 * composition root actually created the opportunity with the exact
 * versioned eligibility reference.
 */
export interface CampaignResolvedOpportunity {
  readonly organizationScopeId: string;
  readonly state: string;
  readonly opportunityType: string;
  readonly eligibilityPolicyReference: string | null;
}

/** Over the opportunities boundary's records (read-only). */
export interface CampaignOpportunityLookup {
  resolveOpportunity(id: string): Promise<CampaignResolvedOpportunity | null>;
}

/** The campaign owner must exist (over identity; read-only). */
export interface CampaignPersonLookup {
  exists(personId: string): Promise<boolean>;
}

export interface CampaignLookups {
  readonly person: CampaignPersonLookup;
  readonly stake: CampaignStakeLookup;
  readonly rewardPolicy: CampaignRewardPolicyLookup;
  readonly opportunity: CampaignOpportunityLookup;
}

// ---------------------------------------------------------------------------
// Inputs / results
// ---------------------------------------------------------------------------

export interface CreateCampaignInput {
  readonly organizationScopeId: string;
  readonly name: string;
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface CreateCampaignResult {
  readonly campaign: CampaignRecord;
  /** false when a campaign with the same idempotency key already existed. */
  readonly created: boolean;
}

/** The full declared policy (all sections required — CAMP-002). */
export interface CampaignPolicySections {
  readonly objectives: readonly CampaignObjective[];
  readonly eligibility: CampaignEligibilityPolicy;
  readonly outcomePolicy: CampaignOutcomePolicy;
  readonly evidencePolicy: CampaignEvidencePolicy;
  readonly budget: CampaignBudgetPolicy;
  readonly attributionRules: readonly CampaignAttributionRule[];
  readonly clearingRules: readonly CampaignClearingRule[];
  readonly opportunitySpecs: readonly CampaignOpportunitySpec[];
}

export interface DefineCampaignPolicyInput {
  readonly campaignId: string;
  readonly policy: CampaignPolicySections;
  readonly idempotencyKey: string;
}

export interface DefineCampaignPolicyResult {
  readonly policy: CampaignPolicy;
  /** false when this idempotency key already defined a version. */
  readonly created: boolean;
}

export interface CampaignStatusInput {
  readonly campaignId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

/**
 * Record the budget commitment the SETTLEMENT authority executed
 * (append-only bookkeeping; the escrow itself is never touched here).
 * Verifies through the read-only stake lookup: same scope, owner ==
 * campaign owner, purpose `campaign_budget:{campaignId}`, state
 * COMMITTED, amount == the current policy's declared total.
 */
export interface RecordBudgetCommitmentInput {
  readonly campaignId: string;
  readonly stakeId: string;
  readonly idempotencyKey: string;
}

/**
 * Record the budget release the SETTLEMENT authority executed (only
 * after the campaign reached a terminal status). Verifies the stake
 * state RELEASED through the read-only stake lookup.
 */
export interface RecordBudgetReleaseInput {
  readonly campaignId: string;
  readonly stakeId: string;
  readonly idempotencyKey: string;
}

/**
 * Record that the composition root published the opportunity for a
 * spec of a policy version (append-only bookkeeping). Verifies through
 * the read-only opportunity lookup: same scope, opportunity type and
 * the EXACT versioned eligibility reference.
 */
export interface RecordOpportunityPublicationInput {
  readonly campaignId: string;
  readonly specId: string;
  readonly policyVersion: number;
  readonly opportunityId: string;
  readonly idempotencyKey: string;
}

/**
 * A resolved publish draft — the provider-neutral fields the
 * composition root materializes into a real Opportunity through the
 * opportunity service (never a domain-to-domain call). Includes the
 * deterministic versioned eligibility reference.
 */
export interface CampaignOpportunityDraft {
  readonly campaignId: string;
  readonly policyVersion: number;
  readonly specId: string;
  readonly organizationScopeId: string;
  readonly title: string;
  readonly opportunityType: string;
  readonly brief: Readonly<Record<string, unknown>>;
  readonly contributionRequirements: Readonly<Record<string, unknown>>;
  readonly evidenceReferencePlaceholders: readonly string[];
  readonly eligibilityPolicyReference: string;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface CampaignRepository {
  save(campaign: CampaignRecord, execution: ExecutionContext): Promise<CampaignRecord>;
  findById(id: string): Promise<CampaignRecord | null>;
  listByOrganization(
    organizationScopeId: string,
    statuses?: readonly string[],
  ): Promise<readonly CampaignRecord[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<CampaignRecord | null>;
  createWithinTx(
    campaign: CampaignRecord,
    tx: AuthorityTransaction,
  ): Promise<CampaignRecord>;
  saveWithinTx(
    campaign: CampaignRecord,
    tx: AuthorityTransaction,
  ): Promise<CampaignRecord>;
}

export interface CampaignPolicyRepository {
  findById(id: string): Promise<CampaignPolicy | null>;
  findVersion(
    campaignId: string,
    version: number,
  ): Promise<CampaignPolicy | null>;
  listByCampaign(campaignId: string): Promise<readonly CampaignPolicy[]>;
  findVersionWithinTx(
    campaignId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<CampaignPolicy | null>;
  findLatestWithinTx(
    campaignId: string,
    tx: AuthorityTransaction,
  ): Promise<CampaignPolicy | null>;
  createWithinTx(
    policy: CampaignPolicy,
    tx: AuthorityTransaction,
  ): Promise<CampaignPolicy>;
}

// ---------------------------------------------------------------------------
// The domain service
// ---------------------------------------------------------------------------

export interface CampaignService {
  /**
   * Create a campaign (person actor = owner; DRAFT). Validates the
   * owner exists and commits atomically with the `campaign.created`
   * audit event.
   */
  createCampaign(
    execution: ExecutionContext,
    input: CreateCampaignInput,
  ): Promise<CreateCampaignResult>;
  getCampaign(execution: ExecutionContext, id: string): Promise<CampaignRecord>;
  listCampaigns(
    execution: ExecutionContext,
    organizationScopeId: string,
    statuses?: readonly string[],
  ): Promise<readonly CampaignRecord[]>;

  /**
   * Define the next policy version (owner-only; campaign non-terminal).
   * Validates every section against the frozen vocabularies
   * (objectives, eligibility, outcome/evidence references, budget
   * arithmetic, attribution/confidence constraints, clearing caps and
   * reward-policy resolution, opportunity specs), enforces version =
   * latest+1 under the org-independent lineage mutex and commits
   * atomically with the `campaign.policy_defined` audit event.
   */
  defineCampaignPolicy(
    execution: ExecutionContext,
    input: DefineCampaignPolicyInput,
  ): Promise<DefineCampaignPolicyResult>;
  getPolicyVersion(
    execution: ExecutionContext,
    campaignId: string,
    version: number,
  ): Promise<CampaignPolicy>;
  listPolicyVersions(
    execution: ExecutionContext,
    campaignId: string,
  ): Promise<readonly CampaignPolicy[]>;

  /**
   * Activate (DRAFT → ACTIVE; owner-only). The CAMP-002 gate: a
   * policy version must exist with ≥1 opportunity spec, and when the
   * current policy declares a positive budget, the settlement escrow
   * must ALREADY be committed and recorded (economic commitments use
   * the canonical settlement authority — no activation on credit).
   */
  activateCampaign(
    execution: ExecutionContext,
    input: CampaignStatusInput,
  ): Promise<CampaignRecord>;
  /** Pause (ACTIVE → PAUSED; owner-only). */
  pauseCampaign(
    execution: ExecutionContext,
    input: CampaignStatusInput,
  ): Promise<CampaignRecord>;
  /** Resume (PAUSED → ACTIVE; owner-only; re-runs the activation gate). */
  resumeCampaign(
    execution: ExecutionContext,
    input: CampaignStatusInput,
  ): Promise<CampaignRecord>;
  /** Complete (ACTIVE/PAUSED → COMPLETED terminal; owner-only). */
  completeCampaign(
    execution: ExecutionContext,
    input: CampaignStatusInput,
  ): Promise<CampaignRecord>;
  /** Cancel (DRAFT/ACTIVE/PAUSED → CANCELLED terminal; owner-only). */
  cancelCampaign(
    execution: ExecutionContext,
    input: CampaignStatusInput,
  ): Promise<CampaignRecord>;

  /**
   * RECORD the budget commitment the settlement authority executed
   * (owner-only; non-terminal; single commitment per campaign — the
   * settlement one-COMMITTED-stake-per-purpose rule made explicit).
   * Commits atomically with the `campaign.budget_committed` audit
   * event.
   */
  recordBudgetCommitment(
    execution: ExecutionContext,
    input: RecordBudgetCommitmentInput,
  ): Promise<CampaignRecord>;
  /**
   * RECORD the budget release the settlement authority executed
   * (owner-only; terminal campaign; verifies the stake is RELEASED).
   * Commits atomically with the `campaign.budget_released` audit event.
   */
  recordBudgetRelease(
    execution: ExecutionContext,
    input: RecordBudgetReleaseInput,
  ): Promise<CampaignRecord>;

  /**
   * Resolve a publish draft for a spec of the CURRENT policy version
   * (read-only; campaign must be publishable — ACTIVE). The
   * composition root materializes the draft through the opportunity
   * service, then records the publication.
   */
  resolveOpportunityDraft(
    execution: ExecutionContext,
    campaignId: string,
    specId: string,
  ): Promise<CampaignOpportunityDraft>;
  /**
   * RECORD the published opportunity (owner-only; ACTIVE; spec exists
   * in the referenced version; the opportunity resolves same-scope
   * with the EXACT eligibility reference). Commits atomically with
   * the `campaign.opportunity_published` audit event.
   */
  recordOpportunityPublication(
    execution: ExecutionContext,
    input: RecordOpportunityPublicationInput,
  ): Promise<CampaignRecord>;
  /**
   * The published opportunities derived from the append-only event
   * history (read-only; ordered by publication).
   */
  listPublishedOpportunities(
    execution: ExecutionContext,
    campaignId: string,
  ): Promise<readonly {
    readonly opportunityId: string;
    readonly specId: string;
    readonly policyVersion: number;
    readonly publishedAt: string;
  }[]>;
}

// ---------------------------------------------------------------------------
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The CampaignsPort describes the boundary's readiness. After NET-W011
 * it carries the campaign domain: first-class campaign records with
 * the administrative status machine, versioned campaign policy
 * (objectives, eligibility, outcome/evidence policy, budget,
 * attribution rules, clearing rules, opportunity specs), budget
 * commitment references through the settlement escrow, and
 * campaign-to-opportunity composition references.
 */
export interface CampaignsPort {
  readonly boundary: "campaigns";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly campaignCreated: "campaign.created";
    readonly campaignPolicyDefined: "campaign.policy_defined";
    readonly campaignActivated: "campaign.activated";
    readonly campaignPaused: "campaign.paused";
    readonly campaignResumed: "campaign.resumed";
    readonly campaignCompleted: "campaign.completed";
    readonly campaignCancelled: "campaign.cancelled";
    readonly campaignBudgetCommitted: "campaign.budget_committed";
    readonly campaignBudgetReleased: "campaign.budget_released";
    readonly campaignOpportunityPublished: "campaign.opportunity_published";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  IdempotencyStore,
  CampaignClearingBasis,
  CampaignClearingDrawKind,
  CampaignEligibilityAttribute,
  CampaignEligibilityOperator,
  CampaignEvidenceRequirementKind,
  CampaignObjectiveKind,
  CampaignStatus,
  AttributionMode,
  OutcomeType,
};
