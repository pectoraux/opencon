/**
 * Evidence boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §4 (Evidence / Outcome /
 * Proof-of-Value primitives), §18 (module ownership: `/evidence` owns
 * evidence, measurement semantics support, outcome evaluation support);
 * spec/architecture-lock.md §4 (evidence authority: the evidence
 * subsystem owns evidence, provenance, confidence and verification
 * semantics; agent/model output is input evidence, never
 * authoritative), §6 (privacy authority: sensitive evidence may remain
 * off-chain; commitments + attestations prove integrity without
 * publishing raw personal data), §12 (large/immutable artifacts live
 * outside core relational rows and are referenced durably).
 *
 * Work order ref: spec/work-orders/NET-W005.md
 *   §3.1 Evidence first-class model.
 *   §3.2 Evidence grades — deterministic rule table.
 *   §3.3 Confidence and uncertainty (EVID-005).
 *   §3.4 Outcome claims (OUT-001 vocabulary, provider-neutral).
 *   §3.5 Attestations (verifier-neutral interfaces).
 *   §3.6 Evidence commitments (EVID-006).
 *   §3.7 Evidence aggregation (EVID-004).
 *   §3.8 Proof-of-Value lifecycle (transitions owned by /workflows).
 *
 * CROSS-BOUNDARY NOTE: the evidence domain is `domain` tier. The tier
 * allow matrix prohibits domain→infrastructure and domain→other-domain
 * imports. This port therefore consumes ONLY core contracts
 * (ExecutionContext, PostgresAuthority/AuthorityTransaction,
 * TransactionalAuditWriter, lifecycle vocabulary, evidence vocabulary).
 * Concrete implementations are wired by the bootstrap composition root.
 *
 * The Proof-of-Value is a {@link LifecycleSubject}: its lifecycle state
 * is mutated ONLY by the `/workflows` boundary (architecture-lock §7).
 * The evidence domain service validates PoV business preconditions but
 * never bypasses workflow authority (work order §4 invariant 5).
 *
 * Out of scope (work order §5): no reputation scoring, Participation
 * Credits, settlement, campaigns, helpfulness scoring, demand pools,
 * fraud scoring/challenge economics, blockchain consensus, model truth
 * authority, or outcome measurement semantics (NET-W006 /outcomes).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  EvidenceCommitment,
  EvidenceGrade,
  EvidenceSourceType,
  ConfidenceEstimate,
  OutcomeType,
  ProvenanceRecord,
} from "../core/evidence.ts";
import type { LifecycleSubject } from "../core/workflow.ts";

/**
 * What an evidence record / outcome claim / Proof-of-Value is ABOUT.
 * Provider-neutral and extensible: typical subject types are
 * "contribution" and "opportunity" (NET-W004 subjects); later work
 * items may add more. The evidence domain does NOT interpret the
 * subject's semantics — it validates existence + organization scope
 * through the injected {@link SubjectLookup} structural interface.
 */
export interface EvidenceSubjectReference {
  readonly subjectId: string;
  readonly subjectType: string;
}

/**
 * Evidence sensitivity classification (work order §3.1, invariant 1).
 *
 *  - `standard`: the payload is protocol data (not personal raw
 *    activity data) and MAY be stored inline in the authoritative
 *    record.
 *  - `sensitive`: the raw material NEVER enters the authoritative
 *    record (architecture-lock §6). The record stores a cryptographic
 *    commitment, an optional payload reference, and approved derived
 *    facts (grade, confidence, source metadata) ONLY.
 */
export type EvidenceSensitivity = "standard" | "sensitive";

/**
 * An Evidence record — a first-class durable object (work order §3.1;
 * EVID-002: records provenance, method, timestamp, scope and
 * confidence). Evidence records are IMMUTABLE after creation: they are
 * authoritative facts about how a claim is supported; corrections are
 * new evidence records, not mutations.
 *
 * Invariants:
 *  - `id` is stable and opaque.
 *  - `grade` is derived deterministically from `provenance.sourceType`
 *    by the explicit rule table (never from model judgment).
 *  - `confidence` satisfies the EVID-005 invariants (validated).
 *  - when `sensitivity` is "sensitive": `payload` is null and
 *    `commitment` is non-null (raw material off-record).
 *  - `payloadReference` (when present) references the off-record raw
 *    material (object-store reference or external URI) — never the
 *    material itself.
 *  - lineage identifiers trace the record to its creating execution.
 */
export interface Evidence {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  /** What this evidence supports (e.g. a contribution). */
  readonly subjectReference: EvidenceSubjectReference;
  /** Provenance: source type, source id, method, collection time, collector. */
  readonly provenance: ProvenanceRecord;
  /** Deterministic grade derived from provenance (rule table). */
  readonly grade: EvidenceGrade;
  /** Confidence with uncertainty (EVID-005). */
  readonly confidence: ConfidenceEstimate;
  readonly sensitivity: EvidenceSensitivity;
  /** Inline non-sensitive facts; null for sensitive evidence. */
  readonly payload: Readonly<Record<string, unknown>> | null;
  /** Cryptographic commitment over the raw material (required for sensitive). */
  readonly commitment: EvidenceCommitment | null;
  /** Durable reference to the off-record raw material (optional). */
  readonly payloadReference: string | null;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
}

/**
 * Inputs to create an evidence record.
 *
 * Privacy boundary (work order §3.1, invariant 1):
 *  - `sensitivity: "standard"`: `payload` MAY carry inline non-sensitive
 *    facts. `commitment` is optional integrity metadata.
 *  - `sensitivity: "sensitive"`: `payload` MUST be absent. The caller
 *    supplies EITHER `sensitivePayload` (the service computes the
 *    commitment and DISCARDS the plaintext — it is never persisted)
 *    OR a pre-computed `commitment`. `payloadReference` optionally
 *    references the off-record material.
 */
export interface CreateEvidenceInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: EvidenceSubjectReference;
  readonly provenance: {
    readonly sourceType: EvidenceSourceType;
    readonly sourceId?: string;
    readonly method: string;
    readonly collectedAt?: string;
    readonly collectorId?: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly sensitivity?: EvidenceSensitivity;
  /** Inline non-sensitive facts (standard sensitivity only). */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Raw sensitive material (sensitive sensitivity only) — committed then DISCARDED. */
  readonly sensitivePayload?: string;
  /** Pre-computed commitment (alternative to sensitivePayload). */
  readonly commitment?: EvidenceCommitment;
  /** Optional durable reference to the off-record raw material. */
  readonly payloadReference?: string;
}

/** The result of an integrity verification against a stored commitment. */
export interface CommitmentVerification {
  readonly evidenceId: string;
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * EvidenceRepository — persistence port for evidence records.
 *
 * Evidence records are immutable: the repository exposes save (create),
 * findById, listBySubject, and exists. Material mutations persist
 * through the PostgreSQL authority boundary (NET-W003) and commit
 * atomically with the audit record (the service opens ONE authoritative
 * transaction, writes via `saveWithinTx`, and appends the audit record
 * through the transactional audit buffer bound to the same tx).
 */
export interface EvidenceRepository {
  /** Persist a new evidence record within its own authority transaction. */
  save(evidence: Evidence, execution: ExecutionContext): Promise<Evidence>;
  /** Persist a new evidence record within a caller-owned authority transaction. */
  saveWithinTx(evidence: Evidence, tx: AuthorityTransaction): Promise<Evidence>;
  /** Read an evidence record by id (committed state). */
  findById(id: string): Promise<Evidence | null>;
  /** List evidence records supporting a subject (committed state). */
  listBySubject(subjectId: string): Promise<readonly Evidence[]>;
  /** Check existence. */
  exists(id: string): Promise<boolean>;
}

/**
 * An OutcomeClaim — a provider-neutral, auditable claim about a
 * measured outcome (work order §3.4; OUT-001 vocabulary). A claim
 * names one of the standard outcome types and carries a claimed value
 * + unit with confidence, referencing the evidence that supports it.
 *
 * Measurement semantics, attribution modes and incrementality are
 * NET-W006 (`/outcomes`); NET-W005 carries the CLAIM vocabulary only.
 *
 * Invariants:
 *  - `outcomeType` ∈ STANDARD_OUTCOME_TYPES (unknown types rejected).
 *  - `claimedValue` (value + unit) and `outcomeType` are IMMUTABLE
 *    after creation — a different value is a different claim.
 *  - `evidenceIds` is append-only (attach more evidence; never detach).
 *  - `version` increments on evidence attachment (optimistic
 *    concurrency for the append operation).
 */
export interface OutcomeClaim {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly claimantId: string;
  readonly subjectReference: EvidenceSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly claimedValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly evidenceIds: readonly string[];
  readonly statement: string | null;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Increments on evidence attachment. */
  readonly version: number;
}

export interface CreateOutcomeClaimInput {
  readonly organizationScopeId: string;
  readonly claimantId: string;
  readonly subjectReference: EvidenceSubjectReference;
  readonly outcomeType: OutcomeType;
  readonly claimedValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly evidenceIds?: readonly string[];
  readonly statement?: string;
}

export interface OutcomeClaimRepository {
  save(claim: OutcomeClaim, execution: ExecutionContext): Promise<OutcomeClaim>;
  saveWithinTx(claim: OutcomeClaim, tx: AuthorityTransaction): Promise<OutcomeClaim>;
  findById(id: string): Promise<OutcomeClaim | null>;
  findByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<OutcomeClaim | null>;
  exists(id: string): Promise<boolean>;
}

export interface OutcomeClaimService {
  /**
   * Create an outcome claim. Validates the outcome type against the
   * standard vocabulary, the confidence invariants, and that every
   * referenced evidence record exists within the same organization
   * scope. Emits an append-oriented audit record atomically with the
   * mutation.
   */
  createOutcomeClaim(
    execution: ExecutionContext,
    input: CreateOutcomeClaimInput,
  ): Promise<OutcomeClaim>;
  getOutcomeClaim(execution: ExecutionContext, id: string): Promise<OutcomeClaim>;
  /**
   * Attach an evidence record to a claim (append-only). When
   * `expectedVersion` is provided, a stale writer is rejected
   * (optimistic concurrency). The claimed value/unit/type are NEVER
   * mutated. Emits an audit record atomically with the mutation.
   */
  attachEvidence(
    execution: ExecutionContext,
    claimId: string,
    evidenceId: string,
    expectedVersion?: number,
  ): Promise<OutcomeClaim>;
}

/**
 * An Attestation — a verifier's signed statement binding a set of
 * evidence records (work order §3.5). The signature covers the
 * canonical digest input built from the statement + evidence ids +
 * the evidence COMMITMENT DIGESTS — so the attestation verifies
 * WITHOUT plaintext disclosure of any sensitive material
 * (architecture-lock §6).
 *
 * Signing and verification are delegated to the verifier-neutral
 * {@link AttestationSigner} / {@link AttestationVerifier} structural
 * interfaces; the domain never performs provider-specific crypto.
 */
export interface Attestation {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The attesting verifier (participant identity id). */
  readonly verifierId: string;
  /** What the verifier attests (provider-neutral statement). */
  readonly statement: string;
  /** The evidence records covered by this attestation. */
  readonly evidenceIds: readonly string[];
  /** Verifier-chosen algorithm label (opaque to the domain). */
  readonly algorithm: string;
  /** Opaque signature over the canonical digest input. */
  readonly signature: string;
  readonly signedAt: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
}

export interface CreateAttestationInput {
  readonly organizationScopeId: string;
  readonly verifierId: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
}

export interface AttestationVerification {
  readonly attestationId: string;
  readonly valid: boolean;
  readonly reason: string;
}

export interface AttestationRepository {
  save(attestation: Attestation, execution: ExecutionContext): Promise<Attestation>;
  saveWithinTx(attestation: Attestation, tx: AuthorityTransaction): Promise<Attestation>;
  findById(id: string): Promise<Attestation | null>;
  exists(id: string): Promise<boolean>;
}

/**
 * Verifier-neutral attestation signing (work order §3.5, invariant 8).
 * The domain builds the canonical digest input; the signer produces an
 * opaque (algorithm, signature) pair. Production signers arrive as
 * adapters behind this interface; the domain never performs
 * provider-specific crypto itself.
 */
export interface AttestationSigner {
  sign(canonicalInput: string): Promise<{ algorithm: string; signature: string }>;
}

/**
 * Verifier-neutral attestation verification. Receives the canonical
 * digest input REBUILT from the stored evidence commitments (no
 * plaintext) plus the stored algorithm/signature, and decides
 * validity. Never throws for an invalid attestation — returns
 * { valid: false, reason }.
 */
export interface AttestationVerifier {
  verify(
    canonicalInput: string,
    attestation: { algorithm: string; signature: string },
  ): Promise<{ valid: boolean; reason: string }>;
}

export interface AttestationService {
  /**
   * Create an attestation: validates the covered evidence exists in
   * the same organization scope, builds the canonical digest input
   * (statement + evidence ids + commitment digests), delegates signing
   * to the injected signer, persists, and emits an audit record
   * atomically with the mutation.
   */
  createAttestation(
    execution: ExecutionContext,
    input: CreateAttestationInput,
  ): Promise<Attestation>;
  getAttestation(execution: ExecutionContext, id: string): Promise<Attestation>;
  /**
   * Verify an attestation WITHOUT plaintext disclosure: rebuild the
   * canonical digest input from the STORED evidence commitments and
   * delegate to the injected verifier.
   */
  verifyAttestation(
    execution: ExecutionContext,
    id: string,
  ): Promise<AttestationVerification>;
}

/**
 * The deterministic result of aggregating multiple evidence records
 * (work order §3.7; EVID-004). Computed by the PURE function in
 * `aggregation.ts`; recorded on the Proof-of-Value when it aggregates.
 */
export interface AggregateEvidenceResult {
  readonly evidenceCount: number;
  readonly independentSources: number;
  /** Grade-weighted mean of the contributing point estimates. */
  readonly aggregatePoint: number;
  /** Conservative envelope over contributing intervals (null when none quantified). */
  readonly aggregateInterval: { readonly lower: number; readonly upper: number } | null;
  /** The grade with the highest total weight (ties → better rank). */
  readonly dominantGrade: EvidenceGrade;
  /** Grades present, ordered best-rank-first. */
  readonly gradesPresent: readonly EvidenceGrade[];
  readonly totalWeight: number;
}

/**
 * A Proof-of-Value — an evidence-backed claim object (architecture §4:
 * the settlement-claim precursor). References a subject
 * (contribution/opportunity), outcome claims, an evidence set, a
 * recorded aggregation, and attestations.
 *
 * Satisfies {@link LifecycleSubject}: lifecycle state is mutated ONLY
 * through `/workflows` (DRAFT → MEASURING → EVALUATING → VERIFIED with
 * REJECTED/CANCELLED exceptional states — work order §3.8).
 *
 * NOTE (non-goals): the PoV carries NO economic value. Value
 * quantities live on outcome claims (measured amounts); credits and
 * settlement are NET-W008. The `version` field is the LIFECYCLE
 * version — incremented only by workflow transitions; domain
 * mutations (evidence attachment, aggregation, attestation
 * attachment) update `updatedAt` but NOT `version`.
 */
export interface ProofOfValue extends LifecycleSubject {
  /** The subject this PoV is about (typically a contribution). */
  readonly subjectReference: EvidenceSubjectReference;
  /** Outcome claims summarized by this PoV. */
  readonly outcomeClaimIds: readonly string[];
  /** Attached evidence records (append-only during DRAFT/MEASURING). */
  readonly evidenceIds: readonly string[];
  /** Recorded aggregation (set when the PoV aggregates in EVALUATING). */
  readonly aggregation: AggregateEvidenceResult | null;
  /** Attached attestations (append-only during MEASURING/EVALUATING). */
  readonly attestationIds: readonly string[];
}

export interface CreateProofOfValueInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: EvidenceSubjectReference;
  readonly outcomeClaimIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
}

/**
 * SubjectLookup — structural interface for validating that a PoV
 * subject exists and resolving its organization scope WITHOUT
 * importing the opportunities/contributions domains (domain→other-
 * domain is prohibited; the bootstrap composition root wires a thin
 * adapter over the wired repositories — the same pattern as
 * OpportunityLookup in the contributions domain).
 */
export interface SubjectLookup {
  /** Resolve the subject's organization scope; null when unknown. */
  getOrganizationScope(subjectType: string, subjectId: string): Promise<string | null>;
  exists(subjectType: string, subjectId: string): Promise<boolean>;
}

/**
 * Inputs to a PoV lifecycle transition request made through the
 * evidence domain service. The service validates business
 * preconditions, then delegates the authorized transition to the
 * `/workflows` WorkflowService (the SOLE lifecycle authority).
 */
export interface ProofOfValueTransitionInput {
  readonly proofId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actorPersonId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The result of a PoV lifecycle transition (wraps the workflow result). */
export interface ProofOfValueTransitionResult {
  readonly proof: ProofOfValue;
  readonly executed: boolean;
  readonly transitionId: string;
  readonly recordId: string;
  readonly auditEventName: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly transactionId: string;
}

export interface ProofOfValueRepository {
  save(proof: ProofOfValue, execution: ExecutionContext): Promise<ProofOfValue>;
  findById(id: string): Promise<ProofOfValue | null>;
  findByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<ProofOfValue | null>;
  /** Persist a NEW proof of value within a caller-owned transaction. */
  createWithinTx(proof: ProofOfValue, tx: AuthorityTransaction): Promise<ProofOfValue>;
  /** Lifecycle repository surface (consumed by the WorkflowService). */
  getByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<ProofOfValue | null>;
  saveWithinTx(
    subject: ProofOfValue,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<ProofOfValue>;
}

export interface EvidenceService {
  /**
   * Create an evidence record. Derives the grade deterministically
   * from provenance, validates confidence, enforces the privacy
   * boundary (sensitive material → commitment only, never persisted),
   * persists through the authority, and emits an audit record
   * ATOMICALLY with the mutation (transactional audit buffer bound to
   * the same authoritative transaction).
   */
  createEvidence(execution: ExecutionContext, input: CreateEvidenceInput): Promise<Evidence>;
  getEvidence(execution: ExecutionContext, id: string): Promise<Evidence>;
  /** List evidence supporting a subject. */
  listEvidenceBySubject(execution: ExecutionContext, subjectId: string): Promise<readonly Evidence[]>;
  /**
   * Verify integrity of presented plaintext against the stored
   * commitment (recompute the digest; constant-time compare). Fails
   * closed when the record carries no commitment.
   */
  verifyEvidenceCommitment(
    execution: ExecutionContext,
    id: string,
    presentedPayload: string,
  ): Promise<CommitmentVerification>;
}

/**
 * ProofOfValueService — domain service orchestrating the
 * Proof-of-Value lifecycle. Validates business preconditions; NEVER
 * mutates lifecycle state directly (every state change routes through
 * the /workflows WorkflowService — work order invariant 5).
 */
export interface ProofOfValueService {
  createProofOfValue(
    execution: ExecutionContext,
    input: CreateProofOfValueInput,
  ): Promise<ProofOfValue>;
  getProofOfValue(execution: ExecutionContext, id: string): Promise<ProofOfValue>;
  /**
   * Attach an evidence record (append-only). Legal while DRAFT or
   * MEASURING (evidence gathering); rejected once EVALUATING (the
   * evidence set is frozen for evaluation). Audited atomically.
   */
  attachEvidence(
    execution: ExecutionContext,
    proofId: string,
    evidenceId: string,
  ): Promise<ProofOfValue>;
  /**
   * Compute + record the aggregation over the attached evidence
   * (deterministic pure function). Legal only in EVALUATING. Audited
   * atomically. Requires ≥1 attached evidence.
   */
  aggregateEvidence(
    execution: ExecutionContext,
    proofId: string,
  ): Promise<ProofOfValue>;
  /**
   * Attach an attestation (append-only). Legal while MEASURING or
   * EVALUATING. The attestation must exist in the same organization
   * scope and cover only evidence already attached to this PoV.
   * Audited atomically.
   */
  attachAttestation(
    execution: ExecutionContext,
    proofId: string,
    attestationId: string,
  ): Promise<ProofOfValue>;
  /** DRAFT → MEASURING (open evidence gathering). */
  beginMeasuring(
    execution: ExecutionContext,
    input: ProofOfValueTransitionInput,
  ): Promise<ProofOfValueTransitionResult>;
  /**
   * MEASURING → EVALUATING (evidence gathering complete). Requires
   * ≥1 attached evidence record (deterministic precondition).
   */
  completeEvidenceGathering(
    execution: ExecutionContext,
    input: ProofOfValueTransitionInput,
  ): Promise<ProofOfValueTransitionResult>;
  /**
   * EVALUATING → VERIFIED (terminal). Requires: recorded aggregation +
   * ≥1 MEASURED or ATTESTED evidence (never model/self-assessed alone —
   * architecture-lock §4) + ≥1 attached attestation.
   */
  verify(
    execution: ExecutionContext,
    input: ProofOfValueTransitionInput,
  ): Promise<ProofOfValueTransitionResult>;
  /** MEASURING|EVALUATING → REJECTED (deterministic rules failed). */
  reject(
    execution: ExecutionContext,
    input: ProofOfValueTransitionInput,
  ): Promise<ProofOfValueTransitionResult>;
  /** DRAFT|MEASURING|EVALUATING → CANCELLED. */
  cancel(
    execution: ExecutionContext,
    input: ProofOfValueTransitionInput,
  ): Promise<ProofOfValueTransitionResult>;
}

/**
 * The EvidencePort describes the boundary's readiness. After NET-W005
 * it is `"ready"` (the boundary carries evidence, outcome claims,
 * attestations, aggregation, and the Proof-of-Value model).
 */
export interface EvidencePort {
  readonly boundary: "evidence";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly evidenceCreated: "evidence.created";
    readonly outcomeClaimCreated: "outcome_claim.created";
    readonly outcomeClaimEvidenceAttached: "outcome_claim.evidence_attached";
    readonly attestationCreated: "attestation.created";
    readonly proofOfValueCreated: "proof_of_value.created";
    readonly proofOfValueEvidenceAttached: "proof_of_value.evidence_attached";
    readonly proofOfValueAggregated: "proof_of_value.aggregated";
    readonly proofOfValueAttestationAttached: "proof_of_value.attestation_attached";
  };
}

export type {
  ExecutionContext,
  EvidenceCommitment,
  EvidenceGrade,
  EvidenceSourceType,
  ConfidenceEstimate,
  OutcomeType,
  ProvenanceRecord,
  LifecycleSubject,
};
