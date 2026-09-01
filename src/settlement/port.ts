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
import type {
  IdempotencyStore,
  IdempotentApplyContext,
} from "../core/idempotency.ts";
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

/**
 * Structural view of a resolved contribution source (NET-W014). The
 * lifecycle state is the /workflows authority's field — read-only
 * here.
 */
export interface ResolvedContributionSource {
  readonly organizationScopeId: string;
  readonly state: string;
}

/**
 * EconomicContributionLookup — structural interface over the
 * contributions boundary's repository (NET-W014). A `contribution`
 * economic source qualifies ONLY when it resolves same-scope AND in
 * lifecycle state VERIFIED — the identical qualifying bar as
 * Proof-of-Value and measured-outcome sources.
 */
export interface EconomicContributionLookup {
  resolve(id: string): Promise<ResolvedContributionSource | null>;
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
  /**
   * NET-W030 (additive): in-tx transaction read. Ledger transactions
   * are immutable after creation, so a committed read can never be
   * stale — the twin exists so derived evaluations (the W030
   * reconciliation derivation) re-derive INSIDE the authoritative
   * transaction with the same discipline as every other in-tx
   * re-derivation.
   */
  findTransactionWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<EconomicLedgerTransaction | null>;
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
   * NET-W020 remediation (PR #40 review — the single authoritative
   * transaction boundary): the SAME issuance body as the standalone
   * command, executed on the CALLER'S authoritative transaction (the
   * apply context's transaction) instead of opening its own. Every
   * mutation — the dual-side issuance postings, the issuance record,
   * the source value consumption (MATURE → CONSUMED, exactly-once)
   * and the buffered audit event — stages on that transaction and
   * commits (or rolls back) WITH the caller. The standalone command
   * above is a thin wrapper: validate → serialize → apply idempotently
   * → THIS body. No compensating reversal exists on this path.
   */
  issueCreditsWithinTx(
    execution: ExecutionContext,
    input: IssueCreditsInput,
    ctx: IdempotentApplyContext,
  ): Promise<CreditIssuance>;
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
   * NET-W020 remediation (PR #40 review — the single authoritative
   * transaction boundary): the SAME allocation body as the standalone
   * command, executed on the CALLER'S authoritative transaction (the
   * apply context's transaction) instead of opening its own. Every
   * mutation — the balanced allocation postings, the allocation
   * record, the source value consumption (MATURE → CONSUMED,
   * exactly-once) and the buffered audit event — stages on that
   * transaction and commits (or rolls back) WITH the caller. The
   * standalone command above is a thin wrapper: validate → pin the
   * policy version → serialize → apply idempotently → THIS body. No
   * compensating reversal exists on this path.
   */
  allocateRewardsWithinTx(
    execution: ExecutionContext,
    input: AllocateRewardsInput,
    ctx: IdempotentApplyContext,
  ): Promise<RewardAllocation>;
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
   * NET-W020 remediation (PR #40 review — the single authoritative
   * transaction boundary): the SAME obligation body as the standalone
   * command, executed on the CALLER'S authoritative transaction (the
   * apply context's transaction) instead of opening its own. Every
   * mutation — the balanced cash postings, the obligation record and
   * the buffered audit event — stages on that transaction and commits
   * (or rolls back) WITH the caller. The standalone command above is a
   * thin wrapper: validate → serialize → apply idempotently → THIS
   * body. No compensating reversal exists on this path.
   */
  recordCashObligationWithinTx(
    execution: ExecutionContext,
    input: RecordCashObligationInput,
    ctx: IdempotentApplyContext,
  ): Promise<CashObligation>;
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
    // NET-W020 (additive): the cross-promotion clearing execution record.
    readonly crossPromotionClearingRecorded: "cross_promotion_clearing.recorded";
    // NET-W030 (additive): the external settlement fact ingestion record
    // (metadata carries the in-tx derived reconciliation verdict) and the
    // mismatch-observation event (a derived `mismatched` verdict is
    // recorded + audited — never auto-corrected).
    readonly externalSettlementFactRecorded: "external_settlement_fact.recorded";
    readonly externalSettlementMismatchObserved: "external_settlement_fact.mismatch_observed";
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

// ---------------------------------------------------------------------------
// NET-W020 — Cross-promotion clearing (issue #39).
//
// Clearing is an ORCHESTRATION/INTEGRATION concern composed at the
// bootstrap boundary; /settlement stays the SOLE economic authority.
// The CrossPromotionClearingRecord below is pure LINEAGE: it references
// the campaign/contribution/placement/value-record/draw-result and
// snapshots the DERIVED eligibility trace — it posts NOTHING itself (no
// new account kind, transaction kind or value source exists; the draws
// flow exclusively through the UNTOUCHED allocateRewards /
// issueCredits / recordCashObligation primitives). There is no second
// ledger. /workflows is COMPLETELY untouched (clearing carries no
// lifecycle subject); /inventory, /campaigns, /contributions and
// /disputes are consumed READ-ONLY through the neutral lookups below.
// ---------------------------------------------------------------------------

/**
 * ClearingContributionLookup — structural interface over the
 * contributions boundary + the W012/W013 derived states (the EXACT
 * NET-W014 recognition-bar views, read-only; domain→domain imports are
 * prohibited so the composition root wires the adapter).
 */
export interface ClearingContributionLookup {
  resolve(contributionId: string): Promise<{
    readonly organizationScopeId: string;
    readonly lifecycleState: string;
    readonly contributorPersonId: string;
    readonly proofOfHelpfulnessState: string;
    readonly moderationStatus: string;
    readonly qualityBand: string | null;
  } | null>;
}

/**
 * ClearingPlacementLookup — structural interface over the inventory
 * boundary's DERIVED settlement readiness (NET-W019 INV-004) plus the
 * placement's campaign binding and registered owner. Read-only; a
 * placement that does not resolve in the requested scope resolves to
 * null (fail-closed).
 */
export interface ClearingPlacementLookup {
  readiness(
    organizationScopeId: string,
    placementId: string,
  ): Promise<{
    readonly placementId: string;
    readonly organizationScopeId: string;
    readonly campaignId: string;
    readonly campaignPolicyVersion: number;
    readonly ownerPersonId: string;
    readonly settlementReady: boolean;
  } | null>;
}

/** One declared campaign clearing rule (read-only view). */
export interface ClearingRuleView {
  readonly id: string;
  readonly objectiveId: string;
  readonly basis: string;
  readonly drawKind: string;
  readonly rewardPolicyId: string | null;
  readonly maxDrawAmount: number;
}

/**
 * ClearingCampaignRuleLookup — structural interface over the campaigns
 * boundary (existence + tenant scope + administrative status + the
 * CURRENT policy version's declared clearing rules). Read-only;
 * /campaigns stays the campaign policy authority.
 */
export interface ClearingCampaignRuleLookup {
  resolve(campaignId: string): Promise<{
    readonly campaignId: string;
    readonly organizationScopeId: string;
    readonly administrativeStatus: string;
    readonly currentPolicyVersion: number;
    readonly clearingRules: readonly ClearingRuleView[];
  } | null>;
}

/** The risk/dispute gate view over the clearing source contexts. */
export interface ClearingGateView {
  readonly clear: boolean;
  /** "risk_control" | "active_dispute" | null (null when clear). */
  readonly source: string | null;
  readonly controlId: string | null;
  readonly disputeId: string | null;
  readonly detail: Record<string, unknown>;
}

/**
 * ClearingGateLookup — structural interface over the disputes
 * boundary's active-control registry + ACTIVE dispute registry (the
 * NET-W014 gate discipline; PENDING_STAKE disputes NEVER gate — the
 * NET-W010 griefing-resistance semantics). Read-only.
 */
export interface ClearingGateLookup {
  assess(input: {
    readonly organizationScopeId: string;
    readonly operationClass: string;
    readonly recordSubjectIds: readonly string[];
    readonly personSubjectId: string | null;
  }): Promise<ClearingGateView>;
}

/** The NET-W020 neutral lookup bundle. */
export interface ClearingLookups {
  readonly contribution: ClearingContributionLookup;
  readonly placement: ClearingPlacementLookup;
  readonly campaign: ClearingCampaignRuleLookup;
  readonly gate: ClearingGateLookup;
}

/** The campaign clearing bookkeeping input (references only). */
export interface ClearingCampaignBookkeepingInput {
  readonly campaignId: string;
  readonly clearingRuleId: string;
  readonly drawKind: string;
  readonly valueRecordId: string;
  readonly resultId: string;
  readonly amount: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

/**
 * ClearingCampaignBookkeepingPort — NET-W020 remediation (PR #40
 * review): the campaign clearing bookkeeping PARTICIPATES in the
 * clearing's SINGLE authoritative transaction. /campaigns stays the
 * bookkeeping authority — the composition root wires this adapter —
 * but the event append runs on the caller's transaction (the apply
 * context's transaction) so the campaign record, the economic draw,
 * the clearing record and the audit lineage commit TOGETHER or not
 * at all. `bookkeepingLockKey` exposes the campaign record's own
 * serialization key so the composite holds it ACROSS the transaction
 * (the campaign repository save is last-write-wins; the standalone
 * bookkeeping command serializes on the same key).
 */
export interface ClearingCampaignBookkeepingPort {
  recordClearingExecutionWithinTx(
    execution: ExecutionContext,
    input: ClearingCampaignBookkeepingInput,
    ctx: IdempotentApplyContext,
  ): Promise<{ readonly campaignId: string; readonly eventCount: number }>;
  /** The campaign record's serialization lock key. */
  bookkeepingLockKey(campaignId: string): string;
}

/**
 * ExecuteCrossPromotionClearingInput — the WHOLE clearing operation
 * as ONE exactly-once economic unit (the tenant scope is anchored by
 * the value record — the economic authority's own durable record;
 * cross-scope references fail closed).
 */
export interface ExecuteCrossPromotionClearingInput {
  readonly sourceContributionId: string;
  readonly targetPlacementId: string;
  readonly valueRecordId: string;
  readonly idempotencyKey: string;
  /** Optional explicit rule id; omitted → the single declared rule. */
  readonly clearingRuleId?: string;
  /** credit draws: credits per value unit (> 0, ≤ 6 decimals). */
  readonly creditsPerValueUnit?: number;
  /** cash draws: payable | receivable (default payable). */
  readonly cashKind?: string;
  /** cash draws: the counterparty person. */
  readonly counterpartyPersonId?: string;
  /** cash draws: the obligation amount (≤ the rule's max draw). */
  readonly cashAmount?: number;
  readonly description?: string;
}

/**
 * ExecuteCrossPromotionClearingResult — the committed composite
 * outcome (replayed verbatim on a same-key retry).
 */
export interface ExecuteCrossPromotionClearingResult {
  readonly drawKind: CrossPromotionClearingRecord["drawKind"];
  readonly clearing: CrossPromotionClearingRecord;
  /** The reward draw's allocation (reward draws only). */
  readonly allocation?: RewardAllocation;
  /** The credit draw's issuance (credit draws only). */
  readonly issuance?: CreditIssuance;
  /** The cash draw's obligation (cash draws only). */
  readonly obligation?: CashObligation;
  /** false when the idempotency key replayed the committed clearing. */
  readonly created: boolean;
  /** The value record's post-draw state (CONSUMED for consuming draws). */
  readonly value: EconomicValueRecord;
  readonly campaignEventCount: number;
}

/**
 * A CrossPromotionClearingRecord — the durable, tenant-scoped,
 * append-only execution record of ONE cross-promotion clearing (the
 * clearing COMMITMENT linking a source contribution and a target
 * placement through canonical inventory/campaign references).
 *
 * Invariants:
 *  - ONE record per (sourceContributionId, targetPlacementId): a
 *    stable CLEARING_CONFLICT otherwise (the W019 active-placement pair
 *    precedent — a cleared pair cannot be cleared again under any
 *    idempotency key);
 *  - the eligibility snapshot was RE-DERIVED inside the authoritative
 *    record transaction through the neutral lookups + the value
 *    repository (nothing caller-asserted qualifies);
 *  - the draw result was VERIFIED against the SAME domain's
 *    allocation/issuance/obligation records (same scope, same value
 *    record, kind-consistent) — a fabricated draw reference cannot be
 *    recorded;
 *  - the record posts NOTHING: `drawTransactionId` references the
 *    EXISTING primitive's ledger transaction (lineage only).
 */
export interface CrossPromotionClearingRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly campaignId: string;
  readonly campaignPolicyVersion: number;
  readonly clearingRuleId: string;
  readonly sourceContributionId: string;
  readonly targetPlacementId: string;
  readonly valueRecordId: string;
  readonly drawKind: "reward_allocation" | "credit_issuance" | "cash_obligation";
  /** The executed primitive's own result id (allocation/issuance/obligation). */
  readonly drawResultId: string;
  /** The executed primitive's ledger transaction (lineage only). */
  readonly drawTransactionId: string;
  /** The drawn amount (the primitive's own amount semantics). */
  readonly amount: number;
  /** The re-derived eligibility trace the clearing executed under. */
  readonly eligibility: {
    readonly eligible: true;
    readonly checks: readonly {
      readonly check: string;
      readonly satisfied: boolean;
      readonly reason: string;
      readonly detail: Record<string, unknown>;
    }[];
  };
  readonly status: "cleared";
  readonly clearedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RecordCrossPromotionClearingInput {
  readonly organizationScopeId: string;
  readonly sourceContributionId: string;
  readonly targetPlacementId: string;
  readonly valueRecordId: string;
  readonly clearingRuleId: string;
  readonly drawKind: string;
  readonly drawResultId: string;
  readonly idempotencyKey: string;
}

export interface RecordCrossPromotionClearingResult {
  readonly clearing: CrossPromotionClearingRecord;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface EvaluateCrossPromotionClearingInput {
  readonly organizationScopeId: string;
  readonly sourceContributionId: string;
  readonly targetPlacementId: string;
  readonly valueRecordId: string;
  /** Optional explicit rule id; omitted → the single declared rule. */
  readonly clearingRuleId?: string;
}

export interface CrossPromotionClearingRepository {
  findById(id: string): Promise<CrossPromotionClearingRecord | null>;
  listByOrganization(
    organizationScopeId: string,
  ): Promise<readonly CrossPromotionClearingRecord[]>;
  findByPair(
    organizationScopeId: string,
    sourceContributionId: string,
    targetPlacementId: string,
  ): Promise<CrossPromotionClearingRecord | null>;
  /** In-tx fresh read (the create-once pair backstop). */
  findByPairWithinTx(
    organizationScopeId: string,
    sourceContributionId: string,
    targetPlacementId: string,
    tx: AuthorityTransaction,
  ): Promise<CrossPromotionClearingRecord | null>;
  createWithinTx(
    clearing: CrossPromotionClearingRecord,
    tx: AuthorityTransaction,
  ): Promise<CrossPromotionClearingRecord>;
}

export interface CrossPromotionClearingService {
  /**
   * THE ATOMIC CLEARING OPERATION (NET-W020 remediation, PR #40
   * review): qualify → risk/dispute gate → draw → clearing record →
   * campaign bookkeeping as ONE exactly-once economic unit inside ONE
   * authoritative transaction:
   *
   * ```text
   * pair mutex → campaign bookkeeping lock → economic account locks
   *   → IdempotencyStore.applyIdempotent(key)
   *       → SINGLE AuthorityTransaction
   *           ├── in-tx fresh value read (tenant anchor)
   *           ├── in-tx hard gates (RISK_CONTROL / DISPUTE_CHALLENGE)
   *           ├── in-tx eligibility re-derivation (the authoritative bar)
   *           ├── the draw WITHIN THE SAME TX (posting + issuance/
   *           │   obligation record + exactly-once value consumption)
   *           ├── the clearing record (re-derives eligibility +
   *           │   verifies the staged draw result in-tx)
   *           ├── the campaign clearing bookkeeping (same tx)
   *           └── the buffered audit lineage (same tx)
   *       COMMIT — everything durable together, or NOTHING
   * ```
   *
   * A failed authoritative COMMIT therefore leaves NO partial
   * economic mutation — no ledger entries, no allocation/issuance/
   * obligation, no value consumption, no clearing record, no campaign
   * event, no audit event — and a retry with the same idempotency key
   * re-executes the whole unit exactly once. No compensating
   * reversal exists on this path.
   */
  executeCrossPromotionClearing(
    execution: ExecutionContext,
    input: ExecuteCrossPromotionClearingInput,
  ): Promise<ExecuteCrossPromotionClearingResult>;
  /**
   * THE DERIVED ELIGIBILITY VIEW (AC-02): re-derived from CURRENT
   * authoritative records on every read — the qualified source
   * contribution (the W014 bar), the settlement-ready target placement
   * (the W019 gate) bound to the clearing campaign, the ACTIVE
   * campaign's current clearing rules, the clearable value record with
   * the contribution in its lineage, and the risk/dispute gate. There
   * is NO command that asserts, stores or waives eligibility; callers
   * can only REFERENCE records.
   */
  evaluateClearingEligibility(
    execution: ExecutionContext,
    input: EvaluateCrossPromotionClearingInput,
  ): Promise<{
    readonly organizationScopeId: string;
    readonly sourceContributionId: string;
    readonly targetPlacementId: string;
    readonly valueRecordId: string;
    readonly eligible: boolean;
    readonly checks: readonly {
      readonly check: string;
      readonly satisfied: boolean;
      readonly reason: string;
      readonly detail: Record<string, unknown>;
    }[];
    readonly resolvedRule: ClearingRuleView | null;
    readonly evaluatedAt: string;
  }>;
  /**
   * The AUTHORITATIVE record command (AC-03/04/07): serialized under
   * the advisory pair mutex, applied idempotently in ONE authoritative
   * transaction that RE-DERIVES the full eligibility in-tx, VERIFIES
   * the draw result against the same domain's allocation/issuance/
   * obligation records, enforces the create-once pair constraint and
   * commits the `cross_promotion_clearing.recorded` audit event
   * binding campaign + contribution + placement + clearing record +
   * idempotency record + authoritative transaction + draw transaction.
   */
  recordCrossPromotionClearing(
    execution: ExecutionContext,
    input: RecordCrossPromotionClearingInput,
  ): Promise<RecordCrossPromotionClearingResult>;
  /**
   * The SAME record body the standalone command commits, executed on
   * the CALLER'S authoritative transaction (NET-W020 remediation):
   * the in-tx eligibility re-derivation, the staged draw-result
   * verification, the create-once pair check, the record create and
   * the audit buffer — all on the apply context's transaction. The
   * atomic clearing operation above invokes THIS body between the
   * draw and the campaign bookkeeping so the record commits in the
   * SAME transaction as the economic mutation it verifies.
   */
  recordCrossPromotionClearingWithinTx(
    execution: ExecutionContext,
    input: RecordCrossPromotionClearingInput,
    ctx: IdempotentApplyContext,
  ): Promise<CrossPromotionClearingRecord>;
  /** Tenant-scoped reads (cross-scope = NotFoundError). */
  getCrossPromotionClearing(
    execution: ExecutionContext,
    organizationScopeId: string,
    clearingId: string,
  ): Promise<CrossPromotionClearingRecord>;
  listCrossPromotionClearings(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly CrossPromotionClearingRecord[]>;
}

export interface CrossPromotionClearingServiceDeps {
  readonly clearingRepository: CrossPromotionClearingRepository;
  readonly valueRepository: EconomicValueRepository;
  readonly allocationRepository: RewardAllocationRepository;
  readonly issuanceRepository: CreditIssuanceRepository;
  readonly obligationRepository: CashObligationRepository;
  readonly lookups: ClearingLookups;
  /**
   * NET-W020 remediation (PR #40 review): the draw primitives run
   * WITHIN the clearing's single authoritative transaction through
   * their same-domain `...WithinTx` forms (never the transaction-
   * owning commands).
   */
  readonly rewardService: RewardService;
  readonly creditService: CreditService;
  readonly cashService: CashService;
  /** Pins the reward policy version for the draw's lock set (committed reads). */
  readonly rewardPolicyRepository: RewardAllocationPolicyRepository;
  /** The campaign clearing bookkeeping (participates in the same tx). */
  readonly campaignBookkeeping: ClearingCampaignBookkeepingPort;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// NET-W030 — External settlement adapters (issue #61).
//
// The settlement boundary EXTENDED (additive — never a rewrite) with
// the external-settlement FACT layer: external payment/settlement
// transactions arrive as AUTHENTICATED, IDEMPOTENT, append-only FACTS
// recorded INSIDE this boundary (SETTLE-001..003, ADAPTER-008;
// architecture-lock §14 invariant 25: "payment adapters provide
// transaction facts; `/settlement` retains semantic authority").
//
//   /settlement  = the SOLE economic authority (W008/W014/W020
//                  primitives are the ONLY economic commands —
//                  unchanged; an external fact can NEVER mint,
//                  consume, reverse or mutate internal value)
//   /adapters    = provider-specific payload parsing (the W023
//                  discipline: concrete adapters under
//                  src/adapters/settlement/ implement the NEUTRAL
//                  contract declared here STRUCTURALLY — the adapter
//                  tier may not import this boundary; the
//                  composition root is the ONLY join)
//   this layer   = authenticated + fail-closed ingestion, exactly-once
//                  fact recording, DERIVED deterministic
//                  reconciliation (matched / pending / mismatched
//                  with machine-readable reasons — never
//                  auto-corrected), traceability in both directions
//
// Reconciliation is DERIVED on every evaluation (the W020
// evaluateClearingEligibility discipline): there is NO command that
// asserts, stores or waives a reconciliation verdict, and NO stored
// reconciliation lifecycle. Facts are immutable after recording;
// corrections are NEW fact records referencing the corrected one.
// ---------------------------------------------------------------------------

/** The record format marker for NET-W030 external settlement facts. */
export const EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT = "NET-W030:1" as const;

/**
 * The CLOSED, VERSIONED external-settlement provider vocabulary
 * (work order §3.1). `reference` is the provider-neutral reference
 * implementation adapter (src/adapters/settlement/); a concrete
 * payment-network integration is a NEW vocabulary entry, never an
 * in-place rewrite. Adapters re-assert their own provider identity on
 * every normalization (provider-identity spoofing guard — the W023
 * discipline).
 */
export const EXTERNAL_SETTLEMENT_PROVIDERS = ["reference"] as const;

export type ExternalSettlementProvider =
  (typeof EXTERNAL_SETTLEMENT_PROVIDERS)[number];

export function isExternalSettlementProvider(
  value: string,
): value is ExternalSettlementProvider {
  return (EXTERNAL_SETTLEMENT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The CLOSED, VERSIONED integrity-envelope algorithm vocabulary. The
 * trust envelope is provider-NEUTRAL HMAC-SHA256 over the canonical
 * submission facts — the same primitive family as the W022/W023
 * authenticated channels. Verification material resolves ONLY
 * through the SecretProvider at the composition root.
 */
export const EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS = [
  "hmac-sha256/v1",
] as const;

export type ExternalSettlementIntegrityAlgorithm =
  (typeof EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS)[number];

export function isExternalSettlementIntegrityAlgorithm(
  value: string,
): value is ExternalSettlementIntegrityAlgorithm {
  return (EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS as readonly string[]).includes(
    value,
  );
}

/**
 * Freshness window for adapter-delivered observations (work order
 * §3.2: "unauthenticated, stale, malformed or unverifiable
 * submissions fail closed"). An observation older than this window
 * is STALE and is never recorded; `observedAt` is the
 * provider-attested observation time (the W023 freshness semantics —
 * an absent/unparseable observedAt fails closed as malformed).
 */
export const EXTERNAL_SETTLEMENT_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * The CLOSED ingestion-rejection reason vocabulary (machine-readable;
 * work order §3.2). Every failed ingestion surfaces EXACTLY one of
 * these reasons in the error context — never a payload value, secret
 * or signature (PRIV-002).
 */
export const EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS = [
  "unsupported_provider",
  "unsupported_algorithm",
  "malformed_submission",
  "unauthenticated",
  "stale",
  "conflicting_fact",
  "correction_target_not_found",
] as const;

export type ExternalSettlementRejectionReason =
  (typeof EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS)[number];

/**
 * The CLOSED reconciliation-verdict vocabulary (work order §3.3):
 * `matched` (the recorded fact's attested amount agrees with the
 * internal ledger lineage per unit), `pending` (the internal lineage
 * does not resolve — recorded yet or out-of-scope, indistinguishable
 * by design), `mismatched` (the lineage resolves and disagrees). The
 * verdict is DERIVED server-side; a mismatch is recorded + audited,
 * never auto-corrected.
 */
export const EXTERNAL_SETTLEMENT_RECONCILIATION_VERDICTS = [
  "matched",
  "pending",
  "mismatched",
] as const;

export type ExternalSettlementReconciliationVerdict =
  (typeof EXTERNAL_SETTLEMENT_RECONCILIATION_VERDICTS)[number];

/**
 * The CLOSED reconciliation reason vocabulary (machine-readable;
 * pinned exactly by the NET-W030 AC-08 regression).
 */
export const EXTERNAL_SETTLEMENT_RECONCILIATION_REASONS = [
  "internal_lineage_not_found",
  "amount_matched",
  "amount_mismatched",
  "unit_absent_in_lineage",
] as const;

export type ExternalSettlementReconciliationReason =
  (typeof EXTERNAL_SETTLEMENT_RECONCILIATION_REASONS)[number];

/**
 * The provider's trust envelope over the EXACT attested submission
 * facts: algorithm (closed vocabulary), hex HMAC-SHA256 signature,
 * and the envelope's signing time. The envelope attests the
 * canonical facts {provider, externalId, internalTransactionId,
 * reportedAmount, reportedUnit, observedAt, correctionOf} — NEVER a
 * secret or internal material (PRIV-002: the signature and key
 * material never appear in logs, audit events, or error contexts).
 */
export interface ExternalSettlementIntegrityBlock {
  readonly algorithm: string;
  readonly signature: string;
  readonly signedAt: string;
}

/**
 * The neutral, adapter-normalized external transaction facts (the
 * adapter tier's OUTPUT). `reportedAmount`/`reportedUnit` are AS
 * REPORTED BY THE PROVIDER — a transaction fact, NEVER authority:
 * the authoritative amount is the ledger entries of the referenced
 * internal transaction. `observedAt` is the provider-attested
 * observation time; `correctionOf` is the append-only correction
 * linkage (a NEW fact record referencing the corrected one — facts
 * are immutable after recording).
 */
export interface ExternalSettlementTransactionFacts {
  readonly provider: string;
  readonly providerVersion: string;
  readonly externalId: string;
  readonly internalTransactionId: string;
  readonly reportedAmount: number;
  readonly reportedUnit: string;
  readonly observedAt: string;
  readonly correctionOf: string | null;
  readonly integrity: ExternalSettlementIntegrityBlock;
}

/** The raw provider submission routed to an adapter by provider id. */
export interface RawExternalSettlementSubmission {
  readonly providerId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The NEUTRAL external-settlement adapter contract (work order §2):
 * provider-specific payload parsing ONLY. Declared HERE (the
 * consuming domain's port — the W029 composition-root crypto
 * discipline); concrete adapters under src/adapters/settlement/
 * implement it STRUCTURALLY without importing this boundary (the
 * tier matrix forbids adapter→domain); the composition root is the
 * ONLY join. An adapter performs NO I/O, NO mutation and NO
 * authentication (the trust envelope is verified downstream against
 * SecretProvider-resolved material).
 */
export interface ExternalSettlementProviderAdapter {
  readonly info: {
    readonly kind: "external_settlement";
    readonly provider: string;
    readonly version: string;
  };
  initialize(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  /**
   * Normalize ONE raw provider submission into the neutral facts.
   * The adapter MUST re-assert its own provider identity (a
   * submission addressed to another provider never normalizes here)
   * and MUST NOT trust the payload for routing decisions.
   */
  normalizeTransaction(
    submission: RawExternalSettlementSubmission,
  ): Promise<ExternalSettlementTransactionFacts>;
}

/**
 * ExternalSettlementAuthenticator — the injected verifier of the
 * provider trust envelope. The REAL implementation (HMAC-SHA256,
 * timing-safe comparison) is constructed ONLY in the composition
 * root with per-provider material resolved exclusively through the
 * SecretProvider (the W029 construction-root crypto discipline).
 * PURE and NON-THROWING: `false` means the submission is
 * UNAUTHENTICATED and ingestion fails closed (never silently
 * recorded). No key material ever crosses this interface.
 */
export interface ExternalSettlementAuthenticator {
  verify(
    submission: {
      readonly provider: string;
      readonly externalId: string;
      readonly internalTransactionId: string;
      readonly reportedAmount: number;
      readonly reportedUnit: string;
      readonly observedAt: string;
      readonly correctionOf: string | null;
      readonly integrity: ExternalSettlementIntegrityBlock;
    },
  ): boolean;
}

/**
 * An ExternalSettlementFactRecord — a first-class, append-only,
 * immutable-after-recording external settlement transaction fact
 * (work order §3.1). Recording is idempotent per (organization
 * scope, provider, external id); the identity is EXACTLY-ONCE (a
 * second submission of the same identity with the same substance
 * replays the committed record; a different substance is a
 * CONFLICT — never a second record, never a mutation).
 *
 * The record carries the provider's REPORTED amount — a fact, not
 * authority. It posts NO ledger entries, touches NO account, mints/
 * consumes/reverses NOTHING: the only economic primitives remain the
 * EXISTING /settlement commands (architecture-lock §14 invariant
 * 25). Reconciliation verdicts are DERIVED from the referenced
 * internal ledger lineage on every evaluation — never stored here.
 */
export interface ExternalSettlementFactRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The delivering provider (closed vocabulary). */
  readonly provider: string;
  /** The delivering adapter's declared version (bookkeeping). */
  readonly providerVersion: string;
  /** The provider's canonical external transaction id. */
  readonly externalId: string;
  /** The internal ledger transaction lineage the fact attests to. */
  readonly internalTransactionId: string;
  /** Positive, ≤ 6 decimals, AS REPORTED — never authority. */
  readonly reportedAmount: number;
  readonly reportedUnit: EconomicUnitType;
  /** The provider-attested observation time (ISO-8601). */
  readonly observedAt: string;
  /** The recording time (ISO-8601). */
  readonly recordedAt: string;
  /** Append-only correction linkage (the corrected fact's id). */
  readonly correctionOf: string | null;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordFormat: string;
}

export interface ExternalSettlementFactRepository {
  findById(id: string): Promise<ExternalSettlementFactRecord | null>;
  /** In-tx twin (immutability makes committed reads sound; the twin keeps the discipline). */
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ExternalSettlementFactRecord | null>;
  /** The exactly-once identity lookup (organization scope, provider, external id). */
  findByIdentity(
    organizationScopeId: string,
    provider: string,
    externalId: string,
  ): Promise<ExternalSettlementFactRecord | null>;
  /** In-tx twin — the create-once identity backstop inside the authoritative transaction. */
  findByIdentityWithinTx(
    organizationScopeId: string,
    provider: string,
    externalId: string,
    tx: AuthorityTransaction,
  ): Promise<ExternalSettlementFactRecord | null>;
  /** Ordered listing for a tenant (recordedAt, id). */
  listByOrganization(
    organizationScopeId: string,
  ): Promise<readonly ExternalSettlementFactRecord[]>;
  /** Reverse traceability: every fact referencing an internal transaction. */
  listByInternalTransaction(
    organizationScopeId: string,
    internalTransactionId: string,
  ): Promise<readonly ExternalSettlementFactRecord[]>;
  /**
   * Create-once (immutable facts): there is NO save/update — a fact
   * record can never be rewritten after recording. Corrections are
   * NEW records.
   */
  createWithinTx(
    record: ExternalSettlementFactRecord,
    tx: AuthorityTransaction,
  ): Promise<ExternalSettlementFactRecord>;
}

/** One machine-readable reconciliation check outcome (work order §3.3). */
export interface ExternalSettlementReconciliationCheck {
  readonly check: string;
  readonly satisfied: boolean;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * The DERIVED reconciliation verdict for ONE recorded fact (work
 * order §3.3). Deterministic and server-side: re-derived from the
 * CURRENT authoritative ledger lineage + the recorded fact on every
 * evaluation — never stored, never asserted by a command. The
 * resolved internal transaction is included for forward
 * traceability; `internalTransaction` is null when the lineage does
 * not resolve in the requesting tenant's scope (recorded-yet and
 * cross-scope are indistinguishable — no existence oracle).
 */
export interface ExternalSettlementReconciliationView {
  readonly factId: string;
  readonly organizationScopeId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly internalTransactionId: string;
  readonly verdict: "matched" | "pending" | "mismatched";
  readonly reason: string;
  readonly checks: readonly ExternalSettlementReconciliationCheck[];
  readonly internalTransaction: {
    readonly id: string;
    readonly kind: string;
    readonly recordedAt: string;
    /** The derived per-unit debit total of the referenced transaction. */
    readonly unitAmount: number;
  } | null;
  readonly derivedAt: string;
}

export interface RecordExternalSettlementFactInput {
  readonly organizationScopeId: string;
  /** The delivering provider (closed vocabulary — routing). */
  readonly provider: string;
  /** The raw provider notification payload (opaque to the transport). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface RecordExternalSettlementFactResult {
  readonly fact: ExternalSettlementFactRecord;
  /** false when the identity replayed the committed record. */
  readonly created: boolean;
  /** The in-tx derived reconciliation at recording time (audited with the fact). */
  readonly reconciliation: ExternalSettlementReconciliationView;
}

export interface ExternalSettlementService {
  /**
   * THE authenticated ingestion + fact recording command (work order
   * §3.1/§3.2): route to the provider's adapter → normalize →
   * validate the closed vocabularies and shapes → verify the trust
   * envelope (injected authenticator — SecretProvider material,
   * fail closed) → enforce freshness → serialize on the
   * organization-scoped identity mutex → apply idempotently in ONE
   * authoritative transaction (the create-once identity backstop,
   * the correction-target resolution, the in-tx reconciliation
   * derivation, the record create and the transactional audit
   * buffer — all on the apply context's transaction). A failure of
   * ANY gate fails closed BEFORE anything is recorded. The command
   * posts NO ledger entries and mutates NO economic state — an
   * external fact is a FACT, never authority.
   */
  recordExternalSettlementFact(
    execution: ExecutionContext,
    input: RecordExternalSettlementFactInput,
  ): Promise<RecordExternalSettlementFactResult>;
  /**
   * Tenant-scoped read (cross-tenant and nonexistent are
   * indistinguishable — null; no existence oracle).
   */
  getExternalSettlementFact(
    execution: ExecutionContext,
    organizationScopeId: string,
    factId: string,
  ): Promise<ExternalSettlementFactRecord | null>;
  /** Tenant-scoped listing (recordedAt, id order). */
  listExternalSettlementFacts(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly ExternalSettlementFactRecord[]>;
  /** Reverse traceability: facts referencing an internal transaction (tenant-scoped). */
  listExternalSettlementFactsByTransaction(
    execution: ExecutionContext,
    organizationScopeId: string,
    internalTransactionId: string,
  ): Promise<readonly ExternalSettlementFactRecord[]>;
  /**
   * THE DERIVED RECONCILIATION VIEW (work order §3.3): re-derived
   * from CURRENT authoritative records on every evaluation. There is
   * NO command that asserts, stores or waives a verdict; a mismatch
   * is recorded + audited (the mismatch-observation audit event),
   * never auto-corrected.
   */
  evaluateExternalSettlementReconciliation(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly factId: string;
    },
  ): Promise<ExternalSettlementReconciliationView>;
}

export interface ExternalSettlementServiceDeps {
  readonly repository: ExternalSettlementFactRepository;
  readonly ledgerRepository: EconomicLedgerRepository;
  /** The neutral adapter list (wired at the composition root ONLY). */
  readonly adapters: readonly ExternalSettlementProviderAdapter[];
  /** The trust-envelope verifier (composition root, SecretProvider material). */
  readonly authenticator: ExternalSettlementAuthenticator;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    debug(message: string, fields?: Record<string, unknown>): void;
  };
  /**
   * Injectable clock for the freshness gate (defaults to Date.now).
   * Freshness governs recording authority, so the gate must be
   * testable-injectable (deterministic AC evidence).
   */
  readonly now?: () => number;
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  PostgresAuthority,
  TransactionalAuditWriter,
  IdempotencyStore,
  IdempotentApplyContext,
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
