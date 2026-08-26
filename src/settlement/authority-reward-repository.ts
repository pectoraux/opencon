/**
 * Authority-backed RewardAllocationRepository — persists the immutable
 * reward-allocation records (append-only; reversals are status
 * transitions recorded on the record).
 *
 * Work order ref: NET-W008 §3.5 (reward accounting).
 *
 * Storage model: allocations live in the `reward_allocations`
 * collection keyed by allocation id. Idempotent allocation is owned by
 * the IdempotencyStore.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  RewardAllocation,
  RewardAllocationRepository,
} from "./port.ts";

const COLLECTION = "reward_allocations";

export interface AuthorityRewardAllocationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityRewardAllocationRepository(
  opts: AuthorityRewardAllocationRepositoryOptions,
): RewardAllocationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<RewardAllocation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<RewardAllocation>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((a) => a.organizationScopeId === organizationScopeId)
        .sort((a, b) => {
          const ta = Date.parse(a.allocatedAt);
          const tb = Date.parse(b.allocatedAt);
          if (ta !== tb) return ta - tb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<RewardAllocation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(allocation, tx) {
      await tx.put(COLLECTION, allocation.id, allocation);
      logger?.debug("reward_allocation.created_within_tx", {
        allocationId: allocation.id,
        policyId: allocation.policyId,
        policyVersion: allocation.policyVersion,
        transactionId: tx.transactionId,
      });
      return allocation;
    },

    async saveWithinTx(allocation, tx) {
      await tx.put(COLLECTION, allocation.id, allocation);
      logger?.debug("reward_allocation.saved_within_tx", {
        allocationId: allocation.id,
        status: allocation.status,
        transactionId: tx.transactionId,
      });
      return allocation;
    },
  };
}

export { COLLECTION as REWARD_ALLOCATIONS_COLLECTION };
export type { AuthorityTransaction };
