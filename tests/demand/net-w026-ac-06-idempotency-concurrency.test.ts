/**
 * NET-W026 AC-06 — Offer creation and material selection mutations are
 * exactly-once under same-key replay, concurrency-safe, and atomically
 * audited on ONE authoritative transaction (issue #52 acceptance
 * criterion 6).
 *
 * Work order: spec/work-orders/NET-W026.md §5 / §7 AC-06.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW026Harness,
  createSupplierOffer,
  seedQualifiedPool,
  seedCompetitivePool,
  poolCreatorCtx,
  supplierCtxBySlot,
  key,
  type NetW026Harness,
} from "./_net-w026-harness.ts";
import { createSupplierOfferService } from "../../src/demand/supplier-offer-service.ts";
import {
  createAuthoritySupplierOfferRepository,
  createAuthorityCompetitiveSelectionRepository,
} from "../../src/demand/authority-supplier-offer-repositories.ts";
import {
  createAuthorityProcurementPoolRepository,
  createAuthorityProcurementCommitmentRepository,
} from "../../src/demand/authority-procurement-repositories.ts";
import type {
  CompetitiveSelectionRepository,
  ProcurementCommitmentRepository,
  ProcurementPoolRepository,
  SupplierOffer,
  SupplierOfferRepository,
  SupplierOfferService,
} from "../../src/demand/port.ts";
import { SupplierOfferConflictError } from "../../src/core/procurement-offer.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-06 idempotency / concurrency / atomicity", () => {
  test("same-key offer replay is EXACTLY ONCE: one record, one audit event, created: false", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-06 Replay Pool",
    });
    const ctx = supplierCtxBySlot(harness, "A", "w026-ac06-replay");
    const idempotencyKey = key("w026-ac06-replay");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      attributes: {
        region: "NA_EAST",
        unitPriceBand: "price_b_10_49",
        timingWindow: "window_short_1_3mo",
        quantityBucket: "q_100_999",
      },
      consent: { scope: "competitive_selection" },
      idempotencyKey,
    };
    const first = await harness.runtime.supplierOfferService
      .createSupplierOffer(ctx, input);
    expect(first.created).toBe(true);
    // The replay (same key, fresh execution context): the COMMITTED
    // record returns with created: false — no second record, no
    // second audit event.
    const second = await harness.runtime.supplierOfferService
      .createSupplierOffer(
        supplierCtxBySlot(harness, "A", "w026-ac06-replay-2"),
        input,
      );
    expect(second.created).toBe(false);
    expect(second.offer).toEqual(first.offer);

    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac06-replay-list"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    expect(offers.length).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_offer.recorded",
      resourceId: first.offer.id,
    });
    expect(events.length).toBe(1);
  });

  test("CONCURRENT same-supplier offers (distinct keys): exactly ONE wins — the per-pool lock serializes", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-06 Concurrent Pool",
    });
    const ctxA = supplierCtxBySlot(harness, "A", "w026-ac06-concurrent-a");
    const ctxB = supplierCtxBySlot(harness, "A", "w026-ac06-concurrent-b");
    const attempts = await Promise.allSettled([
      harness.runtime.supplierOfferService.createSupplierOffer(ctxA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_a_under_10",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        consent: { scope: "competitive_selection" },
        idempotencyKey: key("w026-ac06-concurrent-1"),
      }),
      harness.runtime.supplierOfferService.createSupplierOffer(ctxB, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_a_under_10",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        consent: { scope: "competitive_selection" },
        idempotencyKey: key("w026-ac06-concurrent-2"),
      }),
    ]);
    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt) => attempt.status === "rejected",
    );
    // ONE wins; the other conflicts deterministically (no duplicate
    // durable records).
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(SupplierOfferConflictError);
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac06-concurrent-list"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    expect(offers.length).toBe(1);
  });

  test("same-key selection replay is EXACTLY ONCE: one lineage record, one audit event", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-06 Selection Replay Pool",
    });
    const ctx = poolCreatorCtx(harness, "w026-ac06-selection-replay");
    const idempotencyKey = key("w026-ac06-selection-replay");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      idempotencyKey,
    };
    const first = await harness.runtime.supplierOfferService
      .recordCompetitiveSelection(ctx, input);
    expect(first.created).toBe(true);
    const second = await harness.runtime.supplierOfferService
      .recordCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac06-selection-replay-2"),
        input,
      );
    expect(second.created).toBe(false);
    expect(second.selection).toEqual(first.selection);
    const listed = await harness.runtime.supplierOfferService
      .listPoolSelections(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      });
    expect(listed.length).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
      resourceId: first.selection.id,
    });
    expect(events.length).toBe(1);
  });

  test("CONCURRENT selection records (distinct keys) over one pool: the per-pool lock serializes — both lineage records persist, each internally consistent", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-06 Concurrent Selection Pool",
    });
    const [a, b] = await Promise.all([
      harness.runtime.supplierOfferService.recordCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac06-csel-a"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: key("w026-ac06-csel-a"),
        },
      ),
      harness.runtime.supplierOfferService.recordCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac06-csel-b"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: key("w026-ac06-csel-b"),
        },
      ),
    ]);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.selection.id).not.toBe(b.selection.id);
    // Same unchanged state ⇒ the same decision fingerprint (the
    // anchor is excluded from the digest) — no nondeterministic
    // selection state can interleave.
    expect(a.selection.digest).toBe(b.selection.digest);
    expect(a.selection.selectedOfferId).toBe(b.selection.selectedOfferId);
    const listed = await harness.runtime.supplierOfferService
      .listPoolSelections(
        poolCreatorCtx(harness, "w026-ac06-csel-list"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    expect(listed.length).toBe(2);
  });

  test("FAILURE INJECTION: an offer repository failure inside the transaction leaves NO record and NO audit event", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-06 Failure Offer Pool",
    });
    const ctx = supplierCtxBySlot(harness, "A", "w026-ac06-failure-offer");

    const realOfferRepo: SupplierOfferRepository =
      createAuthoritySupplierOfferRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realSelectionRepo: CompetitiveSelectionRepository =
      createAuthorityCompetitiveSelectionRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realPoolRepo: ProcurementPoolRepository =
      createAuthorityProcurementPoolRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realCommitmentRepo: ProcurementCommitmentRepository =
      createAuthorityProcurementCommitmentRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const failingOfferRepo: SupplierOfferRepository = {
      ...realOfferRepo,
      async createWithinTx(offer, tx) {
        throw new Error("injected supplier offer write failure");
      },
    };
    const failingService: SupplierOfferService = createSupplierOfferService({
      offerRepository: failingOfferRepo,
      selectionRepository: realSelectionRepo,
      poolRepository: realPoolRepo,
      commitmentRepository: realCommitmentRepo,
      membershipLookup: {
        async resolveMembership() {
          return "active";
        },
      },
      idempotency: harness.runtime.idempotency,
      auditWriter: harness.runtime.auditWriter,
      logger: harness.runtime.logger.forModule("demand"),
    });

    await expect(
      failingService.createSupplierOffer(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_b_10_49",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        consent: { scope: "competitive_selection" },
        idempotencyKey: key("w026-ac06-failure-offer"),
      }),
    ).rejects.toThrow("injected supplier offer write failure");

    // No record, no audit event — the mutation and the audit buffer
    // rolled back together.
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac06-failure-list"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    expect(offers.length).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_offer.recorded",
    });
    const forThisPool = events.filter((event) => {
      const metadata = event.metadata as Record<string, unknown>;
      return metadata["poolId"] === pool.id;
    });
    expect(forThisPool.length).toBe(0);
  });

  test("FAILURE INJECTION: a selection repository failure inside the transaction leaves NO lineage record and NO audit event", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-06 Failure Selection Pool",
    });
    const ctx = poolCreatorCtx(harness, "w026-ac06-failure-selection");

    const realOfferRepo: SupplierOfferRepository =
      createAuthoritySupplierOfferRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realSelectionRepo: CompetitiveSelectionRepository =
      createAuthorityCompetitiveSelectionRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realPoolRepo: ProcurementPoolRepository =
      createAuthorityProcurementPoolRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realCommitmentRepo: ProcurementCommitmentRepository =
      createAuthorityProcurementCommitmentRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const failingSelectionRepo: CompetitiveSelectionRepository = {
      ...realSelectionRepo,
      async createWithinTx(selection, tx) {
        throw new Error("injected selection write failure");
      },
    };
    const failingService: SupplierOfferService = createSupplierOfferService({
      offerRepository: realOfferRepo,
      selectionRepository: failingSelectionRepo,
      poolRepository: realPoolRepo,
      commitmentRepository: realCommitmentRepo,
      membershipLookup: {
        async resolveMembership() {
          return "active";
        },
      },
      idempotency: harness.runtime.idempotency,
      auditWriter: harness.runtime.auditWriter,
      logger: harness.runtime.logger.forModule("demand"),
    });

    await expect(
      failingService.recordCompetitiveSelection(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        idempotencyKey: key("w026-ac06-failure-selection"),
      }),
    ).rejects.toThrow("injected selection write failure");

    // No lineage record, no audit event — the atomicity held.
    const listed = await harness.runtime.supplierOfferService
      .listPoolSelections(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      });
    expect(listed.length).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
    });
    const forThisPool = events.filter((event) => {
      const metadata = event.metadata as Record<string, unknown>;
      return metadata["poolId"] === pool.id;
    });
    expect(forThisPool.length).toBe(0);
  });
});
