/**
 * NET-W012-AC-07 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, the contributions domain carries the helpful-contribution
 * foundation WITHOUT hidden authority (no economic mutation — reward
 * integration is NET-W014; no lifecycle mutation — publication
 * transitions execute only through /workflows at the composition
 * root; no evidence/outcomes/campaigns/reputation mutation — the
 * truth authorities are READ through neutral lookups; no moderation
 * engine — NET-W013; no provider-specific semantics; no blockchain/
 * decentralized validation), the composition-root orchestration stays
 * out of every domain, and the domain remains provider-independent
 * (core + self only).
 *
 * Evidence: static architecture check + regression tests.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  DISCLOSURE_RELATIONSHIP_KINDS,
  DISCLOSURE_STATES,
  HELPFUL_ADVISORY_KINDS,
  HELPFUL_OPPORTUNITY_TYPES,
  HELPFULNESS_BASIS_KINDS,
  HELPFULNESS_POLICY_FORMAT,
  PROOF_OF_HELPFULNESS_STATUSES,
  QUALIFYING_HELPFULNESS_SOURCE_TYPES,
  evaluateCampaignEligibility,
} from "../../src/core/contributions.ts";
import { ECONOMIC_ACCOUNT_KINDS, ECONOMIC_STAKE_PURPOSE_KINDS } from "../../src/core/economics.ts";
import { ECONOMIC_LEDGER_TX_KINDS } from "../../src/core/economics.ts";

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

describe("NET-W012-AC-07 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W012 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged; no 17th domain)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The frozen 16-domain list remains intact with /contributions in it.
    expect(lock).toContain("- `/contributions`");
    // No seventeenth domain was added.
    expect(lock).not.toContain("- `/helpfulness`");
    expect(lock).not.toContain("- `/moderation`");
  });

  test("the NET-W012 work order exists and binds to frozen Architecture v1.0 + Issue #23", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W012.md"),
      "utf8",
    );
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN");
    expect(workOrder).toContain("NET-W012-AC-01..07");
    expect(workOrder).toContain("HELP-001..005");
    expect(workOrder).toContain("Issue #23");
    expect(workOrder).toContain("Mention ≠ helpfulness");
    expect(workOrder).toContain("AI is advisory");
    expect(workOrder).toContain("Publication is user-controlled");
    expect(workOrder).toContain("Commercial disclosure is explicit");
    expect(workOrder).toContain("never moves");
    expect(workOrder).toContain("frozen economic vocabulary");
  });

  test("the contributions module references BOTH NET-W004 and NET-W012 (the W004 regression contract holds)", async () => {
    const mod = await import("../../src/contributions/module.ts");
    const contributionsModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(contributionsModule.tier).toBe("domain");
    expect(contributionsModule.describe?.() ?? "").toMatch(/NET-W004/);
    expect(contributionsModule.describe?.() ?? "").toMatch(/NET-W012/);
    expect(contributionsModule.describe?.() ?? "").not.toMatch(/skeleton/i);
    // The port is ready with the helpful audit namespace.
    const portSource = await readFile(
      join(SRC, "contributions/port.ts"),
      "utf8",
    );
    expect(portSource).toContain('readiness: "ready"');
    expect(portSource).toContain('"helpful_contribution.created"');
    expect(portSource).toContain('"proof_of_helpfulness.evaluated"');
    expect(portSource).toContain('"helpful_disclosure.declared"');
  });

  test("the contributions domain introduces NO hidden authority patterns (economic/lifecycle/evidence/campaign/reputation mutation, provider SDKs, decentralized validation, sentiment conditioning)", async () => {
    const files = await listTsFiles(join(SRC, "contributions"));
    expect(files.length).toBeGreaterThan(0);
    // Patterns that would indicate the contributions domain became a
    // hidden economic ledger, a second lifecycle authority, an
    // evidence/outcomes/campaigns/reputation mutator, a moderation
    // engine (NET-W013), or a provider/decentralized/sentiment
    // construct. The economic commands live in /settlement only; the
    // lifecycle commands live in /workflows only; evidence/outcome/
    // campaign records are created by their OWN domains — the helpful
    // domain may only READ them through the neutral lookups.
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
      /\bverifyProofOfValue\b/i,
      /\bcreateOutcomeClaim\b/,
      /\battachAttestation\b/,
      /\bdefineCampaignPolicy\b/,
      /\bactivateCampaign\b/,
      /\bcreateOpportunity\b/,
      /\brequestTransition\b/,
      /\bmoderateContent\b/i,
      /\bflagSpam\b/i,
      /\bsentimentScore\b/i,
      /\bpositivityScore\b/i,
      /\btoneScore\b/i,
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

  test("the contributions domain never imports other domains (the lifecycle/economic execution lives at the composition root)", async () => {
    const files = await listTsFiles(join(SRC, "contributions"));
    const domainImport =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|inventory|creators|demand|benefits|reputation|evidence|outcomes|settlement|workflows|disputes|campaigns)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (domainImport.test(content)) {
        throw new Error(
          `Domain-to-domain import found in ${file.replace(SRC, "src")} (the tier matrix + the work order §3 require composition-root wiring)`,
        );
      }
    }
  });

  test("authority separation is mechanical: /workflows owns the publication transitions; /contributions only asserts + records", async () => {
    const helpfulnessService = await readFile(
      join(SRC, "contributions/helpfulness-service.ts"),
      "utf8",
    );
    // The domain NEVER calls a workflow/evidence/settlement command.
    expect(helpfulnessService).not.toMatch(/\brequestTransition\b/);
    expect(helpfulnessService).not.toMatch(/\bcreateOpportunity\b/);
    expect(helpfulnessService).not.toMatch(/\bcommitStake\b/i);
    // The domain's ONLY cross-boundary reads: the neutral lookups.
    expect(helpfulnessService).toContain("lookups.campaign");
    expect(helpfulnessService).toContain("lookups.opportunity");
    expect(helpfulnessService).toContain("lookups.evidence");
    expect(helpfulnessService).toContain("lookups.measurement");
    expect(helpfulnessService).toContain("lookups.proofOfValue");
    // The user-controlled publication gate lives in the domain…
    expect(helpfulnessService).toContain("assertPublishable");
    // …but the transition EXECUTION lives in /workflows (unchanged).
    const workflowService = await readFile(
      join(SRC, "workflows/workflow-service.ts"),
      "utf8",
    );
    expect(workflowService).toContain("requestTransition");
    const transitionTable = await readFile(
      join(SRC, "workflows/transition-table.ts"),
      "utf8",
    );
    // No new lifecycle subject kind was introduced.
    expect(transitionTable).not.toMatch(/proof_of_helpfulness/);
    expect(transitionTable).not.toMatch(/helpful/);
  });

  test("the frozen lifecycle subject kinds are UNCHANGED (no second lifecycle authority)", async () => {
    const workflowCore = await readFile(
      join(SRC, "core/workflow.ts"),
      "utf8",
    );
    expect(workflowCore).toContain('| "opportunity"');
    expect(workflowCore).toContain('| "contribution"');
    expect(workflowCore).toContain('| "proof_of_value"');
    expect(workflowCore).toContain('| "outcome_measurement"');
    expect(workflowCore).not.toContain('| "proof_of_helpfulness"');
    expect(workflowCore).not.toContain('| "helpful');
  });

  test("the frozen economic vocabulary is UNCHANGED by NET-W012 (no parallel economic system)", async () => {
    expect(ECONOMIC_ACCOUNT_KINDS).toEqual([
      "pending_value",
      "mature_value",
      "credits",
      "rewards",
      "cash_payable",
      "cash_receivable",
      "protocol_recognition",
      "stake_escrow",
    ]);
    expect(ECONOMIC_STAKE_PURPOSE_KINDS).toEqual([
      "campaign_budget",
      "dispute_challenge",
    ]);
    expect(ECONOMIC_LEDGER_TX_KINDS.length).toBe(11);
  });

  test("the core helpful vocabulary is closed, provider-neutral and pinned", async () => {
    expect(HELPFUL_OPPORTUNITY_TYPES).toEqual([
      "helpful_recommendation",
      "helpful_guidance",
      "helpful_answer",
      "helpful_comparison",
    ]);
    expect(HELPFULNESS_POLICY_FORMAT).toBe("NET-W012:1");
    expect(PROOF_OF_HELPFULNESS_STATUSES).toEqual([
      "PENDING",
      "QUALIFIED",
      "NOT_QUALIFIED",
    ]);
    expect(HELPFULNESS_BASIS_KINDS).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence_record",
    ]);
    expect(QUALIFYING_HELPFULNESS_SOURCE_TYPES).toEqual([
      "platform",
      "attested",
      "provider",
    ]);
    expect(HELPFUL_ADVISORY_KINDS).toEqual([
      "model_score",
      "heuristic_score",
    ]);
    expect(DISCLOSURE_STATES).toEqual(["DECLARED", "RETRACTED"]);
    expect(DISCLOSURE_RELATIONSHIP_KINDS.length).toBe(7);
    // The fail-closed eligibility evaluator exists in core (pure).
    const failClosed = evaluateCampaignEligibility(
      [{ attribute: "participant_class", operator: "equals", values: ["contributor"] }],
      {},
    );
    expect(failClosed.eligible).toBe(false);
  });

  test("the composite publication orchestration is wired ONLY at the composition root (runtime), not inside any domain", async () => {
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    // The publication composite: gate → workflow walk → record, with
    // compound idempotency keys.
    expect(runtime).toContain("publishHelpfulContribution");
    expect(runtime).toContain("assertPublishable");
    expect(runtime).toContain(':t${String(step)}');
    expect(runtime).toContain(":record");
    // The neutral helpfulness lookups are wired over the OWNING
    // domains' repositories (read-only dependency inversion).
    expect(runtime).toContain("helpfulnessCampaignLookup");
    expect(runtime).toContain("helpfulnessEvidenceLookup");
    expect(runtime).toContain("helpfulnessMeasurementLookup");
    expect(runtime).toContain("helpfulnessProofOfValueLookup");
    // The guarded routes carry the helpful actions (the API surface).
    const server = await readFile(join(SRC, "api/server.ts"), "utf8");
    for (const action of [
      "helpfulness.policy",
      "helpful_contribution.create",
      "helpful_recommendation.prepare",
      "helpful_contribution.publish",
      "helpful_disclosure.declare",
      "helpful_disclosure.retract",
      "helpful_advisory.record",
      "helpful_poh.basis",
      "helpful_poh.evaluate",
    ]) {
      expect(server).toContain(`"${action}"`);
    }
    // No domain file performs the orchestration.
    const contributionFiles = await listTsFiles(join(SRC, "contributions"));
    for (const file of contributionFiles) {
      const content = await readFile(file, "utf8");
      expect(
        content,
        `${file.replace(SRC, "src")} must not call workflow commands`,
      ).not.toMatch(/\brequestTransition\b/);
      expect(content).not.toMatch(/\bcreateOpportunity\b/);
    }
  });

  test("the evidence/outcomes/campaigns/settlement/workflows/reputation domains were NOT modified to import the helpful layer (authority ownership)", async () => {
    for (const dir of [
      "evidence",
      "outcomes",
      "campaigns",
      "settlement",
      "workflows",
      "reputation",
    ]) {
      const files = await listTsFiles(join(SRC, dir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(
          content,
          `${file.replace(SRC, "src")} must not import the contributions boundary`,
        ).not.toMatch(/from\s+["']\.\.\/contributions\//);
      }
    }
  });

  test("the expected NET-W012 boundary files exist (documented structure)", async () => {
    const expected: readonly string[] = [
      "src/core/contributions.ts",
      "src/contributions/port.ts",
      "src/contributions/poh-engine.ts",
      "src/contributions/helpfulness-service.ts",
      "src/contributions/authority-helpfulness-repository.ts",
      "src/contributions/module.ts",
      "src/contributions/README.md",
      "spec/work-orders/NET-W012.md",
      "docs/net-w012-helpful-contributions.md",
      "tests/contributions/_net-w012-harness.ts",
      "tests/contributions/net-w012-ac-01-records.test.ts",
      "tests/contributions/net-w012-ac-02-policy-and-engine.test.ts",
      "tests/contributions/net-w012-ac-03-mention-not-helpfulness.test.ts",
      "tests/contributions/net-w012-ac-04-advisory.test.ts",
      "tests/contributions/net-w012-ac-05-publication-disclosure.test.ts",
      "tests/contributions/net-w012-ac-06-atomicity-tenancy.test.ts",
      "tests/regression/net-w012-ac-07-architecture-out-of-scope.test.ts",
    ];
    for (const rel of expected) {
      expect(
        existsSync(join(REPO, rel)),
        `${rel} should exist`,
      ).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W012", async () => {
    const changedDirs = ["src/core/contributions.ts", "src/contributions", "src/bootstrap", "src/api"];
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
