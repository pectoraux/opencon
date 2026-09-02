/**
 * Authority-backed ValidatorParticipantRepository — persists the
 * tenant-scoped validator registry records through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W032 §3.1 (the scoped validator participant
 * model).
 *
 * Storage model: participants live in the `validator_participants`
 * collection, keyed by record id. Ordering is the deterministic
 * (registeredAt, id) pair — the frozen assignment-selection order
 * (work order §3.2). At most ONE ACTIVE participant binds a person in
 * an organization scope (checked in the service's authoritative
 * transaction through the findByActiveByPerson(WithinTx) twins).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ValidatorParticipant,
  ValidatorParticipantRepository,
} from "./port.ts";

const COLLECTION = "validator_participants";

/** The deterministic assignment-selection order: (registeredAt, id). */
function byRegistration(a: ValidatorParticipant, b: ValidatorParticipant): number {
  if (a.registeredAt === b.registeredAt) return a.id < b.id ? -1 : 1;
  return a.registeredAt < b.registeredAt ? -1 : 1;
}

export interface AuthorityValidatorParticipantRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityValidatorParticipantRepository(
  opts: AuthorityValidatorParticipantRepositoryOptions,
): ValidatorParticipantRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(validator, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, validator.id, validator);
        logger?.debug("validator_participant.saved", {
          validatorId: validator.id,
          status: validator.status,
          executionId: execution.executionId,
        });
        return validator;
      });
    },

    async findById(id) {
      const rec = await authority.get<ValidatorParticipant>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ValidatorParticipant>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, status) {
      const records = await authority.scan<ValidatorParticipant>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((v) => v.organizationScopeId === organizationScopeId)
        .filter((v) => status === undefined || v.status === status)
        .sort(byRegistration);
    },

    async findActiveByPerson(organizationScopeId, personId) {
      const records = await authority.scan<ValidatorParticipant>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .filter(
          (v) =>
            v.organizationScopeId === organizationScopeId &&
            v.personId === personId &&
            v.status === "ACTIVE",
        )
        .sort(byRegistration);
      return match.length > 0 ? match[0]! : null;
    },

    async findActiveByPersonWithinTx(organizationScopeId, personId, tx) {
      const records = await tx.scan<ValidatorParticipant>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .filter(
          (v) =>
            v.organizationScopeId === organizationScopeId &&
            v.personId === personId &&
            v.status === "ACTIVE",
        )
        .sort(byRegistration);
      return match.length > 0 ? match[0]! : null;
    },

    async createWithinTx(validator, tx) {
      await tx.put(COLLECTION, validator.id, validator);
      logger?.debug("validator_participant.created_within_tx", {
        validatorId: validator.id,
        transactionId: tx.transactionId,
      });
      return validator;
    },

    async saveWithinTx(validator, tx) {
      await tx.put(COLLECTION, validator.id, validator);
      logger?.debug("validator_participant.saved_within_tx", {
        validatorId: validator.id,
        status: validator.status,
        transactionId: tx.transactionId,
      });
      return validator;
    },
  };
}

export { COLLECTION as VALIDATOR_PARTICIPANTS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
