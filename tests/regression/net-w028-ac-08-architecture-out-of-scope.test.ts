/**
 * NET-W028-AC-08 — architecture/out-of-scope regression (issue #56).
 *
 * NET-W028 ships INSIDE the frozen `/benefits` boundary (NO 17th
 * domain — architecture-lock §2 lists `/benefits` among the sixteen
 * frozen core domains; architecture.md §18 names it "benefit
 * allocation"). `/settlement` remains the SOLE economic authority
 * (the only economic join is the composition-root
 * `allocateRewardsWithinTx` primitive — AC-07 pins the behavior);
 * `/demand` stays the procurement/savings authority (the W027
 * savings are consumed as derived FACTS through a neutral lookup);
 * `/organizations` stays the membership authority (neutral lookup);
 * `/workflows` stays the lifecycle authority (pool closure is a
 * ONE-WAY field mutation, never a transition). No W029+
 * decentralization (portable reputation proofs, consensus) and no
 * W033–W036 end-to-end flows; no external payment execution; no AI
 * authority. The shared-file amendments are scoped exactly to the
 * sanctioned NET-W028 activation (the no-premature NET_W028
 * activation + the NET-W004 deferred-list retirement — benefits was
 * the sixteenth and LAST skeletal v1.0 domain).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  BENEFIT_TYPES,
  BENEFIT_FUNDING_SOURCE_KINDS,
  BENEFIT_ELIGIBILITY_CRITERIA,
  BENEFIT_REMAINDER_DISPOSITIONS,
  BENEFIT_ALLOCATION_POLICY_VERSION,
  BENEFIT_ALLOCATION_METHOD,
  BENEFIT_ALLOCATION_CRITERIA,
  BENEFIT_MAX_FUNDING_REFS,
  BENEFIT_MAX_MEMBERS,
  BENEFIT_POOL_POLICY_RECORD_FORMAT,
  BENEFIT_POOL_RECORD_FORMAT,
  BENEFIT_POOL_ALLOCATION_RECORD_FORMAT,
} from "../../src/benefits/port.ts";
import { ECONOMIC_VALUE_SOURCES } from "../../src/core/economics.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W028_FILES = [
  "src/benefits/port.ts",
  "src/benefits/module.ts",
  "src/benefits/allocation-engine.ts",
  "src/benefits/benefit-pool-service.ts",
  "src/benefits/authority-benefit-repositories.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W028-AC-08 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W028 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(301);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(301);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /benefits stays the single home of benefit allocation)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("| `/demand`, `/benefits` | demand aggregation and benefit allocation |");
    expect(lock).toContain("- `/benefits`");
    // NET-W028 adds NO boundary and NO second allocation authority
    // (Benefit Pools live in the SAME frozen /benefits domain).
    expect(lock).not.toContain("- `/benefit-pools`");
    expect(lock).not.toContain("- `/pools`");
    expect(lock).not.toContain("- `/allocations`");
    expect(lock).not.toContain("- `/rewards-allocation`");
  });

  test("the NET-W028 work order exists and binds to frozen Architecture v1.0 + Issue #56", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W028.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#56");
    expect(workOrder).toContain("Benefit Pools");
    // The authority-separation decision of record.
    expect(workOrder).toContain("sole economic authority");
    expect(workOrder).toContain("settlement");
    expect(workOrder).toContain("conservation");
    expect(workOrder).toContain("deterministic");
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("privacy");
    expect(workOrder).toContain("WithinTx");
    expect(workOrder).toContain("BEN-001..004");
  });

  test("the benefit vocabularies are pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W028 vocabularies (closed, versioned, bounded).
    expect(BENEFIT_POOL_POLICY_RECORD_FORMAT).toBe("NET-W028:1");
    expect(BENEFIT_POOL_RECORD_FORMAT).toBe("NET-W028:1");
    expect(BENEFIT_POOL_ALLOCATION_RECORD_FORMAT).toBe("NET-W028:1");
    expect([...BENEFIT_TYPES]).toEqual([
      "credits",
      "cash",
      "discount",
      "service",
      "rebate",
      "inventory",
    ]);
    expect([...BENEFIT_FUNDING_SOURCE_KINDS]).toEqual([
      "economic_value",
      "verified_savings",
    ]);
    expect([...BENEFIT_ELIGIBILITY_CRITERIA]).toEqual(["active_membership"]);
    expect([...BENEFIT_REMAINDER_DISPOSITIONS]).toEqual([
      "last_member_absorbs",
      "retained_in_pool",
    ]);
    expect(BENEFIT_ALLOCATION_POLICY_VERSION).toBe(1);
    expect(BENEFIT_ALLOCATION_METHOD).toBe("proportional-weights-scaled-floor");
    expect([...BENEFIT_ALLOCATION_CRITERIA]).toEqual([
      "pool_active",
      "policy_version_pinned",
      "funding_qualified",
      "funding_available",
      "members_eligible",
      "draw_policy_consistent",
      "conservation_preserved",
    ]);
    expect(BENEFIT_MAX_FUNDING_REFS).toBe(8);
    expect(BENEFIT_MAX_MEMBERS).toBe(64);
    // The REUSED economic vocabulary is unchanged (no benefit value
    // source was minted — W028 CONSUMES authoritative value, it
    // never creates it).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
  });

  test("BENEFITS STAYS A NON-LIFECYCLE/NON-AI/NON-DECENTRALIZED AUTHORITY: no lifecycle machinery, no AI authority, no W029+/W033+ vocabulary in the NET-W028 files", async () => {
    for (const rel of W028_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: pool closure is a one-way field mutation).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      // No domain imports outside itself/core (tier matrix: domain →
      // core/neutral/self only — the /settlement + /demand +
      // /organizations facts cross through the NEUTRAL lookups
      // declared in the port and wired at the composition root).
      expect(content).not.toMatch(
        /from ["']\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|demand|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
      // No AI authority: no advisory machinery can establish pool
      // funding, eligibility, privacy release or economic authority
      // (issue #56 architectural constraints).
      expect(content).not.toMatch(/\badvisoryRanking\b/);
      expect(content).not.toMatch(/\baiEligibility\b/);
      expect(content).not.toMatch(/\baiSufficiency\b/);
      // No W029+ decentralization vocabulary (portable reputation
      // proofs, consensus/verification nodes).
      expect(content).not.toMatch(/\bportableReputation\b/i);
      expect(content).not.toMatch(/\bconsensusNode\b/i);
      expect(content).not.toMatch(/\bverificationNode\b/i);
      // No external payment execution (W028 orchestrates only).
      expect(content).not.toMatch(/\bpaymentAdapter\b/i);
      expect(content).not.toMatch(/\bexecuteExternalPayment\b/i);
      expect(content).not.toMatch(/\bpaymentInstruction\b/i);
      // No W033–W036 end-to-end flow vocabulary.
      expect(content).not.toMatch(/\bendToEndFlow\b/i);
      // The banned historical identifier stays banned (the sanctioned
      // W028 surface is allocatePoolBenefits — never a bare
      // allocateBenefit primitive).
      expect(content).not.toMatch(/\ballocateBenefit\b/);
    }
  });

  test("BENEFITS CONTAINMENT: the W028 command vocabulary is confined to the /benefits boundary and guarded routes", async () => {
    // The API transport: every benefits surface is guarded.
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    for (const action of [
      "benefits.policy.create",
      "benefits.policy.read",
      "benefits.pool.create",
      "benefits.pool.close",
      "benefits.pool.read",
      "benefits.allocation.evaluate",
      "benefits.allocation.execute",
      "benefits.allocation.read",
      "benefits.member.read",
    ]) {
      expect(apiServer).toContain(`"${action}"`);
    }
    // No other domain carries the W028 command vocabulary (the
    // /benefits boundary owns it exclusively).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "benefits") {
        continue;
      }
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry W028 command vocabulary`,
        ).not.toMatch(/\bcreateBenefitPool\b/);
        expect(content).not.toMatch(/\ballocatePoolBenefits\b/);
        expect(content).not.toMatch(/\bevaluatePoolAllocation\b/);
        expect(content).not.toMatch(/\bBenefitPoolService\b/);
        expect(content).not.toMatch(/\bBenefitPoolRepository\b/);
      }
    }
  });

  test("the economic + lifecycle + procurement + membership authorities are UNTOUCHED by NET-W028", async () => {
    // /settlement: the economic authority port has NO benefits
    // coupling (the dependency flows one way, through the neutral
    // draw port wired at the composition root).
    const settlementPort = await readFile(
      join(REPO, "src/settlement/port.ts"),
      "utf8",
    );
    expect(settlementPort).not.toMatch(/benefitPool|BenefitPool\b/);
    expect(settlementPort).not.toMatch(/benefits/i);
    // /workflows: the lifecycle authority is untouched (pool closure
    // is a one-way field mutation — never a transition).
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/benefitPool|benefits/i);
    // /demand: the procurement/savings authority ports are UNCHANGED
    // by W028 (the savings-funding lookup lives in the /benefits port
    // + the composition root only — W028 consumes W027 as derived
    // facts, never re-implements them; the frozen architecture §18
    // header legitimately names `/demand`, `/benefits` — the W028
    // COMMAND vocabulary must stay absent).
    const demandPort = await readFile(
      join(REPO, "src/demand/port.ts"),
      "utf8",
    );
    expect(demandPort).not.toMatch(/\bcreateBenefitPool\b/);
    expect(demandPort).not.toMatch(/\ballocatePoolBenefits\b/);
    expect(demandPort).not.toMatch(/\bevaluatePoolAllocation\b/);
    expect(demandPort).not.toMatch(/\bBenefitPoolService\b/);
    expect(demandPort).not.toMatch(/\bBenefitPoolRepository\b/);
    expect(demandPort).not.toMatch(/\bBenefitEconomicDrawPort\b/);
    // /organizations: the membership authority gains no benefits
    // surface (the membership gate resolves through the neutral
    // lookup).
    const orgPort = await readFile(
      join(REPO, "src/organizations/port.ts"),
      "utf8",
    );
    expect(orgPort).not.toMatch(/benefitPool|benefits/i);
  });

  test("the composition root is the ONLY join between /benefits and the /settlement + /demand + /organizations authorities (wiring pins)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The benefits service is wired at the root over the authority
    // repositories + the idempotency store + the transactional audit
    // writer.
    expect(runtime).toContain("createBenefitPoolService(");
    expect(runtime).toContain("createAuthorityBenefitPoolPolicyRepository");
    expect(runtime).toContain("createAuthorityBenefitPoolRepository");
    expect(runtime).toContain("createAuthorityBenefitPoolAllocationRepository");
    // The FIVE neutral read-only/economic joins (the
    // dependency-inversion boundary): membership, value-record
    // funding facts, savings re-derivation, reward-policy facts and
    // the WithinTx economic draw.
    expect(runtime).toContain("benefitsMembershipLookup");
    expect(runtime).toContain("benefitsValueFundingLookup");
    expect(runtime).toContain("benefitsSavingsFundingLookup");
    expect(runtime).toContain("benefitsRewardPolicyLookup");
    expect(runtime).toContain("benefitsEconomicDrawPort");
    // The ONLY settlement primitive in the join:
    // rewardService.allocateRewardsWithinTx (AC-07 pins the
    // behavior).
    expect(runtime).toContain("allocateRewardsWithinTx");
    // The savings join resolves through the W027 DERIVED evaluation
    // (the re-derivation service — never a caller arithmetic).
    expect(runtime).toContain("procurementSavingsService");
    // The API command surface is wired.
    expect(runtime).toContain("async createBenefitPoolPolicy(");
    expect(runtime).toContain("async createBenefitPool(");
    expect(runtime).toContain("async closeBenefitPool(");
    expect(runtime).toContain("async evaluatePoolAllocation(");
    expect(runtime).toContain("async allocatePoolBenefits(");
    expect(runtime).toContain("async getMemberBenefitView(");
    // The Runtime exposes the benefits service.
    expect(runtime).toContain(
      "readonly benefitPoolService: BenefitPoolService;",
    );
    // The api layer consumes the benefits port types only (the
    // neutral surface: the API layer never imports the benefits
    // implementation files, only the port).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/benefit-pool-service\.ts/);
    expect(apiPort).not.toMatch(/allocation-engine\.ts/);
    expect(apiPort).not.toMatch(/authority-benefit-repositories\.ts/);
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).not.toMatch(/benefit-pool-service\.ts/);
    expect(apiServer).not.toMatch(/allocation-engine\.ts/);
    expect(apiServer).not.toMatch(/authority-benefit-repositories\.ts/);
    expect(apiServer).toContain("benefits.pool.create");
    expect(apiServer).toContain("benefits.allocation.execute");
    expect(apiServer).toContain("benefits.member.read");
  });

  test("the sanctioned shared-file amendments are scoped EXACTLY to the sanctioned NET-W028 activation", async () => {
    // The no-premature suite activates NET-W028 inside the SAME
    // /benefits boundary (the sixteenth-of-sixteen activation —
    // every frozen v1.0 domain is now implemented).
    const noPremature = await readFile(
      join(REPO, "tests/regression/ac-08-no-premature-domain-logic.test.ts"),
      "utf8",
    );
    expect(noPremature).toContain('const NET_W028_DOMAINS = ["benefits"]');
    // The NET-W004 deferred list retires its LAST entry (benefits)
    // with the sanctioned NET-W028 UPDATE comment — the historical
    // W004 intent (W004 itself introduced NO benefits behaviour)
    // stays preserved.
    const w004Suite = await readFile(
      join(REPO, "tests/regression/net-w004-ac-08-architecture-out-of-scope.test.ts"),
      "utf8",
    );
    expect(w004Suite).toContain("NET-W028 UPDATE");
    expect(w004Suite).toContain("const DEFERRED_DOMAINS: string[] = [];");
    // The module carries the W028 contract (non-skeletal).
    const module = await readFile(
      join(REPO, "src/benefits/module.ts"),
      "utf8",
    );
    expect(module).not.toMatch(/skeleton/i);
    expect(module).toContain("NET-W028");
  });

  test("the NET-W028 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W028.md",
      ...W028_FILES,
      "src/benefits/README.md",
      "tests/benefits/_net-w028-harness.ts",
      "tests/benefits/net-w028-ac-01-pool-records.test.ts",
      "tests/benefits/net-w028-ac-02-funding-gate.test.ts",
      "tests/benefits/net-w028-ac-03-deterministic-allocation.test.ts",
      "tests/benefits/net-w028-ac-04-conservation-remainder.test.ts",
      "tests/benefits/net-w028-ac-05-privacy-tenancy.test.ts",
      "tests/benefits/net-w028-ac-06-idempotency-concurrency.test.ts",
      "tests/benefits/net-w028-ac-07-settlement-containment.test.ts",
      "tests/regression/net-w028-ac-08-architecture-out-of-scope.test.ts",
      "docs/net-w028-benefit-pools.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W028 files (no new configuration)", async () => {
    for (const rel of W028_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(
        false,
      );
    }
    // NET-W028 adds NO configuration entries and NO secrets (the
    // benefits boundary needs no key material — deterministic
    // derivation + neutral lookups only).
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    expect(schema).not.toMatch(/BENEFITS_/);
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).not.toMatch(/BENEFITS_/);
  });
});
