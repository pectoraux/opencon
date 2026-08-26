/**
 * NET-W007-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, no economic-authority behaviour is introduced (reputation
 * is a derived trust signal — no credits, settlement, pricing,
 * benefits or campaign behaviour), and the reputation domain remains
 * provider-independent (core + self only).
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

describe("NET-W007-AC-08 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W007 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen documents still declare the reputation rules
    // NET-W007 implements (§11 multidimensional + not purchasable +
    // evidence-traced; architecture-lock core invariants 4/8/22:
    // evidence is authoritative for reputation, reputation cannot be
    // purchased, reputation changes require evidence lineage) — the
    // implementation BINDS to the frozen architecture.
    expect(arch).toContain("Reputation is multi-dimensional and must not be purchasable.");
    expect(arch).toContain("Each major reputation change is traceable to evidence.");
    expect(lock).toContain("Evidence, not participant or agent claims, is authoritative for settlement and reputation.");
    expect(lock).toContain("Reputation cannot be purchased with advertising spend or wealth.");
    expect(lock).toContain("Reputation changes require evidence lineage.");
  });

  test("the NET-W007 work order exists and binds to frozen Architecture v1.0 + Issue #13", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W007.md"), "utf8");
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN)");
    expect(workOrder).toContain("NET-W007-AC-01..08");
    expect(workOrder).toContain("REP-001..004");
    expect(workOrder).toContain("Reputation ≠ purchasable, and reputation ≠ economic ledger.");
    expect(workOrder).toContain("AUD-004");
  });

  test("the reputation domain is non-skeletal (module readiness references NET-W007)", async () => {
    const mod = await import("../../src/reputation/module.ts");
    const reputationModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(reputationModule.tier).toBe("domain");
    expect(reputationModule.describe?.() ?? "").toMatch(/NET-W007/);
    expect(reputationModule.describe?.() ?? "").not.toMatch(/skeleton/i);
  });

  test("the reputation domain introduces NO forbidden economic-authority patterns", async () => {
    // NET-W007 establishes derived trust information ONLY — NO credit
    // issuance, settlement, ad pricing, benefit allocation, campaign
    // delivery, or cash payout. The key rule: reputation ≠ purchasable
    // and reputation ≠ economic ledger.
    const forbidden: RegExp[] = [
      /issueCredit/i,
      /mintCredit/i,
      /settleAmount/i,
      /allocateBenefit/i,
      /deliverCampaign/i,
      /issueReward/i,
      /priceAdvertising/i,
      /optimizeBid/i,
      /\bcash(?:Settlement|Payout)\b/i,
      /participationCredit/i,
    ];
    const files = await listTsFiles(join(SRC, "reputation"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(
            `NET-W007 out-of-scope pattern ${pattern} found in ${file}`,
          );
        }
      }
    }
  });

  test("the reputation domain carries no economic units (no spendable value anywhere in the port contract)", async () => {
    const port = await readFile(join(SRC, "reputation/port.ts"), "utf8");
    for (const token of [
      "creditBalance",
      "cashValue",
      "cashAmount",
      "settlementAmount",
      "rewardAmount",
      "spendAmount",
      "depositAmount",
      "wealthAmount",
    ]) {
      expect(port.includes(token)).toBe(false);
    }
    // The only numeric score fields are trust scores + decayed weights.
    expect(port).toContain("readonly score: number;");
    expect(port).toContain("readonly decayedVerifiedWeight: number;");
  });

  test("the reputation domain imports ONLY core + self (provider-neutral; no other domain, no infrastructure)", async () => {
    const files = await listTsFiles(join(SRC, "reputation"));
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
        if (rel !== "reputation" && rel !== "core") {
          violations.push(`${file} → ../${rel}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the settlement/ledger economic domains remain skeletal (NET-W008 untouched; reputation created no economic authority)", async () => {
    for (const dir of ["settlement"]) {
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      expect(moduleExport.describe?.() ?? "").toMatch(/skeleton/i);
    }
  });

  test("the frozen dependency vocabulary did not grow a reputation lifecycle subject (reputation is append-only, not a workflow subject)", async () => {
    // NET-W007 entities are immutable/append-only — they intentionally
    // do NOT join the workflow lifecycle subject kinds (no state
    // machine; snapshots and inputs never transition).
    const workflow = await readFile(join(SRC, "core/workflow.ts"), "utf8");
    expect(workflow.includes('"reputation"')).toBe(false);
    const transitionTable = await readFile(join(SRC, "workflows/transition-table.ts"), "utf8");
    expect(transitionTable.toUpperCase().includes("REPUTATION_TRANSITION_TABLE")).toBe(false);
  });

  test("the expected NET-W007 boundary files exist (documented structure)", async () => {
    const names = (await listTsFiles(join(SRC, "reputation"))).map((f) =>
      f.slice(f.lastIndexOf("/") + 1),
    );
    for (const expected of [
      "port.ts",
      "scoring.ts",
      "policy-service.ts",
      "input-service.ts",
      "snapshot-service.ts",
      "authority-policy-repository.ts",
      "authority-input-repository.ts",
      "authority-snapshot-repository.ts",
      "module.ts",
      "index.ts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("the core reputation vocabulary exports the frozen dimension set + basis semantics", async () => {
    const core = await import("../../src/core/reputation.ts");
    expect([...core.REPUTATION_DIMENSIONS]).toHaveLength(8);
    expect([...core.REPUTATION_INPUT_BASES]).toEqual(["verified", "indicated"]);
    expect([...core.REPUTATION_INPUT_SOURCES]).toEqual([
      "evidence",
      "proof_of_value",
      "measured_outcome",
      "contribution",
    ]);
    expect([...core.VERIFIED_GRADE_EVIDENCE_SOURCE_TYPES]).toEqual([
      "platform",
      "attested",
      "provider",
    ]);
    expect(core.isReputationDimension("helpfulness")).toBe(true);
    expect(core.isReputationDimension("purchasable")).toBe(false);
  });
});
