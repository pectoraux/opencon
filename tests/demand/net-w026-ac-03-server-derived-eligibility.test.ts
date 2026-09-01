/**
 * NET-W026 AC-03 — Hard eligibility is completely server-derived and
 * cannot be caller-asserted; unauthorized suppliers and cross-tenant
 * references fail closed without existence leakage (issue #52
 * acceptance criterion 3).
 *
 * Work order: spec/work-orders/NET-W026.md §4.2 / §7 AC-03.
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
import { AuthorizationError, NotFoundError } from "../../src/core/errors.ts";
import type { CreateSupplierOfferInput } from "../../src/demand/port.ts";

let harness: NetW026Harness;

beforeAll(async () => {
  harness = await createNetW026Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W026-AC-03 server-derived eligibility + fail-closed authorization", () => {
  test("caller-asserted eligibility/qualification/ranking/selection fields are IGNORED (no input surface exists)", async () => {
    const pool = await seedQualifiedPool(harness, {
      name: "AC-03 Assert Pool",
    });
    // A caller submits an offer with extra assertion fields — the
    // service reads ONLY its declared input fields; every other key
    // is ignored (no eligibility, rank or score input exists).
    const result = await harness.runtime.supplierOfferService
      .createSupplierOffer(
        supplierCtxBySlot(harness, "A", "w026-ac03-assert"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          attributes: {
            region: "NA_EAST",
            unitPriceBand: "price_b_10_49",
            timingWindow: "window_short_1_3mo",
            quantityBucket: "q_100_999",
          },
          consent: { scope: "competitive_selection" },
          idempotencyKey: key("w026-ac03-assert"),
          // Caller-asserted fields that MUST be ignored:
          eligible: true,
          qualified: true,
          rank: 0,
          score: 999999,
          selected: true,
        } as unknown as CreateSupplierOfferInput,
      );
    expect(result.created).toBe(true);
    // The record carries NO eligibility/rank/score fields at all (the
    // offer record schema is the closed set).
    expect(Object.keys(result.offer).sort()).toEqual([
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
    // The derived evaluation input accepts ONLY scope/pool identity —
    // extra assertion keys are ignored and the derivation is
    // unaffected.
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac03-eval"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          // Caller-asserted fields that MUST be ignored:
          qualified: true,
          selectedOfferId: "fabricated-offer-id",
          ranking: [{ offerId: "fabricated-offer-id", rank: 1 }],
        } as unknown as {
          organizationScopeId: string;
          poolId: string;
        },
      );
    expect(view.selectedOfferId).not.toBe("fabricated-offer-id");
    expect(view.qualified).toBe(true);
    // The selected offer is the REAL rank-1 eligible offer — the ONLY
    // real offer on this pool (supplier A's), never the caller's
    // assertion.
    expect(view.selectedOfferId).toBe(result.offer.id);
    expect(view.ranking[0]!.supplierPersonId).toBe(
      harness.supplierAPersonId,
    );
  });

  test("an UNAUTHORIZED supplier (non-member) fails closed", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-03 Non-Member Pool",
    });
    const outsider = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-03 Outsider",
        subjectReferences: [
          {
            subjectId: "w026-ac03-outsider@example.com",
            providerKind: "internal",
          },
        ],
      },
    );
    await expect(
      harness.runtime.supplierOfferService.createSupplierOffer(
        personCtx(outsider.id, "w026-ac03-outsider"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          attributes: {
            region: "NA_EAST",
            unitPriceBand: "price_b_10_49",
            timingWindow: "window_short_1_3mo",
            quantityBucket: "q_100_999",
          },
          consent: { scope: "competitive_selection" },
          idempotencyKey: key("w026-ac03-outsider"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("a REVOKED supplier membership re-derives as ineligible at the selection anchor", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-03 Revoked Pool",
    });
    // A fourth supplier whose membership is later revoked.
    const revokedSupplier = await createSupplierMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      {
        displayName: "AC-03 Revoked Supplier",
        subjectId: "w026-ac03-revoked@example.com",
      },
    );
    // Their offer is recorded while the membership is active (the
    // pool is already qualified by the seed).
    const offer = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: personCtx(revokedSupplier.personId, "w026-ac03-revoked-offer"),
      unitPriceBand: "price_a_under_10",
    });
    expect(offer.supplierPersonId).toBe(revokedSupplier.personId);

    // Revoke the supplier's TENANT membership (the /organizations
    // authority).
    await harness.runtime.membershipService.revokeMembership(
      harness.bootstrapCtx,
      revokedSupplier.tenantMembershipId,
      "bootstrap",
    );

    // The selection re-derives the supplier authorization at the
    // anchor: the offer becomes INELIGIBLE (never an error — the
    // eligibility decision is derived data).
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac03-revoked-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    const evaluation = view.offerEvaluations.find(
      (candidate) => candidate.offerId === offer.id,
    );
    expect(evaluation).toBeTruthy();
    expect(evaluation!.eligible).toBe(false);
    const authorizationCheck = evaluation!.checks.find(
      (check) => check.check === "supplier_authorized",
    );
    expect(authorizationCheck?.satisfied).toBe(false);
    // The REVOKED supplier's cheap offer (price_a_under_10, cheaper
    // than every seeded offer) is ineligible, so the selection falls
    // to the real cheapest ELIGIBLE offer — supplier A's seeded
    // price_a_under_10 offer.
    expect(view.selectedOfferId).not.toBe(offer.id);
    expect(view.ranking[0]!.supplierPersonId).toBe(
      harness.supplierAPersonId,
    );
    // The revoked supplier's offer never appears in the ranking.
    expect(
      view.ranking.some((entry) => entry.offerId === offer.id),
    ).toBe(false);
  });

  test("cross-tenant and nonexistent references fail closed WITHOUT existence oracles (identical failure shape)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-03 Tenancy Pool",
    });
    // A SECOND tenant: a fresh organization with its own member.
    const otherTenant =
      await harness.runtime.organizationService.createOrganization(
        harness.bootstrapCtx,
        {
          name: "AC-03 Other Tenant",
          creatorId: harness.w025.w024.consumerPersonId,
        },
      );

    // (1) Cross-tenant offer submission: the pool id does not resolve
    // in the OTHER tenant's scope → NotFoundError.
    const cross = await harness.runtime.supplierOfferService
      .createSupplierOffer(
        supplierCtxBySlot(harness, "B", "w026-ac03-cross"),
        {
          organizationScopeId: otherTenant.id,
          poolId: pool.id,
          attributes: {
            region: "NA_EAST",
            unitPriceBand: "price_b_10_49",
            timingWindow: "window_short_1_3mo",
            quantityBucket: "q_100_999",
          },
          consent: { scope: "competitive_selection" },
          idempotencyKey: key("w026-ac03-cross"),
        },
      )
      .catch((error: unknown) => error);
    expect(cross).toBeInstanceOf(NotFoundError);

    // (2) A nonexistent pool id in the SAME scope → the IDENTICAL
    // NotFoundError shape (no existence oracle: cross-tenant and
    // nonexistent are indistinguishable).
    const nonexistent = await harness.runtime.supplierOfferService
      .createSupplierOffer(
        supplierCtxBySlot(harness, "B", "w026-ac03-nonexistent"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: "00000000-0000-0000-0000-000000000000",
          attributes: {
            region: "NA_EAST",
            unitPriceBand: "price_b_10_49",
            timingWindow: "window_short_1_3mo",
            quantityBucket: "q_100_999",
          },
          consent: { scope: "competitive_selection" },
          idempotencyKey: key("w026-ac03-nonexistent"),
        },
      )
      .catch((error: unknown) => error);
    expect(nonexistent).toBeInstanceOf(NotFoundError);
    expect((cross as NotFoundError).code).toBe(
      (nonexistent as NotFoundError).code,
    );
    expect((cross as NotFoundError).message).toContain(
      "procurement pool not found",
    );
    expect((nonexistent as NotFoundError).message).toContain(
      "procurement pool not found",
    );

    // (3) Cross-tenant offer WITHDRAWAL: an offer id from another
    // scope → NotFoundError (never "not yours").
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "B", "w026-ac03-list"),
        harness.organizationScopeId,
        { poolId: pool.id, supplierPersonId: harness.supplierBPersonId },
      );
    await expect(
      harness.runtime.supplierOfferService.withdrawSupplierOffer(
        supplierCtxBySlot(harness, "B", "w026-ac03-cross-withdraw"),
        {
          organizationScopeId: otherTenant.id,
          offerId: offers[0]!.id,
          idempotencyKey: key("w026-ac03-cross-withdraw"),
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // (4) Cross-tenant selection evaluation/record: the pool does not
    // resolve in the other tenant → NotFoundError.
    await expect(
      harness.runtime.supplierOfferService.evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac03-cross-eval"),
        { organizationScopeId: otherTenant.id, poolId: pool.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.supplierOfferService.recordCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac03-cross-record"),
        {
          organizationScopeId: otherTenant.id,
          poolId: pool.id,
          idempotencyKey: key("w026-ac03-cross-record"),
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("NON-CREATOR members cannot touch selection surfaces (the selection authority is the pool creator)", async () => {
    const pool = await seedCompetitivePool(harness, {
      name: "AC-03 Creator Pool",
    });
    // Buyer B (a tenant member, a pool participant, NOT the creator):
    // supplier terms must not cross to other pool participants.
    const buyerBCtx = personCtx(
      harness.w025.buyerBPersonId,
      "w026-ac03-buyer-b",
    );
    await expect(
      harness.runtime.supplierOfferService.evaluateCompetitiveSelection(
        buyerBCtx,
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      harness.runtime.supplierOfferService.recordCompetitiveSelection(
        buyerBCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: key("w026-ac03-buyer-b-record"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // A SUPPLIER (tenant member, not the creator) cannot touch the
    // selection surfaces either.
    const supplierCtx = supplierCtxBySlot(harness, "A", "w026-ac03-supplier");
    await expect(
      harness.runtime.supplierOfferService.evaluateCompetitiveSelection(
        supplierCtx,
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      harness.runtime.supplierOfferService.recordCompetitiveSelection(
        supplierCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: key("w026-ac03-supplier-record"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // The CREATOR (buyer A) CAN: the authoritative record commits.
    const selection = await recordCompetitiveSelection(harness, {
      poolId: pool.id,
    });
    expect(selection.qualified).toBe(true);
    expect(selection.selectedOfferId).toBeTruthy();
  });

  test("the region hard gate: an offer whose region is NOT in the named demand groups is ineligible", async () => {
    // The seed's commitments are all NA_EAST (the ONLY named region
    // group). An EU_WEST offer cannot serve the named demand.
    const pool = await seedCompetitivePool(harness, {
      name: "AC-03 Region Pool",
    });
    // Supplier A holds the seeded NA_EAST offer; withdraw it first so
    // the region test is the ONLY variable (a cheaper EU_WEST offer
    // would otherwise still lose to eligibility, not ranking).
    const offers = await harness.runtime.supplierOfferService
      .listSupplierOffers(
        supplierCtxBySlot(harness, "A", "w026-ac03-region-list"),
        harness.organizationScopeId,
        { poolId: pool.id, supplierPersonId: harness.supplierAPersonId },
      );
    await harness.runtime.supplierOfferService.withdrawSupplierOffer(
      supplierCtxBySlot(harness, "A", "w026-ac03-region-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        offerId: offers[0]!.id,
        idempotencyKey: key("w026-ac03-region-withdraw"),
      },
    );
    // A CHEAP offer in a region with no named demand: INELIGIBLE.
    const cheapWrongRegion = await createSupplierOffer(harness, {
      poolId: pool.id,
      ctx: supplierCtxBySlot(harness, "A", "w026-ac03-region-offer"),
      region: "EU_WEST",
      unitPriceBand: "price_a_under_10",
    });
    const view = await harness.runtime.supplierOfferService
      .evaluateCompetitiveSelection(
        poolCreatorCtx(harness, "w026-ac03-region-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    const evaluation = view.offerEvaluations.find(
      (candidate) => candidate.offerId === cheapWrongRegion.id,
    );
    expect(evaluation).toBeTruthy();
    expect(evaluation!.eligible).toBe(false);
    const regionCheck = evaluation!.checks.find(
      (check) => check.check === "region_served",
    );
    expect(regionCheck?.satisfied).toBe(false);
    // The cheap wrong-region offer is NOT selected (the more
    // expensive NA_EAST offer wins — hard eligibility precedes
    // ranking).
    expect(view.selectedOfferId).not.toBe(cheapWrongRegion.id);
    expect(view.selectedOfferId).toBeTruthy();
  });
});
