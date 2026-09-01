/**
 * Demand boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/demand`, `/benefits` own demand aggregation and benefit
 * allocation), §7 (the frozen sixteen core domains); §9 (Demand
 * architecture — individual commercial terms remain private);
 * spec/architecture-lock.md §2 (the frozen domain list — `/demand`
 * was FROZEN from NET-W001; NET-W024 implements INSIDE it and adds
 * NO 17th domain), §5 (economic authority — untouched), §6 (privacy
 * authority — aggregate evidence, never raw personal data).
 *
 * Work order ref: spec/work-orders/NET-W024.md
 * Requirements: DEM-001..003 (consumer demand pools,
 * privacy-preserving aggregation, qualified-aggregate exposure for
 * competing suppliers — offers/selection are NET-W025/W026).
 *
 * AUTHORITY MODEL (work order §2 — the decision of record):
 *  - `/demand` owns the demand POOL and COMMITMENT records (material
 *    mutations flow exclusively through the IdempotencyStore's
 *    authoritative transactions), the versioned provider-neutral
 *    category/attribute vocabulary (src/core/demand.ts), and the
 *    DERIVED privacy-preserving aggregate/qualification view;
 *  - `/settlement` stays the economic authority: there is NO economic
 *    mutation surface in this boundary (no balances, no postings, no
 *    reward/credit/cash commands, no value records). Demand
 *    commitments mint nothing and settle nothing (DEM-003 exposes
 *    qualified aggregate demand ONLY — supplier competition on it is
 *    NET-W025/W026);
 *  - `/identity`, `/organizations`, `/participants` stay the
 *    membership/authorization authorities: pool/commitment
 *    authorization and consent are enforced server-side; organization
 *    membership resolves READ-ONLY through the neutral
 *    {@link DemandMembershipLookup} (the dependency-inversion
 *    precedent — this port imports core contracts only, and the
 *    bootstrap composition root wires the thin adapter over the
 *    /organizations membership repository);
 *  - `/workflows` stays the SOLE lifecycle authority and is UNTOUCHED:
 *    pools and commitments carry NO lifecycle subject kind, NO
 *    transition table, NO state machine. Pool closure and commitment
 *    withdrawal are ONE-WAY field mutations (the NET-W019 retirement
 *    precedent);
 *  - NO AI path exists anywhere in this surface (work order §2).
 */

import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { Logger } from "../core/logger.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  DemandBudgetBand,
  DemandCategoryKey,
  DemandRegionCode,
} from "../core/demand.ts";
import type {
  ProcurementBudgetBand,
  ProcurementCategoryKey,
  ProcurementQuantityBucket,
  ProcurementRegionCode,
  ProcurementTimingWindow,
  ProcurementUnitPriceBand,
} from "../core/procurement.ts";
import type { SupplierOfferConsentScope } from "../core/procurement-offer.ts";
import type { BaselineKind, MeasurementProvenance } from "../core/measurement.ts";
import type { ConfidenceEstimate } from "../core/evidence.ts";
import type { ProcurementBaselineMethod } from "../core/procurement-savings.ts";

// ---------------------------------------------------------------------------
// NET-W024 records
// ---------------------------------------------------------------------------

/**
 * The server-written consent grant on a demand commitment: the
 * consumer's explicit, versioned consent to AGGREGATE-ONLY disclosure
 * (the only closed consent scope in NET-W024 — there is no
 * individual-disclosure vocabulary, so no caller assertion can
 * fabricate individual exposure). The input may only NAME the scope;
 * the grant (who + when + version) is recorded by the server from the
 * server-resolved acting person (DEM-002 / PRIV-003).
 */
export interface DemandConsentGrant {
  readonly scope: "aggregate_disclosure";
  readonly version: string;
  readonly grantedAt: string;
  /** The server-resolved consumer (the acting person). */
  readonly grantedBy: string;
}

/**
 * A DemandPool — the first-class, durable, tenant-scoped record of
 * aggregated consumer demand (DEM-001; invariant 1): a named pool in
 * one demand category with an explicit, versioned qualification
 * policy. The acting person at creation BECOMES the pool creator
 * (there is no creatorPersonId INPUT on any command, so a caller
 * cannot fabricate pool ownership).
 *
 * The record is STATIC after creation except the one-way closure
 * (`closedAt`) — creator-only, audited. A closed pool accepts no new
 * commitments and never qualifies (derived).
 */
export interface DemandPool {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The pool creator — the acting person at creation. */
  readonly createdBy: string;
  readonly name: string;
  readonly categoryKey: DemandCategoryKey;
  readonly categoryVersion: string;
  /**
   * The explicit, versioned qualification policy: the threshold the
   * DERIVED evaluation compares the active commitment count against.
   * Recorded once at creation; only ever re-evaluated, never
   * caller-asserted per evaluation.
   */
  readonly policy: {
    readonly version: number;
    readonly minimumCommitments: number;
  };
  /** One-way closure (null while the pool is open). */
  readonly closedAt: string | null;
  readonly closureReason: string | null;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * A DemandCommitment — the first-class, durable, tenant-scoped record
 * of one consumer's private demand commitment (DEM-001; invariant 1):
 * a bounded, provider-neutral attribute set inside one pool's
 * category, with the SERVER-WRITTEN aggregate-disclosure consent
 * grant and full execution provenance. The acting person at creation
 * BECOMES the consumer (there is no consumerPersonId INPUT on any
 * command, so a caller cannot fabricate demand membership).
 *
 * The record is STATIC after creation except the one-way withdrawal
 * (`withdrawnAt`) — consumer-only, audited. ONE ACTIVE (non-withdrawn)
 * commitment per (pool, consumer) — a stable conflict otherwise; a
 * withdrawn commitment never blocks re-commitment.
 */
export interface DemandCommitment {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  /** The consumer — the acting person at submission. */
  readonly consumerPersonId: string;
  /** The category snapshot (the pool's category at submission). */
  readonly categoryKey: DemandCategoryKey;
  readonly categoryVersion: string;
  /** The bounded, provider-neutral declared demand attributes. */
  readonly attributes: {
    readonly region: DemandRegionCode;
    readonly quantity: number;
    readonly budgetBand: DemandBudgetBand | null;
  };
  /** The server-written aggregate-disclosure consent grant. */
  readonly consent: DemandConsentGrant;
  /** One-way withdrawal (null while the commitment is active). */
  readonly withdrawnAt: string | null;
  readonly withdrawalReason: string | null;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W024 inputs / results
// ---------------------------------------------------------------------------

export interface CreateDemandPoolInput {
  readonly organizationScopeId: string;
  readonly name: string;
  readonly categoryKey: string;
  readonly qualificationPolicy: {
    readonly minimumCommitments: number;
  };
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO creatorPersonId input — the pool
  // creator is the acting person, server-resolved (a caller cannot
  // fabricate pool ownership).
}

export interface CreateDemandPoolResult {
  readonly pool: DemandPool;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface CloseDemandPoolInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

export interface CreateDemandCommitmentInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly attributes: {
    readonly region: string;
    readonly quantity: number;
    readonly budgetBand?: string | null;
  };
  /**
   * The consumer may only NAME the closed consent scope
   * ("aggregate_disclosure"); the grant itself (who + when + version)
   * is server-written. Any other scope value fails closed.
   */
  readonly consent: {
    readonly scope: string;
  };
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO consumerPersonId input — the
  // consumer is the acting person, server-resolved (a caller cannot
  // fabricate demand membership; invariant 2).
}

export interface CreateDemandCommitmentResult {
  readonly commitment: DemandCommitment;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface WithdrawDemandCommitmentInput {
  readonly organizationScopeId: string;
  readonly commitmentId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// The DERIVED qualified aggregate (DEM-002/003 — never stored, never
// caller-asserted)
// ---------------------------------------------------------------------------

/**
 * One qualification/privacy check of the derived aggregate view
 * (machine-readable; issue #48 invariant 3). Every check re-derives
 * from CURRENT durable records on every evaluation.
 */
export interface DemandAggregateCheck {
  readonly check:
    | "pool_open"
    | "requestor_membership"
    | "commitments_present"
    | "privacy_floor_met"
    | "qualification_threshold_met";
  readonly satisfied: boolean;
  /** Deterministic machine-readable detail (no commitment counts below the privacy floor). */
  readonly detail: Record<string, unknown>;
}

/**
 * One named, above-floor distribution group of the aggregate facts
 * (a region code, a budget band or a quantity bucket with its
 * commitment count). Below-floor groups are NEVER named — they fold
 * into `suppressedGroups`.
 */
export interface DemandDistributionGroup {
  readonly group: string;
  readonly count: number;
}

/**
 * The minimized aggregate facts (DEM-002): counts and bounded
 * distributions ONLY — no consumer person ids, no commitment ids, no
 * exact per-person quantities, no per-commitment timestamps. Emitted
 * ONLY when the frozen privacy floor is met AND the requestor is an
 * active organization member.
 */
export interface DemandAggregateFacts {
  readonly commitmentCount: number;
  readonly quantityBuckets: readonly DemandDistributionGroup[];
  readonly regionGroups: readonly DemandDistributionGroup[];
  readonly budgetBandGroups: readonly DemandDistributionGroup[];
  /** The COUNT of non-empty below-floor groups (never named). */
  readonly suppressedGroups: number;
}

/**
 * The DERIVED qualified aggregate demand view (DEM-002/003 / AC-02/03):
 * the privacy-preserving supplier-facing product of one demand pool —
 * a PURE derivation over (the durable pool, the CURRENT active
 * commitments, the requestor's membership) at ONE explicit evaluation
 * anchor. There is NO command that asserts, stores or waives
 * qualification: `qualified` is true iff every check passes, the
 * aggregate facts exist only above the frozen privacy floor, and
 * `/settlement` remains the economic authority (this boundary
 * carries no economic surface at all).
 */
export interface QualifiedDemandAggregate {
  readonly poolId: string;
  readonly organizationScopeId: string;
  readonly category: {
    readonly key: DemandCategoryKey;
    readonly version: string;
  };
  readonly policy: {
    readonly version: number;
    readonly minimumCommitments: number;
  };
  readonly qualified: boolean;
  readonly checks: readonly DemandAggregateCheck[];
  /**
   * The minimized aggregate facts — null unless the frozen privacy
   * floor is met AND the requestor is an active member. When null,
   * even the commitment count is suppressed.
   */
  readonly aggregate: DemandAggregateFacts | null;
  /**
   * The deterministic digest over the canonical serialization of the
   * decision facts (checks + aggregate + policy + category + pool) —
   * EXCLUDING the evaluation anchor, so identical commitment state
   * yields the identical digest across evaluations. Reproducibility
   * evidence (DEM-002 determinism; the W021 decision-digest
   * precedent).
   */
  readonly digest: string;
  /** The explicit evaluation anchor (recorded, never digested). */
  readonly evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// NET-W024 neutral cross-domain lookup (composition-root wired)
// ---------------------------------------------------------------------------

/**
 * The organization membership read for demand authorization/consent
 * (the NET-W018/W019 neutral-lookup precedent): existence + tenant
 * scope + status, resolved READ-ONLY over the /organizations
 * boundary. The demand boundary only VALIDATES membership through
 * this view — it never fabricates membership or consent (a
 * non-member or unknown person resolves to null/revoked and fails
 * closed; no existence oracle beyond the tenant the caller already
 * holds).
 */
export interface DemandMembershipLookup {
  resolveMembership(
    personId: string,
    organizationScopeId: string,
  ): Promise<"active" | "revoked" | null>;
}

// ---------------------------------------------------------------------------
// NET-W024 repositories
// ---------------------------------------------------------------------------

export interface DemandPoolRepository {
  save(
    pool: DemandPool,
    execution: ExecutionContext,
  ): Promise<DemandPool>;
  findById(id: string): Promise<DemandPool | null>;
  createWithinTx(
    pool: DemandPool,
    tx: AuthorityTransaction,
  ): Promise<DemandPool>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<DemandPool | null>;
  /**
   * One-way pool closure (in-tx with the closure audit event): an
   * already-closed pool is returned unchanged.
   */
  closeWithinTx(
    poolId: string,
    closedAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<DemandPool>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly categoryKey?: string;
      readonly closed?: boolean;
    },
  ): Promise<readonly DemandPool[]>;
}

export interface DemandCommitmentRepository {
  save(
    commitment: DemandCommitment,
    execution: ExecutionContext,
  ): Promise<DemandCommitment>;
  findById(id: string): Promise<DemandCommitment | null>;
  createWithinTx(
    commitment: DemandCommitment,
    tx: AuthorityTransaction,
  ): Promise<DemandCommitment>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<DemandCommitment | null>;
  /**
   * In-tx active-commitment lookup for the create-once constraint
   * (one NON-WITHDRAWN commitment per (pool, consumer) — a withdrawn
   * commitment never blocks re-commitment).
   */
  findActiveByPoolAndConsumerWithinTx(
    organizationScopeId: string,
    poolId: string,
    consumerPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<DemandCommitment | null>;
  /**
   * One-way commitment withdrawal (in-tx with the withdrawal audit
   * event): an already-withdrawn commitment is returned unchanged.
   */
  withdrawWithinTx(
    commitmentId: string,
    withdrawnAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<DemandCommitment>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly consumerPersonId?: string;
      readonly withdrawn?: boolean;
    },
  ): Promise<readonly DemandCommitment[]>;
  /**
   * The active (non-withdrawn) commitments of one pool — the
   * authoritative input of the derived aggregate view (committed
   * reads; deterministically ordered by the service).
   */
  listActiveByPool(poolId: string): Promise<readonly DemandCommitment[]>;
}

// ---------------------------------------------------------------------------
// The NET-W024 demand domain service
// ---------------------------------------------------------------------------

export interface DemandService {
  /**
   * Create a demand pool (DEM-001): the acting person BECOMES the
   * pool creator (there is no creatorPersonId input — ownership
   * cannot be fabricated). Requires ACTIVE organization membership
   * (server-resolved through the neutral lookup). Validates the
   * closed category vocabulary, the bounded name and the bounded
   * qualification policy. Commits atomically with the
   * `demand_pool.created` audit event.
   */
  createDemandPool(
    execution: ExecutionContext,
    input: CreateDemandPoolInput,
  ): Promise<CreateDemandPoolResult>;
  /**
   * Close the pool (one-way, creator-only; the conservative
   * direction): a closed pool accepts no new commitments and never
   * qualifies (derived). Commits atomically with the
   * `demand_pool.closed` audit event.
   */
  closeDemandPool(
    execution: ExecutionContext,
    input: CloseDemandPoolInput,
  ): Promise<DemandPool>;
  /**
   * Record a consumer demand commitment (DEM-001): the acting person
   * BECOMES the consumer (there is no consumerPersonId input — demand
   * membership cannot be fabricated) and MUST hold ACTIVE
   * organization membership (server-enforced). The pool must resolve
   * in tenant scope and be open. The consent grant is SERVER-WRITTEN
   * (the input may only name the closed "aggregate_disclosure"
   * scope). ONE ACTIVE commitment per (pool, consumer) — a stable
   * conflict otherwise. Serialized by the per-pool lock so the
   * derived count conserves under concurrency. Commits atomically
   * with the `demand_commitment.recorded` audit event.
   */
  createDemandCommitment(
    execution: ExecutionContext,
    input: CreateDemandCommitmentInput,
  ): Promise<CreateDemandCommitmentResult>;
  /**
   * Withdraw the commitment (one-way, consumer-only — the consent
   * revocation): a withdrawn commitment vanishes from every derived
   * aggregate immediately (derived). Commits atomically with the
   * `demand_commitment.withdrawn` audit event.
   */
  withdrawDemandCommitment(
    execution: ExecutionContext,
    input: WithdrawDemandCommitmentInput,
  ): Promise<DemandCommitment>;
  /** Tenant-scoped pool reads (cross-scope = NotFoundError). */
  getDemandPool(
    execution: ExecutionContext,
    organizationScopeId: string,
    poolId: string,
  ): Promise<DemandPool>;
  listDemandPools(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly categoryKey?: string;
      readonly closed?: boolean;
    },
  ): Promise<readonly DemandPool[]>;
  /** Tenant-scoped commitment reads (service-level diagnostics). */
  getDemandCommitment(
    execution: ExecutionContext,
    organizationScopeId: string,
    commitmentId: string,
  ): Promise<DemandCommitment>;
  listDemandCommitments(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly consumerPersonId?: string;
      readonly withdrawn?: boolean;
    },
  ): Promise<readonly DemandCommitment[]>;
  /**
   * THE SUPPLIER-FACING DERIVATION (DEM-002/003 / AC-02/03): the
   * privacy-preserving qualified aggregate demand of one pool —
   * re-derived from CURRENT durable records (the pool, the ACTIVE
   * commitments, the requestor's membership) at ONE explicit
   * evaluation anchor by the PURE aggregation engine. There is NO
   * command that asserts, stores or waives qualification, NO
   * aggregate or threshold input exists (every caller field beyond
   * scope/pool identity is ignored), and this boundary carries NO
   * economic surface (/settlement stays the economic authority).
   * Mutates nothing; audits nothing (a derived 200 decision).
   */
  evaluateQualifiedDemand(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<QualifiedDemandAggregate>;
}

export interface DemandServiceDeps {
  readonly poolRepository: DemandPoolRepository;
  readonly commitmentRepository: DemandCommitmentRepository;
  readonly membershipLookup: DemandMembershipLookup;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// NET-W025 records (business procurement pools — the SAME boundary)
// ---------------------------------------------------------------------------

/**
 * The server-written consent grant on a business procurement
 * commitment: the buyer's explicit, versioned consent to
 * AGGREGATE-ONLY disclosure of the banded attributes (the only
 * closed consent scope in NET-W025 — there is no
 * individual-disclosure vocabulary, so no caller assertion can
 * fabricate individual exposure or attribute a fact to one
 * organization). The input may only NAME the scope; the grant (who
 * + when + version) is recorded by the server from the
 * server-resolved acting person (DEM-002 / PRIV-003 / PROC-003).
 */
export interface ProcurementConsentGrant {
  readonly scope: "aggregate_disclosure";
  readonly version: string;
  readonly grantedAt: string;
  /** The server-resolved submitter (the acting person). */
  readonly grantedBy: string;
}

/**
 * A ProcurementPool — the first-class, durable, tenant-scoped record
 * of aggregated BUSINESS procurement demand (DEM-001; issue #50
 * invariant 1): a named pool in one procurement category with an
 * explicit, versioned qualification/competition policy (a commitment
 * threshold AND a distinct-organization threshold). The acting
 * person at creation BECOMES the pool creator (there is no
 * creatorPersonId INPUT on any command, so a caller cannot fabricate
 * pool ownership).
 *
 * The record is STATIC after creation except the one-way closure
 * (`closedAt`) — creator-only, audited. A closed pool accepts no new
 * commitments and never qualifies (derived). NO lifecycle subject
 * kind, NO transition machinery (/workflows untouched).
 */
export interface ProcurementPool {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The pool creator — the acting person at creation. */
  readonly createdBy: string;
  readonly name: string;
  readonly categoryKey: ProcurementCategoryKey;
  readonly categoryVersion: string;
  /**
   * The explicit, versioned qualification/competition policy: the
   * thresholds the DERIVED evaluation compares the active commitment
   * count and the DISTINCT buyer-organization count against.
   * Recorded once at creation; only ever re-evaluated, never
   * caller-asserted per evaluation. Neither threshold can lower the
   * frozen disclosure floors.
   */
  readonly policy: {
    readonly version: number;
    readonly minimumCommitments: number;
    readonly minimumOrganizations: number;
  };
  /** One-way closure (null while the pool is open). */
  readonly closedAt: string | null;
  readonly closureReason: string | null;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * A ProcurementCommitment — the first-class, durable, tenant-scoped
 * record of one buyer organization's PRIVATE business demand
 * commitment (DEM-001; issue #50 invariant 1): a bounded,
 * provider-neutral attribute set inside one pool's procurement
 * category, naming the BUYER ORGANIZATION on whose behalf the acting
 * person commits, with the SERVER-WRITTEN aggregate-disclosure
 * consent grant and full execution provenance. The acting person at
 * submission BECOMES the submitter (there is no submittedBy INPUT on
 * any command) and must hold ACTIVE membership in BOTH the tenant
 * organization and the named buyer organization (server-enforced —
 * buyer eligibility cannot be fabricated).
 *
 * The record is STATIC after creation except the one-way withdrawal
 * (`withdrawnAt`) — submitter-only, audited. ONE ACTIVE
 * (non-withdrawn) commitment per (pool, submitter) — a stable
 * conflict otherwise; a buyer organization may hold multiple active
 * commitments submitted by different authorized members (the
 * distinct-organization floor then governs disclosure); a withdrawn
 * commitment never blocks re-commitment.
 */
export interface ProcurementCommitment {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  /** The buyer organization on whose behalf the demand is committed. */
  readonly buyerOrganizationId: string;
  /** The submitter — the acting person at submission. */
  readonly submittedBy: string;
  /** The procurement category snapshot (the pool's category at submission). */
  readonly categoryKey: ProcurementCategoryKey;
  readonly categoryVersion: string;
  /**
   * The bounded, provider-neutral declared demand attributes —
   * bands/buckets/windows ONLY (an exact amount, unit price or
   * delivery date is unrepresentable; PROC-003).
   */
  readonly attributes: {
    readonly region: ProcurementRegionCode;
    readonly quantity: number;
    readonly budgetBand: ProcurementBudgetBand | null;
    readonly unitPriceBand: ProcurementUnitPriceBand | null;
    readonly timingWindow: ProcurementTimingWindow | null;
  };
  /** The server-written aggregate-disclosure consent grant. */
  readonly consent: ProcurementConsentGrant;
  /** One-way withdrawal (null while the commitment is active). */
  readonly withdrawnAt: string | null;
  readonly withdrawalReason: string | null;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W025 inputs / results
// ---------------------------------------------------------------------------

export interface CreateProcurementPoolInput {
  readonly organizationScopeId: string;
  readonly name: string;
  readonly categoryKey: string;
  readonly qualificationPolicy: {
    readonly minimumCommitments: number;
    readonly minimumOrganizations: number;
  };
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO creatorPersonId input — the pool
  // creator is the acting person, server-resolved (a caller cannot
  // fabricate pool ownership).
}

export interface CreateProcurementPoolResult {
  readonly pool: ProcurementPool;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface CloseProcurementPoolInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

export interface CreateProcurementCommitmentInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  /**
   * The buyer organization on whose behalf the acting person commits.
   * The acting person must hold an ACTIVE membership there
   * (server-resolved — a caller cannot fabricate buyer eligibility;
   * a failed authorization is indistinguishable from a nonexistent
   * organization).
   */
  readonly buyerOrganizationId: string;
  readonly attributes: {
    readonly region: string;
    readonly quantity: number;
    readonly budgetBand?: string | null;
    readonly unitPriceBand?: string | null;
    readonly timingWindow?: string | null;
  };
  /**
   * The buyer may only NAME the closed consent scope
   * ("aggregate_disclosure"); the grant itself (who + when + version)
   * is server-written. Any other scope value fails closed.
   */
  readonly consent: {
    readonly scope: string;
  };
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO submittedBy input — the
  // submitter is the acting person, server-resolved (a caller cannot
  // fabricate commitment ownership; issue #50 invariant 2).
}

export interface CreateProcurementCommitmentResult {
  readonly commitment: ProcurementCommitment;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface WithdrawProcurementCommitmentInput {
  readonly organizationScopeId: string;
  readonly commitmentId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// The DERIVED qualified procurement aggregate (DEM-002 + PROC-003 —
// never stored, never caller-asserted)
// ---------------------------------------------------------------------------

/**
 * One qualification/privacy/competition check of the derived
 * aggregate view (machine-readable; issue #50 invariant 5). Every
 * check re-derives from CURRENT durable records on every
 * evaluation.
 */
export interface ProcurementAggregateCheck {
  readonly check:
    | "pool_open"
    | "requestor_membership"
    | "commitments_present"
    | "privacy_floor_met"
    | "organization_floor_met"
    | "qualification_thresholds_met";
  readonly satisfied: boolean;
  /**
   * Deterministic machine-readable detail (commitment/organization
   * counts are disclosed only when the aggregate is disclosable to
   * THAT requestor — both floors met AND active member).
   */
  readonly detail: Record<string, unknown>;
}

/**
 * One named, above-floor distribution group of the aggregate facts
 * (a region code, a budget band, a unit-price band, a timing window
 * or a quantity bucket with its commitment count). Below-floor
 * groups are NEVER named — they fold into `suppressedGroups`.
 */
export interface ProcurementDistributionGroup {
  readonly group: string;
  readonly count: number;
}

/**
 * The minimized aggregate facts (DEM-002 / PROC-003): counts and
 * bounded distributions ONLY — no person ids, no commitment ids, no
 * buyer-organization ids, no exact per-organization quantities, unit
 * prices, budgets or timing. Emitted ONLY when the frozen commitment
 * floor AND the frozen distinct-organization floor are met AND the
 * requestor is an active organization member.
 */
export interface ProcurementAggregateFacts {
  readonly commitmentCount: number;
  /** The DISTINCT buyer-organization count — the only organization datum that ever crosses (itself floor-gated). */
  readonly organizationCount: number;
  readonly quantityBuckets: readonly ProcurementDistributionGroup[];
  readonly regionGroups: readonly ProcurementDistributionGroup[];
  readonly budgetBandGroups: readonly ProcurementDistributionGroup[];
  readonly unitPriceBandGroups: readonly ProcurementDistributionGroup[];
  readonly timingWindowGroups: readonly ProcurementDistributionGroup[];
  /** The COUNT of non-empty below-floor groups (never named). */
  readonly suppressedGroups: number;
}

/**
 * The DERIVED supplier-facing minimized demand view (DEM-002/003 +
 * PROC-003 / AC-02/03): the privacy/competition-preserving qualified
 * aggregate of one procurement pool — a PURE derivation over (the
 * durable pool, the CURRENT active commitments, the requestor's
 * membership) at ONE explicit evaluation anchor. There is NO command
 * that asserts, stores or waives qualification: `qualified` is true
 * iff every check passes, the aggregate facts exist only above BOTH
 * frozen floors, and `/settlement` remains the economic authority
 * (this boundary carries no economic surface at all).
 */
export interface QualifiedProcurementAggregate {
  readonly poolId: string;
  readonly organizationScopeId: string;
  readonly category: {
    readonly key: ProcurementCategoryKey;
    readonly version: string;
  };
  readonly policy: {
    readonly version: number;
    readonly minimumCommitments: number;
    readonly minimumOrganizations: number;
  };
  readonly qualified: boolean;
  readonly checks: readonly ProcurementAggregateCheck[];
  /**
   * The minimized aggregate facts — null unless the frozen commitment
   * floor AND the frozen organization floor are met AND the requestor
   * is an active member. When null, even the counts are suppressed.
   */
  readonly aggregate: ProcurementAggregateFacts | null;
  /**
   * The deterministic digest over the canonical serialization of the
   * decision facts (checks + aggregate + policy + category + pool) —
   * EXCLUDING the evaluation anchor, so identical commitment state
   * yields the identical digest across evaluations. Reproducibility
   * evidence (DEM-002 determinism; the W021/W024 decision-digest
   * precedent).
   */
  readonly digest: string;
  /** The explicit evaluation anchor (recorded, never digested). */
  readonly evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// NET-W025 repositories
// ---------------------------------------------------------------------------

export interface ProcurementPoolRepository {
  save(
    pool: ProcurementPool,
    execution: ExecutionContext,
  ): Promise<ProcurementPool>;
  findById(id: string): Promise<ProcurementPool | null>;
  createWithinTx(
    pool: ProcurementPool,
    tx: AuthorityTransaction,
  ): Promise<ProcurementPool>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementPool | null>;
  /**
   * One-way pool closure (in-tx with the closure audit event): an
   * already-closed pool is returned unchanged.
   */
  closeWithinTx(
    poolId: string,
    closedAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<ProcurementPool>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly categoryKey?: string;
      readonly closed?: boolean;
    },
  ): Promise<readonly ProcurementPool[]>;
}

export interface ProcurementCommitmentRepository {
  save(
    commitment: ProcurementCommitment,
    execution: ExecutionContext,
  ): Promise<ProcurementCommitment>;
  findById(id: string): Promise<ProcurementCommitment | null>;
  createWithinTx(
    commitment: ProcurementCommitment,
    tx: AuthorityTransaction,
  ): Promise<ProcurementCommitment>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementCommitment | null>;
  /**
   * In-tx active-commitment lookup for the create-once constraint
   * (one NON-WITHDRAWN commitment per (pool, submitter) — a
   * withdrawn commitment never blocks re-commitment). The buyer
   * organization is NOT part of the constraint: an organization may
   * hold multiple active commitments from different members, which
   * keeps the commitment count and the distinct-organization count
   * independent (the competition floor stays meaningful).
   */
  findActiveByPoolAndSubmitterWithinTx(
    organizationScopeId: string,
    poolId: string,
    submittedBy: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementCommitment | null>;
  /**
   * One-way commitment withdrawal (in-tx with the withdrawal audit
   * event): an already-withdrawn commitment is returned unchanged.
   */
  withdrawWithinTx(
    commitmentId: string,
    withdrawnAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<ProcurementCommitment>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly buyerOrganizationId?: string;
      readonly submittedBy?: string;
      readonly withdrawn?: boolean;
    },
  ): Promise<readonly ProcurementCommitment[]>;
  /**
   * The active (non-withdrawn) commitments of one pool — the
   * authoritative input of the derived aggregate view (committed
   * reads; deterministically ordered by the service).
   */
  listActiveByPool(poolId: string): Promise<readonly ProcurementCommitment[]>;
  /**
   * In-tx active-commitment listing for the NET-W026
   * qualified-demand re-derivation inside the authoritative
   * transaction (the offer/selection TOCTOU closure: the pool's
   * CURRENT qualification state is re-derived from tx-scanned
   * records, never trusted from a pre-flight snapshot).
   */
  listActiveByPoolWithinTx(
    poolId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly ProcurementCommitment[]>;
}

// ---------------------------------------------------------------------------
// The NET-W025 procurement domain service (same boundary: /demand)
// ---------------------------------------------------------------------------

export interface ProcurementService {
  /**
   * Create a business procurement pool (DEM-001): the acting person
   * BECOMES the pool creator (there is no creatorPersonId input —
   * ownership cannot be fabricated). Requires ACTIVE tenant
   * organization membership (server-resolved through the neutral
   * lookup). Validates the closed procurement category vocabulary,
   * the bounded name and the bounded dual-threshold qualification
   * policy. Commits atomically with the `procurement_pool.created`
   * audit event.
   */
  createProcurementPool(
    execution: ExecutionContext,
    input: CreateProcurementPoolInput,
  ): Promise<CreateProcurementPoolResult>;
  /**
   * Close the pool (one-way, creator-only; the conservative
   * direction): a closed pool accepts no new commitments and never
   * qualifies (derived). Commits atomically with the
   * `procurement_pool.closed` audit event.
   */
  closeProcurementPool(
    execution: ExecutionContext,
    input: CloseProcurementPoolInput,
  ): Promise<ProcurementPool>;
  /**
   * Record a business demand commitment (DEM-001): the acting person
   * BECOMES the submitter (there is no submittedBy input —
   * commitment ownership cannot be fabricated) and must hold ACTIVE
   * membership in BOTH the tenant organization AND the named buyer
   * organization (server-enforced; a failed buyer authorization is
   * indistinguishable from a nonexistent organization). The pool must
   * resolve in tenant scope and be open. The consent grant is
   * SERVER-WRITTEN (the input may only name the closed
   * "aggregate_disclosure" scope). ONE ACTIVE commitment per (pool,
   * submitter) — a stable conflict otherwise. Serialized by the
   * per-pool lock so the derived count conserves under concurrency.
   * Commits atomically with the
   * `procurement_commitment.recorded` audit event.
   */
  createProcurementCommitment(
    execution: ExecutionContext,
    input: CreateProcurementCommitmentInput,
  ): Promise<CreateProcurementCommitmentResult>;
  /**
   * Withdraw the commitment (one-way, submitter-only — the consent
   * revocation): a withdrawn commitment vanishes from every derived
   * aggregate immediately (derived). Commits atomically with the
   * `procurement_commitment.withdrawn` audit event.
   */
  withdrawProcurementCommitment(
    execution: ExecutionContext,
    input: WithdrawProcurementCommitmentInput,
  ): Promise<ProcurementCommitment>;
  /** Tenant-scoped pool reads (cross-scope = NotFoundError). */
  getProcurementPool(
    execution: ExecutionContext,
    organizationScopeId: string,
    poolId: string,
  ): Promise<ProcurementPool>;
  listProcurementPools(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly categoryKey?: string;
      readonly closed?: boolean;
    },
  ): Promise<readonly ProcurementPool[]>;
  /** Tenant-scoped commitment reads (service-level diagnostics). */
  getProcurementCommitment(
    execution: ExecutionContext,
    organizationScopeId: string,
    commitmentId: string,
  ): Promise<ProcurementCommitment>;
  listProcurementCommitments(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly buyerOrganizationId?: string;
      readonly submittedBy?: string;
      readonly withdrawn?: boolean;
    },
  ): Promise<readonly ProcurementCommitment[]>;
  /**
   * THE SUPPLIER-FACING DERIVATION (DEM-002/003 + PROC-003 /
   * AC-02/03): the privacy/competition-preserving qualified aggregate
   * of one procurement pool — re-derived from CURRENT durable records
   * (the pool, the ACTIVE commitments, the requestor's membership) at
   * ONE explicit evaluation anchor by the PURE aggregation engine.
   * There is NO command that asserts, stores or waives qualification,
   * NO aggregate/threshold input exists (every caller field beyond
   * scope/pool identity is ignored), and this boundary carries NO
   * economic surface (/settlement stays the economic authority).
   * Mutates nothing; audits nothing (a derived 200 decision).
   */
  evaluateQualifiedProcurementDemand(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<QualifiedProcurementAggregate>;
}

export interface ProcurementServiceDeps {
  readonly poolRepository: ProcurementPoolRepository;
  readonly commitmentRepository: ProcurementCommitmentRepository;
  readonly membershipLookup: DemandMembershipLookup;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// NET-W026 records (supplier offers + competitive selection — the SAME
// boundary)
// ---------------------------------------------------------------------------

/**
 * The server-written consent grant on a supplier offer: the
 * supplier's explicit, versioned consent to COMPETITIVE-SELECTION
 * disclosure (the only closed consent scope in NET-W026 — the
 * offer's banded attributes may be compared and ranked inside the
 * named pool's selection, and disclosed in the pool-creator-scoped
 * selection results). The input may only NAME the scope; the grant
 * (who + when + version) is recorded by the server from the
 * server-resolved acting supplier (DEM-003 / PROC-003).
 */
export interface SupplierOfferConsentGrant {
  readonly scope: SupplierOfferConsentScope;
  readonly version: string;
  readonly grantedAt: string;
  /** The server-resolved supplier actor (the acting person). */
  readonly grantedBy: string;
}

/**
 * A SupplierOffer — the first-class, durable, tenant-scoped record of
 * one supplier's competitive offer against one procurement pool
 * (DEM-003; issue #52 invariant 1): a bounded, provider-neutral
 * attribute set inside the pool's procurement category (the SAME
 * closed band/bucket/window vocabularies the qualified demand
 * contract discloses), with the SERVER-WRITTEN competitive-selection
 * consent grant, an explicit validity window and full execution
 * provenance. The acting person at submission BECOMES the supplier
 * (there is no supplierPersonId INPUT on any command — supplier
 * identity cannot be fabricated) and must hold ACTIVE membership in
 * the tenant organization (server-enforced — the authorized-supplier
 * gate), and the pool must be CURRENTLY QUALIFIED (re-derived
 * server-side, never caller-asserted).
 *
 * The record is STATIC after creation except the one-way withdrawal
 * (`withdrawnAt`) — supplier-only, audited. ONE ACTIVE (non-withdrawn)
 * offer per (pool, supplier). Expiry is NOT a mutation: validity is
 * DERIVED from the recorded window at each evaluation anchor. NO
 * lifecycle subject kind, NO transition machinery (/workflows
 * untouched). Exact buyer commitment identities and protected
 * commitment records NEVER appear here (the offer references the
 * POOL only).
 */
export interface SupplierOffer {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  /** The supplier — the acting person at submission (server-resolved). */
  readonly supplierPersonId: string;
  /** The procurement category snapshot (the pool's category at submission). */
  readonly categoryKey: ProcurementCategoryKey;
  readonly categoryVersion: string;
  /**
   * The bounded, provider-neutral offer attributes —
   * bands/buckets/windows ONLY, from the SAME closed vocabularies as
   * the qualified demand contract (an exact price, quantity or
   * delivery date is unrepresentable; PROC-003).
   */
  readonly attributes: {
    readonly region: ProcurementRegionCode;
    readonly unitPriceBand: ProcurementUnitPriceBand;
    readonly timingWindow: ProcurementTimingWindow;
    readonly quantityBucket: ProcurementQuantityBucket;
  };
  /** The server-written competitive-selection consent grant. */
  readonly consent: SupplierOfferConsentGrant;
  /** One-way withdrawal (null while the offer is active). */
  readonly withdrawnAt: string | null;
  readonly withdrawalReason: string | null;
  /**
   * The explicit validity window: validFrom is SERVER-SET to the
   * submission instant; validUntil is the bounded OPTIONAL caller
   * horizon (null = open until withdrawn). Selection eligibility is
   * derived against this window at the evaluation anchor.
   */
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W026 inputs / results
// ---------------------------------------------------------------------------

export interface CreateSupplierOfferInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  /**
   * The bounded, provider-neutral offer attributes (region,
   * unit-price band, delivery-timing window, capacity bucket — all
   * REQUIRED, all from the closed NET-W025 vocabularies).
   */
  readonly attributes: {
    readonly region: string;
    readonly unitPriceBand: string;
    readonly timingWindow: string;
    readonly quantityBucket: string;
  };
  /** The bounded OPTIONAL validity horizon (null = open until withdrawn). */
  readonly validUntil?: string | null;
  /**
   * The supplier may only NAME the closed consent scope
   * ("competitive_selection"); the grant itself (who + when +
   * version) is server-written. Any other scope value fails closed.
   */
  readonly consent: {
    readonly scope: string;
  };
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO supplierPersonId input — the
  // supplier is the acting person, server-resolved (a caller cannot
  // fabricate offer ownership; issue #52 invariant 1). There is
  // deliberately NO eligibility/qualified/rank/score input — hard
  // eligibility is server-derived only (issue #52 invariant 3).
}

export interface CreateSupplierOfferResult {
  readonly offer: SupplierOffer;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface WithdrawSupplierOfferInput {
  readonly organizationScopeId: string;
  readonly offerId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

export interface RecordCompetitiveSelectionInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO offer-set, eligibility, ranking or
  // selected-offer input — the selection is re-derived INSIDE the
  // authoritative transaction from CURRENT records (issue #52
  // invariant 4: caller assertions cannot authorize selection).
}

export interface RecordCompetitiveSelectionResult {
  readonly selection: CompetitiveSelection;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// The DERIVED competitive-selection view (DEM-003 / PROC-001 — never
// stored, never caller-asserted) and the authoritative selection
// lineage record
// ---------------------------------------------------------------------------

/**
 * One hard-eligibility check of the derived competitive selection
 * for ONE offer (machine-readable; issue #52 invariant 3). Every
 * check re-derives from CURRENT durable records at the evaluation
 * anchor — no caller-asserted eligibility exists anywhere.
 */
export interface SupplierOfferCheck {
  readonly check:
    | "offer_validity"
    | "region_served"
    | "supplier_authorized";
  readonly satisfied: boolean;
  /** Deterministic machine-readable detail (offer facts only). */
  readonly detail: Record<string, unknown>;
}

/**
 * The per-offer eligibility evaluation of the derived selection
 * view: the offer identity, its supplier, and the re-derived hard
 * checks. Offer facts only — never buyer data.
 */
export interface SupplierOfferEvaluation {
  readonly offerId: string;
  readonly supplierPersonId: string;
  readonly eligible: boolean;
  readonly checks: readonly SupplierOfferCheck[];
}

/**
 * One pool-level check of the derived competitive selection
 * (machine-readable): the qualified-demand gate (the re-derived
 * NET-W025 qualification at the same anchor) and the eligible-offer
 * presence check.
 */
export interface CompetitiveSelectionCheck {
  readonly check: "pool_qualified" | "eligible_offers_present";
  readonly satisfied: boolean;
  /** Deterministic machine-readable detail (pool policy facts only). */
  readonly detail: Record<string, unknown>;
}

/**
 * One ranked offer of the derived selection: the explicit rank
 * position plus the OFFER facts the ranking consumed (supplier,
 * region, unit-price band, delivery-timing window, capacity bucket).
 * Supplier/offer facts ONLY — buyer commitment data never crosses
 * into the ranking (issue #52 invariant 5 / PROC-003).
 */
export interface CompetitiveSelectionRankEntry {
  readonly rank: number;
  readonly offerId: string;
  readonly supplierPersonId: string;
  readonly region: ProcurementRegionCode;
  readonly unitPriceBand: ProcurementUnitPriceBand;
  readonly timingWindow: ProcurementTimingWindow;
  readonly quantityBucket: ProcurementQuantityBucket;
}

/**
 * The DERIVED competitive-selection view (DEM-003 / PROC-001): the
 * deterministic hard-eligibility evaluation + ranking of one pool's
 * active supplier offers at ONE explicit evaluation anchor — a PURE
 * derivation over (the durable pool, the re-derived qualified
 * aggregate at the SAME anchor, the CURRENT active offers, the
 * suppliers' re-resolved memberships). There is NO command that
 * asserts, stores or waives eligibility, ranking or selection:
 * `selectedOfferId` is the rank-1 eligible offer (null when the pool
 * is unqualified or no offer is eligible), the ranking policy is the
 * explicit versioned server-owned table, and the digest EXCLUDES the
 * evaluation anchor (identical authoritative state ⇒ identical
 * digest). `/settlement` remains the economic authority: this view is
 * a procurement decision surface, never an economic one. Mutates
 * nothing; audits nothing (a derived 200 decision).
 */
export interface CompetitiveSelectionView {
  readonly poolId: string;
  readonly organizationScopeId: string;
  /**
   * The explicit, versioned, server-owned selection policy snapshot
   * (the ranking criteria, in evaluation order) that governed this
   * derivation.
   */
  readonly selectionPolicy: {
    readonly version: number;
    readonly rankingCriteria: readonly string[];
  };
  /**
   * The re-derived NET-W025 qualified-aggregate digest at the SAME
   * anchor — links the selection to the exact minimized demand state
   * it competed against (the aggregate facts themselves NEVER cross
   * into the selection view).
   */
  readonly poolDigest: string;
  /** The pool-level qualified-demand gate result at the anchor. */
  readonly qualified: boolean;
  readonly checks: readonly CompetitiveSelectionCheck[];
  readonly offerEvaluations: readonly SupplierOfferEvaluation[];
  /** The offer set: ALL active (non-withdrawn) offer ids, ascending. */
  readonly consideredOfferIds: readonly string[];
  /** The ELIGIBLE offer ids in RANKED order (the decision order). */
  readonly eligibleOfferIds: readonly string[];
  readonly ranking: readonly CompetitiveSelectionRankEntry[];
  readonly selectedOfferId: string | null;
  /**
   * The deterministic digest over the canonical serialization of the
   * decision facts (policy + pool digest + checks + evaluations +
   * offer sets + ranking + selection) — EXCLUDING the evaluation
   * anchor, so identical authoritative state yields the identical
   * digest across evaluations (the W021/W024/W025 decision-digest
   * precedent).
   */
  readonly digest: string;
  /** The explicit evaluation anchor (recorded, never digested). */
  readonly evaluatedAt: string;
}

/**
 * A CompetitiveSelection — the first-class, durable, tenant-scoped
 * AUTHORITATIVE selection-lineage record (PROC-001 / PROC-AC-03: the
 * selection records the offer set and the selection rationale): one
 * pool-creator-executed competitive selection, derived from CURRENT
 * records INSIDE the authoritative transaction at ONE explicit
 * anchor and persisted once (immutable thereafter — each record is a
 * lineage event; re-tendering records a NEW record). The snapshot
 * carries the full decision facts (checks, per-offer evaluations,
 * offer sets, ranking, selected offer, digest) plus provenance. A
 * selection is a PROCUREMENT DECISION — never an economic mutation
 * (`/settlement` stays the sole economic authority; W027/W028
 * semantics are excluded).
 */
export interface CompetitiveSelection {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  /** The pool creator who executed the selection (server-resolved actor). */
  readonly recordedBy: string;
  readonly selectionPolicy: {
    readonly version: number;
    readonly rankingCriteria: readonly string[];
  };
  readonly poolDigest: string;
  /** Always true on a persisted record (unqualified demand fails closed). */
  readonly qualified: boolean;
  /** The explicit evaluation anchor the record's derivation used. */
  readonly evaluationAnchor: string;
  readonly consideredOfferIds: readonly string[];
  readonly eligibleOfferIds: readonly string[];
  readonly offerEvaluations: readonly SupplierOfferEvaluation[];
  readonly checks: readonly CompetitiveSelectionCheck[];
  readonly ranking: readonly CompetitiveSelectionRankEntry[];
  readonly selectedOfferId: string | null;
  readonly digest: string;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W026 repositories
// ---------------------------------------------------------------------------

export interface SupplierOfferRepository {
  save(
    offer: SupplierOffer,
    execution: ExecutionContext,
  ): Promise<SupplierOffer>;
  findById(id: string): Promise<SupplierOffer | null>;
  createWithinTx(
    offer: SupplierOffer,
    tx: AuthorityTransaction,
  ): Promise<SupplierOffer>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<SupplierOffer | null>;
  /**
   * In-tx active-offer lookup for the create-once constraint (ONE
   * NON-WITHDRAWN offer per (pool, supplier) — a withdrawn offer
   * never blocks re-offering).
   */
  findActiveByPoolAndSupplierWithinTx(
    organizationScopeId: string,
    poolId: string,
    supplierPersonId: string,
    tx: AuthorityTransaction,
  ): Promise<SupplierOffer | null>;
  /**
   * One-way offer withdrawal (in-tx with the withdrawal audit event):
   * an already-withdrawn offer is returned unchanged.
   */
  withdrawWithinTx(
    offerId: string,
    withdrawnAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<SupplierOffer>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly supplierPersonId?: string;
      readonly withdrawn?: boolean;
    },
  ): Promise<readonly SupplierOffer[]>;
  /**
   * The active (non-withdrawn) offers of one pool — the authoritative
   * input of the derived selection view (committed reads;
   * deterministically ordered by the service).
   */
  listActiveByPool(poolId: string): Promise<readonly SupplierOffer[]>;
  /**
   * In-tx active-offer listing for the selection derivation inside
   * the authoritative transaction (the selection TOCTOU closure).
   */
  listActiveByPoolWithinTx(
    poolId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly SupplierOffer[]>;
}

export interface CompetitiveSelectionRepository {
  save(
    selection: CompetitiveSelection,
    execution: ExecutionContext,
  ): Promise<CompetitiveSelection>;
  findById(id: string): Promise<CompetitiveSelection | null>;
  createWithinTx(
    selection: CompetitiveSelection,
    tx: AuthorityTransaction,
  ): Promise<CompetitiveSelection>;
  /** In-tx fresh read. */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<CompetitiveSelection | null>;
  /**
   * The pool's selection lineage, newest-first by (createdAt, id) —
   * immutable records (no mutation methods exist: a selection record
   * is append-only lineage).
   */
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
    },
  ): Promise<readonly CompetitiveSelection[]>;
}

// ---------------------------------------------------------------------------
// The NET-W026 supplier-offer/selection service (same boundary: /demand)
// ---------------------------------------------------------------------------

export interface SupplierOfferService {
  /**
   * Record a supplier offer against a procurement pool (DEM-003):
   * the acting person BECOMES the supplier (there is no
   * supplierPersonId input — offer ownership cannot be fabricated)
   * and must hold ACTIVE tenant membership (the authorized-supplier
   * gate, server-resolved). The pool must resolve in tenant scope,
   * be OPEN and be CURRENTLY QUALIFIED — the qualified aggregate is
   * re-derived SERVER-SIDE pre-flight AND inside the authoritative
   * transaction (never caller-asserted; an unqualified or closed pool
   * fails closed). The consent grant is SERVER-WRITTEN (the input may
   * only name the closed "competitive_selection" scope). ONE ACTIVE
   * offer per (pool, supplier). Serialized by the per-pool lock.
   * Commits atomically with the `procurement_offer.recorded` audit
   * event.
   */
  createSupplierOffer(
    execution: ExecutionContext,
    input: CreateSupplierOfferInput,
  ): Promise<CreateSupplierOfferResult>;
  /**
   * Withdraw the offer (one-way, supplier-only — the consent
   * revocation): a withdrawn offer vanishes from every derived
   * selection immediately (derived). Commits atomically with the
   * `procurement_offer.withdrawn` audit event.
   */
  withdrawSupplierOffer(
    execution: ExecutionContext,
    input: WithdrawSupplierOfferInput,
  ): Promise<SupplierOffer>;
  /** Tenant-scoped offer reads (service-level diagnostics). */
  getSupplierOffer(
    execution: ExecutionContext,
    organizationScopeId: string,
    offerId: string,
  ): Promise<SupplierOffer>;
  listSupplierOffers(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly supplierPersonId?: string;
      readonly withdrawn?: boolean;
    },
  ): Promise<readonly SupplierOffer[]>;
  /**
   * THE DERIVED SELECTION VIEW (DEM-003 / PROC-001): the
   * deterministic hard-eligibility + ranking derivation of one
   * pool's active offers at ONE explicit evaluation anchor.
   * Pool-creator-only (the view exposes individual supplier offer
   * terms — PROC-003: supplier commercial terms never cross to other
   * pool participants). NO offer-set/eligibility/ranking/selection
   * input exists (every caller field beyond scope/pool identity is
   * ignored), and this boundary carries NO economic surface
   * (/settlement stays the economic authority). Mutates nothing;
   * audits nothing (a derived 200 decision for every outcome).
   */
  evaluateCompetitiveSelection(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<CompetitiveSelectionView>;
  /**
   * Record the AUTHORITATIVE competitive selection lineage
   * (PROC-AC-03: the selection records the offer set and the
   * selection rationale). Pool-creator-only. The selection is
   * re-derived INSIDE the authoritative transaction from CURRENT
   * records (in-tx pool, commitments, offers; anchor set once inside
   * the transaction) — nothing caller-asserted qualifies, ranks or
   * selects. Fails closed when the pool is not CURRENTLY QUALIFIED
   * (unqualified/closed demand cannot enter competitive selection).
   * Same-key replay is exactly-once; serialized by the per-pool lock.
   * Commits atomically with the `procurement_selection.recorded`
   * audit event. A selection is a PROCUREMENT DECISION — no economic
   * state is created.
   */
  recordCompetitiveSelection(
    execution: ExecutionContext,
    input: RecordCompetitiveSelectionInput,
  ): Promise<RecordCompetitiveSelectionResult>;
  /**
   * The pool's selection lineage records (pool-creator-only read:
   * the lineage exposes individual supplier offer terms — PROC-003).
   */
  listPoolSelections(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<readonly CompetitiveSelection[]>;
}

export interface SupplierOfferServiceDeps {
  readonly offerRepository: SupplierOfferRepository;
  readonly selectionRepository: CompetitiveSelectionRepository;
  readonly poolRepository: ProcurementPoolRepository;
  readonly commitmentRepository: ProcurementCommitmentRepository;
  readonly membershipLookup: DemandMembershipLookup;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// NET-W027 records (verified savings and counterfactuals — the SAME
// boundary)
// ---------------------------------------------------------------------------

/**
 * Neutral, read-only facts about one /evidence record, resolved at
 * the composition root (the dependency-inversion precedent — this
 * port imports core contracts only; the bootstrap root wires the
 * thin adapter over the /evidence authority's repository). The
 * savings boundary consumes EXACTLY these facts: tenancy scope, the
 * subject binding and the source type (the provenance/truth
 * authority keeps everything else).
 */
export interface ProcurementSavingsEvidenceFacts {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  /** The evidence source type (see EVIDENCE_SOURCE_TYPES). */
  readonly sourceType: string;
}

/**
 * The neutral /evidence lookup consumed by the savings boundary
 * (scope + subject-binding + source-type facts ONLY — never the
 * payload, commitment or grade machinery of the /evidence
 * authority).
 */
export interface ProcurementSavingsEvidenceLookup {
  resolve(evidenceId: string): Promise<ProcurementSavingsEvidenceFacts | null>;
}

/**
 * Neutral, read-only facts about one /outcomes observation (the
 * normalized measurement authority's OutcomeObservation records),
 * resolved at the composition root. The savings boundary consumes
 * EXACTLY these facts: tenancy scope, the subject binding, the
 * outcome type, the observed value + unit, the confidence, the
 * provenance source type + collection time, and the correction-chain
 * position (`supersededByObservationId` is computed by the adapter
 * over the authority's correction index — an observation corrected
 * by a later record is NOT chain head and can never support a
 * savings derivation). Measurement semantics stay in /outcomes.
 */
export interface ProcurementSavingsOutcomeObservationFacts {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly outcomeType: string;
  readonly observedValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly confidence: ConfidenceEstimate;
  readonly provenance: {
    readonly sourceType: string;
    readonly collectedAt: string;
  };
  /** The observation this record corrects (null for a root record). */
  readonly correctsObservationId: string | null;
  /** The LATER observation that supersedes this one (null = chain head). */
  readonly supersededByObservationId: string | null;
}

/**
 * The neutral /outcomes lookup consumed by the savings boundary
 * (committed-state reads through the composition root).
 */
export interface ProcurementSavingsOutcomeLookup {
  resolve(observationId: string): Promise<ProcurementSavingsOutcomeObservationFacts | null>;
}

/**
 * A ProcurementBaseline — the first-class, tenant/pool-scoped,
 * durable, explicit baseline or counterfactual reference for one
 * procurement pool's realized-outcome comparison (PROC-002; issue
 * #54 invariant 1): the explicit kind (the NET-W006 BaselineKind
 * vocabulary — a `counterfactual` kind REQUIRES a quantified
 * confidence interval, validated at creation and re-derived at
 * every evaluation), the closed-vocabulary method + REQUIRED
 * method version (method identity never collapsed), the bounded
 * HISTORICAL comparison window + bounded population (the explicit
 * assumptions), the baseline value + unit with a validated
 * ConfidenceEstimate, the measurement provenance, and ≥1 traceable
 * /evidence references subject-bound to the pool (resolved through
 * the neutral lookup, fail closed). The acting person must be the
 * POOL CREATOR (the W026 selection-surface precedent — procurement
 * outcome analysis stays with the demand owner).
 *
 * The record is STATIC after creation except the ONE-WAY
 * invalidation (`invalidatedAt` + reason from the closed
 * vocabulary) — an invalidated baseline can never again support a
 * savings derivation (fail-closed re-derivation; /workflows is
 * untouched — no lifecycle subject kind, NO transition machinery).
 * Evidence staleness is likewise DERIVED at each evaluation anchor,
 * never mutated. NO economic surface exists anywhere on this record
 * (a baseline is a measurement reference, not value).
 */
export interface ProcurementBaseline {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  /** The pool creator who established the baseline (server-resolved actor). */
  readonly createdBy: string;
  /** "baseline" | "counterfactual" — the NET-W006 BaselineKind, reused. */
  readonly baselineKind: BaselineKind;
  /** The closed-vocabulary baseline method (see PROCUREMENT_BASELINE_METHODS). */
  readonly method: ProcurementBaselineMethod;
  /** REQUIRED method version — method identity is never collapsed. */
  readonly methodVersion: string;
  /** The bounded HISTORICAL comparison window (1..365 days). */
  readonly comparisonWindow: {
    readonly startsAt: string;
    readonly endsAt: string;
  };
  /** The bounded population/assumptions description (prose). */
  readonly population: string;
  /** The baseline reference value + unit (never an economic amount). */
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  /** Validated confidence; a counterfactual carries a quantified interval. */
  readonly confidence: ConfidenceEstimate;
  /** How the baseline material was produced (measurement provenance). */
  readonly provenance: MeasurementProvenance;
  /** The traceable /evidence references (subject-bound to the pool). */
  readonly evidenceIds: readonly string[];
  /** One-way invalidation (null while the baseline is valid). */
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W027 inputs / results
// ---------------------------------------------------------------------------

export interface CreateProcurementBaselineInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  /** "baseline" | "counterfactual" (closed vocabulary). */
  readonly baselineKind: string;
  /** The closed-vocabulary baseline method. */
  readonly method: string;
  /** REQUIRED method version (never collapsed). */
  readonly methodVersion: string;
  /** The bounded HISTORICAL comparison window. */
  readonly comparisonWindow: {
    readonly startsAt: string;
    readonly endsAt: string;
  };
  /** The bounded population/assumptions description. */
  readonly population: string;
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  /** Validated confidence (counterfactual ⇒ quantified interval). */
  readonly confidence: ConfidenceEstimate;
  /** The baseline material provenance (sourceType + collectedAt required). */
  readonly provenance: {
    readonly sourceType: string;
    readonly sourceId?: string;
    readonly collectedAt: string;
    readonly collectorId?: string;
  };
  /** 1..8 traceable /evidence references (subject-bound to the pool). */
  readonly evidenceIds: readonly string[];
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO validity/supported/quality input —
  // baseline validity and evidence sufficiency are SERVER-DERIVED at
  // every evaluation anchor (issue #54 invariant 3: caller assertions
  // cannot authorize a savings claim).
}

export interface CreateProcurementBaselineResult {
  readonly baseline: ProcurementBaseline;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface InvalidateProcurementBaselineInput {
  readonly organizationScopeId: string;
  readonly baselineId: string;
  /** The closed-vocabulary invalidation reason. */
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * The derivation input: WHICH explicit baseline + WHICH authoritative
 * observations to derive over (each id is resolved and validated
 * server-side — scope, subject, type, chain-head, source, freshness).
 * The optional W026 selection reference is NEUTRAL LINEAGE only.
 */
export interface EvaluateProcurementSavingsInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly baselineId: string;
  /** 0..8 outcome-observation ids (empty ⇒ the derivation fails closed). */
  readonly outcomeObservationIds: readonly string[];
  /** Optional W026 competitive-selection lineage reference (never savings truth). */
  readonly selectionId?: string | null;
  // NOTE: there is deliberately NO savings value, confidence, supported
  // flag or baseline-facts input — the derivation is server-owned
  // arithmetic over authoritative records (issue #54 invariant 1:
  // savings cannot be inferred from caller-provided arithmetic).
}

export interface RecordProcurementSavingsInput extends EvaluateProcurementSavingsInput {
  readonly idempotencyKey: string;
}

export interface RecordProcurementSavingsResult {
  readonly savings: ProcurementSavings;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// The DERIVED savings view (PROC-002 — never stored, never
// caller-asserted) and the authoritative savings lineage record
// ---------------------------------------------------------------------------

/**
 * One machine-readable sufficiency check of the derived savings
 * evaluation (issue #54 invariant 5). Every check re-derives from
 * CURRENT authoritative records at the evaluation anchor — no
 * caller-asserted sufficiency exists anywhere.
 */
export interface ProcurementSavingsCheck {
  readonly check:
    | "baseline_valid"
    | "baseline_kind_interval"
    | "baseline_evidence_supported"
    | "baseline_evidence_fresh"
    | "observation_present"
    | "observation_supported"
    | "observation_chain_head"
    | "observation_subject_bound"
    | "observation_outcome_type_savings"
    | "observation_evidence_fresh"
    | "unit_consistent"
    | "uncertainty_preserved";
  readonly satisfied: boolean;
  /** Deterministic machine-readable detail (baseline/observation facts only). */
  readonly detail: Record<string, unknown>;
}

/**
 * The DERIVED savings view (PROC-002): the deterministic,
 * uncertainty-preserving derivation of one pool's realized savings
 * against one explicit baseline at ONE explicit evaluation anchor —
 * a PURE derivation over (the durable pool, the CURRENT baseline,
 * the baseline's re-resolved /evidence facts, the re-resolved
 * /outcomes observations). There is NO command that asserts, stores
 * or waives sufficiency: `supported` is the conjunctive verdict of
 * the machine-readable checks, the observed value combines
 * conservatively (sum + unit consistency; MIN confidence point +
 * interval envelope — the NET-W006 rollup precedent), and savings =
 * baseline − observed (SERVER-OWNED arithmetic — never caller
 * arithmetic, never offer price), and the digest EXCLUDES the
 * evaluation anchor (identical authoritative state ⇒ identical
 * digest). `/settlement` remains the economic authority: this view
 * is a MEASUREMENT DECISION surface, never an economic one; W028
 * Benefit Pool semantics are excluded. Mutates nothing; audits
 * nothing (a derived 200 decision).
 */
export interface ProcurementSavingsView {
  readonly poolId: string;
  readonly organizationScopeId: string;
  /** The explicit, versioned, server-owned derivation policy snapshot. */
  readonly derivationPolicy: {
    readonly version: number;
    readonly method: string;
    readonly criteria: readonly string[];
  };
  readonly baselineId: string;
  readonly baselineKind: BaselineKind;
  /** The conjunctive sufficiency verdict (every check satisfied). */
  readonly supported: boolean;
  readonly checks: readonly ProcurementSavingsCheck[];
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  /** The conservatively combined observed value (null when un combinable). */
  readonly observedValue: {
    readonly value: number;
    readonly unit: string;
  } | null;
  /** savings = baseline − observed (null when un combinable; may be negative — honest realized dis-savings). */
  readonly savings: {
    readonly value: number;
    readonly unit: string;
  } | null;
  /** The conservatively combined confidence (null when un combinable). */
  readonly confidence: ConfidenceEstimate | null;
  /** The contributing observation ids, in canonical id order (input-order independent). */
  readonly observationIds: readonly string[];
  /**
   * The deterministic digest over the canonical decision facts
   * (policy + baseline + evidence + observations + checks + derived
   * values) — EXCLUDING the evaluation anchor (the W021/W024/W025/
   * W026 decision-digest precedent).
   */
  readonly digest: string;
  /** The explicit evaluation anchor (recorded, never digested). */
  readonly evaluatedAt: string;
}

/**
 * A ProcurementSavings — the first-class, durable, tenant-scoped
 * AUTHORITATIVE savings-lineage record (PROC-002 / PROC-AC-01's
 * gate): one pool-creator-executed verified savings claim, derived
 * from CURRENT records at ONE explicit anchor and persisted once
 * (IMMUTABLE thereafter — each record is a lineage event;
 * re-derivation records a NEW record). Fails closed when the
 * derivation is not supported (invalid, stale or insufficient
 * evidence — never caller-asserted). The snapshot carries the full
 * derivation facts (policy, baseline identity/kind/value, observed
 * value, savings, confidence, checks, digest) + provenance. A
 * verified savings claim is a MEASUREMENT DECISION — never an
 * economic mutation (`/settlement` stays the sole economic
 * authority; W028 semantics are excluded). Economically
 * authoritative consumers (NET-W028+) must consume the DERIVED
 * evaluation for current verdicts, never stale snapshots.
 */
export interface ProcurementSavings {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly baselineId: string;
  /** Optional W026 competitive-selection lineage (neutral reference). */
  readonly selectionId: string | null;
  /** The pool creator who recorded the claim (server-resolved actor). */
  readonly recordedBy: string;
  readonly derivationPolicy: {
    readonly version: number;
    readonly method: string;
    readonly criteria: readonly string[];
  };
  readonly baselineKind: BaselineKind;
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
  readonly observedValue: {
    readonly value: number;
    readonly unit: string;
  } | null;
  readonly savings: {
    readonly value: number;
    readonly unit: string;
  } | null;
  readonly confidence: ConfidenceEstimate | null;
  readonly observationIds: readonly string[];
  readonly checks: readonly ProcurementSavingsCheck[];
  /** Always true on a persisted record (unsupported derivations fail closed). */
  readonly supported: boolean;
  /** The explicit evaluation anchor the record's derivation used. */
  readonly evaluationAnchor: string;
  readonly digest: string;
  readonly recordFormat: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W027 repositories
// ---------------------------------------------------------------------------

export interface ProcurementBaselineRepository {
  save(
    baseline: ProcurementBaseline,
    execution: ExecutionContext,
  ): Promise<ProcurementBaseline>;
  findById(id: string): Promise<ProcurementBaseline | null>;
  createWithinTx(
    baseline: ProcurementBaseline,
    tx: AuthorityTransaction,
  ): Promise<ProcurementBaseline>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementBaseline | null>;
  /**
   * One-way baseline invalidation (in-tx with the invalidation audit
   * event): an already-invalidated baseline is returned unchanged.
   */
  invalidateWithinTx(
    baselineId: string,
    invalidatedAt: string,
    reason: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementBaseline>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
      readonly invalidated?: boolean;
    },
  ): Promise<readonly ProcurementBaseline[]>;
}

export interface ProcurementSavingsRepository {
  save(
    savings: ProcurementSavings,
    execution: ExecutionContext,
  ): Promise<ProcurementSavings>;
  findById(id: string): Promise<ProcurementSavings | null>;
  createWithinTx(
    savings: ProcurementSavings,
    tx: AuthorityTransaction,
  ): Promise<ProcurementSavings>;
  /** In-tx fresh read. */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementSavings | null>;
  /**
   * The pool's savings lineage, newest-first by (createdAt, id) —
   * immutable records (no mutation methods exist: a savings record
   * is append-only lineage).
   */
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly poolId?: string;
    },
  ): Promise<readonly ProcurementSavings[]>;
}

// ---------------------------------------------------------------------------
// The NET-W027 savings/counterfactual service (same boundary: /demand)
// ---------------------------------------------------------------------------

export interface ProcurementSavingsService {
  /**
   * Establish the explicit baseline/counterfactual record for a
   * procurement pool (PROC-002): pool-creator-only; the attributes,
   * confidence (counterfactual ⇒ quantified interval), provenance and
   * bounded window/population are validated fail-closed, and every
   * evidence reference is resolved through the NEUTRAL /evidence
   * lookup (missing/cross-tenant ⇒ NotFoundError — no existence
   * oracle; subject-bound to the pool or rejected). Evidence
   * SUFFICIENCE (the qualifying source-type rule) is NOT stored — it
   * is re-derived at every evaluation anchor. Commits atomically
   * with the `procurement_baseline.created` audit event.
   */
  createProcurementBaseline(
    execution: ExecutionContext,
    input: CreateProcurementBaselineInput,
  ): Promise<CreateProcurementBaselineResult>;
  /**
   * Invalidate the baseline (ONE-WAY, pool-creator-only): an
   * invalidated baseline can never again support a savings
   * derivation (the derivation's baseline_valid check fails closed —
   * fail-closed re-derivation, never a status transition; /workflows
   * untouched). Commits atomically with the
   * `procurement_baseline.invalidated` audit event.
   */
  invalidateProcurementBaseline(
    execution: ExecutionContext,
    input: InvalidateProcurementBaselineInput,
  ): Promise<ProcurementBaseline>;
  /** The pool's baselines (pool-creator-only read). */
  listPoolBaselines(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<readonly ProcurementBaseline[]>;
  /**
   * THE DERIVED SAVINGS VIEW (PROC-002): the deterministic,
   * uncertainty-preserving derivation of one pool's realized savings
   * against one explicit baseline at ONE explicit evaluation anchor.
   * Pool-creator-only. NO savings value, confidence, supported flag
   * or baseline-facts input exists (every caller field beyond
   * identities is ignored — the arithmetic is server-owned), and this
   * boundary carries NO economic surface. Mutates nothing; audits
   * nothing (a derived 200 decision for every outcome — supported or
   * not, the decision is the product).
   */
  evaluateProcurementSavings(
    execution: ExecutionContext,
    input: EvaluateProcurementSavingsInput,
  ): Promise<ProcurementSavingsView>;
  /**
   * Record the AUTHORITATIVE savings lineage (PROC-002):
   * pool-creator-only. The derivation is re-executed INSIDE the
   * authoritative transaction from CURRENT records (in-tx pool +
   * baseline; neutral-lookup evidence/observation facts at the ONE
   * anchor set inside the transaction) — nothing caller-asserted
   * values or supports the claim. FAILS CLOSED when the derivation
   * is not supported (invalid, stale or insufficient evidence).
   * Same-key replay is exactly-once; serialized by the per-pool
   * lock. Commits atomically with the `procurement_savings.recorded`
   * audit event. A verified savings claim is a MEASUREMENT DECISION
   * — no economic state is created.
   */
  recordProcurementSavings(
    execution: ExecutionContext,
    input: RecordProcurementSavingsInput,
  ): Promise<RecordProcurementSavingsResult>;
  /** The pool's savings lineage records (pool-creator-only read). */
  listPoolSavings(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<readonly ProcurementSavings[]>;
}

export interface ProcurementSavingsServiceDeps {
  readonly baselineRepository: ProcurementBaselineRepository;
  readonly savingsRepository: ProcurementSavingsRepository;
  readonly poolRepository: ProcurementPoolRepository;
  readonly selectionRepository: CompetitiveSelectionRepository;
  readonly membershipLookup: DemandMembershipLookup;
  readonly evidenceLookup: ProcurementSavingsEvidenceLookup;
  readonly outcomeLookup: ProcurementSavingsOutcomeLookup;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The DemandPort describes the boundary's readiness. After NET-W024
 * it is `"ready"` (the boundary carries the consumer demand-pool
 * domain: tenant-scoped pools and consented commitments, the versioned
 * neutral category/attribute vocabulary, deterministic
 * privacy-preserving aggregation with the frozen disclosure floor, and
 * the derived qualified-aggregate supplier view). NET-W025 extends the
 * SAME boundary with business procurement pools and NET-W026 extends
 * it with supplier offers and competitive selection (the
 * `supplierOfferService` audit vocabulary below); `/demand` remains
 * the single demand/procurement/selection authority.
 */
export interface DemandPort {
  readonly boundary: "demand";
  readonly readiness: "ready";
  /** Audit event types emitted by material demand mutations (AC-07). */
  readonly auditEventTypes: {
    readonly poolCreated: "demand_pool.created";
    readonly poolClosed: "demand_pool.closed";
    readonly commitmentRecorded: "demand_commitment.recorded";
    readonly commitmentWithdrawn: "demand_commitment.withdrawn";
    /** NET-W025 business procurement-pool mutations (same boundary). */
    readonly procurementPoolCreated: "procurement_pool.created";
    readonly procurementPoolClosed: "procurement_pool.closed";
    readonly procurementCommitmentRecorded: "procurement_commitment.recorded";
    readonly procurementCommitmentWithdrawn: "procurement_commitment.withdrawn";
    /** NET-W026 supplier-offer/selection mutations (same boundary). */
    readonly supplierOfferRecorded: "procurement_offer.recorded";
    readonly supplierOfferWithdrawn: "procurement_offer.withdrawn";
    readonly competitiveSelectionRecorded: "procurement_selection.recorded";
    /** NET-W027 baseline/savings mutations (same boundary). */
    readonly procurementBaselineCreated: "procurement_baseline.created";
    readonly procurementBaselineInvalidated: "procurement_baseline.invalidated";
    readonly procurementSavingsRecorded: "procurement_savings.recorded";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  TransactionalAuditWriter,
  IdempotencyStore,
  DemandCategoryKey,
  DemandRegionCode,
  DemandBudgetBand,
  ProcurementCategoryKey,
  ProcurementRegionCode,
  ProcurementBudgetBand,
  ProcurementUnitPriceBand,
  ProcurementTimingWindow,
  ProcurementQuantityBucket,
  SupplierOfferConsentScope,
  BaselineKind,
  ConfidenceEstimate,
  ProcurementBaselineMethod,
};
