/**
 * NET-W021-AC-07 — architecture/out-of-scope regression (issue #42).
 *
 * NET-W021 ships INSIDE the frozen `/campaigns` boundary (NO 17th
 * domain; the architecture-lock domain list is unchanged —
 * architecture.md §18/§7 + architecture-lock.md §2 both already name
 * `/campaigns`). The new matching vocabulary is additive; every other
 * frozen vocabulary is UNCHANGED. Matching is SELECTION, not
 * authority: no campaign, inventory, workflow, settlement,
 * reputation, risk or outcome mutation surface exists in the matching
 * implementation (structural pins). The /outcomes change is a
 * READ-ONLY addition (the verified-performance read); the measured-
 * outcome lifecycle and transition table are untouched. The advisory
 * is provider-neutral (AI-002 "matching" + AI-003 "safety"), bounded
 * and structurally unable to flip eligibility. No attribution/privacy
 * adapters (NET-W022), no OpenRTB (NET-W023), no auto-execution of
 * matches.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_OBJECTIVE_KINDS,
  CAMPAIGN_ELIGIBILITY_ATTRIBUTES,
  CAMPAIGN_ELIGIBILITY_OPERATORS,
  CAMPAIGN_EVIDENCE_REQUIREMENT_KINDS,
  CAMPAIGN_CLEARING_BASES,
  CAMPAIGN_CLEARING_DRAW_KINDS,
  CAMPAIGN_DISCLOSURE_KINDS,
  CAMPAIGN_POLICY_FORMAT,
  CAMPAIGN_MATCH_SIGNALS,
  CAMPAIGN_MATCH_GATE_REASONS,
  CAMPAIGN_MATCH_FORMAT,
  CAMPAIGN_MATCH_WEIGHT_SUM,
  CAMPAIGN_MATCH_ADVISORY_MAX_BLEND,
  CAMPAIGN_MATCH_MAX_CANDIDATES,
  CAMPAIGN_MATCH_DEFAULT_WEIGHTS,
  CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE,
} from "../../src/core/campaigns.ts";
import { CAMPAIGN_EVENTS as PORT_EVENTS } from "../../src/campaigns/port.ts";
import { RISK_OPERATION_CLASSES } from "../../src/core/risk.ts";
import { REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";
import { INVENTORY_SURFACE_KINDS, INVENTORY_FORMATS } from "../../src/core/inventory.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

describe("NET-W021-AC-07 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W021 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThanOrEqual(267);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /campaigns was already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/campaigns`");
    // NET-W021 adds NO boundary (matching lives in /campaigns).
    expect(lock).not.toContain("- `/optimization`");
    expect(lock).not.toContain("- `/campaign-matching`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
  });

  test("the NET-W021 work order exists and binds to frozen Architecture v1.0 + Issue #42", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W021.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("CAMP-001");
    expect(workOrder).toContain("AI-002");
    expect(workOrder).toContain("AI-003");
    expect(workOrder).toContain("#42");
    expect(workOrder).toContain("Campaign matching and optimization");
    // The selection-not-authority decision of record.
    expect(workOrder).toContain("selection, not authority");
    expect(workOrder).toContain("hard eligibility gates");
    expect(workOrder).toContain("evidence-backed");
  });

  test("the new matching vocabulary is pinned; every other frozen vocabulary is UNCHANGED", async () => {
    // The NEW NET-W021 vocabulary (additive to core/campaigns.ts).
    expect([...CAMPAIGN_MATCH_SIGNALS]).toEqual([
      "alignment",
      "performance",
      "standing",
      "reliability",
      "risk",
      "coverage",
    ]);
    expect([...CAMPAIGN_MATCH_GATE_REASONS]).toEqual([
      "campaign_not_publishable",
      "policy_version_unresolved",
      "policy_scope_out_of_tenant",
      "item_out_of_scope",
      "item_retired",
      "supply_not_verified",
      "eligibility_rules_not_satisfied",
      "format_not_targeted",
      "surface_kind_not_targeted",
      "territory_not_reached",
      "language_not_supported",
      "owner_risk_control",
    ]);
    expect(CAMPAIGN_MATCH_FORMAT).toBe("NET-W021:1");
    expect(CAMPAIGN_MATCH_WEIGHT_SUM).toBe(100);
    expect(CAMPAIGN_MATCH_ADVISORY_MAX_BLEND).toBe(0.25);
    expect(CAMPAIGN_MATCH_MAX_CANDIDATES).toBe(200);
    expect(CAMPAIGN_MATCH_DEFAULT_WEIGHTS).toEqual({
      alignment: 25,
      performance: 30,
      standing: 15,
      reliability: 10,
      risk: 10,
      coverage: 10,
    });
    expect(CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE).toEqual({
      publisher: "inventory_quality",
      app: "inventory_quality",
      creator: "creator_performance",
    });

    // UNTOUCHED vocabularies (pin the exact frozen sets).
    expect([...CAMPAIGN_STATUSES]).toEqual([
      "DRAFT",
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ]);
    expect([...CAMPAIGN_OBJECTIVE_KINDS]).toEqual([
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
    expect([...CAMPAIGN_ELIGIBILITY_ATTRIBUTES]).toEqual([
      "participant_class",
      "region",
      "language",
      "contribution_type",
      "evidence_grade",
      "measurement_kind",
    ]);
    expect([...CAMPAIGN_ELIGIBILITY_OPERATORS]).toEqual([
      "equals",
      "not_equals",
      "in",
      "not_in",
      "gte",
      "lte",
    ]);
    expect([...PORT_EVENTS]).toEqual([
      "created",
      "policy_defined",
      "activated",
      "paused",
      "resumed",
      "completed",
      "cancelled",
      "budget_committed",
      "budget_released",
      "opportunity_published",
      "clearing_executed",
    ]);
    expect([...CAMPAIGN_EVIDENCE_REQUIREMENT_KINDS]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence_record",
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
    expect([...CAMPAIGN_DISCLOSURE_KINDS]).toEqual([
      "material_connection",
      "paid_partnership",
      "gifted_product",
      "genuine_experience",
      "brand_affiliation",
    ]);
    expect(CAMPAIGN_POLICY_FORMAT).toBe("NET-W011:1");
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
    expect([...INVENTORY_SURFACE_KINDS]).toEqual([
      "publisher",
      "app",
      "creator",
    ]);
    expect([...INVENTORY_FORMATS]).toEqual([
      "display",
      "video",
      "audio",
      "native",
      "sponsored_content",
    ]);
  });

  test("MATCHING IS SELECTION, NOT AUTHORITY: the matching implementation has NO campaign/inventory/workflow/settlement/reputation/risk/outcome mutation surface", async () => {
    const matchingFiles = [
      "src/campaigns/matching-engine.ts",
      "src/campaigns/matching-service.ts",
      "src/campaigns/authority-match-run-repository.ts",
    ];
    const forbidden: RegExp[] = [
      // /workflows authority (lifecycle mutation).
      /\bperformTransition\b/,
      /\btransitionWorkflow\b/,
      // /campaigns authority (campaign record mutation — the
      // matching service only READS its own domain).
      /\bactivateCampaign\b/,
      /\bdefineCampaignPolicy\b/,
      /\brecordBudgetCommitment\b/,
      /\brecordBudgetRelease\b/,
      /\brecordClearingExecution\b/,
      /\brecordOpportunityPublication\b/,
      // /inventory authority (supply/placement mutation).
      /\bregisterInventoryItem\b/,
      /\bretireInventoryItem\b/,
      /\battachSupplyVerification\b/,
      /\bcreatePlacement\b/,
      /\bretirePlacement\b/,
      // /settlement authority (economic mutation).
      /\bissueCredits?\b/i,
      /\brecordPendingValue\b/,
      /\bmatureEconomicValue\b/,
      /\ballocateRewards?\b/i,
      /\brecordCashObligation\b/,
      /\bpostLedgerTransaction\b/,
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
      // /outcomes authority (measurement mutation — matching only
      // READS verified outcomes).
      /\bcreateMeasuredOutcome\b/,
      /\bcreateOutcomeObservation\b/,
      /\bbeginMaturation\b/,
      /\brecordMeasurementRollup\b/,
      /\bfinalizeMeasurement\b/,
      // Domain→domain imports (tier rule: cross-domain facts arrive
      // through the neutral lookups only).
      /from\s+["']\.\.\/workflows\//,
      /from\s+["']\.\.\/settlement\//,
      /from\s+["']\.\.\/reputation\//,
      /from\s+["']\.\.\/disputes\//,
      /from\s+["']\.\.\/inventory\//,
      /from\s+["']\.\.\/creators\//,
      /from\s+["']\.\.\/outcomes\//,
      /from\s+["']\.\.\/llm\//,
      /from\s+["']\.\.\/agents\//,
    ];
    for (const rel of matchingFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `Out-of-scope pattern ${String(pattern)} found in ${rel}`,
        ).toBe(false);
      }
    }
    // The ONLY audit event type the matching service emits is
    // campaign_match.recorded (one const, one append site).
    const service = await readFile(
      join(REPO, "src/campaigns/matching-service.ts"),
      "utf8",
    );
    expect(service).toContain(
      'const CAMPAIGN_MATCH_RECORDED = "campaign_match.recorded" as const',
    );
    expect(service.match(/eventType: CAMPAIGN_MATCH_RECORDED/g)).toHaveLength(1);
  });

  test("STRUCTURAL: neither advisory can ever reach the eligibility evaluator (no code path from advisory output to a verdict)", async () => {
    const engine = await readFile(
      join(REPO, "src/campaigns/matching-engine.ts"),
      "utf8",
    );
    // The eligibility evaluator's signature carries NO advisory
    // parameter — hard restrictions cannot be overridden by model
    // ranking because no advisory value can reach this code.
    expect(engine).toMatch(
      /export function evaluateEligibility\(\s*facts: CampaignMatchCandidateFacts,\s*targeting: CampaignMatchTargeting,\s*\): CampaignMatchEligibility/,
    );
    // The advisory blends appear ONLY in applyAdvisoryBlends, never
    // in the eligibility path (the slice ends at the §3.2 section
    // banner, BEFORE scoreBaselineSignals' doc comment).
    const eligibilityBlock = engine.slice(
      engine.indexOf("export function evaluateEligibility"),
      engine.indexOf("// Evidence-backed feature extraction"),
    );
    expect(eligibilityBlock).not.toMatch(/advisory/i);
    // The service consults BOTH advisories ONLY after the eligibility
    // verdict exists (the exclusion happens first).
    const service = await readFile(
      join(REPO, "src/campaigns/matching-service.ts"),
      "utf8",
    );
    const eligibilityIndex = service.indexOf(
      "evaluateEligibility(facts, effectiveTargeting),",
    );
    const advisoryIndex = service.indexOf("await advisory.assessMatching(");
    const riskAdvisoryIndex = service.indexOf("await advisory.assessRisk(");
    expect(eligibilityIndex).toBeGreaterThanOrEqual(0);
    expect(advisoryIndex).toBeGreaterThan(eligibilityIndex);
    expect(riskAdvisoryIndex).toBeGreaterThan(eligibilityIndex);
  });

  test("the composition-root wiring is provider-neutral and read-only (LlmPort purposes 'matching' + 'safety'; the inventory engine is THE eligibility-semantics authority)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The adapters over the provider-neutral port: AI-002 (matching)
    // + AI-003 (risk/safety).
    const w021Section = runtime.slice(
      runtime.indexOf("NET-W021 — Campaign matching and optimization"),
      runtime.indexOf("NET-W009 §3.7 ECONOMIC GATE"),
    );
    expect(w021Section).toContain('purpose: "matching"');
    expect(w021Section).toContain('purpose: "safety"');
    // The matching lookups are thin READ-ONLY adapters.
    expect(w021Section).toContain("campaignMatchSupplyLookup");
    expect(w021Section).toContain("campaignMatchReputationLookup");
    expect(w021Section).toContain("campaignMatchSafetyLookup");
    expect(w021Section).toContain("campaignMatchOutcomeLookup");
    // The safety read uses the participant_eligibility control class.
    expect(w021Section).toMatch(
      /campaignMatchSafetyLookup[\s\S]{0,900}participant_eligibility/,
    );
    // The policy-rule evaluation delegates to the /inventory pure
    // engine (the W019 eligibility semantics authority).
    expect(w021Section).toContain("evaluatePlacementEligibility(");
    // The supply-lookup adapter NEVER consults wall-clock time: the
    // inventory rule engine receives the run's EXPLICIT deterministic
    // evaluation anchor (the PR #43 review fix — no implicit
    // nondeterministic dependency at the matching boundary).
    const supplyLookupSection = runtime.slice(
      runtime.indexOf("const campaignMatchSupplyLookup"),
      runtime.indexOf("const campaignMatchReputationLookup"),
    );
    expect(supplyLookupSection).not.toContain("new Date(");
    expect(supplyLookupSection).toContain("evaluatedAt");
    // The matching service derives ONE anchor per run at the service
    // boundary (recorded on the decision) and passes it to every
    // rule evaluation — the only wall-clock consult in the W021 path.
    const matchingService = await readFile(
      join(REPO, "src/campaigns/matching-service.ts"),
      "utf8",
    );
    expect(matchingService).toContain(
      "const evaluatedAt = new Date().toISOString()",
    );
    expect(
      matchingService.match(/new Date\(\)/g)?.length ?? 0,
    ).toBeLessThanOrEqual(2);
    // The outcomes lookup consumes the /outcomes authority's
    // verified-performance read.
    expect(w021Section).toContain(
      "listVerifiedMeasuredOutcomesBySubject",
    );
    // The llm port's purpose union carries both purposes.
    const llmPort = await readFile(join(REPO, "src/llm/port.ts"), "utf8");
    expect(llmPort).toMatch(
      /readonly purpose: "content_scoring" \| "safety" \| "matching"/,
    );
    // The measurement subject lookup recognizes inventory-item
    // subjects (the W019 PoV-lookup precedent — read-only).
    const subjectLookupSection = runtime.slice(
      runtime.indexOf("const measurementSubjectLookup"),
      runtime.indexOf("const outcomeClaimLookup"),
    );
    expect(subjectLookupSection).toContain('"inventory_item"');
    expect(subjectLookupSection).toContain("inventoryItemRepo.findById");
  });

  test("the /outcomes change is READ-ONLY: the measured-outcome lifecycle + transition table are untouched; only the verified read was added", async () => {
    // The transition table is byte-identical to the frozen W006
    // matrix (pin its shape — 4 transition rules).
    expect(OUTCOME_MEASUREMENT_TRANSITION_TABLE.length).toBe(4);
    const service = await readFile(
      join(REPO, "src/outcomes/measured-outcome-service.ts"),
      "utf8",
    );
    // The additive read filters VERIFIED (the lifecycle semantics
    // stay in the authority).
    expect(service).toContain(
      "listVerifiedMeasuredOutcomesBySubject",
    );
    const readBlock = service.slice(
      service.indexOf("async listVerifiedMeasuredOutcomesBySubject"),
      service.indexOf("async createMeasuredOutcome"),
    );
    expect(readBlock).toContain('m.state === "VERIFIED"');
    // No new mutation surface in the outcomes boundary (the measured
    // outcome repository additions are reads only).
    const repo = await readFile(
      join(REPO, "src/outcomes/authority-measured-outcome-repository.ts"),
      "utf8",
    );
    const listBlock = repo.slice(
      repo.indexOf("async listBySubject"),
      repo.indexOf("async findByIdWithinTx"),
    );
    expect(listBlock).toContain("authority.scan");
    // The W006 transition-matrix artifact remains.
    expect(
      existsSync(
        join(REPO, "docs/net-w006-measured-outcome-transition-matrix.md"),
      ),
    ).toBe(true);
  });

  test("no attribution/OpenRTB adapter or auto-execution leaked into the W021 implementation (NET-W022/W023 are later)", async () => {
    const files = [
      "src/campaigns/matching-engine.ts",
      "src/campaigns/matching-service.ts",
      "src/campaigns/authority-match-run-repository.ts",
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bopenrtb\b/i);
      expect(content).not.toMatch(/\bOpenRTB\b/);
      expect(content).not.toMatch(/\badsTxt\b/i);
      expect(content).not.toMatch(/\bsellersJson\b/i);
      expect(content).not.toMatch(/\battributionAdapter\b/i);
      // No match auto-execution: a run NEVER creates a placement or
      // an engagement (the caller decides).
      expect(content).not.toMatch(/\bautoPlace\b/i);
      expect(content).not.toMatch(/\bautoAccept\b/i);
    }
  });

  test("the NET-W021 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W021.md",
      "src/campaigns/matching-engine.ts",
      "src/campaigns/matching-service.ts",
      "src/campaigns/authority-match-run-repository.ts",
      "tests/campaigns/_net-w021-harness.ts",
      "tests/campaigns/net-w021-ac-01-hard-gates.test.ts",
      "tests/campaigns/net-w021-ac-02-evidence-ranking.test.ts",
      "tests/campaigns/net-w021-ac-03-advisory-non-authority.test.ts",
      "tests/campaigns/net-w021-ac-04-optimization-adversarial.test.ts",
      "tests/campaigns/net-w021-ac-05-selection-not-authority.test.ts",
      "tests/campaigns/net-w021-ac-06-tenancy-idempotency-contract.test.ts",
      "tests/regression/net-w021-ac-07-architecture-out-of-scope.test.ts",
      "docs/net-w021-campaign-matching-optimization.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W021 files", async () => {
    const SECRET_VALUE_PATTERN =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    const files = await (await import("node:fs/promises")).readdir(
      join(SRC, "campaigns"),
    );
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const content = await readFile(join(SRC, "campaigns", file), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${file} must be secret-free`).toBe(
        false,
      );
    }
    const core = await readFile(join(SRC, "core/campaigns.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(core)).toBe(false);
  });
});
