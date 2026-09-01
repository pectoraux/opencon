/**
 * Authority-backed NET-W026 repositories — persist the supplier-offer
 * and competitive-selection lineage records through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W026.md §4.1.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `procurement_offers` — the supplier offer records (DEM-003;
 *    static after creation except the one-way withdrawal);
 *  - `procurement_selections` — the authoritative competitive-
 *    selection lineage records (PROC-AC-03; IMMUTABLE — no mutation
 *    method exists on the repository: a selection record is
 *    append-only lineage).
 *
 * Supplier offers and selections introduce NO second demand/
 * procurement authority (these collections live INSIDE the /demand
 * boundary the W024/W025 records already occupy), NO lifecycle
 * engine, NO economic ledger, NO reputation engine and NO risk
 * authority: no LifecycleRepository surface exists here (offers are
 * NOT workflow lifecycle subjects — withdrawal is a one-way field
 * mutation, expiry is derived from the recorded validity window at
 * the evaluation anchor; /workflows is untouched by NET-W026), and
 * no economic mutation surface exists at all (/settlement is
 * untouched by NET-W026 — a selection is a procurement decision,
 * never an economic one).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  CompetitiveSelection,
  CompetitiveSelectionRepository,
  SupplierOffer,
  SupplierOfferRepository,
} from "./port.ts";

export const PROCUREMENT_OFFERS_COLLECTION = "procurement_offers";
export const PROCUREMENT_SELECTIONS_COLLECTION = "procurement_selections";

export interface AuthoritySupplierOfferRepositoriesOptions {
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
// Supplier-offer repository
// ---------------------------------------------------------------------------

export function createAuthoritySupplierOfferRepository(
  opts: AuthoritySupplierOfferRepositoriesOptions,
): SupplierOfferRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(offer, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PROCUREMENT_OFFERS_COLLECTION, offer.id, offer);
        logger?.debug("procurement_offer.saved", {
          offerId: offer.id,
          executionId: execution.executionId,
        });
        return offer;
      });
    },

    async findById(id) {
      const rec = await authority.get<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(offer, tx) {
      const existing = await tx.get<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
        offer.id,
      );
      if (existing) {
        throw new Error(
          `supplier offer already persisted: ${offer.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PROCUREMENT_OFFERS_COLLECTION, offer.id, offer);
      logger?.debug("procurement_offer.created", {
        offerId: offer.id,
        organizationScopeId: offer.organizationScopeId,
      });
      return offer;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findActiveByPoolAndSupplierWithinTx(
      organizationScopeId,
      poolId,
      supplierPersonId,
      tx,
    ) {
      const records = await tx.scan<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
      );
      for (const rec of records) {
        const offer = rec.value;
        if (
          offer.organizationScopeId === organizationScopeId &&
          offer.poolId === poolId &&
          offer.supplierPersonId === supplierPersonId &&
          offer.withdrawnAt === null
        ) {
          return offer;
        }
      }
      return null;
    },

    async withdrawWithinTx(offerId, withdrawnAt, reason, tx) {
      const current = await tx.get<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
        offerId,
      );
      if (!current) {
        throw new NotFoundError(
          `supplier offer not found within tx: ${offerId}`,
          { offerId },
        );
      }
      // One-way: an already-withdrawn offer is returned unchanged (the
      // idempotent-apply replay path).
      if (current.value.withdrawnAt !== null) {
        return current.value;
      }
      const withdrawn: SupplierOffer = {
        ...current.value,
        withdrawnAt,
        withdrawalReason: reason,
        updatedAt: withdrawnAt,
      };
      await tx.put(PROCUREMENT_OFFERS_COLLECTION, offerId, withdrawn);
      logger?.debug("procurement_offer.withdrawn", {
        offerId,
        transactionId: tx.transactionId,
      });
      return withdrawn;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (offer) =>
            offer.organizationScopeId === organizationScopeId &&
            (!filters?.poolId || offer.poolId === filters.poolId) &&
            (!filters?.supplierPersonId ||
              offer.supplierPersonId === filters.supplierPersonId) &&
            (filters?.withdrawn === undefined ||
              (offer.withdrawnAt !== null) === filters.withdrawn),
        )
        .sort(byCreatedAt);
    },

    async listActiveByPool(poolId) {
      const records = await authority.scan<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (offer) => offer.poolId === poolId && offer.withdrawnAt === null,
        )
        .sort(byCreatedAt);
    },

    async listActiveByPoolWithinTx(poolId, tx) {
      // The in-tx twin (the selection TOCTOU closure): the CURRENT
      // active offers read INSIDE the authoritative transaction.
      const records = await tx.scan<SupplierOffer>(
        PROCUREMENT_OFFERS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (offer) => offer.poolId === poolId && offer.withdrawnAt === null,
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Competitive-selection (lineage) repository
// ---------------------------------------------------------------------------

export function createAuthorityCompetitiveSelectionRepository(
  opts: AuthoritySupplierOfferRepositoriesOptions,
): CompetitiveSelectionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(selection, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PROCUREMENT_SELECTIONS_COLLECTION, selection.id, selection);
        logger?.debug("procurement_selection.saved", {
          selectionId: selection.id,
          executionId: execution.executionId,
        });
        return selection;
      });
    },

    async findById(id) {
      const rec = await authority.get<CompetitiveSelection>(
        PROCUREMENT_SELECTIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(selection, tx) {
      const existing = await tx.get<CompetitiveSelection>(
        PROCUREMENT_SELECTIONS_COLLECTION,
        selection.id,
      );
      if (existing) {
        throw new Error(
          `competitive selection already persisted: ${selection.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PROCUREMENT_SELECTIONS_COLLECTION, selection.id, selection);
      logger?.debug("procurement_selection.created", {
        selectionId: selection.id,
        organizationScopeId: selection.organizationScopeId,
      });
      return selection;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<CompetitiveSelection>(
        PROCUREMENT_SELECTIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<CompetitiveSelection>(
        PROCUREMENT_SELECTIONS_COLLECTION,
      );
      // Newest-first lineage (the W020/W025 list-order precedent
      // reversed: lineage reads the latest decisions first).
      return records
        .map((rec) => rec.value)
        .filter(
          (selection) =>
            selection.organizationScopeId === organizationScopeId &&
            (!filters?.poolId || selection.poolId === filters.poolId),
        )
        .sort((a, b) => {
          if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
          return a.createdAt < b.createdAt ? 1 : -1;
        });
    },
  };
}
