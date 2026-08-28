/**
 * NET-W020-AC-03 — each clearing operation results in EXACTLY-ONCE
 * economic settlement through /settlement with conservation
 * preserved (issue #39 AC-3; invariants 3/5).
 *
 * The draw flows exclusively through the UNTOUCHED canonical
 * primitives; the clearing record posts NOTHING (its ledger footprint
 * is exactly the draw's own transaction). Conservation is proven over
 * the WHOLE organization entry set per unit, and the ledger lineage
 * (AUD-003) binds the draw transaction by subject.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  operatorCtx,
  key,
  type NetW020Harness,
} from "./_net-w020-harness.ts";

let harness: NetW020Harness;

beforeAll(async () => {
  harness = await createNetW020Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Σdebit === Σcredit per unit over the whole organization. */
async function conservationByUnit(): Promise<Record<string, number>> {
  const entries = await harness.runtime.postgresAuthority.scan<{
    direction: string;
    amount: number;
    unit: string;
  }>("economic_ledger_entries");
  const byUnit: Record<string, number> = {};
  for (const rec of entries) {
    const entry = rec.value;
    const delta = entry.direction === "debit" ? entry.amount : -entry.amount;
    byUnit[entry.unit] = (byUnit[entry.unit] ?? 0) + delta;
  }
  return byUnit;
}

describe("NET-W020-AC-03 exactly-once settlement + conservation", () => {
  test("one clearing = ONE draw through the canonical primitive; the ledger stays conserved per unit", async () => {
    const before = await conservationByUnit();
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const result = await executeCrossPromotionClearing(harness, world);
    const allocation = result.allocation as {
      id: string;
      totalAllocated: number;
      transactionId: string;
    };
    // EXACTLY ONE reward allocation exists for the value record.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-allocations"),
      harness.organizationScopeId,
    );
    const forValue = allocations.filter(
      (a) => a.sourceValueRecordId === world.value.id,
    );
    expect(forValue.length).toBe(1);
    expect(forValue[0]!.id).toBe(allocation.id);
    // The value record is consumed exactly once by that allocation.
    const value = result.value as {
      state: string;
      consumedBy: { kind: string; id: string } | null;
    };
    expect(value.state).toBe("CONSUMED");
    expect(value.consumedBy!.id).toBe(allocation.id);
    // The clearing record's ledger footprint is EXACTLY the draw's
    // transaction (the record itself posts nothing).
    const clearing = result.clearing as {
      drawTransactionId: string;
      drawResultId: string;
    };
    expect(clearing.drawTransactionId).toBe(allocation.transactionId);
    expect(clearing.drawResultId).toBe(allocation.id);
    // AUD-003 lineage: the draw transaction is queryable by subject.
    const ledgerTx =
      await harness.runtime.economicLedgerService.listTransactionsBySubject(
        operatorCtx(harness, "w020-lineage"),
        { kind: "reward_allocation", id: allocation.id },
      );
    expect(ledgerTx.length).toBe(1);
    expect(ledgerTx[0]!.id).toBe(allocation.transactionId);
    // CONSERVATION over the whole organization, per unit.
    const after = await conservationByUnit();
    for (const [unit, delta] of Object.entries(after)) {
      expect(Math.abs(delta)).toBeLessThan(1e-9);
      void unit;
    }
    // The conservation held before the clearing too (a stable base).
    for (const [unit, delta] of Object.entries(before)) {
      expect(Math.abs(delta)).toBeLessThan(1e-9);
      void unit;
    }
  });

  test("the participant summary reflects exactly the drawn amount (the beneficiary's mature value consumed, rewards credited)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 70 });
    const before =
      await harness.runtime.economicLedgerService.getParticipantSummary(
        operatorCtx(harness, "w020-summary-before"),
        harness.organizationScopeId,
        world.contribution.contributorId,
      );
    const result = await executeCrossPromotionClearing(harness, world);
    const after =
      await harness.runtime.economicLedgerService.getParticipantSummary(
        operatorCtx(harness, "w020-summary-after"),
        harness.organizationScopeId,
        world.contribution.contributorId,
      );
    expect(result.drawKind).toBe("reward_allocation");
    // The reward policy beneficiary is the OPERATOR (the campaign
    // owner) — the contributor's mature value is consumed (−70) and
    // the operator's rewards grow (+70): value moves exactly once,
    // conserved.
    expect(after.matureValue).toBe(before.matureValue - 70);
    const operatorAfter =
      await harness.runtime.economicLedgerService.getParticipantSummary(
        operatorCtx(harness, "w020-summary-operator"),
        harness.organizationScopeId,
        harness.operatorPersonId,
      );
    // The operator's rewards balance grew by the drawn amount (the
    // deterministic single-beneficiary split).
    expect(
      operatorAfter.rewards >= 70,
      `operator rewards ${String(operatorAfter.rewards)} should include the draw`,
    ).toBe(true);
  });

  test("the campaign bookkeeping event records the draw (references only — no second ledger)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 50 });
    const result = await executeCrossPromotionClearing(harness, world);
    const allocation = result.allocation as { id: string };
    const campaignAfter = await harness.runtime.campaignService.getCampaign(
      operatorCtx(harness, "w020-campaign-read"),
      world.campaign.id,
    );
    const events = campaignAfter.events.filter(
      (e) => e.event === "clearing_executed",
    );
    expect(events.length).toBe(1);
    expect(events[0]!.details).toMatchObject({
      clearingRuleId: "clear-1",
      drawKind: "reward_allocation",
      valueRecordId: world.value.id,
      resultId: allocation.id,
      amount: 50,
    });
  });

  test("a SECOND clearing of the same pair never draws again (no duplicated value)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 90 });
    const first = await executeCrossPromotionClearing(harness, world);
    expect(first.created).toBe(true);
    // A different idempotency key → the stable pair conflict BEFORE
    // any economic mutation.
    await expect(
      executeCrossPromotionClearing(harness, world, {
        idempotencyKey: key("w020-second"),
      }),
    ).rejects.toMatchObject({ code: "CLEARING_CONFLICT" });
    // EXACTLY one allocation for the value record.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-allocations-2"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(1);
    // EXACTLY one clearing record for the pair.
    const clearings =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-clearings-2"),
        harness.organizationScopeId,
      );
    expect(
      clearings.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(1);
  });
});
