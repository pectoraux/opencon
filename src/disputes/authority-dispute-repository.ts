/**
 * Authority-backed DisputeRepository — persists the challenge/dispute
 * records (with their append-only event histories) through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W010 §3.3 (challenges, disputes and appeals).
 *
 * Storage model: disputes live in the `disputes` collection, keyed by
 * record id, storing the full event history inline (append-only:
 * events are only ever appended; the derived `state` flips through
 * the audited dispute-service command in the same transaction).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { DisputeRecord, DisputeRepository } from "./port.ts";

const COLLECTION = "disputes";

/** The states that gate downstream operations (core vocabulary). */
const GATING_STATES = new Set(["OPEN", "UNDER_REVIEW", "APPEALED"]);

/** The states a subject cannot be re-challenged in (live cycles). */
const LIVE_STATES = new Set(["PENDING_STAKE", "OPEN", "UNDER_REVIEW"]);

function byOpenedAt(a: DisputeRecord, b: DisputeRecord): number {
  const aAt = a.events[0]?.recordedAt ?? "";
  const bAt = b.events[0]?.recordedAt ?? "";
  if (aAt === bAt) return a.id < b.id ? -1 : 1;
  return aAt < bAt ? -1 : 1;
}

export interface AuthorityDisputeRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityDisputeRepository(
  opts: AuthorityDisputeRepositoryOptions,
): DisputeRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(dispute, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, dispute.id, dispute);
        logger?.debug("dispute.saved", {
          disputeId: dispute.id,
          state: dispute.state,
          executionId: execution.executionId,
        });
        return dispute;
      });
    },

    async findById(id) {
      const rec = await authority.get<DisputeRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, states) {
      const records = await authority.scan<DisputeRecord>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((d) => d.organizationScopeId === organizationScopeId)
        .filter((d) => states === undefined || states.includes(d.state))
        .sort(byOpenedAt);
    },

    async findLiveBySubject(organizationScopeId, subjectType, subjectId) {
      const records = await authority.scan<DisputeRecord>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((d) => d.organizationScopeId === organizationScopeId)
        .filter(
          (d) =>
            d.subjectRef.subjectType === subjectType &&
            d.subjectRef.subjectId === subjectId,
        )
        .filter((d) => LIVE_STATES.has(d.state))
        .sort(byOpenedAt);
    },

    async findLiveBySubjectWithinTx(
      organizationScopeId,
      subjectType,
      subjectId,
      tx,
    ) {
      const records = await tx.scan<DisputeRecord>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((d) => d.organizationScopeId === organizationScopeId)
        .filter(
          (d) =>
            d.subjectRef.subjectType === subjectType &&
            d.subjectRef.subjectId === subjectId,
        )
        .filter((d) => LIVE_STATES.has(d.state))
        .sort(byOpenedAt);
    },

    async findActiveBySubjectIds(organizationScopeId, subjectIds) {
      if (subjectIds.length === 0) return [];
      const wanted = new Set(subjectIds);
      const records = await authority.scan<DisputeRecord>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((d) => d.organizationScopeId === organizationScopeId)
        .filter((d) => wanted.has(d.subjectRef.subjectId))
        .filter((d) => GATING_STATES.has(d.state))
        .sort(byOpenedAt);
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<DisputeRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(dispute, tx) {
      await tx.put(COLLECTION, dispute.id, dispute);
      logger?.debug("dispute.created_within_tx", {
        disputeId: dispute.id,
        transactionId: tx.transactionId,
      });
      return dispute;
    },

    async saveWithinTx(dispute, tx) {
      await tx.put(COLLECTION, dispute.id, dispute);
      logger?.debug("dispute.saved_within_tx", {
        disputeId: dispute.id,
        state: dispute.state,
        transactionId: tx.transactionId,
      });
      return dispute;
    },
  };
}

export { COLLECTION as DISPUTES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
