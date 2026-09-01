/**
 * NET-W027-AC-09 — architecture/out-of-scope regression (issue #54).
 *
 * NET-W027 ships INSIDE the frozen `/demand` boundary NET-W024/W025/
 * W026 activated (NO 17th domain, NO second demand/procurement
 * authority; architecture.md §18 already names `/demand`, `/benefits`;
 * architecture-lock §2 lists `/demand` among the sixteen frozen core
 * domains). `/outcomes` remains the normalized measurement authority
 * and `/evidence` the provenance/truth authority — both consumed
 * read-only through NEUTRAL composition-root lookups; `/settlement`
 * remains the economic authority (ZERO economic surface in /demand —
 * a verified savings claim is a measurement decision, never an
 * economic one); `/workflows` is untouched (baseline invalidation is
 * a one-way field mutation; evidence staleness and observation
 * supersession are DERIVED at the evaluation anchor). No economic,
 * lifecycle, reputation, risk, AI-authority or Benefit-Pool (W028)
 * vocabulary; uncertainty is preserved; the derivation is
 * deterministic, anchor-aware and fails closed on invalid, stale or
 * insufficient evidence. The shared-file vocabulary amendments are
 * scoped exactly to the sanctioned NET-W027 contracts (the W025/W026
 * ac-08 amendments + the no-premature NET_W027 activation).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  PROCUREMENT_BASELINE_INVALIDATION_REASONS,
  PROCUREMENT_BASELINE_MAX_EVIDENCE_REFS,
  PROCUREMENT_BASELINE_COMPARISON_WINDOW_MAX_DAYS,
  PROCUREMENT_BASELINE_COMPARISON_WINDOW_MIN_DAYS,
  PROCUREMENT_BASELINE_METHODS,
  PROCUREMENT_BASELINE_RECORD_FORMAT,
  PROCUREMENT_SAVINGS_DERIVATION_CRITERIA,
  PROCUREMENT_SAVINGS_DERIVATION_METHOD,
  PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
  PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
  PROCUREMENT_SAVINGS_MAX_OBSERVATIONS,
  PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES,
  PROCUREMENT_SAVINGS_RECORD_FORMAT,
  PROCUREMENT_SAVINGS_SUBJECT_TYPE,
} from "../../src/core/procurement-savings.ts";
import { BASELINE_KINDS } from "../../src/core/measurement.ts";
import { ECONOMIC_VALUE_SOURCES } from "../../src/core/economics.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W027_FILES = [
  "src/core/procurement-savings.ts",
  "src/demand/port.ts",
  "src/demand/module.ts",
  "src/demand/authority-savings-repositories.ts",
  "src/demand/savings-engine.ts",
  "src/demand/savings-service.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W027-AC-09 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W027 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(298);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(298);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /demand stays the single home of ALL demand surfaces)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("| `/demand`, `/benefits` | demand aggregation and benefit allocation |");
    expect(lock).toContain("- `/demand`");
    // NET-W027 adds NO boundary and NO second demand/procurement/
    // savings authority (verified savings and counterfactuals live in
    // the SAME frozen /demand domain).
    expect(lock).not.toContain("- `/savings`");
    expect(lock).not.toContain("- `/verified-savings`");
    expect(lock).not.toContain("- `/procurement-savings`");
    expect(lock).not.toContain("- `/counterfactuals`");
    expect(lock).not.toContain("- `/baselines`");
    // The architecture's measurement + uncertainty contract covers
    // W027 (§13: counterfactual savings measurement; economically
    // material values retain confidence/uncertainty).
    expect(arch).toContain("counterfactual savings measurement");
    expect(arch).toContain("uncertainty");
  });

  test("the NET-W027 work order exists and binds to frozen Architecture v1.0 + Issue #54", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W027.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("#54");
    expect(workOrder).toContain("Verified savings and counterfactuals");
    // The authority-separation decision of record.
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("settlement");
    expect(workOrder).toContain("uncertainty");
    expect(workOrder).toContain("counterfactual");
    expect(workOrder).toContain("deterministic");
    expect(workOrder).toContain("anchor");
    expect(workOrder).toContain("SOLE economic authority");
    expect(workOrder).toContain("W028");
  });

  test("the savings/counterfactual vocabularies are pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W027 vocabularies (closed, versioned, bounded).
    expect(PROCUREMENT_BASELINE_RECORD_FORMAT).toBe("NET-W027:1");
    expect(PROCUREMENT_SAVINGS_RECORD_FORMAT).toBe("NET-W027:1");
    expect([...PROCUREMENT_BASELINE_METHODS]).toEqual([
      "prior_period",
      "matched_control",
      "market_index",
      "contracted_reference",
    ]);
    expect([...PROCUREMENT_BASELINE_INVALIDATION_REASONS]).toEqual([
      "population_changed",
      "method_superseded",
      "evidence_withdrawn",
      "quality_review",
    ]);
    expect(PROCUREMENT_BASELINE_COMPARISON_WINDOW_MIN_DAYS).toBe(1);
    expect(PROCUREMENT_BASELINE_COMPARISON_WINDOW_MAX_DAYS).toBe(365);
    expect(PROCUREMENT_BASELINE_MAX_EVIDENCE_REFS).toBe(8);
    expect(PROCUREMENT_SAVINGS_MAX_OBSERVATIONS).toBe(8);
    expect(PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS).toBe(365);
    expect(PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION).toBe(1);
    expect(PROCUREMENT_SAVINGS_DERIVATION_METHOD).toBe(
      "baseline-minus-observed-conservative",
    );
    expect([...PROCUREMENT_SAVINGS_DERIVATION_CRITERIA]).toHaveLength(12);
    expect([...PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES]).toEqual([
      "platform",
      "attested",
      "provider",
    ]);
    expect(PROCUREMENT_SAVINGS_SUBJECT_TYPE).toBe("procurement_pool");
    // The REUSED NET-W006 measurement vocabulary is unchanged (the
    // baseline kind IS the /outcomes vocabulary — never redefined).
    expect([...BASELINE_KINDS]).toEqual(["counterfactual", "baseline"]);
    // The REUSED economic vocabulary is unchanged (no savings source
    // kind was minted — W028 stays the economic consumer).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
  });

  test("DEMAND STAYS A NON-ECONOMIC/NON-LIFECYCLE/NON-AI AUTHORITY: no economic, reputation, risk, transition, AI or W028 vocabulary in the NET-W027 files (the savings/counterfactual vocabulary is the sanctioned W027 contract)", async () => {
    for (const rel of W027_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic mutation vocabulary (issue #54 architectural
      // constraints: /settlement stays the sole economic authority).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\bmatureEconomicValue\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\brecordPendingValue\b/);
      expect(content).not.toMatch(/\bcreateReputationInput\b/);
      expect(content).not.toMatch(/\bcreateRiskSignal\b/);
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: baseline invalidation is a one-way field mutation;
      // staleness/supersession are DERIVED at the anchor).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      // No domain imports outside itself/core (tier matrix: domain →
      // core/neutral/self only — the /evidence + /outcomes facts
      // cross through the NEUTRAL lookups declared in the port and
      // wired at the composition root).
      expect(content).not.toMatch(
        /from ["']\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|benefits|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
      // No W028 Benefit-Pool semantics.
      expect(content).not.toMatch(/\bbenefitPool\b/i);
      expect(content).not.toMatch(/\ballocateBenefit\b/);
      // No AI authority: no advisory machinery can authorize a
      // savings claim (issue #54 architectural constraints).
      expect(content).not.toMatch(/\badvisoryRanking\b/);
      expect(content).not.toMatch(/\baiEligibility\b/);
      expect(content).not.toMatch(/\baiSufficiency\b/);
      // The banned historical identifiers stay banned (the shared
      // files carry the sanctioned W027 contracts; these exact
      // camelCase identifiers were never introduced).
      expect(content).not.toMatch(/\bsavingsVerification\b/);
      expect(content).not.toMatch(/\bverifiedSavings\b/);
    }
  });

  test("SAVINGS CONTAINMENT: the W027 savings command vocabulary is confined to the /demand boundary and guarded routes", async () => {
    // The API transport: every savings/baseline surface is guarded.
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).toContain('"demand.procurement.baselines.create"');
    expect(apiServer).toContain('"demand.procurement.baselines.invalidate"');
    expect(apiServer).toContain('"demand.procurement.baselines.read"');
    expect(apiServer).toContain('"demand.procurement.savings.evaluate"');
    expect(apiServer).toContain('"demand.procurement.savings.record"');
    expect(apiServer).toContain('"demand.procurement.savings.read"');
    // No other domain carries the W027 savings command vocabulary
    // (the /demand boundary owns it exclusively; /outcomes and
    // /evidence keep their own measurement/provenance vocabulary —
    // "savings" the OUT-001 value and the W006 baseline kinds are NOT
    // W027 command surfaces).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "demand" || dir === "outcomes" || dir === "evidence") {
        continue;
      }
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry W027 savings command vocabulary`,
        ).not.toMatch(/\bcreateProcurementBaseline\b/);
        expect(content).not.toMatch(/\brecordProcurementSavings\b/);
        expect(content).not.toMatch(/\bevaluateProcurementSavings\b/);
        expect(content).not.toMatch(/\bProcurementSavingsService\b/);
        expect(content).not.toMatch(/\bProcurementBaselineRepository\b/);
      }
    }
  });

  test("the economic + measurement + provenance + lifecycle authorities are UNTOUCHED by NET-W027", async () => {
    // /settlement: the economic authority surface is intact and has
    // no savings/baseline coupling.
    const settlementPort = await readFile(
      join(REPO, "src/settlement/port.ts"),
      "utf8",
    );
    for (const method of [
      "issueCredits(",
      "issueCreditsWithinTx(",
      "recordCashObligation(",
      "recordPendingValue(",
    ]) {
      expect(settlementPort).toContain(method);
    }
    expect(settlementPort).not.toMatch(/procurementSavings/);
    expect(settlementPort).not.toMatch(/procurementBaseline/);
    // /workflows: the lifecycle authority is untouched (baseline
    // invalidation is a one-way field mutation; staleness/supersession
    // are derived — never transitions).
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/procurementSavings|procurementBaseline|savingsVerification/i);
    // /outcomes: the measurement authority port is UNCHANGED by W027
    // (W027 adds no method there — the neutral lookups live in the
    // /demand port + the composition root only).
    const outcomesPort = await readFile(
      join(REPO, "src/outcomes/port.ts"),
      "utf8",
    );
    expect(outcomesPort).not.toMatch(/createProcurementBaseline|recordProcurementSavings|ProcurementSavingsService|ProcurementSavingsOutcomeLookup/);
    // /evidence: the provenance/truth authority port is likewise
    // unchanged by W027.
    const evidencePort = await readFile(
      join(REPO, "src/evidence/port.ts"),
      "utf8",
    );
    expect(evidencePort).not.toMatch(/createProcurementBaseline|recordProcurementSavings|ProcurementSavingsService|ProcurementSavingsEvidenceLookup/);
    // /organizations: the membership authority gains no savings
    // surface (the pool-creator + membership gates resolve through
    // the composition-root lookup).
    const orgPort = await readFile(
      join(REPO, "src/organizations/port.ts"),
      "utf8",
    );
    expect(orgPort).not.toMatch(/procurementSavings|procurementBaseline/i);
  });

  test("the composition root is the ONLY join between /demand-W027 and the /evidence + /outcomes authorities (wiring pins)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The savings service is wired at the root over the authority
    // repositories + the idempotency store + the transactional audit
    // writer.
    expect(runtime).toContain("createProcurementSavingsService(");
    expect(runtime).toContain("createAuthorityProcurementBaselineRepository");
    expect(runtime).toContain("createAuthorityProcurementSavingsRepository");
    // The TWO neutral read-only lookups over the /evidence +
    // /outcomes authorities (the dependency-inversion boundary).
    expect(runtime).toContain("procurementSavingsEvidenceLookup");
    expect(runtime).toContain("procurementSavingsOutcomeLookup");
    expect(runtime).toContain("evidenceRepo.findById");
    expect(runtime).toContain("outcomeObservationRepo.findById");
    expect(runtime).toContain("outcomeObservationRepo.findByCorrectionOf");
    // The SAME neutral membership lookup + the SAME procurement
    // repositories (the pool-creator gate re-derives from /demand's
    // own records).
    expect(runtime).toContain("poolRepository: procurementPoolRepo");
    // The API command surface is wired.
    expect(runtime).toContain("async createProcurementBaseline(");
    expect(runtime).toContain("async recordProcurementSavings(");
    expect(runtime).toContain("async evaluateProcurementSavings(");
    expect(runtime).toContain("async listPoolSavings(");
    // The Runtime exposes the savings service (inside /demand).
    expect(runtime).toContain("readonly procurementSavingsService: ProcurementSavingsService;");
    // The api port consumes the demand port types only (the neutral
    // surface: the API layer never imports the savings implementation
    // files, only the port).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/savings-service\.ts/);
    expect(apiPort).not.toMatch(/savings-engine\.ts/);
    expect(apiPort).not.toMatch(/authority-savings-repositories\.ts/);
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).not.toMatch(/savings-service\.ts/);
    expect(apiServer).not.toMatch(/savings-engine\.ts/);
    expect(apiServer).not.toMatch(/authority-savings-repositories\.ts/);
    expect(apiServer).toContain("demand.procurement.baselines.create");
    expect(apiServer).toContain("demand.procurement.savings.evaluate");
    expect(apiServer).toContain("demand.procurement.savings.record");
  });

  test("the sanctioned shared-file vocabulary amendments are scoped EXACTLY to the sanctioned NET-W027 contracts", async () => {
    // The W025 + W026 ac-08 amendments keep the historical intent:
    // the W025/W026-OWNED files carry the full bans (including the
    // case-insensitive counterfactual ban), while the SHARED /demand
    // port/module carry the sanctioned W027 contracts.
    const w025Suite = await readFile(
      join(REPO, "tests/regression/net-w025-ac-08-architecture-out-of-scope.test.ts"),
      "utf8",
    );
    expect(w025Suite).toContain("W025_OWNED_FILES");
    expect(w025Suite).toContain("NET-W027 UPDATE");
    const w026Suite = await readFile(
      join(REPO, "tests/regression/net-w026-ac-08-architecture-out-of-scope.test.ts"),
      "utf8",
    );
    expect(w026Suite).toContain("W026_OWNED_FILES");
    expect(w026Suite).toContain("NET-W027 UPDATE");
    // The no-premature suite activates NET-W027 inside the SAME
    // /demand boundary.
    const noPremature = await readFile(
      join(REPO, "tests/regression/ac-08-no-premature-domain-logic.test.ts"),
      "utf8",
    );
    expect(noPremature).toContain('const NET_W027_DOMAINS = ["demand"]');
    // The shared files carry the W027 contracts (the sanctioned
    // vocabulary is present there by design).
    const port = await readFile(join(REPO, "src/demand/port.ts"), "utf8");
    expect(port).toContain("ProcurementBaseline");
    expect(port).toContain("ProcurementSavings");
    // ...while the W025/W026-OWNED files STILL carry NO
    // savings/counterfactual vocabulary (the historical intent).
    for (const rel of [
      "src/core/procurement.ts",
      "src/demand/authority-procurement-repositories.ts",
      "src/demand/procurement-aggregation-engine.ts",
      "src/demand/procurement-pool-service.ts",
      "src/core/procurement-offer.ts",
      "src/demand/authority-supplier-offer-repositories.ts",
      "src/demand/competitive-selection-engine.ts",
      "src/demand/supplier-offer-service.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bcounterfactual\b/i);
      expect(content).not.toMatch(/\bsavingsVerification\b/);
      expect(content).not.toMatch(/\bverifiedSavings\b/);
    }
  });

  test("the NET-W027 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W027.md",
      ...W027_FILES,
      "src/demand/README.md",
      "tests/demand/_net-w027-harness.ts",
      "tests/demand/net-w027-ac-01-baseline-records.test.ts",
      "tests/demand/net-w027-ac-02-counterfactual-representation.test.ts",
      "tests/demand/net-w027-ac-03-authoritative-derivation.test.ts",
      "tests/demand/net-w027-ac-04-deterministic-derivation.test.ts",
      "tests/demand/net-w027-ac-05-uncertainty-fail-closed.test.ts",
      "tests/demand/net-w027-ac-06-tenancy-authorization.test.ts",
      "tests/demand/net-w027-ac-07-idempotency-concurrency.test.ts",
      "tests/demand/net-w027-ac-08-economic-containment.test.ts",
      "tests/regression/net-w027-ac-09-architecture-out-of-scope.test.ts",
      "docs/net-w027-verified-savings-counterfactuals.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W027 files (no new configuration)", async () => {
    for (const rel of W027_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(
        false,
      );
    }
    // NET-W027 adds NO configuration entries and NO secrets (the
    // savings/counterfactual boundary needs no key material —
    // deterministic derivation only).
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    expect(schema).not.toMatch(/PROCUREMENT_SAVINGS_|PROCUREMENT_BASELINE_|SAVINGS_VERIFICATION_/);
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).not.toMatch(/PROCUREMENT_SAVINGS_|PROCUREMENT_BASELINE_|SAVINGS_VERIFICATION_/);
  });
});
