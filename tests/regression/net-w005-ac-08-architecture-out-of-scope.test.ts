/**
 * NET-W005-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, /outcomes remains skeletal (NET-W006), and no downstream
 * economic/reputation/settlement behavior is introduced by the
 * evidence domain.
 *
 * Evidence: static architecture check + regression tests.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

async function listTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  const { readdir: rd } = await import("node:fs/promises");
  const entries = await rd(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listTsFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NET-W005-AC-08 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W005 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen documents still declare the evidence authority rules
    // NET-W005 implements (§4, §6) — the implementation BINDS to the
    // frozen architecture, it does not extend it.
    expect(lock).toContain("The evidence subsystem owns evidence, evidence provenance, confidence and verification semantics.");
    expect(lock).toContain("Sensitive evidence may remain off-chain/off-platform.");
  });

  test("the NET-W005 work order exists and binds to frozen Architecture v1.0", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W005.md"), "utf8");
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN)");
    expect(workOrder).toContain("NET-W005-AC-01..08");
    expect(workOrder).toContain("EVID-001..006");
  });

  test("the evidence domain is non-skeletal (module readiness references NET-W005)", async () => {
    const mod = await import("../../src/evidence/module.ts");
    const evidenceModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(evidenceModule.tier).toBe("domain");
    expect(evidenceModule.describe?.() ?? "").toMatch(/NET-W005/);
    expect(evidenceModule.describe?.() ?? "").not.toMatch(/skeleton/i);
  });

  test("the /outcomes domain is implemented by NET-W006 (measurement semantics; no longer skeletal)", async () => {
    // NET-W006 BASELINE UPDATE: when NET-W005 merged, /outcomes was a
    // skeleton (measurement semantics deferred to NET-W006). NET-W006
    // has now implemented it. The NET-W005 boundary intent is
    // preserved: the OUTCOME CLAIM vocabulary lives in /evidence
    // (NET-W005), and /outcomes carries only the MEASUREMENT semantics
    // behind those claims — no economic behaviour.
    const mod = await import("../../src/outcomes/module.ts");
    const outcomesModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(outcomesModule.tier).toBe("domain");
    expect(outcomesModule.describe?.() ?? "").not.toMatch(/skeleton/i);
    expect(outcomesModule.describe?.() ?? "").toMatch(/NET-W006/);
    // The outcomes boundary now carries the measurement-semantics
    // source set (observations, attribution, experiments,
    // incrementality, baselines, maturation).
    const files = await listTsFiles(join(SRC, "outcomes"));
    const names = files.map((f) => f.split("/").pop()!).sort();
    for (const expected of [
      "observation-service.ts",
      "attribution-service.ts",
      "experiment-service.ts",
      "incrementality-service.ts",
      "baseline-service.ts",
      "measured-outcome-service.ts",
      "measurement-rollup.ts",
      "port.ts",
      "module.ts",
      "index.ts",
    ]) {
      expect(names).toContain(expected);
    }
    // NET-W005's own boundary is untouched: the evidence domain still
    // owns the outcome CLAIM vocabulary.
    const evidencePort = await readFile(join(SRC, "evidence/port.ts"), "utf8");
    expect(evidencePort).toContain("interface OutcomeClaim");
  });

  test("the evidence domain introduces NO forbidden economic-material patterns", async () => {
    // The NET-W005 evidence/Proof-of-Value FOUNDATION carries evidence
    // lineage only — no credit issuance, settlement, reputation
    // mutation, campaign delivery, benefit allocation, or cash payout.
    const forbidden: RegExp[] = [
      /issueCredit/i,
      /mintCredit/i,
      /settleAmount/i,
      /mutateReputation/i,
      /allocateBenefit/i,
      /deliverCampaign/i,
      /issueReward/i,
      /\bcash(?:Settlement|Payout)\b/i,
      /computeReputationScore/i,
      /reputationScore/i,
    ];
    const files = await listTsFiles(join(SRC, "evidence"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(
            `NET-W005 out-of-scope pattern ${pattern} found in ${file}`,
          );
        }
      }
    }
  });

  test("the evidence domain imports ONLY core + self (no other domain, no infrastructure)", async () => {
    const files = await listTsFiles(join(SRC, "evidence"));
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const importRe = /(?:^|[;\s{}])(?:import|export)(?:[^'"`;]*?from)?\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const spec = m[1] ?? "";
        if (!spec.startsWith(".")) continue;
        // Resolve the relative import to a top-level src directory.
        const resolved = join(file, "..", spec).replace(/\.ts$/, "");
        const rel = resolved.slice(SRC.length + 1).split(/[\\/]/)[0]!;
        if (rel !== "evidence" && rel !== "core") {
          violations.push(`${file} imports ${spec} (→ ${rel})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the evidence domain does NOT import provider drivers (pg, ioredis)", async () => {
    const files = await listTsFiles(join(SRC, "evidence"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/from\s+["'](pg|ioredis)["']/);
    }
  });

  test("no secrets or credentials are committed in the NET-W005 domain files", async () => {
    const files = await listTsFiles(join(SRC, "evidence"));
    const secretPatterns = [
      /(?:password|passwd|api[_-]?key|secret[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of secretPatterns) {
        expect(pattern.test(content)).toBe(false);
      }
    }
  });

  test("the PoV transition matrix artifact + evidence document exist", async () => {
    const matrixPath = join(REPO, "docs/net-w005-pov-transition-matrix.md");
    const evidencePath = join(REPO, "docs/net-w005-evidence.md");
    expect(existsSync(matrixPath)).toBe(true);
    expect(existsSync(evidencePath)).toBe(true);
    const matrix = await readFile(matrixPath, "utf8");
    expect(matrix).toContain("DRAFT");
    expect(matrix).toContain("MEASURING");
    expect(matrix).toContain("EVALUATING");
    expect(matrix).toContain("VERIFIED");
    expect(matrix).toContain("REJECTED");
    expect(matrix).toContain("CANCELLED");
  });

  test("the shared evidence vocabulary lives in core (importable by later domains)", async () => {
    const core = await readFile(join(SRC, "core/evidence.ts"), "utf8");
    expect(core).toContain("STANDARD_OUTCOME_TYPES");
    expect(core).toContain("EVIDENCE_GRADES");
    expect(core).toContain("ConfidenceEstimate");
    expect(core).toContain("ProvenanceRecord");
    expect(core).toContain("EvidenceCommitment");
    // The core barrel re-exports it.
    const barrel = await readFile(join(SRC, "core/index.ts"), "utf8");
    expect(barrel).toContain("evidence.ts");
  });

  test("the workflows boundary owns the PoV transition table (SOLE lifecycle authority)", async () => {
    const table = await readFile(join(SRC, "workflows/transition-table.ts"), "utf8");
    expect(table).toContain("PROOF_OF_VALUE_TRANSITION_TABLE");
    // The evidence domain does NOT declare its own transition table
    // (it validates preconditions; /workflows owns the rules).
    const evidenceFiles = await listTsFiles(join(SRC, "evidence"));
    for (const file of evidenceFiles) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/TRANSITION_TABLE\s*[:=]/);
    }
  });

  test("docs directory: the NET-W005 evidence document maps every acceptance criterion", async () => {
    const evidence = await readFile(join(REPO, "docs/net-w005-evidence.md"), "utf8");
    for (const ac of [
      "AC-01",
      "AC-02",
      "AC-03",
      "AC-04",
      "AC-05",
      "AC-06",
      "AC-07",
      "AC-08",
    ]) {
      expect(evidence).toContain(ac);
    }
  });
});
