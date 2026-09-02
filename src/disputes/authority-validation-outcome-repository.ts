/**
 * Authority-backed ValidationOutcomeRepository — persists the
 * immutable terminal quorum-outcome records through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W032 §3.5 (deterministic quorum/outcome
 * derivation) + §3.8 (application bookkeeping).
 *
 * Storage model: outcomes live in the `validation_outcomes`
 * collection, keyed by record id. The decision, participation, trace
 * and checks are created once by the derivation and NEVER rewritten;
 * the stake-outcome entries and the application fact append AFTER the
 * owning authority acted (append-only bookkeeping, the W010
 * markStakeOutcome discipline).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ValidationOutcome,
  ValidationOutcomeRepository,
} from "./port.ts";

const COLLECTION = "validation_outcomes";

export interface AuthorityValidationOutcomeRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityValidationOutcomeRepository(
  opts: AuthorityValidationOutcomeRepositoryOptions,
): ValidationOutcomeRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(outcome, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, outcome.id, outcome);
        logger?.debug("validation_outcome.saved", {
          outcomeId: outcome.id,
          executionId: execution.executionId,
        });
        return outcome;
      });
    },

    async findById(id) {
      const rec = await authority.get<ValidationOutcome>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ValidationOutcome>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(outcome, tx) {
      await tx.put(COLLECTION, outcome.id, outcome);
      logger?.debug("validation_outcome.created_within_tx", {
        outcomeId: outcome.id,
        decision: outcome.decision,
        transactionId: tx.transactionId,
      });
      return outcome;
    },

    async saveWithinTx(outcome, tx) {
      await tx.put(COLLECTION, outcome.id, outcome);
      logger?.debug("validation_outcome.saved_within_tx", {
        outcomeId: outcome.id,
        transactionId: tx.transactionId,
      });
      return outcome;
    },
  };
}

export { COLLECTION as VALIDATION_OUTCOMES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
