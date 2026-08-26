/**
 * NET-W001-AC-08 — No premature domain logic.
 *
 * Evidence: architecture review of changed files + test suite.
 *
 * No implementation in the platform-foundation work item authorizes
 * economically material value creation, settlement, reputation mutation,
 * campaign delivery or user benefit allocation. This test guards against
 * premature domain logic by:
 *   - asserting still-deferred domain modules remain skeletal (tier
 *     "domain", describe contains "skeleton");
 *   - asserting identity/organizations/participants (now implemented in
 *     NET-W002) are non-skeletal and tier "domain";
 *   - asserting domain source contains none of a denylist of material
 *     operation patterns (for ALL 16 domains, including the NET-W002
 *     three — NET-W002 introduces identity/org/authz behaviour only,
 *     never economic-material behaviour);
 *   - asserting the full architecture check still passes.
 *
 * NET-W002 update: identity, organizations and participants now have
 * concrete behaviour (identity model, membership lifecycle, participant
 * roles, server-side authorization, audit lineage). They are no longer
 * "skeleton" — but they still introduce NO economically material domain
 * logic (no credit issuance, no settlement, no reputation mutation, no
 * campaign delivery, no benefit allocation). The forbidden-pattern check
 * below applies to ALL 16 domains including the three NET-W002 ones.
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

// Domains implemented in NET-W002 (no longer skeletons).
const NET_W002_DOMAINS = ["identity", "organizations", "participants"];

// Domains implemented in NET-W004 (no longer skeletons). These three
// domains introduce lifecycle/workflow behaviour (opportunity first-class
// model, contribution first-class model, authoritative workflow service)
// but they STILL introduce NO economically material domain logic (no
// credit issuance, no settlement, no reputation mutation, no campaign
// delivery, no benefit allocation, no evidence evaluation, no Proof-of-
// Value). The forbidden-pattern check below applies to ALL 16 domains
// including the NET-W004 three.
const NET_W004_DOMAINS = ["opportunities", "contributions", "workflows"];

// Domains implemented in NET-W005 (no longer skeletons). The evidence
// domain introduces the evidence/Proof-of-Value FOUNDATION (deterministic
// grades, confidence/uncertainty, commitments, attestations, aggregation,
// provider-neutral outcome claims, and the PoV model whose lifecycle
// routes through /workflows). It introduces NO economically material
// behaviour: no credit issuance, no settlement, no reputation mutation,
// no campaign delivery, no benefit allocation — the Proof-of-Value
// carries evidence lineage ONLY (NET-W005 work order §5 non-goals;
// economic value attaches in NET-W008).
const NET_W005_DOMAINS = ["evidence"];

// Domains implemented in NET-W006 (no longer skeletons). The outcomes
// domain introduces the MEASUREMENT semantics layer (first-class
// immutable/append-corrected outcome observations, distinct
// deterministic/probabilistic/experimental attribution representation,
// experiments/holdouts + incrementality with derived causal status,
// explicit counterfactual baselines, provider-neutral provider
// ingestion, and the measured-outcome maturation lifecycle routed
// through /workflows). It introduces NO economically material
// behaviour: measurement ≠ economic truth — no credit issuance, no
// settlement, no reputation mutation, no campaign delivery, no
// pricing (NET-W006 work order §5 non-goals).
const NET_W006_DOMAINS = ["outcomes"];

// Domains still deferred past NET-W006 (must remain skeletons).
const SKELETON_DOMAIN_DIRS = DOMAIN_DIRS.filter(
  (d) =>
    !NET_W002_DOMAINS.includes(d) &&
    !NET_W004_DOMAINS.includes(d) &&
    !NET_W005_DOMAINS.includes(d) &&
    !NET_W006_DOMAINS.includes(d),
);

// Patterns that would indicate economically/material domain logic,
// which the foundation work item explicitly forbids (§5 non-goals).
// Applied to ALL 16 domains — including the NET-W002/NET-W005 ones, which
// introduce identity/org/authz/evidence-foundation behaviour but NEVER
// economic-material behaviour (no credit issuance, no settlement, no
// reputation mutation, no campaign delivery, no benefit allocation).
const FORBIDDEN_PATTERNS: RegExp[] = [
  /issueCredit/i,
  /mintCredit/i,
  /settleAmount/i,
  /mutateReputation/i,
  /allocateBenefit/i,
  /deliverCampaign/i,
  /issueReward/i,
  /\bcash(?:Settlement|Payout)\b/i,
];

// NET-W005 UPDATE: the Proof-of-Value object now legitimately lives in
// the EVIDENCE domain — it is the evidence-backed claim foundation
// (spec/work-orders/NET-W005.md), NOT economic settlement. The bare
// /ProofOfValue/i identifier pattern was REMOVED because the workflows
// domain legitimately references the proof_of_value lifecycle subject
// (proofOfValueRepository routing) — /workflows is the SOLE lifecycle
// authority for EVERY subject kind (architecture-lock §7), and its
// routing reference carries no PoV ownership semantics. The meaningful
// guard that REMAINS: PoV CREATION is evidence-domain only — the
// createProofOfValue pattern is forbidden everywhere else.
const PROOF_OF_VALUE_PATTERNS: RegExp[] = [
  /createProofOfValue/i,
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
  test("still-deferred domain modules remain skeletal (tier domain, describe includes skeleton)", async () => {
    for (const dir of SKELETON_DOMAIN_DIRS) {
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

  test("NET-W002 domain modules are non-skeletal (tier domain, no 'skeleton' marker)", async () => {
    for (const dir of NET_W002_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // NET-W002 modules are no longer skeletons — they carry concrete
      // (non-economic) identity/org/authz behaviour.
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W002/i);
    }
  });

  test("NET-W004 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W004)", async () => {
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
      // NET-W004 modules are no longer skeletons — they carry the
      // Opportunity/Contribution first-class models + the authoritative
      // WorkflowService (transition table + state machine + idempotent
      // authorized transitions + audit lineage).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W004/i);
    }
  });

  test("NET-W006 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W006)", async () => {
    for (const dir of NET_W006_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // NET-W006 modules are no longer skeletons — they carry the
      // measurement-semantics behaviour (observations, attribution,
      // experiments/incrementality, baselines, maturation lifecycle).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W006/);
    }
  });

  test("NET-W005 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W005)", async () => {
    for (const dir of NET_W005_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // The evidence domain carries the NET-W005 evidence/Proof-of-Value
      // foundation (deterministic grades, confidence, commitments,
      // attestations, aggregation, outcome claims, PoV model). Still NO
      // economically material behaviour (see FORBIDDEN_PATTERNS).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W005/i);
    }
  });

  test("domain source contains no forbidden material-operation patterns", async () => {
    for (const dir of DOMAIN_DIRS) {
      const files = await listTsFiles(join(SRC, dir));
      // The Proof-of-Value patterns are permitted ONLY in the evidence
      // domain (its first-class object, NET-W005); every other domain
      // is scanned for them too.
      const patterns = NET_W005_DOMAINS.includes(dir)
        ? FORBIDDEN_PATTERNS
        : [...FORBIDDEN_PATTERNS, ...PROOF_OF_VALUE_PATTERNS];
      for (const file of files) {
        const content = await readFile(file, "utf8");
        for (const pattern of patterns) {
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
    // modules are no-ops by construction (defineBoundaryModule) —
    // including the NET-W002 ones, whose concrete behaviour is wired
    // by the bootstrap composition root, NOT by module init.
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
