/**
 * NET-W022-AC-07 — architecture/out-of-scope regression (issue #44).
 *
 * NET-W022 ships INSIDE the frozen `/measurement` boundary + the
 * adapter tier (NO 17th domain; architecture.md §18 already names
 * `/measurement` — "measurement provider integrations; semantics
 * remain in `/outcomes`"). `/outcomes` remains the sole measurement
 * semantics authority: the only /outcomes change is the ADDITIVE
 * push-ingestion interface (ingestProviderReport); the lifecycle,
 * transition table and W006 vocabulary are unchanged. The measurement
 * tier performs NO mutation (normalization only); the composition
 * root is the only place measurement + /outcomes join. No OpenRTB/
 * ads.txt/sellers.json (NET-W023), no economic/trust/lifecycle
 * mutation surface, no vendor SDK crossing into domain authorities.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import {
  MEASUREMENT_REPORT_REJECTION_REASONS,
} from "../../src/measurement/port.ts";
import { ATTRIBUTION_MODES } from "../../src/core/measurement.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W022_FILES = [
  "src/measurement/port.ts",
  "src/measurement/registry.ts",
  "src/measurement/ingestion.ts",
  "src/measurement/providers/report-integrity.ts",
  "src/measurement/providers/report-normalization.ts",
  "src/measurement/providers/browser-attribution-adapter.ts",
  "src/measurement/providers/ios-attribution-adapter.ts",
  "src/measurement/providers/index.ts",
];

describe("NET-W022-AC-07 architecture / out-of-scope", () => {
  test("the architecture authority guard passes with all NET-W022 files (0 violations)", async () => {
    const result = await scanAuthorityBoundaries(SRC);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThanOrEqual(273);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /measurement was already frozen)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    // /measurement is already a frozen boundary (architecture §18).
    expect(lock).toContain("- `/measurement`");
    // NET-W022 adds NO boundary (adapters live in the existing
    // /measurement adapter tier).
    expect(lock).not.toContain("- `/attribution`");
    expect(lock).not.toContain("- `/privacy`");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(arch).toContain("measurement provider integrations");
  });

  test("the NET-W022 work order exists and binds to frozen Architecture v1.0 + Issue #44", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W022.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 (FROZEN");
    expect(workOrder).toContain("OUT-002");
    expect(workOrder).toContain("PRIV-002");
    expect(workOrder).toContain("ADAPTER-003");
    expect(workOrder).toContain("ADAPTER-004");
    expect(workOrder).toContain("#44");
    expect(workOrder).toContain("Attribution and privacy measurement adapters");
    // The authority-separation decision of record.
    expect(workOrder).toContain("semantic authority");
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("privacy");
  });

  test("the new rejection-reason vocabulary is pinned; every frozen vocabulary is UNCHANGED", () => {
    // The NEW NET-W022 vocabulary.
    expect([...MEASUREMENT_REPORT_REJECTION_REASONS]).toEqual([
      "malformed_report",
      "unsupported_attribution_mode",
      "invalid_attribution_mode",
      "missing_provenance",
      "ambiguous_subject_mapping",
      "unverifiable_integrity",
      "unsupported_push_ingestion",
    ]);
    // The FROZEN core vocabularies are unchanged.
    expect([...ATTRIBUTION_MODES]).toEqual([
      "deterministic",
      "probabilistic",
      "experimental",
    ]);
    // The outcome-measurement transition table is unchanged.
    expect(OUTCOME_MEASUREMENT_TRANSITION_TABLE.length).toBe(4);
  });

  test("PROVIDER FACTS ARE NOT AUTHORITY: the measurement tier has NO mutation surface (normalization only)", async () => {
    for (const rel of W022_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic/trust/lifecycle mutation vocabulary in the
      // measurement tier (the issue #44 non-goals).
      expect(content).not.toMatch(/\bissueCredit\b/);
      expect(content).not.toMatch(/\bsettleCash\b/);
      expect(content).not.toMatch(/\brecordReputation\b/);
      expect(content).not.toMatch(/\bapplyTransition\b/);
      // No persistence/audit writes from the adapter tier — the
      // measurement boundary never mutates.
      expect(content).not.toMatch(/\bsaveWithinTx\b/);
      expect(content).not.toMatch(/\bapplyIdempotent\b/);
      expect(content).not.toMatch(/\bforTransaction\b/);
      // No domain imports (tier matrix: adapter → domain forbidden).
      expect(content).not.toMatch(/from ["']\.\.\/\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence)\//);
    }
  });

  test("the /outcomes change is ADDITIVE ONLY: one new method, no lifecycle/semantic change", async () => {
    const service = await readFile(
      join(REPO, "src/outcomes/observation-service.ts"),
      "utf8",
    );
    // The push method exists...
    expect(service).toContain("async ingestProviderReport(");
    // ...and the W006 method set is intact.
    expect(service).toContain("async ingestProviderObservations(");
    expect(service).toContain("async createOutcomeObservation(");
    expect(service).toContain("async correctOutcomeObservation(");
    // The observation lifecycle constants are unchanged.
    expect(service).toContain('OBSERVATION_CREATED = "outcome_observation.created"');
    expect(service).toContain('OBSERVATION_CORRECTED = "outcome_observation.corrected"');
    // The /outcomes domain still imports ONLY the neutral measurement
    // port (never the adapter tier — architecture-lock §14.24).
    const outcomesFiles = [
      "src/outcomes/port.ts",
      "src/outcomes/observation-service.ts",
    ];
    for (const rel of outcomesFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/from ["']\.\.\/measurement\/(providers|registry|ingestion)\//);
    }
  });

  test("the composition root is the ONLY join between measurement and /outcomes (provider-neutral wiring pins)", async () => {
    const runtime = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    // The composite command composes BOTH boundaries (the adapter
    // tier cannot import the domain — the tier matrix).
    expect(runtime).toContain("async submitMeasurementReport(");
    expect(runtime).toContain("measurementIngestion.normalizeSubmission(");
    expect(runtime).toContain("outcomeObservationService.ingestProviderReport(");
    // The secrets are resolved ONLY through the SecretProvider.
    expect(runtime).toContain("secretProvider.hasSecret(");
    expect(runtime).toContain("MEASUREMENT_BROWSER_ATTRIBUTION_SECRET_KEY");
    expect(runtime).toContain("MEASUREMENT_IOS_ATTRIBUTION_SECRET_KEY");
    // The neutral port is the only measurement surface /outcomes sees.
    const port = await readFile(join(REPO, "src/measurement/port.ts"), "utf8");
    expect(port).toContain("normalizeReport?(");
    // The neutral index still exports ONLY neutral files (the tier
    // matrix forbids the neutral index from re-exporting adapters).
    const index = await readFile(join(REPO, "src/measurement/index.ts"), "utf8");
    expect(index).not.toContain("registry");
    expect(index).not.toContain("ingestion.ts");
    expect(index).not.toContain("providers/");
  });

  test("no OpenRTB/ads.txt/sellers.json supply-chain vocabulary leaked into NET-W022 (NET-W023 is later)", async () => {
    for (const rel of W022_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bopenrtb\b/i);
      expect(content).not.toMatch(/\bOpenRTB\b/);
      expect(content).not.toMatch(/\badsTxt\b/i);
      expect(content).not.toMatch(/\bsellersJson\b/i);
      expect(content).not.toMatch(/\bsupplyChain\b/);
    }
    const api = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(api).not.toMatch(/openrtb/i);
  });

  test("the NET-W022 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W022.md",
      ...W022_FILES,
      "tests/measurement/_net-w022-harness.ts",
      "tests/measurement/net-w022-ac-01-contract-registration.test.ts",
      "tests/measurement/net-w022-ac-02-normalization-provenance.test.ts",
      "tests/measurement/net-w022-ac-03-fail-closed-validation.test.ts",
      "tests/measurement/net-w022-ac-04-privacy-redaction.test.ts",
      "tests/measurement/net-w022-ac-05-outcomes-integration.test.ts",
      "tests/measurement/net-w022-ac-06-http-integration.test.ts",
      "tests/regression/net-w022-ac-07-architecture-out-of-scope.test.ts",
      "docs/net-w022-attribution-privacy-measurement.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W022 files", async () => {
    const SECRET_VALUE_PATTERN =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    for (const rel of W022_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(
        false,
    );
    }
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    // The .env.example documents the new secret NAMES only (no values).
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).toContain("MEASUREMENT_BROWSER_ATTRIBUTION_KEY=");
    expect(envExample).toContain("MEASUREMENT_IOS_ATTRIBUTION_KEY=");
    expect(envExample).not.toMatch(
      /MEASUREMENT_(BROWSER|IOS)_ATTRIBUTION_KEY=\S+/,
    );
  });
});
