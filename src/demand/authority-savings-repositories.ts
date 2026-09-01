/**
 * Authority-backed NET-W027 repositories — persist the procurement
 * baseline and savings-lineage records through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W027.md §4.1/§4.3.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `procurement_baselines` — the explicit baseline/counterfactual
 *    reference records (PROC-002; static after creation except the
 *    ONE-WAY invalidation);
 *  - `procurement_savings` — the authoritative savings-lineage
 *    records (PROC-002 / PROC-AC-01's gate; IMMUTABLE — no mutation
 *    method exists on the repository: a savings record is
 *    append-only lineage).
 *
 * Baselines and savings records introduce NO second demand/
 * procurement authority (these collections live INSIDE the /demand
 * boundary the W024/W025/W026 records already occupy), NO lifecycle
 * engine, NO economic ledger, NO reputation engine and NO risk
 * authority: no LifecycleRepository surface exists here (baselines
 * are NOT workflow lifecycle subjects — invalidation is a one-way
 * field mutation, evidence staleness and observation supersession
 * are DERIVED at the evaluation anchor; /workflows is untouched by
 * NET-W027), and no economic mutation surface exists at all
 * (/settlement is untouched by NET-W027 — a verified savings claim
 * is a measurement decision, never an economic one).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  ProcurementBaseline,
  ProcurementBaselineRepository,
  ProcurementSavings,
  ProcurementSavingsRepository,
} from "./port.ts";

export const PROCUREMENT_BASELINES_COLLECTION = "procurement_baselines";
export const PROCUREMENT_SAVINGS_COLLECTION = "procurement_savings";

export interface AuthoritySavingsRepositoriesOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function byCreatedAt(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Procurement-baseline repository
// ---------------------------------------------------------------------------

export function createAuthorityProcurementBaselineRepository(
  opts: AuthoritySavingsRepositoriesOptions,
): ProcurementBaselineRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(baseline, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PROCUREMENT_BASELINES_COLLECTION, baseline.id, baseline);
        logger?.debug("procurement_baseline.saved", {
          baselineId: baseline.id,
          executionId: execution.executionId,
        });
        return baseline;
      });
    },

    async findById(id) {
      const rec = await authority.get<ProcurementBaseline>(
        PROCUREMENT_BASELINES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(baseline, tx) {
      const existing = await tx.get<ProcurementBaseline>(
        PROCUREMENT_BASELINES_COLLECTION,
        baseline.id,
      );
      if (existing) {
        throw new Error(
          `procurement baseline already persisted: ${baseline.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PROCUREMENT_BASELINES_COLLECTION, baseline.id, baseline);
      logger?.debug("procurement_baseline.created", {
        baselineId: baseline.id,
        organizationScopeId: baseline.organizationScopeId,
      });
      return baseline;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<ProcurementBaseline>(
        PROCUREMENT_BASELINES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async invalidateWithinTx(baselineId, invalidatedAt, reason, tx) {
      const current = await tx.get<ProcurementBaseline>(
        PROCUREMENT_BASELINES_COLLECTION,
        baselineId,
      );
      if (!current) {
        throw new NotFoundError(
          `procurement baseline not found within tx: ${baselineId}`,
          { baselineId },
        );
      }
      // One-way: an already-invalidated baseline is returned unchanged
      // (the idempotent-apply replay path).
      if (current.value.invalidatedAt !== null) {
        return current.value;
      }
      const invalidated: ProcurementBaseline = {
        ...current.value,
        invalidatedAt,
        invalidationReason: reason,
        updatedAt: invalidatedAt,
      };
      await tx.put(PROCUREMENT_BASELINES_COLLECTION, baselineId, invalidated);
      logger?.debug("procurement_baseline.invalidated", {
        baselineId,
        transactionId: tx.transactionId,
      });
      return invalidated;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<ProcurementBaseline>(
        PROCUREMENT_BASELINES_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (baseline) =>
            baseline.organizationScopeId === organizationScopeId &&
            (!filters?.poolId || baseline.poolId === filters.poolId) &&
            (filters?.invalidated === undefined ||
              (baseline.invalidatedAt !== null) === filters.invalidated),
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Procurement-savings (lineage) repository
// ---------------------------------------------------------------------------

export function createAuthorityProcurementSavingsRepository(
  opts: AuthoritySavingsRepositoriesOptions,
): ProcurementSavingsRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(savings, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PROCUREMENT_SAVINGS_COLLECTION, savings.id, savings);
        logger?.debug("procurement_savings.saved", {
          savingsId: savings.id,
          executionId: execution.executionId,
        });
        return savings;
      });
    },

    async findById(id) {
      const rec = await authority.get<ProcurementSavings>(
        PROCUREMENT_SAVINGS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(savings, tx) {
      const existing = await tx.get<ProcurementSavings>(
        PROCUREMENT_SAVINGS_COLLECTION,
        savings.id,
      );
      if (existing) {
        throw new Error(
          `procurement savings record already persisted: ${savings.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PROCUREMENT_SAVINGS_COLLECTION, savings.id, savings);
      logger?.debug("procurement_savings.created", {
        savingsId: savings.id,
        organizationScopeId: savings.organizationScopeId,
      });
      return savings;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<ProcurementSavings>(
        PROCUREMENT_SAVINGS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<ProcurementSavings>(
        PROCUREMENT_SAVINGS_COLLECTION,
      );
      // Newest-first lineage (the W026 selection-lineage precedent).
      return records
        .map((rec) => rec.value)
        .filter(
          (savings) =>
            savings.organizationScopeId === organizationScopeId &&
            (!filters?.poolId || savings.poolId === filters.poolId),
        )
        .sort((a, b) => {
          if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
          return a.createdAt < b.createdAt ? 1 : -1;
        });
    },
  };
}
