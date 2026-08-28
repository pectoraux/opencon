/**
 * NET-W017-AC-07 — architecture/out-of-scope regression.
 *
 * NET-W017 ships INSIDE the frozen `/creators` boundary (NO 17th
 * domain; the architecture-lock domain list is unchanged) with ONE
 * new canonical lifecycle subject kind (`engagement`) whose
 * transitions live in `/workflows` — the SOLE lifecycle authority.
 * The new vocabulary is additive; every other frozen vocabulary is
 * UNCHANGED. No second lifecycle engine, no economic/reputation/
 * risk/outcome mutation surface, NO AI path, provider-neutral
 * external references only.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import {
  USAGE_RIGHTS_CHANNELS,
  USAGE_RIGHTS_OWNERSHIP,
  USAGE_RIGHTS_EFFECTIVE_STATUSES,
  CREATOR_ENGAGEMENT_FORMAT,
  AUTO_ACCEPT_GATE_REASONS,
  CREATOR_RIGHTS_KINDS,
  CREATOR_CONTENT_FORMATS,
  CREATOR_MATCH_FORMAT,
} from "../../src/core/creators.ts";
import { ENGAGEMENT_BATCH_SKIP_REASONS as PORT_SKIP_REASONS, ENGAGEMENT_BATCH_STATUSES as PORT_BATCH_STATUSES } from "../../src/creators/port.ts";
import {
  CANONICAL_LIFECYCLE_STATES,
  EXCEPTIONAL_LIFECYCLE_STATES,
  TERMINAL_LIFECYCLE_STATES,
  type LifecycleSubjectKind,
} from "../../src/core/workflow.ts";
import { ENGAGEMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import { REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";
import { RISK_OPERATION_CLASSES } from "../../src/core/risk.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

describe("NET-W017-AC-07 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W017 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(250);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /creators and /workflows were already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/creators`");
    expect(lock).toContain("- `/workflows`");
    // NET-W017 adds NO boundary (engagements live in /creators;
    // their lifecycle lives in /workflows).
    expect(lock).not.toContain("- `/engagements`");
    expect(lock).not.toContain("- `/ugc`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // UGC production does not require the creator to publish to
    // their own audience (the CRE-004 architecture statement).
    expect(arch).toContain(
      "UGC production does not require the creator to publish to their own audience",
    );
  });

  test("the NET-W017 work order exists and binds to frozen Architecture v1.0 + Issue #33", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W017.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("CRE-003");
    expect(workOrder).toContain("CRE-004");
    expect(workOrder).toContain("CRE-005");
    expect(workOrder).toContain("#33");
    expect(workOrder).toContain("UGC workflow and rights");
    // The decisions of record.
    expect(workOrder).toContain("executed through the canonical lifecycle authority");
    expect(workOrder).toContain("NO second state machine in `/creators`");
    expect(workOrder).toContain("creator_retained");
    expect(workOrder).toContain("The engagement/production lifecycle is the canonical `/workflows`");
  });

  test("the NET-W017 vocabulary is pinned; every other frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W017 vocabulary (additive to core/creators.ts).
    expect([...USAGE_RIGHTS_CHANNELS]).toEqual([
      "creator_owned_channel",
      "organizer_channel",
      "network_channel",
      "paid_media",
    ]);
    expect([...USAGE_RIGHTS_OWNERSHIP]).toEqual(["creator_retained"]);
    expect([...USAGE_RIGHTS_EFFECTIVE_STATUSES]).toEqual([
      "ACTIVE",
      "REVOKED",
      "EXPIRED",
    ]);
    expect(CREATOR_ENGAGEMENT_FORMAT).toBe("NET-W017:1");
    expect([...AUTO_ACCEPT_GATE_REASONS]).toEqual([
      "policy_not_auto_accept",
      "policy_not_found",
      "profile_not_active",
      "not_accepting_work",
      "too_many_active_engagements",
      "rate_below_floor",
      "rights_not_auto_grantable",
      "grant_duration_exceeds_policy",
      "active_risk_control",
    ]);
    expect([...PORT_SKIP_REASONS]).toEqual([
      "open_engagement_exists",
      "profile_not_active",
    ]);
    // NET-W017 remediation: the batch saga journal bookkeeping
    // vocabulary (NOT a lifecycle machine — decision-record status).
    expect([...PORT_BATCH_STATUSES]).toEqual([
      "RUNNING",
      "COMPLETED",
      "ABORTED",
    ]);


    // The engagement lifecycle subject kind joins the frozen union.
    const kinds: readonly LifecycleSubjectKind[] = [
      "opportunity",
      "contribution",
      "proof_of_value",
      "outcome_measurement",
      "engagement",
    ];
    expect(kinds).toContain("engagement");

    // UNTOUCHED vocabularies (pin the exact frozen sets).
    expect([...CANONICAL_LIFECYCLE_STATES]).toEqual([
      "DRAFT",
      "READY",
      "ASSIGNED",
      "IN_PROGRESS",
      "SUBMITTED",
      "MEASURING",
      "EVALUATING",
      "CHALLENGE_WINDOW",
      "SETTLING",
      "SETTLED",
      "VERIFIED",
    ]);
    expect([...EXCEPTIONAL_LIFECYCLE_STATES]).toEqual([
      "BLOCKED",
      "FRAUD_REVIEW",
      "DISPUTED",
      "REJECTED",
      "CANCELLED",
    ]);
    expect([...TERMINAL_LIFECYCLE_STATES]).toEqual([
      "VERIFIED",
      "REJECTED",
      "CANCELLED",
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
    expect([...RISK_OPERATION_CLASSES]).toEqual([
      "value_maturation",
      "credit_issuance",
      "reward_allocation",
      "cash_settlement",
      "workflow_transition",
      "participant_eligibility",
    ]);
    expect([...CREATOR_RIGHTS_KINDS]).toEqual([
      "channel_publication",
      "paid_amplification",
      "reuse_license",
      "exclusivity_window",
      "derivative_works",
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
    expect(CREATOR_MATCH_FORMAT).toBe("NET-W016:1");
  });

  test("the engagement transition table is the exhaustive legal matrix with NO terminal sources and NO risk states", () => {
    expect(ENGAGEMENT_TRANSITION_TABLE).toHaveLength(11);
    for (const rule of ENGAGEMENT_TRANSITION_TABLE) {
      expect(["VERIFIED", "REJECTED", "CANCELLED"]).not.toContain(rule.from);
      // No BLOCKED/FRAUD_REVIEW/DISPUTED states: risk escalation is
      // a /disputes case referencing the engagement, not a local
      // lifecycle branch.
      expect(["BLOCKED", "FRAUD_REVIEW", "DISPUTED"]).not.toContain(rule.to);
    }
  });

  test("UGC IS NOT A SECOND LIFECYCLE AUTHORITY: the engagement implementation has NO local transition machinery", async () => {
    const files = [
      "src/creators/engagement-engine.ts",
      "src/creators/engagement-service.ts",
      "src/creators/authority-engagement-repositories.ts",
    ];
    const forbidden: RegExp[] = [
      // /workflows authority (lifecycle mutation) — the sanctioned
      // delegation is the injected requestTransition callback.
      /\bperformTransition\b/,
      /\btransitionWorkflow\b/,
      // Local status machinery (the usage-rights status is DERIVED).
      /\bstatusTransition\s*\(/,
      /\bstatusMachine\s*\(/,
      /\badministrativeStatusTransition\s*\(/,
      // /settlement authority (economic mutation).
      /\bissueCredits?\b/i,
      /\bmatureEconomicValue\b/,
      /\ballocateRewards?\b/i,
      /\brecordCashObligation\b/,
      /\bpostLedgerTransaction\b/,
      // /reputation authority (trust mutation).
      /\bcreateReputationInput\b/,
      /\bcreateReputationSnapshot\b/,
      // /disputes authority (risk mutation).
      /\bcreateRiskSignal\b/,
      /\bcreateSignal\b/,
      /\bsupersedeSignal\b/,
      /\bcreateRiskAssessment\b/,
      /\bcreateRiskCase\b/,
      /\bactivateControl\b/,
      // /outcomes authority (measurement fabrication).
      /\brecordObservation\b/,
      /\bcreateMeasuredOutcome\b/,
      /\bfinalizeMeasurement\b/,
      // Domain→domain imports (tier rule: cross-domain facts arrive
      // through the neutral lookups only).
      /from\s+["']\.\.\/workflows\//,
      /from\s+["']\.\.\/settlement\//,
      /from\s+["']\.\.\/reputation\//,
      /from\s+["']\.\.\/disputes\//,
      /from\s+["']\.\.\/campaigns\//,
      /from\s+["']\.\.\/outcomes\//,
      /from\s+["']\.\.\/evidence\//,
      /from\s+["']\.\.\/opportunities\//,
      /from\s+["']\.\.\/contributions\//,
      /from\s+["']\.\.\/llm\//,
      /from\s+["']\.\.\/agents\//,
      /from\s+["']\.\.\/adapters\//,
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${pattern} found in ${rel}`,
        ).toBe(false);
      }
    }
    // The ONLY lifecycle mutation path is the injected workflow
    // delegation twin (requestTransitionWithinTx — the NET-W017
    // remediation: the material record + transition commit in ONE
    // authoritative transaction), used for acceptance, production
    // open and submission. The BARE requestTransition is
    // structurally ABSENT: a split-transaction composite cannot be
    // reintroduced without tripping this pin.
    const service = await readFile(
      join(REPO, "src/creators/engagement-service.ts"),
      "utf8",
    );
    expect(service).toContain("workflow.requestTransitionWithinTx(");
    expect(service.match(/workflow\.requestTransitionWithinTx\(/g)).toHaveLength(3);
    expect(service).not.toMatch(/workflow\.requestTransition\(/);
  });

  test("STRUCTURAL: the auto-accept evaluation engine has NO AI/advisory input (no code path from model output to acceptance)", async () => {
    const engine = await readFile(
      join(REPO, "src/creators/engagement-engine.ts"),
      "utf8",
    );
    // The evaluation input carries NO advisory field — deterministic
    // policy facts only.
    expect(engine).toMatch(
      /export interface AutoAcceptEvaluationInput\s*\{[\s\S]*?\}/,
    );
    const inputBlock = engine.slice(
      engine.indexOf("export interface AutoAcceptEvaluationInput"),
      engine.indexOf("function gate("),
    );
    expect(inputBlock).not.toMatch(/advisory|llm|model|score\(/i);
    expect(inputBlock).not.toMatch(/provider/i);
    // No AI anywhere in the W017 surface.
    for (const rel of [
      "src/creators/engagement-engine.ts",
      "src/creators/engagement-service.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bLlmPort\b/);
      expect(content).not.toMatch(/\bllmProvider\b/);
      expect(content).not.toMatch(/\bgenerateAdvisory\b/);
    }
    // The llm port's purpose union is UNTOUCHED (no new purpose).
    const llmPort = await readFile(join(REPO, "src/llm/port.ts"), "utf8");
    expect(llmPort).toMatch(
      /readonly purpose: "content_scoring" \| "safety" \| "matching"/,
    );
  });

  test("the composition-root wiring: the SAME workflow service instance + thin read-only lookups", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The engagement lookups are thin READ-ONLY adapters over the
    // owning domains' repositories.
    expect(runtime).toContain("engagementCampaignLookup");
    expect(runtime).toContain("engagementOpportunityLookup");
    expect(runtime).toContain("engagementContributionLookup");
    expect(runtime).toContain("engagementEvidenceLookup");
    // The workflow delegation targets the SAME service instance
    // (the in-tx twin — the remediation's single-transaction
    // composition seam).
    expect(runtime).toMatch(
      /const creatorEngagementService = createCreatorEngagementService\(\{[\s\S]{0,1800}return workflowService\.requestTransitionWithinTx\(/,
    );
    // The workflow service routes the engagement subject kind.
    expect(runtime).toContain("engagementRepository: createLifecycleRepository(engagementRepo)");
    // The evidence subject lookup resolves ugc_production subjects.
    expect(runtime).toMatch(
      /povSubjectLookup[\s\S]{0,900}subjectType === "ugc_production"/,
    );
  });

  test("the ownership boundary is structurally frozen: exactly one contentOwnership assignment from the constant", async () => {
    const service = await readFile(
      join(REPO, "src/creators/engagement-service.ts"),
      "utf8",
    );
    expect(service).toMatch(/contentOwnership:\s*USAGE_RIGHTS_OWNERSHIP\[0\]/);
    // Exactly one assignment FROM the frozen constant; no assignment
    // ever sources an input field (the audit metadata only READS the
    // record's stored value).
    expect(
      service.match(/contentOwnership:\s*USAGE_RIGHTS_OWNERSHIP\[0\]/g),
    ).toHaveLength(1);
    expect(service).not.toMatch(/contentOwnership:\s*input\./);
  });

  test("no sponsorship/disclosure or ad-inventory execution leaked into the W017 boundary (NET-W018/W019 stay out of scope)", async () => {
    const files = [
      "src/creators/engagement-engine.ts",
      "src/creators/engagement-service.ts",
      "src/creators/authority-engagement-repositories.ts",
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bissueSponsorship\b/);
      expect(content).not.toMatch(/\brecordDisclosure\b/);
      expect(content).not.toMatch(/\bcreatePlacement\b/);
      expect(content).not.toMatch(/\bserveAd\b/i);
    }
  });

  test("the NET-W017 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W017.md",
      "src/creators/engagement-engine.ts",
      "src/creators/engagement-service.ts",
      "src/creators/authority-engagement-repositories.ts",
      "tests/creators/_net-w017-harness.ts",
      "tests/creators/net-w017-ac-01-workflow-lifecycle.test.ts",
      "tests/creators/net-w017-ac-02-production-lineage.test.ts",
      "tests/creators/net-w017-ac-03-usage-rights.test.ts",
      "tests/creators/net-w017-ac-04-ownership-boundary.test.ts",
      "tests/creators/net-w017-ac-05-evidence-integration.test.ts",
      "tests/creators/net-w017-ac-06-provider-neutrality.test.ts",
      "tests/creators/net-w017-ac-08-tenancy-idempotency.test.ts",
      "tests/creators/net-w017-remediation-composite-atomicity.test.ts",
      "tests/regression/net-w017-ac-07-architecture-out-of-scope.test.ts",
      "docs/net-w017-ugc-workflow-rights.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W017", async () => {
    const secretPatterns: RegExp[] = [
      /github_pat_[A-Za-z0-9_]+/,
      /ghp_[A-Za-z0-9]+/,
      /sk-[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const files = [
      "src/creators/engagement-engine.ts",
      "src/creators/engagement-service.ts",
      "src/creators/authority-engagement-repositories.ts",
      "src/core/creators.ts",
      "src/core/workflow.ts",
      "src/workflows/transition-table.ts",
      "src/workflows/workflow-service.ts",
      "src/workflows/port.ts",
      "src/creators/port.ts",
      "src/bootstrap/runtime.ts",
      "src/api/server.ts",
      "src/api/port.ts",
      "tests/creators/_net-w017-harness.ts",
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
