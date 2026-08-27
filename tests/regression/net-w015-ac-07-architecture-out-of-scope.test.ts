/**
 * NET-W015-AC-07 — architecture/out-of-scope regression.
 *
 * NET-W015 makes the frozen `/creators` boundary concrete (the
 * NET-W011 campaigns precedent — NO 17th domain; the frozen
 * architecture-lock domain list is unchanged). The new creator
 * vocabulary is additive; every other frozen vocabulary is
 * UNCHANGED. No economic mutation, no reputation scoring/mutation,
 * no AI path, no matching/ranking (NET-W016), no UGC/rights
 * execution (NET-W017), no sponsorship/disclosure execution
 * (NET-W018), no external platform execution.
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
import { REPUTATION_INPUT_SOURCES, REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";
import {
  CREATOR_PROFILE_STATUSES,
  CREATOR_PLATFORM_KINDS,
  CREATOR_CONTENT_FORMATS,
  CREATOR_RATE_UNITS,
  CREATOR_RIGHTS_KINDS,
  CREATOR_AUDIENCE_SIZE_BANDS,
  CREATOR_ENGAGEMENT_BANDS,
  CREATOR_AUDIENCE_AGE_BANDS,
  CREATOR_REPUTATION_ROLES,
} from "../../src/core/creators.ts";
import { CREATOR_PROFILE_EVENTS } from "../../src/creators/port.ts";

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

describe("NET-W015-AC-07 architecture / out-of-scope", () => {
  test("the architecture check passes with all NET-W015 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; the creators boundary was already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    // The frozen domain list already contains /creators (NET-W001);
    // NET-W015 adds NO boundary.
    expect(lock).toContain("- `/creators`");
    expect(lock).not.toContain("- `/creator-profiles`");
    expect(lock).not.toContain("- `/matching`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
  });

  test("the NET-W015 work order exists and binds to frozen Architecture v1.0 + Issue #29", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W015.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("CRE-001");
    expect(workOrder).toContain("CRE-005");
    expect(workOrder).toContain("#29");
    expect(workOrder).toContain("Creator identity and preferences");
    // The authority-separation decision of record.
    expect(workOrder).toContain("second reputation/identity authority");
    expect(workOrder).toContain("matching/ranking");
  });

  test("the new creator vocabulary is pinned; every other frozen vocabulary is UNCHANGED", async () => {
    // The NEW NET-W015 vocabulary (additive — the creators module is
    // a NEW core contract set, the core/campaigns.ts precedent).
    expect([...CREATOR_PROFILE_STATUSES]).toEqual([
      "DRAFT",
      "ACTIVE",
      "PAUSED",
      "ARCHIVED",
    ]);
    expect([...CREATOR_PLATFORM_KINDS]).toEqual([
      "social",
      "video",
      "audio",
      "written",
      "community",
    ]);
    expect([...CREATOR_CONTENT_FORMATS]).toEqual([
      "post",
      "short_video",
      "long_video",
      "audio_episode",
      "article",
      "newsletter",
      "live_stream",
      "image_set",
    ]);
    expect([...CREATOR_AUDIENCE_SIZE_BANDS]).toEqual([
      "lt_1k",
      "1k_10k",
      "10k_100k",
      "100k_1m",
      "1m_10m",
      "gt_10m",
    ]);
    expect([...CREATOR_ENGAGEMENT_BANDS]).toEqual([
      "low",
      "medium",
      "high",
      "very_high",
    ]);
    expect([...CREATOR_AUDIENCE_AGE_BANDS]).toEqual([
      "13_17",
      "18_24",
      "25_34",
      "35_44",
      "45_54",
      "55_64",
      "65_plus",
    ]);
    expect([...CREATOR_RATE_UNITS]).toEqual([
      "per_deliverable",
      "per_hour",
      "per_campaign",
    ]);
    expect([...CREATOR_RIGHTS_KINDS]).toEqual([
      "channel_publication",
      "paid_amplification",
      "reuse_license",
      "exclusivity_window",
      "derivative_works",
    ]);
    expect([...CREATOR_REPUTATION_ROLES]).toEqual([
      "audience_influence",
      "production",
    ]);
    expect([...CREATOR_PROFILE_EVENTS]).toEqual([
      "created",
      "activated",
      "paused",
      "resumed",
      "archived",
      "profile_version_defined",
    ]);

    // UNTOUCHED vocabularies (pin the exact frozen sets).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
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
    expect(CAMPAIGN_EVENTS).toContain("clearing_executed");
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
    expect([...REPUTATION_DIMENSIONS]).toEqual([
      "helpfulness",
      "content_quality",
      "creator_performance",
      "inventory_quality",
      "measurement_reliability",
      "commerce_reliability",
      "fraud_resistance",
      "fulfillment_reliability",
    ]);
  });

  test("the creators domain carries NO economic mutation surface (declared rates are preferences)", async () => {
    const files = await listTsFiles(join(SRC, "creators"));
    const forbidden: RegExp[] = [
      /\bissueCredits?\b/i,
      /\brecordPendingValue\b/,
      /\bmatureEconomicValue\b/,
      /\bmatureValue\b/,
      /\ballocateRewards?\b/i,
      /\brecordCashObligation\b/,
      /\brecordConversion\b/,
      /\bpostLedgerTransaction\b/,
      /\brecordStakeCommitment\b/,
      /\bcreateRewardPolicy\b/i,
      /from\s+["']\.\.\/settlement\//,
      /from\s+["']\.\.\/payments\//,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${pattern} found in ${file.replace(REPO, ".")}`,
        ).toBe(false);
      }
    }
  });

  test("the creators domain has NO reputation scoring/mutation path and NO AI/LLM path", async () => {
    const files = await listTsFiles(join(SRC, "creators"));
    const forbidden: RegExp[] = [
      /\brecordInput\b/,
      /\bcreatePolicyVersion\b/,
      /\brecordSnapshot\b/,
      /\bcomputeScores\b/,
      /\bscoreReputation\b/i,
      /\bmutateReputation\b/i,
      /\bllm\b/i,
      /\bgenerateAdvisory\b/,
      /\badvisoryScore\b/i,
      /from\s+["']\.\.\/reputation\//,
      /from\s+["']\.\.\/llm\//,
      /from\s+["']\.\.\/agents\//,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${pattern} found in ${file.replace(REPO, ".")}`,
        ).toBe(false);
      }
    }
    // The runtime creator composites consult NO LLM/advisory path
    // either (AI cannot establish creator eligibility — issue
    // invariant 7).
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    const start = runtime.indexOf("async createCreatorProfile");
    const end = runtime.indexOf(
      "\n    },",
      runtime.indexOf("async resolveCreatorReputation"),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const composites = runtime.slice(start, end);
    expect(composites).not.toMatch(
      /llmProvider|generateAdvisory|attachAdvisoryScore|advisoryScores|qualityService|moderationService/,
    );
  });

  test("NO matching/ranking, UGC workflow, or sponsorship/disclosure execution exists anywhere in the creators domain (NET-W016/017/018)", async () => {
    const files = await listTsFiles(join(SRC, "creators"));
    const forbidden: RegExp[] = [
      /\bmatchCreators?\b/i,
      /\brankCreators?\b/i,
      /\bscoreCreators?\b/i,
      /\beligib(?:le|ility)Check\b/i,
      /\bautoAccept\b/i,
      /\bautoMatch\b/i,
      /\bpublishContent\b/i,
      /\bexecuteRights?\b/i,
      /\btransferRights?\b/i,
      /\btakedown\b/i,
      /\bissueSponsorship\b/i,
      /\brecordDisclosure\b/i,
      /from\s+["']\.\.\/workflows\//,
      /from\s+["']\.\.\/opportunities\//,
      /from\s+["']\.\.\/contributions\//,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${pattern} found in ${file.replace(REPO, ".")}`,
        ).toBe(false);
      }
    }
  });

  test("the creators domain consumes identity/reputation ONLY through the neutral lookups (no domain-to-domain import)", async () => {
    const files = await listTsFiles(join(SRC, "creators"));
    const domainImport =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|contributions|campaigns|inventory|demand|benefits|reputation|evidence|outcomes|settlement|workflows|disputes|payments|llm|agents|adapters|measurement)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (domainImport.test(content)) {
        throw new Error(
          `Domain-to-domain import found in ${file.replace(REPO, "src")} (the CreatorPersonLookup/CreatorReputationSnapshotLookup must be composition-root wired)`,
        );
      }
    }
    const service = await readFile(
      join(SRC, "creators/creator-service.ts"),
      "utf8",
    );
    expect(service).toContain("lookups.person.exists");
    expect(service).toContain("lookups.reputation.resolve");
  });

  test("the expected NET-W015 boundary files exist (documented structure)", async () => {
    const expected: readonly string[] = [
      "spec/work-orders/NET-W015.md",
      "docs/net-w015-creator-identity-preferences.md",
      "src/core/creators.ts",
      "src/creators/port.ts",
      "src/creators/creator-service.ts",
      "src/creators/authority-creator-repository.ts",
      "src/creators/module.ts",
      "src/creators/index.ts",
      "tests/creators/_net-w015-harness.ts",
      "tests/creators/net-w015-ac-01-profile-records.test.ts",
      "tests/creators/net-w015-ac-02-preferences.test.ts",
      "tests/creators/net-w015-ac-03-privacy-secrets.test.ts",
      "tests/creators/net-w015-ac-04-reputation-reference.test.ts",
      "tests/creators/net-w015-ac-05-authorization-tenancy.test.ts",
      "tests/creators/net-w015-ac-06-provider-neutrality.test.ts",
      "tests/creators/net-w015-remediation-anchor-concurrency-tenancy.test.ts",
      "tests/regression/net-w015-ac-07-architecture-out-of-scope.test.ts",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W015", async () => {
    const changedTargets = [
      "src/core/creators.ts",
      "src/core/index.ts",
      "src/creators",
      "src/bootstrap",
      "src/api",
      "tests/creators",
    ];
    const secretPatterns: RegExp[] = [
      /ghp_[A-Za-z0-9]{20,}/,
      /github_pat_[A-Za-z0-9_]{20,}/,
      /sk-[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const target of changedTargets) {
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
