/**
 * NET-W035-AC-10 — architecture/authority/scope regression (issue #71).
 *
 * NET-W035 is the Phase-9 creator end-to-end composition proof: it
 * adds NO production source file, NO domain, NO authority, NO
 * ledger, NO crypto, NO second workflow engine, NO new vocabulary and
 * NO W036 behavior. The entire W035 artifact set is composition
 * tests (the tests/creator-lifecycle/ suites + the shared harness) +
 * this regression suite + the evidence ledger + the ONE declared
 * test-harness composition adjustment (the NET-W018 TEST harness
 * option forwarding — a tests/ file, never src/). Every mutation in
 * the canonical path runs through an existing owning boundary; every
 * join is an existing sanctioned composition-root composite.
 *
 * The frozen Architecture v1.0 and the authority guards pass over the
 * WHOLE tree (0 violations); the frozen vocabularies the composed
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
const W035_DIR = join(REPO, "tests/creator-lifecycle");

/**
 * The complete NET-W035 artifact set (tests + docs — NO src). The
 * ONE production-adjacent entry is the declared NET-W018 TEST
 * harness adjustment (option forwarding — a tests/ file).
 */
const W035_TEST_FILES = [
  "tests/creator-lifecycle/_net-w035-harness.ts",
  "tests/creator-lifecycle/net-w035-full-path-scenario.test.ts",
  "tests/creator-lifecycle/net-w035-ac-01-creator-discovery.test.ts",
  "tests/creator-lifecycle/net-w035-ac-02-campaign-terms.test.ts",
  "tests/creator-lifecycle/net-w035-ac-03-acceptance-ugc-rights.test.ts",
  "tests/creator-lifecycle/net-w035-ac-04-disclosure.test.ts",
  "tests/creator-lifecycle/net-w035-ac-05-measurement.test.ts",
  "tests/creator-lifecycle/net-w035-ac-06-evidence.test.ts",
  "tests/creator-lifecycle/net-w035-ac-07-workflow-risk-dispute.test.ts",
  "tests/creator-lifecycle/net-w035-ac-08-settlement-payment.test.ts",
  "tests/creator-lifecycle/net-w035-ac-09-replay-concurrency-atomicity.test.ts",
  "tests/regression/net-w035-ac-10-architecture-out-of-scope.test.ts",
  "tests/creators/_net-w018-harness.ts",
  "docs/net-w035-complete-creator-lifecycle.md",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W035-AC-10 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass over the whole tree (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(322);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(322);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; no creator-lifecycle boundary)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // The 16 frozen domain boundaries — no /lifecycle, /composition,
    // /creator-lifecycle or any other new boundary appears.
    for (const forbiddenBoundary of [
      "- `/lifecycle`",
      "- `/composition`",
      "- `/creator-lifecycle`",
      "- `/creatorLifecycle`",
    ]) {
      expect(lock).not.toContain(forbiddenBoundary);
      expect(arch).not.toContain(forbiddenBoundary);
    }
    // The frozen src/ directory set — EXACTLY the 16 domain
    // boundaries + the established non-domain directories (no new
    // directory was added by W035).
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

  test("the NET-W035 work order exists and binds to frozen Architecture v1.0 + Issue #71", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W035.md"), "utf8");
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#71");
    expect(workOrder).toContain("Complete creator lifecycle");
    expect(workOrder).toContain("/ creators         ← creator identity, creator records, matching inputs");
    expect(workOrder).toContain("/ workflows        ← sole opportunity/contribution lifecycle authority");
    expect(workOrder).toContain("/ settlement       ← sole economic/payment authority");
    expect(workOrder).toContain("not a new authority");
    expect(workOrder).toContain("no new creator domain or creator-specific authority");
    expect(workOrder).toContain("no payment authority outside existing `/payments` integration and `/settlement` semantic ownership");
    expect(workOrder).toContain("no architecture-file amendment");
  });

  test("the composed vocabularies are pinned UNCHANGED (the frozen contracts W035 composes over)", () => {
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
    // The dispute subject types (the maturation gates).
    expect(DISPUTE_SUBJECT_TYPES).toHaveLength(8);
    expect([...DISPUTE_SUBJECT_TYPES]).toContain("economic_value");
    expect([...DISPUTE_SUBJECT_TYPES]).toContain("contribution");
  });

  test("NET-W035 adds NO production source file (the entire artifact set is tests + docs + ONE declared test-harness adjustment)", async () => {
    // No src file carries a W035 marker.
    for (const dir of DOMAIN_DIRS) {
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry NET-W035 implementation markers`,
        ).not.toContain("NET-W035:");
      }
    }
    // Every declared W035 artifact exists.
    for (const rel of W035_TEST_FILES) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
    // The test directory contains EXACTLY the W035 suites (no stray
    // implementation files smuggled in).
    const w035Files = (await readdir(W035_DIR)).filter((f) => f.endsWith(".ts"));
    expect(w035Files.sort()).toEqual(
      W035_TEST_FILES.filter((f) => f.startsWith("tests/creator-lifecycle/"))
        .map((f) => f.slice("tests/creator-lifecycle/".length))
        .sort(),
    );
    // The ONE declared adjustment: the NET-W018 TEST harness forwards
    // the PRE-EXISTING NetW008HarnessOptions (the W015/W016/W017
    // chain already threaded them down to createRuntime — the
    // measurement-provider registry is the NET-W006 surface; the
    // external-settlement trust keys are the NET-W030 surface). Both
    // production options PRE-DATE W035 — the runtime source carries
    // the pre-existing markers and no W035 marker.
    const runtimeSource = await readFile(
      join(REPO, "src/bootstrap/runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("NET-W006: explicitly configured measurement provider adapters");
    expect(runtimeSource).toContain("externalSettlementTrustKeys");
    expect(runtimeSource).not.toContain("NET-W035");
    const w018Harness = await readFile(
      join(REPO, "tests/creators/_net-w018-harness.ts"),
      "utf8",
    );
    expect(w018Harness).toContain("createNetW017Harness(opts)");
    expect(w018Harness).toContain("NetW008HarnessOptions");
  });

  test("the W035 composition tests compose ONLY through the owning boundaries (no direct repository writes)", async () => {
    // The composition suites (this regression suite necessarily
    // NAMES the banned patterns — it is excluded from the scan).
    const compositionFiles = W035_TEST_FILES.filter(
      (f) => f.startsWith("tests/creator-lifecycle/") && f.endsWith(".ts"),
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

  test("NO W036 behavior: the composition files carry no procurement/sourcing lifecycle vocabulary", async () => {
    const compositionFiles = W035_TEST_FILES.filter(
      (f) => f.startsWith("tests/creator-lifecycle/") && f.endsWith(".ts"),
    );
    for (const rel of compositionFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No new demand/procurement lifecycle (W036).
      expect(content).not.toMatch(/\bprocurementLifecycle\b/i);
      expect(content).not.toMatch(/\bsourcingLifecycle\b/i);
      // No new cryptographic surface (W029 remains the sole signing
      // authority — the W035 tests never construct keys).
      expect(content).not.toMatch(/generateKeyPair/);
      expect(content).not.toMatch(/createPrivateKey/);
    }
  });

  test("the composition root remains the ONLY cross-domain join (wiring pins for the composed composites)", async () => {
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    // The composites the canonical creator path runs through are
    // wired at the composition root EXACTLY as before (W035 adds
    // nothing).
    expect(runtime).toContain("async recognizeContributionValue(");
    expect(runtime).toContain("async matureEconomicValue(");
    expect(runtime).toContain("async submitMeasurementReport(");
    expect(runtime).toContain("async recordExternalSettlementFact(");
    expect(runtime).toContain("async evaluateExternalSettlementReconciliation(");
    // The gates the composed path honors (risk + dispute — the W009/
    // W010 controls over maturation).
    expect(runtime).toContain('refuseWhenGated(');
    expect(runtime).toContain('refuseWhenDisputed(');
    // The creator matching service is wired as the W016 authority.
    expect(runtime).toContain("creatorMatchingService");
    // The external settlement service is wired as the W030 boundary.
    expect(runtime).toContain("externalSettlementService");
  });

  test("the secret boundary holds: no key material in the W035 files; NO new secret/config surface", async () => {
    for (const rel of W035_TEST_FILES) {
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
    expect(schema).not.toMatch(/W035\w*KEY/);
    expect(schema).not.toMatch(/CREATOR\w*KEY/);
  });

  test("the frozen architecture files carry NO W035-era amendment (no silent changes)", async () => {
    // The W035 milestone sanctions NO shared-file amendment.
    for (const rel of [
      "spec/architecture.md",
      "spec/architecture-lock.md",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toContain("NET-W035");
    }
  });

  test("the W035 determinism contract: no wall-clock anchors in the proof paths (the dispute fixture binds the authoritative subject anchor)", async () => {
    // The W034 PR #70 remediation discipline carried forward: the
    // dispute fixture derives its anchor from the subject's OWN
    // authoritative timestamp (contribution.createdAt /
    // economic_value.recordedAt) — never Date.now().
    const harness = await readFile(
      join(REPO, "tests/creator-lifecycle/_net-w035-harness.ts"),
      "utf8",
    );
    expect(harness).toContain("subjectAnchorAt");
    expect(harness).toContain("effectiveAt: subjectAnchorAt");
    // The fixed evaluation anchor for the risk assessment (the W016
    // fixture discipline).
    expect(harness).toContain('evaluatedAt: "2026-09-01T12:00:00.000Z"');
  });
});
