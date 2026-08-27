/**
 * NET-W008-AC-02 — Pending and mature value are distinct and
 * maturation is explicit/auditable (architecture-lock invariant 19;
 * SETTLE-002 settlement windows).
 *
 *  - a PENDING record cannot be consumed by credit issuance or reward
 *    allocation (pending value is visible as pending accounting state
 *    ONLY);
 *  - maturation is an explicit, authorized, audited state change
 *    (PENDING → MATURE) with balanced postings;
 *  - a `fixed_window` policy matures ONLY once the explicit
 *    effectiveAt reference reaches windowEndAt (no wall clock, no
 *    silent maturation);
 *  - the pending and mature balances are distinct derived accounts;
 *  - double maturation and maturation of non-PENDING records are
 *    rejected.
 *
 * Evidence: domain/integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW008Harness,
  createPendingValue,
  createMatureValue,
  createDefaultRewardPolicy,
  createVerifiedMeasuredOutcome,
  assertGlobalConservation,
  actorCtx,
  AFTER_WINDOW,
  BEFORE_WINDOW,
  WINDOW_END,
  type NetW008Harness,
} from "./_net-w008-harness.ts";

let harness: NetW008Harness;

beforeEach(async () => {
  harness = await createNetW008Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W008-AC-02 pending ≠ mature; explicit maturation", () => {
  test("a PENDING value record cannot be consumed by credit issuance (invariant 19)", async () => {
    const pending = await createPendingValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac02-pending-issue");
    expect(pending.state).toBe("PENDING");
    let err: Error | null = null;
    try {
      await harness.runtime.creditService.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: pending.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac02-pending-issue",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/PENDING — pending value cannot be consumed/);
    expect((err as Error & { code?: string }).code).toBe("ECONOMIC_VALIDATION");
    // No credits were minted and no entry was posted.
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.credits).toBe(0);
    expect(summary.pendingValue).toBe(100);
    await assertGlobalConservation(harness);
  });

  test("a PENDING value record cannot fund a reward allocation", async () => {
    const pending = await createPendingValue(harness, { amount: 100 });
    await createDefaultRewardPolicy(harness);
    const ctx = actorCtx(harness, "ac02-pending-allocate");
    let err: Error | null = null;
    try {
      await harness.runtime.rewardService.allocateRewards(ctx, {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: pending.id,
        policyId: "reward-policy-w008-default",
        idempotencyKey: "ac02-pending-allocate",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(
      /pending value cannot be consumed as mature value/,
    );
  });

  test("maturation is explicit + audited: state, version, postings and audit event all change atomically", async () => {
    const pending = await createPendingValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac02-mature");
    const matured = await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      idempotencyKey: "ac02-mature",
    });
    expect(matured.state).toBe("MATURE");
    expect(matured.version).toBe(pending.version + 1);
    expect(matured.maturedAt).toBeTruthy();
    expect(matured.maturationTransactionId).toBeTruthy();

    // The audit event carries the authoritative transaction lineage.
    const events = await harness.runtime.auditWriter.query({
      eventType: "economic_value.matured",
    });
    const event = events.find((e) => e.resourceId === pending.id);
    expect(event).toBeDefined();
    expect((event!.metadata as Record<string, unknown>).fromState).toBe("PENDING");
    expect((event!.metadata as Record<string, unknown>).toState).toBe("MATURE");
    expect((event!.metadata as Record<string, unknown>).transactionId).toBeTruthy();
    expect((event!.metadata as Record<string, unknown>).ledgerTransactionId).toBe(
      matured.maturationTransactionId,
    );

    // The pending balance moved to the mature balance (distinct accounts).
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.pendingValue).toBe(0);
    expect(summary.matureValue).toBe(100);
    await assertGlobalConservation(harness);
  });

  test("fixed_window maturation is rejected BEFORE the window closes and accepted after (explicit effectiveAt — no wall clock)", async () => {
    const pending = await createPendingValue(harness, {
      amount: 100,
      maturation: { strategy: "fixed_window", windowEndAt: WINDOW_END },
    });
    const ctx = actorCtx(harness, "ac02-window");

    // BEFORE the window: rejected.
    let err: Error | null = null;
    try {
      await harness.runtime.economicValueService.matureValue(ctx, {
        valueRecordId: pending.id,
        effectiveAt: BEFORE_WINDOW,
        idempotencyKey: "ac02-window-before",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/still inside its settlement window/);

    // Missing effectiveAt on a fixed_window policy: rejected.
    err = null;
    try {
      await harness.runtime.economicValueService.matureValue(ctx, {
        valueRecordId: pending.id,
        idempotencyKey: "ac02-window-missing",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/explicit effectiveAt reference timestamp is required/);

    // AFTER the window (exactly at windowEndAt — inclusive): accepted.
    const matured = await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      effectiveAt: AFTER_WINDOW,
      idempotencyKey: "ac02-window-after",
    });
    expect(matured.state).toBe("MATURE");
    await assertGlobalConservation(harness);
  });

  test("double maturation is rejected (each explicit state change applies exactly once)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac02-double-mature");
    let err: Error | null = null;
    try {
      await harness.runtime.economicValueService.matureValue(ctx, {
        valueRecordId: value.id,
        idempotencyKey: "ac02-double-mature",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/is MATURE, not PENDING/);
  });

  test("replaying the SAME maturation idempotency key is a deterministic replay (no double postings)", async () => {
    const pending = await createPendingValue(harness, { amount: 60 });
    const ctx = actorCtx(harness, "ac02-replay-mature");
    const first = await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      idempotencyKey: "ac02-replay-mature-key",
    });
    const second = await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      idempotencyKey: "ac02-replay-mature-key",
    });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);
    // Exactly ONE maturation ledger transaction for the record.
    const transactions = await harness.runtime.economicLedgerService.listTransactionsBySubject(
      harness.bootstrapCtx,
      { kind: "economic_value", id: pending.id },
    );
    expect(transactions.filter((t) => t.kind === "maturation")).toHaveLength(1);
    await assertGlobalConservation(harness);
  });

  test("a value record recognized from a VERIFIED measured outcome matures identically (measurement is a qualifying source)", async () => {
    const measurement = await createVerifiedMeasuredOutcome(harness);
    const ctx = actorCtx(harness, "ac02-measured-source");
    const pendingResult = await harness.runtime.economicValueService.recordPendingValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      amount: 12,
      sources: [{ kind: "measured_outcome", id: measurement.id }],
      idempotencyKey: `ac02-mo-${measurement.id}`,
    });
    expect(pendingResult.value.state).toBe("PENDING");
    const matured = await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pendingResult.value.id,
      idempotencyKey: `ac02-mo-mature-${pendingResult.value.id}`,
    });
    expect(matured.state).toBe("MATURE");
    await assertGlobalConservation(harness);
  });
});
