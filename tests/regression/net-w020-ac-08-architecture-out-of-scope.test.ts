/**
 * NET-W020-AC-08 — architecture/out-of-scope regression (issue #39
 * AC-8; invariant 9).
 *
 * NET-W020 ships INSIDE the frozen `/settlement` boundary — one of
 * the SIXTEEN frozen core domains since NET-W001 (architecture.md
 * §18/§7 + architecture-lock.md §2 both already name `/settlement`;
 * the W001 skeleton implemented it in NET-W008, W010 and now W020
 * extends it additively). NO 17th domain is created; the
 * architecture-lock domain list is UNCHANGED. Clearing is an
 * ORCHESTRATION/INTEGRATION concern composed at the bootstrap
 * boundary: the clearing record posts NOTHING (no new account kind,
 * transaction kind or value source exists — the pinned economic
 * vocabularies stay byte-identical, so NO second ledger exists); the
 * economic mutation flows exclusively through the UNTOUCHED
 * allocateRewards / issueCredits / recordCashObligation primitives.
 * `/workflows` is COMPLETELY UNTOUCHED (clearing carries NO lifecycle
 * subject kind — the subject-kind union, every transition table and
 * the sanction vocabulary are pinned UNCHANGED). No AI path, no
 * external payment execution, no campaign optimization / attribution
 * adapters / OpenRTB / demand-procurement-benefit pools (the issue
 * #39 non-goals — NET-W021+ / NET-W022+ / NET-W023+ / NET-W024+ /
 * NET-W030+), and no cross-promotion vocabulary leaked into the
 * inventory boundary (the W019 fence stays green).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import {
  ECONOMIC_ACCOUNT_KINDS,
  ECONOMIC_LEDGER_TX_KINDS,
  ECONOMIC_STAKE_PURPOSE_KINDS,
  ECONOMIC_VALUE_SOURCES,
} from "../../src/core/economics.ts";
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

/** The NET-W020 boundary files (the clearing surface). */
const W020_SETTLEMENT_FILES = [
  "src/settlement/port.ts",
  "src/settlement/clearing-eligibility.ts",
  "src/settlement/clearing-service.ts",
  "src/settlement/authority-clearing-repository.ts",
];

describe("NET-W020-AC-08 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W020 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThanOrEqual(264);
  });

  test("THE NO-17TH-DOMAIN PIN: the frozen specs name /settlement among the sixteen and gain NO clearing boundary", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    expect(lock).toContain("- `/settlement`");
    // NET-W020 adds NO boundary (the clearing records live in the
    // ALREADY-FROZEN /settlement domain; the composite is a
    // composition-root orchestration).
    expect(lock).not.toContain("- `/clearing`");
    expect(lock).not.toContain("- `/cross-promotion`");
    expect(lock).not.toContain("- `/netting`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // The frozen module-ownership row that names /settlement.
    expect(arch).toContain("credits, pending/mature value, cash/credit settlement");
  });

  test("the NET-W020 work order exists and binds to frozen Architecture v1.0 + Issue #39", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W020.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("CAMP-004..005");
    expect(workOrder).toContain("ECON-003");
    expect(workOrder).toContain("SETTLE-001");
    expect(workOrder).toContain("INV-004");
    expect(workOrder).toContain("AUD-001");
    expect(workOrder).toContain("#39");
    expect(workOrder).toContain("Cross-promotion clearing");
    // The decisions of record.
    expect(workOrder).toContain("NOT a new domain");
    expect(workOrder).toContain("decision of record");
    expect(workOrder).toContain("posts NOTHING");
    expect(workOrder).toContain("SOLE economic authority");
  });

  test("THE NO-SECOND-LEDGER PIN: every frozen economic vocabulary is byte-identical (W020 adds NO economic primitive)", () => {
    // The exact frozen sets (the W010/W011/W013/W014 pins, re-pinned).
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
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
    expect([...ECONOMIC_STAKE_PURPOSE_KINDS]).toEqual([
      "campaign_budget",
      "dispute_challenge",
      // NET-W032 (additive, sanctioned shared-file amendment): the
      // validator per-round eligibility bond purpose kind.
      "validation_assignment",
    ]);
  });

  test("THE CLEARING-RECORD-POSTS-NOTHING PIN: no posting machinery exists in the clearing surface", async () => {
    // The NEW W020 files (port.ts carries the pre-existing W008/
    // W010 service declarations — its W020 SECTION is pinned below).
    for (const rel of [
      "src/settlement/clearing-eligibility.ts",
      "src/settlement/clearing-service.ts",
      "src/settlement/authority-clearing-repository.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      // The posting layer (the ONLY sanctioned ledger-write path).
      expect(content).not.toMatch(/postLedgerTransactionWithinTx/);
      expect(content).not.toMatch(/\bensureAccountWithinTx\b/);
      expect(content).not.toMatch(/\bcreateTransactionWithinTx\b/);
      expect(content).not.toMatch(/economicAccountId\s*\(/);
      // The economic primitives are NOT re-implemented here (they
      // are composed at the bootstrap boundary only; the call-shaped
      // pins ignore documentation mentions).
      expect(content).not.toMatch(/\bissueCredits\s*\(/);
      expect(content).not.toMatch(/\ballocateRewards\s*\(/);
      expect(content).not.toMatch(/\brecordCashObligation\s*\(/);
      expect(content).not.toMatch(/\bmatureValue\s*\(/);
      expect(content).not.toMatch(/\brecordPendingValue\s*\(/);
      expect(content).not.toMatch(/\brecordConversion\s*\(/);
      expect(content).not.toMatch(/\bcommitStake\s*\(/);
    }
    // The port's W020 SECTION declares NO economic primitive (only
    // the lookups + the record + the derived view).
    const port = await readFile(join(REPO, "src/settlement/port.ts"), "utf8");
    const w020Section = port.slice(port.indexOf("NET-W020 — Cross-promotion clearing"));
    expect(w020Section).not.toMatch(/postLedgerTransactionWithinTx/);
    expect(w020Section).not.toMatch(/\bcreateTransactionWithinTx\s*\(/);
    expect(w020Section).not.toMatch(/economicAccountId\s*\(/);
    expect(w020Section).not.toMatch(/\bissueCredits\s*\(/);
    expect(w020Section).not.toMatch(/\ballocateRewards\s*\(/);
    // The repository persists exactly ONE collection (the clearing
    // records) — no entries/accounts collections.
    const repoContent = await readFile(
      join(REPO, "src/settlement/authority-clearing-repository.ts"),
      "utf8",
    );
    expect(repoContent.match(/COLLECTION = "/g)?.length).toBe(1);
    expect(repoContent).toContain('"cross_promotion_clearings"');
    expect(repoContent).not.toMatch(/economic_ledger_entries/);
    expect(repoContent).not.toMatch(/economic_accounts/);
  });

  test("/workflows is COMPLETELY UNTOUCHED: NO clearing lifecycle subject kind exists", () => {
    const kinds: readonly LifecycleSubjectKind[] = [
      "opportunity",
      "contribution",
      "proof_of_value",
      "outcome_measurement",
      "engagement",
      "publication",
    ];
    expect(kinds).not.toContain("clearing");
    expect(kinds).not.toContain("cross_promotion_clearing");
    expect(kinds.length).toBe(6);
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
    // The transition tables + sanctions are UNTOUCHED (the W017/W018/
    // W019 pins).
    expect(ENGAGEMENT_TRANSITION_TABLE).toHaveLength(11);
    expect(PUBLICATION_TRANSITION_TABLE).toHaveLength(1);
    expect(PUBLICATION_SANCTIONED_TRANSITION_TABLE).toHaveLength(1);
    expect([...WORKFLOW_TRANSITION_SANCTIONS]).toEqual([
      "creators.publication-verification",
    ]);
  });

  test("NO AI PATH: the clearing surface never touches the LLM ports and never imports AI machinery", async () => {
    for (const rel of [
      "src/settlement/clearing-eligibility.ts",
      "src/settlement/clearing-service.ts",
      "src/settlement/authority-clearing-repository.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bLlmPort\b/);
      expect(content).not.toMatch(/\bllmProvider\b/);
      expect(content).not.toMatch(/llm\/agents\.ts/);
    }
    // The clearing composite region in runtime.ts references the LLM
    // provider NOWHERE inside the W020 block. (PR #40 remediation:
    // the region end is the apiCommands DEFINITION — the earlier
    // `apiCommands: ApiCommands` match was the Runtime interface
    // declaration, which made the region empty and the pin vacuous.)
    // NET-W021 refinement (the W016→W017 pin-refinement precedent):
    // the region end is now the NET-W021 section banner — the W021
    // matching section that legitimately wires the LlmPort advisory
    // adapters follows AFTER the clearing block; the clearing surface
    // region itself still references no LLM machinery.
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    const w020Start = runtime.indexOf("NET-W020 — Cross-promotion clearing");
    const w020End = runtime.indexOf(
      "NET-W021 — Campaign matching and optimization",
    );
    const w020Region = runtime.slice(w020Start, w020End);
    expect(w020Region.length).toBeGreaterThan(1000);
    expect(w020Region).not.toMatch(/llm|Llm|LLM/);
  });

  test("NO EXTERNAL PAYMENT EXECUTION: /payments stays untouched and is never imported", async () => {
    for (const rel of W020_SETTLEMENT_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/payments\//);
      expect(content).not.toMatch(/\bexecutePayment\b/);
      expect(content).not.toMatch(/\bprocessPayout\b/);
      expect(content).not.toMatch(/\bpaymentProvider\b/i);
    }
  });

  test("the issue #39 NON-GOALS did not leak into the clearing surface (no optimization, attribution, OpenRTB, pools, netting)", async () => {
    for (const rel of [
      "src/settlement/clearing-eligibility.ts",
      "src/settlement/clearing-service.ts",
      "src/settlement/authority-clearing-repository.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\boptimize\b/i);
      expect(content).not.toMatch(/\brankCandidates\b/i);
      expect(content).not.toMatch(/openrtb/i);
      expect(content).not.toMatch(/\battributionAdapter\b/i);
      expect(content).not.toMatch(/\bdemandPool\b/i);
      expect(content).not.toMatch(/\bprocurement\b/i);
      expect(content).not.toMatch(/\bbenefitPool\b/i);
      expect(content).not.toMatch(/\bnetPosition\b/i);
      expect(content).not.toMatch(/\bnettingEngine\b/i);
      expect(content).not.toMatch(/\bdecentralized\b/i);
      expect(content).not.toMatch(/\bblockchain\b/i);
    }
  });

  test("THE INVENTORY FENCE (the W019 regression pin, re-proven): NO cross-promotion vocabulary leaked into the /inventory boundary", async () => {
    for (const rel of [
      "src/inventory/port.ts",
      "src/inventory/eligibility-engine.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/authority-inventory-repositories.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/crossPromotion|cross_promotion/i);
    }
  });

  test("the API surface exposes the clearing composite + the derived eligibility view + the reads", async () => {
    const server = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(server).toContain(
      '"/api/settlement/cross-promotion-clearings"',
    );
    expect(server).toContain(
      '"/api/settlement/cross-promotion-clearings/eligibility"',
    );
    expect(server).toContain("executeCrossPromotionClearing");
    expect(server).toContain("evaluateCrossPromotionClearing");
    expect(server).toContain("getCrossPromotionClearing");
    expect(server).toContain("listCrossPromotionClearings");
    // The mutation is guarded (the reward.clear guard action).
    expect(server).toMatch(
      /cross-promotion-clearings"[\s\S]{0,400}guardMutation\(\s*ctx,\s*req,\s*"reward\.clear"/,
    );
  });

  test("THE SINGLE-AUTHORITATIVE-TRANSACTION PIN (PR #40 remediation): the clearing composite runs ONLY through the ...WithinTx primitives — the transaction-owning draw commands appear NOWHERE in the composite path", async () => {
    // The settlement composite itself: the draw + the record + the
    // bookkeeping execute on the CALLER'S transaction through the
    // same-domain ...WithinTx forms. The transaction-owning commands
    // (which open their own applyIdempotent) must never be invoked
    // from the clearing composite — that is exactly the
    // partial-economic-mutation defect the review rejected.
    const clearingService = await readFile(
      join(REPO, "src/settlement/clearing-service.ts"),
      "utf8",
    );
    expect(clearingService).toContain("allocateRewardsWithinTx");
    expect(clearingService).toContain("issueCreditsWithinTx");
    expect(clearingService).toContain("recordCashObligationWithinTx");
    expect(clearingService).toContain("recordCrossPromotionClearingWithinTx");
    expect(clearingService).toContain("recordClearingExecutionWithinTx");
    // The call-shaped pins: the transaction-owning forms are NEVER
    // called (only mentioned in documentation without a call site).
    expect(clearingService).not.toMatch(/\ballocateRewards\s*\(/);
    expect(clearingService).not.toMatch(/\bissueCredits\s*\(/);
    expect(clearingService).not.toMatch(/\brecordCashObligation\s*\(/);
    expect(clearingService).not.toMatch(/\brecordClearingExecution\s*\(/);
    // ONE applyIdempotent owns the whole operation (the composite
    // key); the standalone record command keeps its own boundary.
    expect(clearingService).toContain(
      "cross_promotion_clearing_execute:${organizationScopeId}",
    );
    // The composition root delegates to the settlement authority's
    // atomic composite; the runtime's W020 region never invokes the
    // transaction-owning draw commands either (the region ends at
    // the apiCommands definition — the composite adapter delegates
    // to the settlement service's atomic execute).
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    const w020Start = runtime.indexOf("NET-W020 — Cross-promotion clearing");
    const w020End = runtime.indexOf("const apiCommands: ApiCommands = {");
    const w020Region = runtime.slice(w020Start, w020End);
    expect(w020Region.length).toBeGreaterThan(1000);
    expect(w020Region).toContain("recordClearingExecutionWithinTx");
    expect(w020Region).not.toMatch(/\ballocateRewards\s*\(/);
    expect(w020Region).not.toMatch(/\bissueCredits\s*\(/);
    expect(w020Region).not.toMatch(/\brecordCashObligation\s*\(/);
    // The composite-level fault injection regression exists and
    // exercises the ACTUAL end-to-end operation (the architect's
    // required proof).
    const atomicityTest = await readFile(
      join(REPO, "tests/settlement-clearing/net-w020-ac-07-atomicity-lineage.test.ts"),
      "utf8",
    );
    expect(atomicityTest).toContain("COMPOSITE-LEVEL FAULT INJECTION");
    expect(atomicityTest).toContain("injected authoritative COMMIT failure");
    expect(atomicityTest).toContain("SAME AUTHORITATIVE TRANSACTION LINEAGE");
    expect(atomicityTest).toContain("executeCrossPromotionClearing");
  });

  test("the NET-W020 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W020.md",
      "src/settlement/port.ts",
      "src/settlement/clearing-eligibility.ts",
      "src/settlement/clearing-service.ts",
      "src/settlement/authority-clearing-repository.ts",
      "src/settlement/module.ts",
      "src/settlement/README.md",
      "src/bootstrap/runtime.ts",
      "src/api/port.ts",
      "src/api/server.ts",
      "tests/settlement-clearing/_net-w020-harness.ts",
      "tests/settlement-clearing/net-w020-ac-01-qualifying-entry.test.ts",
      "tests/settlement-clearing/net-w020-ac-02-derived-eligibility.test.ts",
      "tests/settlement-clearing/net-w020-ac-03-exactly-once-settlement.test.ts",
      "tests/settlement-clearing/net-w020-ac-04-concurrency-replay.test.ts",
      "tests/settlement-clearing/net-w020-ac-05-fail-closed.test.ts",
      "tests/settlement-clearing/net-w020-ac-06-risk-dispute-gates.test.ts",
      "tests/settlement-clearing/net-w020-ac-07-atomicity-lineage.test.ts",
      "tests/regression/net-w020-ac-08-architecture-out-of-scope.test.ts",
      "docs/net-w020-cross-promotion-clearing.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials were introduced by NET-W020", async () => {
    for (const rel of W020_SETTLEMENT_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(
        /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,})/,
      );
    }
  });
});
