/**
 * NET-W030 AC-04 — no-economic-bypass containment (issue #61; work
 * order §3.4, §6; architecture-lock §14 invariant 25).
 *
 * An external fact can NEVER create, consume, reverse or mutate
 * internal value records, credits, cash or reward state. The only
 * economic primitives remain the EXISTING /settlement commands:
 * recording facts (matched, pending, mismatched, corrected,
 * replayed, conflicted) posts NO ledger entries, changes NO account
 * balance and mutates NO economic record. Global conservation holds
 * after every fact operation.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createNetW030Harness,
  recordExternalFact,
  buildProviderNotification,
  createInternalLineage,
  actorCtx,
  type NetW030Harness,
} from "./_net-w030-harness.ts";
import { assertGlobalConservation } from "./_net-w008-harness.ts";

interface LedgerSnapshot {
  readonly entryCount: number;
  readonly entriesDigest: string;
  readonly valueRecords: readonly { id: string; state: string; version: number; amount: number }[];
  readonly balances: readonly {
    accountId: string;
    balance: number;
  }[];
}

async function ledgerSnapshot(harness: NetW030Harness): Promise<LedgerSnapshot> {
  const entries = await harness.runtime.postgresAuthority.scan<{
    id: string;
    accountId: string;
    direction: string;
    amount: number;
    unit: string;
  }>("economic_ledger_entries");
  const sorted = [...entries].map((r) => r.value).sort((a, b) => (a.id < b.id ? -1 : 1));
  const digest = sorted
    .map((e) => `${e.id}:${e.accountId}:${e.direction}:${e.amount}:${e.unit}`)
    .join("|");
  const values = await harness.runtime.postgresAuthority.scan<{
    id: string;
    state: string;
    version: number;
    amount: number;
    beneficiaryPersonId: string;
  }>("economic_value_records");
  const valueRecords = [...values]
    .map((r) => r.value)
    .filter((v) => v.beneficiaryPersonId === harness.w008.personId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((v) => ({ id: v.id, state: v.state, version: v.version, amount: v.amount }));
  const balances = await harness.runtime.economicLedgerService.listAccountBalances(
    harness.bootstrapCtx,
    harness.organizationScopeId,
  );
  return {
    entryCount: sorted.length,
    entriesDigest: digest,
    valueRecords,
    balances: balances.map((b) => ({ accountId: b.accountId, balance: b.balance })),
  };
}

describe("NET-W030-AC-04 no-economic-bypass containment", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("recording MATCHED / PENDING / MISMATCHED facts moves NO ledger entry, NO balance, NO economic record", async () => {
    const lineage = await createInternalLineage(harness, 100);
    const before = await ledgerSnapshot(harness);

    const matched = await recordExternalFact(harness, {
      externalId: `ext-bypass-matched-${randomUUID()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 100,
    });
    const pending = await recordExternalFact(harness, {
      externalId: `ext-bypass-pending-${randomUUID()}`,
      internalTransactionId: "no-such-internal-transaction",
      reportedAmount: 55,
    });
    const mismatched = await recordExternalFact(harness, {
      externalId: `ext-bypass-mismatched-${randomUUID()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 40_000,
    });
    const correction = await recordExternalFact(harness, {
      externalId: `ext-bypass-correction-${randomUUID()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 100,
      correctionOf: mismatched.id,
    });
    expect([matched.id, pending.id, mismatched.id, correction.id]).toHaveLength(4);

    const after = await ledgerSnapshot(harness);
    // ZERO economic movement: the identical entry set (count AND
    // content digest), identical balances, identical value records.
    expect(after.entryCount).toBe(before.entryCount);
    expect(after.entriesDigest).toBe(before.entriesDigest);
    expect(after.balances).toEqual(before.balances);
    expect(after.valueRecords).toEqual(before.valueRecords);

    // Global conservation still holds (Σdebit === Σcredit per unit,
    // balances ≥ 0).
    await assertGlobalConservation(harness.w008);
  });

  test("replays and CONFLICTS never mutate economic state either", async () => {
    const lineage = await createInternalLineage(harness, 30);
    const payload = buildProviderNotification(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 30,
    });
    const ctx = actorCtx(harness, "ac04-replay");
    const first = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac04-first",
      },
    );
    expect(first.created).toBe(true);
    // Replay (same key).
    const replay = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        provider: "reference",
        payload,
        idempotencyKey: "ac04-first",
      },
    );
    expect(replay.created).toBe(false);
    // A mismatching fact over the same identity → conflict; nothing
    // mutates (the fact layer holds no economic handle at all).
    await expect(
      recordExternalFact(harness, {
        externalId: payload.externalId as string,
        internalTransactionId: lineage.transactionId,
        reportedAmount: 31,
      }),
    ).rejects.toThrow(/already recorded with a different substance/i);

    await assertGlobalConservation(harness.w008);
    const values = await harness.runtime.economicValueService.listValues(
      actorCtx(harness, "ac04-values"),
      harness.organizationScopeId,
      harness.w008.personId,
    );
    const original = values.find((v) => v.id === lineage.valueRecordId);
    expect(original?.state).toBe("MATURE");
    expect(original?.amount).toBe(30);
  });

  test("the settlement fact layer carries NO economic mutation handle (vocabulary + storage pins)", async () => {
    const fs = await import("node:fs/promises");
    const { join } = await import("node:path");
    const service = await fs.readFile(
      join(import.meta.dir, "../../src/settlement/external-settlement-service.ts"),
      "utf8",
    );
    // The fact layer never calls the economic primitives.
    expect(service).not.toMatch(/\bissueCredits\b/);
    expect(service).not.toMatch(/\ballocateRewards\b/);
    expect(service).not.toMatch(/\brecordCashObligation\b/);
    expect(service).not.toMatch(/\bmatureValue\b/);
    expect(service).not.toMatch(/\breverseValue\b/);
    expect(service).not.toMatch(/postLedgerTransaction\b/);
    const input = await fs.readFile(
      join(import.meta.dir, "../../src/settlement/external-settlement-input.ts"),
      "utf8",
    );
    expect(input).not.toMatch(/\bissueCredits\b/);
    expect(input).not.toMatch(/\ballocateRewards\b/);
    const repo = await fs.readFile(
      join(import.meta.dir, "../../src/settlement/authority-external-settlement-repository.ts"),
      "utf8",
    );
    // The repository is CREATE-ONLY over its own collection — no
    // save/update twin (immutability by construction), no ledger
    // entries, no value records, no accounts.
    expect(repo).toContain('"external_settlement_facts"');
    expect(repo).not.toMatch(/economic_ledger_entries/);
    expect(repo).not.toMatch(/economic_value_records/);
    expect(repo).not.toMatch(/economic_accounts/);
    expect(repo).not.toMatch(/saveWithinTx/);
  });
});
