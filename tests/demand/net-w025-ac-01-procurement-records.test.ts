/**
 * NET-W025 AC-01 — Business procurement pools and commitments are
 * first-class, tenant-scoped records with explicit provenance,
 * buyer-organization references and server-written consent grants
 * (issue #50 acceptance criterion 1).
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-01.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW025Harness,
  createProcurementPool,
  createProcurementCommitment,
  buyerCtx,
  supplierCtx,
  key,
  type NetW025Harness,
} from "./_net-w025-harness.ts";
import {
  PROCUREMENT_CATEGORY_KEYS,
  InvalidProcurementError,
} from "../../src/core/procurement.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W025-AC-01 first-class procurement records", () => {
  test("creates a first-class durable procurement pool with full provenance", async () => {
    const ctx = buyerCtx(harness, "A", "w025-ac01-pool");
    const result = await harness.runtime.procurementService
      .createProcurementPool(ctx, {
        organizationScopeId: harness.organizationScopeId,
        name: "AC-01 Cloud Pool",
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: {
          minimumCommitments: 2,
          minimumOrganizations: 3,
        },
        idempotencyKey: key("w025-ac01-pool"),
      });
    expect(result.created).toBe(true);
    const pool = result.pool;
    // The acting person BECOMES the creator (no creator input).
    expect(pool.createdBy).toBe(harness.buyerAPersonId);
    expect(pool.organizationScopeId).toBe(harness.organizationScopeId);
    expect(pool.name).toBe("AC-01 Cloud Pool");
    expect(pool.categoryKey).toBe("cloud_infrastructure");
    expect(pool.categoryVersion).toBe("1");
    expect(pool.policy).toEqual({
      version: 1,
      minimumCommitments: 2,
      minimumOrganizations: 3,
    });
    expect(pool.closedAt).toBeNull();
    expect(pool.closureReason).toBeNull();
    expect(pool.recordFormat).toBe("NET-W025:1");
    // Full lineage.
    expect(pool.idempotencyKey).toBeTruthy();
    expect(pool.executionId).toBe(ctx.executionId);
    expect(pool.correlationId).toBe(ctx.correlationId);
    expect(pool.createdAt).toBeTruthy();
    expect(pool.updatedAt).toBe(pool.createdAt);
    // Durable: re-read returns the identical record.
    const reread = await harness.runtime.procurementService
      .getProcurementPool(
        ctx,
        harness.organizationScopeId,
        pool.id,
      );
    expect(reread).toEqual(pool);
  });

  test("records a business commitment with buyer-organization reference and a server-written consent grant", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-01 Commit Pool",
    });
    const ctx = buyerCtx(harness, "B", "w025-ac01-commit");
    const result = await harness.runtime.procurementService
      .createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgBId,
        attributes: {
          region: "EU_WEST",
          quantity: 250,
          budgetBand: "band_c_10k_99k",
          unitPriceBand: "price_d_100_499",
          timingWindow: "window_medium_3_6mo",
        },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w025-ac01-commit"),
      });
    expect(result.created).toBe(true);
    const commitment = result.commitment;
    // The acting person BECOMES the submitter (no submittedBy input);
    // the buyer organization is the server-authorized organization.
    expect(commitment.submittedBy).toBe(harness.buyerBPersonId);
    expect(commitment.buyerOrganizationId).toBe(harness.buyerOrgBId);
    expect(commitment.organizationScopeId).toBe(harness.organizationScopeId);
    expect(commitment.poolId).toBe(pool.id);
    expect(commitment.categoryKey).toBe("cloud_infrastructure");
    expect(commitment.categoryVersion).toBe("1");
    expect(commitment.attributes).toEqual({
      region: "EU_WEST",
      quantity: 250,
      budgetBand: "band_c_10k_99k",
      unitPriceBand: "price_d_100_499",
      timingWindow: "window_medium_3_6mo",
    });
    // The SERVER-WRITTEN consent grant (the input only named the
    // scope).
    expect(commitment.consent.scope).toBe("aggregate_disclosure");
    expect(commitment.consent.version).toBe("NET-W025:1");
    expect(commitment.consent.grantedAt).toBeTruthy();
    expect(commitment.consent.grantedBy).toBe(harness.buyerBPersonId);
    expect(commitment.withdrawnAt).toBeNull();
    expect(commitment.withdrawalReason).toBeNull();
    expect(commitment.recordFormat).toBe("NET-W025:1");
    expect(commitment.executionId).toBe(ctx.executionId);
    expect(commitment.correlationId).toBe(ctx.correlationId);
    // Durable: re-read returns the identical record.
    const reread = await harness.runtime.procurementService
      .getProcurementCommitment(
        ctx,
        harness.organizationScopeId,
        commitment.id,
      );
    expect(reread).toEqual(commitment);
  });

  test("the closed vocabularies fail closed (category, region, bands, windows)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-01 Vocab Pool",
    });
    const ctx = buyerCtx(harness, "A", "w025-ac01-vocab");
    const base = {
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      buyerOrganizationId: harness.buyerOrgAId,
      consent: { scope: "aggregate_disclosure" },
      idempotencyKey: key("w025-ac01-vocab"),
    };
    // Pool-level category validation (closed vocabulary).
    await expect(
      harness.runtime.procurementService.createProcurementPool(ctx, {
        organizationScopeId: harness.organizationScopeId,
        name: "AC-01 Bad Category",
        categoryKey: "unknown_vertical",
        qualificationPolicy: {
          minimumCommitments: 2,
          minimumOrganizations: 2,
        },
        idempotencyKey: key("w025-ac01-badcat"),
      }),
    ).rejects.toBeInstanceOf(InvalidProcurementError);
    // Commitment-level attribute vocabulary failures.
    const badAttributes: readonly unknown[] = [
      { region: "NA_MARS", quantity: 12 }, // invalid region
      { region: "NA_EAST", quantity: 12, budgetBand: "band_z" },
      { region: "NA_EAST", quantity: 12, unitPriceBand: "price_z" },
      { region: "NA_EAST", quantity: 12, timingWindow: "window_z" },
    ];
    for (const attributes of badAttributes) {
      try {
        await harness.runtime.procurementService
          .createProcurementCommitment(ctx, {
            ...base,
            attributes: attributes as never,
          });
        throw new Error("expected InvalidProcurementError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidProcurementError);
        expect((err as InvalidProcurementError).code).toBe(
          "PROCUREMENT_VALIDATION",
        );
        expect((err as InvalidProcurementError).classification).toBe(
          "validation",
        );
      }
    }
    // The category vocabulary is pinned (8 business verticals).
    expect([...PROCUREMENT_CATEGORY_KEYS]).toHaveLength(8);
  });

  test("attribute bounds fail closed (quantity)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-01 Bounds Pool",
    });
    const ctx = buyerCtx(harness, "A", "w025-ac01-bounds");
    for (const quantity of [0, -1, 0.5, 1000001]) {
      await expect(
        harness.runtime.procurementService.createProcurementCommitment(ctx, {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "NA_EAST", quantity },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac01-bounds"),
        }),
      ).rejects.toBeInstanceOf(InvalidProcurementError);
    }
  });

  test("the consent scope must be the one closed value", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-01 Consent Pool",
    });
    const ctx = buyerCtx(harness, "A", "w025-ac01-consent");
    await expect(
      harness.runtime.procurementService.createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "individual_disclosure" },
        idempotencyKey: key("w025-ac01-consent"),
      }),
    ).rejects.toBeInstanceOf(InvalidProcurementError);
    // No consent object at all also fails closed.
    await expect(
      harness.runtime.procurementService.createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: undefined as never,
        idempotencyKey: key("w025-ac01-noconsent"),
      }),
    ).rejects.toBeInstanceOf(InvalidProcurementError);
  });

  test("pool name and prose bounds fail closed", async () => {
    const ctx = buyerCtx(harness, "A", "w025-ac01-name");
    // Empty + over-bound names.
    for (const name of ["", "   ", "x".repeat(201)]) {
      await expect(
        harness.runtime.procurementService.createProcurementPool(ctx, {
          organizationScopeId: harness.organizationScopeId,
          name,
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: {
            minimumCommitments: 2,
            minimumOrganizations: 2,
          },
          idempotencyKey: key("w025-ac01-name"),
        }),
      ).rejects.toBeInstanceOf(InvalidProcurementError);
    }
    // Over-bound closure reason.
    const pool = await createProcurementPool(harness, {
      name: "AC-01 Prose Pool",
    });
    await expect(
      harness.runtime.procurementService.closeProcurementPool(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "y".repeat(2001),
        idempotencyKey: key("w025-ac01-prose"),
      }),
    ).rejects.toBeInstanceOf(InvalidProcurementError);
  });

  test("qualification policy bounds fail closed (both thresholds)", async () => {
    const ctx = buyerCtx(harness, "A", "w025-ac01-policy");
    const badPolicies: readonly unknown[] = [
      { minimumCommitments: 0, minimumOrganizations: 2 },
      { minimumCommitments: 2, minimumOrganizations: 0 },
      { minimumCommitments: 1.5, minimumOrganizations: 2 },
      { minimumCommitments: 10001, minimumOrganizations: 2 },
      { minimumCommitments: 2, minimumOrganizations: 10001 },
    ];
    for (const qualificationPolicy of badPolicies) {
      await expect(
        harness.runtime.procurementService.createProcurementPool(ctx, {
          organizationScopeId: harness.organizationScopeId,
          name: "AC-01 Bad Policy Pool",
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: qualificationPolicy as never,
          idempotencyKey: key("w025-ac01-policy"),
        }),
      ).rejects.toBeInstanceOf(InvalidProcurementError);
    }
  });

  test("tenant-scoped pool and commitment listings with filters", async () => {
    const logistics = await createProcurementPool(harness, {
      name: "AC-01 Logistics Pool",
      categoryKey: "logistics_freight",
    });
    const energy = await createProcurementPool(harness, {
      name: "AC-01 Energy Pool",
      categoryKey: "energy_supply",
      ctx: buyerCtx(harness, "B", "w025-ac01-energy"),
    });
    const ctx = supplierCtx(harness, "w025-ac01-list");
    const pools = await harness.runtime.procurementService
      .listProcurementPools(ctx, harness.organizationScopeId);
    const ids = pools.map((pool) => pool.id);
    expect(ids).toContain(logistics.id);
    expect(ids).toContain(energy.id);
    // Category filter.
    const logisticsOnly = await harness.runtime.procurementService
      .listProcurementPools(ctx, harness.organizationScopeId, {
        categoryKey: "logistics_freight",
      });
    expect(logisticsOnly.map((pool) => pool.id)).toContain(logistics.id);
    expect(logisticsOnly.map((pool) => pool.id)).not.toContain(energy.id);
    // Commitment filters: pool, buyer org, submitter, withdrawn.
    await createProcurementCommitment(harness, { poolId: logistics.id });
    await createProcurementCommitment(harness, {
      poolId: logistics.id,
      ctx: buyerCtx(harness, "B", "w025-ac01-b-commit"),
      buyerOrganizationId: harness.buyerOrgBId,
      region: "EU_NORTH",
    });
    const forPool = await harness.runtime.procurementService
      .listProcurementCommitments(ctx, harness.organizationScopeId, {
        poolId: logistics.id,
      });
    expect(forPool.length).toBe(2);
    const forBuyerB = await harness.runtime.procurementService
      .listProcurementCommitments(ctx, harness.organizationScopeId, {
        poolId: logistics.id,
        buyerOrganizationId: harness.buyerOrgBId,
      });
    expect(forBuyerB.map((c) => c.buyerOrganizationId)).toEqual([
      harness.buyerOrgBId,
    ]);
    const forSubmitterA = await harness.runtime.procurementService
      .listProcurementCommitments(ctx, harness.organizationScopeId, {
        submittedBy: harness.buyerAPersonId,
      });
    expect(
      forSubmitterA.every((c) => c.submittedBy === harness.buyerAPersonId),
    ).toBe(true);
    const activeOnly = await harness.runtime.procurementService
      .listProcurementCommitments(ctx, harness.organizationScopeId, {
        poolId: logistics.id,
        withdrawn: false,
      });
    expect(activeOnly.length).toBe(2);
  });
});
