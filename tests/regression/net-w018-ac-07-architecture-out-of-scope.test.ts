/**
 * NET-W018-AC-07 — architecture/out-of-scope regression.
 *
 * NET-W018 ships INSIDE the frozen `/creators` + `/campaigns` +
 * `/workflows` boundaries (NO 17th domain; the architecture-lock
 * domain list is unchanged) with ONE new canonical lifecycle subject
 * kind (`publication`) whose transitions live in `/workflows` — the
 * SOLE lifecycle authority. The new vocabulary is additive; every
 * other frozen vocabulary is UNCHANGED (the canonical lifecycle
 * state lists are pinned exactly — W018 REUSES the canonical states
 * per the W005/W006 precedent). No second lifecycle engine, no
 * economic/reputation/risk/outcome mutation surface, NO AI path, no
 * parallel evidence/settlement authority, provider-neutral external
 * references only, and no ad-inventory/payment execution (the
 * NET-W019+/non-goal fence).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { CAMPAIGN_DISCLOSURE_KINDS, CAMPAIGN_POLICY_FORMAT } from "../../src/core/campaigns.ts";
import {
  COMMERCIAL_RELATIONSHIP_KINDS,
  COMMERCIAL_RELATIONSHIP_FORMAT,
  DISCLOSURE_DECLARATION_FORMAT,
  PUBLICATION_RECORD_FORMAT,
} from "../../src/core/creators.ts";
import {
  CANONICAL_LIFECYCLE_STATES,
  EXCEPTIONAL_LIFECYCLE_STATES,
  TERMINAL_LIFECYCLE_STATES,
  PUBLICATION_VERIFICATION_SANCTION,
  WORKFLOW_TRANSITION_SANCTIONS,
  IllegalTransitionError,
  type LifecycleSubjectKind,
} from "../../src/core/workflow.ts";
import {
  ENGAGEMENT_TRANSITION_TABLE,
  PUBLICATION_TRANSITION_TABLE,
  PUBLICATION_SANCTIONED_TRANSITION_TABLE,
  findRule,
  findSanctionedRule,
  sanctionRequiredFor,
  legalTargets,
} from "../../src/workflows/transition-table.ts";
import { evaluateTransition } from "../../src/workflows/state-machine.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

describe("NET-W018-AC-07 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W018 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(250);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /creators, /campaigns, /workflows, /evidence, /settlement were already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/creators`");
    expect(lock).toContain("- `/campaigns`");
    expect(lock).toContain("- `/workflows`");
    expect(lock).toContain("- `/evidence`");
    expect(lock).toContain("- `/settlement`");
    // NET-W018 adds NO boundary (commercial relationships,
    // declarations and publications live in /creators; the disclosure
    // policy lives in /campaigns; the publication lifecycle lives in
    // /workflows).
    expect(lock).not.toContain("- `/sponsorships`");
    expect(lock).not.toContain("- `/disclosures`");
    expect(lock).not.toContain("- `/publications`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // The user-controlled publication stance (HELP-005/CRE-004
    // context) remains the frozen architecture statement.
    expect(arch).toContain(
      "public posting remains a user-controlled action",
    );
  });

  test("the NET-W018 work order exists and binds to frozen Architecture v1.0 + Issue #35", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W018.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("CRE-006");
    expect(workOrder).toContain("DISC-001");
    expect(workOrder).toContain("DISC-002");
    expect(workOrder).toContain("#35");
    expect(workOrder).toContain("Sponsorship and disclosure");
    // The decisions of record.
    expect(workOrder).toContain("THE DISCLOSURE GATE");
    expect(workOrder).toContain("durable records");
    expect(workOrder).toContain("ONE authoritative transaction");
    expect(workOrder).toContain("REFERENCE DATA ONLY");
  });

  test("the NET-W018 vocabulary is pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W018 vocabularies (additive).
    expect([...CAMPAIGN_DISCLOSURE_KINDS]).toEqual([
      "material_connection",
      "paid_partnership",
      "gifted_product",
      "genuine_experience",
      "brand_affiliation",
    ]);
    expect([...COMMERCIAL_RELATIONSHIP_KINDS]).toEqual([
      "sponsorship",
      "paid_placement",
      "gifted_product",
      "brand_ambassador",
    ]);
    expect(COMMERCIAL_RELATIONSHIP_FORMAT).toBe("NET-W018:1");
    expect(DISCLOSURE_DECLARATION_FORMAT).toBe("NET-W018:1");
    expect(PUBLICATION_RECORD_FORMAT).toBe("NET-W018:1");
    // The campaign policy format lineage is UNCHANGED (the
    // disclosure section is additive-with-default — format
    // compatible; pre-W018 versions read as empty).
    expect(CAMPAIGN_POLICY_FORMAT).toBe("NET-W011:1");

    // The publication lifecycle subject kind joins the frozen union.
    const kinds: readonly LifecycleSubjectKind[] = [
      "opportunity",
      "contribution",
      "proof_of_value",
      "outcome_measurement",
      "engagement",
      "publication",
    ];
    expect(kinds).toContain("publication");

    // UNTOUCHED vocabularies (pin the exact frozen sets — W018 REUSES
    // the canonical states; the state universe is unchanged).
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
    // The engagement table is UNTOUCHED (11 rules — the W017 pin).
    expect(ENGAGEMENT_TRANSITION_TABLE).toHaveLength(11);
  });

  test("the publication GENERIC transition table is the exhaustive legal matrix with NO verification edge, NO terminal sources and NO risk states", () => {
    // The PR #36 remediation pin (architect CHANGES REQUESTED): the
    // verification transition is ABSENT from the generic table —
    // exactly ONE generic rule remains (DRAFT → CANCELLED).
    expect(PUBLICATION_TRANSITION_TABLE).toHaveLength(1);
    const rules = PUBLICATION_TRANSITION_TABLE.map((r) => `${r.from}→${r.to}`);
    expect(rules).toEqual(["DRAFT→CANCELLED"]);
    // The verification edge MUST NOT reappear in the generic table.
    expect(
      PUBLICATION_TRANSITION_TABLE.find((r) => r.to === "VERIFIED"),
    ).toBeUndefined();
    for (const rule of PUBLICATION_TRANSITION_TABLE) {
      expect(["VERIFIED", "REJECTED", "CANCELLED"]).not.toContain(rule.from);
      expect(["BLOCKED", "FRAUD_REVIEW", "DISPUTED"]).not.toContain(rule.to);
    }
  });

  test("THE STRUCTURAL PIN: the verification transition resolves ONLY through the sanctioned table + sanction (PR #36 remediation)", () => {
    // 1) The sanctioned table is EXACTLY the whitelist: one rule,
    //    publication DRAFT → VERIFIED, carrying the frozen sanction
    //    and declaring requiresEvidenceReference (the W004 stance).
    //    ANY addition or change here breaks this pin — a future
    //    contributor cannot silently widen the sanctioned surface.
    expect(PUBLICATION_SANCTIONED_TRANSITION_TABLE).toHaveLength(1);
    const sanctioned = PUBLICATION_SANCTIONED_TRANSITION_TABLE[0]!;
    expect(sanctioned.from).toBe("DRAFT");
    expect(sanctioned.to).toBe("VERIFIED");
    expect(sanctioned.sanction).toBe(PUBLICATION_VERIFICATION_SANCTION);
    expect(sanctioned.requiresEvidenceReference).toBe(true);
    expect(sanctioned.policyAction).toBe(
      "publication.transition.draft_to_verified",
    );
    expect(sanctioned.auditEventName).toBe(
      "publication.transition.draft_to_verified",
    );
    // The sanction vocabulary itself is frozen.
    expect([...WORKFLOW_TRANSITION_SANCTIONS]).toEqual([
      "creators.publication-verification",
    ]);

    // 2) The GENERIC resolver CANNOT see the verification edge — a
    //    future contributor re-adding the edge to the generic table
    //    breaks THIS assertion (the re-exposure the architect
    //    required a structural pin against).
    expect(findRule("publication", "DRAFT", "VERIFIED")).toBeNull();
    expect(legalTargets("publication", "DRAFT")).toEqual(["CANCELLED"]);

    // 3) The SANCTIONED resolver requires an EXACT sanction match —
    //    a mismatched (or absent) sanction does not resolve.
    expect(
      findSanctionedRule(
        "publication",
        "DRAFT",
        "VERIFIED",
        PUBLICATION_VERIFICATION_SANCTION,
      ),
    ).toBe(sanctioned);
    expect(
      findSanctionedRule(
        "publication",
        "DRAFT",
        "VERIFIED",
        "not-the-sanction",
      ),
    ).toBeNull();
    expect(
      sanctionRequiredFor("publication", "DRAFT", "VERIFIED"),
    ).toBe(PUBLICATION_VERIFICATION_SANCTION);
    expect(sanctionRequiredFor("publication", "DRAFT", "CANCELLED")).toBeNull();

    // 4) The PURE evaluator enforces the same split: without a
    //    sanction the verification edge is ILLEGAL (with the
    //    precise sanction-naming error); with the EXACT sanction it
    //    is legal and resolves the sanctioned rule.
    const publication: Parameters<typeof evaluateTransition>[0]["subject"] = {
      id: "pin-publication-1",
      kind: "publication",
      state: "DRAFT",
      version: 1,
      organizationScopeId: "org-pin",
      ownerId: "person-pin",
      executionId: "exec-pin",
      correlationId: "corr-pin",
      causationId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const execution = {
      executionId: "exec-pin",
      correlationId: "corr-pin",
      causationId: null,
      actor: null,
    } as Parameters<typeof evaluateTransition>[0]["execution"];
    const unsanctioned = evaluateTransition({
      subject: publication,
      targetState: "VERIFIED",
      expectedVersion: 1,
      execution,
    });
    expect(unsanctioned.legal).toBe(false);
    expect(unsanctioned.error).toBeInstanceOf(IllegalTransitionError);
    expect(unsanctioned.error?.context?.requiredSanction).toBe(
      PUBLICATION_VERIFICATION_SANCTION,
    );
    const wrongSanction = evaluateTransition({
      subject: publication,
      targetState: "VERIFIED",
      expectedVersion: 1,
      execution,
      sanction: "not-the-sanction" as never,
    });
    expect(wrongSanction.legal).toBe(false);
    const sanctionedEvaluation = evaluateTransition({
      subject: publication,
      targetState: "VERIFIED",
      expectedVersion: 1,
      execution,
      sanction: PUBLICATION_VERIFICATION_SANCTION,
    });
    expect(sanctionedEvaluation.legal).toBe(true);
    expect(sanctionedEvaluation.rule).toBe(sanctioned);
    // The generic edge still resolves without any sanction.
    const cancel = evaluateTransition({
      subject: publication,
      targetState: "CANCELLED",
      expectedVersion: 1,
      execution,
    });
    expect(cancel.legal).toBe(true);
  });

  test("SPONSORSHIP IS NOT A SECOND LIFECYCLE AUTHORITY: the implementation has NO local transition machinery", async () => {
    const files = [
      "src/creators/disclosure-engine.ts",
      "src/creators/sponsorship-service.ts",
      "src/creators/authority-sponsorship-repositories.ts",
    ];
    const forbidden: RegExp[] = [
      // /workflows authority (lifecycle mutation) — the sanctioned
      // delegation is the injected requestTransition twin.
      /\bperformTransition\b/,
      /\btransitionWorkflow\b/,
      // Local status machinery (the disclosure status is DERIVED).
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
    // remediation decision applied from the start): the sponsorship
    // service uses it for the verification composite and the BARE
    // requestTransition is structurally ABSENT.
    const service = await readFile(
      join(REPO, "src/creators/sponsorship-service.ts"),
      "utf8",
    );
    expect(service).toContain("workflow.requestTransitionWithinTx(");
    expect(service.match(/workflow\.requestTransitionWithinTx\(/g)).toHaveLength(1);
    expect(service).not.toMatch(/workflow\.requestTransition\(/);
  });

  test("NO PARALLEL EVIDENCE AUTHORITY: the disclosure engine is PURE and the boundary fabricates no evidence", async () => {
    const engine = await readFile(
      join(REPO, "src/creators/disclosure-engine.ts"),
      "utf8",
    );
    // Pure derivation only — no persistence, no IO.
    expect(engine).not.toMatch(/\bauthority\b/i);
    expect(engine).not.toMatch(/async\s+\w+\s*\(/);
    // The service validates evidence REFERENCES through the neutral
    // lookup only (never creates evidence records).
    const service = await readFile(
      join(REPO, "src/creators/sponsorship-service.ts"),
      "utf8",
    );
    expect(service).not.toMatch(/\bcreateEvidence\b/);
    expect(service).not.toMatch(/\bgradeEvidence\b/i);
    expect(service).not.toMatch(/\bcreateAttestation\b/);
  });

  test("NO AI PATH: no code path from model output to sponsorship/disclosure decisions", async () => {
    for (const rel of [
      "src/creators/disclosure-engine.ts",
      "src/creators/sponsorship-service.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bLlmPort\b/);
      expect(content).not.toMatch(/\bllmProvider\b/);
      expect(content).not.toMatch(/\bgenerateAdvisory\b/);
      // No AI/model advisory INPUT participates in the gate (the
      // word "advisory" alone is allowed — the advisory-LOCK
      // concurrency comment is legitimate).
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

  test("the composition-root wiring: the SAME workflow service instance + thin read-only lookups + the publication subject routing", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The sponsorship lookups are thin READ-ONLY adapters over the
    // owning domains' repositories.
    expect(runtime).toContain("campaignDisclosurePolicyLookup");
    expect(runtime).toContain("sponsorshipEvidenceLookup");
    // The workflow delegation targets the SAME service instance
    // (the in-tx twin — the single-transaction composition seam).
    expect(runtime).toMatch(
      /const sponsorshipWorkflowPort: SponsorshipWorkflowPort = \{[\s\S]{0,900}return workflowService\.requestTransitionWithinTx\(/,
    );
    expect(runtime).toMatch(
      /const creatorSponsorshipService = createCreatorSponsorshipService\(\{[\s\S]{0,1200}workflow: sponsorshipWorkflowPort,/,
    );
    // The workflow service routes the publication subject kind.
    expect(runtime).toContain("publicationRepository: createLifecycleRepository(publicationRepo)");
    // The evidence subject lookup resolves publication subjects.
    expect(runtime).toMatch(
      /povSubjectLookup[\s\S]{0,1400}subjectType === "publication"/,
    );
  });

  test("no ad-inventory or payment execution leaked into the W018 boundary (NET-W019+ stay out of scope)", async () => {
    const files = [
      "src/creators/disclosure-engine.ts",
      "src/creators/sponsorship-service.ts",
      "src/creators/authority-sponsorship-repositories.ts",
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bcreatePlacement\b/);
      expect(content).not.toMatch(/\bserveAd\b/i);
      expect(content).not.toMatch(/\bexecutePayment\b/i);
      expect(content).not.toMatch(/\bprocessPayout\b/i);
      expect(content).not.toMatch(/\badInventory\b/i);
    }
  });

  test("the NET-W018 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W018.md",
      "src/creators/disclosure-engine.ts",
      "src/creators/sponsorship-service.ts",
      "src/creators/authority-sponsorship-repositories.ts",
      "tests/creators/_net-w018-harness.ts",
      "tests/creators/net-w018-ac-01-commercial-relationships.test.ts",
      "tests/creators/net-w018-ac-02-disclosure-requirements.test.ts",
      "tests/creators/net-w018-ac-03-declarations-evidence.test.ts",
      "tests/creators/net-w018-ac-04-publication-gate.test.ts",
      "tests/creators/net-w018-ac-05-settlement-reference.test.ts",
      "tests/creators/net-w018-ac-06-provider-neutrality.test.ts",
      "tests/creators/net-w018-ac-08-tenancy-idempotency.test.ts",
      "tests/creators/net-w018-composite-atomicity.test.ts",
      "tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts",
      "docs/net-w018-sponsorship-disclosure.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });
});
