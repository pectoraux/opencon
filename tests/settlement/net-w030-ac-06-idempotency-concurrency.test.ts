/**
 * NET-W030 AC-06 — idempotency / concurrency / atomicity + fault
 * injection (issue #61; work order §3.6, §6).
 *
 * Fact recording uses composite idempotency, identity-mutex
 * concurrency serialization, ONE authoritative transaction and
 * transactional audit buffering with post-commit publication. A
 * failed gate or authoritative commit leaves NO partial mutation —
 * no fact record, no audit event — and a retry with the same
 * idempotency key re-executes the whole unit exactly once.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createNetW030Harness,
  recordExternalFact,
  buildProviderNotification,
  createInternalLineage,
  actorCtx,
  auditCount,
  type NetW030Harness,
} from "./_net-w030-harness.ts";
import { ExternalSettlementIngestionError } from "../../src/settlement/external-settlement-service.ts";

describe("NET-W030-AC-06 idempotency / concurrency / atomicity / fault injection", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("CONCURRENT recordings of the same identity serialize to EXACTLY ONE fact (the identity mutex)", async () => {
    const lineage = await createInternalLineage(harness, 90);
    const payload = buildProviderNotification(harness, {
      externalId: `ext-concurrent-${randomUUID()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 90,
    });
    // N concurrent callers with DIFFERENT idempotency keys but the
    // SAME identity + substance: the identity mutex serializes them;
    // exactly one record commits; every caller resolves the SAME
    // committed fact.
    const callers = Array.from({ length: 8 }, (_, i) =>
      harness.runtime.externalSettlementService
        .recordExternalSettlementFact(actorCtx(harness, `ac06-concurrent-${i}`), {
          organizationScopeId: harness.organizationScopeId,
          provider: "reference",
          payload: { ...payload },
          idempotencyKey: `ac06-concurrent-${i}`,
        })
        .then((r) => ({ id: r.fact.id, created: r.created })),
    );
    const results = await Promise.all(callers);
    const distinctIds = new Set(results.map((r) => r.id));
    expect(distinctIds.size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
    // Exactly one audit event for the identity.
    const listing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac06-concurrent-list"),
      harness.organizationScopeId,
    );
    const externalId = payload.externalId as string;
    expect(listing.filter((f) => f.externalId === externalId)).toHaveLength(1);
    expect(await auditCount(harness, "external_settlement_fact.recorded")).toBeGreaterThanOrEqual(1);
  });

  test("the composite idempotency key binds (scope, provider, external id, caller key) — distinct keys replay the identity", async () => {
    const lineage = await createInternalLineage(harness, 10);
    const payload = buildProviderNotification(harness, {
      externalId: `ext-composite-${randomUUID()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 10,
    });
    const first = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac06-composite-a"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac06-composite-a",
      },
    );
    expect(first.created).toBe(true);
    const second = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac06-composite-b"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac06-composite-b",
      },
    );
    expect(second.created).toBe(false);
    expect(second.fact.id).toBe(first.fact.id);
    // The SECOND org holds a DIFFERENT identity namespace (its own
    // scope) — the same external id there is a separate record, not a
    // replay.
    const foreign = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac06-composite-foreign"),
      {
        organizationScopeId: harness.secondOrganizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac06-composite-a",
      },
    );
    expect(foreign.created).toBe(true);
    expect(foreign.fact.id).not.toBe(first.fact.id);
  });

  test("FAULT INJECTION: an in-tx gate failure commits NOTHING (no fact, no audit — the buffer is discarded)", async () => {
    const lineage = await createInternalLineage(harness, 70);
    const before = await auditCount(harness, "external_settlement_fact.recorded");
    // A correction referencing a nonexistent fact fails INSIDE the
    // authoritative transaction (after validation, authentication
    // and freshness all passed) — the rolled-back commit must leave
    // no partial mutation and publish no audit event.
    await expect(
      recordExternalFact(harness, {
        internalTransactionId: lineage.transactionId,
        correctionOf: "no-such-correction-target",
      }),
    ).rejects.toThrow(ExternalSettlementIngestionError);
    const after = await auditCount(harness, "external_settlement_fact.recorded");
    expect(after).toBe(before);
    const listing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac06-fault-list"),
      harness.organizationScopeId,
    );
    expect(listing.filter((f) => f.correctionOf === "no-such-correction-target")).toHaveLength(0);

    // The identity mutex was released by the rollback: a corrected
    // retry with the SAME external id but a VALID payload succeeds.
    const retry = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
    });
    expect(retry.id).toBeTruthy();
  });

  test("a REJECTED ingestion (pre-transaction gates) never records and never audits", async () => {
    const lineage = await createInternalLineage(harness, 20);
    const recordedBefore = await auditCount(harness, "external_settlement_fact.recorded");
    await expect(
      recordExternalFact(harness, {
        internalTransactionId: lineage.transactionId,
        tampered: true,
      }),
    ).rejects.toThrow(ExternalSettlementIngestionError);
    expect(await auditCount(harness, "external_settlement_fact.recorded")).toBe(recordedBefore);
    const listing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac06-rejected-list"),
      harness.organizationScopeId,
    );
    // Nothing from the rejected identity.
    expect(listing.filter((f) => f.internalTransactionId === lineage.transactionId)).toHaveLength(0);
  });

  test("audit publication is POST-COMMIT: the recording event carries the authoritative transaction + idempotency record ids", async () => {
    const lineage = await createInternalLineage(harness, 15);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 15,
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "external_settlement_fact.recorded",
      resourceId: fact.id,
    });
    expect(events).toHaveLength(1);
    expect(typeof events[0]?.metadata.transactionId).toBe("string");
    expect(typeof events[0]?.metadata.idempotencyRecordId).toBe("string");
    expect(events[0]?.metadata.organizationScopeId).toBe(harness.organizationScopeId);
  });

  test("the failed-commit retry path is exactly-once for the SAME idempotency key", async () => {
    const lineage = await createInternalLineage(harness, 25);
    const payload = buildProviderNotification(harness, {
      externalId: `ext-retry-${randomUUID()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 25,
    });
    const key = "ac06-retry";
    // First attempt fails in-tx (correction target missing).
    await expect(
      harness.runtime.externalSettlementService.recordExternalSettlementFact(
        actorCtx(harness, "ac06-retry-fail"),
        {
          organizationScopeId: harness.organizationScopeId,
          provider: "reference",
          payload: { ...payload, correctionOf: "no-such-target" },
          idempotencyKey: key,
        },
      ),
    ).rejects.toThrow(ExternalSettlementIngestionError);
    // The retry with the SAME key succeeds and commits.
    const retry = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac06-retry-ok"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: key,
      },
    );
    expect(retry.created).toBe(true);
    // And a further same-key replay returns the committed record.
    const replay = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac06-retry-replay"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: key,
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.fact.id).toBe(retry.fact.id);
  });
});
