/**
 * Outcomes boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §4 (Outcome primitive),
 * §13 (measurement architecture: deterministic attribution,
 * probabilistic attribution, experimental incrementality,
 * counterfactual savings measurement — all economically material
 * values retain confidence/uncertainty), §18 (module ownership:
 * `/outcomes` owns outcome evaluation and measurement semantics;
 * `/measurement` owns provider integrations),
 * spec/architecture-lock.md §4 (agent/model output is input evidence,
 * never authoritative), §7 (workflow authority), §14.25 (measurement
 * adapters provide facts; `/outcomes` retains semantic authority).
 *
 * Work order ref: spec/work-orders/NET-W006.md
 *   §3.1 Outcome observations (first-class, immutable, append-corrected).
 *   §3.2 Attribution representation (OUT-002, provider-neutral).
 *   §3.3 Experiments/holdouts and incrementality (OUT-003).
 *   §3.4 Counterfactual/baseline measurements (OUT-004).
 *   §3.5 Measured outcome + maturation (OUT-005).
 *   §3.6 Deterministic measurement rollup.
 *   §3.7 Provider-neutral measurement ingestion.
 *
 * CROSS-BOUNDARY NOTE: the outcomes domain is `domain` tier. The tier
 * allow matrix prohibits domain→infrastructure, domain→adapter and
 * domain→other-domain imports. This port therefore consumes ONLY core
 * contracts + the NEUTRAL measurement port
 * (src/measurement/port.ts). Concrete implementations and cross-domain
 * lookups (opportunities/contributions/evidence) are wired by the
 * bootstrap composition root through the structural interfaces
 * declared here (SubjectLookup, OutcomeClaimLookup,
 * EvidenceRecordLookup) — the same dependency-inversion pattern as
 * the evidence domain's SubjectLookup (NET-W005).
 *
 * THE KEY RULE (work order §2): measurement ≠ economic truth. This
 * boundary establishes outcomes and their uncertainty; it does NOT
 * issue credits, settle cash, mutate reputation, price advertising,
 * or create any economic authority. No entity here carries an
 * economic value dimension.
 *
 * The MeasuredOutcome is a {@link LifecycleSubject}: its maturation
 * state is mutated ONLY by the `/workflows` boundary
 * (architecture-lock §7). The outcomes domain service validates
 * maturation preconditions but never bypasses workflow authority.
 *
 * Out of scope (work order §5): no reputation scoring, Participation
 * Credits, settlement, campaign optimization, creator marketplace
 * behavior, helpfulness scoring, demand/procurement/benefit pools,
 * fraud scoring/challenge economics, blockchain consensus, or
 * provider-specific attribution internals (NET-W022).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type {
  AttributionMode,
  BaselineKind,
  CausalStatus,
  MaturationStrategy,
  MeasurementExperimentStatus,
  MeasurementProvenance,
  RollupStrategy,
} from "../core/measurement.ts";
import type {
  ConfidenceEstimate,
  EvidenceSourceType,
  OutcomeType,
} from "../core/evidence.ts";
import type { LifecycleSubject } from "../core/workflow.ts";
import type {
  MeasurementProviderAdapter,
  ProviderObservationReport,
} from "../measurement/port.ts";

/** A subject reference (same shape as the evidence domain's). */
export interface MeasurementSubjectReference {
  readonly subjectId: string;
  readonly subjectType: string;
}

/**
 * An OutcomeObservation — a first-class, durable, IMMUTABLE record of
 * a measured outcome event/fact (work order §3.1). Linked to the
 * NET-W005 vocabulary through optional validated references to an
 * OutcomeClaim and/or an Evidence record.
 *
 * Immutability + append-correction (work order §3.1): an observation
 * is NEVER mutated after creation. A correction is a NEW observation
 * with `correctsObservationId` pointing at the observation it
 * corrects. Corrections must target the CHAIN HEAD (the most recent
 * record in the correction chain); branching correction chains are
 * rejected. The original record is never rewritten.
 *
 * Invariants:
 *  - `id` is stable and opaque; `organizationScopeId` is the tenant.
 *  - `outcomeType` ∈ STANDARD_OUTCOME_TYPES.
 *  - `confidence` satisfies the EVID-005 invariants (validated).
 *  - `provenance` carries a REQUIRED method + methodVersion
 *    (model/method identity is never collapsed).
 *  - `correctsObservationId` (when present) references an existing
 *    observation in the same organization scope, same subject, same
 *    outcome type, that is the current chain head.
 *  - lineage identifiers trace the record to its creating execution.
 */
export interface OutcomeObservation {
  readonly id: string;
  readonly organizationScopeId: string;
  /** Who recorded the observation (participant or service id). */
  readonly observerId: string;
  /** What was measured (typically a contribution). */
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  /** Optional link to a NET-W005 OutcomeClaim. */
  readonly outcomeClaimId: string | null;
  /** Optional link to a NET-W005 Evidence record. */
  readonly evidenceId: string | null;
  readonly observedValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenance;
  /** The observation this record corrects (null for a root observation). */
  readonly correctsObservationId: string | null;
  /**
   * Provider-reported attribution basis (work order §3.7): recorded
   * when the observation was ingested from a provider that reported an
   * attribution mode. This is a PROVENANCE fact, not a validated
   * protocol AttributionRecord.
   */
  readonly providerAttributionMode: AttributionMode | null;
  /**
   * The provider's own subject reference (provenance/traceability for
   * provider-ingested observations; null otherwise).
   */
  readonly externalSubjectRef: string | null;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
}

export interface CreateOutcomeObservationInput {
  readonly organizationScopeId: string;
  readonly observerId: string;
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly outcomeClaimId?: string;
  readonly evidenceId?: string;
  readonly observedValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenanceInput;
}

/** The provenance shape accepted by measurement create inputs. */
export interface MeasurementProvenanceInput {
  readonly sourceType: EvidenceSourceType;
  readonly sourceId?: string;
  readonly method: string;
  readonly methodVersion: string;
  readonly collectedAt?: string;
  readonly collectorId?: string;
}

export interface CorrectOutcomeObservationInput
  extends Omit<
    CreateOutcomeObservationInput,
    "subjectReference" | "outcomeType" | "provenance"
  > {
  readonly provenance: MeasurementProvenanceInput;
  /** The CHAIN-HEAD observation this correction supersedes. */
  readonly correctsObservationId: string;
}

/** The resolved correction chain of an observation (root → head). */
export interface ObservationChain {
  /** The root observation (the original record). */
  readonly root: OutcomeObservation;
  /** Corrections in order (root → head); empty when uncorrected. */
  readonly corrections: readonly OutcomeObservation[];
  /** The current chain head (the effective measurement). */
  readonly head: OutcomeObservation;
}

export interface OutcomeObservationRepository {
  saveWithinTx(
    observation: OutcomeObservation,
    tx: AuthorityTransaction,
  ): Promise<OutcomeObservation>;
  findById(id: string): Promise<OutcomeObservation | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<OutcomeObservation | null>;
  /** List observations for a subject (committed state). */
  listBySubject(subjectId: string): Promise<readonly OutcomeObservation[]>;
  /** Find observations whose correctsObservationId equals the given id. */
  findByCorrectionOf(id: string): Promise<readonly OutcomeObservation[]>;
  exists(id: string): Promise<boolean>;
}

/**
 * The result of a provider ingestion pass: the normalized observations
 * created for one provider fetch (work order §3.7).
 */
export interface ProviderIngestionResult {
  readonly providerId: string;
  readonly createdObservations: readonly OutcomeObservation[];
}

export interface OutcomeObservationService {
  /**
   * Create an outcome observation. Validates the outcome type against
   * the OUT-001 vocabulary, the confidence invariants (EVID-005), the
   * measurement provenance (method + version REQUIRED), and the
   * optional OutcomeClaim/Evidence links (existence + organization
   * scope through the injected lookups). Emits an append-oriented
   * audit record atomically with the mutation.
   */
  createOutcomeObservation(
    execution: ExecutionContext,
    input: CreateOutcomeObservationInput,
  ): Promise<OutcomeObservation>;
  getOutcomeObservation(
    execution: ExecutionContext,
    id: string,
  ): Promise<OutcomeObservation>;
  /** List observations for a subject (committed state). */
  listObservationsBySubject(
    execution: ExecutionContext,
    subjectId: string,
  ): Promise<readonly OutcomeObservation[]>;
  /**
   * Correct an observation (append-corrected immutability): creates a
   * NEW observation superseding the chain head. The corrected record
   * must exist, share the organization scope, subject reference, and
   * outcome type, and be the CURRENT chain head (branching chains are
   * rejected). The original record is never rewritten. Audited
   * atomically.
   */
  correctOutcomeObservation(
    execution: ExecutionContext,
    input: CorrectOutcomeObservationInput,
  ): Promise<OutcomeObservation>;
  /** Resolve the full correction chain of an observation (root → head). */
  resolveObservationChain(
    execution: ExecutionContext,
    id: string,
  ): Promise<ObservationChain>;
  /**
   * Ingest observations from a provider adapter (work order §3.7).
   * Pulls normalized reports from the injected provider-neutral
   * adapter, validates each report (outcome type, confidence,
   * provenance), and persists them as provider-sourced observations
   * with full provenance. Provider output is a measurement INPUT —
   * never authoritative truth by virtue of its origin.
   */
  ingestProviderObservations(
    execution: ExecutionContext,
    input: {
      readonly subjectReference: MeasurementSubjectReference;
      readonly organizationScopeId: string;
      readonly observerId: string;
      readonly since?: string;
    },
  ): Promise<ProviderIngestionResult>;
}

/**
 * A MeasurementExperiment — a controlled experiment or holdout
 * representation (work order §3.3). The experiment's status lifecycle
 * (PLANNED → RUNNING → COMPLETED, INVALIDATED from PLANNED/RUNNING)
 * is measurement-INPUT state: deterministic domain-enforced
 * transitions, each an authorized, audited, atomic mutation. It does
 * NOT route through /workflows (that machinery is for protocol
 * lifecycle subjects; experiment status feeds measurement validity).
 */
export interface MeasurementExperiment {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  /** Provider-neutral design label (e.g. "holdout", "geo-split"). */
  readonly experimentType: string;
  readonly hypothesis: string | null;
  readonly status: MeasurementExperimentStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Increments on each status change (optimistic concurrency). */
  readonly version: number;
}

export interface CreateMeasurementExperimentInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly experimentType: string;
  readonly hypothesis?: string;
}

export interface MeasurementExperimentRepository {
  saveWithinTx(
    experiment: MeasurementExperiment,
    tx: AuthorityTransaction,
  ): Promise<MeasurementExperiment>;
  findById(id: string): Promise<MeasurementExperiment | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<MeasurementExperiment | null>;
  exists(id: string): Promise<boolean>;
}

export interface MeasurementExperimentService {
  /** Create an experiment (status PLANNED). Audited atomically. */
  createMeasurementExperiment(
    execution: ExecutionContext,
    input: CreateMeasurementExperimentInput,
  ): Promise<MeasurementExperiment>;
  getMeasurementExperiment(
    execution: ExecutionContext,
    id: string,
  ): Promise<MeasurementExperiment>;
  /** PLANNED → RUNNING. Audited atomically. */
  startExperiment(
    execution: ExecutionContext,
    input: ExperimentStatusChangeInput,
  ): Promise<MeasurementExperiment>;
  /** RUNNING → COMPLETED. Audited atomically. */
  completeExperiment(
    execution: ExecutionContext,
    input: ExperimentStatusChangeInput,
  ): Promise<MeasurementExperiment>;
  /** PLANNED|RUNNING → INVALIDATED (fail closed for measurement validity). */
  invalidateExperiment(
    execution: ExecutionContext,
    input: ExperimentStatusChangeInput & { readonly reason: string },
  ): Promise<MeasurementExperiment>;
}

/** Inputs to an experiment status change (optimistic concurrency). */
export interface ExperimentStatusChangeInput {
  readonly experimentId: string;
  readonly expectedVersion: number;
}

/**
 * An AttributionRecord — attributes an outcome observation to a
 * subject with an EXPLICIT mode (work order §3.2; OUT-002).
 *
 * Mode-specific invariants (fail closed, stable error codes):
 *  - `deterministic`: `deterministicLink` REQUIRED (mechanical/causal
 *    link type + opaque identifier). Confidence required; interval
 *    OPTIONAL (a mechanical link carries no sampling uncertainty).
 *  - `probabilistic`: `deterministicLink` FORBIDDEN (modes are
 *    represented distinctly); method + methodVersion REQUIRED;
 *    confidence interval REQUIRED (uncertainty is preserved, never
 *    collapsed — architecture §13).
 *  - `experimental`: `experimentId` REQUIRED referencing an existing
 *    experiment in the same organization scope whose status is
 *    RUNNING or COMPLETED (INVALIDATED cannot back attribution — fail
 *    closed); confidence interval REQUIRED.
 */
export interface AttributionRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The outcome observation being attributed. */
  readonly observationId: string;
  /** The subject the outcome is attributed to (typically a contribution). */
  readonly attributedSubject: MeasurementSubjectReference;
  readonly mode: AttributionMode;
  readonly attributionValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenance;
  /** REQUIRED for deterministic; FORBIDDEN for other modes. */
  readonly deterministicLink: {
    readonly linkType: string;
    readonly linkIdentifier: string;
  } | null;
  /** REQUIRED for experimental (a RUNNING or COMPLETED experiment). */
  readonly experimentId: string | null;
  /** Supporting evidence records (NET-W005), validated when present. */
  readonly evidenceIds: readonly string[];
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
}

export interface CreateAttributionInput {
  readonly organizationScopeId: string;
  readonly observationId: string;
  readonly attributedSubject: MeasurementSubjectReference;
  readonly mode: string;
  readonly attributionValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenanceInput;
  readonly deterministicLink?: {
    readonly linkType: string;
    readonly linkIdentifier: string;
  };
  readonly experimentId?: string;
  readonly evidenceIds?: readonly string[];
}

export interface AttributionRepository {
  saveWithinTx(
    attribution: AttributionRecord,
    tx: AuthorityTransaction,
  ): Promise<AttributionRecord>;
  findById(id: string): Promise<AttributionRecord | null>;
  exists(id: string): Promise<boolean>;
}

export interface AttributionService {
  /**
   * Create an attribution record. Validates the mode-specific rules
   * (work order §3.2) fail-closed, resolves the attributed
   * observation (existence + organization scope), validates the
   * experimental reference, and emits an audit record atomically with
   * the mutation.
   */
  createAttribution(
    execution: ExecutionContext,
    input: CreateAttributionInput,
  ): Promise<AttributionRecord>;
  getAttribution(
    execution: ExecutionContext,
    id: string,
  ): Promise<AttributionRecord>;
}

/**
 * An IncrementalityObservation — an explicit record of measured LIFT
 * (work order §3.3; OUT-003). The causal status is DERIVED, never
 * caller-asserted:
 *  - `experimentId` present → the experiment MUST exist in the same
 *    organization scope and be COMPLETED (PLANNED/RUNNING/INVALIDATED
 *    are rejected — fail closed) and `causalStatus` is
 *    `experiment_backed`;
 *  - `experimentId` absent → `causalStatus` is `observational`
 *    (measured lift WITHOUT a causality claim — no valid experiment
 *    exists).
 */
export interface IncrementalityObservation {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  /** The measured lift (incremental effect). */
  readonly lift: {
    readonly value: number;
    readonly unit: string;
  };
  /** The control-arm baseline the lift is measured against. */
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenance;
  readonly experimentId: string | null;
  readonly causalStatus: CausalStatus;
  readonly evidenceIds: readonly string[];
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
}

export interface CreateIncrementalityObservationInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly lift: {
    readonly value: number;
    readonly unit: string;
  };
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenanceInput;
  readonly experimentId?: string;
  readonly evidenceIds?: readonly string[];
}

export interface IncrementalityObservationRepository {
  saveWithinTx(
    observation: IncrementalityObservation,
    tx: AuthorityTransaction,
  ): Promise<IncrementalityObservation>;
  findById(id: string): Promise<IncrementalityObservation | null>;
  exists(id: string): Promise<boolean>;
}

export interface IncrementalityService {
  /**
   * Create an incrementality observation (work order §3.3). Derives
   * the causal status from the experiment reference (fail closed on
   * non-COMPLETED experiments), validates lift/baseline values +
   * confidence interval + provenance, and audits atomically.
   */
  createIncrementalityObservation(
    execution: ExecutionContext,
    input: CreateIncrementalityObservationInput,
  ): Promise<IncrementalityObservation>;
  getIncrementalityObservation(
    execution: ExecutionContext,
    id: string,
  ): Promise<IncrementalityObservation>;
}

/**
 * A CounterfactualBaseline — an explicit, auditable representation of
 * "what would have happened without the contribution"
 * (`counterfactual`) or a reference level (`baseline`) (work order
 * §3.4; OUT-004).
 *
 * A `counterfactual` estimate REQUIRES a quantified confidence
 * interval — an exact counterfactual claim without quantified
 * uncertainty is manufactured and rejected (architecture §13).
 */
export interface CounterfactualBaseline {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly baselineKind: BaselineKind;
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  /** Optional observed/comparison value (what actually happened). */
  readonly comparisonValue: {
    readonly value: number;
    readonly unit: string;
  } | null;
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenance;
  readonly evidenceIds: readonly string[];
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
}

export interface CreateCounterfactualBaselineInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly baselineKind: string;
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly comparisonValue?: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: MeasurementProvenanceInput;
  readonly evidenceIds?: readonly string[];
}

export interface CounterfactualBaselineRepository {
  saveWithinTx(
    baseline: CounterfactualBaseline,
    tx: AuthorityTransaction,
  ): Promise<CounterfactualBaseline>;
  findById(id: string): Promise<CounterfactualBaseline | null>;
  exists(id: string): Promise<boolean>;
}

export interface BaselineService {
  /**
   * Create a counterfactual/baseline measurement (work order §3.4).
   * Validates the kind, values, provenance, and the uncertainty rules
   * (interval REQUIRED for counterfactuals), and audits atomically.
   */
  createCounterfactualBaseline(
    execution: ExecutionContext,
    input: CreateCounterfactualBaselineInput,
  ): Promise<CounterfactualBaseline>;
  getCounterfactualBaseline(
    execution: ExecutionContext,
    id: string,
  ): Promise<CounterfactualBaseline>;
}

/**
 * The maturation policy of a measured outcome (work order §3.5),
 * fixed at creation:
 *  - `immediate`: no maturation gate.
 *  - `fixed_window`: `windowEndAt` REQUIRED; finalization before it
 *    is rejected.
 *  - `event_driven`: a `maturationEvent` reference is REQUIRED at
 *    finalization (auditable basis for why the outcome matured).
 */
export interface MaturationPolicy {
  readonly strategy: MaturationStrategy;
  readonly windowStartAt: string;
  readonly windowEndAt: string | null;
  /** Free-text description of the maturity signal (event_driven). */
  readonly maturationBasis: string | null;
}

/**
 * The deterministic rollup recorded on a measured outcome (work order
 * §3.6). Computed by the PURE function in measurement-rollup.ts over
 * the CHAIN-HEAD attached observations; the finalized measured value
 * is DERIVED, never caller-asserted (architecture-lock §4).
 */
export interface MeasurementRollup {
  readonly strategy: RollupStrategy;
  readonly measuredValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  /** The exact chain-head observation ids the rollup covers. */
  readonly observationIds: readonly string[];
  /** Corrections excluded from the rollup (auditability). */
  readonly supersededObservationCount: number;
  readonly computedAt: string;
}

/**
 * A MeasuredOutcome — the maturation aggregate (work order §3.5)
 * satisfying {@link LifecycleSubject}. References a subject, an
 * outcome type, optionally a NET-W005 outcome claim, and collects
 * (append-only, pre-finalization) observations, attributions,
 * baselines, and incrementality observations.
 *
 * Lifecycle (transitions owned by /workflows; canonical state
 * vocabulary reused with MATURATION semantics):
 *
 * ```text
 * DRAFT → MEASURING → VERIFIED   (VERIFIED = FINALIZED, terminal)
 * DRAFT → CANCELLED
 * MEASURING → CANCELLED
 * ```
 *
 * NOTE (non-goals): the measured outcome carries NO economic value.
 * The measuredValue is a measured fact with uncertainty; credits and
 * settlement are NET-W008. `version` is the LIFECYCLE version —
 * incremented only by workflow transitions; domain mutations
 * (attachments, rollup recording) update `updatedAt` but NOT
 * `version`.
 */
export interface MeasuredOutcome extends LifecycleSubject {
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly outcomeClaimId: string | null;
  readonly observationIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly baselineIds: readonly string[];
  readonly incrementalityIds: readonly string[];
  readonly maturation: MaturationPolicy;
  /** Deterministic rollup over the attached observations (§3.6). */
  readonly rollup: MeasurementRollup | null;
  readonly rollupStrategy: RollupStrategy;
}

export interface CreateMeasuredOutcomeInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: MeasurementSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly outcomeClaimId?: string;
  readonly maturation: {
    readonly strategy: string;
    readonly windowStartAt?: string;
    readonly windowEndAt?: string;
    readonly maturationBasis?: string;
  };
  readonly rollupStrategy?: string;
  readonly observationIds?: readonly string[];
}

/**
 * SubjectLookup — structural interface for validating that a measured
 * subject exists and resolving its organization scope WITHOUT
 * importing the opportunities/contributions domains (the bootstrap
 * composition root wires a thin adapter over the wired repositories —
 * the same pattern as the evidence domain's SubjectLookup).
 */
export interface MeasurementSubjectLookup {
  getOrganizationScope(
    subjectType: string,
    subjectId: string,
  ): Promise<string | null>;
  exists(subjectType: string, subjectId: string): Promise<boolean>;
}

/**
 * OutcomeClaimLookup — structural interface over the NET-W005
 * evidence domain's outcome-claim repository (domain→domain imports
 * are prohibited; the composition root wires the adapter).
 */
export interface OutcomeClaimLookup {
  exists(id: string): Promise<boolean>;
  getOrganizationScope(id: string): Promise<string | null>;
}

/**
 * EvidenceRecordLookup — structural interface over the NET-W005
 * evidence domain's evidence repository.
 */
export interface EvidenceRecordLookup {
  exists(id: string): Promise<boolean>;
  getOrganizationScope(id: string): Promise<string | null>;
}

/**
 * Inputs to a measured-outcome lifecycle transition request made
 * through the outcomes domain service. The service validates
 * maturation preconditions, then delegates the authorized transition
 * to the /workflows WorkflowService (the SOLE lifecycle authority).
 */
export interface MeasuredOutcomeTransitionInput {
  readonly measurementId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actorPersonId: string;
  /**
   * The explicit maturation event reference (REQUIRED to finalize an
   * event_driven measurement; recorded in the transition audit
   * trail — work order §3.5).
   */
  readonly maturationEvent?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The result of a measured-outcome lifecycle transition. */
export interface MeasuredOutcomeTransitionResult {
  readonly measurement: MeasuredOutcome;
  readonly executed: boolean;
  readonly transitionId: string;
  readonly recordId: string;
  readonly auditEventName: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly transactionId: string;
}

export interface MeasuredOutcomeRepository {
  save(
    measurement: MeasuredOutcome,
    execution: ExecutionContext,
  ): Promise<MeasuredOutcome>;
  findById(id: string): Promise<MeasuredOutcome | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<MeasuredOutcome | null>;
  createWithinTx(
    measurement: MeasuredOutcome,
    tx: AuthorityTransaction,
  ): Promise<MeasuredOutcome>;
  /** Lifecycle repository surface (consumed by the WorkflowService). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<MeasuredOutcome | null>;
  saveWithinTx(
    subject: MeasuredOutcome,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<MeasuredOutcome>;
}

export interface MeasuredOutcomeService {
  /**
   * Create a measured outcome (DRAFT). Validates the subject (through
   * the injected lookup), the outcome type, the optional outcome-claim
   * link, the maturation policy (fixed_window requires windowEndAt
   * after windowStartAt), and the initial observation attachments.
   * Audited atomically.
   */
  createMeasuredOutcome(
    execution: ExecutionContext,
    input: CreateMeasuredOutcomeInput,
  ): Promise<MeasuredOutcome>;
  getMeasuredOutcome(
    execution: ExecutionContext,
    id: string,
  ): Promise<MeasuredOutcome>;
  /**
   * Attach an outcome observation (append-only). Legal while DRAFT or
   * MEASURING (delayed outcomes arrive during maturation); rejected
   * once VERIFIED (finalized measurements are frozen). The
   * observation must exist in the same organization scope. Attaching
   * an already-attached observation is a no-op (append-only
   * idempotency). Audited atomically.
   */
  attachObservation(
    execution: ExecutionContext,
    measurementId: string,
    observationId: string,
  ): Promise<MeasuredOutcome>;
  /** Attach an attribution record (append-only; same rules). */
  attachAttribution(
    execution: ExecutionContext,
    measurementId: string,
    attributionId: string,
  ): Promise<MeasuredOutcome>;
  /** Attach a counterfactual/baseline record (append-only; same rules). */
  attachBaseline(
    execution: ExecutionContext,
    measurementId: string,
    baselineId: string,
  ): Promise<MeasuredOutcome>;
  /** Attach an incrementality observation (append-only; same rules). */
  attachIncrementality(
    execution: ExecutionContext,
    measurementId: string,
    incrementalityId: string,
  ): Promise<MeasuredOutcome>;
  /**
   * Record the deterministic rollup over the attached observations
   * (work order §3.6). Legal only in MEASURING; requires ≥1 attached
   * observation; requires ≥1 chain-head observation from a platform,
   * attested, or provider source (model/self-assessed observations
   * alone can never produce a finalized measurement —
   * architecture-lock §4). Pure deterministic function; audited
   * atomically. Re-recording recomputes from the current observation
   * set (mirrors the PoV aggregation semantics).
   */
  recordMeasurementRollup(
    execution: ExecutionContext,
    measurementId: string,
  ): Promise<MeasuredOutcome>;
  /** DRAFT → MEASURING (open the maturation window). */
  beginMaturation(
    execution: ExecutionContext,
    input: MeasuredOutcomeTransitionInput,
  ): Promise<MeasuredOutcomeTransitionResult>;
  /**
   * MEASURING → VERIFIED (FINALIZE — explicit, authorized, audited).
   * Preconditions (validated by THIS service; the workflow remains
   * the sole lifecycle mutator):
   *  - a recorded rollup (the finalized value is derived, never
   *    caller-asserted);
   *  - fixed_window: the maturation window must have elapsed;
   *  - event_driven: a maturationEvent reference is REQUIRED.
   */
  finalize(
    execution: ExecutionContext,
    input: MeasuredOutcomeTransitionInput,
  ): Promise<MeasuredOutcomeTransitionResult>;
  /** DRAFT|MEASURING → CANCELLED. */
  cancel(
    execution: ExecutionContext,
    input: MeasuredOutcomeTransitionInput,
  ): Promise<MeasuredOutcomeTransitionResult>;
}

/**
 * The OutcomesPort describes the boundary's readiness. After NET-W006
 * it is `"ready"` (the boundary carries outcome observations,
 * attribution, experiments/holdouts, incrementality, counterfactual
 * baselines, and the measured-outcome maturation lifecycle).
 */
export interface OutcomesPort {
  readonly boundary: "outcomes";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly outcomeObservationCreated: "outcome_observation.created";
    readonly outcomeObservationCorrected: "outcome_observation.corrected";
    readonly measurementExperimentCreated: "measurement_experiment.created";
    readonly measurementExperimentStarted: "measurement_experiment.started";
    readonly measurementExperimentCompleted: "measurement_experiment.completed";
    readonly measurementExperimentInvalidated: "measurement_experiment.invalidated";
    readonly attributionCreated: "attribution.created";
    readonly incrementalityObservationCreated: "incrementality_observation.created";
    readonly counterfactualBaselineCreated: "counterfactual_baseline.created";
    readonly measuredOutcomeCreated: "measured_outcome.created";
    readonly measuredOutcomeObservationAttached: "measured_outcome.observation_attached";
    readonly measuredOutcomeAttributionAttached: "measured_outcome.attribution_attached";
    readonly measuredOutcomeBaselineAttached: "measured_outcome.baseline_attached";
    readonly measuredOutcomeIncrementalityAttached: "measured_outcome.incrementality_attached";
    readonly measuredOutcomeRollupRecorded: "measured_outcome.rollup_recorded";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  AttributionMode,
  BaselineKind,
  CausalStatus,
  MaturationStrategy,
  MeasurementExperimentStatus,
  MeasurementProvenance,
  RollupStrategy,
  ConfidenceEstimate,
  EvidenceSourceType,
  OutcomeType,
  LifecycleSubject,
  MeasurementProviderAdapter,
  ProviderObservationReport,
};
