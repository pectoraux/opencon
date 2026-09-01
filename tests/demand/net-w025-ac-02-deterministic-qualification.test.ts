/**
 * NET-W025 AC-02 — Procurement-pool qualification and the aggregate
 * view are deterministically DERIVED from current authoritative
 * records at evaluation time (issue #50 acceptance criterion 2).
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-02.
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
import { deriveQualifiedProcurementAggregate } from "../../src/demand/procurement-aggregation-engine.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W025-AC-02 deterministic qualification", () => {
  test("identical commitment state yields the identical digest across evaluations (anchor excluded)", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-02 Digest Pool",
    });
    const first = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-eval-1"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    const second = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-eval-2"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // Different-or-equal anchors (millisecond precision may tie),
    // identical decision facts ⇒ identical digest. The anchor is
    // EXCLUDED from the digest; the pure-engine order-independence
    // test below proves it with forced distinct anchors.
    expect(second.digest).toBe(first.digest);
    expect(second.evaluatedAt >= first.evaluatedAt).toBe(true);
    expect(second.qualified).toBe(true);
    expect(second.aggregate).toEqual(first.aggregate);
  });

  test("PURE-ENGINE order independence: commitment order does not affect the derivation", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-02 Order Pool",
    });
    const active = await harness.runtime.procurementService
      .listProcurementCommitments(harness.bootstrapCtx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    expect(active.length).toBe(3);
    const forward = deriveQualifiedProcurementAggregate({
      pool,
      commitments: active,
      requestorMembership: "active",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    const reversed = deriveQualifiedProcurementAggregate({
      pool,
      commitments: [...active].reverse(),
      requestorMembership: "active",
      evaluatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(reversed.digest).toBe(forward.digest);
    expect(reversed.aggregate).toEqual(forward.aggregate);
  });

  test("governing-fact changes change the digest", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-02 Facts Pool",
    });
    const before = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-facts-1"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // A new member of buyer org A adds a second commitment for that
    // organization: commitmentCount 3→4 (organizationCount stays 3).
    const extra = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-02 Extra A Member",
        subjectId: "w025-ac02-extra-a@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(extra.personId, "w025-ac02-extra-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      region: "APAC_EAST",
      quantity: 30,
    });
    const after = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-facts-2"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(after.digest).not.toBe(before.digest);
    expect(after.aggregate?.commitmentCount).toBe(4);
    expect(after.aggregate?.organizationCount).toBe(3);
  });

  test("withdrawn commitments are excluded from the derivation", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-02 Withdraw Pool",
    });
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(harness.bootstrapCtx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    const buyerACommitment = commitments.find(
      (c) => c.buyerOrganizationId === harness.buyerOrgAId,
    )!;
    await harness.runtime.procurementService.withdrawProcurementCommitment(
      buyerCtx(harness, "A", "w025-ac02-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: buyerACommitment.id,
        idempotencyKey: key("w025-ac02-withdraw"),
      },
    );
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-withdraw-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // 2 commitments from 2 organizations: BOTH floors fail → the
    // aggregate suppresses entirely (withdrawal is immediate).
    expect(view.aggregate).toBeNull();
    const privacyFloor = view.checks.find(
      (c) => c.check === "privacy_floor_met",
    );
    const orgFloor = view.checks.find(
      (c) => c.check === "organization_floor_met",
    );
    expect(privacyFloor?.satisfied).toBe(false);
    expect(orgFloor?.satisfied).toBe(false);
    expect(view.qualified).toBe(false);
  });

  test("closed pools never qualify (pool_open fails; aggregate suppressed)", async () => {
    const pool = await seedThreeOrgPool(harness, {
      name: "AC-02 Closed Pool",
    });
    await harness.runtime.procurementService.closeProcurementPool(
      buyerCtx(harness, "A", "w025-ac02-close"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "ac-02 closed",
        idempotencyKey: key("w025-ac02-close"),
      },
    );
    const closedPool = await harness.runtime.procurementService
      .getProcurementPool(
        buyerCtx(harness, "A", "w025-ac02-close-reread"),
        harness.organizationScopeId,
        pool.id,
      );
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-close-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(false);
    const poolOpen = view.checks.find((c) => c.check === "pool_open");
    expect(poolOpen?.satisfied).toBe(false);
    expect((poolOpen?.detail as Record<string, unknown>)["reason"]).toBe(
      "pool_closed",
    );
    expect((poolOpen?.detail as Record<string, unknown>)["closedAt"]).toBe(
      closedPool.closedAt,
    );
    // A closed pool never QUALIFIES — but (the W024-consistent
    // disclosure contract) its historical aggregate remains
    // disclosable above the floors: disclosure is governed by the
    // frozen floors + requestor membership, NOT by lifecycle state.
    // The closure IS a digested governing fact: pool_open=false rides
    // the checks array inside the digest input.
    expect(view.aggregate).not.toBeNull();
    expect(view.qualified).toBe(false);
    expect(
      view.checks.map((c) => `${c.check}:${String(c.satisfied)}`),
    ).toContain("pool_open:false");
  });

  test("commitment-threshold boundary: threshold−1 vs threshold", async () => {
    // Policy demands 4 commitments (and 1 organization).
    const pool = await createProcurementPool(harness, {
      name: "AC-02 Commit Threshold Pool",
      minimumCommitments: 4,
      minimumOrganizations: 1,
    });
    await createProcurementCommitment(harness, { poolId: pool.id });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "B", "w025-ac02-ct-b"),
      buyerOrganizationId: harness.buyerOrgBId,
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "C", "w025-ac02-ct-c"),
      buyerOrganizationId: harness.buyerOrgCId,
    });
    const below = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-ct-1"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // 3 commitments / 3 orgs: floors met (aggregate discloses), the
    // commitment threshold is NOT (3 < 4).
    expect(below.aggregate).not.toBeNull();
    expect(below.qualified).toBe(false);
    const thresholds = below.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    expect(thresholds?.satisfied).toBe(false);
    // A 4th commitment (a second member of buyer org A) crosses the
    // threshold.
    const extra = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-02 CT Extra",
        subjectId: "w025-ac02-ct-extra@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(extra.personId, "w025-ac02-ct-extra"),
      buyerOrganizationId: harness.buyerOrgAId,
    });
    const at = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-ct-2"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(at.qualified).toBe(true);
    expect(at.aggregate?.commitmentCount).toBe(4);
    expect(at.aggregate?.organizationCount).toBe(3);
  });

  test("organization-threshold boundary: threshold−1 vs threshold", async () => {
    // Policy demands 4 distinct organizations (and 1 commitment).
    const pool = await createProcurementPool(harness, {
      name: "AC-02 Org Threshold Pool",
      minimumCommitments: 1,
      minimumOrganizations: 4,
    });
    await createProcurementCommitment(harness, { poolId: pool.id });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "B", "w025-ac02-ot-b"),
      buyerOrganizationId: harness.buyerOrgBId,
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "C", "w025-ac02-ot-c"),
      buyerOrganizationId: harness.buyerOrgCId,
    });
    const below = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-ot-1"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // 3 commitments / 3 orgs: floors met (aggregate discloses), the
    // organization threshold is NOT (3 < 4).
    expect(below.aggregate).not.toBeNull();
    expect(below.qualified).toBe(false);
    const thresholds = below.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    expect(thresholds?.satisfied).toBe(false);
    // A 4th commitment from a SECOND member of buyer org A raises the
    // commitment count but NOT the organization count — the
    // organization threshold still fails.
    const extra = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-02 OT Extra",
        subjectId: "w025-ac02-ot-extra@example.com",
      },
    );
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(extra.personId, "w025-ac02-ot-extra"),
      buyerOrganizationId: harness.buyerOrgAId,
    });
    const stillBelow = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac02-ot-2"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(stillBelow.qualified).toBe(false);
    expect(stillBelow.aggregate?.organizationCount).toBe(3);
    expect(stillBelow.aggregate?.commitmentCount).toBe(4);
    // The exact check set is fixed (6 checks) and nothing derived is
    // stored: the pool record is unchanged by evaluation.
    expect(stillBelow.checks.map((c) => c.check)).toEqual([
      "pool_open",
      "requestor_membership",
      "commitments_present",
      "privacy_floor_met",
      "organization_floor_met",
      "qualification_thresholds_met",
    ]);
    const reread = await harness.runtime.procurementService
      .getProcurementPool(
        supplierCtx(harness, "w025-ac02-ot-reread"),
        harness.organizationScopeId,
        pool.id,
      );
    expect(reread.closedAt).toBeNull();
    expect(reread.updatedAt).toBe(pool.createdAt);
  });
});
