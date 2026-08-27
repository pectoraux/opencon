/**
 * NET-W008-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, the settlement domain carries NO out-of-scope behaviour
 * (no fraud scoring, staking/challenges/disputes, campaign economics,
 * benefit pools, external payment execution or blockchain semantics —
 * those belong to NET-W009/010/011+/028/030), the neutral /payments
 * port stays skeletal and untouched (invariant 25), and the
 * settlement domain remains provider-independent (core + self only).
 *
 * Evidence: static architecture check + regression tests.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

async function listTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listTsFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NET-W008-AC-08 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W008 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen documents still declare the economic rules NET-W008
    // implements (lock §1 core invariants 3/4/7, §5 economic
    // authority, §13 economic safety invariants 19–21, §14 invariant
    // 25) — the implementation BINDS to the frozen architecture.
    expect(lock).toContain("No economically material reward may be created from raw activity alone.");
    expect(lock).toContain("Evidence, not participant or agent claims, is authoritative for settlement and reputation.");
    expect(lock).toContain("Participation Credits are distinct from cash settlement and are not inherently speculative assets.");
    expect(lock).toContain("Credit issuance must reference verified value.");
    expect(lock).toContain("Pending value is not equivalent to mature value.");
    expect(lock).toContain("Participation Credit issuance requires a Proof-of-Value reference.");
    expect(lock).toContain("Measurement and payment adapters provide evidence/transaction facts; `/outcomes` and `/settlement` retain semantic authority.");
    expect(lock).toContain("A disputed or fraud-held claim cannot mature until the applicable resolution policy permits it.");
  });

  test("the NET-W008 work order exists and binds to frozen Architecture v1.0 + Issue #15", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W008.md"), "utf8");
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN)");
    expect(workOrder).toContain("NET-W008-AC-01..08");
    expect(workOrder).toContain("ECON-001..005");
    expect(workOrder).toContain("SETTLE-001..003");
    expect(workOrder).toContain("AUD-003");
    expect(workOrder).toContain("No unverified issuance; pending ≠ mature; conservation.");
  });

  test("the settlement domain is non-skeletal (module readiness references NET-W008)", async () => {
    const mod = await import("../../src/settlement/module.ts");
    const settlementModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(settlementModule.tier).toBe("domain");
    expect(settlementModule.describe?.() ?? "").toMatch(/NET-W008/);
    expect(settlementModule.describe?.() ?? "").not.toMatch(/skeleton/i);
  });

  test("the settlement domain introduces NO out-of-scope economic patterns (fraud/staking/disputes/campaigns/benefit pools/external payments/blockchain)", async () => {
    // NET-W008 owns the internal accounting authority ONLY. Fraud
    // scoring + holds (NET-W009), staking/challenges/disputes
    // (NET-W010), campaign economics (NET-W011+), benefit pools
    // (NET-W028), EXTERNAL payment execution (NET-W030) and
    // blockchain/decentralized validation (NET-W029+) are out of
    // scope — the non-goals are mechanically asserted against
    // CODE IDENTIFIERS (the docs legitimately name the deferred work
    // items; the guard is that no such BEHAVIOUR exists).
    const forbidden: RegExp[] = [
      /\bfraudScore/i,
      /\briskSignal/i,
      /\bstakeAmount/i,
      /\bbondStake/i,
      /\bchallengeWindow/i,
      /\bdisputeState/i,
      /\bdisputeLifecycle/i,
      /\bcampaignBudget/i,
      /\bbenefitPool/i,
      /\bexecutePayout/i,
      /\bpayoutExecution/i,
      /\bpaymentProviderId/i,
      /\bblockchainCommit/i,
      /\bonchainAnchor/i,
      /\bweb3Provider/i,
      /\brequirePaymentProvider/i,
      /\bstripePayment/i,
      /\bpaypalTransfer/i,
    ];
    const files = await listTsFiles(join(SRC, "settlement"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(
            `NET-W008 out-of-scope pattern ${pattern} found in ${file}`,
          );
        }
      }
    }
  });

  test("the neutral /payments port remains skeletal and the settlement domain does NOT import it (invariant 25)", async () => {
    const paymentsPort = await readFile(join(SRC, "payments/port.ts"), "utf8");
    expect(paymentsPort).toContain('readiness: "skeleton"');
    const files = await listTsFiles(join(SRC, "settlement"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(
        content.includes("../payments/"),
        `${file} must not import the payments boundary (NET-W030)`,
      ).toBe(false);
      expect(
        content.includes("../ledger/"),
        `${file} must not import the ledger boundary (NET-W030)`,
      ).toBe(false);
    }
  });

  test("the settlement domain imports ONLY core + self (provider-neutral; no other domain, no infrastructure)", async () => {
    const files = await listTsFiles(join(SRC, "settlement"));
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const importRe = /(?:^|[;\s{}()])(?:import|export)(?:[^'"`;]*?from)?\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const spec = m[1] ?? "";
        if (!spec.startsWith(".")) continue;
        const resolved = join(file, "..", spec).replace(/\.ts$/, "");
        const rel = resolved.slice(SRC.length + 1).split(/[\\/]/)[0]!;
        if (rel !== "settlement" && rel !== "core") {
          violations.push(`${file} → ../${rel}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the settlement domain carries no mutable balance counters (balances derive from the immutable entry set)", async () => {
    const port = await readFile(join(SRC, "settlement/port.ts"), "utf8");
    // The read-only views may expose DERIVED balance fields; the guard
    // is that no entity carries a MUTABLE stored balance — every
    // mutation of value happens through append-only ledger entries.
    for (const token of [
      "currentBalance",
      "setBalance",
      "adjustBalance",
      "incrementBalance",
      "balanceVersion",
      "updateBalance",
    ]) {
      expect(port.includes(token)).toBe(false);
    }
    // The participant summary is explicitly a DERIVED projection.
    expect(port).toContain("balances derived from entries");
  });

  test("the frozen lifecycle vocabulary did not grow an economic subject (ledger commands are accounting operations, not workflow subjects)", async () => {
    // NET-W008 entities are accounting records with explicit audited
    // commands (each atomic, idempotent and conservation-checked) —
    // they intentionally do NOT join the workflow lifecycle subject
    // kinds (no canonical multi-step lifecycle; the qualifying VERIFIED
    // state is produced upstream by the PoV lifecycle NET-W005 owns).
    const workflow = await readFile(join(SRC, "core/workflow.ts"), "utf8");
    expect(workflow.includes('"economic_value"')).toBe(false);
    expect(workflow.includes('"credit_issuance"')).toBe(false);
    expect(workflow.includes('"settlement"')).toBe(false);
    const transitionTable = await readFile(join(SRC, "workflows/transition-table.ts"), "utf8");
    expect(transitionTable.toUpperCase().includes("ECONOMIC_TRANSITION_TABLE")).toBe(false);
    expect(transitionTable.toUpperCase().includes("SETTLEMENT_TRANSITION_TABLE")).toBe(false);
  });

  test("the expected NET-W008 boundary files exist (documented structure)", async () => {
    const names = (await listTsFiles(join(SRC, "settlement"))).map((f) =>
      f.slice(f.lastIndexOf("/") + 1),
    );
    for (const expected of [
      "port.ts",
      "ledger.ts",
      "posting.ts",
      "value-service.ts",
      "credit-service.ts",
      "reward-service.ts",
      "cash-service.ts",
      "conversion-service.ts",
      "ledger-service.ts",
      "authority-ledger-repository.ts",
      "authority-value-repository.ts",
      "authority-credit-repository.ts",
      "authority-reward-policy-repository.ts",
      "authority-reward-repository.ts",
      "authority-cash-repository.ts",
      "authority-conversion-repository.ts",
      "module.ts",
      "index.ts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("the core economic vocabulary exports the frozen unit/source/state sets", async () => {
    const core = await import("../../src/core/economics.ts");
    expect([...core.ECONOMIC_UNIT_TYPES]).toEqual(["value", "credits", "cash"]);
    expect([...core.ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
    ]);
    expect([...core.QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES]).toEqual([
      "platform",
      "attested",
      "provider",
    ]);
    expect([...core.ECONOMIC_VALUE_STATES]).toEqual([
      "PENDING",
      "MATURE",
      "CONSUMED",
      "REVERSED",
    ]);
    expect([...core.ECONOMIC_MATURATION_STRATEGIES]).toEqual([
      "immediate",
      "fixed_window",
    ]);
    expect([...core.ECONOMIC_ACCOUNT_KINDS]).toEqual([
      "pending_value",
      "mature_value",
      "credits",
      "rewards",
      "cash_payable",
      "cash_receivable",
      "protocol_recognition",
    ]);
    expect(core.economicAccountNormalSide("protocol_recognition")).toBe("debit");
    expect(core.economicAccountNormalSide("credits")).toBe("credit");
    expect(core.isEconomicValueSourceKind("advertising_spend")).toBe(false);
    expect(core.isEconomicValueSourceKind("reputation")).toBe(false);
  });

  test("no other domain gained economic authority: the reputation domain still carries no credit/settlement channel", async () => {
    // NET-W007's non-purchasable contract remains intact — reputation
    // still has NO economic units and no credit issuance path; the
    // economic authority lives ONLY in /settlement (architecture-lock
    // §5).
    const reputationPort = await readFile(join(SRC, "reputation/port.ts"), "utf8");
    for (const token of [
      "creditBalance",
      "cashValue",
      "settlementAmount",
      "rewardAmount",
      "issueCredits",
    ]) {
      expect(reputationPort.includes(token)).toBe(false);
    }
    const evidencePort = await readFile(join(SRC, "evidence/port.ts"), "utf8");
    expect(evidencePort.includes("issueCredits")).toBe(false);
    expect(evidencePort).toContain("the PoV carries NO economic value");
  });
});
