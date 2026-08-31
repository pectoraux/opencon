/**
 * Authority-backed CampaignMatchRunRepository — persists the
 * immutable, append-only campaign match-run records through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W021 §3.4.
 *
 * Storage model: match runs live in the `campaign_match_runs`
 * collection, keyed by record id. Runs are DECISION RECORDS —
 * they are created once and never rewritten (a re-run with the
 * same idempotency key replays the committed record through the
 * IdempotencyStore, it never re-writes).
 *
 * Matching is SELECTION, not authority: this collection carries
 * ONLY the run records (targeting + weights + advisory metadata +
 * baseline/final ranked results + excluded candidates + digest). No
 * campaign, inventory, workflow, settlement, reputation, risk or
 * outcome state is persisted here.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  CampaignMatchRunRecord,
  CampaignMatchRunRepository,
} from "./port.ts";

export const CAMPAIGN_MATCH_RUNS_COLLECTION = "campaign_match_runs";

function byCreatedAt(
  a: CampaignMatchRunRecord,
  b: CampaignMatchRunRecord,
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

export interface AuthorityCampaignMatchRunRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCampaignMatchRunRepository(
  opts: AuthorityCampaignMatchRunRepositoryOptions,
): CampaignMatchRunRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<CampaignMatchRunRecord>(
        CAMPAIGN_MATCH_RUNS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, campaignId) {
      const records = await authority.scan<CampaignMatchRunRecord>(
        CAMPAIGN_MATCH_RUNS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (run) =>
            run.organizationScopeId === organizationScopeId &&
            (campaignId === undefined ||
              run.campaign.campaignId === campaignId),
        )
        .sort(byCreatedAt);
    },

    async createWithinTx(run, tx) {
      const existing = await tx.get<CampaignMatchRunRecord>(
        CAMPAIGN_MATCH_RUNS_COLLECTION,
        run.id,
      );
      if (existing) {
        throw new Error(
          `campaign match run already persisted: ${run.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(CAMPAIGN_MATCH_RUNS_COLLECTION, run.id, run);
      logger?.debug("campaign_match_run.created", {
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
