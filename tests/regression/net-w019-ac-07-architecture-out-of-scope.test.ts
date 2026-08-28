/**
 * NET-W019-AC-07 — architecture/out-of-scope regression.
 *
 * NET-W019 ships INSIDE the frozen `/inventory` boundary — one of
 * the SIXTEEN frozen core domains since NET-W001 (architecture.md
 * §18/§7 + architecture-lock.md §2 both already name `/inventory`;
 * the W001 skeleton deferred concrete behaviour to NET-W019). NO
 * 17th domain is created; the architecture-lock domain list is
 * UNCHANGED. Items and placements carry NO lifecycle subject kind —
 * `/workflows` is COMPLETELY UNTOUCHED (the subject-kind union, every
 * transition table, the sanction vocabulary and the generic
 * transition surface are pinned UNCHANGED). No second lifecycle
 * engine, no economic/reputation/risk/outcome mutation surface, NO
 * AI path, no parallel evidence/settlement authority, provider-
 * neutral external references only, and no cross-promotion
 * clearing / campaign optimization / attribution adapters / OpenRTB /
 * payment execution (the issue #37 non-goals — NET-W020+ / NET-W022+
 * / later phases).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { CAMPAIGN_POLICY_FORMAT } from "../../src/core/campaigns.ts";
import {
  INVENTORY_FORMATS,
  INVENTORY_SURFACE_KINDS,
  INVENTORY_ITEM_FORMAT,
  PLACEMENT_RECORD_FORMAT,
  INVENTORY_MAX_TERRITORIES,
  INVENTORY_MAX_LANGUAGES,
} from "../../src/core/inventory.ts";
import {
  CANONICAL_LIFECYCLE_STATES,
  EXCEPTIONAL_LIFECYCLE_STATES,
  TERMINAL_LIFECYCLE_STATES,
  WORKFLOW_TRANSITION_SANCTIONS,
  type LifecycleSubjectKind,
} from "../../src/core/workflow.ts";
import {
  ENGAGEMENT_TRANSITION_TABLE,
  PUBLICATION_TRANSITION_TABLE,
  PUBLICATION_SANCTIONED_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

describe("NET-W019-AC-07 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W019 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(260);
  });

  test("THE NO-17TH-DOMAIN PIN: spec/architecture.md and spec/architecture-lock.md remain FROZEN with /inventory ALREADY among the sixteen", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/inventory`");
    // NET-W019 adds NO boundary (supply registration and placement
    // context live in the ALREADY-FROZEN /inventory domain; the
    // campaign policy scope arrives through the neutral lookup; the
    // settlement gate is derived).
    expect(lock).not.toContain("- `/placements`");
    expect(lock).not.toContain("- `/supply`");
    expect(lock).not.toContain("- `/advertising`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // The frozen module-ownership row that names /inventory.
    expect(arch).toContain("`/campaigns`, `/inventory`, `/creators`");
  });

  test("the NET-W019 work order exists and binds to frozen Architecture v1.0 + Issue #37", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W019.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("INV-001");
    expect(workOrder).toContain("INV-002");
    expect(workOrder).toContain("INV-003");
    expect(workOrder).toContain("INV-004");
    expect(workOrder).toContain("CAMP-003");
    expect(workOrder).toContain("CAMP-004");
    expect(workOrder).toContain("#37");
    expect(workOrder).toContain("Inventory and placements");
    // The decisions of record.
    expect(workOrder).toContain("NO 17th domain");
    expect(workOrder).toContain("THE SETTLEMENT GATE");
    expect(workOrder).toContain("derived");
    expect(workOrder).toContain("ONE authoritative transaction");
  });

  test("the NET-W019 vocabulary is pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W019 vocabularies (additive).
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
    expect(INVENTORY_ITEM_FORMAT).toBe("NET-W019:1");
    expect(PLACEMENT_RECORD_FORMAT).toBe("NET-W019:1");
    expect(INVENTORY_MAX_TERRITORIES).toBe(40);
    expect(INVENTORY_MAX_LANGUAGES).toBe(20);

    // The campaign policy format lineage is UNCHANGED (W019 adds NO
    // campaign-policy section — placements only REFERENCE the
    // versioned policy through the neutral lookup).
    expect(CAMPAIGN_POLICY_FORMAT).toBe("NET-W011:1");

    // /workflows is COMPLETELY UNTOUCHED: NO inventory lifecycle
    // subject kind joins the frozen union (the W019 decision of
    // record — items and placements carry NO lifecycle state).
    const kinds: readonly LifecycleSubjectKind[] = [
      "opportunity",
      "contribution",
      "proof_of_value",
      "outcome_measurement",
      "engagement",
      "publication",
    ];
    expect(kinds).not.toContain("inventory_item");
    expect(kinds).not.toContain("placement");

    // UNTOUCHED vocabularies (pin the exact frozen sets — the state
    // universe is unchanged by W019).
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
    // The transition tables are UNTOUCHED (the W017/W018 pins).
    expect(ENGAGEMENT_TRANSITION_TABLE).toHaveLength(11);
    expect(PUBLICATION_TRANSITION_TABLE).toHaveLength(1);
    expect(PUBLICATION_SANCTIONED_TRANSITION_TABLE).toHaveLength(1);
    // The sanction vocabulary is UNCHANGED (no inventory sanction
    // exists — no sanctioned edge is needed because no lifecycle
    // transition exists).
    expect([...WORKFLOW_TRANSITION_SANCTIONS]).toEqual([
      "creators.publication-verification",
    ]);
  });

  test("INVENTORY IS NOT A SECOND LIFECYCLE AUTHORITY: the implementation has NO transition machinery and NEVER touches /workflows", async () => {
    const files = [
      "src/inventory/port.ts",
      "src/inventory/eligibility-engine.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/authority-inventory-repositories.ts",
    ];
    const forbidden: RegExp[] = [
      // /workflows authority (lifecycle mutation + subject kinds).
      /\bperformTransition\b/,
      /\btransitionWorkflow\b/,
      /\brequestTransition\b/,
      /\brequestTransitionWithinTx\b/,
      /\bLifecycleSubject\b/,
      /\bLifecycleSubjectKind\b/,
      /\bTransitionRequest\b/,
      /\bTransitionResult\b/,
      // Local status machinery (the guard's allowlist discipline).
      /\bstatusTransition\s*\(/,
      /\bstatusMachine\s*\(/,
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
      /from\s+["']\.\.\/creators\//,
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
  });

  test("NO PARALLEL EVIDENCE AUTHORITY: the eligibility engine is PURE and the boundary fabricates no evidence", async () => {
    const engine = await readFile(
      join(REPO, "src/inventory/eligibility-engine.ts"),
      "utf8",
    );
    // Pure derivation only — no persistence, no IO.
    expect(engine).not.toMatch(/\bauthority\b/i);
    expect(engine).not.toMatch(/async\s+\w+\s*\(/);
    const service = await readFile(
      join(REPO, "src/inventory/inventory-service.ts"),
      "utf8",
    );
    // The service VALIDATES evidence references through the neutral
    // lookup only (never creates evidence records).
    expect(service).not.toMatch(/\bcreateEvidence\b/);
    expect(service).not.toMatch(/\bgradeEvidence\b/i);
    expect(service).not.toMatch(/\bcreateAttestation\b/);
  });

  test("NO AI PATH: no code path from model output to inventory/placement decisions", async () => {
    for (const rel of [
      "src/inventory/eligibility-engine.ts",
      "src/inventory/inventory-service.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bLlmPort\b/);
      expect(content).not.toMatch(/\bllmProvider\b/);
      expect(content).not.toMatch(/\bgenerateAdvisory\b/);
      expect(content).not.toMatch(/advisoryInput/);
      expect(content).not.toMatch(/advisoryAssessment/);
      expect(content).not.toMatch(/modelOutput/);
    }
    // The llm port's purpose union is UNTOUCHED (no new purpose).
    const llmPort = await readFile(join(REPO, "src/llm/port.ts"), "utf8");
    expect(llmPort).toMatch(
      /readonly purpose: "content_scoring" \| "safety" \| "matching"/,
    );
  });

  test("NO SETTLEMENT BYPASS: the inventory boundary carries no economic surface (INV-004 structural pins)", async () => {
    for (const rel of [
      "src/inventory/port.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/authority-inventory-repositories.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic mutation surface exists in the boundary.
      expect(content).not.toMatch(/\bissueCredits?\b/i);
      expect(content).not.toMatch(/\ballocateRewards?\b/i);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\bpostLedgerTransaction\b/);
      expect(content).not.toMatch(/\bmatureEconomicValue\b/);
      expect(content).not.toMatch(/\bexecutePayment\b/i);
      expect(content).not.toMatch(/\bprocessPayout\b/i);
      // No balances or postings fields on the records.
      expect(content).not.toMatch(/\bbalance\b/i);
      expect(content).not.toMatch(/\bposting\b/i);
    }
    // The derived readiness is the ONLY settlement-relevant surface:
    // the service exposes getPlacementSettlementReadiness and NO
    // command that asserts, stores or waives readiness.
    const service = await readFile(
      join(REPO, "src/inventory/inventory-service.ts"),
      "utf8",
    );
    expect(service).toContain("getPlacementSettlementReadiness");
    expect(service).not.toMatch(/\bsettlePlacement\b/);
    expect(service).not.toMatch(/\bmarkSettlementEligible\b/);
    expect(service).not.toMatch(/\bassertSettlementReadiness\b/);
  });

  test("the composition-root wiring: thin read-only lookups + the inventory service + the inventory_item evidence subject binding", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The inventory lookups are thin READ-ONLY adapters over the
    // OWNING domains' repositories (campaigns + evidence).
    expect(runtime).toContain("inventoryCampaignLookup");
    expect(runtime).toContain("inventoryEvidenceLookup");
    // The campaign lookup resolves the policy scope through the
    // campaigns repos (the dependency-inversion seam).
    expect(runtime).toMatch(
      /const inventoryCampaignLookup: InventoryCampaignLookup = \{[\s\S]{0,900}campaignRepo\.findById\(/,
    );
    // The evidence lookup resolves through the evidence repository.
    expect(runtime).toMatch(
      /const inventoryEvidenceLookup: InventoryEvidenceLookup = \{[\s\S]{0,400}evidenceRepo\.findById\(/,
    );
    // The service wiring.
    expect(runtime).toMatch(
      /const inventoryService = createInventoryService\(\{[\s\S]{0,500}itemRepository: inventoryItemRepo,/,
    );
    // The evidence subject lookup resolves INVENTORY ITEM subjects
    // (the INV-003 supply-verification signal).
    expect(runtime).toMatch(
      /povSubjectLookup[\s\S]{0,2200}subjectType === "inventory_item"/,
    );
  });

  test("no cross-promotion clearing, optimization, attribution adapters, OpenRTB or payment execution leaked into the W019 boundary", async () => {
    for (const rel of [
      "src/inventory/port.ts",
      "src/inventory/eligibility-engine.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/authority-inventory-repositories.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      // The issue #37 explicit non-goals (NET-W020+/NET-W022+/later).
      expect(content).not.toMatch(/crossPromotion|cross_promotion/i);
      expect(content).not.toMatch(/\bclearValue\b/i);
      expect(content).not.toMatch(/\boptimize\b/i);
      expect(content).not.toMatch(/\brankCandidates\b/i);
      expect(content).not.toMatch(/openrtb/i);
      expect(content).not.toMatch(/\bserveAd\b/i);
      expect(content).not.toMatch(/\bexecutePayment\b/i);
      expect(content).not.toMatch(/\bprocessPayout\b/i);
      expect(content).not.toMatch(/\bdemandPool\b/i);
      expect(content).not.toMatch(/\bprocurement\b/i);
      expect(content).not.toMatch(/\bbenefitPool\b/i);
    }
  });

  test("the NET-W019 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W019.md",
      "src/core/inventory.ts",
      "src/inventory/port.ts",
      "src/inventory/eligibility-engine.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/authority-inventory-repositories.ts",
      "src/inventory/module.ts",
      "src/inventory/README.md",
      "tests/inventory/_net-w019-harness.ts",
      "tests/inventory/net-w019-ac-01-inventory-records.test.ts",
      "tests/inventory/net-w019-ac-02-placement-context.test.ts",
      "tests/inventory/net-w019-ac-03-supply-authorization.test.ts",
      "tests/inventory/net-w019-ac-04-settlement-gate.test.ts",
      "tests/inventory/net-w019-ac-05-provider-neutrality.test.ts",
      "tests/inventory/net-w019-ac-06-tenancy-idempotency.test.ts",
      "tests/inventory/net-w019-inventory-atomicity.test.ts",
      "tests/regression/net-w019-ac-07-architecture-out-of-scope.test.ts",
      "docs/net-w019-inventory-placements.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });
});
