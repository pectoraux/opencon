/**
 * NET-W026 AC-02 — Only currently qualified NET-W025 demand can
 * receive/compare offers: unqualified, closed or withdrawn demand
 * cannot enter competitive selection (issue #52 acceptance criterion
 * 2).
 *
 * Work order: spec/work-orders/NET-W026.md §4.2 / §7 AC-02.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW026Harness,
  createSupplierOffer,
  seedQualifiedPool,
  seedCompetitivePool,
  recordCompetitiveSelection,
  poolCreatorCtx,
  supplierCtxBySlot,
  key,
  type NetW026Harness,
} from "./_net-w026-harness.ts";
import {
  createProcurementPool,
  buyerCtx,
} from "./_net-w025-harness.ts";
import { InvalidSupplierOfferError } from "../../src/core/procurement-offer.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-02 qualified-demand gating", () => {
  test("offer submission on an UNQUALIFIED pool fails closed (below the distinct-organization floor)", async () => {
    // One commitment from ONE buyer organization: the commitment
    // threshold (2) and the organization floor/policy (2 orgs) are
    // unmet, so the pool is NOT qualified.
    const pool = await createProcurementPool(harness.w025, {
      name: "AC-02 Unqualified Pool",
      minimumCommitments: 2,
      minimumOrganizations: 2,
    });
    await harness.runtime.procurementService.createProcurementCommitment(
      buyerCtx(harness.w025, "A", "w026-ac02-c0"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.w025.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w026-ac02-c0"),
      },
    );
    const offerError = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac02-unqualified"),
    }).catch((error: unknown) => error);
    expect(offerError).toBeInstanceOf(InvalidSupplierOfferError);
    expect(
      (offerError as InvalidSupplierOfferError).context?.["reason"],
    ).toBe("pool_not_qualified");
  });

  test("offer submission on a CLOSED pool fails closed", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-02 Closed Pool",
    });
    await harness.runtime.procurementService.closeProcurementPool(
      poolCreatorCtx(harness, "w026-ac02-close"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "closed for AC-02",
        idempotencyKey: key("w026-ac02-close"),
      },
    );
    const error = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac02-closed"),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidSupplierOfferError);
    expect((error as InvalidSupplierOfferError).context?.["reason"]).toBe(
      "pool_closed",
    );
  });

  test("existing offers SURVIVE pool closure (durable records) but never re-enter selection", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-02 Survive Pool",
    });
    // The offers exist and the pool currently qualifies.
    const before = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac02-before"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(before.qualified).toBe(true);
    expect(before.selectedOfferId).toBeTruthy();

    // Close the pool: the derived qualification fails (pool_open is
    // one of the W025 checks), so the selection view shows the gate
    // closed — closed pools never qualify (the W025 contract).
    await harness.runtime.procurementService.closeProcurementPool(
      poolCreatorCtx(harness, "w026-ac02-close-2"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "tender closed",
        idempotencyKey: key("w026-ac02-close-2"),
      },
    );
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac02-after"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    expect(offers.length).toBe(3);
    const after = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac02-after"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(after.qualified).toBe(false);
    expect(after.selectedOfferId).toBeNull();
    expect(after.eligibleOfferIds).toEqual([]);
    // The record command FAILS CLOSED on closed demand (unqualified
    // demand cannot enter the authoritative selection).
    const recordError = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    }).catch((e: unknown) => e);
    expect(recordError).toBeInstanceOf(InvalidSupplierOfferError);
    expect(
      (recordError as InvalidSupplierOfferError).context?.["reason"],
    ).toBe("pool_not_qualified");
  });

  test("WITHDRAWN demand cannot enter selection: a commitment withdrawal drops the organization floor and the selection gates close", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-02 Withdraw Pool",
    });
    // The pool currently qualifies with 3 commitments from 3 orgs.
    const before = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac02-w-before"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(before.qualified).toBe(true);

    // Withdraw buyer C's commitment: the distinct-organization count
    // drops to 2 — below the frozen organization floor, so the
    // aggregate suppresses and the pool is no longer qualified.
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(
        poolCreatorCtx(harness, "w026-ac02-w-list"),
        harness.organizationScopeId,
        { poolId: pool.id, withdrawn: false },
      );
    const buyerCCommitment = commitments.find(
      (commitment) =>
        commitment.buyerOrganizationId === harness.w025.buyerOrgCId,
    );
    expect(buyerCCommitment).toBeTruthy();
    await harness.runtime.procurementService.withdrawProcurementCommitment(
      buyerCtx(harness.w025, "C", "w026-ac02-w-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: buyerCCommitment!.id,
        idempotencyKey: key("w026-ac02-w-withdraw"),
      },
    );
    const after = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac02-w-after"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(after.qualified).toBe(false);
    expect(after.selectedOfferId).toBeNull();
    // NEW offer submissions fail closed (the CURRENT qualification is
    // re-derived — a supplier cannot ride a stale qualification).
    const offerError = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac02-w-new"),
      unitPriceBand: "price_a_under_10",
    }).catch((e: unknown) => e);
    // Supplier A already holds the seeded offer — the conflict fires
    // only AFTER the qualification gate... the gate runs pre-flight
    // (before the lock/apply), so the qualification error surfaces
    // first: EITHER failure mode proves the gate; assert both classes
    // are acceptable in that order-documented way (InvalidSupplierOfferError
    // first by construction).
    expect(offerError).toBeInstanceOf(InvalidSupplierOfferError);
    expect((offerError as InvalidSupplierOfferError).context?.["reason"]).toBe(
      "pool_not_qualified",
    );
  });

  test("the derived selection view is a 200 DECISION for every outcome — unqualified pools return the decision, never an error", async () => {
    // A pool with no commitments at all: unqualified — the view still
    // derives (the decision is the product).
    const pool = await createProcurementPool(harness.w025, {
      name: "AC-02 Empty Pool",
    });
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac02-empty"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(false);
    expect(view.selectedOfferId).toBeNull();
    const poolQualifiedCheck = view.checks.find(
      (check) => check.check === "pool_qualified",
    );
    expect(poolQualifiedCheck?.satisfied).toBe(false);
    const eligibleCheck = view.checks.find(
      (check) => check.check === "eligible_offers_present",
    );
    expect(eligibleCheck?.satisfied).toBe(false);
    expect(view.digest).toBeTruthy();
    expect(typeof view.evaluatedAt).toBe("string");
  });
});
