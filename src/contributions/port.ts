/**
 * Contributions boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §17 (canonical lifecycle),
 * §18 (Module ownership): `/contributions` owns the Contribution entity.
 * Lifecycle mutation authority is delegated to `/workflows` (work order
 * §4.1).
 * Architecture ref: spec/architecture-lock.md §2 (core domain
 * `/contributions`).
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.2 Contribution: stable identifier; opportunity reference;
 *      contributor reference; submission payload/reference appropriate
 *      to the contribution type; lifecycle state; timestamps; revision/
 *      version; evidence-reference placeholders only (no Proof-of-Value
 *      evaluation in this work item); execution/correlation lineage.
 *   §4 Required invariants:
 *      2. Domain/application services may validate business preconditions
 *         but may not bypass workflow authority.
 *      7. Every material mutation preserves execution/correlation/causation
 *         lineage and append-oriented audit evidence.
 *
 * CROSS-BOUNDARY NOTE: the contributions domain is `domain` tier. The
 * tier allow matrix prohibits domain→infrastructure and domain→other-
 * domain imports. The ContributionRepository therefore consumes the
 * provider-neutral {@link PostgresAuthority} contract from
 * `src/core/postgres-authority.ts` (core→core is allowed). The
 * OpportunityLookup structural interface is mirrored here so the
 * ContributionService can verify the opportunity exists without
 * importing the opportunities domain — the bootstrap composition root
 * wires a thin adapter that delegates to the real OpportunityRepository.
 *
 * The ContributionRepository extends the {@link LifecycleRepository}
 * structural interface from `/workflows` so the workflow service can
 * mutate lifecycle state uniformly.
 *
 * Out of scope (work order §5): no evidence evaluation or Proof-of-
 * Value, no outcome/measurement, no reputation, no settlement. Evidence
 * references are placeholders only.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  LifecycleState,
  LifecycleSubject,
} from "../core/workflow.ts";

/**
 * The kind of contribution. Provider-neutral — the string discriminator
 * is opaque; downstream work items (helpful contributions, UGC, etc.)
 * attach concrete semantics. NET-W004 does not interpret the kind.
 */
export type ContributionType = string;

/**
 * A submission payload/reference appropriate to the contribution type
 * (work order §3.2). Provider-neutral — opaque shape so different
 * contribution types can carry different submission structures without
 * changing the workflow model. NET-W004 does not interpret the payload.
 */
export type ContributionSubmission = Readonly<Record<string, unknown>>;

/**
 * A Contribution — a first-class protocol object linked to exactly one
 * Opportunity and one contributor (work order §3.2).
 *
 * Invariants:
 *  - `id` is stable and opaque.
 *  - `opportunityId` references exactly one Opportunity. The
 *    Contribution belongs to exactly one Opportunity (AC-02).
 *  - `contributorId` is the canonical identity id of the contributor.
 *    The Contribution belongs to exactly one contributor (AC-02).
 *  - `organizationScopeId` is the tenant/participant scope inherited
 *    from the opportunity; transitions are scoped to this org.
 *  - `state` is the lifecycle state (canonical or exceptional).
 *  - `version` is monotonic; the workflow service uses optimistic
 *    concurrency (work order §4.8).
 *  - `contributionType` is opaque; extensible.
 *  - `submission` is the structured payload (provider-neutral shape).
 *  - `evidenceReferencePlaceholders` are neutral IDs only; no
 *    Proof-of-Value evaluation (work order §5).
 *  - `executionId` / `correlationId` / `causationId` are stable lineage
 *    identifiers (work order §4.7).
 *  - `createdAt` / `updatedAt` are ISO-8601 timestamps.
 */
export interface Contribution extends LifecycleSubject {
  /** The opportunity this contribution belongs to (AC-02 invariant). */
  readonly opportunityId: string;
  /** The contributor this contribution belongs to (AC-02 invariant). */
  readonly contributorId: string;
  /** The contribution type (opaque; extensible). */
  readonly contributionType: ContributionType;
  /** Structured submission payload/reference (provider-neutral). */
  readonly submission: ContributionSubmission;
  /** Neutral IDs only; no Proof-of-Value evaluation in this work item. */
  readonly evidenceReferencePlaceholders: readonly string[];
}

/**
 * Inputs to create a contribution. The contribution is created in
 * `DRAFT` state with version 0; transitions out of DRAFT go through
 * the workflow service.
 */
export interface CreateContributionInput {
  readonly opportunityId: string;
  readonly contributorId: string;
  readonly organizationScopeId: string;
  readonly contributionType: ContributionType;
  readonly submission?: ContributionSubmission;
  readonly evidenceReferencePlaceholders?: readonly string[];
}

/**
 * ContributionRepository — persistence port for contributions.
 *
 * The repository is the authoritative application state boundary for
 * Contribution entities (work order §4.6). All material mutations
 * persist through the {@link PostgresAuthority} boundary.
 *
 * The repository exposes BOTH:
 *  - domain-specific operations (save, findById, listByOpportunity,
 *    listByContributor); AND
 *  - the {@link LifecycleRepository} structural interface
 *    (getByIdWithinTx, saveWithinTx) consumed by the WorkflowService.
 */
export interface ContributionRepository {
  save(contribution: Contribution, execution: ExecutionContext): Promise<Contribution>;
  findById(id: string): Promise<Contribution | null>;
  listByOpportunity(opportunityId: string): Promise<readonly Contribution[]>;
  listByContributor(contributorId: string): Promise<readonly Contribution[]>;
  exists(id: string): Promise<boolean>;

  /**
   * LifecycleRepository structural surface (consumed by the
   * WorkflowService).
   */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<Contribution | null>;
  saveWithinTx(
    subject: Contribution,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<Contribution>;
}

/**
 * OpportunityLookup — structural surface the ContributionService
 * consumes to verify the opportunity exists and resolve its
 * organization scope. Mirrored from `/opportunities`. The bootstrap
 * wires the concrete OpportunityRepository to satisfy this.
 */
export interface OpportunityLookup {
  /** Returns the opportunity's organization scope id, or null if absent. */
  getOrganizationScope(opportunityId: string): Promise<string | null>;
  /** Returns true iff the opportunity exists. */
  exists(opportunityId: string): Promise<boolean>;
}

/**
 * ContributionService — domain service for contributions (work order §3.2).
 *
 * Owns:
 *  - createContribution → persists a new contribution in DRAFT state
 *    linked to exactly one opportunity + one contributor. Validates
 *    the opportunity exists + the contributor's organization scope
 *    matches the opportunity's scope (AC-02 invariant).
 *  - getContribution → reads by id.
 *
 * Does NOT mutate lifecycle state — that goes through the WorkflowService
 * (work order §4.1, §4.2).
 */
export interface ContributionService {
  createContribution(
    execution: ExecutionContext,
    input: CreateContributionInput,
  ): Promise<Contribution>;
  getContribution(
    execution: ExecutionContext,
    id: string,
  ): Promise<Contribution>;
}

/**
 * The ContributionsPort describes the boundary's readiness. After
 * NET-W004 it is `"ready"`; after NET-W012 it additionally carries the
 * helpful-contribution event vocabulary.
 */
export interface ContributionsPort {
  readonly boundary: "contributions";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly created: "contribution.created";
    readonly helpfulContributionCreated: "helpful_contribution.created";
    readonly helpfulRecommendationPrepared: "helpful_recommendation.prepared";
    readonly helpfulContributionPublished: "helpful_contribution.published";
    readonly helpfulDisclosureDeclared: "helpful_disclosure.declared";
    readonly helpfulDisclosureRetracted: "helpful_disclosure.retracted";
    readonly helpfulnessPolicyDefined: "helpfulness_policy.defined";
    readonly helpfulnessBasisAttached: "helpfulness_basis.attached";
    readonly helpfulnessAdvisoryRecorded: "helpfulness_advisory.recorded";
    readonly proofOfHelpfulnessEvaluated: "proof_of_helpfulness.evaluated";
  };
}

// ---------------------------------------------------------------------------
// NET-W012 — Helpful contributions (work order spec/work-orders/
// NET-W012.md). Helpful semantics attach to the W004 opaque
// ContributionType/ContributionSubmission extension points IN this
// domain; no new LifecycleSubjectKind, no 17th domain.
// ---------------------------------------------------------------------------

import type {
  DisclosureRelationshipKind,
  DisclosureState,
  HelpfulAdvisoryKind,
  HelpfulClaimantAttributes,
  HelpfulContributionKind,
  HelpfulEligibilityRule,
  HelpfulnessBasisKind,
  ProofOfHelpfulnessStatus,
} from "../core/contributions.ts";
import type {
  ConfidenceEstimate,
  EvidenceGrade,
  EvidenceSourceType,
  OutcomeType,
} from "../core/evidence.ts";
import type {
  IdempotencyStore,
  TransactionalAuditWriter,
} from "../core/index.ts";

/**
 * One recorded product mention (HELP-001: mention ≠ helpfulness).
 * Mentions are RECORDED METADATA for disclosure compliance — the
 * Proof-of-Helpfulness engine has NO code path through which a
 * mention contributes to qualification.
 */
export interface HelpfulMention {
  /** Neutral product/party reference (opaque string). */
  readonly productRef: string;
  /** Whether the submission text itself carries the disclosure. */
  readonly disclosed: boolean;
  /**
   * Stable client-chosen commercial-relationship key. Compliance: a
   * mention with a non-null key requires a DECLARED disclosure on the
   * same contribution whose `relationshipRef` equals this key.
   */
  readonly commercialRelationshipRef: string | null;
}

/**
 * The structured helpful submission payload (the W004 opaque
 * `ContributionSubmission` made concrete for helpful contributions).
 */
export interface HelpfulSubmission {
  readonly claimantAttributes: HelpfulClaimantAttributes;
  readonly mentions: readonly HelpfulMention[];
  /** Off-record content reference (the drafted contribution text). */
  readonly contentRef: string | null;
  /** Neutral publication channel descriptor (opaque). */
  readonly channel: string | null;
}

/** The resolved + evaluated NET-W011 eligibility reference (or null). */
export interface HelpfulnessEligibilityResolution {
  readonly eligibilityPolicyReference: string;
  readonly campaignId: string;
  readonly policyVersion: number;
  readonly specId: string;
  readonly campaignStatus: string;
  readonly evaluatedAt: string;
  readonly eligible: boolean;
  readonly failures: readonly string[];
}

/** One advisory score (AI is advisory — never qualifying). */
export interface HelpfulAdvisoryScore {
  readonly id: string;
  readonly kind: HelpfulAdvisoryKind;
  /** REQUIRED method identity (the frozen measurement rule). */
  readonly methodRef: string;
  readonly methodVersion: string;
  /** Normalized score in [0, 1]. */
  readonly score: number;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

/** One qualifying-basis reference (re-resolved at evaluation time). */
export interface HelpfulnessBasis {
  readonly id: string;
  readonly kind: HelpfulnessBasisKind;
  /** The authority record id (PoV id / measured-outcome id / evidence id). */
  readonly referenceId: string;
  readonly attachedAt: string;
  readonly attachedBy: string;
}

/** One append-only evaluation event (the deterministic decision record). */
export interface HelpfulnessEvaluation {
  readonly evaluatedAt: string;
  readonly outcome: ProofOfHelpfulnessStatus;
  readonly reasons: readonly string[];
  readonly qualifyingBasisCount: number;
  readonly independentSourceCount: number;
  readonly advisoryCount: number;
  readonly evaluator: "deterministic_policy_v1";
}

/** One protocol-prepared recommendation (never publishes). */
export interface HelpfulRecommendation {
  readonly preparedContentRef: string;
  readonly rationale: string | null;
  readonly preparedAt: string;
  readonly preparedBy: string;
}

/**
 * A ProofOfHelpfulness — the NET-W012 domain aggregate (created 1:1
 * with a helpful contribution in one atomic transaction). The
 * CONTRIBUTION remains the workflow-lifecycle subject; this record is
 * DOMAIN-OWNED bookkeeping with its own administrative state machine
 * (the NET-W010 dispute-record / NET-W011 campaign-record precedent).
 */
export interface ProofOfHelpfulness {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly contributorId: string;
  /** The pinned helpfulness policy that governs evaluation. */
  readonly helpfulnessPolicyId: string;
  readonly helpfulnessPolicyVersion: number;
  readonly formatVersion: string;
  readonly eligibility: HelpfulnessEligibilityResolution | null;
  readonly mentions: readonly HelpfulMention[];
  readonly disclosureIds: readonly string[];
  readonly advisoryScores: readonly HelpfulAdvisoryScore[];
  readonly bases: readonly HelpfulnessBasis[];
  readonly evaluations: readonly HelpfulnessEvaluation[];
  readonly recommendations: readonly HelpfulRecommendation[];
  readonly publication: {
    readonly publishedAt: string;
    readonly publishedBy: string;
    readonly workflowState: string;
  } | null;
  readonly state: ProofOfHelpfulnessStatus;
  readonly events: readonly string[];
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A commercial disclosure — first-class, auditable (HELP-005). */
export interface CommercialDisclosureRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly contributorId: string;
  readonly relationshipKind: DisclosureRelationshipKind;
  /** The stable commercial-relationship key mentions reference. */
  readonly relationshipRef: string;
  readonly productRef: string | null;
  readonly counterpartyRef: string;
  readonly description: string | null;
  readonly state: DisclosureState;
  readonly events: readonly string[];
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The helpfulness policy sections (all required — deterministic). */
export interface HelpfulnessPolicySections {
  readonly qualifyingBasisKinds: readonly HelpfulnessBasisKind[];
  readonly minimumGrade: EvidenceGrade;
  readonly qualifyingSourceTypes: readonly EvidenceSourceType[];
  readonly qualifyingOutcomeTypes: readonly OutcomeType[];
  readonly minimumConfidence: number;
  readonly minimumIndependentSources: number;
  readonly minimumQualifyingBases: number;
  readonly advisory: {
    readonly allowedKinds: readonly HelpfulAdvisoryKind[];
    readonly maxAdvisoryWeight: number;
  };
  readonly requiresDisclosure: boolean;
  readonly description: string;
}

/**
 * A HelpfulnessPolicy — an immutable, versioned record of the
 * deterministic helpfulness criteria (org-scoped lineage, the
 * NET-W007/008/010/011 pattern: version = latest+1, (policyId,
 * version) tuple idempotency, monotonic, cross-scope fork rejection
 * including v1, serialized under the ORGANIZATION-INDEPENDENT mutex
 * `helpfulness_policy_lineage:{policyId}`).
 */
export interface HelpfulnessPolicy {
  readonly id: string;
  readonly policyId: string;
  readonly organizationScopeId: string;
  readonly version: number;
  readonly formatVersion: string;
  readonly sections: HelpfulnessPolicySections;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Neutral cross-domain lookups (composition-root wired; READ-ONLY)
// ---------------------------------------------------------------------------

/** Resolved NET-W011 campaign eligibility policy (over /campaigns). */
export interface HelpfulnessResolvedEligibilityPolicy {
  readonly organizationScopeId: string;
  readonly campaignId: string;
  readonly policyVersion: number;
  readonly specId: string;
  readonly campaignStatus: string;
  readonly rules: readonly HelpfulEligibilityRule[];
}

export interface HelpfulnessCampaignLookup {
  resolveEligibilityPolicy(
    reference: string,
  ): Promise<HelpfulnessResolvedEligibilityPolicy | null>;
}

/** Resolved opportunity (over /opportunities). */
export interface HelpfulnessResolvedOpportunity {
  readonly organizationScopeId: string;
  readonly opportunityType: string;
  readonly eligibilityPolicyReference: string | null;
}

export interface HelpfulnessOpportunityLookup {
  resolveOpportunity(
    id: string,
  ): Promise<HelpfulnessResolvedOpportunity | null>;
}

/** Resolved evidence record (over /evidence). */
export interface HelpfulnessResolvedEvidence {
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly sourceType: EvidenceSourceType;
  readonly grade: EvidenceGrade;
  readonly confidence: ConfidenceEstimate;
  readonly provenanceSourceId: string | null;
}

export interface HelpfulnessEvidenceLookup {
  resolveEvidence(id: string): Promise<HelpfulnessResolvedEvidence | null>;
}

/** Resolved measured outcome (over /outcomes). */
export interface HelpfulnessResolvedMeasurement {
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly outcomeType: OutcomeType;
  readonly state: string;
  readonly rollupConfidence: ConfidenceEstimate | null;
}

export interface HelpfulnessMeasurementLookup {
  resolveMeasuredOutcome(
    id: string,
  ): Promise<HelpfulnessResolvedMeasurement | null>;
}

/** Resolved proof-of-value (over /evidence). */
export interface HelpfulnessResolvedProofOfValue {
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly state: string;
}

export interface HelpfulnessProofOfValueLookup {
  resolveProofOfValue(
    id: string,
  ): Promise<HelpfulnessResolvedProofOfValue | null>;
}

export interface HelpfulnessLookups {
  readonly campaign: HelpfulnessCampaignLookup;
  readonly opportunity: HelpfulnessOpportunityLookup;
  readonly evidence: HelpfulnessEvidenceLookup;
  readonly measurement: HelpfulnessMeasurementLookup;
  readonly proofOfValue: HelpfulnessProofOfValueLookup;
}

// ---------------------------------------------------------------------------
// Inputs / results
// ---------------------------------------------------------------------------

export interface DefineHelpfulnessPolicyInput {
  readonly organizationScopeId: string;
  readonly policyId: string;
  readonly sections: HelpfulnessPolicySections;
  readonly idempotencyKey: string;
}

export interface DefineHelpfulnessPolicyResult {
  readonly policy: HelpfulnessPolicy;
  /** false when this idempotency key already defined a version. */
  readonly created: boolean;
}

export interface CreateHelpfulContributionInput {
  readonly opportunityId: string;
  readonly contributorId: string;
  readonly organizationScopeId: string;
  readonly contributionType: HelpfulContributionKind;
  readonly submission: HelpfulSubmission;
  readonly helpfulnessPolicyId: string;
  readonly idempotencyKey: string;
}

export interface CreateHelpfulContributionResult {
  readonly contribution: Contribution;
  readonly proofOfHelpfulness: ProofOfHelpfulness;
  /** false when a replay (both records already existed). */
  readonly created: boolean;
}

export interface PrepareRecommendationInput {
  readonly contributionId: string;
  readonly preparedContentRef: string;
  readonly rationale?: string;
  readonly idempotencyKey: string;
}

export interface DeclareDisclosureInput {
  readonly contributionId: string;
  readonly contributorPersonId: string;
  readonly relationshipKind: DisclosureRelationshipKind;
  /** The stable commercial-relationship key mentions reference. */
  readonly relationshipRef: string;
  readonly productRef?: string;
  readonly counterpartyRef: string;
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface RetractDisclosureInput {
  readonly disclosureId: string;
  readonly idempotencyKey: string;
}

export interface AttachAdvisoryScoreInput {
  readonly contributionId: string;
  readonly kind: HelpfulAdvisoryKind;
  readonly methodRef: string;
  readonly methodVersion: string;
  readonly score: number;
  readonly idempotencyKey: string;
}

export interface AttachBasisInput {
  readonly contributionId: string;
  readonly kind: HelpfulnessBasisKind;
  readonly referenceId: string;
  readonly idempotencyKey: string;
}

export interface EvaluateHelpfulnessInput {
  readonly contributionId: string;
  readonly idempotencyKey: string;
}

export interface RecordPublicationInput {
  readonly contributionId: string;
  readonly workflowState: string;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Repositories (authority-backed; WithinTx twins for atomic mutation)
// ---------------------------------------------------------------------------

export interface HelpfulnessPolicyRepository {
  findById(id: string): Promise<HelpfulnessPolicy | null>;
  findVersion(
    policyId: string,
    version: number,
  ): Promise<HelpfulnessPolicy | null>;
  listByPolicyId(policyId: string): Promise<readonly HelpfulnessPolicy[]>;
  findVersionWithinTx(
    policyId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<HelpfulnessPolicy | null>;
  findLatestWithinTx(
    policyId: string,
    tx: AuthorityTransaction,
  ): Promise<HelpfulnessPolicy | null>;
  createWithinTx(
    policy: HelpfulnessPolicy,
    tx: AuthorityTransaction,
  ): Promise<HelpfulnessPolicy>;
}

export interface ProofOfHelpfulnessRepository {
  findById(id: string): Promise<ProofOfHelpfulness | null>;
  findByContributionId(
    contributionId: string,
  ): Promise<ProofOfHelpfulness | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProofOfHelpfulness | null>;
  createWithinTx(
    record: ProofOfHelpfulness,
    tx: AuthorityTransaction,
  ): Promise<ProofOfHelpfulness>;
  saveWithinTx(
    record: ProofOfHelpfulness,
    tx: AuthorityTransaction,
  ): Promise<ProofOfHelpfulness>;
}

export interface CommercialDisclosureRepository {
  findById(id: string): Promise<CommercialDisclosureRecord | null>;
  listByContribution(
    contributionId: string,
  ): Promise<readonly CommercialDisclosureRecord[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<CommercialDisclosureRecord | null>;
  /**
   * The transaction-boundary twin of listByContribution: re-resolves
   * the contribution's disclosure records INSIDE the authoritative
   * transaction (the publication TOCTOU closure — retraction state is
   * read as-of the mutation, never from a pre-flight snapshot).
   */
  listByContributionWithinTx(
    contributionId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly CommercialDisclosureRecord[]>;
  createWithinTx(
    record: CommercialDisclosureRecord,
    tx: AuthorityTransaction,
  ): Promise<CommercialDisclosureRecord>;
  saveWithinTx(
    record: CommercialDisclosureRecord,
    tx: AuthorityTransaction,
  ): Promise<CommercialDisclosureRecord>;
}

// ---------------------------------------------------------------------------
// The domain service
// ---------------------------------------------------------------------------

/**
 * HelpfulnessService — the NET-W012 domain service. Never mutates
 * lifecycle state (publication transitions go through `/workflows` at
 * the composition root); every cross-boundary read goes through the
 * neutral read-only lookups; every mutation is exactly-once via the
 * NET-W004 IdempotencyStore primitive with transactional audit
 * lineage.
 */
export interface HelpfulnessService {
  /** Define the next policy version (person actor; lineage mutex). */
  defineHelpfulnessPolicy(
    execution: ExecutionContext,
    input: DefineHelpfulnessPolicyInput,
  ): Promise<DefineHelpfulnessPolicyResult>;
  getPolicyVersion(
    execution: ExecutionContext,
    policyId: string,
    version: number,
  ): Promise<HelpfulnessPolicy>;
  listPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
  ): Promise<readonly HelpfulnessPolicy[]>;

  /**
   * Create a helpful contribution + its Proof-of-Helpfulness record
   * atomically (person actor = contributor; eligibility enforced
   * fail-closed when the opportunity carries a campaign reference).
   */
  createHelpfulContribution(
    execution: ExecutionContext,
    input: CreateHelpfulContributionInput,
  ): Promise<CreateHelpfulContributionResult>;
  getHelpfulContribution(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<{ contribution: Contribution; proofOfHelpfulness: ProofOfHelpfulness }>;
  getProofOfHelpfulness(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<ProofOfHelpfulness>;

  /** Record a protocol-prepared recommendation (DRAFT only; NEVER publishes). */
  prepareRecommendation(
    execution: ExecutionContext,
    input: PrepareRecommendationInput,
  ): Promise<ProofOfHelpfulness>;

  /** Declare a commercial disclosure (person actor = contributor). */
  declareDisclosure(
    execution: ExecutionContext,
    input: DeclareDisclosureInput,
  ): Promise<CommercialDisclosureRecord>;
  /** Retract a disclosure (terminal, append-only). */
  retractDisclosure(
    execution: ExecutionContext,
    input: RetractDisclosureInput,
  ): Promise<CommercialDisclosureRecord>;
  listDisclosures(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<readonly CommercialDisclosureRecord[]>;

  /** Attach an advisory score (validation only; never qualifying). */
  attachAdvisoryScore(
    execution: ExecutionContext,
    input: AttachAdvisoryScoreInput,
  ): Promise<ProofOfHelpfulness>;

  /** Attach a qualifying-basis reference (lookup-verified at attach). */
  attachBasis(
    execution: ExecutionContext,
    input: AttachBasisInput,
  ): Promise<ProofOfHelpfulness>;

  /**
   * Evaluate the Proof-of-Helpfulness deterministically (re-resolves
   * every basis through the truth authorities; PURE engine; gates:
   * published contribution, disclosure compliance, non-terminal state).
   */
  evaluateHelpfulness(
    execution: ExecutionContext,
    input: EvaluateHelpfulnessInput,
  ): Promise<ProofOfHelpfulness>;

  /**
   * The user-controlled publication gate (person actor == contributor,
   * disclosure compliance) — called by the composition root BEFORE the
   * workflow transitions. Throws when publication is not allowed.
   */
  assertPublishable(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<void>;
  /**
   * Record the publication the WORKFLOW authority executed (append-only
   * bookkeeping on the Proof-of-Helpfulness record).
   */
  recordPublication(
    execution: ExecutionContext,
    input: RecordPublicationInput,
  ): Promise<ProofOfHelpfulness>;
}

export type {
  ExecutionContext,
  LifecycleState,
  LifecycleSubject,
  AuthorityTransaction,
  IdempotencyStore,
  TransactionalAuditWriter,
};
