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

/** Over this boundary's own records (signals + assessments). */
export interface RiskRecordLookup {
  resolveSignal(id: string): Promise<RiskResolvedRiskRecordSource | null>;
  resolveAssessment(id: string): Promise<RiskResolvedRiskRecordSource | null>;
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
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The DisputesPort describes the boundary's readiness. After NET-W009
 * it is `"ready"` — the boundary carries the fraud/risk foundation
 * (signals, versioned deterministic policies, provenance-preserving
 * assessments, review cases, control decisions). NET-W010 will extend
 * it with staking, challenges and the dispute lifecycle.
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
};
