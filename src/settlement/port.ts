/**
 * Settlement boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §4 (Participation Credit: an
 * earned utility/accounting unit representing verified participation
 * value — distinct from cash), §5 (economic model), §17 (authoritative
 * workflow — the ledger consumes VERIFIED upstream records), §18
 * (module ownership: `/settlement` owns credits, pending/mature value,
 * cash/credit settlement), §19 (PostgreSQL authoritative; model output
 * never sufficient by itself); spec/architecture-lock.md §1 (core
 * invariants 3/4/7), §3 (PostgreSQL authoritative), §5 (economic
 * authority — credit issuance must reference verified value), §12
 * (execution lineage), §13 (economic safety invariants 19–21), §14
 * (invariant 25: payment adapters provide transaction facts;
 * `/settlement` retains semantic authority).
 *
 * Work order ref: spec/work-orders/NET-W008.md
 *   §3.1 Core economic vocabulary (in src/core/economics.ts).
 *   §3.2 Double-entry ledger (accounts + entries + transactions).
 *   §3.3 Pending value / explicit maturation.
 *   §3.4 Participation Credits (PoV-gated issuance).
 *   §3.5 Reward accounting (versioned policies + deterministic split).
 *   §3.6 Cash accounting + internal settlement state.
 *   §3.7 API surface (declared in /api; wired by the composition root).
 *
 * Requirements: ECON-001..005, SETTLE-001..003, AUD-003 (settlement
 * lineage).
 *
 * CROSS-BOUNDARY NOTE: the settlement domain is `domain` tier. The
 * tier allow matrix prohibits domain→infrastructure, domain→adapter
 * and domain→other-domain imports. This port therefore consumes ONLY
 * core contracts. Upstream record resolution (evidence,
 * Proof-of-Value, measured outcomes, beneficiary persons) happens
 * through the NEUTRAL structural lookup interfaces declared here —
 * the bootstrap composition root wires thin adapters over the wired
 * repositories/services of the owning domains (the same
 * dependency-inversion pattern as NET-W005's SubjectLookup,
 * NET-W006's OutcomeClaimLookup and NET-W007's five reputation
 * lookups).
 *
 * THE KEY RULES (work order §2):
 *  - no unverified issuance: pending value requires ≥1 qualifying
 *    VERIFIED upstream source; credit issuance requires a MATURE
 *    value record carrying a VERIFIED Proof-of-Value reference
 *    (architecture-lock invariant 20);
 *  - pending ≠ mature: only MATURE records are consumable;
 *  - conservation: every ledger transaction balances per unit and
 *    every posting keeps account balances ≥ 0 — value/credits exist
 *    only through the explicitly authorized ledger entries here;
 *  - cash and credits are distinct concepts; conversion is an explicit
 *    entry with a recorded rate, never an implicit 1:1;
 *  - corrections are append-only: historical entries are immutable and
 *    reversals post negated entries referencing the original.
 *
 * Out of scope (work order §5): fraud/risk (NET-W009),
 * staking/challenges/disputes (NET-W010), campaign economics
 * (NET-W011+), benefit pools (NET-W028), external payment execution
 * (NET-W030 — the neutral /payments port stays skeletal and is NOT
 * imported here; invariant 25), blockchain/decentralized validation,
 * and no payment-provider-specific semantics (internal payable/
 * receivable state only).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type {
  EconomicAccountKind,
  EconomicCashKind,
  EconomicConversionDirection,
  EconomicEntryDirection,
  EconomicLedgerTxKind,
  EconomicMaturationPolicy,
  EconomicStakePurposeKind,
  EconomicStakeState,
  EconomicUnitType,
  EconomicValueSourceKind,
  EconomicValueState,
} from "../core/economics.ts";

// ---------------------------------------------------------------------------
// Neutral lookups (dependency inversion over the owning domains).
// ---------------------------------------------------------------------------

/**
 * EconomicSubjectLookup — structural interface validating that a
 * beneficiary/counterparty person exists (domain→domain imports are
 * prohibited; the composition root wires an adapter over the identity
 * service).
 */
export interface EconomicSubjectLookup {
  exists(personId: string): Promise<boolean>;
}

/** Structural view of a resolved Proof-of-Value source. */
export interface ResolvedProofOfValueSource {
  readonly organizationScopeId: string;
  readonly state: string;
}

/** Structural view of a resolved measured-outcome source. */
export interface ResolvedMeasuredOutcomeSource {
  readonly organizationScopeId: string;
  readonly state: string;
}

/** Structural view of a resolved evidence record. */
export interface ResolvedEvidenceRecordSource {
  readonly organizationScopeId: string;
  readonly sourceType: string;
}

/**
 * EconomicProofOfValueLookup — structural interface over the NET-W005
 * evidence domain's Proof-of-Value repository.
 */
export interface EconomicProofOfValueLookup {
  resolve(id: string): Promise<ResolvedProofOfValueSource | null>;
}

/**
 * EconomicMeasuredOutcomeLookup — structural interface over the
 * NET-W006 outcomes domain's measured-outcome repository.
 */
export interface EconomicMeasuredOutcomeLookup {
  resolve(id: string): Promise<ResolvedMeasuredOutcomeSource | null>;
}

/**
 * EconomicEvidenceLookup — structural interface over the NET-W005
 * evidence domain's evidence repository.
 */
export interface EconomicEvidenceLookup {
  resolve(id: string): Promise<ResolvedEvidenceRecordSource | null>;
}

// ---------------------------------------------------------------------------
// §3.3 Economic value records (pending → mature → consumed/reversed).
// ---------------------------------------------------------------------------

/** A reference to a qualifying verified upstream record. */
export interface EconomicValueSourceRef {
  readonly kind: EconomicValueSourceKind;
  readonly id: string;
}

/**
 * An EconomicValueRecord — the first-class pending/mature value object
 * (work order §3.3).
 *
 * Invariants:
 *  - `sources` is non-empty; every source was RESOLVED at recognition
 *    time through the injected neutral lookups (existence + same
 *    organization scope + qualifying VERIFIED state) — a bare spend/
 *    wealth/activity/reputation assertion cannot enter the system
 *    (there is no contract field for any of them).
 *  - `state` transitions are explicit, authorized, audited and
 *    version-checked read-modify-write mutations serialized per record
 *    under the organization-independent mutex
 *    `economic_value_record:{id}` (IdempotencyStore.withLock — the
 *    NET-W007 remediation pattern):
 *      PENDING → MATURE        (matureValue — the explicit gate)
 *      PENDING → REVERSED      (reverseValue)
 *      MATURE  → REVERSED      (reverseValue)
 *      MATURE  → CONSUMED      (issueCredits / allocateRewards)
 *      CONSUMED → MATURE       (reverseIssuance / reverseAllocation —
 *                               restore; never from REVERSED)
 *  - `amount` is a validated positive 6-decimal number in the internal
 *    `value` unit; the amount is IMMUTABLE after recognition (a
 *    different amount is a different record).
 *  - `version` increments on every state mutation (optimistic
 *    concurrency); `consumedBy` records the exactly-once consumer.
 */
export interface EconomicValueRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The participant entitled to this value. */
  readonly beneficiaryPersonId: string;
  readonly state: EconomicValueState;
  readonly version: number;
  /** Positive, ≤ 6 decimals, internal `value` unit. */
  readonly amount: number;
  readonly sources: readonly EconomicValueSourceRef[];
  readonly maturation: EconomicMaturationPolicy;
  readonly description: string | null;
  readonly recordedAt: string;
  readonly maturedAt: string | null;
  readonly consumedBy:
    | { readonly kind: "credit_issuance" | "reward_allocation"; readonly id: string }
    | null;
  readonly reversal:
    | { readonly reversedAt: string; readonly reason: string; readonly transactionId: string }
    | null;
  /** The recognition ledger transaction (source of the reversal postings). */
  readonly recognitionTransactionId: string;
  /** The maturation ledger transaction (set when PENDING → MATURE). */
  readonly maturationTransactionId: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordPendingValueInput {
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly amount: number;
  readonly sources: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly maturation?: { readonly strategy: string; readonly windowEndAt?: string };
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface RecordPendingValueResult {
  readonly value: EconomicValueRecord;
  /** false when a record with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface MatureValueInput {
  readonly valueRecordId: string;
  /**
   * The explicit maturation reference timestamp (REQUIRED for
   * `fixed_window` policies: maturation is legal only when
   * effectiveAt ≥ windowEndAt — deterministic, no wall clock).
   */
  readonly effectiveAt?: string;
  readonly idempotencyKey: string;
}

export interface ReverseValueInput {
  readonly valueRecordId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface EconomicValueRepository {
  findById(id: string): Promise<EconomicValueRecord | null>;
  /** Ordered listing for a beneficiary (recordedAt, id). */
  listByBeneficiary(
    organizationScopeId: string,
    beneficiaryPersonId: string,
    states?: readonly EconomicValueState[],
  ): Promise<readonly EconomicValueRecord[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<EconomicValueRecord | null>;
  createWithinTx(
    record: EconomicValueRecord,
    tx: AuthorityTransaction,
  ): Promise<EconomicValueRecord>;
  /**
   * Version-checked read-modify-write within the caller's transaction:
   * throws a conflict error when the authoritative version differs
   * from `expectedVersion` (the same optimistic-concurrency contract
   * as the PoV lifecycle repositories).
   */
  saveWithinTx(
    record: EconomicValueRecord,
    expectedVersion: number,
    tx: AuthorityTransaction,
  ): Promise<EconomicValueRecord>;
}

export interface EconomicValueService {
  /**
   * Record pending economic value (the economic input gate). Validates
   * the beneficiary, the amount and ≥1 upstream source (each resolved
   * through the injected neutral lookups; same organization scope +
   * qualifying VERIFIED state enforced), then commits the PENDING
   * record, the balanced recognition ledger transaction (debit
   * protocol_recognition(value), credit pending_value) and the
   * `economic_value.recorded` audit event in ONE authoritative
   * transaction.
   */
  recordPendingValue(
    execution: ExecutionContext,
    input: RecordPendingValueInput,
  ): Promise<RecordPendingValueResult>;
  /**
   * Mature a pending value record (the EXPLICIT maturation gate).
   * PENDING → MATURE with balanced postings and the
   * `economic_value.matured` audit event, atomically.
   */
  matureValue(
    execution: ExecutionContext,
    input: MatureValueInput,
  ): Promise<EconomicValueRecord>;
  /**
   * Reverse a PENDING or MATURE value record (append-only correction).
   * Posts negated copies of the record's original postings and commits
   * the `economic_value.reversed` audit event atomically. CONSUMED
   * records are rejected (reverse the consumption instead).
   */
  reverseValue(
    execution: ExecutionContext,
    input: ReverseValueInput,
  ): Promise<EconomicValueRecord>;
  getValue(execution: ExecutionContext, id: string): Promise<EconomicValueRecord>;
  listValues(
    execution: ExecutionContext,
    organizationScopeId: string,
    beneficiaryPersonId: string,
    states?: readonly string[],
  ): Promise<readonly EconomicValueRecord[]>;
}

// ---------------------------------------------------------------------------
// §3.2 Double-entry ledger (accounts + entries + transactions).
// ---------------------------------------------------------------------------

/**
 * An EconomicAccount — a first-class ledger account keyed
 * deterministically by (organizationScopeId, owner, kind, unit) so a
 * tenant can never hold duplicate accounts for the same role. Person
 * accounts belong to a beneficiary; the `protocol_recognition` system
 * account (owner null) is the contra account that keeps every
 * transaction balanced per unit.
 */
export interface EconomicAccount {
  /** Deterministic composite key (org|owner|kind|unit) — stable identity. */
  readonly id: string;
  readonly organizationScopeId: string;
  /** null for the protocol_recognition system account. */
  readonly ownerPersonId: string | null;
  readonly kind: EconomicAccountKind;
  readonly unit: EconomicUnitType;
  readonly createdAt: string;
}

/**
 * An EconomicLedgerEntry — one immutable posting line. Entries carry
 * denormalized (organizationScopeId, ownerPersonId, accountKind) so
 * balances and lineage queries reconstruct from the entry set alone.
 */
export interface EconomicLedgerEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly accountId: string;
  readonly accountKind: EconomicAccountKind;
  readonly organizationScopeId: string;
  readonly ownerPersonId: string | null;
  readonly direction: EconomicEntryDirection;
  readonly amount: number;
  readonly unit: EconomicUnitType;
  readonly recordedAt: string;
}

/**
 * The economic record a ledger transaction belongs to (AUD-003
 * settlement lineage: given an economic record, every ledger movement
 * it caused is queryable).
 */
export interface EconomicLedgerSubjectRef {
  readonly kind:
    | "economic_value"
    | "credit_issuance"
    | "reward_allocation"
    | "cash_obligation"
    | "conversion"
    // NET-W010 (additive): the stake record — the encumbrance a
    // challenge participant commits through this boundary.
    | "stake";
  readonly id: string;
}

/**
 * An EconomicLedgerTransaction — a balanced set of immutable entries
 * posted by exactly one authorized economic command. Per-unit
 * conservation (`Σdebit === Σcredit`, scaled integers) is validated by
 * the posting layer BEFORE anything is persisted, and every affected
 * account's post-balance must remain ≥ 0.
 */
export interface EconomicLedgerTransaction {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly kind: EconomicLedgerTxKind;
  readonly description: string | null;
  readonly subject: EconomicLedgerSubjectRef | null;
  readonly entries: readonly EconomicLedgerEntry[];
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** A posting instruction passed to the ledger posting layer. */
export interface EconomicPostingInput {
  readonly accountId: string;
  readonly accountKind: EconomicAccountKind;
  readonly ownerPersonId: string | null;
  readonly direction: EconomicEntryDirection;
  readonly amount: number;
  readonly unit: EconomicUnitType;
}

/** A prepared ledger transaction (pre-validated postings). */
export interface PostLedgerTransactionInput {
  readonly organizationScopeId: string;
  readonly kind: EconomicLedgerTxKind;
  readonly description?: string;
  readonly subject?: EconomicLedgerSubjectRef;
  readonly entries: readonly EconomicPostingInput[];
  readonly idempotencyKey: string;
}

export interface EconomicAccountBalance {
  readonly accountId: string;
  readonly organizationScopeId: string;
  readonly ownerPersonId: string | null;
  readonly kind: EconomicAccountKind;
  readonly unit: EconomicUnitType;
  /** Normal-side signed balance (≥ 0 is enforced at posting time). */
  readonly balance: number;
}

/** A participant's economic summary (balances derived from entries). */
export interface ParticipantEconomicSummary {
  readonly organizationScopeId: string;
  readonly personId: string;
  readonly pendingValue: number;
  readonly matureValue: number;
  readonly credits: number;
  readonly rewards: number;
  readonly cashPayable: number;
  readonly cashReceivable: number;
}

export interface EconomicLedgerRepository {
  // Accounts.
  findAccount(
    organizationScopeId: string,
    ownerPersonId: string | null,
    kind: EconomicAccountKind,
    unit: EconomicUnitType,
  ): Promise<EconomicAccount | null>;
  findAccountWithinTx(
    organizationScopeId: string,
    ownerPersonId: string | null,
    kind: EconomicAccountKind,
    unit: EconomicUnitType,
    tx: AuthorityTransaction,
  ): Promise<EconomicAccount | null>;
  createAccountWithinTx(
    account: EconomicAccount,
    tx: AuthorityTransaction,
  ): Promise<EconomicAccount>;
  listAccounts(
    organizationScopeId: string,
  ): Promise<readonly EconomicAccount[]>;
  // Entries.
  listEntriesForAccountWithinTx(
    accountId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly EconomicLedgerEntry[]>;
  listEntriesForAccount(
    accountId: string,
  ): Promise<readonly EconomicLedgerEntry[]>;
  // Transactions.
  findTransaction(id: string): Promise<EconomicLedgerTransaction | null>;
  listTransactionsBySubject(
    subject: EconomicLedgerSubjectRef,
  ): Promise<readonly EconomicLedgerTransaction[]>;
  createTransactionWithinTx(
    transaction: EconomicLedgerTransaction,
    tx: AuthorityTransaction,
  ): Promise<EconomicLedgerTransaction>;
  /** All entries in an organization (conservation audits/tests). */
  scanEntries(
    organizationScopeId?: string,
  ): Promise<readonly EconomicLedgerEntry[]>;
}

export interface EconomicLedgerService {
  /** Fetch a ledger transaction by id (public read). */
  getTransaction(
    execution: ExecutionContext,
    id: string,
  ): Promise<EconomicLedgerTransaction>;
  /** Every ledger transaction caused by an economic record (AUD-003). */
  listTransactionsBySubject(
    execution: ExecutionContext,
    subject: EconomicLedgerSubjectRef,
  ): Promise<readonly EconomicLedgerTransaction[]>;
  /** All account balances for an organization (derived from entries). */
  listAccountBalances(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly EconomicAccountBalance[]>;
  /** A participant's economic summary (derived from entries). */
  getParticipantSummary(
    execution: ExecutionContext,
    organizationScopeId: string,
    personId: string,
  ): Promise<ParticipantEconomicSummary>;
}

// ---------------------------------------------------------------------------
// §3.4 Participation Credits.
// ---------------------------------------------------------------------------

/**
 * A CreditIssuance — the first-class record of Participation Credits
 * minted against verified value (ECON-001: credits are EARNED
 * utility/accounting units with stable identifiers).
 *
 * Invariants:
 *  - `sourceValueRecordId` referenced a MATURE value record at issuance
 *    whose sources include ≥1 `proof_of_value` resolving VERIFIED
 *    (architecture-lock invariant 20);
 *  - `creditAmount` was computed deterministically from
 *    `sourceValueAmount × creditsPerValueUnit` (explicit rate — the
 *    issuance record IS the explicit conversion authorization for
 *    value→credits);
 *  - `status` is `issued` or `reversed` (append-only correction).
 */
export interface CreditIssuance {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly creditAmount: number;
  readonly sourceValueRecordId: string;
  readonly sourceValueAmount: number;
  readonly proofOfValueId: string;
  readonly creditsPerValueUnit: number;
  readonly status: "issued" | "reversed";
  readonly reversal:
    | { readonly reversedAt: string; readonly reason: string; readonly transactionId: string }
    | null;
  /** The issuance ledger transaction (source of the reversal postings). */
  readonly transactionId: string;
  readonly issuedAt: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface IssueCreditsInput {
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly sourceValueRecordId: string;
  /** Explicit issuance rate (credits per value unit), > 0, ≤ 6 decimals. */
  readonly creditsPerValueUnit: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface IssueCreditsResult {
  readonly issuance: CreditIssuance;
  /** false when an issuance with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface ReverseIssuanceInput {
  readonly issuanceId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface CreditIssuanceRepository {
  findById(id: string): Promise<CreditIssuance | null>;
  listByBeneficiary(
    organizationScopeId: string,
    beneficiaryPersonId: string,
  ): Promise<readonly CreditIssuance[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<CreditIssuance | null>;
  createWithinTx(
    issuance: CreditIssuance,
    tx: AuthorityTransaction,
  ): Promise<CreditIssuance>;
  saveWithinTx(
    issuance: CreditIssuance,
    tx: AuthorityTransaction,
  ): Promise<CreditIssuance>;
}

export interface CreditService {
  /**
   * Issue Participation Credits against ONE MATURE value record. THE
   * GATE (architecture-lock §5 + invariant 20): the record must carry
   * ≥1 `proof_of_value` source resolving VERIFIED. Posts the dual-side
   * balanced issuance transaction, consumes the record (MATURE →
   * CONSUMED) and commits the `credit_issuance.issued` audit event
   * atomically.
   */
  issueCredits(
    execution: ExecutionContext,
    input: IssueCreditsInput,
  ): Promise<IssueCreditsResult>;
  /**
   * Reverse an issuance (append-only correction). Negates the issuance
   * postings (the beneficiary's credits balance must cover the return —
   * conservation rejects overdraft), restores the source value record
   * to MATURE and commits the `credit_issuance.reversed` audit event
   * atomically.
   */
  reverseIssuance(
    execution: ExecutionContext,
    input: ReverseIssuanceInput,
  ): Promise<CreditIssuance>;
  getIssuance(
    execution: ExecutionContext,
    id: string,
  ): Promise<CreditIssuance>;
  listIssuances(
    execution: ExecutionContext,
    organizationScopeId: string,
    beneficiaryPersonId: string,
  ): Promise<readonly CreditIssuance[]>;
}

// ---------------------------------------------------------------------------
// §3.5 Reward accounting.
// ---------------------------------------------------------------------------

/**
 * A RewardAllocationPolicy — an immutable, versioned record of a
 * deterministic reward split (work order §3.5).
 *
 * Invariants (the exact NET-W007 policy-lineage pattern):
 *  - `policyId` is stable across versions; `version` increases by
 *    exactly 1 (version 1 starts a new lineage); a (policyId, version)
 *    pair is unique — existing versions are NEVER rewritten;
 *  - all versions of a lineage share one organization scope; lineage
 *    creates are serialized under the ORGANIZATION-INDEPENDENT mutex
 *    `economic_reward_policy_lineage:{policyId}` and the cross-scope
 *    check runs against the org-independent lineage read on EVERY
 *    create (including version 1) — a lineage can never fork;
 *  - `allocations` is non-empty; each entry carries a beneficiary
 *    person + weight > 0; beneficiaries are unique.
 */
export interface RewardAllocationPolicy {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly description: string | null;
  readonly allocations: readonly {
    readonly beneficiaryPersonId: string;
    readonly weight: number;
  }[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface CreateRewardPolicyInput {
  readonly organizationScopeId: string;
  readonly policyId: string;
  /** Exactly latest+1 for an existing lineage, or 1 to start a new one. */
  readonly version: number;
  readonly description?: string;
  readonly allocations: readonly {
    readonly beneficiaryPersonId: string;
    readonly weight: number;
  }[];
}

export interface RewardAllocationPolicyRepository {
  findById(id: string): Promise<RewardAllocationPolicy | null>;
  findVersion(
    policyId: string,
    version: number,
  ): Promise<RewardAllocationPolicy | null>;
  findLatestVersion(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<RewardAllocationPolicy | null>;
  listVersions(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly RewardAllocationPolicy[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocationPolicy | null>;
  findVersionWithinTx(
    policyId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocationPolicy | null>;
  findLatestVersionWithinTx(
    policyId: string,
    organizationScopeId: string | undefined,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocationPolicy | null>;
  createWithinTx(
    policy: RewardAllocationPolicy,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocationPolicy>;
}

export interface RewardPolicyService {
  /**
   * Create a reward-policy version (append-only). Validates the
   * allocation set (≥1 entry, weights > 0, unique existing
   * beneficiaries), enforces version monotonicity + single-scope
   * lineages (org-independent lineage mutex — the NET-W007 pattern)
   * and commits the `reward_policy.version_created` audit event
   * atomically.
   */
  createPolicyVersion(
    execution: ExecutionContext,
    input: CreateRewardPolicyInput,
  ): Promise<RewardAllocationPolicy>;
  getPolicy(execution: ExecutionContext, id: string): Promise<RewardAllocationPolicy>;
  getPolicyVersion(
    execution: ExecutionContext,
    policyId: string,
    version: number,
  ): Promise<RewardAllocationPolicy>;
  listPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly RewardAllocationPolicy[]>;
}

/**
 * A RewardAllocation — the deterministic split of ONE MATURE source
 * value record among beneficiaries under an exact policy version
 * (work order §3.5).
 *
 * Determinism: shares are computed in policy declaration order with
 * scaled-integer arithmetic; every share except the LAST is
 * floor(source × weight / totalWeight); the LAST share absorbs the
 * rounding remainder so Σ shares === source EXACTLY (conservation).
 */
export interface RewardAllocation {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly sourceValueRecordId: string;
  readonly sourceValueAmount: number;
  readonly sourceBeneficiaryPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly totalAllocated: number;
  readonly shares: readonly {
    readonly beneficiaryPersonId: string;
    readonly amount: number;
    readonly weight: number;
  }[];
  readonly status: "allocated" | "reversed";
  readonly reversal:
    | { readonly reversedAt: string; readonly reason: string; readonly transactionId: string }
    | null;
  /** The allocation ledger transaction (source of the reversal postings). */
  readonly transactionId: string;
  readonly allocatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface AllocateRewardsInput {
  readonly organizationScopeId: string;
  readonly sourceValueRecordId: string;
  readonly policyId: string;
  /** Omitted → the lineage's latest version. */
  readonly version?: number;
  readonly idempotencyKey: string;
}

export interface AllocateRewardsResult {
  readonly allocation: RewardAllocation;
  /** false when an allocation with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface ReverseAllocationInput {
  readonly allocationId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RewardAllocationRepository {
  findById(id: string): Promise<RewardAllocation | null>;
  listByOrganization(
    organizationScopeId: string,
  ): Promise<readonly RewardAllocation[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocation | null>;
  createWithinTx(
    allocation: RewardAllocation,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocation>;
  saveWithinTx(
    allocation: RewardAllocation,
    tx: AuthorityTransaction,
  ): Promise<RewardAllocation>;
}

export interface RewardService {
  /**
   * Allocate rewards from ONE MATURE source value record under an
   * exact policy version. Posts the balanced allocation transaction
   * (debit mature_value source holder, credit rewards per
   * beneficiary), consumes the record (MATURE → CONSUMED) and commits
   * the `reward_allocation.recorded` audit event atomically.
   */
  allocateRewards(
    execution: ExecutionContext,
    input: AllocateRewardsInput,
  ): Promise<AllocateRewardsResult>;
  /**
   * Reverse an allocation (append-only correction). Negates the
   * postings with per-beneficiary rewards-balance checks, restores the
   * source record to MATURE and commits the
   * `reward_allocation.reversed` audit event atomically.
   */
  reverseAllocation(
    execution: ExecutionContext,
    input: ReverseAllocationInput,
  ): Promise<RewardAllocation>;
  getAllocation(
    execution: ExecutionContext,
    id: string,
  ): Promise<RewardAllocation>;
  listAllocations(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly RewardAllocation[]>;
}

// ---------------------------------------------------------------------------
// §3.6 Cash accounting + internal settlement state.
// ---------------------------------------------------------------------------

/**
 * A CashObligation — a first-class cash payable (the protocol owes a
 * counterparty) or receivable (a counterparty owes the protocol),
 * booked in the `cash` unit against protocol_recognition(cash).
 * External payment execution is NET-W030 (out of scope); the statuses
 * below represent INTERNAL settlement state only (SETTLE-001/002).
 */
export interface CashObligation {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly kind: EconomicCashKind;
  /** The counterparty person owed to / owing. */
  readonly counterpartyPersonId: string;
  /** Positive, ≤ 6 decimals, `cash` unit. */
  readonly amount: number;
  readonly status: "recognized" | "settled" | "reversed";
  readonly settledAt: string | null;
  /** Settlement reference (internal; external rails attach in NET-W030). */
  readonly settlementReference: string | null;
  readonly reversal:
    | { readonly reversedAt: string; readonly reason: string; readonly transactionId: string }
    | null;
  /** The recognition ledger transaction (source of the reversal postings). */
  readonly transactionId: string;
  readonly description: string | null;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordCashObligationInput {
  readonly organizationScopeId: string;
  readonly kind: string;
  readonly counterpartyPersonId: string;
  readonly amount: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface RecordCashObligationResult {
  readonly obligation: CashObligation;
  /** false when an obligation with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface SettleCashObligationInput {
  readonly obligationId: string;
  /** Internal settlement reference (audit lineage). */
  readonly reference?: string;
  readonly idempotencyKey: string;
}

export interface ReverseCashObligationInput {
  readonly obligationId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface CashObligationRepository {
  findById(id: string): Promise<CashObligation | null>;
  listByOrganization(
    organizationScopeId: string,
  ): Promise<readonly CashObligation[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<CashObligation | null>;
  createWithinTx(
    obligation: CashObligation,
    tx: AuthorityTransaction,
  ): Promise<CashObligation>;
  saveWithinTx(
    obligation: CashObligation,
    tx: AuthorityTransaction,
  ): Promise<CashObligation>;
}

export interface CashService {
  /**
   * Record a cash obligation (payable or receivable) with balanced
   * postings; commits the `cash_obligation.recorded` audit event
   * atomically.
   */
  recordCashObligation(
    execution: ExecutionContext,
    input: RecordCashObligationInput,
  ): Promise<RecordCashObligationResult>;
  /**
   * Settle a recognized obligation INTERNALLY (recognized → settled)
   * with balanced postings; commits the `cash_obligation.settled`
   * audit event atomically. External payment execution remains
   * NET-W030 behind the neutral /payments port.
   */
  settleCashObligation(
    execution: ExecutionContext,
    input: SettleCashObligationInput,
  ): Promise<CashObligation>;
  /**
   * Reverse a recognized obligation (append-only correction) with
   * negated postings; commits the `cash_obligation.reversed` audit
   * event atomically.
   */
  reverseCashObligation(
    execution: ExecutionContext,
    input: ReverseCashObligationInput,
  ): Promise<CashObligation>;
  getObligation(execution: ExecutionContext, id: string): Promise<CashObligation>;
  listObligations(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly CashObligation[]>;
}

/**
 * A Conversion — the ONLY cash↔credits movement path (work order
 * §3.6). Both amounts are explicit on the record (the implied rate is
 * recorded, never assumed 1:1 — ECON-004 / architecture-lock
 * invariant 7), and the postings are dual-side balanced per unit.
 */
export interface EconomicConversion {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly personId: string;
  readonly direction: EconomicConversionDirection;
  /** The cash amount (cash unit). */
  readonly cashAmount: number;
  /** The credits amount (credits unit). */
  readonly creditsAmount: number;
  /** cashAmount / creditsAmount, recorded for auditability. */
  readonly rate: number;
  readonly status: "converted" | "reversed";
  readonly reversal:
    | { readonly reversedAt: string; readonly reason: string; readonly transactionId: string }
    | null;
  /** The conversion ledger transaction (source of the reversal postings). */
  readonly transactionId: string;
  readonly convertedAt: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordConversionInput {
  readonly organizationScopeId: string;
  readonly personId: string;
  readonly direction: string;
  readonly cashAmount: number;
  readonly creditsAmount: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface RecordConversionResult {
  readonly conversion: EconomicConversion;
  /** false when a conversion with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface ReverseConversionInput {
  readonly conversionId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ConversionRepository {
  findById(id: string): Promise<EconomicConversion | null>;
  listByOrganization(
    organizationScopeId: string,
  ): Promise<readonly EconomicConversion[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<EconomicConversion | null>;
  createWithinTx(
    conversion: EconomicConversion,
    tx: AuthorityTransaction,
  ): Promise<EconomicConversion>;
  saveWithinTx(
    conversion: EconomicConversion,
    tx: AuthorityTransaction,
  ): Promise<EconomicConversion>;
}

export interface ConversionService {
  /**
   * Record an explicit cash↔credits conversion. Validates both amounts
   * (> 0), records the implied rate, posts the dual-side balanced
   * transaction (balance checks enforce that the source side actually
   * holds the funds) and commits the `conversion.recorded` audit event
   * atomically. This is the ONLY path between the cash and credits
   * concepts.
   */
  recordConversion(
    execution: ExecutionContext,
    input: RecordConversionInput,
  ): Promise<RecordConversionResult>;
  /**
   * Reverse a conversion (append-only correction) with negated
   * postings and balance checks; commits the `conversion.reversed`
   * audit event atomically.
   */
  reverseConversion(
    execution: ExecutionContext,
    input: ReverseConversionInput,
  ): Promise<EconomicConversion>;
  getConversion(execution: ExecutionContext, id: string): Promise<EconomicConversion>;
  listConversions(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly EconomicConversion[]>;
}

/**
 * The SettlementPort describes the boundary's readiness. After
 * NET-W008 it is `"ready"` (the boundary carries the double-entry
 * ledger, pending/mature value with explicit maturation, PoV-gated
 * Participation Credit issuance, deterministic reward accounting, cash
 * obligations with internal settlement state, and explicit cash↔
 * credits conversion). NET-W010 extends it with the stake escrow
 * commands (commit/release/forfeit) — the economic authority for
 * challenge participation stakes.
 */
export interface SettlementPort {
  readonly boundary: "settlement";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly economicValueRecorded: "economic_value.recorded";
    readonly economicValueMatured: "economic_value.matured";
    readonly economicValueReversed: "economic_value.reversed";
    readonly creditIssuanceIssued: "credit_issuance.issued";
    readonly creditIssuanceReversed: "credit_issuance.reversed";
    readonly rewardPolicyVersionCreated: "reward_policy.version_created";
    readonly rewardAllocationRecorded: "reward_allocation.recorded";
    readonly rewardAllocationReversed: "reward_allocation.reversed";
    readonly cashObligationRecorded: "cash_obligation.recorded";
    readonly cashObligationSettled: "cash_obligation.settled";
    readonly cashObligationReversed: "cash_obligation.reversed";
    readonly conversionRecorded: "conversion.recorded";
    readonly conversionReversed: "conversion.reversed";
    readonly stakeCommitted: "stake.committed";
    readonly stakeReleased: "stake.released";
    readonly stakeForfeited: "stake.forfeited";
  };
}

// ---------------------------------------------------------------------------
// Stake escrow (NET-W010 §3.2 — challenge participation stakes)
// ---------------------------------------------------------------------------

/**
 * An EconomicStake — the explicit, escrowed commitment a challenge
 * participant posts (NET-W010 work item: "stake is committed/released
 * through provider-neutral economic commands, not by mutating
 * balances inside disputes").
 *
 * Postings (all balanced per unit, all through the posting layer's
 * conservation + non-negative guards):
 *
 * ```text
 * commit:  debit  credits(owner)        amount   credit stake_escrow(owner)  amount
 * release: debit  stake_escrow(owner)   amount   credit credits(owner)      amount
 * forfeit: debit  stake_escrow(owner)   amount   credit protocol(credits)   amount
 * ```
 *
 * The outcome (release/forfeit) is append-only lineage on the record;
 * terminal states never revert. One COMMITTED stake per purpose is
 * enforced (a purpose cannot double-post its commitment).
 */
export interface EconomicStake {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The participant whose credits are encumbered. */
  readonly ownerPersonId: string;
  /** Positive, ≤ 6 decimals, `credits` unit. */
  readonly amount: number;
  readonly unit: "credits";
  readonly state: EconomicStakeState;
  /** Why the stake exists (linkage verified by the disputes boundary). */
  readonly purpose: {
    readonly kind: EconomicStakePurposeKind;
    readonly id: string;
  };
  readonly committedAt: string;
  /** Terminal outcome lineage (append-only; set on release/forfeit). */
  readonly outcome:
    | {
        readonly disposition: "RELEASED" | "FORFEITED";
        readonly reason: string;
        readonly outcomeAt: string;
        readonly transactionId: string;
      }
    | null;
  /** The stake-commit ledger transaction. */
  readonly transactionId: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface CommitStakeInput {
  readonly organizationScopeId: string;
  readonly ownerPersonId: string;
  readonly amount: number;
  readonly purpose: { readonly kind: string; readonly id: string };
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface CommitStakeResult {
  readonly stake: EconomicStake;
  /** false when a stake with the same idempotency key already existed. */
  readonly created: boolean;
}

export interface ReleaseStakeInput {
  readonly stakeId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ForfeitStakeInput {
  readonly stakeId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface EconomicStakeRepository {
  findById(id: string): Promise<EconomicStake | null>;
  listByOrganization(
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly EconomicStake[]>;
  listByOwner(
    organizationScopeId: string,
    ownerPersonId: string,
  ): Promise<readonly EconomicStake[]>;
  findByPurpose(
    organizationScopeId: string,
    purposeKind: string,
    purposeId: string,
    states?: readonly string[],
  ): Promise<readonly EconomicStake[]>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<EconomicStake | null>;
  findByPurposeWithinTx(
    organizationScopeId: string,
    purposeKind: string,
    purposeId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly EconomicStake[]>;
  createWithinTx(
    stake: EconomicStake,
    tx: AuthorityTransaction,
  ): Promise<EconomicStake>;
  saveWithinTx(
    stake: EconomicStake,
    tx: AuthorityTransaction,
  ): Promise<EconomicStake>;
}

export interface StakeService {
  /**
   * Commit a stake: encumber `amount` credits from the owner into
   * their stake escrow (the posting layer's non-negative guard rejects
   * an over-commitment — conservation). One COMMITTED stake per
   * purpose. Commits atomically with the `stake.committed` audit
   * event.
   */
  commitStake(
    execution: ExecutionContext,
    input: CommitStakeInput,
  ): Promise<CommitStakeResult>;
  /**
   * Release a COMMITTED stake back to its owner (append-only outcome
   * lineage). Commits atomically with the `stake.released` audit
   * event.
   */
  releaseStake(
    execution: ExecutionContext,
    input: ReleaseStakeInput,
  ): Promise<EconomicStake>;
  /**
   * Forfeit a COMMITTED stake to protocol recognition (the
   * unsuccessful-challenge penalty). Commits atomically with the
   * `stake.forfeited` audit event.
   */
  forfeitStake(
    execution: ExecutionContext,
    input: ForfeitStakeInput,
  ): Promise<EconomicStake>;
  getStake(execution: ExecutionContext, id: string): Promise<EconomicStake>;
  listStakes(
    execution: ExecutionContext,
    organizationScopeId: string,
    ownerPersonId?: string,
  ): Promise<readonly EconomicStake[]>;
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  IdempotencyStore,
  EconomicAccountKind,
  EconomicCashKind,
  EconomicConversionDirection,
  EconomicEntryDirection,
  EconomicLedgerTxKind,
  EconomicMaturationPolicy,
  EconomicUnitType,
  EconomicValueSourceKind,
  EconomicValueState,
  EconomicStakeState,
  EconomicStakePurposeKind,
};
