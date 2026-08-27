/**
 * Authority-backed EconomicStakeRepository — persists the stake
 * escrow records through the PostgreSQL authority boundary
 * (NET-W003).
 *
 * Work order ref: NET-W010 §3.2 (challenge participation stakes).
 *
 * Storage model: stakes live in the `stakes` collection, keyed by
 * record id. The economic TRUTH of a stake is its ledger entries (the
 * commit/release/forfeit transactions); this record is the domain
 * projection the disputes boundary links to (purpose linkage) and the
 * API exposes. Terminal outcome lineage is append-only.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { EconomicStake, EconomicStakeRepository } from "./port.ts";

const COLLECTION = "stakes";

export interface AuthorityStakeRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityStakeRepository(
  opts: AuthorityStakeRepositoryOptions,
): EconomicStakeRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<EconomicStake>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, states) {
      const records = await authority.scan<EconomicStake>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((s) => s.organizationScopeId === organizationScopeId)
        .filter((s) => states === undefined || states.includes(s.state))
        .sort((a, b) =>
          a.committedAt === b.committedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.committedAt < b.committedAt
              ? -1
              : 1,
        );
    },

    async listByOwner(organizationScopeId, ownerPersonId) {
      const records = await authority.scan<EconomicStake>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((s) => s.organizationScopeId === organizationScopeId)
        .filter((s) => s.ownerPersonId === ownerPersonId)
        .sort((a, b) =>
          a.committedAt === b.committedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.committedAt < b.committedAt
              ? -1
              : 1,
        );
    },

    async findByPurpose(organizationScopeId, purposeKind, purposeId, states) {
      const records = await authority.scan<EconomicStake>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((s) => s.organizationScopeId === organizationScopeId)
        .filter((s) => s.purpose.kind === purposeKind)
        .filter((s) => s.purpose.id === purposeId)
        .filter((s) => states === undefined || states.includes(s.state))
        .sort((a, b) =>
          a.committedAt === b.committedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.committedAt < b.committedAt
              ? -1
              : 1,
        );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<EconomicStake>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByPurposeWithinTx(organizationScopeId, purposeKind, purposeId, tx) {
      const records = await tx.scan<EconomicStake>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((s) => s.organizationScopeId === organizationScopeId)
        .filter((s) => s.purpose.kind === purposeKind)
        .filter((s) => s.purpose.id === purposeId);
    },

    async createWithinTx(stake, tx) {
      await tx.put(COLLECTION, stake.id, stake);
      logger?.debug("stake.created_within_tx", {
        stakeId: stake.id,
        transactionId: tx.transactionId,
      });
      return stake;
    },

    async saveWithinTx(stake, tx) {
      await tx.put(COLLECTION, stake.id, stake);
      logger?.debug("stake.saved_within_tx", {
        stakeId: stake.id,
        state: stake.state,
        transactionId: tx.transactionId,
      });
      return stake;
    },
  };
}

export { COLLECTION as STAKES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
