/**
 * Authority-backed ReputationInputRepository — persists the immutable,
 * append-only reputation inputs through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: NET-W007 §3.2 (reputation inputs).
 *
 * Storage model: inputs live in the `reputation_inputs` collection.
 * Records are immutable (created once; there is no update path).
 * Subject listings scan the collection and filter to (organization
 * scope, subject person) with a deterministic (occurredAt, id) order
 * so snapshot computations are reproducible. Idempotent recording is
 * owned by the IdempotencyStore (exactly-once-per-key, atomic with
 * the mutation — the NET-W004 primitive), not by this repository.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ReputationInput,
  ReputationInputRepository,
} from "./port.ts";

const COLLECTION = "reputation_inputs";

export interface AuthorityReputationInputRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityReputationInputRepository(
  opts: AuthorityReputationInputRepositoryOptions,
): ReputationInputRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function listBySubjectFrom(
    organizationScopeId: string,
    subjectPersonId: string,
    scan: () => Promise<readonly { value: ReputationInput }[]>,
  ): Promise<readonly ReputationInput[]> {
    const records = await scan();
    return records
      .map((r) => r.value)
      .filter(
        (i) =>
          i.organizationScopeId === organizationScopeId &&
          i.subjectPersonId === subjectPersonId,
      )
      .sort((a, b) => {
        const oa = Date.parse(a.occurredAt);
        const ob = Date.parse(b.occurredAt);
        if (oa !== ob) return oa - ob;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }

  return {
    async save(input, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, input.id, input);
        logger?.debug("reputation_input.saved", {
          inputId: input.id,
          dimension: input.dimension,
          executionId: execution.executionId,
        });
        return input;
      });
    },

    async findById(id) {
      const rec = await authority.get<ReputationInput>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubject(organizationScopeId, subjectPersonId) {
      return listBySubjectFrom(organizationScopeId, subjectPersonId, () =>
        authority.scan<ReputationInput>(COLLECTION),
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ReputationInput>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubjectWithinTx(organizationScopeId, subjectPersonId, tx) {
      return listBySubjectFrom(organizationScopeId, subjectPersonId, () =>
        tx.scan<ReputationInput>(COLLECTION),
      );
    },

    async createWithinTx(input, tx) {
      await tx.put(COLLECTION, input.id, input);
      logger?.debug("reputation_input.created_within_tx", {
        inputId: input.id,
        transactionId: tx.transactionId,
      });
      return input;
    },
  };
}

export { COLLECTION as REPUTATION_INPUTS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
