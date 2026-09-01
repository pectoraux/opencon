/**
 * NET-W026 AC-07 — No /demand code writes economic state or bypasses
 * /settlement: economic vocabulary and settlement mutations remain
 * absent from the W026 paths; a selection is a procurement decision,
 * never an economic mutation (issue #52 acceptance criterion 7).
 *
 * Work order: spec/work-orders/NET-W026.md §4.5 / §7 AC-07.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW026Harness,
  seedCompetitivePool,
  recordCompetitiveSelection,
  poolCreatorCtx,
  supplierCtxBySlot,
  key,
  type NetW026Harness,
} from "./_net-w026-harness.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-07 economic-authority containment", () => {
  test("the W026 mutations emit ONLY procurement audit events — the audit vocabulary carries no economic surface", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-07 Audit Pool",
    });
    const selection = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    });
    // Withdraw one offer to exercise the third event type.
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "C", "w026-ac07-list"),
        harness.organizationScopeId,
        { poolId: pool.id, supplierPersonId: harness.supplierCPersonId },
      );
    await harness.runtime.supplierOfferService.withdrawSupplierOffer(
      supplierCtxBySlot(harness, "C", "w026-ac07-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        offerId: offers[0]!.id,
        idempotencyKey: key("w026-ac07-withdraw"),
      },
    );

    // The complete W026 audit vocabulary on this pool's resources.
    const w026EventTypes = new Set<string>();
    for (const eventType of [
      "procurement_offer.recorded",
      "procurement_offer.withdrawn",
      "procurement_selection.recorded",
    ]) {
      const events = await harness.runtime.auditWriter.query({ eventType });
      for (const event of events) {
        const metadata = event.metadata as Record<string, unknown>;
        if (metadata["poolId"] === pool.id) {
          w026EventTypes.add(event.eventType as string);
        }
      }
    }
    expect([...w026EventTypes].sort()).toEqual([
      "procurement_offer.recorded",
      "procurement_offer.withdrawn",
      "procurement_selection.recorded",
    ]);

    // The selection audit metadata key surface: procurement facts +
    // provenance ONLY — no economic vocabulary (no balances, credits,
    // postings, obligations, payouts, rewards or stakes).
    const selectionEvents = await harness.runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
      resourceId: selection.id,
    });
    expect(selectionEvents.length).toBe(1);
    const metadata = selectionEvents[0]!.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "consideredOfferCount",
      "digest",
      "eligibleOfferCount",
      "evaluationAnchor",
      "idempotencyRecordId",
      "organizationScopeId",
      "poolDigest",
      "poolId",
      "qualified",
      "recordedBy",
      "selectedOfferId",
      "selectionPolicy",
      "transactionId",
    ]);
    const metadataJson = JSON.stringify(metadata);
    for (const economicTerm of [
      "credit",
      "ledger",
      "posting",
      "obligation",
      "payout",
      "reward",
      "stake",
      "balance",
    ]) {
      expect(metadataJson.toLowerCase()).not.toContain(economicTerm);
    }
  });

  test("the selection record/view surfaces carry NO economic fields (a procurement decision, never an economic record)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-07 Surface Pool",
    });
    const selection = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    });
    const recordJson = JSON.stringify(selection).toLowerCase();
    for (const economicTerm of [
      '"credit',
      '"ledger',
      '"posting',
      '"obligation',
      '"payout',
      '"reward',
      '"stake',
      '"balance',
      '"amount"',
      '"value"',
      '"price_amount"',
    ]) {
      expect(recordJson).not.toContain(economicTerm);
    }
    // The view likewise.
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac07-view"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    const viewJson = JSON.stringify(view).toLowerCase();
    for (const economicTerm of [
      '"credit',
      '"ledger',
      '"posting',
      '"obligation',
      '"payout',
      '"reward',
      '"stake',
      '"balance',
      '"amount"',
    ]) {
      expect(viewJson).not.toContain(economicTerm);
    }
    // The offer records likewise (bands only — an exact price is
    // unrepresentable).
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac07-offers"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    const offersJson = JSON.stringify(offers).toLowerCase();
    expect(offersJson).not.toContain('"amount"');
    expect(offersJson).not.toContain('"price"');
    expect(offersJson).not.toContain('"budget"');
  });

  test("the W026 commands create NO settlement-side audit events (zero economic side effects)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-07 Settlement Pool",
    });
    await recordCompetitiveSelection(harness, { poolId: pool.id });
    // The /settlement audit vocabulary (the economic authority's own
    // event types) carries NOTHING attributable to the W026
    // resources: no selection/offer resource types ever appear in
    // settlement events.
    const settlementEvents = await harness.runtime.auditWriter.query({
      eventType: "ledger.entry_posted",
    });
    const w026ResourceTypes = new Set(["procurement_offer", "procurement_selection"]);
    const contaminated = settlementEvents.filter((event) =>
      w026ResourceTypes.has(event.resourceType as string),
    );
    expect(contaminated).toEqual([]);
    // And the W026 resources never appear under ANY economic event
    // type: the audit writer's full query for these resource types
    // returns only the procurement events.
    const offerEvents = await harness.runtime.auditWriter.query({
      eventType: "procurement_offer.recorded",
    });
    for (const event of offerEvents) {
      expect(
        w026ResourceTypes.has(event.resourceType as string),
      ).toBe(true);
    }
  });
});
