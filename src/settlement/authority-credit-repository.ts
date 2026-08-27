/**
 * Authority-backed CreditIssuanceRepository — persists the immutable
 * Participation Credit issuance records (append-only; reversals are
 * status transitions recorded on the record, never rewrites of the
 * original issuance facts).
 *
 * Work order ref: NET-W008 §3.4 (Participation Credits).
 *
 * Storage model: issuances live in the `credit_issuances` collection
 * keyed by issuance id. Idempotent issuance is owned by the
 * IdempotencyStore (exactly-once-per-key, atomic with the mutation).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  CreditIssuance,
  CreditIssuanceRepository,
} from "./port.ts";

const COLLECTION = "credit_issuances";

export interface AuthorityCreditIssuanceRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCreditIssuanceRepository(
  opts: AuthorityCreditIssuanceRepositoryOptions,
): CreditIssuanceRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<CreditIssuance>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByBeneficiary(organizationScopeId, beneficiaryPersonId) {
      const records = await authority.scan<CreditIssuance>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter(
          (i) =>
            i.organizationScopeId === organizationScopeId &&
            i.beneficiaryPersonId === beneficiaryPersonId,
        )
        .sort((a, b) => {
          const ta = Date.parse(a.issuedAt);
          const tb = Date.parse(b.issuedAt);
          if (ta !== tb) return ta - tb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<CreditIssuance>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(issuance, tx) {
      await tx.put(COLLECTION, issuance.id, issuance);
      logger?.debug("credit_issuance.created_within_tx", {
        issuanceId: issuance.id,
        creditAmount: issuance.creditAmount,
        transactionId: tx.transactionId,
      });
      return issuance;
    },

    async saveWithinTx(issuance, tx) {
      await tx.put(COLLECTION, issuance.id, issuance);
      logger?.debug("credit_issuance.saved_within_tx", {
        issuanceId: issuance.id,
        status: issuance.status,
        transactionId: tx.transactionId,
      });
      return issuance;
    },
  };
}

export { COLLECTION as CREDIT_ISSUANCES_COLLECTION };
export type { AuthorityTransaction };
