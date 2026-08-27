/**
 * NET-W013-AC-07 — architecture/out-of-scope regression.
 *
 * Quality/moderation semantics extend /contributions (the W012 §2
 * precedent: no 17th domain — the architecture-lock keeps NO
 * /moderation boundary). The domain carries NO hidden authority
 * (economic/lifecycle/evidence/campaign/reputation/risk mutation),
 * NO sentiment vocabulary, NO provider SDKs and NO decentralized
 * constructs; the LLM adapter is consumed ONLY at the composition
 * root; spam/abuse emission happens ONLY through the composition-root
 * composite; the frozen economic vocabulary and lifecycle subject
 * kinds are UNCHANGED; the additive risk-vocabulary amendments are
 * pinned.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import { ECONOMIC_ACCOUNT_KINDS, ECONOMIC_STAKE_PURPOSE_KINDS, ECONOMIC_LEDGER_TX_KINDS } from "../../src/core/economics.ts";

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

describe("NET-W013-AC-07 architecture / out-of-scope", () => {
  test("the architecture check passes with all NET-W013 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged; no 17th domain)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/contributions`");
    // The W013 domain-placement decision of record: quality/moderation
    // semantics extend /contributions — the lock STILL reserves no
    // /moderation boundary (and no /quality one either).
    expect(lock).not.toContain("- `/moderation`");
    expect(lock).not.toContain("- `/quality`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
  });

  test("the NET-W013 work order exists and binds to frozen Architecture v1.0 + Issue #25", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W013.md"),
      "utf8",
    );
    expect(workOrder).toContain("READY_FOR_IMPLEMENTATION");
    expect(workOrder).toContain("v1.0 (FROZEN)");
    expect(workOrder).toContain("HELP-002");
    expect(workOrder).toContain("AI-004");
    expect(workOrder).toContain("FRAUD-001..003");
    expect(workOrder).toContain("Canonical issue:** #25");
    expect(workOrder).toContain("Quality, moderation and anti-spam controls");
    // The domain-placement decision of record.
    expect(workOrder).toContain("17th domain");
  });

  test("the contributions module references NET-W004 + NET-W012 + NET-W013 (the triple pin)", async () => {
    const mod = await import("../../src/contributions/module.ts");
    const moduleExport = Object.values(mod)[0] as {
      name: string;
      tier: string;
      describe?: () => string;
    };
    expect(moduleExport.tier).toBe("domain");
    const described = moduleExport.describe?.() ?? "";
    expect(described).not.toMatch(/skeleton/i);
    expect(described).toMatch(/NET-W004/);
    expect(described).toMatch(/NET-W012/);
    expect(described).toMatch(/NET-W013/);
    const portSource = await readFile(
      join(SRC, "contributions/port.ts"),
      "utf8",
    );
    expect(portSource).toContain('readiness: "ready"');
    expect(portSource).toContain('"quality_policy.version_created"');
    expect(portSource).toContain('"quality_evaluation.recorded"');
    expect(portSource).toContain('"moderation_decision.recorded"');
  });

  test("the contributions domain introduces NO hidden authority patterns (economic/lifecycle/evidence/campaign/reputation/RISK mutation, provider SDKs, decentralized validation, sentiment conditioning)", async () => {
    const files = await listTsFiles(join(SRC, "contributions"));
    expect(files.length).toBeGreaterThan(0);
    // Patterns that would indicate the contributions domain became a
    // hidden economic ledger, a second lifecycle/risk authority, an
    // evidence/outcomes/campaigns/reputation mutator, or a
    // provider/decentralized/sentiment construct. The economic
    // commands live in /settlement only; lifecycle in /workflows only;
    // RISK-SIGNAL creation lives at the composition root only (the
    // spam/abuse emission composes /disputes — it never duplicates
    // it).
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
      // NET-W013: the DOMAIN never touches the risk authority — the
      // spam/abuse emission is composition-root only.
      /\briskSignalService\b/,
      /\briskControlService\b/,
      /\bcreateSignal\b/,
      /\bactivateControl\b/,
      // Sentiment conditioning is structurally banned (HELP-004).
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
      // The domain never imports the LLM adapter (the
      // domain-must-not-import-adapter rule).
      /from\s+["']\.\.\/llm\//,
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

  test("the contributions domain never imports other domains (composition-root wiring only)", async () => {
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

  test("authority separation is mechanical: quality reads truth through lookups; moderation is append-only bookkeeping; the risk emission + LLM consumption live at the composition root", async () => {
    const qualityService = await readFile(
      join(SRC, "contributions/quality-service.ts"),
      "utf8",
    );
    expect(qualityService).toContain("lookups.proofOfHelpfulness");
    expect(qualityService).toContain("lookups.evidence");
    expect(qualityService).toContain("lookups.measurement");
    expect(qualityService).toContain("lookups.proofOfValue");
    // The in-tx same-scope policy pinning (the PR #24 lesson).
    expect(qualityService).toContain("findVersionWithinTx");
    expect(qualityService).toMatch(
      /cross-tenant policy pin rejected at the authoritative transaction boundary/,
    );
    const moderationService = await readFile(
      join(SRC, "contributions/moderation-service.ts"),
      "utf8",
    );
    // The moderation service records decisions and NOTHING else.
    expect(moderationService).not.toMatch(/\briskSignalService\b/);
    expect(moderationService).not.toMatch(/\bcreateSignal\b/);
    expect(moderationService).toMatch(/append-only/i);
    // The composition root owns the emission + the LLM consumption.
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    expect(runtime).toContain("generateAdvisoryQualityScore");
    expect(runtime).toContain("llmProvider.score");
    expect(runtime).toContain("riskSignalService.createSignal");
    expect(runtime).toContain("net-w013-moderation");
    expect(runtime).toContain('"moderation_decision"');
    expect(runtime).toContain(':signal');
    // No domain file performs the orchestration (asserted above; the
    // composite is composition-root only).
  });

  test("the frozen lifecycle subject kinds are UNCHANGED (no second lifecycle authority)", async () => {
    const workflowCore = await readFile(join(SRC, "core/workflow.ts"), "utf8");
    expect(workflowCore).toContain('| "opportunity"');
    expect(workflowCore).toContain('| "contribution"');
    expect(workflowCore).toContain('| "proof_of_value"');
    expect(workflowCore).toContain('| "outcome_measurement"');
    expect(workflowCore).not.toContain('| "quality_evaluation"');
    expect(workflowCore).not.toContain('| "moderation');
    const transitionTable = await readFile(
      join(SRC, "workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/quality/i);
    expect(transitionTable).not.toMatch(/moderation/i);
  });

  test("the frozen economic vocabulary is UNCHANGED by NET-W013 (quality mints no economic value)", async () => {
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

  test("the core moderation vocabulary is closed, provider-neutral and pinned", async () => {
    const core = await import("../../src/core/moderation.ts");
    expect(core.QUALITY_INPUT_KINDS).toEqual([
      "proof_of_helpfulness",
      "evidence_record",
      "measured_outcome",
      "proof_of_value",
    ]);
    expect(core.QUALITY_ADVISORY_KINDS).toEqual([
      "model_score",
      "heuristic_score",
    ]);
    expect(core.QUALITY_BANDS).toEqual([
      "HIGH_QUALITY",
      "ADEQUATE",
      "LOW_QUALITY",
      "UNSATISFACTORY",
    ]);
    expect(core.MODERATION_DECISIONS).toEqual([
      "APPROVE",
      "REJECT",
      "FLAG_FOR_REVIEW",
    ]);
    expect(core.ABUSE_REASON_KINDS).toEqual(["spam", "abuse"]);
    expect(core.CONTRIBUTION_MODERATION_STATUSES).toEqual([
      "UNMODERATED",
      "APPROVED",
      "REJECTED",
      "FLAGGED_FOR_REVIEW",
    ]);
    expect(core.QUALITY_POLICY_FORMAT).toBe("NET-W013:1");
    expect(core.QUALITY_SCORE_DECIMALS).toBe(6);
    // Sentiment-style kinds are structurally absent.
    expect(
      (core.MODERATION_REASON_KINDS as readonly string[]).includes(
        "negative_sentiment",
      ),
    ).toBe(false);
    expect(
      (core.MODERATION_REASON_KINDS as readonly string[]).includes(
        "positive_sentiment",
      ),
    ).toBe(false);
    // The shape validator rejects an advisory-only cap above ADEQUATE.
    expect(() =>
      core.validateQualityPolicyShape({
        inputs: [{ kind: "proof_of_helpfulness", weight: 1, minimumCount: 1 }],
        advisory: {
          allowedKinds: ["model_score"],
          advisoryWeightFactor: 0.5,
        },
        minimumGrade: "ATTESTED",
        qualifyingSourceTypes: ["attested"],
        qualifyingOutcomeTypes: ["helpfulness"],
        minimumConfidence: 0.7,
        thresholds: { highQualityAt: 0.8, adequateAt: 0.5, lowQualityAt: 0.2 },
        structural: {
          advisoryOnlyCapBand: "HIGH_QUALITY",
          requiredInputs: [],
          missingInputFloorBand: "LOW_QUALITY",
        },
        description: null,
      }),
    ).toThrow(/advisoryOnlyCapBand/);
  });

  test("the additive risk-vocabulary amendments are pinned (spam/abuse categories + the moderation_decision source kind)", async () => {
    const core = await import("../../src/core/risk.ts");
    expect(core.RISK_SIGNAL_CATEGORIES).toEqual([
      "identity",
      "behavioral",
      "device_integrity",
      "graph",
      "economic_anomaly",
      "velocity",
      "duplicate_pattern",
      "historical_reputation",
      "model_advisory",
      "spam",
      "abuse",
    ]);
    expect(
      (core.RISK_SIGNAL_SOURCE_KINDS as readonly string[]).includes(
        "moderation_decision",
      ),
    ).toBe(true);
    expect(core.isRiskSignalCategory("spam")).toBe(true);
    expect(core.isRiskSignalCategory("abuse")).toBe(true);
    // The /disputes source validation resolves moderation decisions
    // through the neutral lookup.
    const sourceValidation = await readFile(
      join(SRC, "disputes/source-validation.ts"),
      "utf8",
    );
    expect(sourceValidation).toContain('case "moderation_decision"');
    expect(sourceValidation).toContain("lookups.moderation.resolve");
  });

  test("the LLM boundary is concrete and provider-neutral (NET-W013 — its designated purpose)", async () => {
    const port = await readFile(join(SRC, "llm/port.ts"), "utf8");
    expect(port).toContain("interface LlmScoringInput");
    expect(port).toContain("interface LlmScoringResult");
    expect(port).toContain("authoritative: false");
    expect(port).toContain('readiness: "ready"');
    const provider = await readFile(
      join(SRC, "llm/providers/echo-llm-provider.ts"),
      "utf8",
    );
    expect(provider).toContain("createHash");
    expect(provider).toContain('readiness = "ready"');
    // The agents boundary remains deferred (explicit non-goal).
    const agentsModule = await import("../../src/agents/module.ts");
    const agentsExport = Object.values(agentsModule)[0] as {
      describe?: () => string;
    };
    expect(agentsExport.describe?.() ?? "").toMatch(/skeleton/i);
  });

  test("the guarded routes carry the NET-W013 actions (the API surface)", async () => {
    const server = await readFile(join(SRC, "api/server.ts"), "utf8");
    for (const action of [
      "quality.policy",
      "quality.advisory.attach",
      "quality.advisory.generate",
      "quality.evaluation.preview",
      "quality.evaluation.record",
      "moderation.decide",
    ]) {
      expect(server).toContain(`"${action}"`);
    }
  });

  test("neighbor domains were not modified (disputes changes are additive lookups/validation only)", async () => {
    // The disputes port + source-validation carry ONLY the additive
    // NET-W013 annotations — no behavior changes to the existing
    // signal/assessment/case/control/dispute flows.
    const disputesPort = await readFile(
      join(SRC, "disputes/port.ts"),
      "utf8",
    );
    expect(disputesPort).toContain("RiskModerationDecisionLookup");
    expect(disputesPort).toContain("moderation: RiskModerationDecisionLookup");
    // The settlement/reputation/workflows/evidence/outcomes domains
    // carry no W013 references at all.
    for (const neighbor of ["settlement", "reputation", "workflows", "evidence", "outcomes", "campaigns"]) {
      const files = await listTsFiles(join(SRC, neighbor));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(
          content,
          `${file.replace(SRC, "src")} must not reference NET-W013`,
        ).not.toMatch(/NET-W013/);
      }
    }
  });

  test("the expected NET-W013 boundary files exist (documented structure)", async () => {
    const expected: readonly string[] = [
      "src/core/moderation.ts",
      "src/contributions/port.ts",
      "src/contributions/quality-engine.ts",
      "src/contributions/quality-service.ts",
      "src/contributions/moderation-service.ts",
      "src/contributions/authority-quality-repository.ts",
      "src/contributions/module.ts",
      "src/contributions/README.md",
      "src/llm/port.ts",
      "src/llm/providers/echo-llm-provider.ts",
      "src/llm/module.ts",
      "src/llm/README.md",
      "spec/work-orders/NET-W013.md",
      "docs/net-w013-quality-moderation.md",
      "tests/contributions/_net-w013-harness.ts",
      "tests/contributions/net-w013-ac-01-quality-records.test.ts",
      "tests/contributions/net-w013-ac-02-provider-independent.test.ts",
      "tests/contributions/net-w013-ac-03-mention-not-quality.test.ts",
      "tests/contributions/net-w013-ac-04-moderation-append-only.test.ts",
      "tests/contributions/net-w013-ac-05-abuse-signal-integration.test.ts",
      "tests/contributions/net-w013-ac-06-atomicity-tenancy.test.ts",
      "tests/contributions/net-w013-remediation-mention-isolation.test.ts",
      "tests/regression/net-w013-ac-07-architecture-out-of-scope.test.ts",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W013", async () => {
    const changedDirs = [
      "src/core/moderation.ts",
      "src/contributions",
      "src/llm",
      "src/disputes",
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
