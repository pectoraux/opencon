/**
 * Authority-backed CrossPromotionClearingRepository — persists the
 * immutable cross-promotion clearing execution records (append-only;
 * NET-W020 work order §3.3).
 *
 * Storage model: clearing records live in the
 * `cross_promotion_clearings` collection keyed by clearing id. The
 * create-once pair constraint (ONE record per
 * (sourceContributionId, targetPlacementId)) is enforced by the
 * clearing service's in-transaction pair check (the W019
 * active-placement pattern); idempotent recording is owned by the
 * IdempotencyStore.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  CrossPromotionClearingRecord,
  CrossPromotionClearingRepository,
} from "./port.ts";

const COLLECTION = "cross_promotion_clearings";

export interface AuthorityCrossPromotionClearingRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCrossPromotionClearingRepository(
  opts: AuthorityCrossPromotionClearingRepositoryOptions,
): CrossPromotionClearingRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<CrossPromotionClearingRecord>(
        COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<CrossPromotionClearingRecord>(
        COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .sort((a, b) => {
          const ta = Date.parse(a.clearedAt);
          const tb = Date.parse(b.clearedAt);
          if (ta !== tb) return ta - tb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    },

    async findByPair(organizationScopeId, sourceContributionId, targetPlacementId) {
      const records = await authority.scan<CrossPromotionClearingRecord>(
        COLLECTION,
      );
      const match = records.find(
        (r) =>
          r.value.organizationScopeId === organizationScopeId &&
          r.value.sourceContributionId === sourceContributionId &&
          r.value.targetPlacementId === targetPlacementId,
      );
      return match ? match.value : null;
    },

    async findByPairWithinTx(
      organizationScopeId,
      sourceContributionId,
      targetPlacementId,
      tx,
    ) {
      const records = await tx.scan<CrossPromotionClearingRecord>(COLLECTION);
      const match = records.find(
        (r) =>
          r.value.organizationScopeId === organizationScopeId &&
          r.value.sourceContributionId === sourceContributionId &&
          r.value.targetPlacementId === targetPlacementId,
      );
      return match ? match.value : null;
    },

    async createWithinTx(clearing, tx) {
      logger?.debug("cross_promotion_clearing.create_within_tx", {
        clearingId: clearing.id,
        organizationScopeId: clearing.organizationScopeId,
        sourceContributionId: clearing.sourceContributionId,
        targetPlacementId: clearing.targetPlacementId,
      });
      await tx.put(COLLECTION, clearing.id, clearing);
      return clearing;
    },
  };
}
