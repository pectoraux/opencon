/**
 * NET-W025 AC-05 — Same-key replay and concurrent submissions are
 * exactly-once and preserve aggregate conservation (issue #50
 * acceptance criterion 5).
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-05.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW025Harness,
  createProcurementPool,
  createProcurementCommitment,
  createBuyerMember,
  buyerCtx,
  supplierCtx,
  personCtx,
  key,
  type NetW025Harness,
} from "./_net-w025-harness.ts";
import { ProcurementCommitmentConflictError } from "../../src/core/procurement.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W025-AC-05 idempotency, concurrency, conservation", () => {
  test("same-key replay is exactly-once (one record, one audit event)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-05 Replay Pool",
    });
    const ctx = buyerCtx(harness, "A", "w025-ac05-replay");
    const idempotencyKey = key("w025-ac05-replay");
    const first = await harness.runtime.procurementService
      .createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey,
      });
    expect(first.created).toBe(true);
    const replay = await harness.runtime.procurementService
      .createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey,
      });
    expect(replay.created).toBe(false);
    expect(replay.commitment).toEqual(first.commitment);
    // Exactly ONE record.
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(ctx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    expect(commitments.length).toBe(1);
    // Exactly ONE audit event.
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_commitment.recorded",
      resourceId: first.commitment.id,
    });
    expect(events.length).toBe(1);
  });

  test("4-way concurrent SAME-KEY submissions yield exactly one commitment", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-05 Concurrent Same Pool",
    });
    const idempotencyKey = key("w025-ac05-concurrent-same");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      buyerOrganizationId: harness.buyerOrgAId,
      attributes: { region: "NA_EAST", quantity: 12 },
      consent: { scope: "aggregate_disclosure" },
      idempotencyKey,
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        harness.runtime.procurementService.createProcurementCommitment(
          buyerCtx(harness, "A", `w025-ac05-cs-${i}`),
          input,
        ),
      ),
    );
    expect(results.filter((r) => r.created).length).toBe(1);
    expect(new Set(results.map((r) => r.commitment.id)).size).toBe(1);
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(
        supplierCtx(harness, "w025-ac05-cs-list"),
        harness.organizationScopeId,
        { poolId: pool.id },
      );
    expect(commitments.length).toBe(1);
  });

  test("4-way concurrent DISTINCT-KEY submissions all commit and the aggregate conserves", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-05 Concurrent Distinct Pool",
    });
    // Four submitters: buyers A, B, C and a second member of A.
    const extra = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-05 Concurrent Extra",
        subjectId: "w025-ac05-cd-extra@example.com",
      },
    );
    const submissions = [
      {
        ctx: buyerCtx(harness, "A", "w025-ac05-cd-a"),
        buyerOrganizationId: harness.buyerOrgAId,
      },
      {
        ctx: buyerCtx(harness, "B", "w025-ac05-cd-b"),
        buyerOrganizationId: harness.buyerOrgBId,
      },
      {
        ctx: buyerCtx(harness, "C", "w025-ac05-cd-c"),
        buyerOrganizationId: harness.buyerOrgCId,
      },
      {
        ctx: personCtx(extra.personId, "w025-ac05-cd-extra"),
        buyerOrganizationId: harness.buyerOrgAId,
      },
    ];
    await Promise.all(
      submissions.map((s) =>
        harness.runtime.procurementService.createProcurementCommitment(
          s.ctx,
          {
            organizationScopeId: harness.organizationScopeId,
            poolId: pool.id,
            buyerOrganizationId: s.buyerOrganizationId,
            attributes: { region: "NA_EAST", quantity: 12 },
            consent: { scope: "aggregate_disclosure" },
            idempotencyKey: key("w025-ac05-cd"),
          },
        ),
      ),
    );
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac05-cd-eval"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // Conservation: 4 commitments across 3 distinct organizations,
    // exactly as submitted.
    expect(view.aggregate?.commitmentCount).toBe(4);
    expect(view.aggregate?.organizationCount).toBe(3);
  });

  test("withdrawal is exactly-once and idempotent", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-05 Withdraw Pool",
    });
    const commitment = await createProcurementCommitment(harness, {
      poolId: pool.id,
    });
    const ctx = buyerCtx(harness, "A", "w025-ac05-withdraw");
    const idempotencyKey = key("w025-ac05-withdraw");
    const first = await harness.runtime.procurementService
      .withdrawProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey,
      });
    const replay = await harness.runtime.procurementService
      .withdrawProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey,
      });
    expect(replay).toEqual(first);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_commitment.withdrawn",
      resourceId: commitment.id,
    });
    expect(events.length).toBe(1);
  });

  test("one active commitment per (pool, submitter) conflicts deterministically", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-05 Conflict Pool",
    });
    await createProcurementCommitment(harness, { poolId: pool.id });
    // SAME submitter, DIFFERENT key → the stable conflict.
    let error: unknown;
    try {
      await harness.runtime.procurementService.createProcurementCommitment(
        buyerCtx(harness, "A", "w025-ac05-conflict"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "EU_WEST", quantity: 40 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac05-conflict"),
        },
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProcurementCommitmentConflictError);
    const conflict = error as ProcurementCommitmentConflictError;
    expect(conflict.code).toBe("PROCUREMENT_COMMITMENT_CONFLICT");
    expect(conflict.classification).toBe("conflict");
    expect((conflict.context as Record<string, unknown>)["poolId"]).toBe(
      pool.id,
    );
    // A DIFFERENT member of the SAME buyer organization does NOT
    // conflict (the buyer organization may hold multiple commitments;
    // the organization floor governs that dimension).
    const extra = await createBuyerMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.buyerOrgAId,
      {
        displayName: "AC-05 Conflict Extra",
        subjectId: "w025-ac05-conflict-extra@example.com",
      },
    );
    const sameOrg = await harness.runtime.procurementService
      .createProcurementCommitment(
        personCtx(extra.personId, "w025-ac05-conflict-extra"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "NA_EAST", quantity: 20 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac05-conflict-extra"),
        },
      );
    expect(sameOrg.created).toBe(true);
  });

  test("withdraw then re-commit creates a NEW record (re-entry)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-05 Reentry Pool",
    });
    const first = await createProcurementCommitment(harness, {
      poolId: pool.id,
    });
    await harness.runtime.procurementService.withdrawProcurementCommitment(
      buyerCtx(harness, "A", "w025-ac05-reentry-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: first.id,
        idempotencyKey: key("w025-ac05-reentry-withdraw"),
      },
    );
    const second = await harness.runtime.procurementService
      .createProcurementCommitment(
        buyerCtx(harness, "A", "w025-ac05-reentry-recommit"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "EU_WEST", quantity: 60 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac05-reentry-recommit"),
        },
      );
    expect(second.created).toBe(true);
    expect(second.commitment.id).not.toBe(first.id);
    expect(second.commitment.withdrawnAt).toBeNull();
  });

  test("pool creation and closure replay exactly-once", async () => {
    const ctx = buyerCtx(harness, "A", "w025-ac05-pool-replay");
    const idempotencyKey = key("w025-ac05-pool-replay");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      name: "AC-05 Pool Replay",
      categoryKey: "professional_services",
      qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
      idempotencyKey,
    };
    const first = await harness.runtime.procurementService
      .createProcurementPool(ctx, input);
    expect(first.created).toBe(true);
    const replay = await harness.runtime.procurementService
      .createProcurementPool(ctx, input);
    expect(replay.created).toBe(false);
    expect(replay.pool).toEqual(first.pool);
    // Closure replay: same key → identical one-way result.
    const closeKey = key("w025-ac05-close-replay");
    const closed = await harness.runtime.procurementService
      .closeProcurementPool(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: first.pool.id,
        reason: "done",
        idempotencyKey: closeKey,
      });
    const closedReplay = await harness.runtime.procurementService
      .closeProcurementPool(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: first.pool.id,
        reason: "done",
        idempotencyKey: closeKey,
      });
    expect(closedReplay).toEqual(closed);
    // One creation event, one closure event.
    const created = await harness.runtime.auditWriter.query({
      eventType: "procurement_pool.created",
      resourceId: first.pool.id,
    });
    expect(created.length).toBe(1);
    const closedEvents = await harness.runtime.auditWriter.query({
      eventType: "procurement_pool.closed",
      resourceId: first.pool.id,
    });
    expect(closedEvents.length).toBe(1);
  });
});
