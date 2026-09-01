/**
 * NET-W030 AC-03 — deterministic reconciliation + machine-readable
 * reasons (issue #61; work order §3.3, §6).
 *
 * The reconciliation verdict over (internal ledger lineage, recorded
 * facts) is a DERIVED, deterministic, server-side computation:
 * matched / pending / mismatched with machine-readable reasons. A
 * mismatch is recorded + audited, never auto-corrected; cross-scope
 * lineage resolves as pending (recorded-yet and cross-tenant are
 * indistinguishable — no existence oracle).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW030Harness,
  recordExternalFact,
  buildProviderNotification,
  createInternalLineage,
  actorCtx,
  auditCount,
  type NetW030Harness,
} from "./_net-w030-harness.ts";

describe("NET-W030-AC-03 deterministic reconciliation", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("MATCHED: the reported amount agrees with the internal lineage's per-unit debit total", async () => {
    const lineage = await createInternalLineage(harness, 250);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 250,
    });
    const view = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-matched-eval"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(view.verdict).toBe("matched");
    expect(view.reason).toBe("amount_matched");
    expect(view.factId).toBe(fact.id);
    expect(view.internalTransaction).not.toBeNull();
    expect(view.internalTransaction?.id).toBe(lineage.transactionId);
    expect(view.internalTransaction?.kind).toBe("value_recognition");
    expect(view.internalTransaction?.unitAmount).toBe(250);
    const checkNames = view.checks.map((c) => c.check);
    expect(checkNames).toContain("internal_lineage_resolved");
    expect(checkNames).toContain("reported_unit_present");
    expect(checkNames).toContain("reported_amount_agrees");
    for (const c of view.checks) {
      expect(c.satisfied).toBe(true);
    }
  });

  test("PENDING: an unresolvable internal lineage stays pending (recorded yet, never an error)", async () => {
    const fact = await recordExternalFact(harness, {
      internalTransactionId: "no-such-internal-transaction",
    });
    const view = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-pending"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(view.verdict).toBe("pending");
    expect(view.reason).toBe("internal_lineage_not_found");
    expect(view.internalTransaction).toBeNull();
    const lineageCheck = view.checks.find((c) => c.check === "internal_lineage_resolved");
    expect(lineageCheck?.satisfied).toBe(false);
    expect(lineageCheck?.reason).toBe("internal_lineage_not_found");
  });

  test("PENDING: a CROSS-SCOPE lineage is indistinguishable from a nonexistent one (no existence oracle)", async () => {
    const lineage = await createInternalLineage(harness);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
    });
    // The SECOND org evaluates a fact whose lineage belongs to the
    // first org — but the fact itself is also invisible to the second
    // org (scoped read). Use the first org's fact id with the second
    // org's scope: NotFoundError (indistinguishable from nonexistent).
    let err: unknown;
    try {
      await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        actorCtx(harness, "ac03-cross-scope"),
        { organizationScopeId: harness.secondOrganizationScopeId, factId: fact.id },
      );
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe("NOT_FOUND");

    // A fact recorded IN the second org referencing the FIRST org's
    // transaction resolves as pending (cross-scope lineage ==
    // not-found for reconciliation — indistinguishable by design).
    const foreignLineageFact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      organizationScopeId: harness.secondOrganizationScopeId,
    });
    const view = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-cross-scope-eval"),
      { organizationScopeId: harness.secondOrganizationScopeId, factId: foreignLineageFact.id },
    );
    expect(view.verdict).toBe("pending");
    expect(view.reason).toBe("internal_lineage_not_found");
  });

  test("MISMATCHED (amount): a disagreeing reported amount is recorded + audited, never auto-corrected", async () => {
    const lineage = await createInternalLineage(harness, 100);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 999,
    });
    const mismatchedObservations = await auditCount(
      harness,
      "external_settlement_fact.mismatch_observed",
    );
    const view = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-mismatch"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(view.verdict).toBe("mismatched");
    expect(view.reason).toBe("amount_mismatched");
    expect(view.internalTransaction?.unitAmount).toBe(100);
    const amountCheck = view.checks.find((c) => c.check === "reported_amount_agrees");
    expect(amountCheck?.satisfied).toBe(false);
    expect(amountCheck?.reason).toBe("amount_mismatched");
    expect(amountCheck?.detail.reportedAmount).toBe(999);
    expect(amountCheck?.detail.lineageUnitAmount).toBe(100);

    // The mismatch observation is AUDITED (recorded + audited — the
    // work order's explicit requirement) ...
    expect(
      await auditCount(harness, "external_settlement_fact.mismatch_observed"),
    ).toBe(mismatchedObservations + 1);
    // ... and NEVER auto-corrected: the fact still reports 999 and the
    // internal lineage still totals 100 (no mutation on either side).
    const stored = await harness.runtime.externalSettlementService.getExternalSettlementFact(
      actorCtx(harness, "ac03-mismatch-read"),
      harness.organizationScopeId,
      fact.id,
    );
    expect(stored?.reportedAmount).toBe(999);
    const internalTx = await harness.runtime.economicLedgerService.getTransaction(
      actorCtx(harness, "ac03-mismatch-tx"),
      lineage.transactionId,
    );
    expect(internalTx.entries.length).toBeGreaterThan(0);
  });

  test("MISMATCHED (unit): a lineage with no entries in the reported unit mismatches with the precise reason", async () => {
    const lineage = await createInternalLineage(harness, 100);
    // The recognition transaction posts in the `value` unit only.
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 100,
      reportedUnit: "cash",
    });
    const view = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-unit"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(view.verdict).toBe("mismatched");
    expect(view.reason).toBe("unit_absent_in_lineage");
    const unitCheck = view.checks.find((c) => c.check === "reported_unit_present");
    expect(unitCheck?.satisfied).toBe(false);
    expect(unitCheck?.reason).toBe("unit_absent_in_lineage");
    expect(unitCheck?.detail.lineageUnits).toContain("value");
  });

  test("DETERMINISM: repeated evaluations derive the identical verdict/reason/checks", async () => {
    const lineage = await createInternalLineage(harness, 80);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 80,
    });
    const first = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-det-1"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    const second = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-det-2"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(second.verdict).toBe(first.verdict);
    expect(second.reason).toBe(first.reason);
    expect(second.internalTransaction).toEqual(first.internalTransaction);
    expect(second.checks).toEqual(first.checks);
    // Repeated MATCHED evaluations append NO mismatch observations.
    const observations = await auditCount(harness, "external_settlement_fact.mismatch_observed");
    await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-det-3"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(await auditCount(harness, "external_settlement_fact.mismatch_observed")).toBe(observations);
  });

  test("the RECORDING audit event carries the in-tx derived verdict (atomic fact + verdict lineage)", async () => {
    const lineage = await createInternalLineage(harness, 60);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 61,
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "external_settlement_fact.recorded",
      resourceId: fact.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata.reconciliationVerdict).toBe("mismatched");
    expect(events[0]?.metadata.reconciliationReason).toBe("amount_mismatched");
    expect(events[0]?.metadata.provider).toBe("reference");
    expect(events[0]?.metadata.externalId).toBe(fact.externalId);
    expect(events[0]?.metadata.internalTransactionId).toBe(lineage.transactionId);
    expect(typeof events[0]?.metadata.transactionId).toBe("string");
    expect(typeof events[0]?.metadata.idempotencyRecordId).toBe("string");
    expect(events[0]?.resourceType).toBe("external_settlement_fact");
  });

  test("the RECORDING result's in-tx derived verdict equals the later evaluation (one derivation discipline)", async () => {
    const lineage = await createInternalLineage(harness, 120);
    const payload = buildProviderNotification(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 120,
    });
    const result = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      actorCtx(harness, "ac03-result"),
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac03-result",
      },
    );
    expect(result.created).toBe(true);
    expect(result.reconciliation.verdict).toBe("matched");
    expect(result.reconciliation.reason).toBe("amount_matched");
    const later = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac03-result-later"),
      { organizationScopeId: harness.organizationScopeId, factId: result.fact.id },
    );
    expect(later.verdict).toBe(result.reconciliation.verdict);
    expect(later.reason).toBe(result.reconciliation.reason);
  });
});
