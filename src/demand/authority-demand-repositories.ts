/**
 * Authority-backed NET-W024 repositories — persist the demand-pool /
 * demand-commitment records through the PostgreSQL authority boundary
 * (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W024.md §3.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `demand_pools` — the pool records (DEM-001; static after
 *    creation except the one-way closure);
 *  - `demand_commitments` — the private consumer commitment records
 *    (DEM-001; static after creation except the one-way withdrawal).
 *
 * Demand semantics introduce NO second lifecycle engine, economic
 * ledger, reputation engine, risk authority or procurement authority:
 * no LifecycleRepository surface exists here (pools and commitments
 * are NOT workflow lifecycle subjects — /workflows is untouched by
 * NET-W024), and no economic mutation surface exists at all
 * (/settlement is untouched by NET-W024).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  DemandCommitment,
  DemandCommitmentRepository,
  DemandPool,
  DemandPoolRepository,
} from "./port.ts";

export const DEMAND_POOLS_COLLECTION = "demand_pools";
export const DEMAND_COMMITMENTS_COLLECTION = "demand_commitments";

export interface AuthorityDemandRepositoriesOptions {
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
// Demand-pool repository
// ---------------------------------------------------------------------------

export function createAuthorityDemandPoolRepository(
  opts: AuthorityDemandRepositoriesOptions,
): DemandPoolRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(pool, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(DEMAND_POOLS_COLLECTION, pool.id, pool);
        logger?.debug("demand_pool.saved", {
          poolId: pool.id,
          executionId: execution.executionId,
        });
        return pool;
      });
    },

    async findById(id) {
      const rec = await authority.get<DemandPool>(
        DEMAND_POOLS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(pool, tx) {
      const existing = await tx.get<DemandPool>(
        DEMAND_POOLS_COLLECTION,
        pool.id,
      );
      if (existing) {
        throw new Error(
          `demand pool already persisted: ${pool.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(DEMAND_POOLS_COLLECTION, pool.id, pool);
      logger?.debug("demand_pool.created", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
      });
      return pool;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<DemandPool>(DEMAND_POOLS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async closeWithinTx(poolId, closedAt, reason, tx) {
      const current = await tx.get<DemandPool>(
        DEMAND_POOLS_COLLECTION,
        poolId,
      );
      if (!current) {
        throw new NotFoundError(
          `demand pool not found within tx: ${poolId}`,
          { poolId },
        );
      }
      // One-way: an already-closed pool is returned unchanged (the
      // idempotent-apply replay path).
      if (current.value.closedAt !== null) {
        return current.value;
      }
      const closed: DemandPool = {
        ...current.value,
        closedAt,
        closureReason: reason,
        updatedAt: closedAt,
      };
      await tx.put(DEMAND_POOLS_COLLECTION, poolId, closed);
      logger?.debug("demand_pool.closed", {
        poolId,
        transactionId: tx.transactionId,
      });
      return closed;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<DemandPool>(
        DEMAND_POOLS_COLLECTION,
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
// Demand-commitment repository
// ---------------------------------------------------------------------------

export function createAuthorityDemandCommitmentRepository(
  opts: AuthorityDemandRepositoriesOptions,
): DemandCommitmentRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(commitment, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(
          DEMAND_COMMITMENTS_COLLECTION,
          commitment.id,
          commitment,
        );
        logger?.debug("demand_commitment.saved", {
          commitmentId: commitment.id,
          executionId: execution.executionId,
        });
        return commitment;
      });
    },

    async findById(id) {
      const rec = await authority.get<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(commitment, tx) {
      const existing = await tx.get<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
        commitment.id,
      );
      if (existing) {
        throw new Error(
          `demand commitment already persisted: ${commitment.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(DEMAND_COMMITMENTS_COLLECTION, commitment.id, commitment);
      logger?.debug("demand_commitment.created", {
        commitmentId: commitment.id,
        organizationScopeId: commitment.organizationScopeId,
      });
      return commitment;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findActiveByPoolAndConsumerWithinTx(
      organizationScopeId,
      poolId,
      consumerPersonId,
      tx,
    ) {
      const records = await tx.scan<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
      );
      for (const rec of records) {
        const commitment = rec.value;
        if (
          commitment.organizationScopeId === organizationScopeId &&
          commitment.poolId === poolId &&
          commitment.consumerPersonId === consumerPersonId &&
          commitment.withdrawnAt === null
        ) {
          return commitment;
        }
      }
      return null;
    },

    async withdrawWithinTx(commitmentId, withdrawnAt, reason, tx) {
      const current = await tx.get<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
        commitmentId,
      );
      if (!current) {
        throw new NotFoundError(
          `demand commitment not found within tx: ${commitmentId}`,
          { commitmentId },
        );
      }
      // One-way: an already-withdrawn commitment is returned
      // unchanged (the idempotent-apply replay path).
      if (current.value.withdrawnAt !== null) {
        return current.value;
      }
      const withdrawn: DemandCommitment = {
        ...current.value,
        withdrawnAt,
        withdrawalReason: reason,
        updatedAt: withdrawnAt,
      };
      await tx.put(DEMAND_COMMITMENTS_COLLECTION, commitmentId, withdrawn);
      logger?.debug("demand_commitment.withdrawn", {
        commitmentId,
        transactionId: tx.transactionId,
      });
      return withdrawn;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (commitment) =>
            commitment.organizationScopeId === organizationScopeId &&
            (!filters?.poolId || commitment.poolId === filters.poolId) &&
            (!filters?.consumerPersonId ||
              commitment.consumerPersonId === filters.consumerPersonId) &&
            (filters?.withdrawn === undefined ||
              (commitment.withdrawnAt !== null) === filters.withdrawn),
        )
        .sort(byCreatedAt);
    },

    async listActiveByPool(poolId) {
      const records = await authority.scan<DemandCommitment>(
        DEMAND_COMMITMENTS_COLLECTION,
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
