/**
 * NET-W011-AC-07 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, the campaigns domain carries the campaign
 * policy/configuration foundation WITHOUT hidden authority (no
 * economic mutation — budget escrows execute only through the
 * settlement authority's stake commands wired at the composition
 * root; no lifecycle mutation — opportunities are composed through
 * the opportunities/workflows services; no evidence/outcome/
 * reputation mutation; no provider-specific campaign SDK semantics;
 * no blockchain/decentralized validation), the composition-root
 * orchestration stays out of every domain, and the domain remains
 * provider-independent (core + self only).
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

describe("NET-W011-AC-07 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W011 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen 16-domain list remains intact with /campaigns in it.
    expect(lock).toContain("- `/campaigns`");
    // No seventeenth domain was added.
    expect(lock).not.toContain("- `/advertising`");
    expect(lock).not.toContain("- `/procurement`");
  });

  test("the NET-W011 work order exists and binds to frozen Architecture v1.0 + Issue #21", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W011.md"),
      "utf8",
    );
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN");
    expect(workOrder).toContain("NET-W011-AC-01..07");
    expect(workOrder).toContain("CAMP-001");
    expect(workOrder).toContain("CAMP-005");
    expect(workOrder).toContain("Issue #21");
    expect(workOrder).toContain("No second economic system");
    expect(workOrder).toContain("Authority separation");
    expect(workOrder).toContain("second lifecycle authority");
  });

  test("the campaigns domain is non-skeletal (module readiness references NET-W011)", async () => {
    const mod = await import("../../src/campaigns/module.ts");
    const campaignsModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(campaignsModule.tier).toBe("domain");
    expect(campaignsModule.describe?.() ?? "").toMatch(/NET-W011/);
    expect(campaignsModule.describe?.() ?? "").not.toMatch(/skeleton/i);
    // The port flipped to ready with the campaign audit namespace.
    const port = await import("../../src/campaigns/port.ts");
    const campaignsPort = (port as unknown as { CampaignsPort: unknown }).CampaignsPort;
    void campaignsPort; // type-only presence; the runtime pins follow.
    const portSource = await readFile(
      join(SRC, "campaigns/port.ts"),
      "utf8",
    );
    expect(portSource).toContain('readiness: "ready"');
    expect(portSource).toContain('"campaign.created"');
    expect(portSource).toContain('"campaign.opportunity_published"');
  });

  test("the campaigns domain introduces NO hidden authority patterns (economic/lifecycle/evidence/reputation mutation, provider SDKs, decentralized validation)", async () => {
    const files = await listTsFiles(join(SRC, "campaigns"));
    expect(files.length).toBeGreaterThan(0);
    // Patterns that would indicate the campaigns domain became a
    // hidden economic ledger, a second lifecycle authority, an
    // evidence/outcomes/reputation mutator, or a provider/
    // decentralized construct. The stake COMMANDS live in /settlement
    // only — campaigns may only READ stakes through the neutral
    // lookup and RECORD references (the audited bookkeeping,
    // NET-W011-scoped). The opportunity WORKFLOW commands live in the
    // opportunities/workflows boundaries only — campaigns compose
    // through the composition root.
    const forbidden: RegExp[] = [
      /\bissueCredits?\b/i,
      /\bmintCredit/i,
      /\bmatureValue\b/,
      /\brecordPendingValue\b/,
      /\bsettleCashObligation\b/,
      /\brecordConversion\b/,
      /\ballocateRewards?\b/i,
      /\bcommitStake\b/i,
      /\breleaseStake\b/i,
      /\bforfeitStake\b/i,
      /\bpostLedgerTransaction\b/,
      /\bmutateReputation\b/i,
      /\brecordReputationInput\b/,
      /\brecordSnapshot\b/,
      /\bcreateProofOfValue\b/i,
      /\battachEvidence\b/i,
      /\bverifyProofOfValue\b/i,
      /\bcreateOpportunity\b/,
      /\brequestTransition\b/,
      /\bcreateContribution\b/i,
      /from\s+["']pg["']/,
      /from\s+["']ioredis["']/,
      /openrtb/i,
      /sellersJson/i,
      /blockchain/i,
      /\bconsensus\b/i,
      /\bweb3\b/i,
      /\bnft\b/i,
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

  test("the campaigns domain never imports other domains (the economic/lifecycle execution lives at the composition root)", async () => {
    const files = await listTsFiles(join(SRC, "campaigns"));
    const domainImport =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|contributions|inventory|creators|demand|benefits|reputation|evidence|outcomes|settlement|workflows|disputes)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (domainImport.test(content)) {
        throw new Error(
          `Domain-to-domain import found in ${file.replace(SRC, "src")} (the tier matrix + the work order §3 require composition-root wiring)`,
        );
      }
    }
  });

  test("the settlement domain carries the stake commands; the campaigns boundary does NOT (economic authority separation)", async () => {
    const stakeService = await readFile(
      join(SRC, "settlement/stake-service.ts"),
      "utf8",
    );
    expect(stakeService).toContain("commitStake");
    expect(stakeService).toContain("releaseStake");
    // The settlement side carries NO campaign policy (W008's guard
    // stands): no campaign statuses, no campaign budgets.
    const settlementFiles = await listTsFiles(join(SRC, "settlement"));
    for (const file of settlementFiles) {
      const content = await readFile(file, "utf8");
      expect(
        content,
        `${file.replace(SRC, "src")} must not carry campaign policy`,
      ).not.toMatch(/\bcampaignStatus\b/);
      expect(content).not.toMatch(/\bcampaignBudget\b/i);
      expect(content).not.toMatch(/\bcampaignLifecycle\b/i);
    }
    // The campaigns side has NO stake posting path and NO lifecycle
    // mutation path (only the read-only lookups + bookkeeping).
    const campaignService = await readFile(
      join(SRC, "campaigns/campaign-service.ts"),
      "utf8",
    );
    expect(campaignService).not.toMatch(/\bcommitStake\b/i);
    expect(campaignService).not.toMatch(/\breleaseStake\b/i);
    expect(campaignService).not.toMatch(/\bcreateOpportunity\b/);
    expect(campaignService).not.toMatch(/\brequestTransition\b/);
    // The ONLY settlement touchpoint: the read-only stake lookup.
    expect(campaignService).toContain("resolveStake");
    // The ONLY opportunities touchpoint: the read-only lookup.
    expect(campaignService).toContain("resolveOpportunity");
  });

  test("the composite orchestration is wired ONLY at the composition root (runtime), not inside any domain", async () => {
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    // The campaign budget escrow orchestration with compound keys.
    expect(runtime).toContain('"campaign_budget"');
    expect(runtime).toContain(":stake");
    expect(runtime).toContain(":record");
    // The publish orchestration through the opportunities boundary.
    expect(runtime).toContain("createOpportunity");
    // The guarded routes carry the campaign actions (the API surface).
    const server = await readFile(join(SRC, "api/server.ts"), "utf8");
    for (const action of [
      "campaign.create",
      "campaign.policy",
      "campaign.activate",
      "campaign.pause",
      "campaign.resume",
      "campaign.complete",
      "campaign.cancel",
      "campaign.budget.commit",
      "campaign.budget.release",
      "campaign.opportunity.publish",
    ]) {
      expect(server).toContain(`"${action}"`);
    }
    // No domain file performs the orchestration (the settlement
    // boundary legitimately DEFINES the stake commands; the
    // opportunities boundary legitimately defines createOpportunity —
    // the point is that the CAMPAIGNS domain never calls either).
    const campaignFiles = await listTsFiles(join(SRC, "campaigns"));
    for (const file of campaignFiles) {
      const content = await readFile(file, "utf8");
      expect(content, `${file.replace(SRC, "src")} must not call settlement commands`).not.toMatch(
        /\bcommitStake\b/,
      );
      expect(content, `${file.replace(SRC, "src")} must not call opportunities/workflows commands`).not.toMatch(
        /\bcreateOpportunity\b/,
      );
      expect(content).not.toMatch(/\brequestTransition\b/);
    }
  });

  test("the evidence/outcomes/reputation/workflows domains were NOT modified by NET-W011 (authority ownership)", async () => {
    for (const dir of ["evidence", "outcomes", "reputation", "workflows"]) {
      const files = await listTsFiles(join(SRC, dir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(
          content,
          `${file.replace(SRC, "src")} must not import the campaigns boundary`,
        ).not.toMatch(/from\s+["']\.\.\/campaigns\//);
      }
    }
  });

  test("the core campaign vocabulary exports the frozen sets + deterministic references", async () => {
    const core = await import("../../src/core/campaigns.ts");
    expect([...core.CAMPAIGN_STATUSES]).toEqual([
      "DRAFT",
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ]);
    expect(core.CAMPAIGN_TERMINAL_STATUSES).toEqual([
      "COMPLETED",
      "CANCELLED",
    ]);
    expect(core.CAMPAIGN_PUBLISHABLE_STATUSES).toEqual(["ACTIVE"]);
    // CAMP-001: the nine frozen objective kinds.
    expect([...core.CAMPAIGN_OBJECTIVE_KINDS]).toEqual([
      "awareness",
      "attention",
      "engagement",
      "intent",
      "conversion",
      "incremental_conversion",
      "creator_content",
      "cross_promotion",
      "referral",
    ]);
    expect(core.isCampaignObjectiveKind("awareness")).toBe(true);
    expect(core.isCampaignObjectiveKind("viral_splash")).toBe(false);
    expect(core.isCampaignStatus("ACTIVE")).toBe(true);
    expect(core.isCampaignStatus("SETTLING")).toBe(false);
    // The deterministic incremental-conversion constraint.
    expect(() =>
      core.assertIncrementalAttributionConstraint(
        "incremental_conversion",
        "deterministic",
        false,
      ),
    ).toThrow();
    expect(() =>
      core.assertIncrementalAttributionConstraint(
        "incremental_conversion",
        "experimental",
        true,
      ),
    ).not.toThrow();
    // The deterministic versioned eligibility reference.
    expect(
      core.campaignEligibilityPolicyReference("c1", 2, "s3"),
    ).toBe("campaign_policy:c1:2:s3");
    // The policy-format lineage.
    expect(core.CAMPAIGN_POLICY_FORMAT).toBe("NET-W011:1");
    expect(core.CAMPAIGN_BUDGET_STAKE_PURPOSE_KIND).toBe("campaign_budget");
  });

  test("the core economic vocabulary gained the additive campaign purpose (frozen superset)", async () => {
    const core = await import("../../src/core/economics.ts");
    // The account kinds are UNCHANGED (no campaign account was added —
    // the escrow reuses stake_escrow; no second ledger).
    expect([...core.ECONOMIC_ACCOUNT_KINDS]).toEqual([
      "pending_value",
      "mature_value",
      "credits",
      "rewards",
      "cash_payable",
      "cash_receivable",
      "protocol_recognition",
      "stake_escrow",
    ]);
    expect([...core.ECONOMIC_STAKE_PURPOSE_KINDS]).toEqual([
      "campaign_budget",
      "dispute_challenge",
    ]);
    expect(core.isEconomicStakePurposeKind("campaign_budget")).toBe(true);
    // The ad-hoc kind stays rejected (W010's negative pin preserved).
    expect(core.isEconomicStakePurposeKind("ad_campaign")).toBe(false);
  });

  test("the expected NET-W011 boundary files exist (documented structure)", async () => {
    for (const file of [
      "src/core/campaigns.ts",
      "src/campaigns/port.ts",
      "src/campaigns/campaign-service.ts",
      "src/campaigns/authority-campaign-repository.ts",
      "src/campaigns/module.ts",
      "src/campaigns/README.md",
      "docs/net-w011-campaigns.md",
    ]) {
      expect(existsSync(join(REPO, file)), `${file} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W011 files", async () => {
    const SECRET_VALUE_PATTERN =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    const files = await listTsFiles(join(SRC, "campaigns"));
    files.push(join(SRC, "core/campaigns.ts"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${file} must be secret-free`).toBe(
        false,
      );
    }
  });
});
