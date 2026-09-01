/**
 * NET-W026 AC-01 — Supplier offers are first-class tenant/pool-scoped
 * durable records with explicit provenance, authorization, validity
 * and version lineage; invalid provider-neutral vocabulary fails
 * closed (issue #52 acceptance criterion 1).
 *
 * Work order: spec/work-orders/NET-W026.md §4.1 / §7 AC-01.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW026Harness,
  createSupplierOffer,
  seedQualifiedPool,
  seedCompetitivePool,
  supplierCtxBySlot,
  key,
  type NetW026Harness,
} from "./_net-w026-harness.ts";
import {
  SUPPLIER_OFFER_RECORD_FORMAT,
  SUPPLIER_OFFER_CONSENT_SCOPE,
  SUPPLIER_OFFER_CONSENT_VERSION,
  InvalidSupplierOfferError,
  SupplierOfferConflictError,
} from "../../src/core/procurement-offer.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-01 first-class supplier offer records", () => {
  test("an offer is a durable, tenant/pool-scoped record with provenance, consent, validity and version lineage", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-01 Record Pool",
    });
    const ctx = supplierCtxBySlot(harness, "A", "w026-ac01-record");
    const offer = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx,
    });

    expect(offer.id).toBeTruthy();
    expect(offer.organizationScopeId).toBe(harness.organizationScopeId);
    expect(offer.poolId).toBe(pool.id);
    // The supplier IS the acting person — server-resolved, never a
    // caller assertion.
    expect(offer.supplierPersonId).toBe(harness.supplierAPersonId);
    // The category snapshot comes from the pool (the pool's category
    // at submission — lineage).
    expect(offer.categoryKey).toBe(pool.categoryKey);
    expect(offer.categoryVersion).toBe(pool.categoryVersion);
    // The bounded provider-neutral attributes round-trip.
    expect(offer.attributes).toEqual({
      region: "NA_EAST",
      unitPriceBand: "price_b_10_49",
      timingWindow: "window_short_1_3mo",
      quantityBucket: "q_100_999",
    });
    // The consent grant is SERVER-WRITTEN: the closed scope, the
    // version, the grant time and the server-resolved grantor.
    expect(offer.consent.scope).toBe(SUPPLIER_OFFER_CONSENT_SCOPE);
    expect(offer.consent.version).toBe(SUPPLIER_OFFER_CONSENT_VERSION);
    expect(offer.consent.grantedBy).toBe(harness.supplierAPersonId);
    expect(typeof offer.consent.grantedAt).toBe("string");
    // The explicit validity window: validFrom server-set to the
    // submission instant; validUntil open-ended by default.
    expect(typeof offer.validFrom).toBe("string");
    expect(offer.validUntil).toBeNull();
    // One-way withdrawal fields start clean.
    expect(offer.withdrawnAt).toBeNull();
    expect(offer.withdrawalReason).toBeNull();
    // Record-format + idempotency/execution lineage.
    expect(offer.recordFormat).toBe(SUPPLIER_OFFER_RECORD_FORMAT);
    expect(offer.idempotencyKey).toBeTruthy();
    expect(offer.executionId).toBe(ctx.executionId);
    expect(offer.correlationId).toBe(ctx.correlationId);
    expect(offer.createdAt).toBeTruthy();
    expect(offer.updatedAt).toBe(offer.createdAt);

    // Durable: the record is retrievable through the tenant-scoped
    // read.
    const read = await harness.runtime.supplierOfferService.getSupplierOffer(
      ctx,
      harness.organizationScopeId,
      offer.id,
    );
    expect(read).toEqual(offer);
  });

  test("the bounded validity window is honored: validUntil round-trips and is bounded", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-01 Validity Pool",
    });
    const validUntil = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const offer = await createSupplierOffer(harness, {
      poolId: pool.id,
      validUntil,
    });
    expect(offer.validUntil).toBe(validUntil);

    // Bounded: a validity horizon past the max bound fails closed.
    const tooFar = new Date(
      Date.now() + 400 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx: supplierCtxBySlot(harness, "B", "w026-ac01-too-far"),
        validUntil: tooFar,
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);

    // A validity horizon in the past fails closed.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx: supplierCtxBySlot(harness, "B", "w026-ac01-past"),
        validUntil: past,
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);
  });

  test("invalid provider-neutral vocabulary fails closed (region, price band, timing window, capacity bucket, consent scope)", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-01 Vocabulary Pool",
    });
    const ctx = supplierCtxBySlot(harness, "B", "w026-ac01-vocab");

    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx,
        region: "ATLANTIS" as never,
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx,
        unitPriceBand: "price_z_free",
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx,
        timingWindow: "window_yesterday",
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx,
        quantityBucket: "q_infinite",
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);
    // Any consent scope other than the ONE closed scope fails closed
    // (individual-disclosure is unrepresentable).
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx,
        consentScope: "individual_disclosure",
      }),
    ).rejects.toBeInstanceOf(InvalidSupplierOfferError);
  });

  test("ONE ACTIVE offer per (pool, supplier): a stable conflict; withdrawal frees the slot", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-01 Conflict Pool",
    });
    // Supplier A already holds an ACTIVE offer from the seed.
    await expect(
      createSupplierOffer(harness, {
        poolId: pool.id,
        ctx: supplierCtxBySlot(harness, "A", "w026-ac01-conflict"),
      }),
    ).rejects.toBeInstanceOf(SupplierOfferConflictError);

    // Withdrawal frees the slot: the supplier may re-enter under a
    // NEW record.
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac01-list"),
        harness.organizationScopeId,
        { poolId: pool.id, supplierPersonId: harness.supplierAPersonId },
      );
    expect(offers.length).toBe(1);
    const withdrawn = await harness.runtime.supplierOfferService
      .withdrawSupplierOffer(
        supplierCtxBySlot(harness, "A", "w026-ac01-withdraw"),
        {
          organizationScopeId: harness.organizationScopeId,
          offerId: offers[0]!.id,
          idempotencyKey: key("w026-ac01-withdraw"),
        },
      );
    expect(withdrawn.withdrawnAt).toBeTruthy();
    const reoffered = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac01-reoffer"),
      unitPriceBand: "price_a_under_10",
    });
    expect(reoffered.id).not.toBe(offers[0]!.id);
    expect(reoffered.withdrawnAt).toBeNull();
  });

  test("withdrawal is one-way: an already-withdrawn offer is returned unchanged on replay-path withdrawal", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-01 One-Way Pool",
    });
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "C", "w026-ac01-oneway"),
        harness.organizationScopeId,
        { poolId: pool.id, supplierPersonId: harness.supplierCPersonId },
      );
    const offerId = offers[0]!.id;
    const first = await harness.runtime.supplierOfferService
      .withdrawSupplierOffer(
        supplierCtxBySlot(harness, "C", "w026-ac01-oneway-1"),
        {
          organizationScopeId: harness.organizationScopeId,
          offerId,
          idempotencyKey: key("w026-ac01-oneway"),
        },
      );
    expect(first.withdrawnAt).toBeTruthy();
    const second = await harness.runtime.supplierOfferService
      .withdrawSupplierOffer(
        supplierCtxBySlot(harness, "C", "w026-ac01-oneway-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          offerId,
          idempotencyKey: key("w026-ac01-oneway-2"),
        },
      );
    // One-way: the second (different-key) withdrawal of the same
    // offer returns the withdrawn record unchanged.
    expect(second.withdrawnAt).toBe(first.withdrawnAt);
  });
});
