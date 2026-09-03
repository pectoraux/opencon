/**
 * NET-W036 AC-02 — Aggregate disclosure privacy (work order §5 AC-02 +
 * the frozen ledger §4): the commitment count and the distinct
 * buyer-organization count remain SEPARATE disclosure dimensions, and
 * every emitted machine-readable aggregate is behind the correct
 * disclosure gate (the frozen floors 3/3 + the active requestor
 * membership — the same gate for all aggregates).
 *
 * Mutation targets covered (ledger §4): collapse counts; bypass
 * aggregate gate; leak participant/commercial detail.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac02-…`),
 * fixed person/subject fixtures — NO `Date.now(`, NO `randomUUID`, NO
 * `new Date(` code tokens in this file. ONE harness per file (the
 * W025/W026 AC-suite precedent); every test seeds its OWN pool with a
 * distinct fixed key.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW036Harness,
  personCtx,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { createBuyerMember } from "../demand/_net-w025-harness.ts";
import type {
  ProcurementCommitment,
  ProcurementPool,
} from "../../src/demand/port.ts";

let harness: NetW036Harness;

beforeAll(async () => {
  harness = await createNetW036Harness();
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

/** Seed one pool with NO commitments (each test commits its own shape). */
async function newPool(name: string, poolKey: string): Promise<ProcurementPool> {
  return (
    await harness.runtime.procurementService.createProcurementPool(
      harness.poolCreatorCtx("w036-ac02-pool"),
      {
        organizationScopeId: harness.organizationScopeId,
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
}

/** Record one commitment (fixed key, default banded attributes). */
async function commit(
  poolId: string,
  opts: {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly key: string;
    readonly region?: string;
    readonly quantity?: number;
    readonly budgetBand?: string;
    readonly unitPriceBand?: string;
    readonly timingWindow?: string;
  },
): Promise<ProcurementCommitment> {
  return (
    await harness.runtime.procurementService.createProcurementCommitment(
      opts.ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId,
        buyerOrganizationId: opts.buyerOrganizationId,
        attributes: {
          region: opts.region ?? "NA_EAST",
          quantity: opts.quantity ?? 12,
          budgetBand: opts.budgetBand ?? "band_b_1k_9k",
          unitPriceBand: opts.unitPriceBand ?? "price_b_10_49",
          timingWindow: opts.timingWindow ?? "window_short_1_3mo",
        },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: opts.key,
      },
    )
  ).commitment;
}

/** The canonical three-organization seed (A/B/C, one commitment each). */
async function seedThreeOrgPool(
  name: string,
  poolKey: string,
): Promise<ProcurementPool> {
  const pool = await newPool(name, poolKey);
  await commit(pool.id, {
    ctx: harness.poolCreatorCtx("w036-ac02-ca"),
    buyerOrganizationId: harness.buyerOrgAId,
    quantity: 12,
    key: `${poolKey}-a`,
  });
  await commit(pool.id, {
    ctx: harness.buyerBCtx("w036-ac02-cb"),
    buyerOrganizationId: harness.buyerOrgBId,
    quantity: 40,
    key: `${poolKey}-b`,
  });
  await commit(pool.id, {
    ctx: harness.buyerCCtx("w036-ac02-cc"),
    buyerOrganizationId: harness.buyerOrgCId,
    quantity: 75,
    key: `${poolKey}-c`,
  });
  return pool;
}

describe("NET-W036-AC-02 aggregate disclosure privacy", () => {
  test("the gated positive view: commitmentCount and organizationCount are SEPARATE fields (3/3) with a reproducible digest", async () => {
    const runtime = harness.runtime;
    const pool = await seedThreeOrgPool(
      "W036 AC-02 Positive Pool",
      "w036-ac02-pool-positive",
    );
    const ctx = harness.poolCreatorCtx("w036-ac02-positive");

    const view = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      });
    expect(view.qualified).toBe(true);
    expect(view.aggregate).not.toBeNull();
    // The two disclosure dimensions are SEPARATE top-level fields,
    // never collapsed into one count.
    expect(view.aggregate!.commitmentCount).toBe(3);
    expect(view.aggregate!.organizationCount).toBe(3);
    expect(
      Object.keys(view.aggregate!).filter((key) =>
        ["commitmentCount", "organizationCount"].includes(key),
      ),
    ).toEqual(["commitmentCount", "organizationCount"]);
    const checkMap = new Map(view.checks.map((c) => [c.check, c.satisfied]));
    expect(checkMap.get("privacy_floor_met")).toBe(true);
    expect(checkMap.get("organization_floor_met")).toBe(true);
    expect(checkMap.get("requestor_membership")).toBe(true);
    // The threshold detail discloses BOTH counts — as two facts.
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    const detail = thresholds?.detail as Record<string, unknown>;
    expect(detail["commitmentCount"]).toBe(3);
    expect(detail["organizationCount"]).toBe(3);

    // The digest is reproducible across evaluations (the anchor is
    // excluded) — and IDENTICAL for a DIFFERENT active member (the
    // supplier-facing requestor sees the same derived decision).
    const replay = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      });
    expect(replay.digest).toBe(view.digest);
    expect(replay.aggregate).toEqual(view.aggregate);
    const supplierView = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        harness.supplierACtx("w036-ac02-positive-supplier"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    expect(supplierView.digest).toBe(view.digest);
    expect(supplierView.aggregate).toEqual(view.aggregate);
  }, 120_000);

  test("THE DIMENSION SEPARATION: THREE commitments from only TWO distinct buyer organizations suppress the aggregate entirely", async () => {
    const runtime = harness.runtime;
    // 3 commitments ≥ the commitment floor, but only 2 distinct buyer
    // organizations < the organization floor: the two dimensions are
    // evaluated INDEPENDENTLY (they never collapse — a collapsed count
    // would have passed both floors).
    const pool = await newPool(
      "W036 AC-02 Two Org Pool",
      "w036-ac02-pool-two-org",
    );
    await commit(pool.id, {
      ctx: harness.poolCreatorCtx("w036-ac02-ta"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: "w036-ac02-two-org-a1",
    });
    // A SECOND authorized member of buyer organization A (a distinct
    // submitter, the SAME buyer organization).
    const secondA = await createBuyerMember(
      runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "W036 AC-02 Buyer A Member 2",
        subjectId: "w036-ac02-a2@example.com",
      },
    );
    await commit(pool.id, {
      ctx: personCtx(harness, secondA.personId, "w036-ac02-ta2"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 20,
      key: "w036-ac02-two-org-a2",
    });
    await commit(pool.id, {
      ctx: harness.buyerBCtx("w036-ac02-tb"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: "w036-ac02-two-org-b",
    });

    const view = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        harness.supplierACtx("w036-ac02-two-org"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    // The commitment floor PASSES while the organization floor FAILS
    // on the SAME commitment set — the separate-dimension proof.
    const checkMap = new Map(view.checks.map((c) => [c.check, c.satisfied]));
    expect(checkMap.get("privacy_floor_met")).toBe(true);
    expect(checkMap.get("organization_floor_met")).toBe(false);
    expect(view.aggregate).toBeNull();
    expect(view.qualified).toBe(false);
    const orgFloor = view.checks.find(
      (c) => c.check === "organization_floor_met",
    );
    expect(
      (orgFloor?.detail as Record<string, unknown>)["reason"],
    ).toBe("insufficient_distinct_organizations_for_disclosure");
    // Even the counts are suppressed (a two-buyer duopoly's terms would
    // be reconstructable).
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    const detail = thresholds?.detail as Record<string, unknown>;
    expect(detail["commitmentCount"]).toBeUndefined();
    expect(detail["organizationCount"]).toBeUndefined();
    expect(detail["reason"]).toBe("counts_suppressed_below_disclosure_floors");
  }, 120_000);

  test("THE COMMITMENT FLOOR: fewer than the privacy-floor commitments suppress the aggregate entirely (no suppressedGroups or any facts object crosses)", async () => {
    const runtime = harness.runtime;
    const pool = await newPool(
      "W036 AC-02 Commit Floor Pool",
      "w036-ac02-pool-commit-floor",
    );
    await commit(pool.id, {
      ctx: harness.poolCreatorCtx("w036-ac02-fa"),
      buyerOrganizationId: harness.buyerOrgAId,
      key: "w036-ac02-floor-a",
    });
    await commit(pool.id, {
      ctx: harness.buyerBCtx("w036-ac02-fb"),
      buyerOrganizationId: harness.buyerOrgBId,
      key: "w036-ac02-floor-b",
    });
    const view = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        harness.supplierACtx("w036-ac02-floor"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    const checkMap = new Map(view.checks.map((c) => [c.check, c.satisfied]));
    expect(checkMap.get("privacy_floor_met")).toBe(false);
    // The whole facts object is null — no suppressedGroups count, no
    // partial distribution, NOTHING crosses below the floor.
    const viewJson = JSON.stringify(view);
    expect(viewJson).not.toContain("suppressedGroups");
    expect(viewJson).not.toContain("commitmentCount");
    expect(viewJson).not.toContain("organizationCount");
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    const detail = thresholds?.detail as Record<string, unknown>;
    expect(detail["reason"]).toBe("counts_suppressed_below_privacy_floor");
  }, 120_000);

  test("an unauthorized (non-member) requestor receives aggregate null even with both floors met — the requestor gate", async () => {
    const runtime = harness.runtime;
    // Both floors MET (3/3) — yet a NON-MEMBER requestor gets nothing:
    // the requestor-membership gate is an independent disclosure
    // dimension of the SAME gate set.
    const pool = await seedThreeOrgPool(
      "W036 AC-02 Non Member Pool",
      "w036-ac02-pool-non-member",
    );
    const outsider = await runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W036 AC-02 Outsider",
        subjectReferences: [
          {
            subjectId: "w036-ac02-outsider@example.com",
            providerKind: "internal",
          },
        ],
      },
    );
    const view = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        personCtx(harness, outsider.id, "w036-ac02-nm"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    const checkMap = new Map(view.checks.map((c) => [c.check, c.satisfied]));
    expect(checkMap.get("privacy_floor_met")).toBe(true);
    expect(checkMap.get("organization_floor_met")).toBe(true);
    expect(checkMap.get("requestor_membership")).toBe(false);
    const membership = view.checks.find(
      (c) => c.check === "requestor_membership",
    );
    expect(
      (membership?.detail as Record<string, unknown>)["reason"],
    ).toBe("requestor_not_active_member");
    // Even the counts are withheld from the non-member requestor (the
    // detail carries no count fields).
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    const detail = thresholds?.detail as Record<string, unknown>;
    expect(detail["commitmentCount"]).toBeUndefined();
    expect(detail["organizationCount"]).toBeUndefined();
  }, 120_000);

  test("NO LEAKAGE: the disclosed facts object carries EXACTLY the sanctioned keys; below-floor groups fold into suppressedGroups (counted, never named); no participant or commercial detail crosses", async () => {
    const runtime = harness.runtime;
    // Three NA_EAST commitments from the three organizations + one
    // EU_WEST outlier from a second org-A member with distinctive
    // below-floor bands: the outlier's group names must NEVER appear.
    const pool = await newPool(
      "W036 AC-02 Leakage Pool",
      "w036-ac02-pool-leakage",
    );
    const commitments: ProcurementCommitment[] = [];
    commitments.push(
      await commit(pool.id, {
        ctx: harness.poolCreatorCtx("w036-ac02-la"),
        buyerOrganizationId: harness.buyerOrgAId,
        quantity: 12,
        key: "w036-ac02-leak-a",
      }),
    );
    commitments.push(
      await commit(pool.id, {
        ctx: harness.buyerBCtx("w036-ac02-lb"),
        buyerOrganizationId: harness.buyerOrgBId,
        quantity: 40,
        key: "w036-ac02-leak-b",
      }),
    );
    commitments.push(
      await commit(pool.id, {
        ctx: harness.buyerCCtx("w036-ac02-lc"),
        buyerOrganizationId: harness.buyerOrgCId,
        quantity: 75,
        key: "w036-ac02-leak-c",
      }),
    );
    const extraA = await createBuyerMember(
      runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "W036 AC-02 Buyer A Outlier",
        subjectId: "w036-ac02-outlier@example.com",
      },
    );
    commitments.push(
      await commit(pool.id, {
        ctx: personCtx(harness, extraA.personId, "w036-ac02-lout"),
        buyerOrganizationId: harness.buyerOrgAId,
        quantity: 1234,
        region: "EU_WEST",
        budgetBand: "band_e_1m_plus",
        unitPriceBand: "price_e_500_plus",
        timingWindow: "window_extended_12mo_plus",
        key: "w036-ac02-leak-outlier",
      }),
    );

    const view = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        harness.supplierACtx("w036-ac02-leak"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
        },
      );
    expect(view.qualified).toBe(true);
    expect(view.aggregate).not.toBeNull();

    // (a) The facts object key set is EXACTLY the sanctioned aggregate
    //     keys (src/demand/port.ts ProcurementAggregateFacts) —
    //     nothing else ever crosses.
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

    // (b) Below-floor groups fold into suppressedGroups — counted,
    //     NEVER named: the EU_WEST singleton + the band_e / price_e /
    //     extended-window / q_1000_9999 singletons all suppress.
    expect(view.aggregate!.regionGroups.map((g) => g.group)).toEqual([
      "NA_EAST",
    ]);
    expect(view.aggregate!.regionGroups[0]!.count).toBe(3);
    expect(view.aggregate!.suppressedGroups).toBeGreaterThan(0);
    const factsJson = JSON.stringify(view.aggregate);
    for (const neverNamed of [
      "EU_WEST",
      "band_e_1m_plus",
      "price_e_500_plus",
      "window_extended_12mo_plus",
      "q_1000_9999",
    ]) {
      expect(factsJson).not.toContain(neverNamed);
    }
    // The exact outlier quantity never appears anywhere.
    expect(JSON.stringify(view)).not.toContain("1234");

    // (c) NO buyer-organization id, NO member/person id, NO commitment
    //     id appears anywhere in the view.
    const viewJson = JSON.stringify(view);
    for (const orgId of [
      harness.buyerOrgAId,
      harness.buyerOrgBId,
      harness.buyerOrgCId,
    ]) {
      expect(viewJson).not.toContain(orgId);
    }
    for (const personId of [
      harness.poolCreatorPersonId,
      harness.buyerBPersonId,
      harness.buyerCPersonId,
      extraA.personId,
    ]) {
      expect(viewJson).not.toContain(personId);
    }
    for (const commitment of commitments) {
      expect(viewJson).not.toContain(commitment.id);
      expect(viewJson).not.toContain(commitment.submittedBy);
    }
    // (d) No commercial per-commitment detail vocabulary crosses: no
    //     exact price/budget/date fields exist anywhere in the view.
    for (const forbidden of [
      '"unitPrice"',
      '"amount"',
      '"budget"',
      '"currency"',
      '"dueDate"',
      '"deadline"',
      '"deliveryDate"',
    ]) {
      expect(viewJson).not.toContain(forbidden);
    }
  }, 120_000);
});
