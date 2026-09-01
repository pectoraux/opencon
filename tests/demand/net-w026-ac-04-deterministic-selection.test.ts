/**
 * NET-W026 AC-04 — Given identical authoritative state + anchor,
 * ranking and selection are identical; tie-breaking is explicit and
 * stable; selection lineage is auditable (issue #52 acceptance
 * criterion 4).
 *
 * Work order: spec/work-orders/NET-W026.md §4.3 / §6 / §7 AC-04.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW026Harness,
  createSupplierOffer,
  createSupplierMember,
  seedCompetitivePool,
  seedQualifiedPool,
  recordCompetitiveSelection,
  poolCreatorCtx,
  supplierCtxBySlot,
  personCtx,
  key,
  type NetW026Harness,
} from "./_net-w026-harness.ts";
import {
  SUPPLIER_OFFER_RANKING_CRITERIA,
  SUPPLIER_OFFER_SELECTION_POLICY_VERSION,
} from "../../src/core/procurement-offer.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-04 deterministic competitive selection", () => {
  test("identical authoritative state produces the IDENTICAL digest across evaluations (the anchor is excluded)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-04 Digest Pool",
    });
    const first = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac04-digest-1"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // Force a DISTINCT anchor (same-millisecond evaluations would make
    // the anchor assertion vacuous — the same-ms pitfall of the
    // ms-precision nowIso()).
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac04-digest-2"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // Different evaluation anchors (fresh nowIso() per evaluation) —
    // but identical state, so the digests are IDENTICAL.
    expect(first.digest).toBe(second.digest);
    expect(first.evaluatedAt).not.toBe(second.evaluatedAt);
    expect(first.selectedOfferId).toBe(second.selectedOfferId);
    expect(first.ranking).toEqual(second.ranking);
  });

  test("the explicit ranking policy: price band ascending, then timing window, then capacity, then offer id", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-04 Ranking Pool",
    });
    // Supplier A: EXPENSIVE price (ranks last among price-diverse
    // offers).
    const expensive = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac04-expensive"),
      unitPriceBand: "price_e_500_plus",
      timingWindow: "window_immediate",
      quantityBucket: "q_10000_plus",
    });
    // Supplier B: mid price, SLOW window.
    const midSlow = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "B", "w026-ac04-mid-slow"),
      unitPriceBand: "price_b_10_49",
      timingWindow: "window_long_6_12mo",
      quantityBucket: "q_10_99",
    });
    // Supplier C: mid price, FAST window (outranks B on the timing
    // axis).
    const midFast = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "C", "w026-ac04-mid-fast"),
      unitPriceBand: "price_b_10_49",
      timingWindow: "window_short_1_3mo",
      quantityBucket: "q_10_99",
    });
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac04-rank-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.ranking.map((entry) => entry.offerId)).toEqual([
      midFast.id,
      midSlow.id,
      expensive.id,
    ]);
    expect(view.selectedOfferId).toBe(midFast.id);
    // The rank entries carry the explicit rank positions + the offer
    // facts the ranking consumed.
    expect(view.ranking[0]!.rank).toBe(1);
    expect(view.ranking[1]!.rank).toBe(2);
    expect(view.ranking[2]!.rank).toBe(3);
  });

  test("tie-breaking is EXPLICIT and STABLE: identical attributes rank by offer id ascending", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-04 Tie Pool",
    });
    // Three suppliers with IDENTICAL offer attributes.
    const offerA = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac04-tie-a"),
    });
    const offerB = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "B", "w026-ac04-tie-b"),
    });
    const offerC = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "C", "w026-ac04-tie-c"),
    });
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac04-tie-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // The expected order: offer id ascending (the stable final
    // tie-break — no input order ever leaks into the decision).
    const expectedOrder = [offerA, offerB, offerC]
      .map((offer) => offer.id)
      .sort();
    expect(view.ranking.map((entry) => entry.offerId)).toEqual(
      expectedOrder,
    );
    expect(view.selectedOfferId).toBe(expectedOrder[0]!);
    // The ranking is IDENTICAL across re-evaluations (stability).
    const again = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac04-tie-again"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(again.ranking).toEqual(view.ranking);
  });

  test("the ranking policy is explicit, versioned and recorded on every selection surface", () => {
    // The server-owned policy table is pinned.
    expect([...SUPPLIER_OFFER_RANKING_CRITERIA]).toEqual([
      "unit_price_band_ascending",
      "timing_window_ascending",
      "quantity_capacity_descending",
      "offer_id_ascending",
    ]);
    expect(SUPPLIER_OFFER_SELECTION_POLICY_VERSION).toBe(1);
  });

  test("the selection RECORD persists the offer set + rationale and is auditable (PROC-AC-03)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-04 Lineage Pool",
    });
    const ctx = poolCreatorCtx(harness, "w026-ac04-lineage");
    const result = await harness.runtime.supplierOfferService
      .recordCompetitiveSelection(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        idempotencyKey: key("w026-ac04-lineage"),
      });
    const selection = result.selection;
    expect(result.created).toBe(true);
    expect(selection.recordedBy).toBe(harness.w025.buyerAPersonId);
    expect(selection.poolId).toBe(pool.id);
    expect(selection.qualified).toBe(true);
    expect(selection.recordFormat).toBe("NET-W026:1");
    expect(selection.executionId).toBe(ctx.executionId);
    // The OFFER SET: all three active offers are recorded (ascending
    // id).
    expect(selection.consideredOfferIds.length).toBe(3);
    expect([...selection.consideredOfferIds]).toEqual(
      [...selection.consideredOfferIds].slice().sort(),
    );
    // The RATIONALE: the ranking + the per-offer evaluations + the
    // checks + the policy snapshot + the pool digest.
    expect(selection.ranking.length).toBe(3);
    expect(selection.offerEvaluations.length).toBe(3);
    expect(selection.checks.length).toBe(2);
    expect(selection.selectionPolicy.version).toBe(1);
    expect(selection.selectionPolicy.rankingCriteria).toEqual([
      ...SUPPLIER_OFFER_RANKING_CRITERIA,
    ]);
    expect(selection.poolDigest).toBeTruthy();
    expect(selection.selectedOfferId).toBe(selection.eligibleOfferIds[0]!);
    // The selected offer is supplier A's cheapest offer.
    expect(viewOf(selection).ranking[0]!.supplierPersonId).toBe(
      harness.supplierAPersonId,
    );

    // AUDIT LINEAGE: exactly one atomic event with full provenance.
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
      resourceId: selection.id,
    });
    expect(events.length).toBe(1);
    const event = events[0]!;
    const metadata = event.metadata as Record<string, unknown>;
    expect(typeof metadata["transactionId"]).toBe("string");
    expect(typeof metadata["idempotencyRecordId"]).toBe("string");
    expect(event.executionId).toBe(ctx.executionId);
    expect(event.actor).toBe(harness.w025.buyerAPersonId);
    expect(event.subject).toBe(selection.id);
    expect(event.resourceType).toBe("procurement_selection");
    expect(metadata["selectedOfferId"]).toBe(selection.selectedOfferId);
    expect(metadata["consideredOfferCount"]).toBe(3);
    expect(metadata["eligibleOfferCount"]).toBe(3);
    expect(metadata["digest"]).toBe(selection.digest);

    // The lineage listing returns the record (creator-scoped read).
    const listed = await harness.runtime.supplierOfferService
      .listPoolSelections(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      });
    expect(listed.length).toBe(1);
    expect(listed[0]!.id).toBe(selection.id);
  });

  test("re-tendering: a SECOND record (different key) over UNCHANGED state carries the SAME digest (distinct records)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-04 Re-Tender Pool",
    });
    const first = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    });
    const second = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    });
    // Distinct immutable records (append-only lineage)...
    expect(second.id).not.toBe(first.id);
    // ...with the IDENTICAL decision fingerprint (the digest excludes
    // the anchors; unchanged state ⇒ unchanged digest — the
    // reproducibility proof).
    expect(second.digest).toBe(first.digest);
    expect(second.selectedOfferId).toBe(first.selectedOfferId);
    // Two lineage records now exist for the pool.
    const listed = await harness.runtime.supplierOfferService
      .listPoolSelections(
        poolCreatorCtx(harness, "w026-ac04-retender-list"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    expect(listed.length).toBe(2);
  });

  test("an EXPIRED offer (validUntil in the past) re-derives as ineligible at the anchor", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-04 Expiry Pool",
    });
    // A short-fused validity window: 1ms after submission... the
    // offer is created valid, then the window passes.
    const freshOffer = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac04-expiry"),
      unitPriceBand: "price_a_under_10",
      validUntil: new Date(Date.now() + 5).toISOString(),
    });
    // Let the validity window lapse.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac04-expiry-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    const evaluation = view.offerEvaluations.find(
      (candidate) => candidate.offerId === freshOffer.id,
    );
    expect(evaluation).toBeTruthy();
    expect(evaluation!.eligible).toBe(false);
    const validityCheck = evaluation!.checks.find(
      (check) => check.check === "offer_validity",
    );
    expect(validityCheck?.satisfied).toBe(false);
    // The expired CHEAP offer is not selected; no other offer exists,
    // so the selection is null (a deterministic outcome, not an
    // error).
    expect(view.selectedOfferId).toBeNull();
    expect(view.eligibleOfferIds).toEqual([]);
  });
});

/** A minimal ranking accessor for record-level assertions. */
function viewOf(selection: {
  readonly ranking: ReadonlyArray<
    Record<"offerId" | "supplierPersonId", string>
  >;
}) {
  return { ranking: selection.ranking };
}
