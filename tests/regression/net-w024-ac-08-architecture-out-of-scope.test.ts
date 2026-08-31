/**
 * NET-W024-AC-08 — architecture/out-of-scope regression (issue #48).
 *
 * NET-W024 ships INSIDE the frozen `/demand` boundary (NO 17th
 * domain; architecture.md §18 already names `/demand` — "demand
 * aggregation and benefit allocation"; architecture-lock §2 lists
 * `/demand` among the sixteen frozen core domains). `/settlement`
 * remains the economic authority (ZERO economic surface in /demand);
 * `/organizations` remains the membership authority (read-only
 * through the neutral composition-root lookup); `/workflows` is
 * untouched (closure/withdrawal are one-way field mutations). No
 * economic, lifecycle, reputation, risk or procurement mutation
 * surface; aggregates are DERIVED (never stored, never
 * caller-asserted) behind the frozen privacy floor.
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
  INVENTORY_FORMATS,
  INVENTORY_SURFACE_KINDS,
} from "../../src/core/inventory.ts";
import { ATTRIBUTION_MODES } from "../../src/core/measurement.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import { MEASUREMENT_REPORT_REJECTION_REASONS } from "../../src/measurement/port.ts";
import { SUPPLY_CHAIN_VERIFICATION_STATUSES } from "../../src/adapters/port.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W024_FILES = [
  "src/core/demand.ts",
  "src/demand/port.ts",
  "src/demand/module.ts",
  "src/demand/aggregation-engine.ts",
  "src/demand/authority-demand-repositories.ts",
  "src/demand/demand-service.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W024-AC-08 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W024 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(286);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(286);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /demand was already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    // /demand is already a frozen boundary (architecture §18 + lock §2).
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("| `/demand`, `/benefits` | demand aggregation and benefit allocation |");
    expect(lock).toContain("- `/demand`");
    // NET-W024 adds NO boundary (consumer demand pools live in the
    // existing frozen /demand domain).
    expect(lock).not.toContain("- `/demand-pools`");
    expect(lock).not.toContain("- `/procurement`");
    expect(lock).not.toContain("- `/consumer-demand`");
  });

  test("the NET-W024 work order exists and binds to frozen Architecture v1.0 + Issue #48", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W024.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("DEM-001..003");
    expect(workOrder).toContain("#48");
    expect(workOrder).toContain("Consumer Demand Pools");
    // The authority-separation decision of record.
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("settlement");
    expect(workOrder).toContain("privacy");
    expect(workOrder).toContain("consent");
  });

  test("the demand vocabularies are pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W024 vocabularies (closed, versioned, bounded).
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
    expect([...DEMAND_REGION_CODES]).toEqual([
      "NA_EAST",
      "NA_CENTRAL",
      "NA_WEST",
      "EU_NORTH",
      "EU_SOUTH",
      "EU_EAST",
      "EU_WEST",
      "APAC_EAST",
      "APAC_SOUTH",
      "APAC_SOUTHEAST",
      "LATAM",
      "MEA",
    ]);
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
    // THE FROZEN PRIVACY FLOOR (no policy can lower it).
    expect(DEMAND_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    // The closed consent scope + versions + bounds + lineage.
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
    // The FROZEN vocabularies of the prior work items are unchanged.
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

  test("DEMAND IS NOT AN ECONOMIC/LIFECYCLE AUTHORITY: no economic, reputation, risk or transition machinery in /demand", async () => {
    for (const rel of W024_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic mutation vocabulary (issue #48 architectural
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
      // No domain imports outside itself (tier matrix: domain →
      // core/neutral/self only).
      expect(content).not.toMatch(
        /from ["']\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|benefits|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
      // No procurement/supplier-offer/selection semantics (W025/W026).
      expect(content).not.toMatch(/\bprocurementPool\b/);
      expect(content).not.toMatch(/\bsupplierOffer\b/);
      expect(content).not.toMatch(/\bsupplierSelection\b/);
    }
  });

  test("DEMAND PRIVACY CONTAINMENT: commitment exposure vocabulary is confined to the actor-scoped surface; no provider vocabulary in /demand", async () => {
    // No provider/platform vocabulary in the demand files (the W023
    // containment, restated for the demand tier).
    for (const rel of W024_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bopenrtb\b/i);
      expect(content).not.toMatch(/\bschain\b/i);
      expect(content).not.toMatch(/\bbidfloor\b/i);
    }
    // The API transport: individual commitments are reachable ONLY
    // through the actor-scoped route (listMyDemandCommitments); there
    // is NO unguarded commitment listing.
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).toContain('"demand.commitments.read"');
    expect(apiServer).toContain("/api/demand/commitments/mine");
    // The ONLY commitment read command (actor-scoped, no
    // consumerPersonId input).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).toContain("listMyDemandCommitments(");
    expect(apiPort).toContain("no consumerPersonId input");
    expect(apiPort).not.toMatch(/listDemandCommitments\(\s*execution: ExecutionContext,\s*organizationScopeId: string,\s*consumerPersonId: string/);
    // No other domain carries demand-pool vocabulary (the boundary
    // owns it exclusively).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "demand") continue;
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry demand-pool vocabulary`,
        ).not.toMatch(/\bcreateDemandCommitment\b/);
        expect(content).not.toMatch(/\bevaluateQualifiedDemand\b/);
        expect(content).not.toMatch(/\bDemandPoolRepository\b/);
      }
    }
  });

  test("the economic + lifecycle authorities are UNTOUCHED by NET-W024", async () => {
    // /settlement: the economic authority surface is intact and has
    // no demand coupling.
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
    expect(settlementPort).not.toMatch(/demandPool/i);
    expect(settlementPort).not.toMatch(/QualifiedDemandAggregate/);
    // /workflows: the lifecycle authority is untouched (closure and
    // withdrawal are one-way field mutations, never transitions).
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/demand/i);
    // /organizations: the membership authority gains no demand
    // surface (the lookup is implemented at the composition root).
    const orgPort = await readFile(
      join(REPO, "src/organizations/port.ts"),
      "utf8",
    );
    expect(orgPort).not.toMatch(/demandPool/i);
  });

  test("the composition root is the ONLY join between /demand and the membership authority (wiring pins)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The demand service is wired at the root over the authority
    // repositories + the idempotency store + the transactional audit
    // writer.
    expect(runtime).toContain("createDemandService(");
    expect(runtime).toContain("createAuthorityDemandPoolRepository");
    expect(runtime).toContain("createAuthorityDemandCommitmentRepository");
    // The NEUTRAL membership lookup (thin read-only adapter over the
    // /organizations membership repository — the W002 pattern).
    expect(runtime).toContain("demandMembershipLookup");
    expect(runtime).toContain("membershipRepo.findByPersonAndOrganization");
    // The API command surface is wired.
    expect(runtime).toContain("async createDemandPool(");
    expect(runtime).toContain("async createDemandCommitment(");
    expect(runtime).toContain("async evaluateQualifiedDemand(");
    expect(runtime).toContain("async listMyDemandCommitments(");
    // The Runtime exposes the demand service.
    expect(runtime).toContain("readonly demandService: DemandService;");
    // The api port consumes the demand port types only (the neutral
    // surface: the API layer never imports the demand implementation
    // files, only the port).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/demand-service\.ts/);
    expect(apiPort).not.toMatch(/aggregation-engine\.ts/);
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).not.toMatch(/demand-service\.ts/);
    expect(apiServer).not.toMatch(/aggregation-engine\.ts/);
    expect(apiServer).toContain("demand.pools.create");
    expect(apiServer).toContain("demand.commitments.create");
    expect(apiServer).toContain("demand.aggregates.evaluate");
  });

  test("the NET-W024 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W024.md",
      ...W024_FILES,
      "src/demand/README.md",
      "tests/demand/_net-w024-harness.ts",
      "tests/demand/net-w024-ac-01-demand-records.test.ts",
      "tests/demand/net-w024-ac-02-deterministic-qualification.test.ts",
      "tests/demand/net-w024-ac-03-privacy-aggregation.test.ts",
      "tests/demand/net-w024-ac-04-threshold-policy.test.ts",
      "tests/demand/net-w024-ac-05-idempotency-concurrency.test.ts",
      "tests/demand/net-w024-ac-06-tenancy-authorization.test.ts",
      "tests/demand/net-w024-ac-07-atomicity-audit.test.ts",
      "tests/regression/net-w024-ac-08-architecture-out-of-scope.test.ts",
      "docs/net-w024-consumer-demand-pools.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W024 files (no new configuration)", async () => {
    for (const rel of W024_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(
        false,
      );
    }
    // NET-W024 adds NO configuration entries and NO secrets (the
    // demand boundary needs no key material — deterministic
    // derivation only).
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    expect(schema).not.toMatch(/DEMAND_/);
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).not.toMatch(/DEMAND_/);
  });
});
