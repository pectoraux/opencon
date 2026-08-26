/**
 * Authority-backed AttributionRepository — persists attribution
 * records through the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W006 §3.2 (attribution representation).
 *
 * Storage model: attribution records live in the `attributions`
 * collection. Records are immutable (created once; there is no update
 * path).
 */

import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type {
  AttributionRecord,
  AttributionRepository,
} from "./port.ts";

const COLLECTION = "attributions";

export interface AuthorityAttributionRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityAttributionRepository(
  opts: AuthorityAttributionRepositoryOptions,
): AttributionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async saveWithinTx(attribution, tx) {
      await tx.put(COLLECTION, attribution.id, attribution);
      logger?.debug("attribution.saved_within_tx", {
        attributionId: attribution.id,
        mode: attribution.mode,
        transactionId: tx.transactionId,
      });
      return attribution;
    },

    async findById(id) {
      const rec = await authority.get<AttributionRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<AttributionRecord>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as ATTRIBUTIONS_COLLECTION };
export type { AuthorityTransaction };
