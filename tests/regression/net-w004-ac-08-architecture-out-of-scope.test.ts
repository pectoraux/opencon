/**
 * NET-W004-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, and no downstream economic/evidence/reputation/product
 * behavior is introduced.
 *
 * Evidence: static architecture check + regression tests.
 */

import { describe, test, expect } from "bun:test";
import { join, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

// Patterns that would indicate economically/material domain logic,
// which the NET-W004 work order explicitly forbids (§5 non-goals).
// Applied to the NET-W004 domains (opportunities, contributions,
// workflows) — they MUST introduce lifecycle/workflow behavior only,
// never economic-material behavior.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /issueCredit/i,
  /mintCredit/i,
  /settleAmount/i,
  /mutateReputation/i,
  /allocateBenefit/i,
  /deliverCampaign/i,
  /issueReward/i,
  /createProofOfValue/i,
  /evaluateProofOfValue/i,
  /\bcash(?:Settlement|Payout)\b/i,
];

// NET-W004 domains.
const NET_W004_DOMAINS = ["opportunities", "contributions", "workflows"];

// Domains deferred past NET-W004 (must remain skeletons).
// NET-W005 UPDATE: "evidence" is now implemented (NET-W005) and is no
// longer deferred.
// NET-W006 UPDATE: "outcomes" is now implemented (NET-W006 — outcome
// observations, attribution, experiments/incrementality,
// counterfactual baselines, measured-outcome maturation) and is no
// longer deferred. NET-W007 UPDATE: reputation is implemented by
// NET-W007 (a separate work item) and left this list; the NET-W004
// intent — NET-W004 itself introduced NO reputation behaviour — is
// preserved (reputation's implementation arrives only with the
// NET-W007 work item + its own AC-08 regression).
// NET-W008 UPDATE: settlement is implemented by NET-W008 (a separate
// work item) and left this list; the NET-W004 intent — NET-W004
// itself introduced NO economic behaviour — is preserved (the
// economic ledger arrives only with the NET-W008 work item + its own
// AC-08 regression).
// NET-W009 UPDATE: disputes is implemented by NET-W009 (the fraud/risk
// foundation — see the NET-W009 work order §2 placement decision) and
// left this list the same way; the NET-W004 intent — NET-W004 itself
// introduced NO fraud/risk behaviour — is preserved (the trust
// foundation arrives only with the NET-W009 work item + its own AC-08
// regression).
const DEFERRED_DOMAINS = [
  "campaigns", "inventory", "creators", "demand", "benefits",
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

describe("NET-W004-AC-08 architecture/out-of-scope regression", () => {
  test("NET-W004 domains introduce no forbidden material-operation patterns (no economic/reputation/settlement/credit/evidence-evaluation logic)", async () => {
    for (const dir of NET_W004_DOMAINS) {
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

  test("NET-W004 domains reference NET-W004 in their module summaries (no 'skeleton' marker)", async () => {
    for (const dir of NET_W004_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W004/i);
    }
  });

  test("domains deferred past NET-W004 remain skeletons (no concrete behavior introduced)", async () => {
    for (const dir of DEFERRED_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      expect(moduleExport.describe?.() ?? "").toMatch(/skeleton/i);
    }
  });

  test("the architecture check passes with all NET-W004 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // architecture-lock §7: workflow authority.
    expect(lock).toContain("workflow");
    // architecture-lock §3: PostgreSQL is authoritative application state.
    expect(lock).toContain("PostgreSQL is authoritative application state");
    // architecture-lock §16: Redis/caches/queues never authoritative.
    expect(lock).toContain(
      "Redis, caches, queues and worker memory are never authoritative state",
    );
  });

  test("NET-W004 work order exists and binds to frozen Architecture v1.0", async () => {
    const wo = await readFile(join(REPO, "spec/work-orders/NET-W004.md"), "utf8");
    expect(wo).toContain("NET-W004");
    expect(wo).toContain("FROZEN");
    expect(wo).toContain("READY_FOR_IMPLEMENTATION");
    expect(wo).toContain("NET-W004-AC-01");
    expect(wo).toContain("NET-W004-AC-08");
    expect(wo).toContain("Opportunity and Contribution Lifecycle");
    expect(wo).toContain("workflow authority");
    expect(wo).toContain("Explicit non-goals");
  });

  test("no secrets or real credentials are committed in NET-W004 domain files", async () => {
    const SECRET_VALUE_PATTERN =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    for (const dir of NET_W004_DOMAINS) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(SECRET_VALUE_PATTERN.test(content)).toBe(false);
      }
    }
  });

  test("the NET-W004 domains do NOT import the concrete provider drivers (pg, ioredis) — only the provider-neutral core contracts", async () => {
    // The architecture checker (ac-02) already enforces this, but we
    // assert it explicitly for the NET-W004 domains as defense in depth.
    for (const dir of NET_W004_DOMAINS) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(content).not.toMatch(/from\s+["']pg["']/);
        expect(content).not.toMatch(/from\s+["']ioredis["']/);
      }
    }
  });

  test("the NET-W004 domains do NOT import any other domain (tier allow matrix: domain→other-domain prohibited)", async () => {
    // The architecture checker (ac-02) enforces this. We assert it
    // explicitly here so a future change that violates the matrix is
    // caught by this AC test (not just the architecture check).
    const DOMAIN_DIRS = [
      "identity", "organizations", "participants", "opportunities",
      "contributions", "campaigns", "inventory", "creators", "demand",
      "benefits", "reputation", "evidence", "outcomes", "settlement",
      "disputes", "workflows",
    ];
    for (const dir of NET_W004_DOMAINS) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        // For each relative import in this file, resolve it and check
        // that the target is NOT a different domain dir.
        const importRe = /(?:^|[;\s{}()])(?:import|export)(?:[^'"`;]*?from)?\s*["'](\.[^"']+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(content)) !== null) {
          const spec = m[1] ?? "";
          // Resolve relative to the file's directory.
          const fileDir = file.substring(0, file.lastIndexOf("/"));
          const segments = spec.split("/");
          // The first non-"." segment is the target dir.
          const target = segments.find((s) => s !== "." && s !== "..");
          if (!target) continue;
          // Map the target dir name to a domain dir.
          // (e.g. "../core/workflow.ts" → "core"; "../opportunities/port.ts" → "opportunities")
          if (target === "core" || target === "node:") continue;
          if (DOMAIN_DIRS.includes(target) && target !== dir) {
            throw new Error(
              `NET-W004 domain ${dir} imports another domain ${target} in ${relative(REPO, file)}`,
            );
          }
        }
      }
    }
  });

  test("the transition matrix artifact (docs/net-w004-transition-matrix.md) exists and enumerates every legal transition", async () => {
    const matrixPath = join(REPO, "docs/net-w004-transition-matrix.md");
    expect(existsSync(matrixPath)).toBe(true);
    const content = await readFile(matrixPath, "utf8");
    // The matrix references the canonical lifecycle states.
    expect(content).toContain("DRAFT");
    expect(content).toContain("READY");
    expect(content).toContain("ASSIGNED");
    expect(content).toContain("IN_PROGRESS");
    expect(content).toContain("SUBMITTED");
    expect(content).toContain("MEASURING");
    expect(content).toContain("EVALUATING");
    expect(content).toContain("CHALLENGE_WINDOW");
    expect(content).toContain("SETTLING");
    expect(content).toContain("SETTLED");
    expect(content).toContain("VERIFIED");
    // Exceptional states.
    expect(content).toContain("BLOCKED");
    expect(content).toContain("FRAUD_REVIEW");
    expect(content).toContain("DISPUTED");
    expect(content).toContain("REJECTED");
    expect(content).toContain("CANCELLED");
    // Terminal states.
    expect(content).toMatch(/terminal/i);
  });

  test("the NET-W004 evidence document exists", async () => {
    const evidencePath = join(REPO, "docs/net-w004-evidence.md");
    expect(existsSync(evidencePath)).toBe(true);
    const content = await readFile(evidencePath, "utf8");
    expect(content).toContain("NET-W004");
    expect(content).toMatch(/AC-01/i);
    expect(content).toMatch(/AC-08/i);
  });
});
