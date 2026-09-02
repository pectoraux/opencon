/**
 * NET-W036 AC-03 — Supplier offers and selection (work order §5 AC-03 +
 * the frozen ledger §4): offers are owned by `/demand`, hard
 * eligibility PRECEDES deterministic competitive selection, at least
 * one candidate is hard-excluded, and the winner is deterministic —
 * a PROCUREMENT decision with NO economic mutation.
 *
 * The canonical hard-ineligible mechanism (the stage-1 deviation of
 * record, mirroring the canonical scenario): supplier D is created as
 * an ACTIVE tenant member, submits the fourth offer, and has its
 * tenant membership REVOKED before the eligibility evaluation — the
 * `supplier_authorized` hard gate excludes D's offer from the ranking
 * (reason "supplier_membership_not_active"). A deterministically
 * EXPIRED validity window is NOT constructible (createSupplierOffer
 * rejects a validUntil that is not strictly after the server-set
 * submission instant, and the evaluation anchor is milliseconds later).
 *
 * Mutation targets covered (ledger §4): rank before hard gates; accept
 * stale/ineligible offer; AI/advisory override; economic mutation
 * during selection.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac03-…`),
 * fixed person/subject fixtures — NO `Date.now(`, NO `randomUUID`, NO
 * `new Date(` code tokens in this file. ONE harness per file (the
 * W025/W026 AC-suite precedent); every test seeds its OWN pool.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW036Harness,
  personCtx,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { createSupplierMember } from "../demand/_net-w026-harness.ts";
import { AuthorizationError } from "../../src/core/errors.ts";
import {
  InvalidSupplierOfferError,
  SupplierOfferConflictError,
} from "../../src/core/procurement-offer.ts";
import type {
  CompetitiveSelection,
  ProcurementPool,
  SupplierOffer,
} from "../../src/demand/port.ts";

let harness: NetW036Harness;

beforeAll(async () => {
  harness = await createNetW036Harness();
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

/** Seed one QUALIFIED pool (three buyer organizations, all NA_EAST). */
async function seedQualifiedPool(
  name: string,
  poolKey: string,
): Promise<ProcurementPool> {
  const scope = harness.organizationScopeId;
  const pool = (
    await harness.runtime.procurementService.createProcurementPool(
      harness.poolCreatorCtx("w036-ac03-pool"),
      {
        organizationScopeId: scope,
        name,
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: {
          minimumCommitments: 2,
          minimumOrganizations: 2,
        },
        idempotencyKey: poolKey,
      },
    )
  ).pool;
  const commitmentSeeds: readonly {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-ac03-commit-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: `${poolKey}-commit-a`,
    },
    {
      ctx: harness.buyerBCtx("w036-ac03-commit-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: `${poolKey}-commit-b`,
    },
    {
      ctx: harness.buyerCCtx("w036-ac03-commit-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: `${poolKey}-commit-c`,
    },
  ];
  for (const seed of commitmentSeeds) {
    await harness.runtime.procurementService.createProcurementCommitment(
      seed.ctx,
      {
        organizationScopeId: scope,
        poolId: pool.id,
        buyerOrganizationId: seed.buyerOrganizationId,
        attributes: {
          region: "NA_EAST",
          quantity: seed.quantity,
          budgetBand: "band_b_1k_9k",
          unitPriceBand: "price_b_10_49",
          timingWindow: "window_short_1_3mo",
        },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: seed.key,
      },
    );
  }
  return pool;
}

/** Record one supplier offer (defaults: NA_EAST, open-ended validity). */
async function offer(
  ctx: ReturnType<typeof harness.supplierACtx>,
  poolId: string,
  opts: {
    readonly key: string;
    readonly unitPriceBand?: string;
    readonly region?: string;
  },
): Promise<SupplierOffer> {
  return (
    await harness.runtime.supplierOfferService.createSupplierOffer(ctx, {
      organizationScopeId: harness.organizationScopeId,
      poolId,
      attributes: {
        region: opts.region ?? "NA_EAST",
        unitPriceBand: opts.unitPriceBand ?? "price_b_10_49",
        timingWindow: "window_short_1_3mo",
        quantityBucket: "q_100_999",
      },
      validUntil: null,
      consent: { scope: "competitive_selection" },
      idempotencyKey: opts.key,
    })
  ).offer;
}

describe("NET-W036-AC-03 supplier offers and selection", () => {
  test("four offers recorded through /demand; the hard-ineligible supplier D is excluded BEFORE ranking (supplier_membership_not_active) and is absent from the ranking, the eligible set and the selection", async () => {
    const runtime = harness.runtime;
    const pool = await seedQualifiedPool(
      "W036 AC-03 Exclusion Pool",
      "w036-ac03-pool-exclusion",
    );

    // Supplier D — an ACTIVE tenant member at submission time (the
    // authorized-supplier gate at offer creation).
    const supplierD = await createSupplierMember(
      runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      {
        displayName: "W036 AC-03 Supplier D",
        subjectId: "w036-ac03-supplier-d@example.com",
      },
    );
    const offers = [
      await offer(harness.supplierACtx("w036-ac03-offer-a"), pool.id, {
        key: "w036-ac03-offer-a",
        unitPriceBand: "price_a_under_10",
      }),
      await offer(harness.supplierBCtx("w036-ac03-offer-b"), pool.id, {
        key: "w036-ac03-offer-b",
        unitPriceBand: "price_b_10_49",
      }),
      await offer(harness.supplierCCtx("w036-ac03-offer-c"), pool.id, {
        key: "w036-ac03-offer-c",
        unitPriceBand: "price_c_50_99",
      }),
      await offer(
        personCtx(harness, supplierD.personId, "w036-ac03-offer-d"),
        pool.id,
        {
          key: "w036-ac03-offer-d",
          unitPriceBand: "price_d_100_499",
        },
      ),
    ];

    // Every offer is a durable /demand record: server-assigned id,
    // record-format lineage, the SERVER-WRITTEN competitive-selection
    // consent grant, the acting person as the supplier.
    expect(offers).toHaveLength(4);
    for (const [index, o] of offers.entries()) {
      expect(o.id).not.toBe("");
      expect(o.poolId).toBe(pool.id);
      expect(o.recordFormat).toBe("NET-W026:1");
      expect(o.consent.scope).toBe("competitive_selection");
      expect(o.withdrawnAt).toBeNull();
      expect(o.validUntil).toBeNull();
      expect(o.attributes.region).toBe("NA_EAST");
      const expectedSupplier = [
        harness.supplierAPersonId,
        harness.supplierBPersonId,
        harness.supplierCPersonId,
        supplierD.personId,
      ][index]!;
      expect(o.supplierPersonId).toBe(expectedSupplier);
    }

    // The canonical hard-ineligible mechanism: supplier D's tenant
    // membership is REVOKED before the eligibility evaluation.
    await runtime.membershipService.revokeMembership(
      harness.bootstrapCtx,
      supplierD.tenantMembershipId,
      "bootstrap",
    );

    const view = await runtime.supplierOfferService.evaluateCompetitiveSelection(
      harness.poolCreatorCtx("w036-ac03-exclusion"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      },
    );
    // ALL FOUR offers are considered (the offer set), but only THREE
    // are eligible: hard eligibility precedes ranking.
    expect(view.consideredOfferIds).toHaveLength(4);
    for (const o of offers) {
      expect(view.consideredOfferIds).toContain(o.id);
    }
    const excluded = view.offerEvaluations.find(
      (e) => e.offerId === offers[3]!.id,
    )!;
    expect(excluded).toBeDefined();
    expect(excluded.eligible).toBe(false);
    const authorizationCheck = excluded.checks.find(
      (c) => c.check === "supplier_authorized",
    )!;
    expect(authorizationCheck.satisfied).toBe(false);
    expect(authorizationCheck.detail.reason).toBe(
      "supplier_membership_not_active",
    );
    // The region + validity gates still PASS for D — the exclusion is
    // attributable to the authorization gate ALONE.
    const regionCheck = excluded.checks.find(
      (c) => c.check === "region_served",
    )!;
    expect(regionCheck.satisfied).toBe(true);
    const validityCheck = excluded.checks.find(
      (c) => c.check === "offer_validity",
    )!;
    expect(validityCheck.satisfied).toBe(true);

    // D's offer is ABSENT from the eligible set, the ranking and the
    // selection; A/B/C remain, ranked by the price-band criterion.
    expect(view.eligibleOfferIds).toHaveLength(3);
    expect(view.eligibleOfferIds).not.toContain(offers[3]!.id);
    expect(view.ranking).toHaveLength(3);
    for (const entry of view.ranking) {
      expect(entry.offerId).not.toBe(offers[3]!.id);
    }
    expect(view.ranking.map((entry) => entry.offerId)).toEqual([
      offers[0]!.id,
      offers[1]!.id,
      offers[2]!.id,
    ]);
    expect(view.ranking[0]!.supplierPersonId).toBe(harness.supplierAPersonId);
    expect(view.selectedOfferId).toBe(offers[0]!.id);
    // The versioned server-owned selection policy (criteria order).
    expect(view.selectionPolicy.version).toBe(1);
    expect(view.selectionPolicy.rankingCriteria).toEqual([
      "unit_price_band_ascending",
      "timing_window_ascending",
      "quantity_capacity_descending",
      "offer_id_ascending",
    ]);
  }, 120_000);

  test("DETERMINISM: two independent evaluations of the same pool yield the identical digest, selectedOfferId and ranking order", async () => {
    const runtime = harness.runtime;
    const pool = await seedQualifiedPool(
      "W036 AC-03 Determinism Pool",
      "w036-ac03-pool-determinism",
    );
    const offers = [
      await offer(harness.supplierACtx("w036-ac03-d-offer-a"), pool.id, {
        key: "w036-ac03-d-offer-a",
        unitPriceBand: "price_a_under_10",
      }),
      await offer(harness.supplierBCtx("w036-ac03-d-offer-b"), pool.id, {
        key: "w036-ac03-d-offer-b",
        unitPriceBand: "price_b_10_49",
      }),
      await offer(harness.supplierCCtx("w036-ac03-d-offer-c"), pool.id, {
        key: "w036-ac03-d-offer-c",
        unitPriceBand: "price_c_50_99",
      }),
    ];
    const first = await runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        harness.poolCreatorCtx("w036-ac03-d-eval-1"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    const second = await runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        harness.poolCreatorCtx("w036-ac03-d-eval-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    // The digest EXCLUDES the evaluation anchor: identical
    // authoritative state ⇒ identical decision facts.
    expect(second.digest).toBe(first.digest);
    expect(second.selectedOfferId).toBe(first.selectedOfferId);
    expect(second.selectedOfferId).toBe(offers[0]!.id);
    expect(second.eligibleOfferIds).toEqual(first.eligibleOfferIds);
    expect(second.ranking.map((entry) => entry.offerId)).toEqual(
      first.ranking.map((entry) => entry.offerId),
    );
    expect(second.ranking.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    // The ranking follows the FIRST criterion (unit price band
    // ascending: a < b < c).
    expect(second.ranking.map((entry) => entry.unitPriceBand)).toEqual([
      "price_a_under_10",
      "price_b_10_49",
      "price_c_50_99",
    ]);
    // The evaluation mutates nothing and audits nothing (a derived 200
    // decision).
    const eventsBefore = await runtime.auditWriter.query({});
    await runtime.supplierOfferService.evaluateCompetitiveSelection(
      harness.poolCreatorCtx("w036-ac03-d-eval-3"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      },
    );
    const eventsAfter = await runtime.auditWriter.query({});
    expect(eventsAfter.length).toBe(eventsBefore.length);
  }, 120_000);

  test("recordCompetitiveSelection commits the durable lineage (policy version + digest); same-key replay is exactly-once; the lineage is readable via listPoolSelections", async () => {
    const runtime = harness.runtime;
    const pool = await seedQualifiedPool(
      "W036 AC-03 Record Pool",
      "w036-ac03-pool-record",
    );
    const offers = [
      await offer(harness.supplierACtx("w036-ac03-r-offer-a"), pool.id, {
        key: "w036-ac03-r-offer-a",
        unitPriceBand: "price_a_under_10",
      }),
      await offer(harness.supplierBCtx("w036-ac03-r-offer-b"), pool.id, {
        key: "w036-ac03-r-offer-b",
        unitPriceBand: "price_b_10_49",
      }),
      await offer(harness.supplierCCtx("w036-ac03-r-offer-c"), pool.id, {
        key: "w036-ac03-r-offer-c",
        unitPriceBand: "price_c_50_99",
      }),
    ];
    const qualified = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        harness.poolCreatorCtx("w036-ac03-r-qualified"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    const ctx = harness.poolCreatorCtx("w036-ac03-r-record");
    const first = await runtime.supplierOfferService.recordCompetitiveSelection(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        idempotencyKey: "w036-ac03-selection",
      },
    );
    expect(first.created).toBe(true);
    const selection: CompetitiveSelection = first.selection;
    expect(selection.selectedOfferId).toBe(offers[0]!.id);
    expect(selection.recordedBy).toBe(harness.poolCreatorPersonId);
    expect(selection.recordFormat).toBe("NET-W026:1");
    expect(selection.selectionPolicy.version).toBe(1);
    expect(selection.selectionPolicy.rankingCriteria[0]).toBe(
      "unit_price_band_ascending",
    );
    // The record's pool digest links to the EXACT minimized demand
    // state the offers competed against.
    expect(selection.poolDigest).toBe(qualified.digest);
    expect(selection.qualified).toBe(true);
    expect(selection.digest).not.toBe("");
    // The eligible set in RANKED (decision) order — the price-band order.
    expect(selection.eligibleOfferIds).toEqual(offers.map((o) => o.id));
    expect(selection.ranking.map((entry) => entry.offerId)).toEqual(
      offers.map((o) => o.id),
    );

    // Same-key replay: created:false + the IDENTICAL record + exactly
    // ONE audit event.
    const replay = await runtime.supplierOfferService
      .recordCompetitiveSelection(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        idempotencyKey: "w036-ac03-selection",
      });
    expect(replay.created).toBe(false);
    expect(replay.selection).toEqual(selection);
    const events = await runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
      resourceId: selection.id,
    });
    expect(events).toHaveLength(1);

    // The append-only lineage: a re-tender with a DIFFERENT key records
    // a NEW selection; listPoolSelections returns the pool's lineage
    // (newest first by (createdAt, id)).
    const reTender = await runtime.supplierOfferService
      .recordCompetitiveSelection(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        idempotencyKey: "w036-ac03-selection-re-tender",
      });
    expect(reTender.created).toBe(true);
    expect(reTender.selection.id).not.toBe(selection.id);
    expect(reTender.selection.digest).toBe(selection.digest);
    const lineage = await runtime.supplierOfferService.listPoolSelections(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      },
    );
    expect(lineage).toHaveLength(2);
    expect(lineage[0]!.id).toBe(reTender.selection.id);
    expect(lineage[1]!.id).toBe(selection.id);
    const reTenderEvents = await runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
      resourceId: reTender.selection.id,
    });
    expect(reTenderEvents).toHaveLength(1);
  }, 120_000);

  test("NO ECONOMIC SIDE EFFECT: the view/record/offer surfaces carry no economic vocabulary and the commands emit no ledger/economic audit events (the W026 AC-07 mirror)", async () => {
    const runtime = harness.runtime;
    const pool = await seedQualifiedPool(
      "W036 AC-03 Economic Pool",
      "w036-ac03-pool-economic",
    );
    const offers = [
      await offer(harness.supplierACtx("w036-ac03-e-offer-a"), pool.id, {
        key: "w036-ac03-e-offer-a",
        unitPriceBand: "price_a_under_10",
      }),
      await offer(harness.supplierBCtx("w036-ac03-e-offer-b"), pool.id, {
        key: "w036-ac03-e-offer-b",
        unitPriceBand: "price_b_10_49",
      }),
      await offer(harness.supplierCCtx("w036-ac03-e-offer-c"), pool.id, {
        key: "w036-ac03-e-offer-c",
        unitPriceBand: "price_c_50_99",
      }),
    ];
    const view = await runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        harness.poolCreatorCtx("w036-ac03-e-view"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    const selection = (
      await runtime.supplierOfferService.recordCompetitiveSelection(
        harness.poolCreatorCtx("w036-ac03-e-record"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: "w036-ac03-e-selection",
        },
      )
    ).selection;

    // (a) The derived view + the durable record + the offer records
    //     carry NO economic fields (bands only — an exact price is
    //     unrepresentable).
    for (const [label, json] of [
      ["view", JSON.stringify(view)],
      ["record", JSON.stringify(selection)],
      ["offers", JSON.stringify(offers)],
    ] as const) {
      const lower = json.toLowerCase();
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
        expect(lower, `${label} must not carry ${economicTerm}`).not.toContain(
          economicTerm,
        );
      }
    }

    // (b) The offer/selection commands emit ONLY the procurement audit
    //     vocabulary on this pool's resources.
    const eventTypes = new Set<string>();
    for (const eventType of [
      "procurement_offer.recorded",
      "procurement_offer.withdrawn",
      "procurement_selection.recorded",
    ]) {
      const events = await runtime.auditWriter.query({ eventType });
      for (const event of events) {
        const metadata = event.metadata as Record<string, unknown>;
        if (metadata["poolId"] === pool.id) {
          eventTypes.add(event.eventType as string);
        }
      }
    }
    expect([...eventTypes].sort()).toEqual([
      "procurement_offer.recorded",
      "procurement_selection.recorded",
    ]);

    // (c) The selection audit metadata key surface: procurement facts +
    //     provenance ONLY (the W026-reviewed key set).
    const selectionEvents = await runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
      resourceId: selection.id,
    });
    expect(selectionEvents).toHaveLength(1);
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
    const metadataJson = JSON.stringify(metadata).toLowerCase();
    for (const economicTerm of [
      "credit",
      "ledger",
      "posting",
      "obligation",
      "payout",
      "reward",
      "stake",
      "balance",
      "amount",
    ]) {
      expect(metadataJson).not.toContain(economicTerm);
    }

    // (d) NO settlement-side audit events are attributable to the
    //     offer/selection resources (zero economic side effects).
    const settlementEvents = await runtime.auditWriter.query({
      eventType: "ledger.entry_posted",
    });
    const w036ResourceTypes = new Set([
      "procurement_offer",
      "procurement_selection",
    ]);
    expect(
      settlementEvents.filter((event) =>
        w036ResourceTypes.has(event.resourceType as string),
      ),
    ).toEqual([]);
  }, 120_000);

  test("authorization negatives: only the pool creator may evaluate, record or read the selection lineage", async () => {
    const runtime = harness.runtime;
    const pool = await seedQualifiedPool(
      "W036 AC-03 Authorization Pool",
      "w036-ac03-pool-authorization",
    );
    await offer(harness.supplierACtx("w036-ac03-auth-offer-a"), pool.id, {
      key: "w036-ac03-auth-offer-a",
      unitPriceBand: "price_a_under_10",
    });

    // A supplier (an active tenant member, NOT the pool creator)
    // cannot evaluate the selection view.
    const supplierEvalError = await runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        harness.supplierACtx("w036-ac03-auth-eval"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      )
      .catch((e: unknown) => e);
    expect(supplierEvalError).toBeInstanceOf(AuthorizationError);
    expect((supplierEvalError as AuthorizationError).code).toBe(
      "AUTHORIZATION",
    );

    // A different buyer (an active member, NOT the creator) cannot
    // record the selection.
    const buyerRecordError = await runtime.supplierOfferService
      .recordCompetitiveSelection(
        harness.buyerBCtx("w036-ac03-auth-record"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: "w036-ac03-auth-selection",
        },
      )
      .catch((e: unknown) => e);
    expect(buyerRecordError).toBeInstanceOf(AuthorizationError);
    expect((buyerRecordError as AuthorizationError).code).toBe(
      "AUTHORIZATION",
    );

    // The lineage read is creator-only as well.
    const supplierListError = await runtime.supplierOfferService
      .listPoolSelections(harness.supplierACtx("w036-ac03-auth-list"), {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      })
      .catch((e: unknown) => e);
    expect(supplierListError).toBeInstanceOf(AuthorizationError);

    // Nothing was recorded by the rejected attempts.
    const lineage = await runtime.supplierOfferService.listPoolSelections(
      harness.poolCreatorCtx("w036-ac03-auth-lineage"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      },
    );
    expect(lineage).toEqual([]);
  }, 120_000);

  test("validation/eligibility negatives: unqualified pool, duplicate active offer, region-ineligible offer and revoked supplier all fail closed", async () => {
    const runtime = harness.runtime;

    // (a) An offer against an UNQUALIFIED pool (no commitments — the
    //     floors fail): SUPPLIER_OFFER_VALIDATION, reason
    //     pool_not_qualified (re-derived server-side, never
    //     caller-asserted).
    const unqualifiedPool = (
      await runtime.procurementService.createProcurementPool(
        harness.poolCreatorCtx("w036-ac03-unqualified-pool"),
        {
          organizationScopeId: harness.organizationScopeId,
          name: "W036 AC-03 Unqualified Pool",
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: {
            minimumCommitments: 2,
            minimumOrganizations: 2,
          },
          idempotencyKey: "w036-ac03-pool-unqualified",
        },
      )
    ).pool;
    const unqualifiedError = await runtime.supplierOfferService
      .createSupplierOffer(harness.supplierACtx("w036-ac03-uq-offer"), {
        organizationScopeId: harness.organizationScopeId,
        poolId: unqualifiedPool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_a_under_10",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        validUntil: null,
        consent: { scope: "competitive_selection" },
        idempotencyKey: "w036-ac03-unqualified-offer",
      })
      .catch((e: unknown) => e);
    expect(unqualifiedError).toBeInstanceOf(InvalidSupplierOfferError);
    expect((unqualifiedError as InvalidSupplierOfferError).code).toBe(
      "SUPPLIER_OFFER_VALIDATION",
    );
    expect(
      ((unqualifiedError as InvalidSupplierOfferError).context as Record<
        string,
        unknown
      >)["reason"],
    ).toBe("pool_not_qualified");

    // (b) A SECOND active offer from the SAME supplier on the same
    //     pool: SUPPLIER_OFFER_CONFLICT (one active offer per
    //     (pool, supplier)).
    const conflictPool = await seedQualifiedPool(
      "W036 AC-03 Conflict Pool",
      "w036-ac03-pool-conflict",
    );
    const firstOffer = await offer(
      harness.supplierACtx("w036-ac03-conflict-a"),
      conflictPool.id,
      {
        key: "w036-ac03-conflict-offer-a",
        unitPriceBand: "price_a_under_10",
      },
    );
    const conflictError = await runtime.supplierOfferService
      .createSupplierOffer(harness.supplierACtx("w036-ac03-conflict-a2"), {
        organizationScopeId: harness.organizationScopeId,
        poolId: conflictPool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_b_10_49",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        validUntil: null,
        consent: { scope: "competitive_selection" },
        idempotencyKey: "w036-ac03-conflict-offer-a2",
      })
      .catch((e: unknown) => e);
    expect(conflictError).toBeInstanceOf(SupplierOfferConflictError);
    expect((conflictError as SupplierOfferConflictError).code).toBe(
      "SUPPLIER_OFFER_CONFLICT",
    );
    expect(
      ((conflictError as SupplierOfferConflictError).context as Record<
        string,
        unknown
      >)["existingOfferId"],
    ).toBe(firstOffer.id);

    // (c) A region-ineligible offer: the pool's named above-floor
    //     demand region is NA_EAST; an EU_WEST offer is RECORDED (a
    //     legitimate submission) but is hard-excluded from selection
    //     with reason region_not_in_named_demand.
    const regionPool = await seedQualifiedPool(
      "W036 AC-03 Region Pool",
      "w036-ac03-pool-region",
    );
    await offer(harness.supplierACtx("w036-ac03-region-a"), regionPool.id, {
      key: "w036-ac03-region-offer-a",
      unitPriceBand: "price_a_under_10",
    });
    const euOffer = await offer(
      harness.supplierBCtx("w036-ac03-region-b"),
      regionPool.id,
      {
        key: "w036-ac03-region-offer-b",
        unitPriceBand: "price_b_10_49",
        region: "EU_WEST",
      },
    );
    expect(euOffer.attributes.region).toBe("EU_WEST");
    const regionView = await runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        harness.poolCreatorCtx("w036-ac03-region-eval"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: regionPool.id,
        },
      );
    const regionEvaluation = regionView.offerEvaluations.find(
      (e) => e.offerId === euOffer.id,
    )!;
    expect(regionEvaluation.eligible).toBe(false);
    const regionCheck = regionEvaluation.checks.find(
      (c) => c.check === "region_served",
    )!;
    expect(regionCheck.satisfied).toBe(false);
    expect(regionCheck.detail.reason).toBe("region_not_in_named_demand");
    expect(regionView.eligibleOfferIds).not.toContain(euOffer.id);
    expect(regionView.selectedOfferId).not.toBe(euOffer.id);
    expect(regionView.selectedOfferId).not.toBe(null);

    // (d) A supplier with REVOKED membership cannot submit a NEW offer
    //     (the authorized-supplier gate at creation: membership_not_active).
    const revokedSupplier = await createSupplierMember(
      runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      {
        displayName: "W036 AC-03 Supplier E",
        subjectId: "w036-ac03-supplier-e@example.com",
      },
    );
    await runtime.membershipService.revokeMembership(
      harness.bootstrapCtx,
      revokedSupplier.tenantMembershipId,
      "bootstrap",
    );
    const revokedError = await runtime.supplierOfferService
      .createSupplierOffer(
        personCtx(harness, revokedSupplier.personId, "w036-ac03-revoked"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: regionPool.id,
          attributes: {
            region: "NA_EAST",
            unitPriceBand: "price_c_50_99",
            timingWindow: "window_short_1_3mo",
            quantityBucket: "q_100_999",
          },
          validUntil: null,
          consent: { scope: "competitive_selection" },
          idempotencyKey: "w036-ac03-revoked-offer",
        },
      )
      .catch((e: unknown) => e);
    expect(revokedError).toBeInstanceOf(AuthorizationError);
    expect(
      ((revokedError as AuthorizationError).context as Record<
        string,
        unknown
      >)["reason"],
    ).toBe("membership_not_active");
  }, 120_000);
});
