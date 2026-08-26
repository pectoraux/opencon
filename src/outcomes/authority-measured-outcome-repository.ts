/**
 * Authority-backed MeasuredOutcomeRepository — persists measured
 * outcomes (the maturation aggregate) through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W006 §3.5 (measured outcome + maturation),
 * §3.6 (deterministic rollup).
 *
 * Storage model: measured outcomes live in the `measured_outcomes`
 * collection. The entity satisfies LifecycleSubject (kind
 * "outcome_measurement"): lifecycle transitions are written ONLY by
 * the /workflows WorkflowService through the lifecycle repository
 * surface (getByIdWithinTx/saveWithinTx with optimistic concurrency);
 * domain mutations (attachments, rollup recording) preserve the
 * lifecycle fields and update only domain fields + updatedAt.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  MeasuredOutcome,
  MeasuredOutcomeRepository,
} from "./port.ts";

const COLLECTION = "measured_outcomes";

export interface AuthorityMeasuredOutcomeRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityMeasuredOutcomeRepository(
  opts: AuthorityMeasuredOutcomeRepositoryOptions,
): MeasuredOutcomeRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(measurement, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, measurement.id, measurement);
        logger?.debug("measured_outcome.saved", {
          measurementId: measurement.id,
          state: measurement.state,
          executionId: execution.executionId,
        });
        return measurement;
      });
    },

    async findById(id) {
      const rec = await authority.get<MeasuredOutcome>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<MeasuredOutcome>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(measurement, tx) {
      await tx.put(COLLECTION, measurement.id, measurement);
      logger?.debug("measured_outcome.created_within_tx", {
        measurementId: measurement.id,
        transactionId: tx.transactionId,
      });
      return measurement;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<MeasuredOutcome>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async saveWithinTx(subject, expectedVersion, execution, tx) {
      // Re-read the current subject within the tx (sees uncommitted
      // writes in this tx). Defense in depth: the WorkflowService has
      // already checked expectedVersion; we re-check here so even a
      // caller bypassing the workflow service cannot write stale.
      // Domain mutations pass the version read within the SAME tx and
      // never increment it, so they are never spuriously rejected
      // (mirrors the Proof-of-Value repository semantics).
      const current = await tx.get<MeasuredOutcome>(COLLECTION, subject.id);
      if (!current) {
        throw new NotFoundError(
          `measured outcome ${subject.id} not found within tx`,
          { measurementId: subject.id },
        );
      }
      if (current.value.version !== expectedVersion) {
        const err = new Error(
          `stale writer: expected version ${expectedVersion}, authoritative ${current.value.version}`,
        );
        err.name = "ConcurrentTransitionError";
        throw err;
      }
      // Merge the workflow service's lifecycle mutation onto the current
      // entity, preserving ALL domain fields (subjectReference,
      // outcomeType, attachments, maturation, rollup). The
      // lifecycle-repository adapter already merged them; the explicit
      // spread keeps this repository correct even when called directly.
      const merged: MeasuredOutcome = {
        ...current.value,
        ...subject,
        subjectReference: subject.subjectReference ?? current.value.subjectReference,
        outcomeType: subject.outcomeType ?? current.value.outcomeType,
        outcomeClaimId: subject.outcomeClaimId ?? current.value.outcomeClaimId,
        observationIds: subject.observationIds ?? current.value.observationIds,
        attributionIds: subject.attributionIds ?? current.value.attributionIds,
        baselineIds: subject.baselineIds ?? current.value.baselineIds,
        incrementalityIds:
          subject.incrementalityIds ?? current.value.incrementalityIds,
        maturation: subject.maturation ?? current.value.maturation,
        rollup: subject.rollup ?? current.value.rollup,
        rollupStrategy: subject.rollupStrategy ?? current.value.rollupStrategy,
      };
      await tx.put(COLLECTION, subject.id, merged);
      logger?.debug("measured_outcome.saved_within_tx", {
        measurementId: subject.id,
        fromVersion: current.value.version,
        toVersion: merged.version,
        transactionId: tx.transactionId,
      });
      return merged;
    },
  };
}

export { COLLECTION as MEASURED_OUTCOMES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
