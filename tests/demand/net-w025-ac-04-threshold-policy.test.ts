/**
 * NET-W025 AC-04 — Qualification/competition policy is explicit,
 * versioned, bounded, and unassertable; the floors are frozen
 * constants no pool policy can lower (issue #50 acceptance criterion
 * 4; key invariant 6).
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-04.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW025Harness,
  createProcurementPool,
  createProcurementCommitment,
  createBuyerMember,
  seedThreeOrgPool,
  buyerCtx,
  supplierCtx,
  personCtx,
  type NetW025Harness,
} from "./_net-w025-harness.ts";
import {
  PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS,
  PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS,
} from "../../src/core/procurement.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

const REPO = join(import.meta.dir, "../..");

describe("NET-W025-AC-04 explicit, unassertable thresholds and floors", () => {
  test("the versioned dual-threshold policy rides the pool record and the derived view", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-04 Policy Pool",
      minimumCommitments: 4,
      minimumOrganizations: 3,
    });
    expect(pool.policy).toEqual({
      version: 1,
      minimumCommitments: 4,
      minimumOrganizations: 3,
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac04-policy"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.policy).toEqual(pool.policy);
    // The thresholds are PUBLIC policy — visible in the check detail.
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    expect(thresholds?.detail).toMatchObject({
      policyVersion: 1,
      minimumCommitments: 4,
      minimumOrganizations: 3,
    });
  });

  test("the frozen floors are constants: commitment floor 3 AND organization floor 3", () => {
    expect(PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    expect(PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS).toBe(3);
  });

  test("NEITHER floor can be lowered by pool policy (policy 1/1 still suppresses below the floors)", async () => {
    // The pool creator sets the LOOSEST legal policy (1 commitment,
    // 1 organization). The floors still govern disclosure.
    const pool = await createProcurementPool(harness, {
      name: "AC-04 Loose Policy Pool",
      minimumCommitments: 1,
      minimumOrganizations: 1,
    });
    // 2 commitments from 1 organization: the policy thresholds are
    // MET (2 ≥ 1, 1 ≥ 1) but BOTH floors suppress the aggregate.
    await createProcurementCommitment(harness, { poolId: pool.id });
    const second = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-04 Second A Member",
        subjectId: "w025-ac04-a2@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(second.personId, "w025-ac04-a2"),
      buyerOrganizationId: harness.buyerOrgAId,
    });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac04-loose"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    const orgFloor = view.checks.find(
      (c) => c.check === "organization_floor_met",
    );
    expect(orgFloor?.satisfied).toBe(false);
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    // Policy thresholds met, floors NOT — both facts machine-readable.
    expect(thresholds?.satisfied).toBe(true);
  });

  test("caller-asserted aggregates, counts and qualification outcomes are ignored (smuggled fields)", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-04 Smuggle Pool",
    });
    // Withdraw one commitment so the state is below the floors (the
    // smuggled fields will try to "restore" disclosure).
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(harness.bootstrapCtx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    const buyerACommitment = commitments.find(
      (c) => c.buyerOrganizationId === harness.buyerOrgAId,
    )!;
    await harness.runtime.procurementService.withdrawProcurementCommitment(
      buyerCtx(harness, "A", "w025-ac04-smuggle-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: buyerACommitment.id,
        idempotencyKey: "w025-ac04-smuggle-withdraw",
      },
    );
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac04-smuggle"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          // EVERY smuggled field is ignored — only scope/pool
          // identity exists on the input contract:
          commitmentCount: 9999,
          organizationCount: 9999,
          qualified: true,
          minimumCommitments: 0,
          minimumOrganizations: 0,
          aggregate: {
            commitmentCount: 9999,
            organizationCount: 9999,
          },
        } as never,
      );
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
  });

  test("no activity, spend, wealth or reputation input exists anywhere in the qualification path", async () => {
    for (const rel of [
      "src/core/procurement.ts",
      "src/demand/port.ts",
      "src/demand/procurement-aggregation-engine.ts",
      "src/demand/procurement-pool-service.ts",
      "src/demand/authority-procurement-repositories.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content, `${rel} must not carry spend/reputation inputs`).not
        .toMatch(/\bspendScore\b|\bwealthScore\b|\bactivityScore\b|\breputationScore\b|\bcreateReputationInput\b/i);
    }
  });
});
