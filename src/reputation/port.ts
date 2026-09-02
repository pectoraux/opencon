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
  /**
   * NET-W031 (additive): the transaction-scoped twin of
   * `listBySubject` — proof issuance resolves the subject's LATEST
   * authoritative snapshot INSIDE the issuance transaction (the
   * committed/in-tx twin discipline the W029 coverage lookups
   * established). Same (computedAt, id) ordering as the committed twin.
   */
  listBySubjectWithinTx(
    organizationScopeId: string,
    subjectPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly ReputationSnapshot[]>;
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

// ---------------------------------------------------------------------
// NET-W031 — Portable reputation proofs (issue #63).
//
// EXTENDS the W007 reputation authority — never rewrites it. Everything
// above (inputs, policies, snapshots, the deterministic scoring engine)
// stays byte-identical; everything below is ADDITIVE.
//
// W031 adds, inside the SAME frozen /reputation boundary (the SOLE
// reputation authority — no 18th domain):
//  - DERIVED, self-contained, tenant-scoped PORTABLE REPUTATION PROOFS:
//    the aggregate dimension facts of an authoritative snapshot (the
//    authority's OWN time-decayed values — never recomputed at
//    presentation, REP-003), bound to their lineage (snapshot id,
//    policy id + version, referenceAt, the snapshot digest) and signed
//    through the W029 signed-attestation MACHINERY (the versioned
//    algorithm + key-reference vocabularies, the SecretProvider-only
//    key resolution — composed through the NEUTRAL contracts below; NO
//    new cryptographic primitive, NO new signing surface, NO new
//    key-material class);
//  - AGGREGATE DISCLOSURE ONLY (PRIV-001..003): a proof carries the
//    subject/scope references, the lineage tuple and per-dimension
//    aggregates (score, the authority's capped flag, the three
//    evidence-reference counts — the REP-004 OPAQUE lineage). No raw
//    personal activity, no input ids, no descriptions, no source refs,
//    no payloads, no cross-tenant data ever enters a proof;
//  - DETERMINISTIC, fail-closed verification with MACHINE-READABLE
//    reasons from a closed vocabulary, in TWO forms: authority-side
//    (by id, over the stored record) and PRESENTATION-side (over a
//    presented artifact, WITHOUT querying tenant-scoped state — the
//    portable path; work order §3.3). Both are non-mutating and
//    non-auditing derived decisions;
//  - the ONE-WAY revocation discipline (the W029 precedent: a field
//    mutation, never a lifecycle transition; /workflows is not
//    extended) and VERIFICATION-TIME staleness over the issuance
//    timestamp (never a stored lifecycle state; work order §5).
//
// Proof issuance composes the W029 machinery through the NEUTRAL
// `ReputationProofSigner` / `ReputationProofVerifier` /
// `ReputationProofSigningVocabulary` contracts declared below: the
// bootstrap composition root is the ONLY join (it wires the SAME
// versioned attestation signing pair selected for the W029 surface and
// injects W029's frozen vocabularies as data — single source of truth,
// no mirrored constants to drift; the reputation domain imports core
// contracts only and never imports /evidence). PostgreSQL remains THE
// authoritative state: proofs DERIVE from recorded snapshots and never
// mint, mutate or resurrect reputation authority.
//
// Work order: spec/work-orders/NET-W031.md; issue #63; requirements
// REP-003..004 + PRIV-001..003.
// ---------------------------------------------------------------------

/** The record format marker for NET-W031 portable reputation proofs. */
export const REPUTATION_PROOF_RECORD_FORMAT = "NET-W031:1" as const;

/**
 * The FROZEN freshness window for proof staleness (work order §5):
 * staleness is a verification-time derivation over the issuance
 * timestamp — `evaluatedAt - issuedAt` must lie within this window (and
 * must be >= 0). A constant, not a per-request parameter: the staleness
 * semantics of a portable claim must not vary by who verifies it.
 */
export const REPUTATION_PROOF_FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * ONE disclosed dimension fact — AGGREGATE ONLY (work order §3.1/§3.2).
 * `score` is the authority's OWN time-decayed value from the referenced
 * snapshot (the same value the W007 engine computed and recorded at
 * snapshot time — REP-003 consistency: presentation-side recomputation
 * is forbidden); `capped` is the authority's own cap flag (W007 defines
 * no separate grade vocabulary — the disclosed per-dimension authority
 * state is exactly score + capped); the three counts are the OPAQUE
 * evidence-reference lineage (REP-004) — counts, never raw input ids.
 * The decayed weight internals are deliberately NOT disclosed (the
 * minimal aggregate projection).
 */
export interface ReputationProofDimensionFact {
  readonly dimension: ReputationDimension;
  readonly score: number;
  /** true when a policy cap (maxScore / indicatedOnlyCap) applied at snapshot time. */
  readonly capped: boolean;
  readonly inputCount: number;
  readonly verifiedInputCount: number;
  readonly indicatedInputCount: number;
}

/**
 * The SUBSTANTIVE, portable proof artifact — everything a verifier
 * needs (identity + lineage + aggregate facts + the signed envelope),
 * nothing it must not see. This is the SELF-CONTAINED presentation
 * shape: a stored `ReputationProof` IS a `PresentedReputationProof`
 * (the record adds only write bookkeeping, which is excluded from
 * signing and from verification semantics).
 */
export interface PresentedReputationProof {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  /** The authoritative snapshot the facts derive from (lineage binding). */
  readonly snapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  /** The SNAPSHOT's deterministic digest (lineage binding). */
  readonly digest: string;
  /** Exactly the eight frozen dimensions, in frozen vocabulary order. */
  readonly dimensions: readonly ReputationProofDimensionFact[];
  readonly algorithm: string;
  readonly keyReference: string;
  readonly signature: string;
  readonly issuedAt: string;
  /** Set by the ONE-WAY revocation mutation; null until revoked. */
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
  readonly recordFormat: string;
}

/**
 * A ReputationProof — a derived, immutable, portable reputation claim
 * (work order §3.1).
 *
 * Invariants:
 *  - every substantive field is DERIVED at issuance from the referenced
 *    authoritative snapshot (the aggregate projection above); the
 *    issuance input carries NO caller-asserted facts (non-purchasable,
 *    REP-002: no score-altering input exists on the proof surface);
 *  - the record is IMMUTABLE after issuance except the ONE-WAY
 *    revocation fields (`revokedAt`/`revocationReason` — the W029/W028
 *    closure precedent; never a lifecycle transition); re-issuance
 *    produces a NEW proof;
 *  - `algorithm`/`keyReference` come from the composed W029 versioned
 *    signing machinery and are validated against its CLOSED
 *    vocabularies at issuance and at verification (fail closed);
 *  - `signature` covers the "reputation-proof/v1" canonical digest
 *    input over the canonical facts (see proof-input.ts): tampering the
 *    subject, the scope, ANY lineage field, ANY aggregate dimension
 *    fact or the issuance timestamp invalidates it;
 *  - staleness is NOT a stored state: it is derived at verification
 *    time over `issuedAt` within the frozen freshness window.
 */
export interface ReputationProof extends PresentedReputationProof {
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordFormat: typeof REPUTATION_PROOF_RECORD_FORMAT;
}

export interface IssueReputationProofInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  /**
   * The EXACT snapshot to derive from. Omitted → the subject's LATEST
   * recorded snapshot IN the issuance organization scope (resolved
   * inside the authoritative transaction). Facts are ALWAYS derived —
   * never caller-asserted.
   */
  readonly snapshotId?: string;
  readonly idempotencyKey: string;
}

export interface IssueReputationProofResult {
  readonly proof: ReputationProof;
  /** false when a proof with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface RevokeReputationProofInput {
  readonly organizationScopeId: string;
  readonly proofId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * The CLOSED, machine-readable proof verification reason vocabulary
 * (work order §3.3: failures fail closed with machine-readable
 * reasons). The algorithm/key-reference/signature reasons mirror the
 * W029 vocabulary semantics — composed machinery, same failure
 * semantics; the proof-specific reasons cover revocation, malformed
 * shape and staleness.
 */
export const REPUTATION_PROOF_VERIFICATION_REASONS = [
  "verified",
  "proof_revoked",
  "malformed_proof",
  "unsupported_algorithm",
  "unknown_key_reference",
  "algorithm_key_reference_mismatch",
  "signature_mismatch",
  "proof_stale",
] as const;

export type ReputationProofVerificationReason =
  (typeof REPUTATION_PROOF_VERIFICATION_REASONS)[number];

/** The closed check-name vocabulary for per-check verification detail. */
export type ReputationProofCheckName =
  | "revocation"
  | "proof_shape"
  | "algorithm_vocabulary"
  | "key_reference_vocabulary"
  | "algorithm_key_reference_pairing"
  | "signature"
  | "staleness";

/**
 * One verification check outcome (deterministic order; no aggregate
 * counts — the aggregate-disclosure lesson). The `subject` carries the
 * failing field path for shape failures (machine-readable pinpointing)
 * and is null for global checks.
 */
export interface ReputationProofCheck {
  readonly check: ReputationProofCheckName;
  readonly subject: string | null;
  readonly passed: boolean;
  readonly reason: string;
}

/**
 * The deterministic verification verdict: identical (proof,
 * evaluatedAt, active verifier) ⇒ identical verdict object. `evaluatedAt`
 * is an EXPLICIT input (no wall clock) so verification is a pure
 * derived decision. No plaintext beyond the proof's own aggregate
 * content is disclosed on this path.
 */
export interface ReputationProofVerification {
  readonly proofId: string;
  readonly valid: boolean;
  readonly reason: ReputationProofVerificationReason;
  readonly checks: readonly ReputationProofCheck[];
}

/** Authority-side verification input (the stored proof by id). */
export interface VerifyReputationProofInput {
  readonly organizationScopeId: string;
  readonly proofId: string;
  /**
   * The EXPLICIT staleness evaluation timestamp (REQUIRED — ISO-8601;
   * determinism: no wall clock anywhere on the verification path).
   */
  readonly evaluatedAt: string;
}

/**
 * The signed envelope triple produced by the composed W029 versioned
 * machinery: (algorithm, signature, keyReference). The same structural
 * shape the W029 surface produces — composed machinery, no new
 * envelope type semantics.
 */
export interface ReputationProofSignatureMaterial {
  readonly algorithm: string;
  readonly signature: string;
  readonly keyReference: string;
}

/**
 * ReputationProofSigner — the NEUTRAL versioned signing surface W031
 * composes from the W029 machinery (declared HERE on the consuming
 * domain's port; the composition root is the only join — the W030
 * discipline). The declared `algorithm`/`keyReference` build the
 * canonical input BEFORE signing; the returned triple MUST match them
 * and the closed vocabularies (the service validates fail-closed).
 * The domain never performs provider-specific crypto and never sees
 * key material.
 */
export interface ReputationProofSigner {
  readonly algorithm: string;
  readonly keyReference: string;
  signProof(canonicalInput: string): Promise<ReputationProofSignatureMaterial>;
}

/**
 * ReputationProofVerifier — the NEUTRAL versioned verification surface
 * composed from the W029 machinery. Receives the canonical input
 * REBUILT from the PRESENTED proof facts plus the stored
 * algorithm/signature/key reference, and decides validity. Never
 * throws for an invalid proof — returns { valid: false, reason }.
 */
export interface ReputationProofVerifier {
  verifyProof(
    canonicalInput: string,
    envelope: { readonly algorithm: string; readonly signature: string; readonly keyReference: string },
  ): Promise<{ readonly valid: boolean; readonly reason: string }>;
}

/**
 * The CLOSED, VERSIONED algorithm + key-reference vocabularies and the
 * frozen pairing, INJECTED at the composition root FROM the W029
 * frozen arrays (single source of truth — the reputation domain
 * declares the neutral contract, bootstrap supplies W029's data; a new
 * algorithm id is a W029 frozen-vocabulary change, never a local one).
 */
export interface ReputationProofSigningVocabulary {
  readonly algorithms: readonly string[];
  readonly keyReferences: readonly string[];
  readonly keyReferenceByAlgorithm: Readonly<Record<string, readonly string[]>>;
}

export interface ReputationProofRepository {
  save(proof: ReputationProof, execution: ExecutionContext): Promise<ReputationProof>;
  saveWithinTx(proof: ReputationProof, tx: AuthorityTransaction): Promise<ReputationProof>;
  findById(id: string): Promise<ReputationProof | null>;
  findByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<ReputationProof | null>;
  exists(id: string): Promise<boolean>;
}

export interface ReputationProofService {
  /**
   * Issue a portable reputation proof (protected mutation; guard
   * action `reputationProof.create`). Resolves the authoritative
   * snapshot INSIDE the issuance transaction (exact id, or the
   * subject's latest in scope — missing/cross-scope/subject-mismatch
   * fail closed), derives the AGGREGATE dimension facts from the
   * STORED snapshot values (never recomputes, never accepts
   * caller-asserted facts), signs the "reputation-proof/v1" canonical
   * input through the composed W029 versioned signer, and commits the
   * immutable proof + its `reputation_proof.issued` audit event in ONE
   * authoritative transaction (composite idempotency; replay-safe).
   * Proof issuance mutates NO reputation authority state (inputs,
   * policies and snapshots are untouched).
   */
  issueProof(
    execution: ExecutionContext,
    input: IssueReputationProofInput,
  ): Promise<IssueReputationProofResult>;
  /**
   * Tenant-scoped presentation read (guard action
   * `reputationProof.read`): returns the SELF-CONTAINED proof
   * artifact; a record in another organization scope is
   * INDISTINGUISHABLE from a nonexistent one (no existence oracle).
   */
  getProof(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<ReputationProof>;
  /**
   * Authority-side deterministic verification (guard action
   * `reputationProof.verify`; work order §3.3): loads the STORED proof
   * (current revocation state) and runs the fixed fail-closed
   * check pipeline — revocation → shape → algorithm vocabulary →
   * key-reference vocabulary → pairing → signature (canonical input
   * rebuilt from the presented facts) → staleness at the EXPLICIT
   * `evaluatedAt`. Non-mutating, non-auditing.
   */
  verifyProof(
    execution: ExecutionContext,
    input: VerifyReputationProofInput,
  ): Promise<ReputationProofVerification>;
  /**
   * PRESENTATION-side deterministic verification (the PORTABLE path;
   * guard action `reputationProof.verify`): verifies a PRESENTED,
   * self-contained proof artifact WITHOUT querying ANY tenant-scoped
   * state (no store reads, no mutations, no audit). The same fixed
   * fail-closed pipeline over the presented facts; revocation is
   * evaluated from the artifact's own one-way field.
   */
  verifyPresentedProof(
    execution: ExecutionContext,
    presented: PresentedReputationProof,
    evaluatedAt: string,
  ): Promise<ReputationProofVerification>;
  /**
   * ONE-WAY revocation (guard action `reputationProof.revoke`; the
   * W029 precedent — a field mutation, never a lifecycle transition).
   * Idempotent: revoking an already-revoked proof returns it
   * unchanged. Audited atomically. A revoked proof NEVER verifies
   * again.
   */
  revokeProof(
    execution: ExecutionContext,
    input: RevokeReputationProofInput,
  ): Promise<ReputationProof>;
}

/**
 * The ReputationPort describes the boundary's readiness. After
 * NET-W007 it is `"ready"` (the boundary carries the multidimensional
 * input/policy/snapshot engine with deterministic scoring + decay);
 * NET-W031 (additive) extends the boundary with portable reputation
 * proofs over the composed W029 machinery.
 */
export interface ReputationPort {
  readonly boundary: "reputation";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly reputationPolicyVersionCreated: "reputation_policy.version_created";
    readonly reputationInputRecorded: "reputation_input.recorded";
    readonly reputationSnapshotRecorded: "reputation_snapshot.recorded";
    readonly reputationProofIssued: "reputation_proof.issued";
    readonly reputationProofRevoked: "reputation_proof.revoked";
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
