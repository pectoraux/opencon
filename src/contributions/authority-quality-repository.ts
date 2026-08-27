/**
 * NET-W013 authority-backed repositories — quality policies, quality
 * evaluations (supersession chains), advisory quality scores and
 * moderation decisions (append-only histories).
 *
 * The pattern follows authority-helpfulness-repository.ts: all state
 * lives in the PostgreSQL authority collections below; the WithinTx
 * twins read/write through the caller's authoritative transaction so
 * the mutation + the idempotency record commit atomically.
 *
 * Record identity:
 *  - quality_policies     — key `{policyId}:v{version}` (immutable);
 *  - quality_evaluations  — key `{recordId}` + the contribution-id
 *    index `contribution:{contributionId}` (latest pointer, updated
 *    atomically on supersession);
 *  - advisory_quality_scores — key `{recordId}` (append-only);
 *  - moderation_decisions — key `{recordId}` (append-only, sorted by
 *    (decidedAt, id) on read).
 */

import type { PostgresAuthority } from "../core/postgres-authority.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  AdvisoryQualityScore,
  AdvisoryQualityScoreRepository,
  ModerationDecisionRecord,
  ModerationDecisionRepository,
  QualityEvaluation,
  QualityEvaluationRepository,
  QualityPolicy,
  QualityPolicyRepository,
} from "./port.ts";

const QUALITY_POLICIES_COLLECTION = "quality_policies";
const QUALITY_EVALUATIONS_COLLECTION = "quality_evaluations";
const ADVISORY_QUALITY_SCORES_COLLECTION = "advisory_quality_scores";
const MODERATION_DECISIONS_COLLECTION = "moderation_decisions";

/** The neutral contribution-id → latest-evaluation-id index key. */
function latestEvaluationIndexKey(contributionId: string): string {
  return `latest:${contributionId}`;
}

function byVersion(a: QualityPolicy, b: QualityPolicy): number {
  return a.version - b.version;
}

export interface AuthorityQualityRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityQualityPolicyRepository(
  opts: AuthorityQualityRepositoryOptions,
): QualityPolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function scanPolicies(): Promise<QualityPolicy[]> {
    const records = await authority.scan<QualityPolicy>(
      QUALITY_POLICIES_COLLECTION,
    );
    return records.map((r) => r.value);
  }

  return {
    async findById(id) {
      const rec = await authority.get<QualityPolicy>(
        QUALITY_POLICIES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findVersion(policyId, version) {
      const all = await scanPolicies();
      return (
        all.find(
          (p) => p.policyId === policyId && p.version === version,
        ) ?? null
      );
    },

    async listByPolicyId(policyId) {
      const all = await scanPolicies();
      return all.filter((p) => p.policyId === policyId).sort(byVersion);
    },

    async findVersionWithinTx(policyId, version, tx) {
      const rec = await tx.get<QualityPolicy>(
        QUALITY_POLICIES_COLLECTION,
        `${policyId}:v${String(version)}`,
      );
      if (rec) return rec.value;
      const records = await tx.scan<QualityPolicy>(QUALITY_POLICIES_COLLECTION);
      return (
        records
          .map((r) => r.value)
          .find((p) => p.policyId === policyId && p.version === version) ??
        null
      );
    },

    async findLatestWithinTx(policyId, tx) {
      const records = await tx.scan<QualityPolicy>(QUALITY_POLICIES_COLLECTION);
      const versions = records
        .map((r) => r.value)
        .filter((p) => p.policyId === policyId)
        .sort(byVersion);
      return versions.length > 0 ? versions[versions.length - 1]! : null;
    },

    async createWithinTx(policy, tx) {
      await tx.put(
        QUALITY_POLICIES_COLLECTION,
        `${policy.policyId}:v${String(policy.version)}`,
        policy,
      );
      logger?.debug("quality_policy.created_within_tx", {
        policyId: policy.policyId,
        version: policy.version,
        transactionId: tx.transactionId,
      });
      return policy;
    },
  };
}

export function createAuthorityQualityEvaluationRepository(
  opts: AuthorityQualityRepositoryOptions,
): QualityEvaluationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function scanEvaluations(): Promise<QualityEvaluation[]> {
    const records = await authority.scan<QualityEvaluation>(
      QUALITY_EVALUATIONS_COLLECTION,
    );
    // The latest-evaluation index entries (key `latest:{cid}`, value
    // = evaluation id string) share the collection — exclude them by
    // KEY before mapping values.
    return records
      .filter((r) => !r.key.startsWith("latest:"))
      .map((r) => r.value)
      .sort((a, b) =>
        a.recordedAt === b.recordedAt
          ? a.id < b.id
            ? -1
            : 1
          : a.recordedAt < b.recordedAt
            ? -1
            : 1,
      );
  }

  return {
    async findById(id) {
      const rec = await authority.get<QualityEvaluation>(
        QUALITY_EVALUATIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findLatestByContributionId(contributionId) {
      const index = await authority.get<string>(
        QUALITY_EVALUATIONS_COLLECTION,
        latestEvaluationIndexKey(contributionId),
      );
      if (index) {
        const rec = await authority.get<QualityEvaluation>(
          QUALITY_EVALUATIONS_COLLECTION,
          index.value,
        );
        if (rec) return rec.value;
      }
      const all = await scanEvaluations();
      return (
        all
          .filter((e) => e.contributionId === contributionId)
          .slice(-1)[0] ?? null
      );
    },

    async listByContributionId(contributionId) {
      const all = await scanEvaluations();
      return all.filter((e) => e.contributionId === contributionId);
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<QualityEvaluation>(
        QUALITY_EVALUATIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findLatestByContributionIdWithinTx(contributionId, tx) {
      const index = await tx.get<string>(
        QUALITY_EVALUATIONS_COLLECTION,
        latestEvaluationIndexKey(contributionId),
      );
      if (index) {
        const rec = await tx.get<QualityEvaluation>(
          QUALITY_EVALUATIONS_COLLECTION,
          index.value,
        );
        if (rec) return rec.value;
      }
      const records = await tx.scan<QualityEvaluation>(
        QUALITY_EVALUATIONS_COLLECTION,
      );
      const all = records
        .filter((r) => !r.key.startsWith("latest:"))
        .map((r) => r.value)
        .filter((e) => e.contributionId === contributionId)
        .sort((a, b) =>
          a.recordedAt === b.recordedAt ? (a.id < b.id ? -1 : 1) : a.recordedAt < b.recordedAt ? -1 : 1,
        );
      return all.length > 0 ? all[all.length - 1]! : null;
    },

    async createWithinTx(evaluation, tx) {
      await tx.put(QUALITY_EVALUATIONS_COLLECTION, evaluation.id, evaluation);
      await tx.put(
        QUALITY_EVALUATIONS_COLLECTION,
        latestEvaluationIndexKey(evaluation.contributionId),
        evaluation.id,
      );
      logger?.debug("quality_evaluation.created_within_tx", {
        evaluationId: evaluation.id,
        contributionId: evaluation.contributionId,
        transactionId: tx.transactionId,
      });
      return evaluation;
    },

    async saveWithinTx(evaluation, tx) {
      await tx.put(QUALITY_EVALUATIONS_COLLECTION, evaluation.id, evaluation);
      logger?.debug("quality_evaluation.saved_within_tx", {
        evaluationId: evaluation.id,
        supersededBy: evaluation.supersededByEvaluationId,
        transactionId: tx.transactionId,
      });
      return evaluation;
    },
  };
}

export function createAuthorityAdvisoryQualityScoreRepository(
  opts: AuthorityQualityRepositoryOptions,
): AdvisoryQualityScoreRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<AdvisoryQualityScore>(
        ADVISORY_QUALITY_SCORES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByContribution(contributionId) {
      const records = await authority.scan<AdvisoryQualityScore>(
        ADVISORY_QUALITY_SCORES_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((a) => a.contributionId === contributionId)
        .sort((a, b) =>
          a.recordedAt === b.recordedAt ? (a.id < b.id ? -1 : 1) : a.recordedAt < b.recordedAt ? -1 : 1,
        );
    },

    async listByContributionWithinTx(contributionId, tx) {
      const records = await tx.scan<AdvisoryQualityScore>(
        ADVISORY_QUALITY_SCORES_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((a) => a.contributionId === contributionId)
        .sort((a, b) =>
          a.recordedAt === b.recordedAt ? (a.id < b.id ? -1 : 1) : a.recordedAt < b.recordedAt ? -1 : 1,
        );
    },

    async createWithinTx(record, tx) {
      await tx.put(ADVISORY_QUALITY_SCORES_COLLECTION, record.id, record);
      logger?.debug("advisory_quality_score.created_within_tx", {
        advisoryScoreId: record.id,
        contributionId: record.contributionId,
        transactionId: tx.transactionId,
      });
      return record;
    },
  };
}

export function createAuthorityModerationDecisionRepository(
  opts: AuthorityQualityRepositoryOptions,
): ModerationDecisionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  function byDecidedAt(
    a: ModerationDecisionRecord,
    b: ModerationDecisionRecord,
  ): number {
    if (a.decidedAt === b.decidedAt) return a.id < b.id ? -1 : 1;
    return a.decidedAt < b.decidedAt ? -1 : 1;
  }

  return {
    async findById(id) {
      const rec = await authority.get<ModerationDecisionRecord>(
        MODERATION_DECISIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByContribution(contributionId) {
      const records = await authority.scan<ModerationDecisionRecord>(
        MODERATION_DECISIONS_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((d) => d.contributionId === contributionId)
        .sort(byDecidedAt);
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ModerationDecisionRecord>(
        MODERATION_DECISIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByContributionWithinTx(contributionId, tx) {
      const records = await tx.scan<ModerationDecisionRecord>(
        MODERATION_DECISIONS_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((d) => d.contributionId === contributionId)
        .sort(byDecidedAt);
    },

    async createWithinTx(record, tx) {
      await tx.put(MODERATION_DECISIONS_COLLECTION, record.id, record);
      logger?.debug("moderation_decision.created_within_tx", {
        moderationDecisionId: record.id,
        contributionId: record.contributionId,
        transactionId: tx.transactionId,
      });
      return record;
    },
  };
}

export {
  QUALITY_POLICIES_COLLECTION,
  QUALITY_EVALUATIONS_COLLECTION,
  ADVISORY_QUALITY_SCORES_COLLECTION,
  MODERATION_DECISIONS_COLLECTION,
};

export type { ExecutionContext, AuthorityTransaction };
