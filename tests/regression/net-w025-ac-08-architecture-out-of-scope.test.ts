/**
 * NET-W025-AC-08 — architecture/out-of-scope regression (issue #50).
 *
 * NET-W025 ships INSIDE the frozen `/demand` boundary NET-W024
 * activated (NO 17th domain, NO second demand/procurement authority;
 * architecture.md §18 already names `/demand`, `/benefits` — "demand
 * aggregation and benefit allocation"; architecture-lock §2 lists
 * `/demand` among the sixteen frozen core domains). `/settlement`
 * remains the economic authority (ZERO economic surface in /demand);
 * `/organizations` remains the membership authority (read-only through
 * the neutral composition-root lookup — the dual tenant +
 * buyer-organization gates); `/workflows` is untouched (closure/
 * withdrawal are one-way field mutations). No economic, lifecycle,
 * reputation, risk, supplier-offer/selection (W026),
 * savings/counterfactual (W027) or Benefit-Pool (W028) vocabulary;
 * aggregates are DERIVED (never stored, never caller-asserted) behind
 * the frozen commitment floor AND the frozen distinct-organization
 * floor.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  DEMAND_BUDGET_BANDS,
  DEMAND_CATEGORY_KEYS,
  DEMAND_CATEGORY_VERSION,
  DEMAND_COMMITMENT_RECORD_FORMAT,
  DEMAND_CONSENT_SCOPE,
  DEMAND_CONSENT_VERSION,
  DEMAND_MAX_QUALIFICATION_COMMITMENTS,
  DEMAND_MAX_QUANTITY,
  DEMAND_MIN_QUALIFICATION_COMMITMENTS,
  DEMAND_MIN_QUANTITY,
  DEMAND_POLICY_VERSION,
  DEMAND_POOL_NAME_MAX_CHARS,
  DEMAND_POOL_RECORD_FORMAT,
  DEMAND_PRIVACY_MINIMUM_COMMITMENTS,
  DEMAND_QUANTITY_BUCKETS,
  DEMAND_REGION_CODES,
} from "../../src/core/demand.ts";
import {
  PROCUREMENT_BUDGET_BANDS,
  PROCUREMENT_CATEGORY_KEYS,
  PROCUREMENT_CATEGORY_VERSION,
  PROCUREMENT_COMMITMENT_RECORD_FORMAT,
  PROCUREMENT_CONSENT_SCOPE,
  PROCUREMENT_CONSENT_VERSION,
  PROCUREMENT_MAX_PROSE_CHARS,
  PROCUREMENT_MAX_QUALIFICATION_COMMITMENTS,
  PROCUREMENT_MAX_QUALIFICATION_ORGANIZATIONS,
  PROCUREMENT_MAX_QUANTITY,
  PROCUREMENT_MIN_QUALIFICATION_COMMITMENTS,
  PROCUREMENT_MIN_QUALIFICATION_ORGANIZATIONS,
  PROCUREMENT_MIN_QUANTITY,
  PROCUREMENT_POLICY_VERSION,
  PROCUREMENT_POOL_NAME_MAX_CHARS,
  PROCUREMENT_POOL_RECORD_FORMAT,
  PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS,
  PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS,
  PROCUREMENT_QUANTITY_BUCKETS,
  PROCUREMENT_TIMING_WINDOWS,
  PROCUREMENT_UNIT_PRICE_BANDS,
} from "../../src/core/procurement.ts";
import {
  INVENTORY_FORMATS,
  INVENTORY_SURFACE_KINDS,
} from "../../src/core/inventory.ts";
import { ATTRIBUTION_MODES } from "../../src/core/measurement.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import { MEASUREMENT_REPORT_REJECTION_REASONS } from "../../src/measurement/port.ts";
import { SUPPLY_CHAIN_VERIFICATION_STATUSES } from "../../src/adapters/port.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W025_FILES = [
  "src/core/procurement.ts",
  "src/demand/port.ts",
  "src/demand/module.ts",
  "src/demand/authority-procurement-repositories.ts",
  "src/demand/procurement-aggregation-engine.ts",
  "src/demand/procurement-pool-service.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W025-AC-08 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W025 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(290);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(290);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /demand stays the single home of BOTH demand surfaces)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("| `/demand`, `/benefits` | demand aggregation and benefit allocation |");
    expect(lock).toContain("- `/demand`");
    // NET-W025 adds NO boundary and NO second demand/procurement
    // authority (business procurement pools live in the SAME frozen
    // /demand domain).
    expect(lock).not.toContain("- `/demand-pools`");
    expect(lock).not.toContain("- `/procurement`");
    expect(lock).not.toContain("- `/consumer-demand`");
    expect(lock).not.toContain("- `/procurement-pools`");
    expect(lock).not.toContain("- `/business-procurement`");
  });

  test("the NET-W025 work order exists and binds to frozen Architecture v1.0 + Issue #50", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W025.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("DEM-001..003");
    expect(workOrder).toContain("PROC-001..003");
    expect(workOrder).toContain("#50");
    expect(workOrder).toContain("Business procurement pools");
    // The authority-separation decision of record.
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("settlement");
    expect(workOrder).toContain("privacy");
    expect(workOrder).toContain("consent");
    expect(workOrder).toContain("competition");
    expect(workOrder).toContain("second demand or procurement");
  });

  test("the procurement vocabularies are pinned; every frozen vocabulary is UNCHANGED (including NET-W024's)", () => {
    // The NEW NET-W025 vocabularies (closed, versioned, bounded).
    expect([...PROCUREMENT_CATEGORY_KEYS]).toEqual([
      "cloud_infrastructure",
      "software_licensing",
      "professional_services",
      "logistics_freight",
      "manufacturing_materials",
      "facilities_maintenance",
      "energy_supply",
      "marketing_agency",
    ]);
    expect(PROCUREMENT_CATEGORY_VERSION).toBe("1");
    expect([...PROCUREMENT_BUDGET_BANDS]).toEqual([
      "band_a_under_1k",
      "band_b_1k_9k",
      "band_c_10k_99k",
      "band_d_100k_999k",
      "band_e_1m_plus",
    ]);
    expect([...PROCUREMENT_UNIT_PRICE_BANDS]).toEqual([
      "price_a_under_10",
      "price_b_10_49",
      "price_c_50_99",
      "price_d_100_499",
      "price_e_500_plus",
    ]);
    expect([...PROCUREMENT_TIMING_WINDOWS]).toEqual([
      "window_immediate",
      "window_short_1_3mo",
      "window_medium_3_6mo",
      "window_long_6_12mo",
      "window_extended_12mo_plus",
    ]);
    expect([...PROCUREMENT_QUANTITY_BUCKETS]).toEqual([
      "q_1_9",
      "q_10_99",
      "q_100_999",
      "q_1000_9999",
      "q_10000_plus",
    ]);
    // THE TWO FROZEN FLOORS (no policy can lower either).
    expect(PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    expect(PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS).toBe(3);
    // The closed consent scope + versions + bounds + lineage.
    expect(PROCUREMENT_CONSENT_SCOPE).toBe("aggregate_disclosure");
    expect(PROCUREMENT_CONSENT_VERSION).toBe("NET-W025:1");
    expect(PROCUREMENT_POOL_RECORD_FORMAT).toBe("NET-W025:1");
    expect(PROCUREMENT_COMMITMENT_RECORD_FORMAT).toBe("NET-W025:1");
    expect(PROCUREMENT_POLICY_VERSION).toBe(1);
    expect(PROCUREMENT_MIN_QUALIFICATION_COMMITMENTS).toBe(1);
    expect(PROCUREMENT_MAX_QUALIFICATION_COMMITMENTS).toBe(10000);
    expect(PROCUREMENT_MIN_QUALIFICATION_ORGANIZATIONS).toBe(1);
    expect(PROCUREMENT_MAX_QUALIFICATION_ORGANIZATIONS).toBe(10000);
    expect(PROCUREMENT_MIN_QUANTITY).toBe(1);
    expect(PROCUREMENT_MAX_QUANTITY).toBe(1000000);
    expect(PROCUREMENT_POOL_NAME_MAX_CHARS).toBe(200);
    expect(PROCUREMENT_MAX_PROSE_CHARS).toBe(2000);
    // The FROZEN vocabularies of the prior work items are unchanged
    // (including the ENTIRE NET-W024 demand set — W025 extends, it
    // never rewrites).
    expect([...DEMAND_CATEGORY_KEYS]).toEqual([
      "utilities_energy",
      "telecom_connectivity",
      "insurance_home",
      "grocery_household",
      "software_tools",
      "transport_mobility",
      "health_wellness",
      "home_services",
    ]);
    expect(DEMAND_CATEGORY_VERSION).toBe("1");
    expect([...DEMAND_REGION_CODES]).toHaveLength(12);
    expect([...DEMAND_BUDGET_BANDS]).toEqual([
      "band_a_under_50",
      "band_b_50_199",
      "band_c_200_499",
      "band_d_500_999",
      "band_e_1000_plus",
    ]);
    expect([...DEMAND_QUANTITY_BUCKETS]).toEqual([
      "q_1_9",
      "q_10_49",
      "q_50_99",
      "q_100_499",
      "q_500_plus",
    ]);
    expect(DEMAND_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    expect(DEMAND_CONSENT_SCOPE).toBe("aggregate_disclosure");
    expect(DEMAND_CONSENT_VERSION).toBe("NET-W024:1");
    expect(DEMAND_POOL_RECORD_FORMAT).toBe("NET-W024:1");
    expect(DEMAND_COMMITMENT_RECORD_FORMAT).toBe("NET-W024:1");
    expect(DEMAND_POLICY_VERSION).toBe(1);
    expect(DEMAND_MIN_QUALIFICATION_COMMITMENTS).toBe(1);
    expect(DEMAND_MAX_QUALIFICATION_COMMITMENTS).toBe(10000);
    expect(DEMAND_MIN_QUANTITY).toBe(1);
    expect(DEMAND_MAX_QUANTITY).toBe(10000);
    expect(DEMAND_POOL_NAME_MAX_CHARS).toBe(200);
    expect([...ATTRIBUTION_MODES]).toEqual([
      "deterministic",
      "probabilistic",
      "experimental",
    ]);
    expect([...INVENTORY_FORMATS]).toEqual([
      "display",
      "video",
      "audio",
      "native",
      "sponsored_content",
    ]);
    expect([...INVENTORY_SURFACE_KINDS]).toEqual([
      "publisher",
      "app",
      "creator",
    ]);
    expect(MEASUREMENT_REPORT_REJECTION_REASONS).toHaveLength(7);
    expect(OUTCOME_MEASUREMENT_TRANSITION_TABLE.length).toBe(4);
    expect([...SUPPLY_CHAIN_VERIFICATION_STATUSES]).toEqual([
      "verified",
      "absent",
      "incomplete",
      "unauthenticated",
      "mismatched",
      "stale",
      "ambiguous",
    ]);
  });

  test("DEMAND STAYS A NON-ECONOMIC/NON-LIFECYCLE AUTHORITY: no economic, reputation, risk, transition, supplier-offer/selection, savings or benefit vocabulary in the NET-W025 files", async () => {
    for (const rel of W025_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic mutation vocabulary (issue #50 architectural
      // constraints: /settlement stays the sole economic authority).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\bmatureEconomicValue\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\bcreateReputationInput\b/);
      expect(content).not.toMatch(/\bcreateRiskSignal\b/);
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: closure/withdrawal are one-way field mutations).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      // No domain imports outside itself/core (tier matrix: domain →
      // core/neutral/self only).
      expect(content).not.toMatch(
        /from ["']\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|benefits|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
      // No supplier-offer/selection (W026), savings/counterfactual
      // (W027) or Benefit-Pool (W028) semantics.
      expect(content).not.toMatch(/\bsupplierOffer\b/);
      expect(content).not.toMatch(/\bsupplierSelection\b/);
      expect(content).not.toMatch(/\bsavingsVerification\b/);
      expect(content).not.toMatch(/\bcounterfactual\b/i);
      expect(content).not.toMatch(/\bbenefitPool\b/i);
      expect(content).not.toMatch(/\ballocateBenefit\b/);
    }
  });

  test("PROCUREMENT PRIVACY CONTAINMENT: commitment exposure vocabulary is confined to the actor-scoped surface; the /demand boundary owns it exclusively", async () => {
    // The API transport: individual business commitments are reachable
    // ONLY through the actor-scoped route
    // (listMyProcurementCommitments); there is NO unguarded
    // commitment listing.
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).toContain('"demand.procurement.commitments.read"');
    expect(apiServer).toContain("/api/demand/procurement/commitments/mine");
    // The ONLY commitment read command (actor-scoped, no submittedBy
    // input).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).toContain("listMyProcurementCommitments(");
    expect(apiPort).toContain("no submittedBy input");
    expect(apiPort).not.toMatch(/listProcurementCommitments\(\s*execution: ExecutionContext,\s*organizationScopeId: string,\s*submittedBy: string/);
    // No other domain carries procurement-pool vocabulary (the /demand
    // boundary owns it exclusively).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "demand") continue;
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry procurement-pool vocabulary`,
        ).not.toMatch(/\bcreateProcurementCommitment\b/);
        expect(content).not.toMatch(/\bevaluateQualifiedProcurementDemand\b/);
        expect(content).not.toMatch(/\bProcurementPoolRepository\b/);
      }
    }
  });

  test("the economic + lifecycle authorities are UNTOUCHED by NET-W025", async () => {
    // /settlement: the economic authority surface is intact and has
    // no procurement coupling.
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
    expect(settlementPort).not.toMatch(/procurement/i);
    expect(settlementPort).not.toMatch(/QualifiedProcurementAggregate/);
    // /workflows: the lifecycle authority is untouched (closure and
    // withdrawal are one-way field mutations, never transitions).
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/procurement/i);
    expect(transitionTable).not.toMatch(/demand/i);
    // /organizations: the membership authority gains no procurement
    // surface (the dual gates resolve through the composition-root
    // lookup).
    const orgPort = await readFile(
      join(REPO, "src/organizations/port.ts"),
      "utf8",
    );
    expect(orgPort).not.toMatch(/procurementPool/i);
  });

  test("the composition root is the ONLY join between /demand-procurement and the membership authority (wiring pins)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The procurement service is wired at the root over the authority
    // repositories + the idempotency store + the transactional audit
    // writer.
    expect(runtime).toContain("createProcurementService(");
    expect(runtime).toContain("createAuthorityProcurementPoolRepository");
    expect(runtime).toContain("createAuthorityProcurementCommitmentRepository");
    // The SAME neutral membership lookup (thin read-only adapter over
    // the /organizations membership repository — reused for BOTH the
    // tenant gate and the buyer-organization gate).
    expect(runtime).toContain("demandMembershipLookup");
    expect(runtime).toContain("membershipRepo.findByPersonAndOrganization");
    // The API command surface is wired.
    expect(runtime).toContain("async createProcurementPool(");
    expect(runtime).toContain("async createProcurementCommitment(");
    expect(runtime).toContain("async evaluateQualifiedProcurementDemand(");
    expect(runtime).toContain("async listMyProcurementCommitments(");
    // The Runtime exposes the procurement service (inside /demand).
    expect(runtime).toContain("readonly procurementService: ProcurementService;");
    // The api port consumes the demand port types only (the neutral
    // surface: the API layer never imports the procurement
    // implementation files, only the port).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/procurement-pool-service\.ts/);
    expect(apiPort).not.toMatch(/procurement-aggregation-engine\.ts/);
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).not.toMatch(/procurement-pool-service\.ts/);
    expect(apiServer).not.toMatch(/procurement-aggregation-engine\.ts/);
    expect(apiServer).toContain("demand.procurement.pools.create");
    expect(apiServer).toContain("demand.procurement.commitments.create");
    expect(apiServer).toContain("demand.procurement.aggregates.evaluate");
  });

  test("the NET-W025 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W025.md",
      ...W025_FILES,
      "src/demand/README.md",
      "tests/demand/_net-w025-harness.ts",
      "tests/demand/net-w025-ac-01-procurement-records.test.ts",
      "tests/demand/net-w025-ac-02-deterministic-qualification.test.ts",
      "tests/demand/net-w025-ac-03-privacy-competition.test.ts",
      "tests/demand/net-w025-ac-04-threshold-policy.test.ts",
      "tests/demand/net-w025-ac-05-idempotency-concurrency.test.ts",
      "tests/demand/net-w025-ac-06-tenancy-authorization.test.ts",
      "tests/demand/net-w025-ac-07-atomicity-audit.test.ts",
      "tests/regression/net-w025-ac-08-architecture-out-of-scope.test.ts",
      "docs/net-w025-business-procurement-pools.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W025 files (no new configuration)", async () => {
    for (const rel of W025_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(
        false,
      );
    }
    // NET-W025 adds NO configuration entries and NO secrets (the
    // procurement boundary needs no key material — deterministic
    // derivation only).
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    expect(schema).not.toMatch(/PROCUREMENT_/);
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).not.toMatch(/PROCUREMENT_/);
  });
});
