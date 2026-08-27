/**
 * Authority-backed NET-W017 repositories — persist the engagement /
 * acceptance-policy / usage-rights / UGC-production /
 * deliverable / submission / batch records through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W017.md §3.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `engagements`               — the lifecycle subject records
 *    (lifecycle fields are mutated ONLY through the canonical
 *    WorkflowService's LifecycleRepository surface below — the same
 *    contract every lifecycle subject repository exposes);
 *  - `creator_acceptance_policies` — versioned policy records
 *    (append-only; the latest version per (org, creator) is
 *    effective);
 *  - `usage_rights_grants` / `usage_rights_revocations` — the
 *    immutable grant records + their (at most one) revocations;
 *  - `ugc_productions`, `ugc_deliverables`, `ugc_submissions` — the
 *    append-only UGC lineage records;
 *  - `engagement_batches` — the auto-match decision records.
 *
 * UGC and rights logic introduces NO second workflow engine, ledger,
 * reputation engine, risk authority or platform ownership layer: the
 * only lifecycle mutation surface here is the sanctioned
 * LifecycleRepository structural contract consumed by /workflows.
 */

import { randomUUID } from "node:crypto";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import { TERMINAL_LIFECYCLE_STATES } from "../core/workflow.ts";
import type {
  CreatorAcceptancePolicyRecord,
  CreatorAcceptancePolicyRepository,
  Engagement,
  EngagementBatchRecord,
  EngagementBatchRepository,
  EngagementRepository,
  UgcDeliverableRepository,
  UgcDeliverableVersion,
  UgcProduction,
  UgcProductionRepository,
  UgcSubmission,
  UgcSubmissionRepository,
  UsageRightsGrant,
  UsageRightsRepository,
  UsageRightsRevocation,
} from "./port.ts";

export const ENGAGEMENTS_COLLECTION = "engagements";
export const CREATOR_ACCEPTANCE_POLICIES_COLLECTION =
  "creator_acceptance_policies";
export const USAGE_RIGHTS_GRANTS_COLLECTION = "usage_rights_grants";
export const USAGE_RIGHTS_REVOCATIONS_COLLECTION =
  "usage_rights_revocations";
export const UGC_PRODUCTIONS_COLLECTION = "ugc_productions";
export const UGC_DELIVERABLES_COLLECTION = "ugc_deliverables";
export const UGC_SUBMISSIONS_COLLECTION = "ugc_submissions";
export const ENGAGEMENT_BATCHES_COLLECTION = "engagement_batches";

export interface AuthorityEngagementRepositoriesOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function byCreatedAt(a: { readonly createdAt: string; readonly id: string }, b: { readonly createdAt: string; readonly id: string }): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function byOpenedAt(a: UgcProduction, b: UgcProduction): number {
  if (a.openedAt === b.openedAt) return a.id < b.id ? -1 : 1;
  return a.openedAt < b.openedAt ? -1 : 1;
}

function byRecordedAt(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  return byCreatedAt(a, b);
}

function bySubmittedAt(a: UgcSubmission, b: UgcSubmission): number {
  if (a.submittedAt === b.submittedAt) return a.id < b.id ? -1 : 1;
  return a.submittedAt < b.submittedAt ? -1 : 1;
}

function isNonTerminal(engagement: Engagement): boolean {
  return !(TERMINAL_LIFECYCLE_STATES as readonly string[]).includes(
    engagement.state,
  );
}

// ---------------------------------------------------------------------------
// Engagement repository (+ the LifecycleRepository surface)
// ---------------------------------------------------------------------------

export function createAuthorityEngagementRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): EngagementRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(engagement, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(ENGAGEMENTS_COLLECTION, engagement.id, engagement);
        logger?.debug("engagement.saved", {
          engagementId: engagement.id,
          executionId: execution.executionId,
        });
        return engagement;
      });
    },

    async findById(id) {
      const rec = await authority.get<Engagement>(ENGAGEMENTS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<Engagement>(ENGAGEMENTS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(engagement, tx) {
      const existing = await tx.get<Engagement>(
        ENGAGEMENTS_COLLECTION,
        engagement.id,
      );
      if (existing) {
        throw new Error(
          `engagement already persisted: ${engagement.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(ENGAGEMENTS_COLLECTION, engagement.id, engagement);
      logger?.debug("engagement.created", {
        engagementId: engagement.id,
        organizationScopeId: engagement.organizationScopeId,
      });
      return engagement;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<Engagement>(
        ENGAGEMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (engagement) =>
            engagement.organizationScopeId === organizationScopeId &&
            (!filters?.campaignId ||
              engagement.campaignId === filters.campaignId) &&
            (!filters?.creatorPersonId ||
              engagement.creatorPersonId === filters.creatorPersonId) &&
            (!filters?.states ||
              (filters.states as readonly string[]).includes(
                engagement.state,
              )),
        )
        .sort(byCreatedAt);
    },

    async listNonTerminalByCreator(organizationScopeId, creatorPersonId) {
      const records = await authority.scan<Engagement>(
        ENGAGEMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (engagement) =>
            engagement.organizationScopeId === organizationScopeId &&
            engagement.creatorPersonId === creatorPersonId &&
            isNonTerminal(engagement),
        )
        .sort(byCreatedAt);
    },

    async findNonTerminalWithinTx(organizationScopeId, campaignId, creatorPersonId, tx) {
      const records = await tx.scan<Engagement>(ENGAGEMENTS_COLLECTION);
      for (const rec of records) {
        const engagement = rec.value;
        if (
          engagement.organizationScopeId === organizationScopeId &&
          engagement.campaignId === campaignId &&
          engagement.creatorPersonId === creatorPersonId &&
          isNonTerminal(engagement)
        ) {
          return engagement;
        }
      }
      return null;
    },

    // -- LifecycleRepository structural surface (consumed by the
    //    canonical WorkflowService — the SOLE lifecycle authority).

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<Engagement>(ENGAGEMENTS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async saveWithinTx(subject, expectedVersion, execution, tx) {
      // Re-read the current subject within the tx (sees uncommitted
      // writes in this tx). Defense in depth: the WorkflowService has
      // already checked expectedVersion; we re-check here so even a
      // caller bypassing the workflow service cannot write stale.
      const current = await tx.get<Engagement>(ENGAGEMENTS_COLLECTION, subject.id);
      if (!current) {
        throw new NotFoundError(
          `engagement ${subject.id} not found within tx`,
          { engagementId: subject.id },
        );
      }
      if (current.value.version !== expectedVersion) {
        const err = new Error(
          `stale writer: expected version ${expectedVersion}, authoritative ${current.value.version}`,
        );
        err.name = "ConcurrentTransitionError";
        throw err;
      }
      // Merge the workflow service's lifecycle mutation onto the
      // current entity, preserving ALL domain fields (the record is
      // static after creation except the lifecycle fields).
      const merged: Engagement = {
        ...current.value,
        ...subject,
        creatorPersonId: current.value.creatorPersonId,
        creatorProfileId: current.value.creatorProfileId,
        creatorProfileVersion: current.value.creatorProfileVersion,
        campaignId: current.value.campaignId,
        campaignPolicyVersion: current.value.campaignPolicyVersion,
        matchRunId: current.value.matchRunId,
        opportunityId: current.value.opportunityId,
        requestedRights: current.value.requestedRights,
        compensation: current.value.compensation,
        brief: current.value.brief,
        formatVersion: current.value.formatVersion,
      };
      await tx.put(ENGAGEMENTS_COLLECTION, subject.id, merged);
      logger?.debug("engagement.saved_within_tx", {
        engagementId: subject.id,
        fromVersion: current.value.version,
        toVersion: merged.version,
        transactionId: tx.transactionId,
      });
      return merged;
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance-policy repository
// ---------------------------------------------------------------------------

export function createAuthorityAcceptancePolicyRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): CreatorAcceptancePolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function findLatestWithinScope(
    organizationScopeId: string,
    creatorPersonId: string,
    scan: () => Promise<readonly { readonly value: CreatorAcceptancePolicyRecord }[]>,
  ): Promise<CreatorAcceptancePolicyRecord | null> {
    const records = await scan();
    let latest: CreatorAcceptancePolicyRecord | null = null;
    for (const rec of records) {
      const policy = rec.value;
      if (
        policy.organizationScopeId === organizationScopeId &&
        policy.creatorPersonId === creatorPersonId &&
        (latest === null || policy.version > latest.version)
      ) {
        latest = policy;
      }
    }
    return latest;
  }

  return {
    async save(policy, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(CREATOR_ACCEPTANCE_POLICIES_COLLECTION, policy.id, policy);
        logger?.debug("creator_acceptance_policy.saved", {
          policyId: policy.id,
          executionId: execution.executionId,
        });
        return policy;
      });
    },

    async findLatest(organizationScopeId, creatorPersonId) {
      return findLatestWithinScope(
        organizationScopeId,
        creatorPersonId,
        () =>
          authority.scan<CreatorAcceptancePolicyRecord>(
            CREATOR_ACCEPTANCE_POLICIES_COLLECTION,
          ),
      );
    },

    async findLatestWithinTx(organizationScopeId, creatorPersonId, tx) {
      return findLatestWithinScope(
        organizationScopeId,
        creatorPersonId,
        () =>
          tx.scan<CreatorAcceptancePolicyRecord>(
            CREATOR_ACCEPTANCE_POLICIES_COLLECTION,
          ),
      );
    },

    async createWithinTx(policy, tx) {
      const existing = await tx.get<CreatorAcceptancePolicyRecord>(
        CREATOR_ACCEPTANCE_POLICIES_COLLECTION,
        policy.id,
      );
      if (existing) {
        throw new Error(
          `acceptance policy already persisted: ${policy.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(CREATOR_ACCEPTANCE_POLICIES_COLLECTION, policy.id, policy);
      logger?.debug("creator_acceptance_policy.created", {
        policyId: policy.id,
        organizationScopeId: policy.organizationScopeId,
        version: policy.version,
      });
      return policy;
    },
  };
}

// ---------------------------------------------------------------------------
// Usage-rights repository (grants + revocations)
// ---------------------------------------------------------------------------

export function createAuthorityUsageRightsRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): UsageRightsRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function findByEngagementWithinScope(
    organizationScopeId: string,
    engagementId: string,
    scan: () => Promise<readonly { readonly value: UsageRightsGrant }[]>,
  ): Promise<UsageRightsGrant | null> {
    const records = await scan();
    for (const rec of records) {
      const grant = rec.value;
      if (
        grant.organizationScopeId === organizationScopeId &&
        grant.engagementId === engagementId
      ) {
        return grant;
      }
    }
    return null;
  }

  return {
    async save(grant, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(USAGE_RIGHTS_GRANTS_COLLECTION, grant.id, grant);
        logger?.debug("usage_rights_grant.saved", {
          grantId: grant.id,
          executionId: execution.executionId,
        });
        return grant;
      });
    },

    async findById(grantId) {
      const rec = await authority.get<UsageRightsGrant>(
        USAGE_RIGHTS_GRANTS_COLLECTION,
        grantId,
      );
      return rec ? rec.value : null;
    },

    async findByEngagement(organizationScopeId, engagementId) {
      return findByEngagementWithinScope(
        organizationScopeId,
        engagementId,
        () =>
          authority.scan<UsageRightsGrant>(USAGE_RIGHTS_GRANTS_COLLECTION),
      );
    },

    async findByEngagementWithinTx(organizationScopeId, engagementId, tx) {
      return findByEngagementWithinScope(
        organizationScopeId,
        engagementId,
        () => tx.scan<UsageRightsGrant>(USAGE_RIGHTS_GRANTS_COLLECTION),
      );
    },

    async createWithinTx(grant, tx) {
      const existing = await tx.get<UsageRightsGrant>(
        USAGE_RIGHTS_GRANTS_COLLECTION,
        grant.id,
      );
      if (existing) {
        throw new Error(
          `usage rights grant already persisted: ${grant.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(USAGE_RIGHTS_GRANTS_COLLECTION, grant.id, grant);
      logger?.debug("usage_rights_grant.created", {
        grantId: grant.id,
        organizationScopeId: grant.organizationScopeId,
        engagementId: grant.engagementId,
      });
      return grant;
    },

    async saveRevocation(revocation, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(
          USAGE_RIGHTS_REVOCATIONS_COLLECTION,
          revocation.id,
          revocation,
        );
        logger?.debug("usage_rights_revocation.saved", {
          revocationId: revocation.id,
          executionId: execution.executionId,
        });
        return revocation;
      });
    },

    async findRevocation(grantId) {
      const records = await authority.scan<UsageRightsRevocation>(
        USAGE_RIGHTS_REVOCATIONS_COLLECTION,
      );
      for (const rec of records) {
        if (rec.value.grantId === grantId) return rec.value;
      }
      return null;
    },

    async findRevocationWithinTx(grantId, tx) {
      const records = await tx.scan<UsageRightsRevocation>(
        USAGE_RIGHTS_REVOCATIONS_COLLECTION,
      );
      for (const rec of records) {
        if (rec.value.grantId === grantId) return rec.value;
      }
      return null;
    },

    async createRevocationWithinTx(revocation, tx) {
      const existing = await tx.get<UsageRightsRevocation>(
        USAGE_RIGHTS_REVOCATIONS_COLLECTION,
        revocation.id,
      );
      if (existing) {
        throw new Error(
          `usage rights revocation already persisted: ${revocation.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(
        USAGE_RIGHTS_REVOCATIONS_COLLECTION,
        revocation.id,
        revocation,
      );
      logger?.debug("usage_rights_revocation.created", {
        revocationId: revocation.id,
        grantId: revocation.grantId,
      });
      return revocation;
    },

    async listByOrganization(organizationScopeId, engagementId) {
      const records = await authority.scan<UsageRightsGrant>(
        USAGE_RIGHTS_GRANTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (grant) =>
            grant.organizationScopeId === organizationScopeId &&
            (engagementId === undefined ||
              grant.engagementId === engagementId),
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// UGC production / deliverable / submission repositories
// ---------------------------------------------------------------------------

export function createAuthorityUgcProductionRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): UgcProductionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function findByEngagementWithinScope(
    organizationScopeId: string,
    engagementId: string,
    scan: () => Promise<readonly { readonly value: UgcProduction }[]>,
  ): Promise<UgcProduction | null> {
    const records = await scan();
    for (const rec of records) {
      const production = rec.value;
      if (
        production.organizationScopeId === organizationScopeId &&
        production.engagementId === engagementId
      ) {
        return production;
      }
    }
    return null;
  }

  return {
    async save(production, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(UGC_PRODUCTIONS_COLLECTION, production.id, production);
        logger?.debug("ugc_production.saved", {
          productionId: production.id,
          executionId: execution.executionId,
        });
        return production;
      });
    },

    async findById(id) {
      const rec = await authority.get<UgcProduction>(
        UGC_PRODUCTIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(production, tx) {
      const existing = await tx.get<UgcProduction>(
        UGC_PRODUCTIONS_COLLECTION,
        production.id,
      );
      if (existing) {
        throw new Error(
          `ugc production already persisted: ${production.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(UGC_PRODUCTIONS_COLLECTION, production.id, production);
      logger?.debug("ugc_production.created", {
        productionId: production.id,
        organizationScopeId: production.organizationScopeId,
        engagementId: production.engagementId,
      });
      return production;
    },

    async findByEngagement(organizationScopeId, engagementId) {
      return findByEngagementWithinScope(
        organizationScopeId,
        engagementId,
        () => authority.scan<UgcProduction>(UGC_PRODUCTIONS_COLLECTION),
      );
    },

    async listByOrganization(organizationScopeId, engagementId) {
      const records = await authority.scan<UgcProduction>(
        UGC_PRODUCTIONS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (production) =>
            production.organizationScopeId === organizationScopeId &&
            (engagementId === undefined ||
              production.engagementId === engagementId),
        )
        .sort(byOpenedAt);
    },
  };
}

export function createAuthorityUgcDeliverableRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): UgcDeliverableRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(deliverable, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(UGC_DELIVERABLES_COLLECTION, deliverable.id, deliverable);
        logger?.debug("ugc_deliverable.saved", {
          deliverableId: deliverable.id,
          executionId: execution.executionId,
        });
        return deliverable;
      });
    },

    async createWithinTx(deliverable, tx) {
      const existing = await tx.get<UgcDeliverableVersion>(
        UGC_DELIVERABLES_COLLECTION,
        deliverable.id,
      );
      if (existing) {
        throw new Error(
          `ugc deliverable already persisted: ${deliverable.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(UGC_DELIVERABLES_COLLECTION, deliverable.id, deliverable);
      logger?.debug("ugc_deliverable.created", {
        deliverableId: deliverable.id,
        productionId: deliverable.productionId,
        deliverableKey: deliverable.deliverableKey,
        version: deliverable.version,
      });
      return deliverable;
    },

    async listByProduction(organizationScopeId, productionId) {
      const records = await authority.scan<UgcDeliverableVersion>(
        UGC_DELIVERABLES_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (deliverable) =>
            deliverable.organizationScopeId === organizationScopeId &&
            deliverable.productionId === productionId,
        )
        .sort((a, b) =>
          a.deliverableKey === b.deliverableKey
            ? a.version - b.version
            : a.deliverableKey < b.deliverableKey
              ? -1
              : 1,
        );
    },

    async countByKeyWithinTx(productionId, deliverableKey, tx) {
      const records = await tx.scan<UgcDeliverableVersion>(
        UGC_DELIVERABLES_COLLECTION,
      );
      let count = 0;
      for (const rec of records) {
        if (
          rec.value.productionId === productionId &&
          rec.value.deliverableKey === deliverableKey
        ) {
          count += 1;
        }
      }
      return count;
    },
  };
}

export function createAuthorityUgcSubmissionRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): UgcSubmissionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(submission, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(UGC_SUBMISSIONS_COLLECTION, submission.id, submission);
        logger?.debug("ugc_submission.saved", {
          submissionId: submission.id,
          executionId: execution.executionId,
        });
        return submission;
      });
    },

    async createWithinTx(submission, tx) {
      const existing = await tx.get<UgcSubmission>(
        UGC_SUBMISSIONS_COLLECTION,
        submission.id,
      );
      if (existing) {
        throw new Error(
          `ugc submission already persisted: ${submission.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(UGC_SUBMISSIONS_COLLECTION, submission.id, submission);
      logger?.debug("ugc_submission.created", {
        submissionId: submission.id,
        organizationScopeId: submission.organizationScopeId,
        productionId: submission.productionId,
      });
      return submission;
    },

    async findById(id) {
      const rec = await authority.get<UgcSubmission>(
        UGC_SUBMISSIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByProduction(organizationScopeId, productionId) {
      const records = await authority.scan<UgcSubmission>(
        UGC_SUBMISSIONS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (submission) =>
            submission.organizationScopeId === organizationScopeId &&
            submission.productionId === productionId,
        )
        .sort(bySubmittedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Engagement batch repository
// ---------------------------------------------------------------------------

export function createAuthorityEngagementBatchRepository(
  opts: AuthorityEngagementRepositoriesOptions,
): EngagementBatchRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(batch, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(ENGAGEMENT_BATCHES_COLLECTION, batch.id, batch);
        logger?.debug("engagement_batch.saved", {
          batchId: batch.id,
          executionId: execution.executionId,
        });
        return batch;
      });
    },

    async createWithinTx(batch, tx) {
      const existing = await tx.get<EngagementBatchRecord>(
        ENGAGEMENT_BATCHES_COLLECTION,
        batch.id,
      );
      if (existing) {
        throw new Error(
          `engagement batch already persisted: ${batch.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(ENGAGEMENT_BATCHES_COLLECTION, batch.id, batch);
      logger?.debug("engagement_batch.created", {
        batchId: batch.id,
        organizationScopeId: batch.organizationScopeId,
        matchRunId: batch.matchRunId,
      });
      return batch;
    },

    async findById(id) {
      const rec = await authority.get<EngagementBatchRecord>(
        ENGAGEMENT_BATCHES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, matchRunId) {
      const records = await authority.scan<EngagementBatchRecord>(
        ENGAGEMENT_BATCHES_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (batch) =>
            batch.organizationScopeId === organizationScopeId &&
            (matchRunId === undefined || batch.matchRunId === matchRunId),
        )
        .sort(byRecordedAt);
    },
  };
}

/** Allocate an engagement id (exposed for tests). */
export function allocateEngagementId(): string {
  return randomUUID();
}

/** Narrow an AuthorityTransaction to the repositories' transactional
 * surface (re-exported for the composition root). */
export type { AuthorityTransaction };
