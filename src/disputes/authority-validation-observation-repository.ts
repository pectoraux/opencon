/**
 * Authority-backed ValidationObservationRepository — persists the
 * independent validator observation records through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W032 §3.4 (validator observations).
 *
 * Storage model: observations live in the
 * `validation_observations` collection, keyed by record id. Each
 * observation carries the validator identity, the assignment-set
 * binding, the target copy, the verdict, the opaque evidence
 * references and the EXPLICIT observation anchor. At most ONE
 * observation exists per (round, validator) — enforced by the
 * service's authoritative transaction through the
 * findByChallengeAndValidator(WithinTx) twins (the slot mutex
 * serializes the check-then-act).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ValidationObservation,
  ValidationObservationRepository,
} from "./port.ts";

const COLLECTION = "validation_observations";

/** The deterministic derivation order: (observedAt, id). */
function byObservedAt(a: ValidationObservation, b: ValidationObservation): number {
  if (a.observedAt === b.observedAt) return a.id < b.id ? -1 : 1;
  return a.observedAt < b.observedAt ? -1 : 1;
}

export interface AuthorityValidationObservationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityValidationObservationRepository(
  opts: AuthorityValidationObservationRepositoryOptions,
): ValidationObservationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(observation, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, observation.id, observation);
        logger?.debug("validation_observation.saved", {
          observationId: observation.id,
          executionId: execution.executionId,
        });
        return observation;
      });
    },

    async findById(id) {
      const rec = await authority.get<ValidationObservation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByChallenge(organizationScopeId, challengeId) {
      const records = await authority.scan<ValidationObservation>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter(
          (o) =>
            o.organizationScopeId === organizationScopeId &&
            o.challengeId === challengeId,
        )
        .sort(byObservedAt);
    },

    async listByChallengeWithinTx(organizationScopeId, challengeId, tx) {
      const records = await tx.scan<ValidationObservation>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter(
          (o) =>
            o.organizationScopeId === organizationScopeId &&
            o.challengeId === challengeId,
        )
        .sort(byObservedAt);
    },

    async findByChallengeAndValidator(
      organizationScopeId,
      challengeId,
      validatorPersonId,
    ) {
      const records = await authority.scan<ValidationObservation>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .filter(
          (o) =>
            o.organizationScopeId === organizationScopeId &&
            o.challengeId === challengeId &&
            o.validatorPersonId === validatorPersonId,
        )
        .sort(byObservedAt);
      return match.length > 0 ? match[0]! : null;
    },

    async findByChallengeAndValidatorWithinTx(
      organizationScopeId,
      challengeId,
      validatorPersonId,
      tx,
    ) {
      const records = await tx.scan<ValidationObservation>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .filter(
          (o) =>
            o.organizationScopeId === organizationScopeId &&
            o.challengeId === challengeId &&
            o.validatorPersonId === validatorPersonId,
        )
        .sort(byObservedAt);
      return match.length > 0 ? match[0]! : null;
    },

    async createWithinTx(observation, tx) {
      await tx.put(COLLECTION, observation.id, observation);
      logger?.debug("validation_observation.created_within_tx", {
        observationId: observation.id,
        transactionId: tx.transactionId,
      });
      return observation;
    },
  };
}

export { COLLECTION as VALIDATION_OBSERVATIONS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
