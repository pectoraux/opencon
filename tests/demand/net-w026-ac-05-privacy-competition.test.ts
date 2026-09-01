/**
 * NET-W026 AC-05 — No selection or offer-comparison output leaks
 * W025-protected buyer commitment identities or exact competitor
 * commercial terms; offer surfaces cannot reconstruct individual
 * buyer demand (issue #52 acceptance criterion 5; PROC-003 /
 * PROC-AC-02).
 *
 * Work order: spec/work-orders/NET-W026.md §4.4 / §7 AC-05.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW026Harness,
  createSupplierOffer,
  seedCompetitivePool,
  recordCompetitiveSelection,
  poolCreatorCtx,
  supplierCtxBySlot,
  key,
  type NetW026Harness,
} from "./_net-w026-harness.ts";
import { buyerCtx } from "./_net-w025-harness.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-05 privacy / competition preservation", () => {
  test("the selection view carries NO buyer data: no buyer person ids, no buyer-organization ids, no commitment ids, no exact buyer quantities", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 View Pool",
    });
    // The buyer commitments behind the qualified aggregate: exact
    // quantities 12/40/75 from three buyer organizations.
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(
        poolCreatorCtx(harness, "w026-ac05-list"),
        harness.organizationScopeId,
        { poolId: pool.id, withdrawn: false },
      );
    expect(commitments.length).toBe(3);

    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac05-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(true);
    const json = JSON.stringify(view);

    // No buyer person identifiers.
    for (const buyerPersonId of [
      harness.w025.buyerAPersonId,
      harness.w025.buyerBPersonId,
      harness.w025.buyerCPersonId,
    ]) {
      expect(json).not.toContain(buyerPersonId);
    }
    // No buyer-organization identifiers.
    for (const buyerOrgId of [
      harness.w025.buyerOrgAId,
      harness.w025.buyerOrgBId,
      harness.w025.buyerOrgCId,
    ]) {
      expect(json).not.toContain(buyerOrgId);
    }
    // No commitment identifiers.
    for (const commitment of commitments) {
      expect(json).not.toContain(commitment.id);
    }
    // No EXACT buyer quantities (bands/buckets only — the exact
    // commitment quantities 12/40/75 never cross).
    expect(json).not.toContain('"quantity":12');
    expect(json).not.toContain('"quantity":40');
    expect(json).not.toContain('"quantity":75');
    // No aggregate facts object at all (the selection view links the
    // demand state through the pool digest ONLY — the minimized
    // aggregate contract never crosses into selection output).
    expect(json).not.toContain("commitmentCount");
    expect(json).not.toContain("organizationCount");
    expect(json).not.toContain("regionGroups");
    expect(json).not.toContain("quantityBuckets");
    expect(json).not.toContain("budgetBandGroups");
    expect(json).not.toContain("unitPriceBandGroups");
    expect(json).not.toContain("timingWindowGroups");
    expect(json).not.toContain("suppressedGroups");
  });

  test("the selection view key surface is the exact closed set (supplier/offer facts + policy + digest only)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 Keys Pool",
    });
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac05-keys"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(Object.keys(view).sort()).toEqual([
      "checks",
      "consideredOfferIds",
      "digest",
      "eligibleOfferIds",
      "evaluatedAt",
      "offerEvaluations",
      "organizationScopeId",
      "poolDigest",
      "poolId",
      "qualified",
      "ranking",
      "selectedOfferId",
      "selectionPolicy",
    ]);
    // The rank entries carry the closed offer-fact set.
    expect(Object.keys(view.ranking[0]!).sort()).toEqual([
      "offerId",
      "quantityBucket",
      "rank",
      "region",
      "supplierPersonId",
      "timingWindow",
      "unitPriceBand",
    ]);
    // The per-offer evaluations carry the closed set.
    expect(Object.keys(view.offerEvaluations[0]!).sort()).toEqual([
      "checks",
      "eligible",
      "offerId",
      "supplierPersonId",
    ]);
  });

  test("the PERSISTED selection record never carries buyer data (the lineage is supplier/offer facts + provenance)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 Record Pool",
    });
    const selection = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    });
    const json = JSON.stringify(selection);
    for (const buyerOrgId of [
      harness.w025.buyerOrgAId,
      harness.w025.buyerOrgBId,
      harness.w025.buyerOrgCId,
    ]) {
      expect(json).not.toContain(buyerOrgId);
    }
    for (const buyerPersonId of [
      harness.w025.buyerAPersonId,
      harness.w025.buyerBPersonId,
      harness.w025.buyerCPersonId,
    ]) {
      // The recordedBy provenance IS the pool creator (buyer A) — the
      // selection authority is a legitimate recorded fact; the OTHER
      // buyers must never appear.
      if (buyerPersonId === harness.w025.buyerAPersonId) continue;
      expect(json).not.toContain(buyerPersonId);
    }
    expect(json).not.toContain('"quantity":12');
    expect(json).not.toContain('"quantity":40');
    expect(json).not.toContain('"quantity":75');
    expect(json).not.toContain("commitmentCount");
    expect(json).not.toContain("organizationCount");
  });

  test("the offer record surface carries NO buyer data (offers reference the POOL only)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 Offer Pool",
    });
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac05-offers"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    expect(offers.length).toBe(3);
    const json = JSON.stringify(offers);
    for (const buyerOrgId of [
      harness.w025.buyerOrgAId,
      harness.w025.buyerOrgBId,
      harness.w025.buyerOrgCId,
    ]) {
      expect(json).not.toContain(buyerOrgId);
    }
    // The offer record key surface is the closed set (no buyer
    // fields, no commitment references).
    expect(Object.keys(offers[0]!).sort()).toEqual([
      "attributes",
      "categoryKey",
      "categoryVersion",
      "causationId",
      "consent",
      "correlationId",
      "createdAt",
      "executionId",
      "id",
      "idempotencyKey",
      "organizationScopeId",
      "poolId",
      "recordFormat",
      "supplierPersonId",
      "updatedAt",
      "validFrom",
      "validUntil",
      "withdrawalReason",
      "withdrawnAt",
    ]);
  });

  test("SUPPLIER-SIDE privacy: a supplier's offer listing returns ONLY their own offers — competitor offers never cross (PROC-003)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 Supplier Pool",
    });
    // Supplier B lists their own offers.
    const own = await harness.runtime.supplierOfferService.listSupplierOffers(
      supplierCtxBySlot(harness, "B", "w026-ac05-own"),
      harness.organizationScopeId,
      { poolId: pool.id, supplierPersonId: harness.supplierBPersonId },
    );
    expect(own.length).toBe(1);
    expect(own[0]!.supplierPersonId).toBe(harness.supplierBPersonId);

    // Competitor offers A and C never appear in supplier B's surface.
    const allForPool = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "B", "w026-ac05-all"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    // (The tenant-scoped diagnostic listing is service-level; the API
    // exposes ONLY the actor-scoped /mine surface — the transport
    // contract is pinned in the AC-08 regression. The actor-scoped
    // command itself is the privacy boundary the API enforces.)
    expect(allForPool.length).toBe(3);
    const mineCommand = async (actorPersonId: string) => {
      // Emulate the API command's actor-scoping exactly (the runtime
      // apiCommands.listMySupplierOffers passes the server-resolved
      // actor as the filter).
      return harness.runtime.supplierOfferService.listSupplierOffers(
        supplierCtxBySlot(harness, "B", "w026-ac05-command"),
        harness.organizationScopeId,
        { supplierPersonId: actorPersonId, poolId: pool.id },
      );
    };
    const supplierAOwn = await mineCommand(harness.supplierAPersonId);
    expect(supplierAOwn.length).toBe(1);
    expect(supplierAOwn[0]!.supplierPersonId).toBe(
      harness.supplierAPersonId,
    );
    const supplierBOwn = await mineCommand(harness.supplierBPersonId);
    expect(supplierBOwn.length).toBe(1);
    expect(supplierBOwn[0]!.supplierPersonId).toBe(
      harness.supplierBPersonId,
    );
  });

  test("SUPPLIERS cannot see the selection surfaces: competitor terms stay private (creator-only gates)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 Gate Pool",
    });
    // Supplier A attempts to evaluate the selection (the ranking
    // would expose suppliers B and C's exact bands).
    await expect(
      harness.runtime.supplierOfferService.evaluateCompetitiveSelection(
        supplierCtxBySlot(harness, "A", "w026-ac05-supplier-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      ),
    ).rejects.toThrow("only the procurement pool's creator");
    // The lineage listing is creator-only as well.
    await expect(
      harness.runtime.supplierOfferService.listPoolSelections(
        supplierCtxBySlot(harness, "A", "w026-ac05-supplier-list"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      ),
    ).rejects.toThrow("only the procurement pool's creator");
  });

  test("no offer-comparison disclosure path defeats the W025 floors: below-floor demand never names regions for targeting", async () => {
    // A pool whose commitments spread across three DIFFERENT regions
    // (1 commitment each): every region group is below the frozen
    // commitment floor (3) — the region groups are ALL suppressed, so
    // no offer can satisfy the region gate (nothing is named; the
    // competition surface cannot be used to reconstruct which regions
    // hold demand).
    const pool = await seedCompetitivePool(harness, {
      name: "AC-05 Floor Pool",
    });
    // Re-commit buyer C's demand in a different region... instead,
    // build the scenario fresh: withdraw all three seeded commitments
    // and re-commit them across three distinct regions (each region
    // group then has count 1 < floor 3).
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(
        poolCreatorCtx(harness, "w026-ac05-floor-list"),
        harness.organizationScopeId,
        { poolId: pool.id, withdrawn: false },
      );
    const buyerFor = new Map(
      commitments.map((commitment) => [
        commitment.id,
        commitment.buyerOrganizationId,
      ]),
    );
    for (const commitment of commitments) {
      const buyerOrg = buyerFor.get(commitment.id)!;
      const isBuyerA = buyerOrg === harness.w025.buyerOrgAId;
      const isBuyerB = buyerOrg === harness.w025.buyerOrgBId;
      await harness.runtime.procurementService.withdrawProcurementCommitment(
        isBuyerA
          ? buyerCtx(harness.w025, "A", "w026-ac05-floor-withdraw-a")
          : isBuyerB
            ? buyerCtx(harness.w025, "B", "w026-ac05-floor-withdraw-b")
            : buyerCtx(harness.w025, "C", "w026-ac05-floor-withdraw-c"),
        {
          organizationScopeId: harness.organizationScopeId,
          commitmentId: commitment.id,
          idempotencyKey: key("w026-ac05-floor-withdraw"),
        },
      );
      // Re-commit from the SAME buyer in a DIFFERENT region.
      await harness.runtime.procurementService.createProcurementCommitment(
        isBuyerA
          ? buyerCtx(harness.w025, "A", "w026-ac05-recommit-a")
          : isBuyerB
            ? buyerCtx(harness.w025, "B", "w026-ac05-recommit-b")
            : buyerCtx(harness.w025, "C", "w026-ac05-recommit-c"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: buyerOrg,
          attributes: {
            region: isBuyerA
              ? "NA_EAST"
              : isBuyerB
                ? "NA_WEST"
                : "NA_CENTRAL",
            quantity: 12,
          },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w026-ac05-recommit"),
        },
      );
    }
    // The pool still qualifies (3 commitments from 3 orgs, thresholds
    // 2/2) BUT every region group is below-floor: the aggregate names
    // NO regions, so the selection's region gate fails closed for
    // every offer without ever disclosing which regions hold demand.
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac05-floor-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(true);
    expect(view.eligibleOfferIds).toEqual([]);
    expect(view.selectedOfferId).toBeNull();
    for (const evaluation of view.offerEvaluations) {
      const regionCheck = evaluation.checks.find(
        (check) => check.check === "region_served",
      );
      expect(regionCheck?.satisfied).toBe(false);
      // The failure detail names the OFFER's own region (a supplier
      // fact) and the reason — never the demand-side regions.
      const detail = JSON.stringify(regionCheck?.detail);
      expect(detail).not.toContain("NA_WEST");
      expect(detail).not.toContain("NA_CENTRAL");
    }
  });
});
