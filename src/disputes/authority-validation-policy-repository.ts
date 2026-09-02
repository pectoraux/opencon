/**
 * Authority-backed ValidationPolicyRepository — persists the immutable,
 * versioned quorum-policy records through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: NET-W032 §3.5 (the versioned policy contract).
 *
 * Storage model: policy versions live in the `validation_policies`
 * collection, keyed by RECORD id. The (policyId, version) pair is
 * unique — records are created once and never rewritten
 * (reproducibility, invariant 4). Version lookups scan the collection
 * and filter deterministically (id tiebreak keeps ordering stable).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ValidationPolicyRepository,
  ValidationQuorumPolicy,
} from "./port.ts";

const COLLECTION = "validation_policies";

export interface AuthorityValidationPolicyRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function inScope(
  policy: ValidationQuorumPolicy,
  organizationScopeId: string | undefined,
): boolean {
  return (
    organizationScopeId === undefined ||
    policy.organizationScopeId === organizationScopeId
  );
}

export function createAuthorityValidationPolicyRepository(
  opts: AuthorityValidationPolicyRepositoryOptions,
): ValidationPolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function versionsFor(
    policyId: string,
    organizationScopeId: string | undefined,
    scan: () => Promise<readonly { value: ValidationQuorumPolicy }[]>,
  ): Promise<readonly ValidationQuorumPolicy[]> {
    const records = await scan();
    return records
      .map((r) => r.value)
      .filter((p) => p.policyId === policyId && inScope(p, organizationScopeId))
      .sort((a, b) =>
        a.version === b.version ? (a.id < b.id ? -1 : 1) : a.version - b.version,
      );
  }

  return {
    async save(policy, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, policy.id, policy);
        logger?.debug("validation_policy.saved", {
          policyId: policy.policyId,
          version: policy.version,
          executionId: execution.executionId,
        });
        return policy;
      });
    },

    async findById(id) {
      const rec = await authority.get<ValidationQuorumPolicy>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findVersion(policyId, version) {
      const versions = await versionsFor(policyId, undefined, () =>
        authority.scan<ValidationQuorumPolicy>(COLLECTION),
      );
      return versions.find((p) => p.version === version) ?? null;
    },

    async findLatestVersion(policyId, organizationScopeId) {
      const versions = await versionsFor(policyId, organizationScopeId, () =>
        authority.scan<ValidationQuorumPolicy>(COLLECTION),
      );
      return versions.length > 0 ? versions[versions.length - 1]! : null;
    },

    async listVersions(policyId, organizationScopeId) {
      return versionsFor(policyId, organizationScopeId, () =>
        authority.scan<ValidationQuorumPolicy>(COLLECTION),
      );
    },

    async findVersionWithinTx(policyId, version, tx) {
      const records = await tx.scan<ValidationQuorumPolicy>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .filter((p) => p.policyId === policyId && p.version === version);
      return match.length > 0 ? match[0]! : null;
    },

    async findLatestVersionWithinTx(policyId, organizationScopeId, tx) {
      const records = await tx.scan<ValidationQuorumPolicy>(COLLECTION);
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
      logger?.debug("validation_policy.created_within_tx", {
        policyId: policy.policyId,
        version: policy.version,
        transactionId: tx.transactionId,
      });
      return policy;
    },
  };
}

export { COLLECTION as VALIDATION_POLICIES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
