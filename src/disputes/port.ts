/**
 * Disputes boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §12 (Fraud architecture:
 * multi-signal detection, no single authoritative signal), §17
 * (authoritative workflow — FRAUD_REVIEW is a workflow exceptional
 * state owned by /workflows, NOT by this boundary), §18 (module
 * ownership), §19 (AI/model output is never sufficient by itself to
 * authorize settlement/reputation/governance state);
 * spec/architecture-lock.md §2 (the sixteen frozen core domains),
 * §5 (model output is input, never authoritative), §13 invariant 21
 * (a disputed or fraud-held claim cannot mature until the applicable
 * resolution policy permits it).
 *
 * Work order ref: spec/work-orders/NET-W009.md
 *   §2   Boundary placement: the fraud/risk foundation lives in the
 *        /disputes boundary (the Phase-3 Trust domain). NET-W010 will
 *        extend this boundary with staking, challenges and the
 *        dispute lifecycle.
 *   §3.2 Risk signals (first-class, provenance-backed, append-only).
 *   §3.3 Versioned deterministic risk policies.
 *   §3.4 Deterministic risk engine (src/disputes/risk-engine.ts).
 *   §3.5 Risk assessments (multi-signal, provenance-preserving).
 *   §3.6 Risk cases and reviews (append-only decision history).
 *   §3.7 Control decisions + the composition-root gates.
 *
 * Requirements: FRAUD-001 (multiple fraud signals), FRAUD-002 (Sybil
 * signal families), FRAUD-003 (collusion/cycle detection), AI-003
 * (AI-assisted risk analysis — advisory only), AUD-005
 * (administrative action logging).
 *
 * CROSS-BOUNDARY NOTE: this boundary is `domain` tier. The tier allow
 * matrix prohibits domain→infrastructure, domain→adapter and
 * domain→other-domain imports. This port therefore consumes ONLY core
 * contracts. Upstream record resolution (persons, evidence,
 * Proof-of-Value, measured outcomes, contributions, economic records,
 * reputation snapshots) happens through the NEUTRAL structural lookup
 * interfaces declared here — the bootstrap composition root wires
 * thin adapters over the wired repositories/services of the owning
 * domains (the same dependency-inversion pattern as NET-W005's
 * SubjectLookup, NET-W006's OutcomeClaimLookup and NET-W007's five
 * lookups).
 *
 * THE KEY RULES (work order §4):
 *  - fraud/risk is a decision-support and CONTROL authority: it may
 *    block, hold, route or require review of otherwise authorized
 *    operations, but it can NEVER mint, destroy or transfer money,
 *    Participation Credits or value (invariant 1 — this port carries
 *    no economic-unit fields and no economic mutation methods);
 *  - it never mutates reputation directly (invariant 2 — reputation
 *    snapshots are a read-only upstream source kind here);
 *  - material decisions are evidence-backed (invariant 3 — signals
 *    require ≥1 authoritative source ref; controls require an
 *    assessment and/or case origin);
 *  - it never mutates workflow lifecycle state itself: workflow holds
 *    are requested THROUGH the workflow service at the composition
 *    root (work order §3.7 — /workflows stays the sole lifecycle
 *    authority).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type {
  RiskControlAction,
  RiskOperationClass,
  RiskEvaluationRule,
  RiskSignalCategory,
  RiskSignalProvenanceKind,
  RiskSignalSeverity,
  RiskSignalSourceKind,
  RiskState,
  RiskStateThresholds,
} from "../core/risk.ts";
import type {
  DisputeControlDisposition,
  DisputeKind,
  DisputeOutcome,
  DisputeStakeDisposition,
  DisputeState,
  DisputeSubjectType,
} from "../core/disputes.ts";

// ---------------------------------------------------------------------------
// Risk signals (work order §3.2)
// ---------------------------------------------------------------------------

/**
 * A reference to an authoritative upstream record backing a risk
 * signal's provenance. At least one source is REQUIRED on every signal
 * (invariant 3): a bare assertion — raw activity, spend, wealth, a
 * model claim with no record citation — cannot enter the system.
 */
export interface RiskSignalSourceRef {
  readonly kind: RiskSignalSourceKind;
  readonly id: string;
}

/**
 * The generic subject a risk signal is about: a person, and optionally
 * a specific upstream record (contribution / Proof-of-Value / measured
 * outcome / economic value / credit issuance / cash obligation).
 */
export interface RiskSubjectRef {
  readonly subjectType:
    | "contribution"
    | "proof_of_value"
    | "measured_outcome"
    | "economic_value"
    | "credit_issuance"
    | "cash_obligation";
  readonly subjectId: string;
}

/**
 * A RiskSignal — an immutable, append-only risk observation (work
 * order §3.2).
 *
 * Invariants:
 *  - `provenance.sources` is non-empty; every source resolves through
 *    the injected neutral lookups and belongs to the signal's
 *    organization scope (tenant isolation, invariant 6).
 *  - `advisory` is DERIVED from the provenance kind (model_output ⇒
 *    always advisory — never caller-asserted, invariant 5).
 *  - corrections are append-only (work item: "corrections create new
 *    signals referencing superseded records"): the CORRECTION carries
 *    `supersedesSignalId` → the original; the original's
 *    `supersededBySignalId` back-pointer flips in the SAME atomic
 *    transaction (a state flip, never a content rewrite — the original
 *    finding's category/severity/provenance/history stay byte-identical).
 *  - lineage identifiers trace the record to its creating execution.
 */
export interface RiskSignal {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The participant the signal is about (always a person subject). */
  readonly subjectPersonId: string;
  /** Optional specific upstream record the signal is about. */
  readonly subjectRef: RiskSubjectRef | null;
  readonly category: RiskSignalCategory;
  readonly severity: RiskSignalSeverity;
  /** Confidence point estimate in [0, 1]. */
  readonly confidence: number;
  readonly provenance: {
    readonly kind: RiskSignalProvenanceKind;
    /** e.g. "velocity-window-v1", "ensemble-fraud-v4", "manual-review". */
    readonly detectionMethod: string;
    readonly detectionVersion: string;
    readonly sources: readonly RiskSignalSourceRef[];
  };
  /** Derived: true iff provenance kind is structurally advisory. */
  readonly advisory: boolean;
  /** Human-readable, non-sensitive description of the finding. */
  readonly description: string | null;
  /** When the underlying detection observed the behaviour. */
  readonly detectedAt: string;
  readonly recordedAt: string;
  /** Set on CORRECTIONS: the signal this one replaces. */
  readonly supersedesSignalId: string | null;
  /** Flipped atomically when a correction replaces this signal. */
  readonly supersededBySignalId: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface CreateRiskSignalInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly subjectRef?: RiskSubjectRef;
  readonly category: string;
  readonly severity: string;
  readonly confidence: number;
  readonly provenance: {
    readonly kind: string;
    readonly detectionMethod: string;
    readonly detectionVersion: string;
    readonly sources: readonly {
      readonly kind: string;
      readonly id: string;
    }[];
  };
  readonly description?: string;
  readonly detectedAt: string;
  readonly idempotencyKey: string;
}

export interface CreateRiskSignalResult {
  readonly signal: RiskSignal;
  /** false when a signal with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface SupersedeRiskSignalInput {
  /** The signal being corrected (must exist, same org, not superseded). */
  readonly signalId: string;
  /**
   * The correcting signal's fields (category/severity/confidence/
   * provenance/description/detectedAt) — a full replacement record.
   * The correction inherits the original's subject person/ref.
   */
  readonly category: string;
  readonly severity: string;
  readonly confidence: number;
  readonly provenance: CreateRiskSignalInput["provenance"];
  readonly description?: string;
  readonly detectedAt: string;
  readonly idempotencyKey: string;
}

export interface SupersedeRiskSignalResult {
  /** The original signal with its back-pointer flipped to the correction. */
  readonly original: RiskSignal;
  /** The appended correcting signal. */
  readonly correction: RiskSignal;
  /** false when the correction idempotency key already existed. */
  readonly created: boolean;
}

export interface RiskSignalService {
  /**
   * Record a signal (immutable, append-only). Validates the subject
   * person, category/severity vocabulary, confidence, ≥1 authoritative
   * source ref (neutral-lookup resolution + org-scope enforcement),
   * DERIVES the advisory flag from the provenance kind, dedupes by
   * idempotency key, and commits atomically with the
   * `risk_signal.recorded` audit event.
   */
  createSignal(
    execution: ExecutionContext,
    input: CreateRiskSignalInput,
  ): Promise<CreateRiskSignalResult>;
  /**
   * Append a correcting signal superseding an existing one (the
   * correction references the original; the original's back-pointer
   * flips in the same transaction). Commits atomically with the
   * `risk_signal.superseded` audit event.
   */
  supersedeSignal(
    execution: ExecutionContext,
    input: SupersedeRiskSignalInput,
  ): Promise<SupersedeRiskSignalResult>;
  getSignal(execution: ExecutionContext, id: string): Promise<RiskSignal>;
  /** List signals (a subject's, or the whole org's). */
  listSignals(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId?: string,
  ): Promise<readonly RiskSignal[]>;
}

export interface RiskSignalRepository {
  save(signal: RiskSignal, execution: ExecutionContext): Promise<RiskSignal>;
  findById(id: string): Promise<RiskSignal | null>;
  /** Signals for a person in an org (non-superseded + superseded). */
  listBySubject(
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly RiskSignal[]>;
  listByOrganization(organizationScopeId: string): Promise<readonly RiskSignal[]>;
  /** Transaction-scoped variants. */
  findByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<RiskSignal | null>;
  listBySubjectWithinTx(
    organizationScopeId: string,
    subjectPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly RiskSignal[]>;
  /** Persist the original-with-backpointer AND the correction atomically. */
  putSupersessionWithinTx(
    original: RiskSignal,
    correction: RiskSignal,
    tx: AuthorityTransaction,
  ): Promise<void>;
  createWithinTx(signal: RiskSignal, tx: AuthorityTransaction): Promise<RiskSignal>;
}

// ---------------------------------------------------------------------------
// Neutral upstream lookups (composition-root wired)
// ---------------------------------------------------------------------------

/** Structural view of a resolved lifecycle upstream record. */
export interface RiskResolvedLifecycleSource {
  readonly organizationScopeId: string;
  readonly state: string;
}

/** Structural view of a resolved evidence record. */
export interface RiskResolvedEvidenceSource {
  readonly organizationScopeId: string;
  readonly sourceType: string;
}

/** Structural view of a resolved economic value record. */
export interface RiskResolvedEconomicSource {
  readonly organizationScopeId: string;
  readonly state: string;
  readonly beneficiaryPersonId: string;
}

/** Structural view of a resolved reputation snapshot. */
export interface RiskResolvedReputationSource {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly digest: string;
}

/** The risk signal's subject person must exist (over identity). */
export interface RiskSubjectLookup {
  exists(personId: string): Promise<boolean>;
}

/** Over the NET-W005 evidence domain. */
export interface RiskEvidenceLookup {
  resolve(id: string): Promise<RiskResolvedEvidenceSource | null>;
}

/** Over the NET-W005 evidence domain (Proof-of-Value). */
export interface RiskProofOfValueLookup {
  resolve(id: string): Promise<RiskResolvedLifecycleSource | null>;
}

/** Over the NET-W006 outcomes domain. */
export interface RiskMeasuredOutcomeLookup {
  resolve(id: string): Promise<RiskResolvedLifecycleSource | null>;
}

/** Over the NET-W004 contributions domain. */
export interface RiskContributionLookup {
  resolve(id: string): Promise<RiskResolvedLifecycleSource | null>;
}

/** Over the NET-W008 settlement domain (economic value / credits / cash). */
export interface RiskEconomicValueLookup {
  resolveValue(id: string): Promise<RiskResolvedEconomicSource | null>;
  resolveCreditIssuance(id: string): Promise<RiskResolvedEconomicSource | null>;
  resolveCashObligation(id: string): Promise<RiskResolvedEconomicSource | null>;
}

/** Structural view of a resolved risk record (signal / assessment). */
export interface RiskResolvedRiskRecordSource {
  readonly organizationScopeId: string;
}

/** Over this boundary's own records (signals + assessments + cases). */
export interface RiskRecordLookup {
  resolveSignal(id: string): Promise<RiskResolvedRiskRecordSource | null>;
  resolveAssessment(id: string): Promise<RiskResolvedRiskRecordSource | null>;
  /**
   * NET-W010 (additive, non-breaking): a risk CASE is an
   * authoritative prior decision — resolvable as a challenge subject
   * and as a supporting source reference.
   */
  resolveCase(id: string): Promise<RiskResolvedRiskRecordSource | null>;
}

/** Over the NET-W007 reputation domain (read-only — never mutated here). */
export interface RiskReputationSnapshotLookup {
  /** Resolve by subject (the latest snapshot for that person). */
  resolve(
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<RiskResolvedReputationSource | null>;
  /** Resolve by exact snapshot record id (source-ref validation). */
  resolveById(id: string): Promise<RiskResolvedReputationSource | null>;
}

export interface RiskLookups {
  readonly subject: RiskSubjectLookup;
  readonly evidence: RiskEvidenceLookup;
  readonly proofOfValue: RiskProofOfValueLookup;
  readonly measuredOutcome: RiskMeasuredOutcomeLookup;
  readonly contribution: RiskContributionLookup;
  readonly economic: RiskEconomicValueLookup;
  readonly reputation: RiskReputationSnapshotLookup;
  readonly risk: RiskRecordLookup;
}

// ---------------------------------------------------------------------------
// Risk policies (work order §3.3)
// ---------------------------------------------------------------------------

/**
 * A RiskPolicy — an immutable, versioned record of the deterministic
 * evaluation parameters (work order §3.3).
 *
 * Invariants (the NET-W007/NET-W008 policy-lineage pattern):
 *  - `policyId` is stable across versions; `version` increases by
 *    exactly 1 (version 1 starts a new lineage); a (policyId, version)
 *    pair is unique and is the idempotency tuple (replay semantics);
 *  - all versions of a policyId share one organizationScopeId — the
 *    lineage cannot be forked across scopes (checked on EVERY create
 *    including version 1, under the ORGANIZATION-INDEPENDENT lineage
 *    mutex `risk_policy_lineage:{policyId}`);
 *  - the deterministic shape (rules/thresholds/floors/caps/required
 *    categories/missing-data state) is validated by the core
 *    validator; identical shape + signals + evaluatedAt always
 *    reproduce identical assessments (invariant 4).
 */
export interface RiskPolicy {
  /** Record id (unique per version). */
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly description: string | null;
  readonly rules: readonly RiskEvaluationRule[];
  readonly thresholds: RiskStateThresholds;
  readonly criticalFloorState: RiskState;
  readonly advisoryOnlyCapState: RiskState;
  readonly requiredCategories: readonly RiskSignalCategory[];
  readonly missingDataState: RiskState;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface CreateRiskPolicyInput {
  readonly organizationScopeId: string;
  /** The stable lineage id (caller-supplied so retries are idempotent). */
  readonly policyId: string;
  /** Exactly latest+1 for an existing lineage, or 1 to start a new one. */
  readonly version: number;
  readonly description?: string;
  readonly rules: readonly {
    readonly category: string;
    readonly weight: number;
    readonly advisoryWeightFactor: number;
    readonly severityPoints: {
      readonly LOW: number;
      readonly MEDIUM: number;
      readonly HIGH: number;
      readonly CRITICAL: number;
    };
  }[];
  readonly thresholds: {
    readonly watch: number;
    readonly review: number;
    readonly hold: number;
    readonly blocked: number;
  };
  readonly criticalFloorState: string;
  readonly advisoryOnlyCapState: string;
  readonly requiredCategories: readonly string[];
  readonly missingDataState: string;
}

export interface RiskPolicyRepository {
  save(policy: RiskPolicy, execution: ExecutionContext): Promise<RiskPolicy>;
  findById(id: string): Promise<RiskPolicy | null>;
  findVersion(policyId: string, version: number): Promise<RiskPolicy | null>;
  findLatestVersion(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<RiskPolicy | null>;
  listVersions(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly RiskPolicy[]>;
  findVersionWithinTx(
    policyId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<RiskPolicy | null>;
  findLatestVersionWithinTx(
    policyId: string,
    organizationScopeId: string | undefined,
    tx: AuthorityTransaction,
  ): Promise<RiskPolicy | null>;
  createWithinTx(policy: RiskPolicy, tx: AuthorityTransaction): Promise<RiskPolicy>;
}

export interface RiskPolicyService {
  /**
   * Create a policy version (append-only). Validates the deterministic
   * shape (core validator), enforces version monotonicity and the
   * organization-scope lineage invariant under the
   * org-independent lineage mutex, dedupes by the (policyId, version)
   * tuple, and commits atomically with the
   * `risk_policy.version_created` audit event.
   */
  createPolicyVersion(
    execution: ExecutionContext,
    input: CreateRiskPolicyInput,
  ): Promise<RiskPolicy>;
  getPolicy(execution: ExecutionContext, id: string): Promise<RiskPolicy>;
  getPolicyVersion(
    execution: ExecutionContext,
    policyId: string,
    version: number,
  ): Promise<RiskPolicy>;
  listPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly RiskPolicy[]>;
}

// ---------------------------------------------------------------------------
// Risk assessments (work order §3.5)
// ---------------------------------------------------------------------------

/**
 * The per-signal contribution inside an assessment — the multi-signal
 * provenance-preserving record (work item: signals are "not collapsed
 * into an opaque score"). Every contributing signal keeps its
 * category, severity, weight, advisory flag and deterministic points.
 */
export interface RiskSignalContribution {
  readonly signalId: string;
  readonly category: RiskSignalCategory;
  readonly severity: RiskSignalSeverity;
  readonly weight: number;
  readonly advisory: boolean;
  /** Scaled-integer points (RISK_SCORE_DECIMALS). */
  readonly points: number;
}

export interface RiskAssessment {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly subjectRef: RiskSubjectRef | null;
  readonly policyId: string;
  readonly policyVersion: number;
  /** Explicit evaluation timestamp (determinism anchor). */
  readonly evaluatedAt: string;
  readonly recordedAt: string;
  /** The exact signal ids the assessment covered (deterministic order). */
  readonly signalIds: readonly string[];
  readonly contributions: readonly RiskSignalContribution[];
  /** Scaled-integer total score (RISK_SCORE_DECIMALS). */
  readonly score: number;
  readonly state: RiskState;
  /** Categories the policy requires that had NO resolvable signals. */
  readonly missingCategories: readonly RiskSignalCategory[];
  /** SHA-256 digest over the full deterministic evaluation. */
  readonly digest: string;
  /** Set on RE-EVALUATIONS: the previous latest assessment replaced here. */
  readonly supersedesAssessmentId: string | null;
  /** Flipped atomically when a later assessment supersedes this one. */
  readonly supersededByAssessmentId: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordRiskAssessmentInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly subjectRef?: RiskSubjectRef;
  readonly policyId: string;
  /** Omitted → the lineage's latest version. */
  readonly version?: number;
  /** REQUIRED explicit evaluation timestamp (no wall-clock races). */
  readonly evaluatedAt: string;
  readonly idempotencyKey: string;
}

export interface RecordRiskAssessmentResult {
  readonly assessment: RiskAssessment;
  /** false when an assessment with the same idempotency key existed. */
  readonly created: boolean;
}

export interface RiskAssessmentRepository {
  save(
    assessment: RiskAssessment,
    execution: ExecutionContext,
  ): Promise<RiskAssessment>;
  findById(id: string): Promise<RiskAssessment | null>;
  /** Ordered assessment history for a subject (oldest → newest). */
  listBySubject(
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly RiskAssessment[]>;
  findLatestBySubject(
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<RiskAssessment | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<RiskAssessment | null>;
  listBySubjectWithinTx(
    organizationScopeId: string,
    subjectPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly RiskAssessment[]>;
  /** Persist the new assessment AND mark the previous latest superseded. */
  putSupersessionWithinTx(
    previous: RiskAssessment,
    next: RiskAssessment,
    tx: AuthorityTransaction,
  ): Promise<void>;
  createWithinTx(
    assessment: RiskAssessment,
    tx: AuthorityTransaction,
  ): Promise<RiskAssessment>;
}

export interface RiskAssessmentService {
  /**
   * Deterministic preview (pure, read-only): run the exact engine over
   * the committed signal set WITHOUT persisting.
   */
  previewAssessment(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly subjectPersonId: string;
      readonly subjectRef?: RiskSubjectRef;
      readonly policyId: string;
      readonly version?: number;
      readonly evaluatedAt: string;
    },
  ): Promise<Omit<RiskAssessment, "id" | "recordedAt" | "supersedesAssessmentId" | "supersededByAssessmentId" | "idempotencyKey" | "executionId" | "correlationId" | "causationId">>;
  /**
   * Evaluate + persist an assessment (append-only). Loads the signal
   * set INSIDE the authority transaction (transaction-consistent),
   * supersedes the previous latest assessment for the subject, and
   * commits atomically with the `risk_assessment.recorded` audit
   * event.
   */
  recordAssessment(
    execution: ExecutionContext,
    input: RecordRiskAssessmentInput,
  ): Promise<RecordRiskAssessmentResult>;
  getAssessment(execution: ExecutionContext, id: string): Promise<RiskAssessment>;
  getAssessmentHistory(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly RiskAssessment[]>;
  getLatestAssessment(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<RiskAssessment | null>;
}

// ---------------------------------------------------------------------------
// Risk cases and reviews (work order §3.6)
// ---------------------------------------------------------------------------

/**
 * The deterministic case state machine (validated in the case service;
 * the state is DERIVED from the append-only decision history):
 *
 * ```text
 * OPEN ──start_review──→ UNDER_REVIEW ──resolve──→ RESOLVED
 *   └──────────────── resolve (direct clear) ────────↑
 * ```
 */
export const RISK_CASE_STATES = ["OPEN", "UNDER_REVIEW", "RESOLVED"] as const;
export type RiskCaseState = (typeof RISK_CASE_STATES)[number];

export const RISK_CASE_DECISIONS = [
  "open",
  "start_review",
  "escalate",
  "resolve_clear",
  "resolve_uphold",
] as const;
export type RiskCaseDecisionKind = (typeof RISK_CASE_DECISIONS)[number];

/** The resolution outcome (set on RESOLVED). */
export type RiskCaseResolution = "CLEARED" | "UPHELD";

/**
 * One append-only decision in a case's history. Reviewer identity is
 * taken from the EXECUTION ACTOR (server-side; never caller-asserted).
 * Material resolutions require ≥1 supporting reference (invariant 3).
 */
export interface RiskCaseDecision {
  readonly id: string;
  readonly decision: RiskCaseDecisionKind;
  readonly reviewerPersonId: string;
  readonly reasonCodes: readonly string[];
  readonly note: string | null;
  /** ≥1 supporting reference (signal / assessment / upstream record). */
  readonly sourceRefs: readonly RiskSignalSourceRef[];
  readonly recordedAt: string;
  readonly executionId: string;
  readonly correlationId: string;
}

/**
 * A RiskCase — an evidence-backed review process (work order §3.6).
 * The decision history is append-only; the state is derived from the
 * last decision; corrections append new decisions, never rewrite.
 */
export interface RiskCase {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string | null;
  readonly subjectRef: RiskSubjectRef | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: RiskCaseState;
  readonly reasonCodes: readonly string[];
  readonly decisions: readonly RiskCaseDecision[];
  readonly openedBy: string;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: RiskCaseResolution | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface OpenRiskCaseInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId?: string;
  readonly subjectRef?: RiskSubjectRef;
  readonly title: string;
  readonly description?: string;
  readonly reasonCodes: readonly string[];
  /** ≥1 supporting reference required to open a case (invariant 3). */
  readonly sourceRefs: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly idempotencyKey: string;
}

export interface RecordRiskCaseDecisionInput {
  readonly caseId: string;
  readonly decision: string;
  readonly reasonCodes: readonly string[];
  readonly note?: string;
  /**
   * Supporting references — REQUIRED for material resolutions
   * (resolve_clear / resolve_uphold / escalate; invariant 3).
   */
  readonly sourceRefs: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly idempotencyKey: string;
}

export interface RiskCaseRepository {
  save(riskCase: RiskCase, execution: ExecutionContext): Promise<RiskCase>;
  findById(id: string): Promise<RiskCase | null>;
  listByOrganization(
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly RiskCase[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<RiskCase | null>;
  createWithinTx(riskCase: RiskCase, tx: AuthorityTransaction): Promise<RiskCase>;
  /** Persist an updated case record (appended decisions + derived state). */
  saveWithinTx(
    riskCase: RiskCase,
    tx: AuthorityTransaction,
  ): Promise<RiskCase>;
}

export interface RiskCaseService {
  /**
   * Open a case (append-only first decision `open`). Validates the
   * subject (when a person subject is given), requires ≥1 supporting
   * reference (invariant 3), and commits atomically with the
   * `risk_case.opened` audit event.
   */
  openCase(
    execution: ExecutionContext,
    input: OpenRiskCaseInput,
  ): Promise<{ readonly riskCase: RiskCase; readonly created: boolean }>;
  /**
   * Append a decision (deterministic state machine; reviewer identity
   * from the execution actor; material decisions require ≥1 source
   * ref). Commits atomically with `risk_case.decision_recorded`.
   */
  recordDecision(
    execution: ExecutionContext,
    input: RecordRiskCaseDecisionInput,
  ): Promise<RiskCase>;
  getCase(execution: ExecutionContext, id: string): Promise<RiskCase>;
  listCases(
    execution: ExecutionContext,
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly RiskCase[]>;
}

// ---------------------------------------------------------------------------
// Risk control decisions (work order §3.7)
// ---------------------------------------------------------------------------

export const RISK_CONTROL_STATES = ["ACTIVE", "RESOLVED"] as const;
export type RiskControlState = (typeof RISK_CONTROL_STATES)[number];

/**
 * A RiskControlDecision — the control-hook record consumed by the
 * downstream workflow/economic gates (work order §3.7).
 *
 * Invariants:
 *  - a material control MUST cite its origin: `assessmentId` and/or
 *    `caseId` (invariant 3 — evidence-backed material decisions); the
 *    referenced record must exist, be non-superseded and belong to the
 *    same organization scope;
 *  - controls are append-only state carriers: activation is one
 *    record; resolution flips `state` through an audited, idempotent
 *    command (never a destructive rewrite of history — the resolution
 *    lineage is carried on the record);
 *  - controls NEVER mutate downstream authorities themselves — the
 *    /workflows and /settlement gates read the active-control registry
 *    and refuse their OWN operations (lock invariant 21 enforcement
 *    point at the composition root).
 */
export interface RiskControlDecision {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly operationClass: RiskOperationClass;
  readonly action: RiskControlAction;
  /** Person- or record-scoped subject the control applies to. */
  readonly subjectPersonId: string | null;
  readonly subjectRef: RiskSubjectRef | null;
  readonly originAssessmentId: string | null;
  readonly originCaseId: string | null;
  readonly reasonCodes: readonly string[];
  readonly description: string | null;
  readonly state: RiskControlState;
  readonly activatedBy: string;
  readonly activatedAt: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  /** The case decision that resolved this control (when applicable). */
  readonly resolvedViaCaseDecisionId: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface ActivateRiskControlInput {
  readonly organizationScopeId: string;
  readonly operationClass: string;
  readonly action: string;
  readonly subjectPersonId?: string;
  readonly subjectRef?: RiskSubjectRef;
  /** At least one of originAssessmentId / originCaseId is REQUIRED. */
  readonly originAssessmentId?: string;
  readonly originCaseId?: string;
  readonly reasonCodes: readonly string[];
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface ResolveRiskControlInput {
  readonly controlDecisionId: string;
  /** The resolving case decision (required when resolving via a case). */
  readonly caseDecisionId?: string;
  readonly note?: string;
  readonly idempotencyKey: string;
}

export interface RiskControlRepository {
  save(
    control: RiskControlDecision,
    execution: ExecutionContext,
  ): Promise<RiskControlDecision>;
  findById(id: string): Promise<RiskControlDecision | null>;
  listByOrganization(
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly RiskControlDecision[]>;
  /**
   * The active-control registry read used by the composition-root
   * gates: active controls for an org, optionally narrowed by
   * operation class and/or subject id (person or record).
   */
  findActiveControls(
    organizationScopeId: string,
    operationClass?: RiskOperationClass,
    subjectId?: string,
  ): Promise<readonly RiskControlDecision[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<RiskControlDecision | null>;
  createWithinTx(
    control: RiskControlDecision,
    tx: AuthorityTransaction,
  ): Promise<RiskControlDecision>;
  /** Persist a resolution state flip (activation history preserved). */
  saveWithinTx(
    control: RiskControlDecision,
    tx: AuthorityTransaction,
  ): Promise<RiskControlDecision>;
}

export interface RiskControlService {
  /**
   * Activate a control (evidence-backed: assessment and/or case origin
   * required, same org scope, non-superseded). Commits atomically
   * with the `risk_control.activated` audit event.
   */
  activateControl(
    execution: ExecutionContext,
    input: ActivateRiskControlInput,
  ): Promise<{ readonly control: RiskControlDecision; readonly created: boolean }>;
  /**
   * Resolve (deactivate) a control. Commits atomically with the
   * `risk_control.resolved` audit event. When a case decision clears
   * a case, resolving its controls via `caseDecisionId` links the
   * resolution lineage.
   */
  resolveControl(
    execution: ExecutionContext,
    input: ResolveRiskControlInput,
  ): Promise<RiskControlDecision>;
  getControl(execution: ExecutionContext, id: string): Promise<RiskControlDecision>;
  listControls(
    execution: ExecutionContext,
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly RiskControlDecision[]>;
  /**
   * The gate read: the strongest ACTIVE control matching
   * (org, operationClass, subjectId) — person-scoped and record-scoped
   * controls both match a record id (the caller passes the record's
   * subject id and its beneficiary person id is matched server-side
   * through the person-scoped subject field). Read-only.
   */
  findGatingControl(
    execution: ExecutionContext,
    organizationScopeId: string,
    operationClass: RiskOperationClass,
    recordSubjectId: string | null,
    personSubjectId: string | null,
  ): Promise<RiskControlDecision | null>;
}

// ---------------------------------------------------------------------------
// Challenges, disputes and appeals (NET-W010 work order §3.3)
// ---------------------------------------------------------------------------

/**
 * The subject a dispute is about: a prior decision / risk case /
 * authoritative upstream record (work item §Scope). Resolution may
 * challenge, suspend, route or request re-evaluation of the subject —
 * it can never MUTATE the subject (authority separation, invariant 5:
 * /evidence remains the truth authority, /settlement the economic
 * authority, /workflows the lifecycle authority, /reputation the
 * trust-signal authority).
 */
export interface DisputeSubjectRef {
  readonly subjectType: DisputeSubjectType;
  readonly subjectId: string;
}

/**
 * Structural view of a resolved dispute subject, resolved through the
 * NEUTRAL subject lookup (composition-root wired over the owning
 * domains' repositories — never a domain-to-domain import).
 *
 *  - `anchorAt` is the subject's AUTHORITATIVE timestamp the challenge
 *    window anchors to (deterministic eligibility, invariant 4 — each
 *    subject kind's anchor is fixed by the adapter: economic value →
 *    recordedAt, credit issuance → issuedAt, cash obligation →
 *    recordedAt, contribution/proof_of_value/measured_outcome → their
 *    recorded/submitted timestamp, risk case → its last decision's
 *    recordedAt, risk control → activatedAt).
 *  - `beneficiaryPersonId` is the subject's interested participant
 *    (the conflict-of-interest check bars them from reviewing a
 *    dispute about their own record). Null when the subject carries
 *    no single beneficiary.
 */
export interface DisputeResolvedSubject {
  readonly organizationScopeId: string;
  readonly anchorAt: string;
  readonly beneficiaryPersonId: string | null;
  readonly state: string;
}

/** Over the subject-owning domains (read-only). */
export interface DisputeSubjectLookup {
  resolveSubject(
    subjectType: string,
    id: string,
  ): Promise<DisputeResolvedSubject | null>;
}

/**
 * Structural view of a stake resolved through the NEUTRAL stake
 * lookup over the settlement boundary's stake repository (read-only —
 * the disputes domain never posts or mutates stakes; it only
 * VERIFIES the linkage when bonding and RECORDS the outcome after
 * the settlement authority acted).
 */
export interface DisputeResolvedStake {
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
export interface DisputeStakeLookup {
  resolveStake(id: string): Promise<DisputeResolvedStake | null>;
}

export interface DisputeLookups {
  readonly subject: RiskSubjectLookup;
  readonly sources: RiskLookups;
  readonly disputeSubject: DisputeSubjectLookup;
  readonly stake: DisputeStakeLookup;
}

/** The dispute lifecycle events (append-only history entries). */
export const DISPUTE_EVENTS = [
  "requested",
  "stake_bonded",
  "withdrawn",
  "review_started",
  "rejected",
  "resolved",
  "appealed",
  "stake_outcome_recorded",
] as const;

export type DisputeEventKind = (typeof DISPUTE_EVENTS)[number];

export function isDisputeEventKind(value: string): value is DisputeEventKind {
  return (DISPUTE_EVENTS as readonly string[]).includes(value);
}

/**
 * One append-only event in a dispute's history. Actor identity is
 * taken from the EXECUTION ACTOR (server-side; never
 * caller-asserted — AUD-006 dispute audit lineage). Material events
 * (rejected / resolved / appealed) require ≥1 supporting reference
 * (evidence-backed material decisions).
 */
export interface DisputeEvent {
  readonly id: string;
  readonly event: DisputeEventKind;
  readonly actorPersonId: string;
  readonly reasonCodes: readonly string[];
  readonly note: string | null;
  /** Supporting references (signal / assessment / case / upstream records). */
  readonly sourceRefs: readonly RiskSignalSourceRef[];
  readonly recordedAt: string;
  readonly executionId: string;
  readonly correlationId: string;
}

/**
 * The dispute's explicit stake bookkeeping. The AMOUNT is the frozen
 * requirement at open time; `stakeId` is the settlement authority's
 * record bonded through the composition root; the recorded
 * `disposition` mirrors what the settlement authority EXECUTED (the
 * disputes domain never moves the escrow itself — invariant 1).
 */
export interface DisputeStakeBlock {
  readonly requirement: { readonly amount: number; readonly unit: "credits" };
  readonly stakeId: string | null;
  readonly bondedAt: string | null;
  readonly disposition: DisputeStakeDisposition | null;
  readonly dispositionAt: string | null;
}

/** The immutable resolution block (set on RESOLVED — never rewritten). */
export interface DisputeResolutionBlock {
  readonly outcome: DisputeOutcome;
  readonly controlDisposition: DisputeControlDisposition;
  /** The DETERMINISTIC stake mapping (core: stakeDispositionForOutcome). */
  readonly stakeDisposition: DisputeStakeDisposition;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
  readonly appealWindowExpiresAt: string;
}

/**
 * A DisputeRecord — a first-class, durable, organization-scoped
 * challenge or appeal with an immutable, append-only event history
 * (work item: "immutable lifecycle history"; invariant 8).
 *
 * The `state` is derived from the event history (monotonic); appeals
 * create a NEW linked record (`appealOfDisputeId`) and flip the
 * original RESOLVED→APPEALED with an append-only event + forward
 * pointer — the original's resolution block stays byte-identical.
 */
export interface DisputeRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly kind: DisputeKind;
  /** Set on APPEAL records: the dispute whose outcome is appealed. */
  readonly appealOfDisputeId: string | null;
  readonly challengerPersonId: string;
  readonly subjectRef: DisputeSubjectRef;
  /** The subject snapshot the deterministic eligibility gate used. */
  readonly subjectAnchorAt: string;
  readonly subjectBeneficiaryPersonId: string | null;
  readonly statement: string;
  readonly reasonCodes: readonly string[];
  readonly supportingRefs: readonly RiskSignalSourceRef[];
  readonly state: DisputeState;
  readonly stake: DisputeStakeBlock;
  readonly window: {
    readonly challengeWindowExpiresAt: string;
    readonly appealWindowExpiresAt: string | null;
  };
  readonly reviewerPersonId: string | null;
  readonly reviewStartedAt: string | null;
  readonly resolution: DisputeResolutionBlock | null;
  /** Forward pointer to the appeal record (set when appealed). */
  readonly appealDisputeId: string | null;
  readonly events: readonly DisputeEvent[];
  /** The recorded policy lineage (deterministic reproducibility). */
  readonly policyVersion: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface OpenDisputeInput {
  readonly organizationScopeId: string;
  /**
   * The subject being challenged (prior decision / risk case /
   * authoritative record).
   */
  readonly subjectRef: { readonly subjectType: string; readonly subjectId: string };
  /** The challenger's statement of the challenge (required, non-empty). */
  readonly statement: string;
  readonly reasonCodes: readonly string[];
  /** ≥1 supporting reference required (evidence-backed challenges). */
  readonly supportingRefs: readonly { readonly kind: string; readonly id: string }[];
  /**
   * The EXPLICIT eligibility reference timestamp (deterministic —
   * must fall within the subject's challenge window; no wall clock).
   */
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
}

export interface OpenDisputeResult {
  readonly dispute: DisputeRecord;
  /** false when a dispute with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface BondStakeInput {
  readonly disputeId: string;
  /** The settlement authority's stake record id (committed for this dispute). */
  readonly stakeId: string;
  readonly idempotencyKey: string;
}

export interface MarkStakeOutcomeInput {
  readonly disputeId: string;
  /** The outcome the settlement authority EXECUTED (RELEASE | FORFEIT). */
  readonly disposition: string;
  readonly stakeId: string;
  readonly transactionId: string | null;
  readonly idempotencyKey: string;
}

export interface StartDisputeReviewInput {
  readonly disputeId: string;
  readonly reasonCodes?: readonly string[];
  readonly note?: string;
  readonly idempotencyKey: string;
}

export interface RejectDisputeInput {
  readonly disputeId: string;
  readonly reasonCodes: readonly string[];
  readonly note?: string;
  /** ≥1 supporting reference required (material decision). */
  readonly sourceRefs: readonly { readonly kind: string; readonly id: string }[];
  readonly idempotencyKey: string;
}

export interface ResolveDisputeInput {
  readonly disputeId: string;
  /** UPHELD | DENIED | DISMISSED (the challenge's merits outcome). */
  readonly outcome: string;
  /** MAINTAIN_CONTROL | RELEASE_CONTROL | REQUIRE_REEVALUATION. */
  readonly controlDisposition: string;
  readonly reasonCodes: readonly string[];
  readonly note?: string;
  /** ≥1 supporting reference required (material decision). */
  readonly sourceRefs: readonly { readonly kind: string; readonly id: string }[];
  readonly idempotencyKey: string;
}

export interface AppealDisputeInput {
  readonly disputeId: string;
  readonly statement: string;
  readonly reasonCodes: readonly string[];
  /** ≥1 supporting reference required (material decision). */
  readonly supportingRefs: readonly { readonly kind: string; readonly id: string }[];
  /**
   * The EXPLICIT eligibility reference timestamp (must fall within the
   * appealed resolution's appeal window; no wall clock).
   */
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
}

export interface AppealDisputeResult {
  /** The appealed original (state APPEALED, forward pointer set). */
  readonly original: DisputeRecord;
  /** The NEW linked appeal record (state PENDING_STAKE). */
  readonly appeal: DisputeRecord;
  readonly created: boolean;
}

export interface WithdrawDisputeInput {
  readonly disputeId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface DisputeRepository {
  save(dispute: DisputeRecord, execution: ExecutionContext): Promise<DisputeRecord>;
  findById(id: string): Promise<DisputeRecord | null>;
  listByOrganization(
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly DisputeRecord[]>;
  /** Live disputes (PENDING_STAKE/OPEN/UNDER_REVIEW) about a subject. */
  findLiveBySubject(
    organizationScopeId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<readonly DisputeRecord[]>;
  /** In-transaction variant (duplicate-gate re-check inside the tx). */
  findLiveBySubjectWithinTx(
    organizationScopeId: string,
    subjectType: string,
    subjectId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly DisputeRecord[]>;
  /**
   * The gate read: disputes in the ACTIVE states (OPEN/UNDER_REVIEW/
   * APPEALED) whose subject id is in the given set — the composition
   * root's dispute gate consults this read (lock invariant 21, the
   * disputed half).
   */
  findActiveBySubjectIds(
    organizationScopeId: string,
    subjectIds: readonly string[],
  ): Promise<readonly DisputeRecord[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<DisputeRecord | null>;
  createWithinTx(
    dispute: DisputeRecord,
    tx: AuthorityTransaction,
  ): Promise<DisputeRecord>;
  /** Persist an updated dispute record (appended events + derived state). */
  saveWithinTx(
    dispute: DisputeRecord,
    tx: AuthorityTransaction,
  ): Promise<DisputeRecord>;
}

export interface DisputeService {
  /**
   * Open a dispute (the challenge request). Runs the DETERMINISTIC
   * eligibility gate — actor is a person, the subject resolves
   * same-scope with a valid anchor, `effectiveAt` is within the
   * challenge window, no other LIVE dispute covers the subject,
   * reason codes and supporting references are present — and commits
   * the PENDING_STAKE record atomically with the `dispute.opened`
   * audit event. The stake is NOT touched here (explicit bonding is
   * a separate step through the settlement authority).
   */
  openDispute(
    execution: ExecutionContext,
    input: OpenDisputeInput,
  ): Promise<OpenDisputeResult>;
  /**
   * Bond the committed stake to a PENDING_STAKE dispute ( verifier:
   * same scope, owner == challenger, amount/unit match the frozen
   * requirement, state COMMITTED, purpose links THIS dispute, bonded
   * within the challenge window). Flips the state to OPEN atomically
   * with the `dispute.stake_bonded` audit event.
   */
  bondStake(
    execution: ExecutionContext,
    input: BondStakeInput,
  ): Promise<DisputeRecord>;
  /**
   * RECORD the stake outcome the settlement authority executed
   * (release/forfeit) — append-only bookkeeping on the dispute; the
   * escrow itself is never touched here. Commits atomically with the
   * `dispute.stake_outcome_recorded` audit event.
   */
  markStakeOutcome(
    execution: ExecutionContext,
    input: MarkStakeOutcomeInput,
  ): Promise<DisputeRecord>;
  /**
   * Start the review (OPEN → UNDER_REVIEW). The reviewer is the
   * execution actor; the conflict-of-interest gate bars the
   * challenger and the subject beneficiary. Commits atomically with
   * the `dispute.review_started` audit event.
   */
  startReview(
    execution: ExecutionContext,
    input: StartDisputeReviewInput,
  ): Promise<DisputeRecord>;
  /**
   * Reject the dispute as inadmissible (OPEN/UNDER_REVIEW →
   * REJECTED; stake disposition deterministically RELEASE).
   * Material decision: ≥1 supporting reference required. Commits
   * atomically with the `dispute.rejected` audit event.
   */
  rejectDispute(
    execution: ExecutionContext,
    input: RejectDisputeInput,
  ): Promise<DisputeRecord>;
  /**
   * Resolve the dispute on the merits (UNDER_REVIEW → RESOLVED).
   * Records the outcome, the provider-neutral control disposition and
   * the DETERMINISTIC stake mapping; the economic consequence itself
   * executes through the settlement authority at the composition
   * root AFTER this records the decision. Material decision: ≥1
   * supporting reference required. Commits atomically with the
   * `dispute.resolved` audit event.
   */
  resolveDispute(
    execution: ExecutionContext,
    input: ResolveDisputeInput,
  ): Promise<DisputeRecord>;
  /**
   * Appeal a RESOLVED dispute's outcome within the appeal window: the
   * ORIGINAL flips to terminal APPEALED (append-only event + forward
   * pointer — its resolution stays byte-identical) and a NEW linked
   * APPEAL record opens (PENDING_STAKE, its own stake cycle). The
   * appellant is the execution actor (the original challenger or the
   * subject beneficiary — the interested parties). Commits atomically
   * with the `dispute.appealed` audit event.
   */
  appealDispute(
    execution: ExecutionContext,
    input: AppealDisputeInput,
  ): Promise<AppealDisputeResult>;
  /**
   * Withdraw the dispute (PENDING_STAKE/OPEN → WITHDRAWN; only the
   * challenger; stake disposition deterministically RELEASE when
   * bonded). Commits atomically with the `dispute.withdrawn` audit
   * event.
   */
  withdrawDispute(
    execution: ExecutionContext,
    input: WithdrawDisputeInput,
  ): Promise<DisputeRecord>;
  getDispute(execution: ExecutionContext, id: string): Promise<DisputeRecord>;
  listDisputes(
    execution: ExecutionContext,
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly DisputeRecord[]>;
  /**
   * The gate read (read-only): disputes in the ACTIVE states whose
   * subject id is in the given set. Consumed by the composition
   * root's dispute gate (never by any domain).
   */
  listActiveBySubjectIds(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectIds: readonly string[],
  ): Promise<readonly DisputeRecord[]>;
}

// ---------------------------------------------------------------------------
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The DisputesPort describes the boundary's readiness. After NET-W009
 * it carries the fraud/risk foundation (signals, versioned
 * deterministic policies, provenance-preserving assessments, review
 * cases, control decisions). NET-W010 extends it with the challenge/
 * dispute/appeal lifecycle and stake bonding bookkeeping.
 */
export interface DisputesPort {
  readonly boundary: "disputes";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly riskPolicyVersionCreated: "risk_policy.version_created";
    readonly riskSignalRecorded: "risk_signal.recorded";
    readonly riskSignalSuperseded: "risk_signal.superseded";
    readonly riskAssessmentRecorded: "risk_assessment.recorded";
    readonly riskCaseOpened: "risk_case.opened";
    readonly riskCaseDecisionRecorded: "risk_case.decision_recorded";
    readonly riskControlActivated: "risk_control.activated";
    readonly riskControlResolved: "risk_control.resolved";
    readonly disputeOpened: "dispute.opened";
    readonly disputeStakeBonded: "dispute.stake_bonded";
    readonly disputeReviewStarted: "dispute.review_started";
    readonly disputeRejected: "dispute.rejected";
    readonly disputeResolved: "dispute.resolved";
    readonly disputeAppealed: "dispute.appealed";
    readonly disputeWithdrawn: "dispute.withdrawn";
    readonly disputeStakeOutcomeRecorded: "dispute.stake_outcome_recorded";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  IdempotencyStore,
  RiskControlAction,
  RiskOperationClass,
  RiskEvaluationRule,
  RiskSignalCategory,
  RiskSignalProvenanceKind,
  RiskSignalSeverity,
  RiskSignalSourceKind,
  RiskState,
  RiskStateThresholds,
  DisputeControlDisposition,
  DisputeKind,
  DisputeOutcome,
  DisputeStakeDisposition,
  DisputeState,
  DisputeSubjectType,
};
