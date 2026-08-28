/**
 * NET-W019 — inventory mutation atomicity (fault-injection evidence,
 * the W017/W018 composite-atomicity standard applied to the W019
 * composites). Every material mutation commits as ONE authoritative
 * transaction (a single applyIdempotent: the record + the idempotency
 * record + the transactional audit event commit together or not at
 * all — there is NO cross-authority second transaction in NET-W019,
 * so the failure surface is the authoritative COMMIT itself):
 *
 *   authoritative COMMIT fails  → NOTHING survives (no record, no
 *   idempotency completion, no audit event)
 *   retry after the failure     → converges deterministically
 *
 * Work order ref: spec/work-orders/NET-W019.md §3.5.
 */

import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../../src/core/postgres-authority.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import {
  createAuthorityInventoryItemRepository,
  createAuthorityPlacementRepository,
} from "../../src/inventory/authority-inventory-repositories.ts";
import { createInventoryService } from "../../src/inventory/inventory-service.ts";
import {
  createNetW019Harness,
  createCampaignWithEligibility,
  registerInventoryItem,
  personCtx,
  key,
  type NetW019Harness,
} from "./_net-w019-harness.ts";

/** Count audit events of one type for one resource. */
async function auditCount(
  harness: NetW019Harness,
  eventType: string,
  resourceId?: string,
): Promise<number> {
  const events = await harness.runtime.auditWriter.query(
    resourceId ? { eventType, resourceId } : { eventType },
  );
  return events.length;
}

/**
 * The W006/W017/W018 rebuild pattern: a transaction wrapper whose
 * commit() always fails AFTER the composite staged everything.
 */
class CommitFailingTransaction implements AuthorityTransaction {
  public constructor(
    private readonly inner: AuthorityTransaction,
  ) {}
  get transactionId(): string {
    return this.inner.transactionId;
  }
  get settled(): boolean {
    return this.inner.settled;
  }
  get<T = unknown>(collection: string, key: string) {
    return this.inner.get<T>(collection, key);
  }
  scan<T = unknown>(collection: string) {
    return this.inner.scan<T>(collection);
  }
  put<T>(collection: string, key: string, value: T) {
    return this.inner.put<T>(collection, key, value);
  }
  delete(collection: string, key: string) {
    return this.inner.delete(collection, key);
  }
  afterCommit(hook: () => Promise<void>): void {
    this.inner.afterCommit(hook);
  }
  afterRollback(hook: () => Promise<void>): void {
    this.inner.afterRollback(hook);
  }
  async commit(): Promise<void> {
    throw new Error("injected authoritative COMMIT failure");
  }
  async rollback(): Promise<void> {
    return this.inner.rollback();
  }
}

describe("NET-W019 inventory mutation atomicity (fault injection)", () => {
  test("registerInventoryItem: the authoritative COMMIT fails → NOTHING commits; healthy retry converges", async () => {
    const harness = await createNetW019Harness();
    try {
      const failingAuthority: PostgresAuthority = {
        async begin(context: ExecutionContext) {
          return new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
        },
        async run<T>(
          context: ExecutionContext,
          work: (tx: AuthorityTransaction) => Promise<T>,
        ): Promise<T> {
          const tx = new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
          try {
            const result = await work(tx);
            await tx.commit();
            return result;
          } catch (err) {
            await tx.rollback();
            throw err;
          }
        },
        get<T = unknown>(collection: string, key: string) {
          return harness.runtime.postgresAuthority.get<T>(collection, key);
        },
        scan<T = unknown>(collection: string) {
          return harness.runtime.postgresAuthority.scan<T>(collection);
        },
        count(collection: string) {
          return harness.runtime.postgresAuthority.count(collection);
        },
        recover() {
          return harness.runtime.postgresAuthority.recover();
        },
        close() {
          return harness.runtime.postgresAuthority.close();
        },
      };
      const failingIdempotency = createPostgresIdempotencyStore({
        authority: failingAuthority,
      });
      const failingService = createInventoryService({
        itemRepository: createAuthorityInventoryItemRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        placementRepository: createAuthorityPlacementRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        lookups: {
          campaign: {
            async resolvePolicy() {
              return null;
            },
          },
          evidence: {
            async resolve() {
              return null;
            },
          },
        },
        idempotency: failingIdempotency,
        auditWriter: createTransactionalAuditWriter({
          underlying: harness.runtime.auditWriter,
        }),
        logger: harness.runtime.logger.forModule("inventory"),
      });
      const ctx = personCtx(harness, harness.creatorPersonId, "w019-atomic");
      await expect(
        failingService.registerInventoryItem(ctx, {
          organizationScopeId: harness.organizationScopeId,
          surfaceKind: "publisher",
          format: "display",
          externalReference: null,
          attributes: { territories: ["GH"], languages: ["en"] },
          description: null,
          idempotencyKey: key("w019-atomic-register"),
        }),
      ).rejects.toThrow("injected authoritative COMMIT failure");

      // NOTHING committed: no record, no audit event (the failure
      // key is unique so no replay short-circuit applies).
      const items = await harness.runtime.inventoryService.listInventoryItems(
        personCtx(harness, harness.operatorPersonId, "w019-atomic-read"),
        harness.organizationScopeId,
      );
      expect(
        items.find(
          (i) => i.idempotencyKey === "w019-atomic-register-x",
        ),
      ).toBeUndefined();
      expect(await auditCount(harness, "inventory_item.registered")).toBe(0);

      // The HEALTHY service + store converge on retry (a fresh key,
      // the same semantics).
      const healthy = await harness.runtime.inventoryService.registerInventoryItem(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          surfaceKind: "publisher",
          format: "display",
          externalReference: null,
          attributes: { territories: ["GH"], languages: ["en"] },
          description: null,
          idempotencyKey: key("w019-atomic-register-retry"),
        },
      );
      expect(healthy.created).toBe(true);
      expect(
        await auditCount(harness, "inventory_item.registered", healthy.item.id),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  });

  test("createPlacement: the authoritative COMMIT fails → NOTHING commits (no placement, no audit); healthy retry converges", async () => {
    const harness = await createNetW019Harness();
    try {
      const item = await registerInventoryItem(harness);
      const campaign = await createCampaignWithEligibility(harness);

      const failingAuthority: PostgresAuthority = {
        async begin(context: ExecutionContext) {
          return new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
        },
        async run<T>(
          context: ExecutionContext,
          work: (tx: AuthorityTransaction) => Promise<T>,
        ): Promise<T> {
          const tx = new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
          try {
            const result = await work(tx);
            await tx.commit();
            return result;
          } catch (err) {
            await tx.rollback();
            throw err;
          }
        },
        get<T = unknown>(collection: string, key: string) {
          return harness.runtime.postgresAuthority.get<T>(collection, key);
        },
        scan<T = unknown>(collection: string) {
          return harness.runtime.postgresAuthority.scan<T>(collection);
        },
        count(collection: string) {
          return harness.runtime.postgresAuthority.count(collection);
        },
        recover() {
          return harness.runtime.postgresAuthority.recover();
        },
        close() {
          return harness.runtime.postgresAuthority.close();
        },
      };
      const failingIdempotency = createPostgresIdempotencyStore({
        authority: failingAuthority,
      });
      // The service reads preconditions through the HEALTHY authority
      // (outer reads) but the failing idempotency store governs the
      // COMMIT — the architectural seam where everything stages and
      // then the settle fails.
      const campaignLookupThroughService = harness.runtime.inventoryService;
      void campaignLookupThroughService;
      const failingService = createInventoryService({
        itemRepository: createAuthorityInventoryItemRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        placementRepository: createAuthorityPlacementRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        lookups: {
          campaign: {
            async resolvePolicy(campaignId: string, policyVersion?: number) {
              const campaignRecord =
                await harness.runtime.campaignService.getCampaign(
                  personCtx(harness, harness.operatorPersonId, "w019-atomic"),
                  campaignId,
                );
              if (!campaignRecord) return null;
              if (
                policyVersion !== undefined &&
                campaignRecord.currentPolicyVersion !== policyVersion
              ) {
                return null;
              }
              const version =
                await harness.runtime.campaignService.getPolicyVersion(
                  personCtx(harness, harness.operatorPersonId, "w019-atomic"),
                  campaignId,
                  policyVersion ?? campaignRecord.currentPolicyVersion!,
                );
              return {
                campaignId: campaignRecord.id,
                organizationScopeId: campaignRecord.organizationScopeId,
                campaignStatus: campaignRecord.status,
                policyVersion: version.version,
                eligibilityRules: version.eligibility.rules.map((rule) => ({
                  attribute: rule.attribute,
                  operator: rule.operator,
                  values: [...rule.values],
                })),
              };
            },
          },
          evidence: {
            async resolve() {
              return null;
            },
          },
        },
        idempotency: failingIdempotency,
        auditWriter: createTransactionalAuditWriter({
          underlying: harness.runtime.auditWriter,
        }),
        logger: harness.runtime.logger.forModule("inventory"),
      });
      const ctx = personCtx(harness, harness.creatorPersonId, "w019-atomic");
      await expect(
        failingService.createPlacement(ctx, {
          organizationScopeId: harness.organizationScopeId,
          inventoryItemId: item.id,
          campaignId: campaign.id,
          context: { territories: ["US", "CA"], languages: ["en"] },
          idempotencyKey: key("w019-atomic-placement"),
        }),
      ).rejects.toThrow("injected authoritative COMMIT failure");

      // NOTHING committed: no placement for the pair, no audit event.
      const placements = await harness.runtime.inventoryService.listPlacements(
        personCtx(harness, harness.operatorPersonId, "w019-atomic-read"),
        harness.organizationScopeId,
        { inventoryItemId: item.id, campaignId: campaign.id },
      );
      expect(placements).toEqual([]);
      expect(await auditCount(harness, "placement.recorded")).toBe(0);

      // The HEALTHY service converges on retry (the same pair is
      // still free — the failed apply left nothing behind).
      const healthy = await harness.runtime.inventoryService.createPlacement(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          inventoryItemId: item.id,
          campaignId: campaign.id,
          context: { territories: ["US", "CA"], languages: ["en"] },
          idempotencyKey: key("w019-atomic-placement-retry"),
        },
      );
      expect(healthy.created).toBe(true);
      expect(
        await auditCount(harness, "placement.recorded", healthy.placement.id),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  });
});
