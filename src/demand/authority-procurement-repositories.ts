/**
 * Authority-backed NET-W025 repositories — persist the
 * business-procurement-pool / commitment records through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W025.md §3.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `procurement_pools` — the pool records (DEM-001; static after
 *    creation except the one-way closure);
 *  - `procurement_commitments` — the private business commitment
 *    records (DEM-001; static after creation except the one-way
 *    withdrawal).
 *
 * Procurement semantics introduce NO second demand/procurement
 * authority (these collections live INSIDE the /demand boundary the
 * W024 pools already occupy), NO lifecycle engine, NO economic
 * ledger, NO reputation engine, NO risk authority and NO
 * supplier-selection authority: no LifecycleRepository surface exists
 * here (pools and commitments are NOT workflow lifecycle subjects —
 * /workflows is untouched by NET-W025), and no economic mutation
 * surface exists at all (/settlement is untouched by NET-W025).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  ProcurementCommitment,
  ProcurementCommitmentRepository,
  ProcurementPool,
  ProcurementPoolRepository,
} from "./port.ts";

export const PROCUREMENT_POOLS_COLLECTION = "procurement_pools";
export const PROCUREMENT_COMMITMENTS_COLLECTION =
  "procurement_commitments";

export interface AuthorityProcurementRepositoriesOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function byCreatedAt(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Procurement-pool repository
// ---------------------------------------------------------------------------

export function createAuthorityProcurementPoolRepository(
  opts: AuthorityProcurementRepositoriesOptions,
): ProcurementPoolRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(pool, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PROCUREMENT_POOLS_COLLECTION, pool.id, pool);
        logger?.debug("procurement_pool.saved", {
          poolId: pool.id,
          executionId: execution.executionId,
        });
        return pool;
      });
    },

    async findById(id) {
      const rec = await authority.get<ProcurementPool>(
        PROCUREMENT_POOLS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(pool, tx) {
      const existing = await tx.get<ProcurementPool>(
        PROCUREMENT_POOLS_COLLECTION,
        pool.id,
      );
      if (existing) {
        throw new Error(
          `procurement pool already persisted: ${pool.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PROCUREMENT_POOLS_COLLECTION, pool.id, pool);
      logger?.debug("procurement_pool.created", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
      });
      return pool;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<ProcurementPool>(
        PROCUREMENT_POOLS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async closeWithinTx(poolId, closedAt, reason, tx) {
      const current = await tx.get<ProcurementPool>(
        PROCUREMENT_POOLS_COLLECTION,
        poolId,
      );
      if (!current) {
        throw new NotFoundError(
          `procurement pool not found within tx: ${poolId}`,
          { poolId },
        );
      }
      // One-way: an already-closed pool is returned unchanged (the
      // idempotent-apply replay path).
      if (current.value.closedAt !== null) {
        return current.value;
      }
      const closed: ProcurementPool = {
        ...current.value,
        closedAt,
        closureReason: reason,
        updatedAt: closedAt,
      };
      await tx.put(PROCUREMENT_POOLS_COLLECTION, poolId, closed);
      logger?.debug("procurement_pool.closed", {
        poolId,
        transactionId: tx.transactionId,
      });
      return closed;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<ProcurementPool>(
        PROCUREMENT_POOLS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (pool) =>
            pool.organizationScopeId === organizationScopeId &&
            (!filters?.categoryKey ||
              pool.categoryKey === filters.categoryKey) &&
            (filters?.closed === undefined ||
              (pool.closedAt !== null) === filters.closed),
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Procurement-commitment repository
// ---------------------------------------------------------------------------

export function createAuthorityProcurementCommitmentRepository(
  opts: AuthorityProcurementRepositoriesOptions,
): ProcurementCommitmentRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(commitment, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(
          PROCUREMENT_COMMITMENTS_COLLECTION,
          commitment.id,
          commitment,
        );
        logger?.debug("procurement_commitment.saved", {
          commitmentId: commitment.id,
          executionId: execution.executionId,
        });
        return commitment;
      });
    },

    async findById(id) {
      const rec = await authority.get<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(commitment, tx) {
      const existing = await tx.get<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
        commitment.id,
      );
      if (existing) {
        throw new Error(
          `procurement commitment already persisted: ${commitment.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(
        PROCUREMENT_COMMITMENTS_COLLECTION,
        commitment.id,
        commitment,
      );
      logger?.debug("procurement_commitment.created", {
        commitmentId: commitment.id,
        organizationScopeId: commitment.organizationScopeId,
      });
      return commitment;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findActiveByPoolAndSubmitterWithinTx(
      organizationScopeId,
      poolId,
      submittedBy,
      tx,
    ) {
      const records = await tx.scan<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
      );
      for (const rec of records) {
        const commitment = rec.value;
        if (
          commitment.organizationScopeId === organizationScopeId &&
          commitment.poolId === poolId &&
          commitment.submittedBy === submittedBy &&
          commitment.withdrawnAt === null
        ) {
          return commitment;
        }
      }
      return null;
    },

    async withdrawWithinTx(commitmentId, withdrawnAt, reason, tx) {
      const current = await tx.get<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
        commitmentId,
      );
      if (!current) {
        throw new NotFoundError(
          `procurement commitment not found within tx: ${commitmentId}`,
          { commitmentId },
        );
      }
      // One-way: an already-withdrawn commitment is returned
      // unchanged (the idempotent-apply replay path).
      if (current.value.withdrawnAt !== null) {
        return current.value;
      }
      const withdrawn: ProcurementCommitment = {
        ...current.value,
        withdrawnAt,
        withdrawalReason: reason,
        updatedAt: withdrawnAt,
      };
      await tx.put(
        PROCUREMENT_COMMITMENTS_COLLECTION,
        commitmentId,
        withdrawn,
      );
      logger?.debug("procurement_commitment.withdrawn", {
        commitmentId,
        transactionId: tx.transactionId,
      });
      return withdrawn;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (commitment) =>
            commitment.organizationScopeId === organizationScopeId &&
            (!filters?.poolId || commitment.poolId === filters.poolId) &&
            (!filters?.buyerOrganizationId ||
              commitment.buyerOrganizationId ===
                filters.buyerOrganizationId) &&
            (!filters?.submittedBy ||
              commitment.submittedBy === filters.submittedBy) &&
            (filters?.withdrawn === undefined ||
              (commitment.withdrawnAt !== null) === filters.withdrawn),
        )
        .sort(byCreatedAt);
    },

    async listActiveByPool(poolId) {
      const records = await authority.scan<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (commitment) =>
            commitment.poolId === poolId && commitment.withdrawnAt === null,
        )
        .sort(byCreatedAt);
    },

    async listActiveByPoolWithinTx(poolId, tx) {
      // The in-tx twin (NET-W026): the CURRENT active commitments read
      // INSIDE the authoritative transaction so the offer/selection
      // commands re-derive the pool's qualification from tx-scanned
      // records (never a pre-flight snapshot — the TOCTOU closure).
      const records = await tx.scan<ProcurementCommitment>(
        PROCUREMENT_COMMITMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (commitment) =>
            commitment.poolId === poolId && commitment.withdrawnAt === null,
        )
        .sort(byCreatedAt);
    },
  };
}
