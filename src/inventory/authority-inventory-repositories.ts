/**
 * Authority-backed NET-W019 repositories — persist the
 * inventory-item / placement records through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W019.md §3.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `inventory_items` — the registered supply records (INV-001;
 *    static after registration except the one-way withdrawal and the
 *    one-time supply-verification attachment);
 *  - `placements` — the placement-context records (INV-002; static
 *    after creation except the one-way retirement).
 *
 * Inventory semantics introduce NO second lifecycle engine, economic
 * ledger, reputation engine, risk authority, evidence authority or
 * platform ownership layer: no LifecycleRepository surface exists
 * here (items and placements are NOT workflow lifecycle subjects —
 * /workflows is untouched by NET-W019).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  InventoryItem,
  InventoryItemRepository,
  PlacementRecord,
  PlacementRepository,
} from "./port.ts";

export const INVENTORY_ITEMS_COLLECTION = "inventory_items";
export const PLACEMENTS_COLLECTION = "placements";

export interface AuthorityInventoryRepositoriesOptions {
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
// Inventory-item repository
// ---------------------------------------------------------------------------

export function createAuthorityInventoryItemRepository(
  opts: AuthorityInventoryRepositoriesOptions,
): InventoryItemRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(item, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(INVENTORY_ITEMS_COLLECTION, item.id, item);
        logger?.debug("inventory_item.saved", {
          itemId: item.id,
          executionId: execution.executionId,
        });
        return item;
      });
    },

    async findById(id) {
      const rec = await authority.get<InventoryItem>(
        INVENTORY_ITEMS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(item, tx) {
      const existing = await tx.get<InventoryItem>(
        INVENTORY_ITEMS_COLLECTION,
        item.id,
      );
      if (existing) {
        throw new Error(
          `inventory item already persisted: ${item.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(INVENTORY_ITEMS_COLLECTION, item.id, item);
      logger?.debug("inventory_item.created", {
        itemId: item.id,
        organizationScopeId: item.organizationScopeId,
      });
      return item;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<InventoryItem>(INVENTORY_ITEMS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async retireWithinTx(itemId, retiredAt, reason, tx) {
      const current = await tx.get<InventoryItem>(
        INVENTORY_ITEMS_COLLECTION,
        itemId,
      );
      if (!current) {
        throw new NotFoundError(
          `inventory item ${itemId} not found within tx`,
          { itemId },
        );
      }
      // One-way: an already-retired item is returned unchanged (the
      // idempotent-apply replay path).
      if (current.value.retiredAt !== null) {
        return current.value;
      }
      const retired: InventoryItem = {
        ...current.value,
        retiredAt,
        retirementReason: reason,
        updatedAt: retiredAt,
      };
      await tx.put(INVENTORY_ITEMS_COLLECTION, itemId, retired);
      logger?.debug("inventory_item.retired", {
        itemId,
        transactionId: tx.transactionId,
      });
      return retired;
    },

    async attachVerificationWithinTx(itemId, evidenceReference, attachedAt, tx) {
      const current = await tx.get<InventoryItem>(
        INVENTORY_ITEMS_COLLECTION,
        itemId,
      );
      if (!current) {
        throw new NotFoundError(
          `inventory item ${itemId} not found within tx`,
          { itemId },
        );
      }
      // One-time attachment: an item that already carries a reference
      // is returned unchanged (stable provenance — the idempotent-
      // apply replay path).
      if (current.value.verificationEvidenceReference !== null) {
        return current.value;
      }
      const updated: InventoryItem = {
        ...current.value,
        verificationEvidenceReference: evidenceReference,
        updatedAt: attachedAt,
      };
      await tx.put(INVENTORY_ITEMS_COLLECTION, itemId, updated);
      logger?.debug("inventory_item.supply_verification_attached", {
        itemId,
        transactionId: tx.transactionId,
      });
      return updated;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<InventoryItem>(
        INVENTORY_ITEMS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (item) =>
            item.organizationScopeId === organizationScopeId &&
            (!filters?.surfaceKind ||
              item.surfaceKind === filters.surfaceKind) &&
            (!filters?.format || item.format === filters.format) &&
            (!filters?.ownerPersonId ||
              item.ownerPersonId === filters.ownerPersonId) &&
            (filters?.retired === undefined ||
              (item.retiredAt !== null) === filters.retired),
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Placement repository
// ---------------------------------------------------------------------------

export function createAuthorityPlacementRepository(
  opts: AuthorityInventoryRepositoriesOptions,
): PlacementRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(placement, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PLACEMENTS_COLLECTION, placement.id, placement);
        logger?.debug("placement.saved", {
          placementId: placement.id,
          executionId: execution.executionId,
        });
        return placement;
      });
    },

    async findById(id) {
      const rec = await authority.get<PlacementRecord>(
        PLACEMENTS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(placement, tx) {
      const existing = await tx.get<PlacementRecord>(
        PLACEMENTS_COLLECTION,
        placement.id,
      );
      if (existing) {
        throw new Error(
          `placement already persisted: ${placement.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PLACEMENTS_COLLECTION, placement.id, placement);
      logger?.debug("placement.created", {
        placementId: placement.id,
        organizationScopeId: placement.organizationScopeId,
      });
      return placement;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<PlacementRecord>(PLACEMENTS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findActiveByItemAndCampaignWithinTx(
      organizationScopeId,
      inventoryItemId,
      campaignId,
      tx,
    ) {
      const records = await tx.scan<PlacementRecord>(PLACEMENTS_COLLECTION);
      for (const rec of records) {
        const placement = rec.value;
        if (
          placement.organizationScopeId === organizationScopeId &&
          placement.inventoryItemId === inventoryItemId &&
          placement.campaignId === campaignId &&
          placement.retiredAt === null
        ) {
          return placement;
        }
      }
      return null;
    },

    async retireWithinTx(placementId, retiredAt, reason, tx) {
      const current = await tx.get<PlacementRecord>(
        PLACEMENTS_COLLECTION,
        placementId,
      );
      if (!current) {
        throw new NotFoundError(
          `placement ${placementId} not found within tx`,
          { placementId },
        );
      }
      // One-way: an already-retired placement is returned unchanged
      // (the idempotent-apply replay path).
      if (current.value.retiredAt !== null) {
        return current.value;
      }
      const retired: PlacementRecord = {
        ...current.value,
        retiredAt,
        retirementReason: reason,
        updatedAt: retiredAt,
      };
      await tx.put(PLACEMENTS_COLLECTION, placementId, retired);
      logger?.debug("placement.retired", {
        placementId,
        transactionId: tx.transactionId,
      });
      return retired;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<PlacementRecord>(
        PLACEMENTS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (placement) =>
            placement.organizationScopeId === organizationScopeId &&
            (!filters?.inventoryItemId ||
              placement.inventoryItemId === filters.inventoryItemId) &&
            (!filters?.campaignId ||
              placement.campaignId === filters.campaignId) &&
            (!filters?.ownerPersonId ||
              placement.sourceContext.ownerPersonId === filters.ownerPersonId) &&
            (filters?.retired === undefined ||
              (placement.retiredAt !== null) === filters.retired),
        )
        .sort(byCreatedAt);
    },
  };
}
