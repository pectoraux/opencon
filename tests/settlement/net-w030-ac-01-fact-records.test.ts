/**
 * NET-W030 AC-01 — external transaction fact records (append-only,
 * idempotent, immutable; issue #61; work order §3.1, §6).
 *
 * First-class tenant-scoped external settlement transaction facts:
 * recorded INSIDE /settlement, create-only, exactly-once per
 * (organization scope, provider, external id) with composite
 * idempotency keys; replays return the committed record verbatim; a
 * conflicting substance is a CONFLICT — never a second record, never
 * a mutation; corrections are NEW records referencing the corrected
 * one (append-only, never in-place rewrites).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW030Harness,
  recordExternalFact,
  buildProviderNotification,
  createInternalLineage,
  actorCtx,
  type NetW030Harness,
} from "./_net-w030-harness.ts";
import { ExternalSettlementIngestionError } from "../../src/settlement/external-settlement-service.ts";
import {
  EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT,
  EXTERNAL_SETTLEMENT_PROVIDERS,
} from "../../src/settlement/port.ts";

function ingestionReason(err: unknown): string | undefined {
  if (err instanceof ExternalSettlementIngestionError) {
    return err.context.reason as string;
  }
  return undefined;
}

describe("NET-W030-AC-01 external transaction fact records", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("a recorded fact is a first-class /settlement record with the full neutral fact surface", async () => {
    const lineage = await createInternalLineage(harness);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount,
    });
    expect(fact.organizationScopeId).toBe(harness.organizationScopeId);
    expect(fact.provider).toBe(EXTERNAL_SETTLEMENT_PROVIDERS[0]);
    expect(fact.providerVersion).toBe("1.0.0");
    expect(fact.externalId).toMatch(/^ext-txn-/);
    expect(fact.internalTransactionId).toBe(lineage.transactionId);
    expect(fact.reportedAmount).toBe(lineage.amount);
    expect(fact.reportedUnit).toBe("value");
    expect(fact.observedAt).toBeTruthy();
    expect(fact.recordedAt).toBeTruthy();
    expect(fact.correctionOf).toBeNull();
    expect(fact.idempotencyKey).toBeTruthy();
    expect(fact.recordFormat).toBe(EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT);
    expect(fact.executionId).toBeTruthy();
    expect(fact.correlationId).toBeTruthy();
  });

  test("replay with the SAME idempotency key returns the committed record (created: false)", async () => {
    const lineage = await createInternalLineage(harness);
    const externalId = `ext-txn-replay-${Date.now()}`;
    const payload = buildProviderNotification(harness, {
      externalId,
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount,
    });
    const ctx = actorCtx(harness, "ac01-same-key");
    const first = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac01-same-key",
      },
    );
    expect(first.created).toBe(true);
    // The exact same submission + key replays the committed record.
    const replay = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac01-same-key",
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.fact.id).toBe(first.fact.id);
  });

  test("the identity replay: same (scope, provider, external id) + same substance replays regardless of the idempotency key", async () => {
    const lineage = await createInternalLineage(harness);
    const externalId = `ext-txn-identity-${Date.now()}`;
    const payload = buildProviderNotification(harness, {
      externalId,
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount,
    });
    const first = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac01-identity-a"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac01-identity-a",
      },
    );
    expect(first.created).toBe(true);

    // A DIFFERENT idempotency key with the SAME substance: the
    // committed record replays (exactly-once identity).
    const replay = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac01-identity-b"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac01-identity-b",
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.fact.id).toBe(first.fact.id);
    // The immutable committed record keeps the FIRST key.
    expect(replay.fact.idempotencyKey).toBe("ac01-identity-a");
  });

  test("a conflicting substance for the same identity is a CONFLICT — never a second record, never a mutation", async () => {
    const lineage = await createInternalLineage(harness);
    const externalId = `ext-txn-conflict-${Date.now()}`;
    const first = await recordExternalFact(harness, {
      externalId,
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount,
    });

    // Same identity, DIFFERENT reported amount: the external network
    // contradicting its own attested facts fails closed.
    let conflict: unknown;
    try {
      await recordExternalFact(harness, {
        externalId,
        internalTransactionId: lineage.transactionId,
        reportedAmount: lineage.amount + 1,
      });
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toBeInstanceOf(ExternalSettlementIngestionError);
    expect(ingestionReason(conflict)).toBe("conflicting_fact");

    // The committed record is unchanged (immutable facts).
    const stored = await harness.runtime.externalSettlementService.getExternalSettlementFact(
      actorCtx(harness, "ac01-conflict-read"),
      harness.organizationScopeId,
      first.id,
    );
    expect(stored?.reportedAmount).toBe(lineage.amount);
    const listing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac01-conflict-list"),
      harness.organizationScopeId,
    );
    expect(listing.filter((f) => f.externalId === externalId)).toHaveLength(1);
  });

  test("corrections are NEW fact records referencing the corrected one (append-only, never in-place rewrites)", async () => {
    const lineage = await createInternalLineage(harness);
    const original = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount + 5,
    });
    const correction = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount,
      correctionOf: original.id,
    });
    expect(correction.correctionOf).toBe(original.id);
    expect(correction.id).not.toBe(original.id);

    // The ORIGINAL is untouched by the correction.
    const storedOriginal = await harness.runtime.externalSettlementService.getExternalSettlementFact(
      actorCtx(harness, "ac01-correction-read"),
      harness.organizationScopeId,
      original.id,
    );
    expect(storedOriginal?.reportedAmount).toBe(lineage.amount + 5);
    expect(storedOriginal?.correctionOf).toBeNull();
  });

  test("a correction referencing a fact that does not resolve in the scope fails closed (correction_target_not_found)", async () => {
    const lineage = await createInternalLineage(harness);
    let err: unknown;
    try {
      await recordExternalFact(harness, {
        internalTransactionId: lineage.transactionId,
        correctionOf: "no-such-fact",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExternalSettlementIngestionError);
    expect(ingestionReason(err)).toBe("correction_target_not_found");
  });

  test("the tenant listing returns the tenant's facts in recording order (cross-tenant facts never appear)", async () => {
    const lineage = await createInternalLineage(harness);
    const a = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
    });
    const b = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
    });
    const listing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac01-list"),
      harness.organizationScopeId,
    );
    const ids = listing.map((f) => f.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.indexOf(b.id)).toBeGreaterThan(ids.indexOf(a.id));
    // The second org sees none of the first org's facts.
    const secondOrgListing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac01-list-second"),
      harness.secondOrganizationScopeId,
    );
    expect(secondOrgListing).toHaveLength(0);
  });
});
