/**
 * Authority-backed IncrementalityObservationRepository — persists
 * incrementality observations through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: NET-W006 §3.3 (incrementality observations).
 *
 * Storage model: incrementality observations live in the
 * `incrementality_observations` collection. Records are immutable
 * (created once; there is no update path).
 */

import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type {
  IncrementalityObservation,
  IncrementalityObservationRepository,
} from "./port.ts";

const COLLECTION = "incrementality_observations";

export interface AuthorityIncrementalityObservationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityIncrementalityObservationRepository(
  opts: AuthorityIncrementalityObservationRepositoryOptions,
): IncrementalityObservationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async saveWithinTx(observation, tx) {
      await tx.put(COLLECTION, observation.id, observation);
      logger?.debug("incrementality_observation.saved_within_tx", {
        observationId: observation.id,
        causalStatus: observation.causalStatus,
        transactionId: tx.transactionId,
      });
      return observation;
    },

    async findById(id) {
      const rec = await authority.get<IncrementalityObservation>(
        COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<IncrementalityObservation>(
        COLLECTION,
        id,
      );
      return rec !== null;
    },
  };
}

export { COLLECTION as INCREMENTALITY_OBSERVATIONS_COLLECTION };
export type { AuthorityTransaction };
