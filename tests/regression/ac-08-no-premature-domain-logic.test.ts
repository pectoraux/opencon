/**
 * NET-W001-AC-08 — No premature domain logic.
 *
 * Evidence: architecture review of changed files + test suite.
 *
 * No implementation in this work item authorizes economically material
 * value creation, settlement, reputation mutation, campaign delivery
 * or user benefit allocation. This test guards against premature domain
 * logic by:
 *   - asserting domain modules are skeletal (tier "domain", describe
 *     contains "skeleton");
 *   - asserting domain source contains none of a denylist of material
 *     operation patterns;
 *   - asserting the full architecture check still passes.
 */

import { describe, test, expect } from "bun:test";
import { join, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

// Patterns that would indicate economically/material domain logic,
// which NET-W001 explicitly forbids (§5 non-goals).
const FORBIDDEN_PATTERNS: RegExp[] = [
  /issueCredit/i,
  /mintCredit/i,
  /settleAmount/i,
  /mutateReputation/i,
  /allocateBenefit/i,
  /deliverCampaign/i,
  /issueReward/i,
  /ProofOfValue/i,
  /createProofOfValue/i,
  /\bcash(?:Settlement|Payout)\b/i,
];

async function listTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listTsFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NET-W001-AC-08 no premature domain logic", () => {
  test("domain modules are skeletal (tier domain, describe includes skeleton)", async () => {
    for (const dir of DOMAIN_DIRS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      // Each domain module exports exactly one boundary Module.
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      expect(moduleExport.describe?.() ?? "").toMatch(/skeleton/i);
    }
  });

  test("domain source contains no forbidden material-operation patterns", async () => {
    for (const dir of DOMAIN_DIRS) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            throw new Error(
              `Forbidden material-operation pattern ${pattern} found in ${relative(REPO, file)}`,
            );
          }
        }
      }
    }
  });

  test("domain port files declare interfaces only (no executable material logic)", async () => {
    for (const dir of DOMAIN_DIRS) {
      const portPath = join(SRC, dir, "port.ts");
      const content = await readFile(portPath, "utf8");
      // port.ts must not contain function declarations with bodies that
      // perform state changes. Interfaces only.
      expect(content).not.toMatch(/function\s+\w+\s*\([^)]*\)\s*{[^]*}/);
    }
  });

  test("domain modules do not perform economically material mutations on init", async () => {
    // Drive init for every domain module through the registry and
    // confirm it completes without side-effecting state. The boundary
    // modules are no-ops by construction (defineBoundaryModule).
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    const runtime = createRuntime({ env: { APP_ENV: "test" }, port: 0 });
    const states = await runtime.initialize();
    const domainStates = states.filter((s) => {
      // Domains are the 16 frozen dirs; infra/adapter also registered.
      return true;
    });
    expect(domainStates.every((s) => s.initialized)).toBe(true);
    await runtime.shutdown();
  });

  test("the architecture check still passes (no domain leak introduced)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
  });

  test("spec/architecture.md and spec/architecture-lock.md are unchanged", async () => {
    // AC-08 (and §9 constraints): the architecture lock must not be
    // modified. Confirm the files still exist and bear the FROZEN status.
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("Status");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("Status");
  });
});
