/**
 * Authority-backed RiskSignalRepository — persists the immutable
 * risk-signal records through the PostgreSQL authority boundary
 * (NET-W003).
 *
 * Work order ref: NET-W009 §3.2 (first-class risk signals).
 *
 * Storage model: signals live in the `risk_signals` collection, keyed
 * by record id. Corrections are append-only: the correction signal is
 * a NEW record carrying `supersedesSignalId`; the original's
 * `supersededBySignalId` back-pointer flips in the same authoritative
 * transaction (a state flip, never a content rewrite). Listings filter
 * deterministically (recordedAt, then id).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { RiskSignal, RiskSignalRepository } from "./port.ts";

const COLLECTION = "risk_signals";

export interface AuthorityRiskSignalRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function sortSignals(signals: readonly RiskSignal[]): RiskSignal[] {
  return [...signals].sort((a, b) =>
    a.recordedAt === b.recordedAt
      ? a.id < b.id
        ? -1
        : 1
      : a.recordedAt < b.recordedAt
        ? -1
        : 1,
  );
}

export function createAuthorityRiskSignalRepository(
  opts: AuthorityRiskSignalRepositoryOptions,
): RiskSignalRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(signal, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, signal.id, signal);
        logger?.debug("risk_signal.saved", {
          signalId: signal.id,
          category: signal.category,
          executionId: execution.executionId,
        });
        return signal;
      });
    },

    async findById(id) {
      const rec = await authority.get<RiskSignal>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubject(organizationScopeId, subjectPersonId) {
      const records = await authority.scan<RiskSignal>(COLLECTION);
      return sortSignals(
        records
          .map((r) => r.value)
          .filter(
            (s) =>
              s.organizationScopeId === organizationScopeId &&
              s.subjectPersonId === subjectPersonId,
          ),
      );
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<RiskSignal>(COLLECTION);
      return sortSignals(
        records
          .map((r) => r.value)
          .filter((s) => s.organizationScopeId === organizationScopeId),
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<RiskSignal>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubjectWithinTx(organizationScopeId, subjectPersonId, tx) {
      const records = await tx.scan<RiskSignal>(COLLECTION);
      return sortSignals(
        records
          .map((r) => r.value)
          .filter(
            (s) =>
              s.organizationScopeId === organizationScopeId &&
              s.subjectPersonId === subjectPersonId,
          ),
      );
    },

    async putSupersessionWithinTx(original, correction, tx) {
      // The original keeps its content byte-identical; ONLY the
      // supersession back-pointer flips. The correction is a new
      // record referencing the original.
      await tx.put(COLLECTION, original.id, original);
      await tx.put(COLLECTION, correction.id, correction);
      logger?.debug("risk_signal.supersession_persisted", {
        originalId: original.id,
        correctionId: correction.id,
        transactionId: tx.transactionId,
      });
    },

    async createWithinTx(signal, tx) {
      await tx.put(COLLECTION, signal.id, signal);
      logger?.debug("risk_signal.created_within_tx", {
        signalId: signal.id,
        category: signal.category,
        transactionId: tx.transactionId,
      });
      return signal;
    },
  };
}

export { COLLECTION as RISK_SIGNALS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
