/**
 * NET-W024 AC-01 — Consumer demand commitments and pools are
 * first-class, tenant-scoped, durable records with explicit provenance
 * and authorization/consent (issue #48 acceptance criterion 1).
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-01.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW024Harness,
  createPool,
  createCommitment,
  consumerCtx,
  supplierCtx,
  key,
  type NetW024Harness,
} from "./_net-w024-harness.ts";
import {
  DEMAND_CATEGORY_KEYS,
  DEMAND_CATEGORY_VERSION,
  DEMAND_COMMITMENT_RECORD_FORMAT,
  DEMAND_CONSENT_SCOPE,
  DEMAND_CONSENT_VERSION,
  DEMAND_POOL_RECORD_FORMAT,
  InvalidDemandError,
} from "../../src/core/demand.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W024-AC-01 first-class records with provenance + consent", () => {
  test("a demand pool is a first-class, tenant-scoped, durable record with provenance", async () => {
    const pool = await createPool(harness, {
      name: "AC-01 Energy Pool",
      categoryKey: "utilities_energy",
      minimumCommitments: 5,
    });
    expect(pool.id).toBeTruthy();
    expect(pool.organizationScopeId).toBe(harness.organizationScopeId);
    // EXPLICIT provenance: the acting person BECOMES the creator
    // (there is no creatorPersonId input — ownership cannot be
    // fabricated).
    expect(pool.createdBy).toBe(harness.consumerPersonId);
    // Explicit, versioned category + policy lineage.
    expect(pool.categoryKey).toBe("utilities_energy");
    expect(pool.categoryVersion).toBe(DEMAND_CATEGORY_VERSION);
    expect(pool.policy).toEqual({
      version: 1,
      minimumCommitments: 5,
    });
    expect(pool.recordFormat).toBe(DEMAND_POOL_RECORD_FORMAT);
    // One-way closure starts null.
    expect(pool.closedAt).toBeNull();
    expect(pool.closureReason).toBeNull();
    // Execution lineage (provenance).
    expect(pool.executionId).toBeTruthy();
    expect(pool.correlationId).toBeTruthy();
    expect(pool.idempotencyKey).toBeTruthy();

    // Durable: re-read through the tenant-scoped read API.
    const reread = await harness.runtime.demandService.getDemandPool(
      consumerCtx(harness, "w024-ac01-reread"),
      harness.organizationScopeId,
      pool.id,
    );
    expect(reread).toEqual(pool);
  });

  test("a demand commitment is a first-class, tenant-scoped, durable record with a server-written consent grant", async () => {
    const pool = await createPool(harness);
    const commitment = await createCommitment(harness, {
      poolId: pool.id,
      region: "EU_NORTH",
      quantity: 37,
      budgetBand: "band_b_50_199",
    });
    expect(commitment.id).toBeTruthy();
    expect(commitment.organizationScopeId).toBe(harness.organizationScopeId);
    expect(commitment.poolId).toBe(pool.id);
    // EXPLICIT membership provenance: the acting person BECOMES the
    // consumer (there is no consumerPersonId input).
    expect(commitment.consumerPersonId).toBe(harness.consumerPersonId);
    // Category snapshot from the durable pool.
    expect(commitment.categoryKey).toBe(pool.categoryKey);
    expect(commitment.categoryVersion).toBe(pool.categoryVersion);
    // Bounded, provider-neutral attributes.
    expect(commitment.attributes).toEqual({
      region: "EU_NORTH",
      quantity: 37,
      budgetBand: "band_b_50_199",
    });
    // The SERVER-WRITTEN consent grant (the input may only NAME the
    // scope; who + when + version are recorded by the server).
    expect(commitment.consent.scope).toBe(DEMAND_CONSENT_SCOPE);
    expect(commitment.consent.version).toBe(DEMAND_CONSENT_VERSION);
    expect(commitment.consent.grantedBy).toBe(harness.consumerPersonId);
    expect(commitment.consent.grantedAt).toBeTruthy();
    // One-way withdrawal starts null.
    expect(commitment.withdrawnAt).toBeNull();
    expect(commitment.withdrawalReason).toBeNull();
    expect(commitment.recordFormat).toBe(DEMAND_COMMITMENT_RECORD_FORMAT);
    // Execution lineage (provenance).
    expect(commitment.executionId).toBeTruthy();
    expect(commitment.correlationId).toBeTruthy();

    // Durable: re-read through the tenant-scoped read API.
    const reread = await harness.runtime.demandService.getDemandCommitment(
      consumerCtx(harness, "w024-ac01-reread"),
      harness.organizationScopeId,
      commitment.id,
    );
    expect(reread).toEqual(commitment);
  });

  test("the category vocabulary is closed, versioned and fail-closed", async () => {
    let err: unknown;
    try {
      await harness.runtime.demandService.createDemandPool(
        consumerCtx(harness, "w024-ac01-badcategory"),
        {
          organizationScopeId: harness.organizationScopeId,
          name: "Bad Category",
          categoryKey: "vendor_specific_vertical",
          qualificationPolicy: { minimumCommitments: 2 },
          idempotencyKey: key("w024-badcategory"),
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidDemandError);
    const error = err as InvalidDemandError;
    expect(error.code).toBe("DEMAND_VALIDATION");
    expect(error.classification).toBe("validation");
    // The vocabulary stays closed (provider-neutral verticals only).
    expect(DEMAND_CATEGORY_KEYS).toEqual([
      "utilities_energy",
      "telecom_connectivity",
      "insurance_home",
      "grocery_household",
      "software_tools",
      "transport_mobility",
      "health_wellness",
      "home_services",
    ]);
  });

  test("pool-name and prose bounds fail closed", async () => {
    await expect(
      harness.runtime.demandService.createDemandPool(
        consumerCtx(harness, "w024-ac01-emptyname"),
        {
          organizationScopeId: harness.organizationScopeId,
          name: "",
          categoryKey: "utilities_energy",
          qualificationPolicy: { minimumCommitments: 2 },
          idempotencyKey: key("w024-emptyname"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
    await expect(
      harness.runtime.demandService.createDemandPool(
        consumerCtx(harness, "w024-ac01-longname"),
        {
          organizationScopeId: harness.organizationScopeId,
          name: "x".repeat(201),
          categoryKey: "utilities_energy",
          qualificationPolicy: { minimumCommitments: 2 },
          idempotencyKey: key("w024-longname"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
  });

  test("commitment attributes fail closed on invalid region / quantity / budget band", async () => {
    const pool = await createPool(harness);
    const base = {
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      consent: { scope: DEMAND_CONSENT_SCOPE },
    };
    // Invalid region (closed vocabulary).
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-badregion"),
        {
          ...base,
          attributes: { region: "ATLANTIS", quantity: 12 },
          idempotencyKey: key("w024-badregion"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
    // Quantity below the bound.
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-lowqty"),
        {
          ...base,
          attributes: { region: "NA_EAST", quantity: 0 },
          idempotencyKey: key("w024-lowqty"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
    // Quantity above the bound.
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-highqty"),
        {
          ...base,
          attributes: { region: "NA_EAST", quantity: 10001 },
          idempotencyKey: key("w024-highqty"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
    // Non-integer quantity.
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-fracqty"),
        {
          ...base,
          attributes: { region: "NA_EAST", quantity: 12.5 },
          idempotencyKey: key("w024-fracqty"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
    // Invalid budget band.
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-badband"),
        {
          ...base,
          attributes: { region: "NA_EAST", quantity: 12, budgetBand: "band_z" },
          idempotencyKey: key("w024-badband"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
  });

  test("the consent scope is closed: any other consent value fails closed", async () => {
    const pool = await createPool(harness);
    // An attempted individual-disclosure consent does not exist in
    // the vocabulary — no caller assertion can fabricate it.
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-badconsent"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "individual_disclosure" },
          idempotencyKey: key("w024-badconsent"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
    // A missing consent object fails closed too.
    await expect(
      harness.runtime.demandService.createDemandCommitment(
        consumerCtx(harness, "w024-ac01-noconsent"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: undefined as unknown as { scope: string },
          idempotencyKey: key("w024-noconsent"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidDemandError);
  });

  test("pool listing is tenant-scoped and filterable; commitments list by pool/consumer", async () => {
    const poolA = await createPool(harness, {
      name: "AC-01 Pool A",
      categoryKey: "telecom_connectivity",
    });
    const poolB = await createPool(harness, {
      name: "AC-01 Pool B",
      categoryKey: "utilities_energy",
    });
    const commitment = await createCommitment(harness, { poolId: poolA.id });
    await createCommitment(harness, {
      poolId: poolA.id,
      ctx: supplierCtx(harness, "w024-ac01-suppliercommit"),
    });

    const telecom = await harness.runtime.demandService.listDemandPools(
      consumerCtx(harness, "w024-ac01-listpools"),
      harness.organizationScopeId,
      { categoryKey: "telecom_connectivity" },
    );
    expect(telecom.some((p) => p.id === poolA.id)).toBe(true);
    expect(telecom.some((p) => p.id === poolB.id)).toBe(false);

    const byPool = await harness.runtime.demandService.listDemandCommitments(
      consumerCtx(harness, "w024-ac01-listcommit"),
      harness.organizationScopeId,
      { poolId: poolA.id },
    );
    expect(byPool.length).toBe(2);
    expect(
      byPool.some((c) => c.consumerPersonId === commitment.consumerPersonId),
    ).toBe(true);
  });
});
