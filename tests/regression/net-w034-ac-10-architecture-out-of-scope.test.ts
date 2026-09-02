/**
 * NET-W034-AC-10 — architecture/authority/scope regression (issue #69).
 *
 * NET-W034 is the Phase-9 advertising end-to-end composition proof:
 * it adds NO production source file, NO domain, NO authority, NO
 * ledger, NO crypto, NO second workflow engine, NO new vocabulary and
 * NO W035/W036 behavior. The entire W034 artifact set is composition
 * tests (the tests/advertising/ suites + the shared harness) + this
 * regression suite + the evidence ledger + the ONE declared
 * test-harness composition adjustment (the NET-W008 TEST harness
 * measurement threading — a tests/ file, never src/). Every mutation
 * in the canonical path runs through an existing owning boundary;
 * every join is an existing sanctioned composition-root composite.
 *
 * The frozen Architecture v1.0 and the authority guards pass over
 * the WHOLE tree (0 violations); the frozen vocabularies the composed
 * chain consumes are pinned unchanged; the composition root remains
 * the only join; the secret boundary holds.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  EVIDENCE_GRADES,
  EVIDENCE_GRADE_RANK,
} from "../../src/core/evidence.ts";
import {
  REPUTATION_DIMENSIONS,
  REPUTATION_INPUT_SOURCES,
  REPUTATION_INPUT_BASES,
} from "../../src/core/reputation.ts";
import { ECONOMIC_VALUE_SOURCES } from "../../src/core/economics.ts";
import { DISPUTE_SUBJECT_TYPES } from "../../src/core/disputes.ts";
import { REQUIRED_IN_PRODUCTION } from "../../src/config/schema.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");
const W034_DIR = join(REPO, "tests/advertising");

/** The complete NET-W034 artifact set (tests + docs — NO src). */
const W034_TEST_FILES = [
  "tests/advertising/_net-w034-harness.ts",
  "tests/advertising/net-w034-full-path-scenario.test.ts",
  "tests/advertising/net-w034-ac-01-campaign.test.ts",
  "tests/advertising/net-w034-ac-02-supply.test.ts",
  "tests/advertising/net-w034-ac-03-matching.test.ts",
  "tests/advertising/net-w034-ac-04-placement-lifecycle.test.ts",
  "tests/advertising/net-w034-ac-05-measurement.test.ts",
  "tests/advertising/net-w034-ac-06-evidence.test.ts",
  "tests/advertising/net-w034-ac-07-workflow-risk-dispute.test.ts",
  "tests/advertising/net-w034-ac-08-settlement.test.ts",
  "tests/advertising/net-w034-ac-09-replay-concurrency-atomicity.test.ts",
  "tests/advertising/net-w034-ac-10-traversal-architecture.test.ts",
  "tests/regression/net-w034-ac-10-architecture-out-of-scope.test.ts",
  "docs/net-w034-complete-advertising-lifecycle.md",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W034-AC-10 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass over the whole tree (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(322);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(322);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; no advertising boundary)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // The 16 frozen domain boundaries — no /lifecycle, /composition,
    // /advertising or any other new boundary appears.
    for (const forbiddenBoundary of [
      "- `/lifecycle`",
      "- `/composition`",
      "- `/advertising`",
      "- `/advertising-lifecycle`",
    ]) {
      expect(lock).not.toContain(forbiddenBoundary);
      expect(arch).not.toContain(forbiddenBoundary);
    }
    // The frozen src/ directory set — EXACTLY the 16 domain
    // boundaries + the established non-domain directories (no new
    // directory was added by W034).
    const srcEntries = await readdir(SRC, { withFileTypes: true });
    const dirs = srcEntries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([
      "adapters", "agents", "api", "audit", "benefits", "bootstrap",
      "campaigns", "config", "contributions", "core", "creators",
      "demand", "disputes", "evidence", "identity", "inventory",
      "ledger", "llm", "measurement", "object-storage",
      "observability", "opportunities", "organizations", "outcomes",
      "participants", "payments", "persistence", "queues",
      "reputation", "secrets", "settlement", "workers", "workflows",
    ]);
  });

  test("the NET-W034 work order exists and binds to frozen Architecture v1.0 + Issue #69", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W034.md"), "utf8");
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#69");
    expect(workOrder).toContain("Complete advertising lifecycle");
    expect(workOrder).toContain("/ campaigns        ← campaign policy/configuration + matching selection");
    expect(workOrder).toContain("/ workflows        ← sole opportunity/contribution lifecycle authority");
    expect(workOrder).toContain("/ settlement       ← sole economic authority");
    expect(workOrder).toContain("not a new authority");
    expect(workOrder).toContain("no new advertising domain or authority");
    expect(workOrder).toContain("no advertising ledger exists");
    expect(workOrder).toContain("no architecture-file amendment");
  });

  test("the composed vocabularies are pinned UNCHANGED (the frozen contracts W034 composes over)", () => {
    // The economic source kinds (the recognition/settlement chain).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
    // The reputation input surface (the basis derivation is
    // server-side; the source kinds are the four authority records).
    expect([...REPUTATION_INPUT_SOURCES]).toEqual([
      "evidence",
      "proof_of_value",
      "measured_outcome",
      "contribution",
    ]);
    expect([...REPUTATION_INPUT_BASES]).toEqual(["verified", "indicated"]);
    expect([...REPUTATION_DIMENSIONS]).toHaveLength(8);
    // The evidence grade vocabulary + frozen rank (1 = best).
    expect([...EVIDENCE_GRADES]).toEqual([
      "MEASURED",
      "ATTESTED",
      "PROVIDER_REPORTED",
      "MODEL_ASSESSED",
      "SELF_REPORTED",
    ]);
    expect(EVIDENCE_GRADE_RANK.MEASURED).toBe(1);
    expect(EVIDENCE_GRADE_RANK.SELF_REPORTED).toBe(5);
    // The dispute subject types (the maturation/clearing gates).
    expect(DISPUTE_SUBJECT_TYPES).toHaveLength(8);
    expect([...DISPUTE_SUBJECT_TYPES]).toContain("economic_value");
    expect([...DISPUTE_SUBJECT_TYPES]).toContain("contribution");
  });

  test("NET-W034 adds NO production source file (the entire artifact set is tests + docs + ONE declared test-harness adjustment)", async () => {
    // No src file carries a W034 marker.
    for (const dir of DOMAIN_DIRS) {
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry NET-W034 implementation markers`,
        ).not.toContain("NET-W034:");
      }
    }
    // Every declared W034 artifact exists.
    for (const rel of W034_TEST_FILES) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
    // The test directory contains EXACTLY the W034 suites (no stray
    // implementation files smuggled in).
    const w034Files = (await readdir(W034_DIR)).filter((f) => f.endsWith(".ts"));
    expect(w034Files.sort()).toEqual(
      W034_TEST_FILES.filter((f) => f.startsWith("tests/advertising/"))
        .map((f) => f.slice("tests/advertising/".length))
        .sort(),
    );
    // The ONE declared adjustment: the NET-W008 TEST harness threads
    // the PRE-EXISTING createRuntime measurement option (the W006
    // surface — the threading is test-only, the production option
    // pre-dates W034).
    const runtimeSource = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("NET-W006: explicitly configured measurement provider adapters");
    expect(runtimeSource).not.toContain("NET-W034");
  });

  test("the W034 composition tests compose ONLY through the owning boundaries (no direct repository writes)", async () => {
    // The composition suites (this regression suite necessarily
    // NAMES the banned patterns — it is excluded from the scan).
    const compositionFiles = W034_TEST_FILES.filter(
      (f) => f.startsWith("tests/advertising/") && f.endsWith(".ts"),
    );
    for (const rel of compositionFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No direct authority/repository mutation from the test tier:
      // the scenario composes services + composites only.
      expect(content, `${rel} must not write repositories`).not.toMatch(
        /\.put\(/,
      );
      expect(content).not.toMatch(/saveWithinTx/);
      expect(content).not.toMatch(/deleteWithinTx/);
      // No second lifecycle machinery (the structural no-second-
      // state-machine pin, whole directory).
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
    }
  });

  test("NO W035/W036 behavior: the composition files carry no creator/procurement lifecycle vocabulary", async () => {
    const compositionFiles = W034_TEST_FILES.filter(
      (f) => f.startsWith("tests/advertising/") && f.endsWith(".ts"),
    );
    for (const rel of compositionFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No creator lifecycle (W035).
      expect(content).not.toMatch(/\bcreatorOnboarding\b/i);
      expect(content).not.toMatch(/\bcreatorLifecycle\b/i);
      expect(content).not.toMatch(/\bcreatorContract\b/i);
      // No new demand/procurement lifecycle (W036).
      expect(content).not.toMatch(/\bprocurementLifecycle\b/i);
      expect(content).not.toMatch(/\bsourcingLifecycle\b/i);
      // No new cryptographic surface (W029 remains the sole signing
      // authority — the W034 tests never construct keys).
      expect(content).not.toMatch(/generateKeyPair/);
      expect(content).not.toMatch(/createPrivateKey/);
    }
  });

  test("the composition root remains the ONLY cross-domain join (wiring pins for the composed composites)", async () => {
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    // The composites the canonical advertising path runs through are
    // wired at the composition root EXACTLY as before (W034 adds
    // nothing).
    expect(runtime).toContain("async recognizeContributionValue(");
    expect(runtime).toContain("async matureEconomicValue(");
    expect(runtime).toContain("async executeCrossPromotionClearing(");
    expect(runtime).toContain("async submitMeasurementReport(");
    expect(runtime).toContain("async evaluateExternalAdRequest(");
    // The gates the composed path honors (risk + dispute — the W009/
    // W010 controls over maturation + clearing).
    expect(runtime).toContain('refuseWhenGated(');
    expect(runtime).toContain('refuseWhenDisputed(');
    // The campaigns matching service is wired as the W021 authority.
    expect(runtime).toContain("campaignMatchingService");
  });

  test("the secret boundary holds: no key material in the W034 files; NO new secret/config surface", async () => {
    for (const rel of W034_TEST_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(false);
    }
    // No NEW required-in-production secret (the composed chain uses
    // the existing services — zero new names).
    expect([...REQUIRED_IN_PRODUCTION]).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "OBJECT_STORAGE_BUCKET",
    ]);
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(schema).not.toMatch(/W034\w*KEY/);
    expect(schema).not.toMatch(/ADVERTISING\w*KEY/);
  });

  test("the frozen architecture files carry NO W034-era amendment (no silent changes)", async () => {
    // The W034 milestone sanctions NO shared-file amendment. (The
    // dependency-graph legitimately DECLARES the pre-existing W034
    // node + edges — it is the activation state, not an amendment.)
    for (const rel of [
      "spec/architecture.md",
      "spec/architecture-lock.md",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toContain("NET-W034");
    }
  });
});
