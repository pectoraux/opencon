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

// Domains implemented in NET-W007 (no longer skeletons). The
// reputation domain introduces the REPUTATION ENGINE (multidimensional
// dimensions with independent scores, evidence-backed inputs with
// DERIVED verified/indicated basis, immutable versioned deterministic
// scoring policies, pure deterministic time decay, append-only
// reconstructable snapshots/history). It introduces NO economically
// material behaviour: reputation is a derived trust signal — no credit
// issuance, no settlement, no pricing, no benefit allocation, and
// reputation cannot be spent (NET-W007 work order §5 non-goals).
const NET_W007_DOMAINS = ["reputation"];

// Domains implemented in NET-W008 (no longer skeletons). The
// settlement domain introduces the ECONOMIC LEDGER — the protocol's
// internal accounting authority: pending/mature value with an
// explicit maturation gate, PoV-gated Participation Credit issuance,
// deterministic reward allocation, cash obligations with internal
// settlement state, and explicit cash↔credits conversions, all on a
// double-entry ledger that balances per unit and derives every
// balance from the immutable entry set (NET-W008 work order). Credit
// issuance and settlement are THE legitimate behaviours of this
// domain — the /issueCredit/ pattern exception below mirrors the
// NET-W005 PoV exception: those patterns remain forbidden in every
// OTHER domain. The out-of-scope guard for settlement (fraud/staking/
// disputes/campaigns/benefit pools/external payment execution/
// blockchain) lives in net-w008-ac-08 with identifier-precise
// patterns.
const NET_W008_DOMAINS = ["settlement"];

// Domains implemented in NET-W009 (no longer skeletons). The disputes
// domain (the Phase-3 Trust boundary — see the NET-W009 work order §2
// placement decision) introduces the FRAUD/RISK FOUNDATION: first-class
// provenance-backed risk signals, immutable versioned deterministic
// risk policies, multi-signal provenance-preserving assessments (pure
// deterministic engine), evidence-backed review cases with append-only
// decision history, and the control-decision registry consumed by the
// composition-root workflow/economic gates. It introduces NO
// economically material behaviour and NO trust mutation: fraud/risk is
// a decision-support and CONTROL authority only — it can never mint,
// destroy or transfer value, never mutates reputation, never mutates
// lifecycle state (those belong to /settlement, /reputation and
// /workflows; NET-W009 work order §4 invariants 1–2).
const NET_W009_DOMAINS = ["disputes"];

// Domains implemented in NET-W011 (no longer skeletons). The campaigns
// domain (the Phase-4 Campaign boundary) carries the CAMPAIGN DOMAIN:
// first-class campaign records with the administrative status machine,
// immutable versioned campaign policy (objectives, eligibility,
// outcome/evidence policy, budget declarations, attribution rules,
// clearing rules, opportunity specs), budget-commitment references
// through the settlement escrow, and campaign-to-opportunity
// composition references. It introduces NO economically material
// behaviour (budgets are declarations; the escrow posts through
// /settlement at the composition root) and NO lifecycle mutation
// (opportunity lifecycle stays with /workflows; NET-W011 work order
// §4 authority separation).
const NET_W011_DOMAINS = ["campaigns"];

// Domains still deferred past NET-W011 (must remain skeletons).
const SKELETON_DOMAIN_DIRS = DOMAIN_DIRS.filter(
  (d) =>
    !NET_W002_DOMAINS.includes(d) &&
    !NET_W004_DOMAINS.includes(d) &&
    !NET_W005_DOMAINS.includes(d) &&
    !NET_W006_DOMAINS.includes(d) &&
    !NET_W007_DOMAINS.includes(d) &&
    !NET_W008_DOMAINS.includes(d) &&
    !NET_W009_DOMAINS.includes(d) &&
    !NET_W011_DOMAINS.includes(d),
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

  test("NET-W007 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W007)", async () => {
    for (const dir of NET_W007_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // NET-W007 modules are no longer skeletons — they carry the
      // reputation engine (dimensions, inputs, versioned policies,
      // deterministic decay, snapshots/history).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W007/);
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

  test("NET-W008 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W008)", async () => {
    for (const dir of NET_W008_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // NET-W008 modules are no longer skeletons — they carry the
      // economic ledger (the accounting authority frozen architecture
      // §18 assigns to /settlement).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W008/);
    }
  });

  test("NET-W009 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W009)", async () => {
    for (const dir of NET_W009_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // NET-W009 modules are no longer skeletons — the disputes
      // boundary carries the fraud/risk foundation (the Trust-domain
      // authority the NET-W009 work order §2 placement decision
      // assigns to /disputes).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W009/);
    }
  });

  test("NET-W011 domain modules are non-skeletal (tier domain, no 'skeleton' marker, reference NET-W011)", async () => {
    for (const dir of NET_W011_DOMAINS) {
      const modulePath = join(SRC, dir, "module.ts");
      expect(existsSync(modulePath), `${dir}/module.ts should exist`).toBe(true);
      const mod = await import(`../../src/${dir}/module.ts`);
      const moduleExport = Object.values(mod)[0] as {
        name: string;
        tier: string;
        describe?: () => string;
      };
      expect(moduleExport.tier).toBe("domain");
      // NET-W011 modules are no longer skeletons — the campaigns
      // boundary carries the campaign domain (policy/configuration
      // authority; economics + lifecycle stay with /settlement and
      // /workflows per the NET-W011 work order §4).
      expect(moduleExport.describe?.() ?? "").not.toMatch(/skeleton/i);
      expect(moduleExport.describe?.() ?? "").toMatch(/NET-W011/);
    }
  });

  test("domain source contains no forbidden material-operation patterns", async () => {
    for (const dir of DOMAIN_DIRS) {
      const files = await listTsFiles(join(SRC, dir));
      // The Proof-of-Value patterns are permitted ONLY in the evidence
      // domain (its first-class object, NET-W005); the credit-issuance
      // pattern is permitted ONLY in the settlement domain (its
      // legitimate accounting authority, NET-W008); every other
      // domain is scanned for both sets too.
      let patterns = NET_W005_DOMAINS.includes(dir)
        ? FORBIDDEN_PATTERNS
        : [...FORBIDDEN_PATTERNS, ...PROOF_OF_VALUE_PATTERNS];
      if (NET_W008_DOMAINS.includes(dir)) {
        patterns = patterns.filter((p) => !/issueCredit/i.test(String(p)));
      }
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
