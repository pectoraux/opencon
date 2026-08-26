/**
 * Authority-backed MeasurementExperimentRepository — persists
 * measurement experiments through the PostgreSQL authority boundary
 * (NET-W003).
 *
 * Work order ref: NET-W006 §3.3 (experiments/holdouts).
 *
 * Storage model: experiments live in the `measurement_experiments`
 * collection. The status lifecycle (PLANNED → RUNNING → COMPLETED,
 * INVALIDATED from PLANNED/RUNNING) is enforced by the experiment
 * service; the entity's `version` increments on each status change
 * (optimistic concurrency).
 */

import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type {
  MeasurementExperiment,
  MeasurementExperimentRepository,
} from "./port.ts";

const COLLECTION = "measurement_experiments";

export interface AuthorityMeasurementExperimentRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityMeasurementExperimentRepository(
  opts: AuthorityMeasurementExperimentRepositoryOptions,
): MeasurementExperimentRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async saveWithinTx(experiment, tx) {
      await tx.put(COLLECTION, experiment.id, experiment);
      logger?.debug("measurement_experiment.saved_within_tx", {
        experimentId: experiment.id,
        status: experiment.status,
        transactionId: tx.transactionId,
      });
      return experiment;
    },

    async findById(id) {
      const rec = await authority.get<MeasurementExperiment>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<MeasurementExperiment>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<MeasurementExperiment>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as MEASUREMENT_EXPERIMENTS_COLLECTION };
export type { AuthorityTransaction };
