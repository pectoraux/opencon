/**
 * NET-W014-AC-07 — architecture/out-of-scope regression.
 *
 * NET-W014 is an INTEGRATION layer: composition-root composites over
 * the EXISTING authorities (no 17th domain, no parallel ledger, no
 * new lifecycle authority, no payment execution, no AI settlement
 * authority). The additive amendments (the `contribution` economic
 * source kind; the `clearing_executed` campaign event) are pinned;
 * every other frozen vocabulary is UNCHANGED.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  ECONOMIC_ACCOUNT_KINDS,
  ECONOMIC_VALUE_SOURCES,
  ECONOMIC_STAKE_PURPOSE_KINDS,
  ECONOMIC_LEDGER_TX_KINDS,
  ECONOMIC_CASH_KINDS,
} from "../../src/core/economics.ts";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_CLEARING_BASES,
  CAMPAIGN_CLEARING_DRAW_KINDS,
} from "../../src/core/campaigns.ts";
import { CAMPAIGN_EVENTS } from "../../src/campaigns/port.ts";
import { RISK_OPERATION_CLASSES } from "../../src/core/risk.ts";
import { DISPUTE_SUBJECT_TYPES } from "../../src/core/disputes.ts";
import { REPUTATION_INPUT_SOURCES } from "../../src/core/reputation.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

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

describe("NET-W014-AC-07 architecture / out-of-scope", () => {
  test("the architecture check passes with all NET-W014 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; no integration boundary)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    // NET-W014 adds NO boundary: no reward-integration or settlement-
    // integration module appears in the frozen domain list.
    expect(lock).not.toContain("- `/reward-integration`");
    expect(lock).not.toContain("- `/settlement-integration`");
    expect(lock).not.toContain("- `/rewards`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
  });

  test("the NET-W014 work order exists and binds to frozen Architecture v1.0 + Issue #27", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W014.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("ECON-003");
    expect(workOrder).toContain("SETTLE-001..003");
    expect(workOrder).toContain("REP-004");
    expect(workOrder).toContain("#27");
    expect(workOrder).toContain("Reward and settlement integration");
    // The integration-layer decision of record.
    expect(workOrder).toContain("INTEGRATION layer");
    expect(workOrder).toContain("parallel ledger");
  });

  test("the additive amendments are pinned; every other frozen vocabulary is UNCHANGED", async () => {
    // The NET-W014 amendment: the verified helpful contribution as a
    // first-class economic source (additive — the original three
    // remain).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
    // The NET-W014 amendment: the clearing-executed campaign event
    // (additive — bookkeeping references only).
    expect(CAMPAIGN_EVENTS).toContain("clearing_executed");
    expect(CAMPAIGN_EVENTS.filter((e) => e === "clearing_executed").length).toBe(1);
    // UNTOUCHED vocabularies (pin the exact frozen sets).
    expect([...ECONOMIC_ACCOUNT_KINDS]).toEqual([
      "pending_value",
      "mature_value",
      "credits",
      "rewards",
      "cash_payable",
      "cash_receivable",
      "protocol_recognition",
      "stake_escrow",
    ]);
    expect([...ECONOMIC_STAKE_PURPOSE_KINDS]).toEqual([
      "campaign_budget",
      "dispute_challenge",
    ]);
    expect([...ECONOMIC_LEDGER_TX_KINDS]).toEqual([
      "value_recognition",
      "maturation",
      "reversal",
      "credit_issuance",
      "reward_allocation",
      "cash_accounting",
      "conversion",
      "settlement",
      "stake_commit",
      "stake_release",
      "stake_forfeit",
    ]);
    expect([...ECONOMIC_CASH_KINDS]).toEqual(["payable", "receivable"]);
    expect([...CAMPAIGN_STATUSES]).toEqual([
      "DRAFT",
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ]);
    expect([...CAMPAIGN_CLEARING_BASES]).toEqual([
      "attributed_outcome",
      "verified_evidence",
      "measured_value",
    ]);
    expect([...CAMPAIGN_CLEARING_DRAW_KINDS]).toEqual([
      "reward_allocation",
      "credit_issuance",
      "cash_obligation",
    ]);
    expect([...RISK_OPERATION_CLASSES]).toEqual([
      "value_maturation",
      "credit_issuance",
      "reward_allocation",
      "cash_settlement",
      "workflow_transition",
      "participant_eligibility",
    ]);
    expect([...DISPUTE_SUBJECT_TYPES]).toEqual([
      "contribution",
      "proof_of_value",
      "measured_outcome",
      "economic_value",
      "credit_issuance",
      "cash_obligation",
      "risk_case",
      "risk_control_decision",
    ]);
    expect([...REPUTATION_INPUT_SOURCES]).toEqual([
      "evidence",
      "proof_of_value",
      "measured_outcome",
      "contribution",
    ]);
  });

  test("NO parallel ledger: the integration layer introduces no new economic repository, collection or mutation path", async () => {
    // The economic mutation surface is UNCHANGED — the settlement
    // value service still owns the ONLY recognition path, and the
    // campaigns domain stores REFERENCES only (the budget/clearing
    // bookkeeping lives on the campaign record in the EXISTING
    // collections — no clearing-execution repository/collection).
    const campaignRepo = await readFile(
      join(SRC, "campaigns/authority-campaign-repository.ts"),
      "utf8",
    );
    expect(campaignRepo).toContain('const CAMPAIGNS_COLLECTION = "campaigns"');
    expect(campaignRepo).toContain(
      'const CAMPAIGN_POLICIES_COLLECTION = "campaign_policies"',
    );
    expect(campaignRepo).not.toMatch(/clearing_execution/i);
    // The clearing bookkeeping is an EVENT on the campaign record —
    // no new collection, no balances, no postings, no settlement
    // mutation inside the campaigns domain.
    const campaignService = await readFile(
      join(SRC, "campaigns/campaign-service.ts"),
      "utf8",
    );
    const clearingRegion = campaignService.slice(
      campaignService.indexOf("async recordClearingExecution"),
      campaignService.indexOf("async resolveOpportunityDraft"),
    );
    expect(clearingRegion).toContain('"clearing_executed"');
    expect(clearingRegion).not.toMatch(
      /postLedgerTransaction|issueCredits|allocateRewards|recordCashObligation|recordPendingValue/,
    );
    // No reward-integration repository/collection appeared anywhere.
    const settlementFiles = await listTsFiles(join(SRC, "settlement"));
    for (const file of settlementFiles) {
      const content = await readFile(file, "utf8");
      expect(
        /reward_integration|rewardIntegration/i.test(content),
        `parallel-ledger pattern in ${file.replace(SRC, "src")}`,
      ).toBe(false);
    }
  });

  test("the settlement domain consumes the contribution source ONLY through the neutral lookup (no domain-to-domain import)", async () => {
    const files = await listTsFiles(join(SRC, "settlement"));
    const domainImport =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|inventory|creators|demand|benefits|reputation|evidence|outcomes|contributions|workflows|disputes|campaigns|payments|llm)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (domainImport.test(content)) {
        throw new Error(
          `Domain-to-domain import found in ${file.replace(SRC, "src")} (the EconomicContributionLookup must be composition-root wired)`,
        );
      }
    }
    const valueService = await readFile(
      join(SRC, "settlement/value-service.ts"),
      "utf8",
    );
    expect(valueService).toContain("EconomicContributionLookup");
    expect(valueService).toContain('ref.kind === "contribution"');
    // The SAME qualifying bar as the other lifecycle sources.
    expect(valueService).toMatch(
      /upstream \$\{ref\.kind\} \$\{ref\.id\} is in state \$\{lifecycle\.state\}, not VERIFIED/,
    );
  });

  test("the reputation domain remains non-economic and settlement-free", async () => {
    const files = await listTsFiles(join(SRC, "reputation"));
    const forbidden: RegExp[] = [
      /\bissueCredits?\b/i,
      /\brecordPendingValue\b/,
      /\bmatureValue\b/,
      /\ballocateRewards?\b/i,
      /\brecordCashObligation\b/,
      /\brecordConversion\b/,
      /\bpostLedgerTransaction\b/,
      /from\s+["']\.\.\/settlement\//,
      /from\s+["']\.\.\/payments\//,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${pattern} found in ${file.replace(SRC, "src")}`,
        ).toBe(false);
      }
    }
  });

  test("AI/model outputs never authorize settlement or reputation mutation (the composites consult no advisory/LLM path)", async () => {
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    const start = runtime.indexOf("async recognizeContributionValue");
    const end = runtime.indexOf("\n    },", runtime.indexOf("async applySettlementReputationEffect"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const composites = runtime.slice(start, end);
    expect(composites).not.toMatch(/llmProvider|generateAdvisory|attachAdvisoryScore|advisoryScores/);
    // The quality gate reads the DETERMINISTIC evaluation record
    // ONLY (the band of the latest recorded evaluation).
    expect(composites).toContain("getLatestQualityEvaluation");
    expect(composites).toContain('"UNSATISFACTORY"');
  });

  test("the expected NET-W014 boundary files exist (documented structure)", async () => {
    const expected: readonly string[] = [
      "spec/work-orders/NET-W014.md",
      "docs/net-w014-reward-settlement.md",
      "tests/reward-integration/_net-w014-harness.ts",
      "tests/reward-integration/net-w014-ac-01-recognition.test.ts",
      "tests/reward-integration/net-w014-ac-02-gates.test.ts",
      "tests/reward-integration/net-w014-ac-03-clearing.test.ts",
      "tests/reward-integration/net-w014-ac-04-reputation.test.ts",
      "tests/reward-integration/net-w014-ac-05-atomicity-tenancy.test.ts",
      "tests/reward-integration/net-w014-ac-06-boundaries.test.ts",
      "tests/regression/net-w014-ac-07-architecture-out-of-scope.test.ts",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W014", async () => {
    const changedDirs = [
      "src/core/economics.ts",
      "src/core/campaigns.ts",
      "src/settlement",
      "src/campaigns",
      "src/reputation",
      "src/bootstrap",
      "src/api",
    ];
    const secretPatterns: RegExp[] = [
      /ghp_[A-Za-z0-9]{20,}/,
      /github_pat_[A-Za-z0-9_]{20,}/,
      /sk-[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const target of changedDirs) {
      const files = target.endsWith(".ts")
        ? [join(REPO, target)]
        : await listTsFiles(join(REPO, target));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        for (const pattern of secretPatterns) {
          expect(
            pattern.test(content),
            `secret pattern ${pattern} found in ${file.replace(REPO, ".")}`,
          ).toBe(false);
        }
      }
    }
  });
});
