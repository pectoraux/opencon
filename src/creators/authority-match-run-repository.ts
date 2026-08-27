/**
 * Authority-backed CreatorMatchRunRepository — persists the
 * immutable, append-only creator match-run records through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W016 §3.4.
 *
 * Storage model: match runs live in the `creator_match_runs`
 * collection, keyed by record id. Runs are DECISION RECORDS —
 * they are created once and never rewritten (a re-run with the
 * same idempotency key replays the committed record through the
 * IdempotencyStore, it never re-writes).
 *
 * Matching is SELECTION, not authority: this collection carries
 * ONLY the run records (requirements + weights + advisory metadata
 * + ranked results + excluded candidates + digest). No workflow,
 * settlement, reputation or risk state is persisted here.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  CreatorMatchRunRecord,
  CreatorMatchRunRepository,
} from "./port.ts";

export const CREATOR_MATCH_RUNS_COLLECTION = "creator_match_runs";

function byCreatedAt(
  a: CreatorMatchRunRecord,
  b: CreatorMatchRunRecord,
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

export interface AuthorityCreatorMatchRunRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCreatorMatchRunRepository(
  opts: AuthorityCreatorMatchRunRepositoryOptions,
): CreatorMatchRunRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(run, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(CREATOR_MATCH_RUNS_COLLECTION, run.id, run);
        logger?.debug("creator_match_run.saved", {
          runId: run.id,
          executionId: execution.executionId,
        });
        return run;
      });
    },

    async findById(id) {
      const rec = await authority.get<CreatorMatchRunRecord>(
        CREATOR_MATCH_RUNS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, campaignId) {
      const records = await authority.scan<CreatorMatchRunRecord>(
        CREATOR_MATCH_RUNS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (run) =>
            run.organizationScopeId === organizationScopeId &&
            (campaignId === undefined ||
              run.campaign?.campaignId === campaignId),
        )
        .sort(byCreatedAt);
    },

    async createWithinTx(run, tx) {
      const existing = await tx.get<CreatorMatchRunRecord>(
        CREATOR_MATCH_RUNS_COLLECTION,
        run.id,
      );
      if (existing) {
        throw new Error(
          `creator match run already persisted: ${run.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(CREATOR_MATCH_RUNS_COLLECTION, run.id, run);
      logger?.debug("creator_match_run.created", {
        runId: run.id,
        organizationScopeId: run.organizationScopeId,
      });
      return run;
    },
  };
}

/**
 * Narrow an AuthorityTransaction to the repository's transactional
 * surface (used by the matching service inside applyIdempotent).
 */
export type { AuthorityTransaction };
