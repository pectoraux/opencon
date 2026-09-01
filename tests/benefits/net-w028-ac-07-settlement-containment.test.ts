/**
 * NET-W028 AC-07 — /settlement remains the SOLE economic authority:
 * /benefits is an economic allocation ORCHESTRATOR, never a second
 * ledger (issue #56 key invariant 7 + work order §4).
 *
 * Proofs:
 *  - BEHAVIORAL: an entitlement (savings-funded) allocation posts
 *    NOTHING (no draw, no ledger transaction, no balance mutation);
 *    an economic draw posts EXACTLY the /settlement reward split (one
 *    balanced transaction, per-beneficiary rewards-account deltas
 *    equal the settlement shares, the value record consumed
 *    exactly-once by the settlement primitive); the benefit TYPE is
 *    declarative — a "cash"-typed pool still routes the SAME reward
 *    draw and never mints a cash obligation.
 *  - STATIC: no standalone economic primitive exists anywhere in the
 *    /benefits files (no credits/cash/pending-value/maturity/
 *    standalone reward allocation/ledger entries); the economic
 *    vocabularies are unchanged (no benefit value source, no new
 *    account kind); /settlement carries no benefits coupling; the
 *    composition root's ONLY economic join is the existing
 *    `allocateRewardsWithinTx` primitive (work order §3.8 decision
 *    of record).
 *
 * Work order: spec/work-orders/NET-W028.md §4 / §6 AC-07.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW028Harness,
  seedValueFundedPool,
  seedSavingsFundedPool,
  allocateBenefits,
  key,
  type NetW028Harness,
} from "./_net-w028-harness.ts";
import { assertGlobalConservation } from "../../src/settlement/ledger.ts";
import { ECONOMIC_VALUE_SOURCES, ECONOMIC_ACCOUNT_KINDS } from "../../src/core/economics.ts";
import { BENEFIT_TYPES } from "../../src/benefits/port.ts";

const REPO = join(import.meta.dir, "../..");

const W028_FILES = [
  "src/benefits/port.ts",
  "src/benefits/module.ts",
  "src/benefits/allocation-engine.ts",
  "src/benefits/benefit-pool-service.ts",
  "src/benefits/authority-benefit-repositories.ts",
];

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Snapshot the org's account balances as a person→kind→minor map. */
async function balanceSnapshot(): Promise<Map<string, number>> {
  const balances = await harness.runtime.economicLedgerService.listAccountBalances(
    harness.poolCreatorCtx("ac07-balance"),
    harness.organizationScopeId,
  );
  const map = new Map<string, number>();
  for (const b of balances) {
    map.set(
      `${b.ownerPersonId ?? "null"}:${b.kind}`,
      Math.round(b.balance * 1_000_000),
    );
  }
  return map;
}

/** The per-person minor-unit balance DELTA between two snapshots. */
function balanceDelta(
  before: Map<string, number>,
  after: Map<string, number>,
): Map<string, number> {
  const delta = new Map<string, number>();
  for (const [k, v] of after) {
    const b = before.get(k) ?? 0;
    if (v !== b) delta.set(k, v - b);
  }
  for (const [k, v] of before) {
    if (!after.has(k)) delta.set(k, -v);
  }
  return delta;
}

describe("NET-W028-AC-07 settlement-authority containment", () => {
  test("an ENTITLEMENT allocation posts NOTHING: no draw, no ledger transaction, no balance mutation", async () => {
    const scenario = await seedSavingsFundedPool(harness, {
      policyId: "ac07-entitlement",
    });
    const before = await balanceSnapshot();
    const result = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      amount: 25,
    });
    // Entitlement-only: the record carries NO draw (nothing posted).
    expect(result.allocation.draw).toBeNull();
    const after = await balanceSnapshot();
    // NO balance changed — the savings measurement funded an
    // entitlement record, and NO economic state moved anywhere.
    expect(balanceDelta(before, after).size).toBe(0);
    // The savings record itself stays exactly as W027 recorded it
    // (consumed as a verified/derived FACT, never re-calculated).
    const savings = await harness.runtime.procurementSavingsService.listPoolSavings(
      harness.poolCreatorCtx("ac07-savings"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.savings.poolId,
      },
    );
    expect(
      savings.find((s) => s.id === scenario.savings.id)?.savings,
    ).toBe(scenario.savings.savings);
  });

  test("the ECONOMIC DRAW posts EXACTLY the settlement reward split (one balanced transaction; per-beneficiary deltas === shares; the value record consumed exactly-once BY SETTLEMENT)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac07-draw",
    });
    const before = await balanceSnapshot();
    const result = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
    });
    // The draw lineage references the SETTLEMENT reward allocation.
    expect(result.allocation.draw).not.toBeNull();
    const draw = result.allocation.draw!;
    const reward = await harness.runtime.rewardService.getAllocation(
      harness.poolCreatorCtx("ac07-draw"),
      draw.resultId,
    );
    // The settlement primitive's split IS the benefits plan (the
    // mirror-bridge invariant — the two systems agree exactly).
    expect(reward.shares.map((s) => s.beneficiaryPersonId)).toEqual(
      result.allocation.shares.map((s) => s.personId),
    );
    expect(reward.totalAllocated).toBe(result.allocation.totalAllocated);
    // Σ settlement shares === the value record amount at scaled
    // precision, and the transaction is globally conserved.
    const scaledShares = reward.shares.reduce(
      (sum, s) => sum + Math.round(s.amount * 1_000_000),
      0,
    );
    expect(scaledShares).toBe(100_000_000);
    const transaction = await harness.runtime.economicLedgerService.getTransaction(
      harness.poolCreatorCtx("ac07-draw"),
      reward.transactionId,
    );
    expect(() => assertGlobalConservation(transaction.entries)).not.toThrow();
    // The per-beneficiary REWARDS-account deltas equal the settlement
    // shares EXACTLY (minor-unit precision — only /settlement posted).
    const after = await balanceSnapshot();
    const delta = balanceDelta(before, after);
    for (const share of reward.shares) {
      expect(delta.get(`${share.beneficiaryPersonId}:rewards`)).toBe(
        Math.round(share.amount * 1_000_000),
      );
    }
    // Every changed balance is a REWARDS-account delta for a declared
    // member (plus the source-consumption entries) — no credits, no
    // cash, no new account kind was minted by /benefits.
    for (const k of delta.keys()) {
      const kind = k.split(":")[1]!;
      expect(["rewards", "mature_value", "pending_value"]).toContain(kind);
    }
    // The value record is CONSUMED exactly-once — BY the settlement
    // primitive (the W008 backstop, not a benefits-owned mutation).
    const valueAfter = await harness.runtime.economicValueService.getValue(
      harness.poolCreatorCtx("ac07-draw"),
      scenario.value.id,
    );
    expect(valueAfter.state).toBe("CONSUMED");
  });

  test("the benefit TYPE is declarative: a 'cash'-typed pool still routes the SAME settlement reward draw and never mints a cash obligation", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac07-cash-type",
      benefitType: "cash",
    });
    const before = await balanceSnapshot();
    const result = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
    });
    // The economic execution is the settlement reward draw — NOT a
    // cash obligation, NOT a payment instruction (work order §4).
    expect(result.allocation.draw).not.toBeNull();
    const after = await balanceSnapshot();
    const delta = balanceDelta(before, after);
    for (const k of delta.keys()) {
      // No cash_payable/cash_receivable balance was created: the
      // "cash" TYPE is classification, never an execution primitive.
      expect(k.endsWith("cash_payable")).toBe(false);
      expect(k.endsWith("cash_receivable")).toBe(false);
    }
    // And the rewards deltas exist exactly as the settlement split.
    for (const share of result.allocation.shares) {
      expect(delta.get(`${share.personId}:rewards`)).toBe(
        Math.round(share.amount * 1_000_000),
      );
    }
  });

  test("the W028 files carry NO standalone economic primitive (static containment)", async () => {
    for (const rel of W028_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No credits/cash/pending-value/maturity primitives.
      expect(content, `${rel} must not carry issueCredits`).not.toMatch(
        /\bissueCredits\b/,
      );
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\brecordPendingValue\b/);
      expect(content).not.toMatch(/\bmatureValue\b/);
      // No STANDALONE reward allocation/reversal (the only sanctioned
      // join is the composition-root allocateRewardsWithinTx; the
      // word-boundary does not match the WithinTx form).
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\breverseAllocation\b/);
      // No direct settlement-service references and no ledger-entry
      // construction (postings stay exclusively in /settlement).
      expect(content).not.toMatch(/\brewardService\b/);
      expect(content).not.toMatch(/\bcreditService\b/);
      expect(content).not.toMatch(/\bcashService\b/);
      expect(content).not.toMatch(/\bEconomicLedgerEntry\b/);
      expect(content).not.toMatch(/\bappendEntries\b/);
      expect(content).not.toMatch(/\bpostEntries\b/);
    }
  });

  test("the economic vocabularies are UNCHANGED: no benefit value source, no new account kind, no benefits coupling in /settlement", async () => {
    // ECONOMIC_VALUE_SOURCES: the four W008/W014 sources — no
    // benefit/savings source was minted (W028 CONSUMES value, it
    // never creates it).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
    // ECONOMIC_ACCOUNT_KINDS: the eight W008 accounts — no
    // benefits-account/benefit-balance kind exists.
    expect([...ECONOMIC_ACCOUNT_KINDS]).toEqual([
      "pending_value",
      "mature_value",
      "credits",
      "rewards",
      "cash_payable",
      "cash_receivable",
      "protocol_recognition",
      "stake_escrow",
    ]);
    // The benefit types stay DECLARATIVE classification (BEN-001) —
    // six closed kinds, none an execution primitive.
    expect([...BENEFIT_TYPES]).toEqual([
      "credits",
      "cash",
      "discount",
      "service",
      "rebate",
      "inventory",
    ]);
    // /settlement carries NO benefits coupling (its port is
    // untouched by W028 — the dependency flows one way, through the
    // neutral draw port wired at the composition root).
    const settlementPort = await readFile(
      join(REPO, "src/settlement/port.ts"),
      "utf8",
    );
    expect(settlementPort).not.toMatch(/benefitPool|BenefitPool\b/);
    expect(settlementPort).not.toMatch(/benefits/i);
  });

  test("the composition root's ONLY economic join is the settlement WithinTx draw primitive (wiring pin)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The ONE sanctioned economic primitive wired into /benefits:
    // the EXISTING rewardService.allocateRewardsWithinTx on the
    // CALLER'S authoritative transaction (work order §3.8).
    expect(runtime).toContain("allocateRewardsWithinTx");
    // The neutral draw port is wired into the benefits service.
    expect(runtime).toContain("benefitsEconomicDrawPort");
    // NO other settlement service is wired into the benefits
    // service (no creditService/cashService/economicValueService
    // join — funding resolution is read-only through lookups).
    const wiring = runtime.slice(
      runtime.indexOf("createBenefitPoolService("),
      runtime.indexOf("createBenefitPoolService(") + 2000,
    );
    expect(wiring).not.toMatch(/\bcreditService\b/);
    expect(wiring).not.toMatch(/\bcashService\b/);
    expect(wiring).not.toMatch(/\beconomicValueService\b/);
    // The API layer consumes the benefits port only.
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/benefit-pool-service\.ts/);
    expect(apiPort).not.toMatch(/allocation-engine\.ts/);
    expect(apiPort).not.toMatch(/authority-benefit-repositories\.ts/);
    const apiServer = await readFile(
      join(REPO, "src/api/server.ts"),
      "utf8",
    );
    expect(apiServer).not.toMatch(/benefit-pool-service\.ts/);
    expect(apiServer).not.toMatch(/allocation-engine\.ts/);
    expect(apiServer).not.toMatch(/authority-benefit-repositories\.ts/);
  });
});
