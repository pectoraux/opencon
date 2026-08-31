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
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The DemandPort describes the boundary's readiness. After NET-W024
 * it is `"ready"` (the boundary carries the consumer demand-pool
 * domain: tenant-scoped pools and consented commitments, the versioned
 * neutral category/attribute vocabulary, deterministic
 * privacy-preserving aggregation with the frozen disclosure floor, and
 * the derived qualified-aggregate supplier view).
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
};
