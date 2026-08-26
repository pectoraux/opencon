/**
 * NET-W006-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, no downstream economic/reputation/settlement behavior
 * is introduced, and the outcomes domain remains provider-independent
 * (core + self + the neutral measurement port only).
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

describe("NET-W006-AC-08 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W006 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen documents still declare the measurement authority
    // rules NET-W006 implements (§13 measurement architecture;
    // architecture-lock §14.25 measurement adapters provide facts) —
    // the implementation BINDS to the frozen architecture, it does not
    // extend it.
    expect(arch).toContain("All economically material values retain confidence/uncertainty information.");
    expect(lock).toContain("Measurement and payment adapters provide evidence/transaction facts; `/outcomes` and `/settlement` retain semantic authority.");
  });

  test("the NET-W006 work order exists and binds to frozen Architecture v1.0", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W006.md"), "utf8");
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN)");
    expect(workOrder).toContain("NET-W006-AC-01..08");
    expect(workOrder).toContain("OUT-001..005");
    expect(workOrder).toContain("measurement ≠ economic truth");
  });

  test("the outcomes domain is non-skeletal (module readiness references NET-W006)", async () => {
    const mod = await import("../../src/outcomes/module.ts");
    const outcomesModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(outcomesModule.tier).toBe("domain");
    expect(outcomesModule.describe?.() ?? "").toMatch(/NET-W006/);
    expect(outcomesModule.describe?.() ?? "").not.toMatch(/skeleton/i);
  });

  test("the outcomes domain introduces NO forbidden economic-material patterns", async () => {
    // NET-W006 establishes facts/estimates and their uncertainty —
    // NO credit issuance, settlement, reputation mutation, campaign
    // delivery, benefit allocation, ad pricing, or cash payout. The
    // key rule: measurement ≠ economic truth.
    const forbidden: RegExp[] = [
      /issueCredit/i,
      /mintCredit/i,
      /settleAmount/i,
      /mutateReputation/i,
      /allocateBenefit/i,
      /deliverCampaign/i,
      /issueReward/i,
      /priceAdvertising/i,
      /optimizeBid/i,
      /\bcash(?:Settlement|Payout)\b/i,
      /computeReputationScore/i,
      /reputationScore/i,
      /participationCredit/i,
    ];
    const files = await listTsFiles(join(SRC, "outcomes"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(
            `NET-W006 out-of-scope pattern ${pattern} found in ${file}`,
          );
        }
      }
    }
  });

  test("the outcomes domain imports ONLY core + self + the NEUTRAL measurement port", async () => {
    const files = await listTsFiles(join(SRC, "outcomes"));
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
        if (rel !== "outcomes" && rel !== "core" && rel !== "measurement") {
          violations.push(`${file} imports ${spec} (→ ${rel})`);
        }
      }
    }
    expect(violations).toEqual([]);
    // The ONLY measurement import is the neutral port (root port.ts) —
    // never a concrete provider under measurement/providers/.
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/from ["']\.\.\/measurement\/providers\//);
    }
  });

  test("the outcomes domain does NOT import provider drivers (pg, ioredis)", async () => {
    const files = await listTsFiles(join(SRC, "outcomes"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/from\s+["'](pg|ioredis)["']/);
    }
  });

  test("no secrets or credentials are committed in the NET-W006 domain files", async () => {
    const files = await listTsFiles(join(SRC, "outcomes"));
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

  test("the workflows boundary owns the measured-outcome transition table (SOLE lifecycle authority)", async () => {
    const table = await readFile(join(SRC, "workflows/transition-table.ts"), "utf8");
    expect(table).toContain("OUTCOME_MEASUREMENT_TRANSITION_TABLE");
    // The outcomes domain does NOT declare its own transition table
    // (it validates preconditions; /workflows owns the rules).
    const files = await listTsFiles(join(SRC, "outcomes"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/TRANSITION_TABLE\s*[:=]/);
    }
  });

  test("the measurement boundary carries the provider-neutral adapter contract (NET-W022 plugs in here)", async () => {
    const port = await readFile(join(SRC, "measurement/port.ts"), "utf8");
    expect(port).toContain("MeasurementProviderAdapter");
    expect(port).toContain("ProviderObservationReport");
    // The concrete reference adapter stays behind providers/.
    expect(existsSync(join(SRC, "measurement/providers/echo-measurement-provider.ts"))).toBe(true);
    // The neutral port does NOT import a concrete provider (only
    // COMMENT references to the providers/ directory are allowed).
    expect(port).not.toMatch(/from\s+["']\.+\/measurement\/providers\//);
  });

  test("the shared measurement vocabulary lives in core (importable by later domains)", async () => {
    const core = await readFile(join(SRC, "core/measurement.ts"), "utf8");
    expect(core).toContain("ATTRIBUTION_MODES");
    expect(core).toContain("MeasurementProvenance");
    expect(core).toContain("MATURATION_STRATEGIES");
    expect(core).toContain("ROLLUP_STRATEGIES");
    expect(core).toContain("MEASUREMENT_EXPERIMENT_STATUSES");
    expect(core).toContain("BASELINE_KINDS");
    expect(core).toContain("CAUSAL_STATUSES");
    // The core barrel re-exports it.
    const barrel = await readFile(join(SRC, "core/index.ts"), "utf8");
    expect(barrel).toContain("measurement.ts");
  });

  test("the measured-outcome transition matrix artifact + evidence document exist", async () => {
    const matrixPath = join(REPO, "docs/net-w006-measured-outcome-transition-matrix.md");
    const evidencePath = join(REPO, "docs/net-w006-outcomes-measurement.md");
    expect(existsSync(matrixPath)).toBe(true);
    expect(existsSync(evidencePath)).toBe(true);
    const matrix = await readFile(matrixPath, "utf8");
    expect(matrix).toContain("DRAFT");
    expect(matrix).toContain("MEASURING");
    expect(matrix).toContain("VERIFIED");
    expect(matrix).toContain("CANCELLED");
    // The matrix documents the NO silent-finalization edge.
    expect(matrix).toContain("DRAFT → VERIFIED");
  });

  test("docs directory: the NET-W006 evidence document maps every acceptance criterion", async () => {
    const evidence = await readFile(join(REPO, "docs/net-w006-outcomes-measurement.md"), "utf8");
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

  test("settlement/reputation domains remain skeletal (NET-W006 introduces NO economic authority)", async () => {
    // NET-W006's key rule: measurement ≠ economic truth. The
    // economic domains are untouched by this work item.
    for (const dir of ["settlement", "reputation"]) {
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      expect(moduleExport.describe?.() ?? "").toMatch(/skeleton/i);
    }
  });
});
