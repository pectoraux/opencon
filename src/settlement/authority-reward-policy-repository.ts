/**
 * Authority-backed RewardAllocationPolicyRepository — persists the
 * immutable, versioned reward-allocation policies (the exact NET-W007
 * policy-lineage storage pattern).
 *
 * Work order ref: NET-W008 §3.5 (reward accounting).
 *
 * Storage model: policy versions live in the
 * `reward_allocation_policies` collection keyed by RECORD id. The
 * (policyId, version) pair is unique — records are created once and
 * never rewritten (deterministic reward splits stay reproducible).
 * Version lookups scan the collection and filter deterministically.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  RewardAllocationPolicy,
  RewardAllocationPolicyRepository,
} from "./port.ts";

const COLLECTION = "reward_allocation_policies";

export interface AuthorityRewardPolicyRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function inScope(
  policy: RewardAllocationPolicy,
  organizationScopeId?: string,
): boolean {
  return (
    organizationScopeId === undefined ||
    policy.organizationScopeId === organizationScopeId
  );
}

export function createAuthorityRewardPolicyRepository(
  opts: AuthorityRewardPolicyRepositoryOptions,
): RewardAllocationPolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function versionsFor(
    policyId: string,
    organizationScopeId: string | undefined,
    scan: () => Promise<readonly { value: RewardAllocationPolicy }[]>,
  ): Promise<readonly RewardAllocationPolicy[]> {
    const records = await scan();
    return records
      .map((r) => r.value)
      .filter((p) => p.policyId === policyId && inScope(p, organizationScopeId))
      .sort((a, b) =>
        a.version === b.version ? (a.id < b.id ? -1 : 1) : a.version - b.version,
      );
  }

  return {
    async findById(id) {
      const rec = await authority.get<RewardAllocationPolicy>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findVersion(policyId, version) {
      const versions = await versionsFor(policyId, undefined, () =>
        authority.scan<RewardAllocationPolicy>(COLLECTION),
      );
      return versions.find((p) => p.version === version) ?? null;
    },

    async findLatestVersion(policyId, organizationScopeId) {
      const versions = await versionsFor(policyId, organizationScopeId, () =>
        authority.scan<RewardAllocationPolicy>(COLLECTION),
      );
      return versions.length > 0 ? versions[versions.length - 1]! : null;
    },

    async listVersions(policyId, organizationScopeId) {
      return versionsFor(policyId, organizationScopeId, () =>
        authority.scan<RewardAllocationPolicy>(COLLECTION),
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<RewardAllocationPolicy>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findVersionWithinTx(policyId, version, tx) {
      const records = await tx.scan<RewardAllocationPolicy>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .filter((p) => p.policyId === policyId && p.version === version);
      return match.length > 0 ? match[0]! : null;
    },

    async findLatestVersionWithinTx(policyId, organizationScopeId, tx) {
      const records = await tx.scan<RewardAllocationPolicy>(COLLECTION);
      const versions = records
        .map((r) => r.value)
        .filter((p) => p.policyId === policyId && inScope(p, organizationScopeId))
        .sort((a, b) =>
          a.version === b.version ? (a.id < b.id ? -1 : 1) : a.version - b.version,
        );
      return versions.length > 0 ? versions[versions.length - 1]! : null;
    },

    async createWithinTx(policy, tx) {
      await tx.put(COLLECTION, policy.id, policy);
      logger?.debug("reward_policy.created_within_tx", {
        policyId: policy.policyId,
        version: policy.version,
        transactionId: tx.transactionId,
      });
      return policy;
    },
  };
}

export { COLLECTION as REWARD_ALLOCATION_POLICIES_COLLECTION };
export type { AuthorityTransaction };
