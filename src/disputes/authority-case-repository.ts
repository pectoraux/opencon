/**
 * Authority-backed RiskCaseRepository — persists the review-case
 * records (with their append-only decision histories) through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W009 §3.6 (risk cases and reviews).
 *
 * Storage model: cases live in the `risk_cases` collection, keyed by
 * record id, storing the full decision history inline (append-only:
 * decisions are only ever appended; the derived `state` flips through
 * the audited case-service command in the same transaction).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { RiskCase, RiskCaseRepository } from "./port.ts";

const COLLECTION = "risk_cases";

export interface AuthorityRiskCaseRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityRiskCaseRepository(
  opts: AuthorityRiskCaseRepositoryOptions,
): RiskCaseRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(riskCase, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, riskCase.id, riskCase);
        logger?.debug("risk_case.saved", {
          caseId: riskCase.id,
          state: riskCase.state,
          executionId: execution.executionId,
        });
        return riskCase;
      });
    },

    async findById(id) {
      const rec = await authority.get<RiskCase>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, states) {
      const records = await authority.scan<RiskCase>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .filter(
          (c) => states === undefined || states.includes(c.state),
        )
        .sort((a, b) =>
          a.openedAt === b.openedAt ? (a.id < b.id ? -1 : 1) : a.openedAt < b.openedAt ? -1 : 1,
        );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<RiskCase>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(riskCase, tx) {
      await tx.put(COLLECTION, riskCase.id, riskCase);
      logger?.debug("risk_case.created_within_tx", {
        caseId: riskCase.id,
        transactionId: tx.transactionId,
      });
      return riskCase;
    },

    async saveWithinTx(riskCase, tx) {
      await tx.put(COLLECTION, riskCase.id, riskCase);
      logger?.debug("risk_case.saved_within_tx", {
        caseId: riskCase.id,
        state: riskCase.state,
        transactionId: tx.transactionId,
      });
      return riskCase;
    },
  };
}

export { COLLECTION as RISK_CASES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
