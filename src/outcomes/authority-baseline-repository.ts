/**
 * Authority-backed CounterfactualBaselineRepository — persists
 * counterfactual/baseline measurements through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W006 §3.4 (counterfactual/baseline
 * measurements).
 *
 * Storage model: baselines live in the `counterfactual_baselines`
 * collection. Records are immutable (created once; there is no update
 * path).
 */

import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type {
  CounterfactualBaseline,
  CounterfactualBaselineRepository,
} from "./port.ts";

const COLLECTION = "counterfactual_baselines";

export interface AuthorityCounterfactualBaselineRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCounterfactualBaselineRepository(
  opts: AuthorityCounterfactualBaselineRepositoryOptions,
): CounterfactualBaselineRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async saveWithinTx(baseline, tx) {
      await tx.put(COLLECTION, baseline.id, baseline);
      logger?.debug("counterfactual_baseline.saved_within_tx", {
        baselineId: baseline.id,
        baselineKind: baseline.baselineKind,
        transactionId: tx.transactionId,
      });
      return baseline;
    },

    async findById(id) {
      const rec = await authority.get<CounterfactualBaseline>(
        COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<CounterfactualBaseline>(
        COLLECTION,
        id,
      );
      return rec !== null;
    },
  };
}

export { COLLECTION as COUNTERFACTUAL_BASELINES_COLLECTION };
export type { AuthorityTransaction };
