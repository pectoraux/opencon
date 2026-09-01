/**
 * NET-W025 AC-03 — Supplier-facing output is aggregate-only and
 * protects commercially sensitive competitor terms (issue #50
 * acceptance criterion 3; PROC-003).
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-03.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW025Harness,
  createProcurementPool,
  createProcurementCommitment,
  createBuyerMember,
  seedThreeOrgPool,
  buyerCtx,
  supplierCtx,
  personCtx,
  key,
  type NetW025Harness,
} from "./_net-w025-harness.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W025-AC-03 privacy / competition-preserving aggregation", () => {
  test("the minimized fact contract is EXACTLY counts + bounded distributions", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-03 Contract Pool",
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-contract"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).not.toBeNull();
    expect(Object.keys(view.aggregate!).sort()).toEqual([
      "budgetBandGroups",
      "commitmentCount",
      "organizationCount",
      "quantityBuckets",
      "regionGroups",
      "suppressedGroups",
      "timingWindowGroups",
      "unitPriceBandGroups",
    ]);
    // The view carries exactly the fixed surface: no person, no
    // commitment, no buyer-organization references.
    expect(Object.keys(view).sort()).toEqual([
      "aggregate",
      "category",
      "checks",
      "digest",
      "evaluatedAt",
      "organizationScopeId",
      "policy",
      "poolId",
      "qualified",
    ]);
  });

  test("NO identifier-shaped strings beyond the pool/tenant references (no buyer-organization, person or commitment ids)", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-03 Ids Pool",
    });
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(harness.bootstrapCtx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-ids"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    const json = JSON.stringify(view);
    // The only allowed identifiers are the pool + tenant references.
    expect(json).toContain(pool.id);
    expect(json).toContain(harness.organizationScopeId);
    // Buyer organizations are NEVER named.
    for (const orgId of [
      harness.buyerOrgAId,
      harness.buyerOrgBId,
      harness.buyerOrgCId,
    ]) {
      expect(json).not.toContain(orgId);
    }
    // Persons are NEVER named.
    for (const personId of [
      harness.buyerAPersonId,
      harness.buyerBPersonId,
      harness.buyerCPersonId,
      harness.supplierPersonId,
    ]) {
      expect(json).not.toContain(personId);
    }
    // Commitment ids are NEVER named.
    for (const commitment of commitments) {
      expect(json).not.toContain(commitment.id);
    }
  });

  test("exact quantities never cross — bucket distributions only", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-03 Quantity Pool",
    });
    // A distinctive exact quantity that must not appear anywhere in
    // the supplier-facing output (submitted by a SECOND member of
    // buyer organization B — the buyer-B representative already holds
    // the pool's seeded commitment).
    const extraB = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgBId,
      {
        displayName: "AC-03 Extra B Member",
        subjectId: "w025-ac03-extra-b@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(extraB.personId, "w025-ac03-qty-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 1234,
      region: "NA_EAST",
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-qty"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).not.toBeNull();
    const json = JSON.stringify(view);
    // The exact quantity NEVER appears anywhere in the output.
    expect(json).not.toContain("1234");
    // Quantities cross ONLY as bucket distributions: the three seeded
    // quantities (12/40/75) share the q_10_99 bucket (count 3 ≥
    // floor, named)…
    const buckets = view.aggregate!.quantityBuckets.map((g) => g.group);
    expect(buckets).toContain("q_10_99");
    // …while the singleton q_1000_9999 bucket (count 1 < floor) is
    // SUPPRESSED — counted in suppressedGroups, never named.
    expect(buckets).not.toContain("q_1000_9999");
    expect(view.aggregate!.suppressedGroups).toBeGreaterThan(0);
    // There is no per-organization quantity field anywhere.
    expect(json).not.toMatch(/perOrganization|exactQuantity/);
  });

  test("unit prices, budgets and timing cross ONLY as bands/windows — exact terms are unrepresentable", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-03 Terms Pool",
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-terms"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).not.toBeNull();
    // The banded attributes appear ONLY as their closed-vocabulary
    // group names with counts.
    expect(
      view.aggregate!.unitPriceBandGroups.map((g) => g.group),
    ).toEqual(["price_b_10_49"]);
    expect(
      view.aggregate!.budgetBandGroups.map((g) => g.group),
    ).toEqual(["band_b_1k_9k"]);
    expect(
      view.aggregate!.timingWindowGroups.map((g) => g.group),
    ).toEqual(["window_short_1_3mo"]);
    // No numeric price/amount/date fields exist anywhere in the
    // contract (the aggregate key set is pinned by the contract test
    // above; here: no exact-value numerics cross, only group names).
    const json = JSON.stringify(view.aggregate);
    expect(json).not.toMatch(/"unitPrice"/);
    expect(json).not.toMatch(/"amount"|"budget"|"currency"/);
    expect(json).not.toMatch(/"dueDate"|"deadline"|"deliveryDate"/);
  });

  test("THE ORGANIZATION FLOOR: a many-commitment single-buyer aggregate suppresses ENTIRELY (PROC-003)", async () => {
    // Three commitments — ALL from buyer organization A (three
    // different authorized members). The commitment floor is met
    // (3 ≥ 3) but the distinct-organization floor is NOT (1 < 3): a
    // single buyer's terms would be reconstructable, so the whole
    // aggregate suppresses — this is the competition floor.
    const pool = await createProcurementPool(harness, {
      name: "AC-03 Single Buyer Pool",
    });
    await createProcurementCommitment(harness, { poolId: pool.id });
    const second = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-03 A Member 2",
        subjectId: "w025-ac03-a2@example.com",
      },
    );
    const third = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-03 A Member 3",
        subjectId: "w025-ac03-a3@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(second.personId, "w025-ac03-a2"),
      buyerOrganizationId: harness.buyerOrgAId,
      region: "NA_EAST",
      quantity: 20,
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(third.personId, "w025-ac03-a3"),
      buyerOrganizationId: harness.buyerOrgAId,
      region: "NA_EAST",
      quantity: 30,
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-single-buyer"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).toBeNull();
    const orgFloor = view.checks.find(
      (c) => c.check === "organization_floor_met",
    );
    expect(orgFloor?.satisfied).toBe(false);
    // Even the commitment count is suppressed below the floor (and
    // the qualification check detail carries no counts).
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    const detail = thresholds?.detail as Record<string, unknown>;
    expect(detail["commitmentCount"]).toBeUndefined();
    expect(detail["organizationCount"]).toBeUndefined();
    expect(detail["reason"]).toBe(
      "counts_suppressed_below_disclosure_floors",
    );
    expect(view.qualified).toBe(false);
  });

  test("THE COMMITMENT FLOOR: a below-floor aggregate suppresses entirely", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-03 Commit Floor Pool",
    });
    // Two commitments from two organizations: the commitment floor
    // (3) is not met → everything suppresses.
    await createProcurementCommitment(harness, { poolId: pool.id });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "B", "w025-ac03-cf-b"),
      buyerOrganizationId: harness.buyerOrgBId,
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-commit-floor"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).toBeNull();
    const privacyFloor = view.checks.find(
      (c) => c.check === "privacy_floor_met",
    );
    expect(privacyFloor?.satisfied).toBe(false);
    expect(view.qualified).toBe(false);
  });

  test("below-floor distribution groups are suppressed (counted, never named)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-03 Groups Pool",
    });
    // Three commitments in NA_EAST from three organizations + one in
    // EU_WEST: the EU_WEST group (1 < floor 3) must never be named.
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      region: "NA_EAST",
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "B", "w025-ac03-g-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      region: "NA_EAST",
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "C", "w025-ac03-g-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      region: "NA_EAST",
    });
    const extra = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-03 Groups Extra",
        subjectId: "w025-ac03-g-extra@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(extra.personId, "w025-ac03-g-extra"),
      buyerOrganizationId: harness.buyerOrgAId,
      region: "EU_WEST",
      budgetBand: "band_e_1m_plus",
      unitPriceBand: "price_e_500_plus",
      timingWindow: "window_extended_12mo_plus",
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-groups"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).not.toBeNull();
    // NA_EAST is named (3 ≥ floor); EU_WEST is NEVER named.
    expect(
      view.aggregate!.regionGroups.map((g) => g.group),
    ).toEqual(["NA_EAST"]);
    // Every below-floor singleton group folds into the suppressed
    // count (region EU_WEST + budget band_e + price band_e + timing
    // extended + the quantity buckets all below floor…).
    expect(view.aggregate!.suppressedGroups).toBeGreaterThan(0);
    const json = JSON.stringify(view.aggregate);
    expect(json).not.toContain("EU_WEST");
    expect(json).not.toContain("band_e_1m_plus");
    expect(json).not.toContain("price_e_500_plus");
    expect(json).not.toContain("window_extended_12mo_plus");
  });

  test("withdrawal (the consent revocation) takes effect on the very next evaluation", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-03 Consent Pool",
    });
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(harness.bootstrapCtx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    const buyerACommitment = commitments.find(
      (c) => c.buyerOrganizationId === harness.buyerOrgAId,
    )!;
    await harness.runtime.procurementService.withdrawProcurementCommitment(
      buyerCtx(harness, "A", "w025-ac03-revoke"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: buyerACommitment.id,
        reason: "revoked",
        idempotencyKey: key("w025-ac03-revoke"),
      },
    );
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-revoke-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.aggregate).toBeNull();
    expect(view.qualified).toBe(false);
  });

  test("evaluation mutates nothing, audits nothing, and error contexts carry no private attribute material", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-03 NoSideEffects Pool",
    });
    const eventsBefore = await harness.runtime.auditWriter.query({});
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac03-sfx"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(true);
    const eventsAfter = await harness.runtime.auditWriter.query({});
    expect(eventsAfter.length).toBe(eventsBefore.length);
    // The durable records are unchanged by the evaluation.
    const pools = await harness.runtime.procurementService
      .listProcurementPools(
        supplierCtx(harness, "w025-ac03-sfx-list"),
        harness.organizationScopeId,
      );
    const reread = pools.find((p) => p.id === pool.id)!;
    expect(reread.updatedAt).toBe(pool.createdAt);
    // A not-found error carries only id/scope lineage — never
    // attribute or consent payloads.
    let error: unknown;
    try {
      await harness.runtime.procurementService.getProcurementPool(
        supplierCtx(harness, "w025-ac03-nf"),
        harness.organizationScopeId,
        "no-such-pool",
      );
    } catch (err) {
      error = err;
    }
    const errorJson = JSON.stringify(error);
    expect(errorJson).not.toMatch(/region|quantity|budgetBand|unitPrice|timingWindow|consent/);
  });
});
