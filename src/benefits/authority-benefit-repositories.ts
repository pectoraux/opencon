/**
 * Authority-backed NET-W028 repositories — persist the benefit
 * allocation-policy versions, the benefit-pool records and the
 * allocation-lineage records through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W028.md §3.1/§3.8.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `benefit_pool_policies` — the immutable versioned allocation
 *    policy records (append-only: no mutation method exists — a new
 *    version is a NEW record);
 *  - `benefit_pools` — the tenant-scoped pool records (static after
 *    creation except the ONE-WAY closure);
 *  - `benefit_pool_allocations` — the allocation-lineage records
 *    (IMMUTABLE — append-only lineage).
 *
 * Benefit pools introduce NO second economic authority (no ledger,
 * balance, account, credit, cash or reward surface exists here — the
 * ONLY economic mutation flows through the /settlement primitive the
 * composition root exposes through the neutral draw port), NO
 * lifecycle engine (pool closure is a one-way field mutation;
 * /workflows untouched by NET-W028) and NO AI surface.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  BenefitAllocationPolicy,
  BenefitPool,
  BenefitPoolAllocation,
  BenefitPoolAllocationRepository,
  BenefitPoolPolicyRepository,
  BenefitPoolRepository,
} from "./port.ts";

export const BENEFIT_POOL_POLICIES_COLLECTION = "benefit_pool_policies";
export const BENEFIT_POOLS_COLLECTION = "benefit_pools";
export const BENEFIT_POOL_ALLOCATIONS_COLLECTION =
  "benefit_pool_allocations";

export interface AuthorityBenefitRepositoriesOptions {
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
// Benefit-pool-policy repository
// ---------------------------------------------------------------------------

export function createAuthorityBenefitPoolPolicyRepository(
  opts: AuthorityBenefitRepositoriesOptions,
): BenefitPoolPolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findVersion(policyId, version) {
      const records = await authority.scan<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
      );
      return (
        records
          .map((rec) => rec.value)
          .find(
            (policy) =>
              policy.policyId === policyId && policy.version === version,
          ) ?? null
      );
    },

    async findLatestVersion(policyId, organizationScopeId) {
      const records = await authority.scan<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
      );
      const versions = records
        .map((rec) => rec.value)
        .filter(
          (policy) =>
            policy.policyId === policyId &&
            (organizationScopeId === undefined ||
              policy.organizationScopeId === organizationScopeId),
        )
        .sort((a, b) => b.version - a.version);
      return versions[0] ?? null;
    },

    async listVersions(policyId, organizationScopeId) {
      const records = await authority.scan<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (policy) =>
            policy.policyId === policyId &&
            policy.organizationScopeId === organizationScopeId,
        )
        .sort((a, b) => a.version - b.version);
    },

    async findAnyVersion(policyId) {
      // The ORGANIZATION-INDEPENDENT lineage read (the cross-scope
      // fork guard — any version of the lineage, any scope).
      const records = await authority.scan<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
      );
      return (
        records.map((rec) => rec.value).find(
          (policy) => policy.policyId === policyId,
        ) ?? null
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findVersionWithinTx(policyId, version, tx) {
      // The in-tx lineage scan (the create-time TOCTOU closure runs
      // under the org-independent lineage mutex; the pinned-version
      // re-read guards repository drift).
      const records = await tx.scan<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
      );
      return (
        records
          .map((rec) => rec.value)
          .find(
            (policy) =>
              policy.policyId === policyId && policy.version === version,
          ) ?? null
      );
    },

    async createWithinTx(policy, tx) {
      const existing = await tx.get<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
        policy.id,
      );
      if (existing) {
        throw new Error(
          `benefit allocation policy already persisted: ${policy.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      const records = await tx.scan<BenefitAllocationPolicy>(
        BENEFIT_POOL_POLICIES_COLLECTION,
      );
      const duplicate = records.some(
        (rec) =>
          rec.value.policyId === policy.policyId &&
          rec.value.version === policy.version,
      );
      if (duplicate) {
        throw new Error(
          `benefit allocation policy version already persisted: ${policy.policyId}#${policy.version}`,
        );
      }
      await tx.put(BENEFIT_POOL_POLICIES_COLLECTION, policy.id, policy);
      logger?.debug("benefit_pool_policy.created", {
        policyId: policy.policyId,
        version: policy.version,
        organizationScopeId: policy.organizationScopeId,
      });
      return policy;
    },
  };
}

// ---------------------------------------------------------------------------
// Benefit-pool repository
// ---------------------------------------------------------------------------

export function createAuthorityBenefitPoolRepository(
  opts: AuthorityBenefitRepositoriesOptions,
): BenefitPoolRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<BenefitPool>(
        BENEFIT_POOLS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<BenefitPool>(
        BENEFIT_POOLS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(pool, tx) {
      const existing = await tx.get<BenefitPool>(
        BENEFIT_POOLS_COLLECTION,
        pool.id,
      );
      if (existing) {
        throw new Error(
          `benefit pool already persisted: ${pool.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(BENEFIT_POOLS_COLLECTION, pool.id, pool);
      logger?.debug("benefit_pool.created", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
      });
      return pool;
    },

    async closeWithinTx(poolId, closedAt, tx) {
      const current = await tx.get<BenefitPool>(
        BENEFIT_POOLS_COLLECTION,
        poolId,
      );
      if (!current) {
        throw new NotFoundError(
          `benefit pool not found within tx: ${poolId}`,
          { poolId },
        );
      }
      // One-way: an already-closed pool is returned unchanged (the
      // idempotent-apply replay path; a foreign-key second close is
      // rejected by the service before reaching here).
      if (current.value.closedAt !== null) {
        return current.value;
      }
      const closed: BenefitPool = {
        ...current.value,
        closedAt,
      };
      await tx.put(BENEFIT_POOLS_COLLECTION, poolId, closed);
      logger?.debug("benefit_pool.closed", {
        poolId,
        transactionId: tx.transactionId,
      });
      return closed;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<BenefitPool>(
        BENEFIT_POOLS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (pool) =>
            pool.organizationScopeId === organizationScopeId &&
            (filters?.createdBy === undefined ||
              pool.createdBy === filters.createdBy) &&
            (filters?.openOnly === undefined ||
              (pool.closedAt === null) === filters.openOnly),
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Benefit-pool-allocation repository
// ---------------------------------------------------------------------------

export function createAuthorityBenefitPoolAllocationRepository(
  opts: AuthorityBenefitRepositoriesOptions,
): BenefitPoolAllocationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function mapRecords(
    records: readonly { readonly key: string; readonly value: BenefitPoolAllocation }[],
    organizationScopeId: string,
    poolId: string,
  ): Promise<readonly BenefitPoolAllocation[]> {
    // Newest-first lineage (the W026/W027 lineage precedents).
    return records
      .map((rec) => rec.value)
      .filter(
        (allocation) =>
          allocation.organizationScopeId === organizationScopeId &&
          allocation.poolId === poolId,
      )
      .sort((a, b) => {
        if (a.allocatedAt === b.allocatedAt) {
          return a.id < b.id ? 1 : -1;
        }
        return a.allocatedAt < b.allocatedAt ? 1 : -1;
      });
  }

  return {
    async findById(id) {
      const rec = await authority.get<BenefitPoolAllocation>(
        BENEFIT_POOL_ALLOCATIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByPool(organizationScopeId, poolId) {
      const records = await authority.scan<BenefitPoolAllocation>(
        BENEFIT_POOL_ALLOCATIONS_COLLECTION,
      );
      return mapRecords(records, organizationScopeId, poolId);
    },

    async listByPoolWithinTx(organizationScopeId, poolId, tx) {
      const records = await tx.scan<BenefitPoolAllocation>(
        BENEFIT_POOL_ALLOCATIONS_COLLECTION,
      );
      return mapRecords(records, organizationScopeId, poolId);
    },

    async createWithinTx(allocation, tx) {
      const existing = await tx.get<BenefitPoolAllocation>(
        BENEFIT_POOL_ALLOCATIONS_COLLECTION,
        allocation.id,
      );
      if (existing) {
        throw new Error(
          `benefit pool allocation already persisted: ${allocation.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(
        BENEFIT_POOL_ALLOCATIONS_COLLECTION,
        allocation.id,
        allocation,
      );
      logger?.debug("benefit_pool_allocation.created", {
        allocationId: allocation.id,
        poolId: allocation.poolId,
        organizationScopeId: allocation.organizationScopeId,
      });
      return allocation;
    },
  };
}
