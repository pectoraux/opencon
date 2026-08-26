/**
 * NET-W008-AC-04 — Cash and Credits remain distinct accounting
 * concepts with explicit conversion/policy entries where applicable
 * (ECON-004; architecture-lock invariant 7).
 *
 *  - credits and cash obligations live in different units on
 *    different account kinds (the participant summary exposes them as
 *    separate balances);
 *  - there is NO implicit conversion path: an issuance mints credits
 *    without touching cash; a payable books cash without touching
 *    credits;
 *  - conversion is an EXPLICIT ledger entry recording BOTH amounts —
 *    the rate is recorded, never assumed 1:1;
 *  - the balance checks enforce that the surrendered side actually
 *    holds the funds (a conversion cannot create either concept);
 *  - conversion reversal restores both balances (conservation).
 *
 * Evidence: domain/integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW008Harness,
  createMatureValue,
  issueDefaultCredits,
  createPayable,
  assertGlobalConservation,
  actorCtx,
  type NetW008Harness,
} from "./_net-w008-harness.ts";

let harness: NetW008Harness;

beforeEach(async () => {
  harness = await createNetW008Harness();
});

afterEach(async () => {
  await harness.teardown();
});

async function summary() {
  return harness.runtime.economicLedgerService.getParticipantSummary(
    harness.bootstrapCtx,
    harness.organizationScopeId,
    harness.personId,
  );
}

describe("NET-W008-AC-04 cash and credits are distinct; conversion is explicit", () => {
  test("credits and cash are separate units on separate account kinds (no silent interchange — ECON-AC-02)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    await issueDefaultCredits(harness, value.id, 2); // 200 credits
    await createPayable(harness, 75); // 75 cash payable

    const s = await summary();
    expect(s.credits).toBe(200);
    expect(s.cashPayable).toBe(75);
    // Credits did NOT become cash payable and vice versa.
    const balances = await harness.runtime.economicLedgerService.listAccountBalances(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    const creditsAccount = balances.find(
      (b) => b.kind === "credits" && b.ownerPersonId === harness.personId,
    );
    const cashAccount = balances.find(
      (b) => b.kind === "cash_payable" && b.ownerPersonId === harness.personId,
    );
    expect(creditsAccount!.unit).toBe("credits");
    expect(cashAccount!.unit).toBe("cash");
    expect(creditsAccount!.balance).toBe(200);
    expect(cashAccount!.balance).toBe(75);
    await assertGlobalConservation(harness);
  });

  test("conversion records BOTH amounts with an explicit recorded rate (never an assumed 1:1)", async () => {
    await createPayable(harness, 100);
    const ctx = actorCtx(harness, "ac04-rate");
    const result = await harness.runtime.conversionService.recordConversion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.personId,
      direction: "cash_to_credits",
      cashAmount: 100,
      creditsAmount: 40, // deliberately NOT 1:1
      idempotencyKey: "ac04-rate",
    });
    expect(result.conversion.rate).toBe(2.5);
    expect(result.conversion.cashAmount).toBe(100);
    expect(result.conversion.creditsAmount).toBe(40);

    const s = await summary();
    expect(s.cashPayable).toBe(0);
    expect(s.credits).toBe(40);
    await assertGlobalConservation(harness);
  });

  test("a conversion cannot create either concept: insufficient cash payable is rejected (conservation)", async () => {
    await createPayable(harness, 10);
    const ctx = actorCtx(harness, "ac04-insufficient");
    let err: Error | null = null;
    try {
      await harness.runtime.conversionService.recordConversion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: harness.personId,
        direction: "cash_to_credits",
        cashAmount: 50,
        creditsAmount: 20,
        idempotencyKey: "ac04-insufficient",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/would overdraw account/);
    expect((err as Error).message).toMatch(/cash_payable/);
    // Nothing changed.
    const s = await summary();
    expect(s.cashPayable).toBe(10);
    expect(s.credits).toBe(0);
    await assertGlobalConservation(harness);
  });

  test("credits_to_cash converts issued credits into a cash payable with balance checks", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    await issueDefaultCredits(harness, value.id, 3); // 300 credits
    const ctx = actorCtx(harness, "ac04-credits-to-cash");

    // Overspending the credits balance is rejected.
    let err: Error | null = null;
    try {
      await harness.runtime.conversionService.recordConversion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: harness.personId,
        direction: "credits_to_cash",
        cashAmount: 500,
        creditsAmount: 400,
        idempotencyKey: "ac04-c2h-overdraft",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/would overdraw account/);

    // A funded conversion succeeds.
    const result = await harness.runtime.conversionService.recordConversion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.personId,
      direction: "credits_to_cash",
      cashAmount: 120,
      creditsAmount: 300,
      idempotencyKey: "ac04-c2h-ok",
    });
    expect(result.conversion.rate).toBe(0.4);
    const s = await summary();
    expect(s.credits).toBe(0);
    expect(s.cashPayable).toBe(120);
    await assertGlobalConservation(harness);
  });

  test("conversion reversal restores both balances and preserves history", async () => {
    await createPayable(harness, 100);
    const ctx = actorCtx(harness, "ac04-reverse");
    const { conversion } = await harness.runtime.conversionService.recordConversion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.personId,
      direction: "cash_to_credits",
      cashAmount: 100,
      creditsAmount: 40,
      idempotencyKey: "ac04-reverse-source",
    });
    let s = await summary();
    expect(s.credits).toBe(40);
    expect(s.cashPayable).toBe(0);

    const reversed = await harness.runtime.conversionService.reverseConversion(ctx, {
      conversionId: conversion.id,
      reason: "wrong direction",
      idempotencyKey: "ac04-reverse",
    });
    expect(reversed.status).toBe("reversed");
    s = await summary();
    expect(s.credits).toBe(0);
    expect(s.cashPayable).toBe(100);
    await assertGlobalConservation(harness);

    // Double reversal is rejected.
    let err: Error | null = null;
    try {
      await harness.runtime.conversionService.reverseConversion(ctx, {
        conversionId: conversion.id,
        reason: "again",
        idempotencyKey: "ac04-reverse-2",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/already reversed/);
  });

  test("cash obligations settle INTERNALLY with balanced postings (external rails are NET-W030)", async () => {
    const payable = await createPayable(harness, 60);
    const ctx = actorCtx(harness, "ac04-settle");
    let s = await summary();
    expect(s.cashPayable).toBe(60);

    const settled = await harness.runtime.cashService.settleCashObligation(ctx, {
      obligationId: payable.id,
      reference: "internal-offset-1",
      idempotencyKey: "ac04-settle",
    });
    expect(settled.status).toBe("settled");
    expect(settled.settlementReference).toBe("internal-offset-1");
    s = await summary();
    expect(s.cashPayable).toBe(0);
    await assertGlobalConservation(harness);

    // Settled obligations cannot settle or reverse again.
    for (const attempt of ["settle", "reverse"]) {
      let err: Error | null = null;
      try {
        if (attempt === "settle") {
          await harness.runtime.cashService.settleCashObligation(ctx, {
            obligationId: payable.id,
            idempotencyKey: `ac04-settle-2`,
          });
        } else {
          await harness.runtime.cashService.reverseCashObligation(ctx, {
            obligationId: payable.id,
            reason: "late reversal",
            idempotencyKey: "ac04-reverse-late",
          });
        }
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect((err as Error).message).toMatch(/is settled, not recognized/);
    }
  });
});
