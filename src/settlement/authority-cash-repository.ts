/**
 * Authority-backed CashObligationRepository — persists the immutable
 * cash obligation records (payables/receivables with internal
 * settlement state).
 *
 * Work order ref: NET-W008 §3.6 (cash accounting + internal settlement
 * state). External payment execution is NET-W030 and never touches
 * this collection.
 *
 * Storage model: obligations live in the `cash_obligations` collection
 * keyed by obligation id. Idempotent recording is owned by the
 * IdempotencyStore.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  CashObligation,
  CashObligationRepository,
} from "./port.ts";

const COLLECTION = "cash_obligations";

export interface AuthorityCashObligationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCashObligationRepository(
  opts: AuthorityCashObligationRepositoryOptions,
): CashObligationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<CashObligation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<CashObligation>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((o) => o.organizationScopeId === organizationScopeId)
        .sort((a, b) => {
          const ta = Date.parse(a.recordedAt);
          const tb = Date.parse(b.recordedAt);
          if (ta !== tb) return ta - tb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<CashObligation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(obligation, tx) {
      await tx.put(COLLECTION, obligation.id, obligation);
      logger?.debug("cash_obligation.created_within_tx", {
        obligationId: obligation.id,
        kind: obligation.kind,
        amount: obligation.amount,
        transactionId: tx.transactionId,
      });
      return obligation;
    },

    async saveWithinTx(obligation, tx) {
      await tx.put(COLLECTION, obligation.id, obligation);
      logger?.debug("cash_obligation.saved_within_tx", {
        obligationId: obligation.id,
        status: obligation.status,
        transactionId: tx.transactionId,
      });
      return obligation;
    },
  };
}

export { COLLECTION as CASH_OBLIGATIONS_COLLECTION };
export type { AuthorityTransaction };
