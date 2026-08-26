/**
 * Authority-backed OutcomeClaimRepository — persists outcome claims
 * through the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W005 §3.4 (outcome claims, provider-neutral).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 *
 * Storage model: outcome claims live in the `outcome_claims`
 * collection; the entity is the record's `value`. Claimed value, unit,
 * and outcome type are immutable after creation (enforced by the
 * service, which only ever appends evidence ids); the entity's
 * `version` increments on evidence attachment.
 */

import { type ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type { OutcomeClaim, OutcomeClaimRepository } from "./port.ts";

const COLLECTION = "outcome_claims";

export interface AuthorityOutcomeClaimRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthorityOutcomeClaimRepository(
  opts: AuthorityOutcomeClaimRepositoryOptions,
): OutcomeClaimRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(claim, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, claim.id, claim);
        logger?.debug("outcome_claim.saved", {
          claimId: claim.id,
          outcomeType: claim.outcomeType,
          executionId: execution.executionId,
        });
        return claim;
      });
    },

    async saveWithinTx(claim, tx) {
      await tx.put(COLLECTION, claim.id, claim);
      logger?.debug("outcome_claim.saved_within_tx", {
        claimId: claim.id,
        outcomeType: claim.outcomeType,
        transactionId: tx.transactionId,
      });
      return claim;
    },

    async findById(id) {
      const rec = await authority.get<OutcomeClaim>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<OutcomeClaim>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<OutcomeClaim>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as OUTCOME_CLAIMS_COLLECTION };
export type { AuthorityTransaction };
