/**
 * NET-W023-AC-08 — architecture/out-of-scope regression (issue #46).
 *
 * NET-W023 ships INSIDE the frozen `/adapters` boundary + the
 * /measurement provider tier (NO 17th domain; architecture.md §18
 * already names `/adapters` — "external platform/provider
 * integrations"). `/inventory` remains the supply authority (ZERO
 * inventory/outcomes/campaigns file changes: the exact-one lookup is
 * a bootstrap-root read over the existing org-scoped service API);
 * `/measurement` + `/outcomes` remain the measurement path (the ONE
 * material operation reuses the W022 ingestion composite unchanged).
 * No economic/trust/lifecycle mutation surface, no provider SDK
 * crossing into domain authorities, no OpenRTB vocabulary in domain
 * modules or the API transport.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  OPENRTB_REQUEST_REJECTION_REASONS,
  EXTERNAL_ADMISSION_REJECTION_REASONS,
  SUPPLY_CHAIN_VERIFICATION_STATUSES,
  SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM,
  SELLER_RELATIONSHIP_KINDS,
  SELLER_AUTHORIZATION_SOURCE_KINDS,
  OPENRTB_SUPPORTED_VERSIONS,
} from "../../src/adapters/port.ts";
import {
  MEASUREMENT_REPORT_REJECTION_REASONS,
} from "../../src/measurement/port.ts";
import {
  INVENTORY_FORMATS,
  INVENTORY_SURFACE_KINDS,
} from "../../src/core/inventory.ts";
import { ATTRIBUTION_MODES } from "../../src/core/measurement.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W023_FILES = [
  "src/adapters/port.ts",
  "src/adapters/registry.ts",
  "src/adapters/ingress.ts",
  "src/adapters/openrtb/canonical-json.ts",
  "src/adapters/openrtb/vendor-request.ts",
  "src/adapters/openrtb/supply-chain-files.ts",
  "src/adapters/openrtb/authorization-integrity.ts",
  "src/adapters/openrtb/reference-adapter.ts",
  "src/measurement/providers/openrtb-delivery-adapter.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W023-AC-08 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W023 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(281);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(281);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /adapters was already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    // /adapters is already a frozen boundary (architecture §18).
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("| `/adapters` | external platform/provider integrations |");
    // NET-W023 adds NO boundary (OpenRTB lives in the existing
    // /adapters adapter tier).
    expect(lock).not.toContain("- `/openrtb`");
    expect(lock).not.toContain("- `/supply-chain`");
    expect(lock).not.toContain("- `/ads`");
  });

  test("the NET-W023 work order exists and binds to frozen Architecture v1.0 + Issue #46", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W023.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("ADAPTER-001..002");
    expect(workOrder).toContain("#46");
    expect(workOrder).toContain("OpenRTB and supply-chain adapters");
    // The authority-separation decision of record.
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("exact");
    expect(workOrder).toContain("settlement");
    expect(workOrder).toContain("privacy");
  });

  test("the new rejection-reason vocabularies are pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W023 vocabularies.
    expect([...OPENRTB_REQUEST_REJECTION_REASONS]).toEqual([
      "malformed_request",
      "unsupported_openrtb_version",
      "missing_request_id",
      "missing_supply_identity",
      "invalid_supply_identity",
      "cardinality_exceeded",
      "payload_too_large",
      "unsafe_critical_value",
      "ambiguous_supply_chain",
    ]);
    expect([...EXTERNAL_ADMISSION_REJECTION_REASONS]).toEqual([
      "supply_not_found",
      "ambiguous_supply",
      "supply_retired",
      "supply_format_mismatch",
      "supply_chain_absent",
      "supply_chain_incomplete",
      "supply_chain_unauthenticated",
      "supply_chain_mismatched",
      "supply_chain_stale",
      "supply_chain_ambiguous",
    ]);
    expect([...SUPPLY_CHAIN_VERIFICATION_STATUSES]).toEqual([
      "verified",
      "absent",
      "incomplete",
      "unauthenticated",
      "mismatched",
      "stale",
      "ambiguous",
    ]);
    expect([...SELLER_RELATIONSHIP_KINDS]).toEqual([
      "direct",
      "reseller",
      "publisher",
      "intermediary",
      "both",
    ]);
    expect([...SELLER_AUTHORIZATION_SOURCE_KINDS]).toEqual([
      "ads.txt",
      "app-ads.txt",
      "sellers.json",
    ]);
    expect([...OPENRTB_SUPPORTED_VERSIONS]).toEqual(["2.5", "2.6"]);
    // PR #47 remediation: the trust-envelope algorithm vocabulary.
    expect(SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM).toBe("hmac-sha256");
    // The FROZEN vocabularies are unchanged.
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
  });

  test("PROVIDER FACTS ARE NOT AUTHORITY: the adapter tier has NO mutation surface (no domain imports either)", async () => {
    for (const rel of W023_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic/trust/lifecycle mutation vocabulary in the
      // adapters boundary (the issue #46 non-goals).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\bsettleCash\b/);
      expect(content).not.toMatch(/\brecordReputation\b/);
      expect(content).not.toMatch(/\bapplyTransition\b/);
      expect(content).not.toMatch(/\bcreateRiskSignal\b/);
      // No persistence/audit writes from the adapter tier — the
      // boundary never mutates.
      expect(content).not.toMatch(/\bsaveWithinTx\b/);
      expect(content).not.toMatch(/\bapplyIdempotent\b/);
      expect(content).not.toMatch(/\bforTransaction\b/);
      // No domain imports (tier matrix: adapter → domain forbidden).
      expect(content).not.toMatch(
        /from ["']\.\.\/?\.\.?\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|demand|benefits|opportunities|contributions|identity|organizations|participants)\//,
      );
    }
  });

  test("PROVIDER VOCABULARY CONTAINMENT: no OpenRTB/supply-chain vocabulary in domain authorities or the API transport", async () => {
    for (const dir of DOMAIN_DIRS) {
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry OpenRTB vocabulary`,
        ).not.toMatch(/\bopenrtb\b/i);
        expect(content).not.toMatch(/\bschain\b/i);
        expect(content).not.toMatch(/\bbidfloor\b/i);
        expect(content).not.toMatch(/\badsTxt\b/i);
        expect(content).not.toMatch(/\bsellersJson\b/i);
      }
    }
    // The API transport stays provider-neutral (the W022 pin,
    // restated for W023: vendor vocabulary stays in /adapters).
    const api = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(api).not.toMatch(/openrtb/i);
    expect(api).not.toMatch(/schain/i);
    expect(api).not.toMatch(/bidfloor/i);
    // The neutral /adapters index exports ONLY neutral files (the
    // tier matrix forbids the neutral index from re-exporting the
    // adapter tier).
    const index = await readFile(join(REPO, "src/adapters/index.ts"), "utf8");
    expect(index).not.toContain("registry");
    expect(index).not.toContain("ingress.ts");
    expect(index).not.toContain("openrtb/");
    // The W022 measurement provider index is UNCHANGED (the delivery
    // adapter is deliberately not re-exported there).
    const measurementIndex = await readFile(
      join(REPO, "src/measurement/providers/index.ts"),
      "utf8",
    );
    expect(measurementIndex).not.toContain("openrtb-delivery-adapter");
  });

  test("the domain authorities are UNTOUCHED by NET-W023 (additive-only wiring at the composition root)", async () => {
    // /inventory: the supply authority has ZERO W023 surface — the
    // exact-one lookup is a bootstrap-root read over the EXISTING
    // org-scoped list API.
    const inventoryService = await readFile(
      join(REPO, "src/inventory/inventory-service.ts"),
      "utf8",
    );
    expect(inventoryService).not.toMatch(/openrtb/i);
    expect(inventoryService).not.toMatch(/adRequest/i);
    expect(inventoryService).not.toMatch(/externalSupply/i);
    const inventoryPort = await readFile(
      join(REPO, "src/inventory/port.ts"),
      "utf8",
    );
    expect(inventoryPort).not.toMatch(/openrtb/i);
    // /outcomes: the W006/W022 method set is intact (the measurement
    // path reuses the ingestion composite unchanged).
    const observationService = await readFile(
      join(REPO, "src/outcomes/observation-service.ts"),
      "utf8",
    );
    for (const method of [
      "async createOutcomeObservation(",
      "async ingestProviderObservations(",
      "async ingestProviderReport(",
    ]) {
      expect(observationService).toContain(method);
    }
    // /campaigns: the policy authority is untouched by external
    // requests (no ad-request surface).
    const campaignsPort = await readFile(
      join(REPO, "src/campaigns/port.ts"),
      "utf8",
    );
    expect(campaignsPort).not.toMatch(/openrtb/i);
  });

  test("the composition root is the ONLY join between /adapters and the domain authorities (wiring pins)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The ingress service is wired with the NEUTRAL read-only
    // inventory lookup (implemented at the root over /inventory
    // reads — the adapter tier may not import the domain).
    expect(runtime).toContain("createOpenRtbIngressService(");
    expect(runtime).toContain("resolveByExternalReference");
    expect(runtime).toContain("inventoryService.listInventoryItems");
    // The evaluation composite performs no mutation.
    expect(runtime).toContain("async evaluateExternalAdRequest(");
    // The ONLY material path reuses the W022 ingestion composite.
    expect(runtime).toContain("async submitMeasurementReport(");
    // The delivery-notice secret resolves ONLY through the
    // SecretProvider (auto-wire iff present).
    expect(runtime).toContain("MEASUREMENT_OPENRTB_DELIVERY_SECRET_KEY");
    // PR #47 remediation: the seller-authorization trust channel key
    // resolves ONLY through the SecretProvider (or the explicit
    // composition override) and injects into the ingress.
    expect(runtime).toContain("SELLER_AUTHORIZATION_TRUST_SECRET_KEY");
    expect(runtime).toContain("sellerAuthorizationTrustKey");
    // The neutral port is the only adapters surface the API sees.
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).toContain("adapters/port.ts");
    expect(apiPort).not.toMatch(/adapters\/(openrtb|registry|ingress)\//);
  });

  test("the NET-W023 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W023.md",
      ...W023_FILES,
      "tests/adapters/_net-w023-harness.ts",
      "tests/adapters/net-w023-ac-01-neutral-contract.test.ts",
      "tests/adapters/net-w023-ac-02-fail-closed-validation.test.ts",
      "tests/adapters/net-w023-ac-03-supply-chain-normalization.test.ts",
      "tests/adapters/net-w023-ac-04-exact-one-inventory.test.ts",
      "tests/adapters/net-w023-ac-05-no-authority-bypass.test.ts",
      "tests/adapters/net-w023-ac-06-determinism-privacy.test.ts",
      "tests/adapters/net-w023-ac-07-tenancy-idempotency.test.ts",
      "tests/regression/net-w023-ac-08-architecture-out-of-scope.test.ts",
      "docs/net-w023-openrtb-supply-chain.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W023 files", async () => {
    for (const rel of W023_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(
        false,
      );
    }
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    // The .env.example documents the new secret NAMES only (no values).
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).toContain("MEASUREMENT_OPENRTB_DELIVERY_KEY=");
    expect(envExample).not.toMatch(/MEASUREMENT_OPENRTB_DELIVERY_KEY=\S+/);
    // PR #47 remediation: the trust-channel secret name only.
    expect(envExample).toContain("SELLER_AUTHORIZATION_TRUST_KEY=");
    expect(envExample).not.toMatch(/SELLER_AUTHORIZATION_TRUST_KEY=\S+/);
  });
});
