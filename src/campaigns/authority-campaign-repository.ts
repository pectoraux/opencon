/**
 * Authority-backed CampaignRepository + CampaignPolicyRepository —
 * persists the campaign records (with their append-only event
 * histories) and the immutable versioned campaign policies through
 * the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W011 §3.1–3.2.
 *
 * Storage model:
 *  - campaigns live in the `campaigns` collection, keyed by record
 *    id, storing the full event history inline (append-only: events
 *    are only ever appended; the derived `status` flips through the
 *    audited campaign-service command in the same transaction);
 *  - campaign policies live in the `campaign_policies` collection,
 *    keyed by record id, one immutable record per (campaignId,
 *    version) — existing versions are never rewritten.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  CampaignPolicy,
  CampaignPolicyRepository,
  CampaignRecord,
  CampaignRepository,
} from "./port.ts";

const CAMPAIGNS_COLLECTION = "campaigns";
const CAMPAIGN_POLICIES_COLLECTION = "campaign_policies";

function byCreatedAt(a: CampaignRecord, b: CampaignRecord): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function byVersion(
  a: CampaignPolicy,
  b: CampaignPolicy,
): number {
  return a.version - b.version;
}

export interface AuthorityCampaignRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCampaignRepository(
  opts: AuthorityCampaignRepositoryOptions,
): CampaignRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(campaign, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(CAMPAIGNS_COLLECTION, campaign.id, campaign);
        logger?.debug("campaign.saved", {
          campaignId: campaign.id,
          status: campaign.status,
          executionId: execution.executionId,
        });
        return campaign;
      });
    },

    async findById(id) {
      const rec = await authority.get<CampaignRecord>(
        CAMPAIGNS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, statuses) {
      const records = await authority.scan<CampaignRecord>(
        CAMPAIGNS_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .filter((c) => statuses === undefined || statuses.includes(c.status))
        .sort(byCreatedAt);
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<CampaignRecord>(CAMPAIGNS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(campaign, tx) {
      await tx.put(CAMPAIGNS_COLLECTION, campaign.id, campaign);
      logger?.debug("campaign.created_within_tx", {
        campaignId: campaign.id,
        transactionId: tx.transactionId,
      });
      return campaign;
    },

    async saveWithinTx(campaign, tx) {
      await tx.put(CAMPAIGNS_COLLECTION, campaign.id, campaign);
      logger?.debug("campaign.saved_within_tx", {
        campaignId: campaign.id,
        status: campaign.status,
        transactionId: tx.transactionId,
      });
      return campaign;
    },
  };
}

export function createAuthorityCampaignPolicyRepository(
  opts: AuthorityCampaignRepositoryOptions,
): CampaignPolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function scanPolicies(): Promise<CampaignPolicy[]> {
    const records = await authority.scan<CampaignPolicy>(
      CAMPAIGN_POLICIES_COLLECTION,
    );
    return records.map((r) => r.value);
  }

  return {
    async findById(id) {
      const rec = await authority.get<CampaignPolicy>(
        CAMPAIGN_POLICIES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findVersion(campaignId, version) {
      const policies = await scanPolicies();
      return (
        policies.find(
          (p) => p.campaignId === campaignId && p.version === version,
        ) ?? null
      );
    },

    async listByCampaign(campaignId) {
      const policies = await scanPolicies();
      return policies
        .filter((p) => p.campaignId === campaignId)
        .sort(byVersion);
    },

    async findVersionWithinTx(campaignId, version, tx) {
      const records = await tx.scan<CampaignPolicy>(
        CAMPAIGN_POLICIES_COLLECTION,
      );
      const policies = records.map((r) => r.value);
      return (
        policies.find(
          (p) => p.campaignId === campaignId && p.version === version,
        ) ?? null
      );
    },

    async findLatestWithinTx(campaignId, tx) {
      const records = await tx.scan<CampaignPolicy>(
        CAMPAIGN_POLICIES_COLLECTION,
      );
      const policies = records
        .map((r) => r.value)
        .filter((p) => p.campaignId === campaignId);
      if (policies.length === 0) return null;
      return policies.reduce((latest, p) =>
        p.version > latest.version ? p : latest,
      );
    },

    async createWithinTx(policy, tx) {
      await tx.put(CAMPAIGN_POLICIES_COLLECTION, policy.id, policy);
      logger?.debug("campaign_policy.created_within_tx", {
        policyId: policy.id,
        campaignId: policy.campaignId,
        version: policy.version,
        transactionId: tx.transactionId,
      });
      return policy;
    },
  };
}

export {
  CAMPAIGNS_COLLECTION,
  CAMPAIGN_POLICIES_COLLECTION,
};
export type { ExecutionContext, AuthorityTransaction };
