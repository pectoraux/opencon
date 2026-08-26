/**
 * Authority-backed OutcomeObservationRepository — persists outcome
 * observations through the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W006 §3.1 (outcome observations).
 *
 * Tier compliance: outcomes domain → self + core contracts only.
 *
 * Storage model: observations live in the `outcome_observations`
 * collection; the entity is the record's `value`. Observations are
 * IMMUTABLE after creation (the service only ever creates records —
 * corrections are new records; there is no update path). Subject
 * listings and correction-chain lookups use collection scans (the
 * authority's scan surface); the authoritative store remains the
 * system of record.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  OutcomeObservation,
  OutcomeObservationRepository,
} from "./port.ts";

const COLLECTION = "outcome_observations";

export interface AuthorityOutcomeObservationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityOutcomeObservationRepository(
  opts: AuthorityOutcomeObservationRepositoryOptions,
): OutcomeObservationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async saveWithinTx(observation, tx) {
      await tx.put(COLLECTION, observation.id, observation);
      logger?.debug("outcome_observation.saved_within_tx", {
        observationId: observation.id,
        outcomeType: observation.outcomeType,
        transactionId: tx.transactionId,
      });
      return observation;
    },

    async findById(id) {
      const rec = await authority.get<OutcomeObservation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<OutcomeObservation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubject(subjectId) {
      const records = await authority.scan<OutcomeObservation>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((o) => o.subjectReference.subjectId === subjectId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    },

    async findByCorrectionOf(id) {
      const records = await authority.scan<OutcomeObservation>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((o) => o.correctsObservationId === id);
    },

    async exists(id) {
      const rec = await authority.get<OutcomeObservation>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as OUTCOME_OBSERVATIONS_COLLECTION };
export type { ExecutionContext };
