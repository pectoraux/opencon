/**
 * NET-W009-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, the disputes domain (the Phase-3 Trust boundary — see the
 * NET-W009 work order §2 placement decision) carries NO out-of-scope
 * behaviour (no economic mutation — it cannot mint/destroy/transfer
 * value or credits; no reputation mutation; no provider-specific
 * fraud SDK semantics; no decentralized fraud consensus; the
 * challenge/dispute/staking lifecycle is NET-W010 — asserted by the
 * net-w010-ac-08 regression), the gates stay at the composition root
 * (the risk domain never imports /workflows or /settlement), and the
 * domain remains provider-independent (core + self only).
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

describe("NET-W009-AC-08 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W009 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen documents still declare the fraud/risk rules NET-W009
    // implements or binds to: architecture §12 (no single signal is
    // authoritative), §19 (AI/model output is never sufficient by
    // itself), lock §2 (the frozen sixteen-domain list — the
    // placement decision adds NO seventeenth domain), §4/§5 (model
    // output is input evidence, never authoritative), §13 invariant 21
    // (a disputed or fraud-held claim cannot mature).
    expect(arch).toContain("No single signal is authoritative.");
    expect(arch).toContain(
      "AI/model output is never sufficient by itself to authorize settlement, reputation, or governance state.",
    );
    expect(lock).toContain("Agent/model output is input evidence or a recommendation; it does not directly authorize settlement.");
    expect(lock).toContain("A disputed or fraud-held claim cannot mature until the applicable resolution policy permits it.");
    // The frozen 16-domain list is intact — /disputes is IN it; there
    // is no /risk or /fraud domain.
    expect(lock).toContain("- `/disputes`");
    expect(lock).not.toContain("- `/risk`");
    expect(lock).not.toContain("- `/fraud`");
  });

  test("the NET-W009 work order exists and binds to frozen Architecture v1.0 + Issue #17", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W009.md"), "utf8");
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN");
    expect(workOrder).toContain("NET-W009-AC-01..08");
    expect(workOrder).toContain("FRAUD-001..005");
    expect(workOrder).toContain("AUD-005");
    expect(workOrder).toContain("No hidden economic authority");
    expect(workOrder).toContain("Model non-authority");
    expect(workOrder).toContain("Fail-safe controls");
    expect(workOrder).toContain("Boundary placement");
  });

  test("the disputes domain is non-skeletal (module readiness references NET-W009)", async () => {
    const mod = await import("../../src/disputes/module.ts");
    const disputesModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(disputesModule.tier).toBe("domain");
    expect(disputesModule.describe?.() ?? "").toMatch(/NET-W009/);
    expect(disputesModule.describe?.() ?? "").not.toMatch(/skeleton/i);
  });

  test("the disputes domain introduces NO out-of-scope patterns (economic mutation / reputation mutation / provider fraud SDKs / decentralized consensus)", async () => {
    const files = await listTsFiles(join(SRC, "disputes"));
    expect(files.length).toBeGreaterThan(0);
    // Patterns that would indicate hidden economic or reputation
    // authority, or provider/decentralized semantics inside the risk
    // foundation. NET-W010 AMENDMENT: `bondStake` (the audited
    // dispute-side bookkeeping command that VERIFIES the settlement
    // authority's stake record) and `resolveDispute` (the audited
    // merits-resolution command) are now LEGITIMATE /disputes
    // identifiers — the stake COMMANDS (commit/release/forfeit) remain
    // forbidden here (they live in /settlement only; the
    // net-w010-ac-08 regression asserts both sides). The stake
    // POSTING path never enters this boundary.
    const forbidden: RegExp[] = [
      /\bissueCredits?\b/i,
      /\bmintCredit/i,
      /\bmatureValue\b/,
      /\brecordPendingValue\b/,
      /\bsettleCashObligation\b/,
      /\brecordConversion\b/,
      /\ballocateRewards?\b/i,
      /\bmutateReputation\b/i,
      /\brecordReputationInput\b/,
      /\brecordSnapshot\b/,
      /\brequestTransition\b/,
      /\bslashStake\b/i,
      /\bopenChallenge\b/i,
      /\bfrom\s+["']pg["']/,
      /\bfrom\s+["']ioredis["']/,
      /openrtb/i,
      /sellersJson/i,
      /blockchain/i,
      /\bconsensus\b/i,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(
            `Out-of-scope pattern ${pattern} found in ${file.replace(SRC, "src")}`,
          );
        }
      }
    }
  });

  test("the risk domain never imports other domains (the gates live at the composition root; /workflows stays the sole lifecycle authority)", async () => {
    const files = await listTsFiles(join(SRC, "disputes"));
    const domainImport = /from\s+["']\.\.\/(identity|organizations|participants|opportunities|contributions|campaigns|inventory|creators|demand|benefits|reputation|evidence|outcomes|settlement|workflows)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (domainImport.test(content)) {
        throw new Error(
          `Domain-to-domain import found in ${file.replace(SRC, "src")} (the tier matrix + the work order §3.7 require composition-root wiring)`,
        );
      }
    }
  });

  test("the settlement and reputation domains were NOT modified by NET-W009 (invariants 1–2)", async () => {
    // The economic and reputation authorities remain risk-agnostic:
    // no disputes-boundary imports inside their domain sources (the
    // gate wraps their composition-root COMMANDS only — the non-goal
    // "No economic ledger implementation changes (NET-W008)" and
    // invariant 2 "no direct reputation mutation").
    for (const dir of ["settlement", "reputation"]) {
      const files = await listTsFiles(join(SRC, dir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(
          content,
          `${file.replace(SRC, "src")} must not import the disputes boundary`,
        ).not.toMatch(/from\s+["']\.\.\/disputes\//);
      }
    }
  });

  test("the economic gate is wired ONLY at the composition root (runtime), not inside any domain", async () => {
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    expect(runtime).toContain("refuseWhenGated");
    expect(runtime).toContain('"value_maturation"');
    expect(runtime).toContain('"credit_issuance"');
    expect(runtime).toContain('"reward_allocation"');
    expect(runtime).toContain('"cash_settlement"');
    // No domain file performs the gate.
    for (const dir of ["settlement", "disputes"]) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(content).not.toContain("refuseWhenGated");
      }
    }
  });

  test("the workflow hold flows through the workflow service (no hidden lifecycle mutation)", async () => {
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    expect(runtime).toContain("applyWorkflowHold");
    expect(runtime).toContain("workflowService.requestTransition");
    // The disputes domain carries no lifecycle transition calls
    // (already asserted above via /requestTransition/ — this test
    // pins the positive wiring side).
    expect(runtime).toContain("FRAUD_REVIEW");
  });

  test("the core risk vocabulary exports the frozen sets + structural advisory rule", async () => {
    const core = await import("../../src/core/risk.ts");
    expect(core.RISK_SIGNAL_CATEGORIES).toEqual([
      "identity",
      "behavioral",
      "device_integrity",
      "graph",
      "economic_anomaly",
      "velocity",
      "duplicate_pattern",
      "historical_reputation",
      "model_advisory",
    ]);
    expect(core.RISK_STATES).toEqual([
      "CLEAR",
      "WATCH",
      "REVIEW",
      "HOLD",
      "BLOCKED",
    ]);
    expect(core.RISK_OPERATION_CLASSES).toEqual([
      "value_maturation",
      "credit_issuance",
      "reward_allocation",
      "cash_settlement",
      "workflow_transition",
      "participant_eligibility",
    ]);
    expect(core.ADVISORY_PROVENANCE_KINDS).toEqual(["model_output"]);
    expect(core.isAdvisoryProvenanceKind("model_output")).toBe(true);
    expect(core.isAdvisoryProvenanceKind("manual_review")).toBe(false);
    expect(core.RISK_SCORE_DECIMALS).toBe(6);
  });

  test("the expected NET-W009 boundary files exist (documented structure)", async () => {
    for (const file of [
      "src/core/risk.ts",
      "src/disputes/port.ts",
      "src/disputes/risk-engine.ts",
      "src/disputes/signal-service.ts",
      "src/disputes/policy-service.ts",
      "src/disputes/assessment-service.ts",
      "src/disputes/case-service.ts",
      "src/disputes/control-service.ts",
      "src/disputes/source-validation.ts",
      "src/disputes/authority-signal-repository.ts",
      "src/disputes/authority-policy-repository.ts",
      "src/disputes/authority-assessment-repository.ts",
      "src/disputes/authority-case-repository.ts",
      "src/disputes/authority-control-repository.ts",
      "src/disputes/module.ts",
      "src/disputes/README.md",
      "docs/net-w009-fraud-risk.md",
    ]) {
      expect(existsSync(join(REPO, file)), `${file} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W009 domain files", async () => {
    const SECRET_VALUE_PATTERN =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    const files = await listTsFiles(join(SRC, "disputes"));
    files.push(join(SRC, "core/risk.ts"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${file} must be secret-free`).toBe(false);
    }
  });
});
