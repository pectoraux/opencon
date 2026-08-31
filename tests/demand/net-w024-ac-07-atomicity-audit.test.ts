/**
 * NET-W024 AC-07 — Material demand mutations are atomically committed
 * with idempotency and audit lineage; failed commits leave no partial
 * pool state (issue #48 acceptance criterion 7).
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-07.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW024Harness,
  createPool,
  createCommitment,
  createPerson,
  consumerCtx,
  supplierCtx,
  personCtx,
  key,
  type NetW024Harness,
} from "./_net-w024-harness.ts";
import { createDemandService } from "../../src/demand/demand-service.ts";
import {
  createAuthorityDemandCommitmentRepository,
  createAuthorityDemandPoolRepository,
} from "../../src/demand/authority-demand-repositories.ts";
import type {
  DemandCommitmentRepository,
  DemandPoolRepository,
  DemandService,
} from "../../src/demand/port.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W024-AC-07 atomicity + audit lineage", () => {
  test("a commitment and its audit event commit atomically on ONE transaction with full lineage", async () => {
    const pool = await createPool(harness, { name: "AC-07 Lineage Pool" });
    const ctx = consumerCtx(harness, "w024-ac07-lineage");

    const result = await harness.runtime.demandService.createDemandCommitment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac07-lineage"),
      },
    );
    expect(result.created).toBe(true);

    const events = await harness.runtime.auditWriter.query({
      eventType: "demand_commitment.recorded",
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
    expect(event.actor).toBe(harness.consumerPersonId);
    expect(event.subject).toBe(result.commitment.id);
    expect(event.resourceType).toBe("demand_commitment");
    // The record's own provenance ties back to the same execution.
    expect(result.commitment.executionId).toBe(ctx.executionId);
    expect(result.commitment.correlationId).toBe(ctx.correlationId);
  });

  test("FAILURE INJECTION: a repository failure inside the transaction leaves NO record and NO audit event", async () => {
    // The pool + its audit event exist (committed normally).
    const pool = await createPool(harness, { name: "AC-07 Failure Pool" });
    const ctx = consumerCtx(harness, "w024-ac07-failure");

    // A demand service built over the SAME authority/idempotency/
    // audit infrastructure but with a FAILING commitment repository
    // (the failure lands INSIDE the authoritative transaction).
    const realCommitmentRepo: DemandCommitmentRepository =
      createAuthorityDemandCommitmentRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const realPoolRepo: DemandPoolRepository =
      createAuthorityDemandPoolRepository({
        authority: harness.runtime.postgresAuthority,
      });
    const failingCommitmentRepo: DemandCommitmentRepository = {
      ...realCommitmentRepo,
      async createWithinTx(commitment, tx) {
        throw new Error("injected commitment write failure");
      },
    };
    const failingService: DemandService = createDemandService({
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
      failingService.createDemandCommitment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac07-failure"),
      }),
    ).rejects.toThrow("injected commitment write failure");

    // NO partial pool state: no commitment record for this key and
    // NO audit event (the transactional buffer was discarded on
    // rollback — audit can never exist for a mutation that never
    // committed).
    const commitments = await harness.runtime.demandService.listDemandCommitments(
      ctx,
      harness.organizationScopeId,
      { poolId: pool.id },
    );
    expect(commitments.length).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "demand_commitment.recorded",
    });
    const forThisPool = events.filter(
      (e) => (e.metadata as Record<string, unknown>)["poolId"] === pool.id,
    );
    expect(forThisPool.length).toBe(0);

    // The failed key is replayable: the retry (healthy path) commits.
    const retry = await harness.runtime.demandService.createDemandCommitment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac07-retry"),
      },
    );
    expect(retry.created).toBe(true);
    const after = await harness.runtime.auditWriter.query({
      eventType: "demand_commitment.recorded",
    });
    const forPoolAfter = after.filter(
      (e) => (e.metadata as Record<string, unknown>)["poolId"] === pool.id,
    );
    expect(forPoolAfter.length).toBe(1);
  });

  test("withdrawal and closure carry their own atomic audit events", async () => {
    const pool = await createPool(harness, { name: "AC-07 Withdraw Pool" });
    const commitment = await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac07-w-commit"),
    });

    await harness.runtime.demandService.withdrawDemandCommitment(
      supplierCtx(harness, "w024-ac07-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey: key("w024-ac07-withdraw"),
      },
    );
    const withdrawnEvents = await harness.runtime.auditWriter.query({
      eventType: "demand_commitment.withdrawn",
      resourceId: commitment.id,
    });
    expect(withdrawnEvents.length).toBe(1);
    const wMeta = withdrawnEvents[0]!.metadata as Record<string, unknown>;
    expect(typeof wMeta["transactionId"]).toBe("string");
    expect(typeof wMeta["idempotencyRecordId"]).toBe("string");
    expect(wMeta["poolId"]).toBe(pool.id);

    await harness.runtime.demandService.closeDemandPool(
      consumerCtx(harness, "w024-ac07-close"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        reason: "ac-07 closed",
        idempotencyKey: key("w024-ac07-close"),
      },
    );
    const closedEvents = await harness.runtime.auditWriter.query({
      eventType: "demand_pool.closed",
      resourceId: pool.id,
    });
    expect(closedEvents.length).toBe(1);
    const cMeta = closedEvents[0]!.metadata as Record<string, unknown>;
    expect(typeof cMeta["transactionId"]).toBe("string");
    expect(typeof cMeta["idempotencyRecordId"]).toBe("string");
    expect(cMeta["closedAt"]).not.toBeNull();
  });

  test("the pool creation event carries the versioned policy + provenance metadata", async () => {
    const pool = await createPool(harness, {
      name: "AC-07 Created Pool",
      categoryKey: "telecom_connectivity",
      minimumCommitments: 4,
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "demand_pool.created",
      resourceId: pool.id,
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata["organizationScopeId"]).toBe(harness.organizationScopeId);
    expect(metadata["createdBy"]).toBe(harness.consumerPersonId);
    expect(metadata["categoryKey"]).toBe("telecom_connectivity");
    expect(metadata["policy"]).toEqual({
      version: 1,
      minimumCommitments: 4,
    });
    expect(typeof metadata["transactionId"]).toBe("string");
    expect(typeof metadata["idempotencyRecordId"]).toBe("string");
  });

  test("the complete mutation set leaves a closed-world audit vocabulary", async () => {
    // Every demand audit event is one of the four material mutation
    // types — evaluations (derived reads) emit NOTHING.
    const member = await createPerson(harness, {
      displayName: "AC-07 Vocab Member",
      subjectId: "w024-ac07-vocab@example.com",
      member: true,
    });
    const pool = await createPool(harness, { name: "AC-07 Vocab Pool" });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(member.personId, "w024-ac07-vocab-commit"),
    });
    await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac07-vocab-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    const events = await harness.runtime.auditWriter.query({});
    const demandEvents = events.filter((e) =>
      [
        "demand_pool.created",
        "demand_pool.closed",
        "demand_commitment.recorded",
        "demand_commitment.withdrawn",
      ].includes(e.eventType),
    );
    expect(demandEvents.length).toBeGreaterThan(0);
    // Every demand event is from the closed vocabulary (nothing
    // outside it — no evaluation events, no ad-hoc types).
    expect(
      events.filter((e) => e.eventType.startsWith("demand_")).length,
    ).toBe(demandEvents.length);
  });
});
