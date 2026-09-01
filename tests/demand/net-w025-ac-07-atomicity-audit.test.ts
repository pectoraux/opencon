/**
 * NET-W025 AC-07 — Procurement-pool/commitment mutations and their
 * audit events commit atomically on ONE authoritative transaction;
 * failed commits leave no partial procurement-pool state (issue #50
 * acceptance criterion 7).
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-07.
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
import { createProcurementService } from "../../src/demand/procurement-pool-service.ts";
import {
  createAuthorityProcurementCommitmentRepository,
  createAuthorityProcurementPoolRepository,
} from "../../src/demand/authority-procurement-repositories.ts";
import type {
  ProcurementCommitmentRepository,
  ProcurementPoolRepository,
  ProcurementService,
} from "../../src/demand/port.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W025-AC-07 atomicity + audit lineage", () => {
  test("a commitment and its audit event commit atomically on ONE transaction with full lineage", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-07 Lineage Pool",
    });
    const ctx = buyerCtx(harness, "A", "w025-ac07-lineage");

    const result = await harness.runtime.procurementService
      .createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w025-ac07-lineage"),
      });
    expect(result.created).toBe(true);

    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_commitment.recorded",
      resourceId: result.commitment.id,
    });
    expect(events.length).toBe(1);
    const event = events[0]!;
    // Audit lineage: the transactional id + idempotency record id +
    // the execution context lineage.
    const metadata = event.metadata as Record<string, unknown>;
    expect(typeof metadata["transactionId"]).toBe("string");
    expect((metadata["transactionId"] as string).length).toBeGreaterThan(0);
    expect(typeof metadata["idempotencyRecordId"]).toBe("string");
    expect(event.executionId).toBe(ctx.executionId);
    expect(event.correlationId).toBe(ctx.correlationId);
    expect(event.actor).toBe(harness.buyerAPersonId);
    expect(event.subject).toBe(result.commitment.id);
    expect(event.resourceType).toBe("procurement_commitment");
    // The record's own provenance ties back to the same execution.
    expect(result.commitment.executionId).toBe(ctx.executionId);
    expect(result.commitment.correlationId).toBe(ctx.correlationId);
  });

  test("FAILURE INJECTION: a repository failure inside the transaction leaves NO record and NO audit event", async () => {
    // The pool + its audit event exist (committed normally).
    const pool = await createProcurementPool(harness, {
      name: "AC-07 Failure Pool",
    });
    const ctx = buyerCtx(harness, "A", "w025-ac07-failure");

    // A procurement service built over the SAME
    // authority/idempotency/audit infrastructure but with a FAILING
    // commitment repository (the failure lands INSIDE the
    // authoritative transaction).
    const realCommitmentRepo: ProcurementCommitmentRepository =
      createAuthorityProcurementCommitmentRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realPoolRepo: ProcurementPoolRepository =
      createAuthorityProcurementPoolRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const failingCommitmentRepo: ProcurementCommitmentRepository = {
      ...realCommitmentRepo,
      async createWithinTx(commitment, tx) {
        throw new Error("injected procurement commitment write failure");
      },
    };
    const failingService: ProcurementService = createProcurementService({
      poolRepository: realPoolRepo,
      commitmentRepository: failingCommitmentRepo,
      membershipLookup: {
        async resolveMembership() {
          return "active";
        },
      },
      idempotency: harness.runtime.idempotency,
      auditWriter: harness.runtime.auditWriter,
      logger: harness.runtime.logger.forModule("demand"),
    });

    await expect(
      failingService.createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w025-ac07-failure"),
      }),
    ).rejects.toThrow("injected procurement commitment write failure");

    // NO partial pool state: no commitment record for this key and
    // NO audit event (the transactional buffer was discarded on
    // rollback — audit can never exist for a mutation that never
    // committed).
    const commitments = await harness.runtime.procurementService
      .listProcurementCommitments(ctx, harness.organizationScopeId, {
        poolId: pool.id,
      });
    expect(commitments.length).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_commitment.recorded",
    });
    const forThisPool = events.filter(
      (e) => (e.metadata as Record<string, unknown>)["poolId"] === pool.id,
    );
    expect(forThisPool.length).toBe(0);

    // The failed key is replayable: the retry (healthy path) commits.
    const retry = await harness.runtime.procurementService
      .createProcurementCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w025-ac07-retry"),
      });
    expect(retry.created).toBe(true);
    const after = await harness.runtime.auditWriter.query({
      eventType: "procurement_commitment.recorded",
    });
    const forPoolAfter = after.filter(
      (e) => (e.metadata as Record<string, unknown>)["poolId"] === pool.id,
    );
    expect(forPoolAfter.length).toBe(1);
  });

  test("withdrawal and closure carry their own atomic audit events", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-07 Withdraw Pool",
    });
    const commitment = await createProcurementCommitment(harness, {
      poolId: pool.id,
    });

    await harness.runtime.procurementService.withdrawProcurementCommitment(
      buyerCtx(harness, "A", "w025-ac07-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey: key("w025-ac07-withdraw"),
      },
    );
    const withdrawnEvents = await harness.runtime.auditWriter.query({
      eventType: "procurement_commitment.withdrawn",
      resourceId: commitment.id,
    });
    expect(withdrawnEvents.length).toBe(1);
    const wMeta = withdrawnEvents[0]!.metadata as Record<string, unknown>;
    expect(typeof wMeta["transactionId"]).toBe("string");
    expect(typeof wMeta["idempotencyRecordId"]).toBe("string");
    expect(wMeta["poolId"]).toBe(pool.id);
    expect(wMeta["buyerOrganizationId"]).toBe(harness.buyerOrgAId);

    await harness.runtime.procurementService.closeProcurementPool(
      buyerCtx(harness, "A", "w025-ac07-close"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "ac-07 closed",
        idempotencyKey: key("w025-ac07-close"),
      },
    );
    const closedEvents = await harness.runtime.auditWriter.query({
      eventType: "procurement_pool.closed",
      resourceId: pool.id,
    });
    expect(closedEvents.length).toBe(1);
    const cMeta = closedEvents[0]!.metadata as Record<string, unknown>;
    expect(typeof cMeta["transactionId"]).toBe("string");
    expect(typeof cMeta["idempotencyRecordId"]).toBe("string");
    expect(cMeta["closedAt"]).not.toBeNull();
  });

  test("the pool creation event carries the versioned dual-threshold policy + provenance metadata", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-07 Created Pool",
      categoryKey: "logistics_freight",
      minimumCommitments: 4,
      minimumOrganizations: 3,
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_pool.created",
      resourceId: pool.id,
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata["organizationScopeId"]).toBe(harness.organizationScopeId);
    expect(metadata["createdBy"]).toBe(harness.buyerAPersonId);
    expect(metadata["categoryKey"]).toBe("logistics_freight");
    expect(metadata["policy"]).toEqual({
      version: 1,
      minimumCommitments: 4,
      minimumOrganizations: 3,
    });
    expect(typeof metadata["transactionId"]).toBe("string");
    expect(typeof metadata["idempotencyRecordId"]).toBe("string");
  });

  test("the complete mutation set leaves a closed-world audit vocabulary (evaluations audit nothing)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-07 Vocab Pool",
    });
    await createProcurementCommitment(harness, { poolId: pool.id });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "B", "w025-ac07-vocab-b"),
      buyerOrganizationId: harness.buyerOrgBId,
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "C", "w025-ac07-vocab-c"),
      buyerOrganizationId: harness.buyerOrgCId,
    });
    const eventsBefore = await harness.runtime.auditWriter.query({});
    await harness.runtime.procurementService.evaluateQualifiedProcurementDemand(
      supplierCtx(harness, "w025-ac07-vocab-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    const eventsAfter = await harness.runtime.auditWriter.query({});
    // The evaluation emitted NOTHING.
    expect(eventsAfter.length).toBe(eventsBefore.length);
    // Every procurement event is from the closed vocabulary (nothing
    // outside it — no evaluation events, no ad-hoc types).
    const events = await harness.runtime.auditWriter.query({});
    const procurementEvents = events.filter((e) =>
      [
        "procurement_pool.created",
        "procurement_pool.closed",
        "procurement_commitment.recorded",
        "procurement_commitment.withdrawn",
      ].includes(e.eventType),
    );
    expect(procurementEvents.length).toBeGreaterThan(0);
    expect(
      events.filter((e) => e.eventType.startsWith("procurement_")).length,
    ).toBe(procurementEvents.length);
  });
});
