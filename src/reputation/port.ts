/**
 * Reputation boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §4 (Reputation primitive: a
 * multi-dimensional record derived from verified historical
 * performance), §11 (Reputation architecture: multidimensional, not
 * purchasable, every major change traceable to evidence),
 * §18 (module ownership: `/reputation` owns reputation computation and
 * provenance), §19 (AI/model output is never sufficient by itself to
 * authorize reputation state); spec/architecture-lock.md §3
 * (PostgreSQL authoritative), §4 (model output is input evidence,
 * never authoritative), §12 (execution lineage), §14 (provider
 * neutrality).
 *
 * Work order ref: spec/work-orders/NET-W007.md
 *   §3.1 Core reputation vocabulary (in src/core/reputation.ts).
 *   §3.2 Reputation inputs (evidence-backed, basis DERIVED).
 *   §3.3 Versioned deterministic scoring policies.
 *   §3.4 Deterministic scoring + time decay (src/reputation/scoring.ts).
 *   §3.5 Snapshots + history (append-only, reconstructable).
 *   §3.6 API surface (declared in /api; wired by the composition root).
 *
 * Requirements: REP-001 (dimensions), REP-002 (not purchasable),
 * REP-003 (time decay), REP-004 (evidence-traced changes),
 * AUD-004 (reputation lineage).
 *
 * CROSS-BOUNDARY NOTE: the reputation domain is `domain` tier. The
 * tier allow matrix prohibits domain→infrastructure, domain→adapter
 * and domain→other-domain imports. This port therefore consumes ONLY
 * core contracts. Upstream record resolution (evidence, Proof-of-Value,
 * measured outcomes, contributions, subject persons) happens through
 * the NEUTRAL structural lookup interfaces declared here — the
 * bootstrap composition root wires thin adapters over the wired
 * repositories/services of the owning domains (the same
 * dependency-inversion pattern as NET-W005's SubjectLookup and
 * NET-W006's OutcomeClaimLookup/EvidenceRecordLookup).
 *
 * THE KEY RULE (work order §2): reputation ≠ purchasable and
 * reputation ≠ economic ledger. This boundary produces derived trust
 * information ONLY: no credit issuance, no settlement, no pricing, no
 * benefit allocation, no campaign delivery, no mutation of any other
 * domain. Reputation carries no economic units and can never be spent.
 *
 * Out of scope (work order §5): Participation Credits/economic ledger
 * (NET-W008), cash settlement (NET-W008), campaign optimization,
 * creator marketplace behaviour (NET-W015+), helpfulness pipeline
 * (NET-W012 — the DIMENSION exists, the pipeline does not), fraud
 * decisions (NET-W009), challenges/disputes (NET-W010), portable
 * reputation proofs (NET-W031), external payments, and no
 * provider-specific scoring semantics.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type {
  ReputationDimension,
  ReputationInputBasis,
  ReputationInputSourceKind,
  ReputationScoringRule,
} from "../core/reputation.ts";

/**
 * A reference to an upstream record backing a reputation input. At
 * least one source is REQUIRED on every input (REP-002/REP-004): a
 * bare activity/spend assertion cannot enter the system.
 */
export interface ReputationInputSourceRef {
  readonly kind: ReputationInputSourceKind;
  readonly id: string;
}

/**
 * A ReputationInput — an immutable, append-only record feeding one
 * reputation dimension (work order §3.2).
 *
 * Invariants:
 *  - `sources` is non-empty; every source exists and belongs to the
 *    input's organization scope (validated at record time through the
 *    injected neutral lookups).
 *  - `basis` is DERIVED by the service from the resolved upstream
 *    records (never caller-asserted): `verified` iff any source is
 *    verified-grade (VERIFIED contribution/PoV/measured outcome, or
 *    platform/attested/provider evidence), else `indicated`.
 *  - `occurredAt` is the decay anchor (REP-003); `recordedAt` is the
 *    persistence time. They are independent so backdated verified
 *    history decays from when it HAPPENED.
 *  - `idempotencyKey` scopes idempotent recording: re-recording with
 *    the same key returns the existing input (created=false).
 *  - lineage identifiers trace the record to its creating execution.
 */
export interface ReputationInput {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The participant whose reputation this input feeds. */
  readonly subjectPersonId: string;
  readonly dimension: ReputationDimension;
  readonly basis: ReputationInputBasis;
  readonly sources: readonly ReputationInputSourceRef[];
  /** Human-readable, non-sensitive description of what was done. */
  readonly description: string | null;
  /** When the underlying contribution/evidence occurred (decay anchor). */
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordReputationInputInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly dimension: string;
  readonly sources: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly description?: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

export interface RecordReputationInputResult {
  readonly input: ReputationInput;
  /** false when an input with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface ReputationInputRepository {
  save(input: ReputationInput, execution: ExecutionContext): Promise<ReputationInput>;
  findById(id: string): Promise<ReputationInput | null>;
  listBySubject(organizationScopeId: string, subjectPersonId: string): Promise<readonly ReputationInput[]>;
  /** Transaction-scoped variants (snapshot computation runs in-tx). */
  findByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<ReputationInput | null>;
  listBySubjectWithinTx(
    organizationScopeId: string,
    subjectPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly ReputationInput[]>;
  createWithinTx(
    input: ReputationInput,
    tx: AuthorityTransaction,
  ): Promise<ReputationInput>;
}

/**
 * ReputationSubjectLookup — structural interface for validating that
 * the reputation subject (a person) exists (domain→domain imports are
 * prohibited; the composition root wires an adapter over the identity
 * service).
 */
export interface ReputationSubjectLookup {
  exists(personId: string): Promise<boolean>;
}

/**
 * Structural view of a resolved lifecycle upstream record
 * (contribution / Proof-of-Value / measured outcome).
 */
export interface ResolvedLifecycleSource {
  readonly organizationScopeId: string;
  readonly state: string;
}

/**
 * Structural view of a resolved evidence record.
 */
export interface ResolvedEvidenceSource {
  readonly organizationScopeId: string;
  readonly sourceType: string;
}

/**
 * ReputationEvidenceLookup — structural interface over the NET-W005
 * evidence domain's repository (existence + org scope + source type
 * for basis derivation).
 */
export interface ReputationEvidenceLookup {
  resolve(id: string): Promise<ResolvedEvidenceSource | null>;
}

/**
 * ReputationProofOfValueLookup — structural interface over the NET-W005
 * evidence domain's Proof-of-Value repository.
 */
export interface ReputationProofOfValueLookup {
  resolve(id: string): Promise<ResolvedLifecycleSource | null>;
}

/**
 * ReputationMeasuredOutcomeLookup — structural interface over the
 * NET-W006 outcomes domain's measured-outcome repository.
 */
export interface ReputationMeasuredOutcomeLookup {
  resolve(id: string): Promise<ResolvedLifecycleSource | null>;
}

/**
 * ReputationContributionLookup — structural interface over the
 * NET-W004 contributions domain's repository.
 */
export interface ReputationContributionLookup {
  resolve(id: string): Promise<ResolvedLifecycleSource | null>;
}

export interface ReputationInputService {
  /**
   * Record a reputation input (immutable, append-only). Validates the
   * subject person, the dimension, ≥1 upstream source (each resolved
   * through the injected neutral lookups; same organization scope
   * enforced), DERIVES the basis deterministically, dedupes by
   * idempotency key, and commits atomically with the
   * `reputation_input.recorded` audit event.
   */
  recordInput(
    execution: ExecutionContext,
    input: RecordReputationInputInput,
  ): Promise<RecordReputationInputResult>;
  getInput(execution: ExecutionContext, id: string): Promise<ReputationInput>;
  listInputs(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly ReputationInput[]>;
}

/**
 * A ReputationScoringPolicy — an immutable, versioned record of the
 * deterministic scoring parameters (work order §3.3).
 *
 * Invariants:
 *  - `policyId` is stable across versions; `version` increases by
 *    exactly 1 (version 1 starts a new lineage); a (policyId, version)
 *    pair is unique — existing versions are NEVER rewritten, so any
 *    historical snapshot referencing them remains reproducible.
 *  - `rules` carries EXACTLY one rule per dimension (all eight — a
 *    partial policy would silently zero unlisted dimensions).
 *  - All versions of a policyId share one organizationScopeId.
 */
export interface ReputationScoringPolicy {
  /** Record id (unique per version). */
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly description: string | null;
  readonly rules: readonly ReputationScoringRule[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface CreateReputationScoringPolicyInput {
  readonly organizationScopeId: string;
  /** The stable lineage id (caller-supplied so retries are idempotent). */
  readonly policyId: string;
  /**
   * The version being created: exactly latest+1 for an existing
   * lineage, or 1 to start a new one. Explicit so concurrent creates
   * are deterministic (the same (policyId, version) tuple replays; a
   * non-monotonic version is rejected).
   */
  readonly version: number;
  readonly description?: string;
  readonly rules: readonly {
    readonly dimension: string;
    readonly inputWeight: number;
    readonly decayHalfLifeDays: number;
    readonly maxScore: number;
    readonly indicatedWeightFactor: number;
    readonly indicatedOnlyCap: number;
  }[];
}

export interface ReputationScoringPolicyRepository {
  save(
    policy: ReputationScoringPolicy,
    execution: ExecutionContext,
  ): Promise<ReputationScoringPolicy>;
  /** Fetch by record id. */
  findById(id: string): Promise<ReputationScoringPolicy | null>;
  /** Fetch an exact (policyId, version) pair. */
  findVersion(
    policyId: string,
    version: number,
  ): Promise<ReputationScoringPolicy | null>;
  /** The highest version for a policyId (null when the lineage is new). */
  findLatestVersion(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<ReputationScoringPolicy | null>;
  listVersions(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly ReputationScoringPolicy[]>;
  /** Transaction-scoped variants (version monotonicity is checked in-tx). */
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ReputationScoringPolicy | null>;
  findVersionWithinTx(
    policyId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<ReputationScoringPolicy | null>;
  findLatestVersionWithinTx(
    policyId: string,
    organizationScopeId: string | undefined,
    tx: AuthorityTransaction,
  ): Promise<ReputationScoringPolicy | null>;
  createWithinTx(
    policy: ReputationScoringPolicy,
    tx: AuthorityTransaction,
  ): Promise<ReputationScoringPolicy>;
}

export interface ReputationPolicyService {
  /**
   * Create a policy version (append-only). Validates the rule set
   * (exactly one rule per dimension, every rule deterministic),
   * enforces version monotonicity (new lineage at version 1, else
   * latest+1) and organization-scope consistency across the lineage,
   * and commits atomically with the `reputation_policy.version_created`
   * audit event.
   */
  createPolicyVersion(
    execution: ExecutionContext,
    input: CreateReputationScoringPolicyInput,
  ): Promise<ReputationScoringPolicy>;
  getPolicy(execution: ExecutionContext, id: string): Promise<ReputationScoringPolicy>;
  getPolicyVersion(
    execution: ExecutionContext,
    policyId: string,
    version: number,
  ): Promise<ReputationScoringPolicy>;
  listPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly ReputationScoringPolicy[]>;
}

/**
 * A computed per-dimension score (work order §3.4). Deterministic:
 * identical inputs + policy + referenceAt → identical values.
 */
export interface ReputationDimensionScore {
  readonly dimension: ReputationDimension;
  readonly score: number;
  readonly inputCount: number;
  readonly verifiedInputCount: number;
  readonly indicatedInputCount: number;
  readonly decayedVerifiedWeight: number;
  readonly decayedIndicatedWeight: number;
  /** true when a policy cap (maxScore / indicatedOnlyCap) applied. */
  readonly capped: boolean;
}

export interface ComputeReputationScoresInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  /** Exact policy lineage (required — no ambient "current" policy). */
  readonly policyId: string;
  /** Omitted → the lineage's latest version. */
  readonly version?: number;
  /**
   * The decay reference timestamp (REQUIRED, explicit — REP-003/AC-04:
   * deterministic and testable without wall-clock races).
   */
  readonly referenceAt: string;
}

export interface ComputeReputationScoresResult {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  /** One score per dimension (always all eight, order = the frozen vocabulary). */
  readonly scores: readonly ReputationDimensionScore[];
  /** The exact input ids the computation covered (AUD-004). */
  readonly inputIds: readonly string[];
  /** Deterministic digest over (policyId, policyVersion, referenceAt, scores). */
  readonly digest: string;
}

/**
 * A ReputationSnapshot — an immutable, append-only point-in-time
 * multidimensional reputation record (work order §3.5).
 *
 * Reconstructability (AUD-004): the snapshot references the exact
 * policy version and the exact input ids it was computed from, plus
 * the decay reference timestamp — recomputing from those three always
 * reproduces the recorded scores and digest.
 */
export interface ReputationSnapshot {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  readonly computedAt: string;
  readonly scores: readonly ReputationDimensionScore[];
  readonly inputIds: readonly string[];
  readonly digest: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordReputationSnapshotInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly version?: number;
  readonly referenceAt: string;
  readonly idempotencyKey: string;
}

export interface RecordReputationSnapshotResult {
  readonly snapshot: ReputationSnapshot;
  /** false when a snapshot with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface ReputationSnapshotRepository {
  save(
    snapshot: ReputationSnapshot,
    execution: ExecutionContext,
  ): Promise<ReputationSnapshot>;
  findById(id: string): Promise<ReputationSnapshot | null>;
  /**
   * Ordered snapshot history for a subject (oldest → newest) —
   * score changes remain auditable and reconstructable.
   */
  listBySubject(
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly ReputationSnapshot[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ReputationSnapshot | null>;
  createWithinTx(
    snapshot: ReputationSnapshot,
    tx: AuthorityTransaction,
  ): Promise<ReputationSnapshot>;
}

export interface ReputationSnapshotService {
  /**
   * Compute scores WITHOUT persisting (deterministic preview; the
   * exact engine used for snapshots — read-only).
   */
  computeScores(
    execution: ExecutionContext,
    input: ComputeReputationScoresInput,
  ): Promise<ComputeReputationScoresResult>;
  /**
   * Compute + persist a snapshot (append-only). Runs the computation
   * INSIDE the authority transaction over the transaction-consistent
   * input set, dedupes by idempotency key, and commits atomically
   * with the `reputation_snapshot.recorded` audit event carrying the
   * policy version, reference timestamp, digest and per-dimension
   * scores (AUD-004 reputation lineage).
   */
  recordSnapshot(
    execution: ExecutionContext,
    input: RecordReputationSnapshotInput,
  ): Promise<RecordReputationSnapshotResult>;
  getSnapshot(execution: ExecutionContext, id: string): Promise<ReputationSnapshot>;
  getSnapshotHistory(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly ReputationSnapshot[]>;
  getLatestSnapshot(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<ReputationSnapshot | null>;
}

/**
 * The ReputationPort describes the boundary's readiness. After
 * NET-W007 it is `"ready"` (the boundary carries the multidimensional
 * input/policy/snapshot engine with deterministic scoring + decay).
 */
export interface ReputationPort {
  readonly boundary: "reputation";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly reputationPolicyVersionCreated: "reputation_policy.version_created";
    readonly reputationInputRecorded: "reputation_input.recorded";
    readonly reputationSnapshotRecorded: "reputation_snapshot.recorded";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  IdempotencyStore,
  ReputationDimension,
  ReputationInputBasis,
  ReputationInputSourceKind,
  ReputationScoringRule,
};
