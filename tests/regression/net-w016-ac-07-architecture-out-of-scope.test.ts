/**
 * NET-W016-AC-07 — architecture/out-of-scope regression.
 *
 * NET-W016 ships INSIDE the frozen `/creators` boundary (NO 17th
 * domain; the architecture-lock domain list is unchanged). The new
 * matching vocabulary is additive; every other frozen vocabulary is
 * UNCHANGED. Matching is SELECTION, not authority: no workflow,
 * settlement, reputation or risk mutation surface exists in the
 * matching implementation (structural pins); the advisory is
 * provider-neutral, bounded and structurally unable to flip
 * eligibility. No auto-match/auto-accept execution (NET-W017), no
 * UGC/rights execution (NET-W017), no sponsorship/disclosure
 * execution (NET-W018), no ad inventory or optimization (NET-W019+).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import {
  CREATOR_MATCH_SIGNALS,
  CREATOR_MATCH_GATE_REASONS,
  CREATOR_MATCH_FORMAT,
  CREATOR_MATCH_WEIGHT_SUM,
  CREATOR_MATCH_ADVISORY_MAX_BLEND,
  CREATOR_MATCH_MAX_CANDIDATES,
  CREATOR_MATCH_DEFAULT_WEIGHTS,
} from "../../src/core/creators.ts";
import { CREATOR_PROFILE_EVENTS } from "../../src/creators/port.ts";
import { RISK_OPERATION_CLASSES } from "../../src/core/risk.ts";
import { REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

describe("NET-W016-AC-07 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W016 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(250);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /creators was already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/creators`");
    // NET-W016 adds NO boundary (matching lives in /creators).
    expect(lock).not.toContain("- `/matching`");
    expect(lock).not.toContain("- `/creator-matching`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
  });

  test("the NET-W016 work order exists and binds to frozen Architecture v1.0 + Issue #31", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W016.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("CRE-002");
    expect(workOrder).toContain("AI-002");
    expect(workOrder).toContain("#31");
    expect(workOrder).toContain("Creator matching");
    // The selection-not-authority decision of record.
    expect(workOrder).toContain("selection, not authority");
    expect(workOrder).toContain("cannot be overridden by model ranking");
  });

  test("the new matching vocabulary is pinned; every other frozen vocabulary is UNCHANGED", async () => {
    // The NEW NET-W016 vocabulary (additive to core/creators.ts).
    expect([...CREATOR_MATCH_SIGNALS]).toEqual([
      "relevance",
      "audience_quality",
      "historic_outcomes",
      "safety",
      "price",
      "availability",
    ]);
    expect([...CREATOR_MATCH_GATE_REASONS]).toEqual([
      "no_profile_version",
      "profile_not_active",
      "not_accepting_work",
      "no_capacity",
      "notice_window_exceeded",
      "direct_campaigns_not_accepted",
      "invitation_required",
      "format_unsupported",
      "format_restricted",
      "language_unsupported",
      "territory_unsupported",
      "territory_restricted",
      "topic_restricted",
      "rights_not_granted",
      "rate_exceeds_ceiling",
      "audience_band_below_minimum",
      "reputation_reference_unresolvable",
      "reputation_below_minimum",
      "active_risk_control",
    ]);
    expect(CREATOR_MATCH_FORMAT).toBe("NET-W016:1");
    expect(CREATOR_MATCH_WEIGHT_SUM).toBe(100);
    expect(CREATOR_MATCH_ADVISORY_MAX_BLEND).toBe(0.25);
    expect(CREATOR_MATCH_MAX_CANDIDATES).toBe(200);
    expect(CREATOR_MATCH_DEFAULT_WEIGHTS).toEqual({
      relevance: 30,
      audienceQuality: 20,
      historicOutcomes: 20,
      safety: 10,
      price: 10,
      availability: 10,
    });

    // UNTOUCHED vocabularies (pin the exact frozen sets).
    expect([...RISK_OPERATION_CLASSES]).toEqual([
      "value_maturation",
      "credit_issuance",
      "reward_allocation",
      "cash_settlement",
      "workflow_transition",
      "participant_eligibility",
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
    expect([...CREATOR_PROFILE_EVENTS]).toEqual([
      "created",
      "activated",
      "paused",
      "resumed",
      "archived",
      "profile_version_defined",
    ]);
  });

  test("MATCHING IS SELECTION, NOT AUTHORITY: the matching implementation has NO workflow/settlement/reputation/risk mutation surface", async () => {
    const matchingFiles = [
      "src/creators/matching-engine.ts",
      "src/creators/matching-service.ts",
      "src/creators/authority-match-run-repository.ts",
    ];
    const forbidden: RegExp[] = [
      // /workflows authority (lifecycle mutation).
      /\bperformTransition\b/,
      /\btransitionWorkflow\b/,
      // /settlement authority (economic mutation).
      /\bissueCredits?\b/i,
      /\brecordPendingValue\b/,
      /\bmatureEconomicValue\b/,
      /\bmatureValue\b/,
      /\ballocateRewards?\b/i,
      /\brecordCashObligation\b/,
      /\brecordConversion\b/,
      /\bpostLedgerTransaction\b/,
      /\brecordStakeCommitment\b/,
      // /reputation authority (trust mutation).
      /\brecordInput\b/,
      /\bcreateReputationInput\b/,
      /\brecordSnapshot\b/,
      /\bcreateReputationSnapshot\b/,
      /\bcomputeScores\b/,
      // /disputes authority (risk mutation).
      /\bcreateRiskSignal\b/,
      /\bcreateSignal\b/,
      /\bsupersedeSignal\b/,
      /\bcreateRiskAssessment\b/,
      /\bcreateRiskCase\b/,
      /\bactivateControl\b/,
      /\bresolveControl\b/,
      /\bopenDispute\b/,
      // Domain→domain imports (tier rule: cross-domain facts arrive
      // through the neutral lookups only).
      /from\s+["']\.\.\/workflows\//,
      /from\s+["']\.\.\/settlement\//,
      /from\s+["']\.\.\/reputation\//,
      /from\s+["']\.\.\/disputes\//,
      /from\s+["']\.\.\/campaigns\//,
      /from\s+["']\.\.\/llm\//,
      /from\s+["']\.\.\/agents\//,
    ];
    for (const rel of matchingFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${pattern} found in ${rel}`,
        ).toBe(false);
      }
    }
    // The ONLY audit event type the matching service emits is
    // creator_match.recorded (one const, one append site).
    const service = await readFile(
      join(REPO, "src/creators/matching-service.ts"),
      "utf8",
    );
    expect(service).toContain(
      'const CREATOR_MATCH_RECORDED = "creator_match.recorded" as const',
    );
    expect(service.match(/eventType: CREATOR_MATCH_RECORDED/g)).toHaveLength(1);
  });

  test("STRUCTURAL: the advisory can never reach the eligibility evaluator (no code path from advisory output to a verdict)", async () => {
    const engine = await readFile(
      join(REPO, "src/creators/matching-engine.ts"),
      "utf8",
    );
    // The eligibility evaluator's signature carries NO advisory
    // parameter — hard restrictions cannot be overridden by model
    // ranking because no advisory value can reach this code.
    expect(engine).toMatch(
      /export function evaluateEligibility\(\s*facts: CreatorMatchCandidateFacts,\s*requirements: CreatorMatchRequirements,\s*\): CreatorMatchEligibility/,
    );
    // The advisory blend appears ONLY in the relevance scoring path
    // (scoreCandidate), never in the eligibility path.
    const eligibilityBlock = engine.slice(
      engine.indexOf("export function evaluateEligibility"),
      engine.indexOf("export function priceSignalScore"),
    );
    expect(eligibilityBlock).not.toMatch(/advisory/i);
    // The service consults the advisory ONLY after the eligibility
    // verdict exists (the exclusion happens first).
    const service = await readFile(
      join(REPO, "src/creators/matching-service.ts"),
      "utf8",
    );
    const eligibilityIndex = service.indexOf(
      "evaluateEligibility(facts, effectiveRequirements),",
    );
    const advisoryIndex = service.indexOf("await advisory.assess(");
    expect(eligibilityIndex).toBeGreaterThanOrEqual(0);
    expect(advisoryIndex).toBeGreaterThan(eligibilityIndex);
  });

  test("the composition-root advisory adapter is provider-neutral (LlmPort purpose 'matching'; provider identity preserved)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The adapter over the provider-neutral port.
    expect(runtime).toContain('purpose: "matching"');
    // The matching lookups are thin READ-ONLY adapters over the
    // owning domains' repositories (no matching-owned authority).
    expect(runtime).toContain("creatorMatchCampaignLookup");
    expect(runtime).toContain("creatorMatchReputationLookup");
    expect(runtime).toContain("creatorMatchSafetyLookup");
    // The safety read uses the participant_eligibility control class.
    expect(runtime).toMatch(
      /creatorMatchSafetyLookup[\s\S]{0,900}participant_eligibility/,
    );
    // The llm port's purpose union carries "matching" (AI-002).
    const llmPort = await readFile(join(REPO, "src/llm/port.ts"), "utf8");
    expect(llmPort).toMatch(
      /readonly purpose: "content_scoring" \| "safety" \| "matching"/,
    );
  });

  test("no auto-match/auto-accept or workflow execution leaked into the matching boundary (NET-W017 stays out of scope)", async () => {
    const files = [
      "src/creators/matching-engine.ts",
      "src/creators/matching-service.ts",
      "src/creators/port.ts",
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      // CRE-003 auto-match/auto-accept EXECUTION is NET-W017; the
      // matching boundary only READS the declared participation
      // preferences (the participation-rules gate).
      expect(content).not.toMatch(/\bautoAccept\b/i);
      expect(content).not.toMatch(/\bautoMatch\b/i);
      // No engagement/invitation lifecycle machinery (workflows
      // authority; NET-W017).
      expect(content).not.toMatch(/\bcreateEngagement\b/i);
      expect(content).not.toMatch(/\bissueInvitation\b/i);
    }
  });

  test("the NET-W016 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W016.md",
      "src/creators/matching-engine.ts",
      "src/creators/matching-service.ts",
      "src/creators/authority-match-run-repository.ts",
      "tests/creators/_net-w016-harness.ts",
      "tests/creators/net-w016-ac-01-eligibility.test.ts",
      "tests/creators/net-w016-ac-02-ranking-explanation.test.ts",
      "tests/creators/net-w016-ac-03-advisory-non-authority.test.ts",
      "tests/creators/net-w016-ac-04-selection-not-authority.test.ts",
      "tests/creators/net-w016-ac-05-tenancy-idempotency.test.ts",
      "tests/creators/net-w016-ac-06-matching-contract.test.ts",
      "tests/regression/net-w016-ac-07-architecture-out-of-scope.test.ts",
      "docs/net-w016-creator-matching.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W016", async () => {
    const secretPatterns: RegExp[] = [
      /github_pat_[A-Za-z0-9_]+/,
      /ghp_[A-Za-z0-9]+/,
      /sk-[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const files = [
      "src/creators/matching-engine.ts",
      "src/creators/matching-service.ts",
      "src/creators/authority-match-run-repository.ts",
      "src/core/creators.ts",
      "src/creators/port.ts",
      "src/llm/port.ts",
      "src/bootstrap/runtime.ts",
      "src/api/server.ts",
      "src/api/port.ts",
      "tests/creators/_net-w016-harness.ts",
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      for (const pattern of secretPatterns) {
        expect(
          pattern.test(content),
          `secret pattern ${pattern} found in ${rel}`,
        ).toBe(false);
      }
    }
  });
});
