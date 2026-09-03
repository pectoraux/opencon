/**
 * NET-W036-AC-10 — architecture/authority/scope regression (issue #75).
 *
 * NET-W036 is the Phase-9 demand/procurement/benefit end-to-end
 * composition proof: it adds NO production source file, NO domain, NO
 * authority, NO ledger, NO lifecycle machine, NO new economic
 * primitive, NO new W027/W028 semantics, NO new vocabulary and NO
 * W037 behavior. The entire W036 artifact set is composition tests
 * (the tests/demand-procurement-benefit-lifecycle/ suites + the
 * shared harness) + this regression suite + the evidence ledger +
 * the ONE sanctioned test-tier pin extension (the AC-04 suite
 * inventory 11→12 filename-list extension — a tests/ file, never
 * src/). Every mutation in the canonical path runs through an
 * existing owning boundary; every join is an existing sanctioned
 * composition-root composite.
 *
 * The frozen Architecture v1.0 and the authority guards pass over the
 * WHOLE tree (0 violations); the frozen vocabularies the composed
 * chain consumes are pinned unchanged; the composition root remains
 * the only join; the secret boundary holds; and the W036 suite is
 * ZERO wall-clock (STRONGER than the W035 determinism contract —
 * no sanctioned freshness exception exists).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import { ECONOMIC_VALUE_SOURCES, ECONOMIC_SCALE } from "../../src/core/economics.ts";
import { DEMAND_PRIVACY_MINIMUM_COMMITMENTS } from "../../src/core/demand.ts";
import {
  PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS,
  PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS,
} from "../../src/core/procurement.ts";
import {
  PROCUREMENT_BASELINE_METHODS,
  PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
} from "../../src/core/procurement-savings.ts";
import {
  SUPPLIER_OFFER_SELECTION_POLICY_VERSION,
  SUPPLIER_OFFER_RANKING_CRITERIA,
} from "../../src/core/procurement-offer.ts";
import {
  BENEFIT_TYPES,
  BENEFIT_FUNDING_SOURCE_KINDS,
  BENEFIT_ELIGIBILITY_CRITERIA,
  BENEFIT_REMAINDER_DISPOSITIONS,
  BENEFIT_ALLOCATION_POLICY_VERSION,
} from "../../src/benefits/port.ts";
import { REQUIRED_IN_PRODUCTION } from "../../src/config/schema.ts";
import {
  W036_EVIDENCE_CAPTURED_AT,
  W036_RISK_CONTROL_EVALUATED_AT,
  W036_NOTICE_COLLECTED_AT,
  W036_STALE_COLLECTED_AT,
  W036_STALE_BASELINE_WINDOW_ENDS_AT,
  W036_BASELINE_WINDOW_DAYS,
  W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  w036IsoMinusDays,
} from "../demand-procurement-benefit-lifecycle/_net-w036-harness.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");
const W036_DIR = join(REPO, "tests/demand-procurement-benefit-lifecycle");

/**
 * The complete NET-W036 artifact set (tests — NO src). The ONE
 * test-tier adjustment is the AC-04 suite-inventory pin extension
 * (11→12 filenames — a pure filename-list extension, documented in the
 * AC-04 structural pin itself).
 */
const W036_TEST_FILES = [
  "tests/demand-procurement-benefit-lifecycle/_net-w036-harness.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-full-path-scenario.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-01-demand-pool-authority.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-02-aggregate-disclosure-privacy.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-03-supplier-offers-selection.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-04-fulfillment-lifecycle.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-05-measurement-outcomes.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-06-baseline-savings.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-07-evidence-pov.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-08-settlement-authority.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-09-benefit-funding-allocation.test.ts",
  "tests/demand-procurement-benefit-lifecycle/net-w036-ac-10-replay-concurrency-atomicity.test.ts",
  "tests/regression/net-w036-ac-10-architecture-out-of-scope.test.ts",
];

/**
 * Strip comments (block + line) so the determinism pins below scan
 * CODE only — the remediation doc comments legitimately NAME the
 * forbidden tokens (`Date.now()`, `randomUUID`, `new Date()`) while
 * explaining why they are absent. URLs are safe: the line-comment
 * pattern requires whitespace before `//`, so `https://…` string
 * content survives.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/.*$/gm, "");
}

/** Count code-level (comment-free) occurrences of an exact token. */
function countCodeToken(source: string, token: string): number {
  return stripComments(source).split(token).length - 1;
}

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W036-AC-10 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass over the whole tree (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(322);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(322);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; no demand/procurement/benefit-lifecycle boundary)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // The 16 frozen domain boundaries — no /lifecycle, /composition,
    // /creator-lifecycle or any demand/procurement/benefit-lifecycle
    // style new boundary appears.
    for (const forbiddenBoundary of [
      "- `/lifecycle`",
      "- `/composition`",
      "- `/creator-lifecycle`",
      "- `/creatorLifecycle`",
      "- `/demand-procurement-lifecycle`",
      "- `/procurement-lifecycle`",
      "- `/benefit-lifecycle`",
      "- `/demandLifecycle`",
      "- `/procurementLifecycle`",
      "- `/benefitLifecycle`",
    ]) {
      expect(lock).not.toContain(forbiddenBoundary);
      expect(arch).not.toContain(forbiddenBoundary);
    }
    // The frozen src/ directory set — EXACTLY the 16 domain
    // boundaries + the established non-domain directories (no new
    // directory was added by W036 — the same 34 sorted entries the
    // W035 regression pinned).
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

  test("the NET-W036 work order exists and binds to frozen Architecture v1.0 + Issue #75 + the frozen objective chain", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W036.md"),
      "utf8",
    );
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#75");
    expect(workOrder).toContain("Complete demand/procurement/benefit lifecycle");
    // The frozen objective arrow chain — the EXACT lines (the declared
    // traversal every W036 test proves in executable order).
    expect(workOrder).toContain("demand aggregation");
    expect(workOrder).toContain("  → supplier offers / competitive selection");
    expect(workOrder).toContain("  → fulfillment / execution");
    expect(workOrder).toContain("  → measured outcome");
    expect(workOrder).toContain("  → supported baseline / counterfactual");
    expect(workOrder).toContain("  → verified savings / Proof-of-Value");
    expect(workOrder).toContain("  → settlement");
    expect(workOrder).toContain("  → benefit funding / allocation");
    // The §2 authority placement (the existing boundaries only).
    expect(workOrder).toContain("/ demand       ← demand pools, offers, supplier eligibility/selection");
    expect(workOrder).toContain("/ workflows    ← sole lifecycle authority where execution has lifecycle state");
    expect(workOrder).toContain("/ settlement   ← sole economic authority");
    expect(workOrder).toContain("/ benefits     ← pool/entitlement/allocation semantics");
    // W036 is composition/proof work, NEVER a new authority.
    expect(workOrder).toContain("not a new authority");
    // The explicit non-goals (§8).
    expect(workOrder).toContain("no second demand/procurement/savings/benefit ledger");
    expect(workOrder).toContain("no new lifecycle machine");
    expect(workOrder).toContain("no new settlement/economic primitive");
    expect(workOrder).toContain("no W037 behavior");
    expect(workOrder).toContain("no architecture-file amendment");
  });

  test("the composed vocabularies are pinned UNCHANGED (the frozen contracts W036 composes over)", () => {
    // The economic source kinds (the recognition/settlement chain —
    // the exact four authority records).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
    // The deterministic economic scale (the conservation arithmetic).
    expect(ECONOMIC_SCALE).toBe(1_000_000);
    // The benefit type vocabulary (W028 — the pool classification).
    expect([...BENEFIT_TYPES]).toEqual([
      "credits",
      "cash",
      "discount",
      "service",
      "rebate",
      "inventory",
    ]);
    // The closed funding-source kinds (the authoritative upstream
    // record kinds: /settlement value records + /demand savings).
    expect([...BENEFIT_FUNDING_SOURCE_KINDS]).toEqual([
      "economic_value",
      "verified_savings",
    ]);
    // The eligibility criteria + remainder dispositions.
    expect([...BENEFIT_ELIGIBILITY_CRITERIA]).toEqual(["active_membership"]);
    expect([...BENEFIT_REMAINDER_DISPOSITIONS]).toEqual([
      "last_member_absorbs",
      "retained_in_pool",
    ]);
    // The versioned derivation/allocation policies.
    expect(BENEFIT_ALLOCATION_POLICY_VERSION).toBe(1);
    // The W027 baseline/savings vocabulary.
    expect([...PROCUREMENT_BASELINE_METHODS]).toEqual([
      "prior_period",
      "matched_control",
      "market_index",
      "contracted_reference",
    ]);
    expect(PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION).toBe(1);
    // The W026 competitive-selection policy + ranking criteria.
    expect(SUPPLIER_OFFER_SELECTION_POLICY_VERSION).toBe(1);
    expect([...SUPPLIER_OFFER_RANKING_CRITERIA]).toEqual([
      "unit_price_band_ascending",
      "timing_window_ascending",
      "quantity_capacity_descending",
      "offer_id_ascending",
    ]);
    // The frozen privacy floors (DEMAND + PROCUREMENT — the separate
    // commitment-count and distinct-buyer-organization-count gates).
    expect(DEMAND_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    expect(PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    expect(PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS).toBe(3);
  });

  test("NET-W036 adds NO production source file (the entire artifact set is tests + the ONE declared test-tier pin extension)", async () => {
    // No src file carries a W036 marker — every src/ directory is
    // scanned (stronger than the domain-dir-only sweep).
    const srcDirs = (await readdir(SRC, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const dir of srcDirs) {
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry NET-W036 implementation markers`,
        ).not.toContain("NET-W036:");
      }
    }
    // Every declared W036 artifact exists.
    for (const rel of W036_TEST_FILES) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
    // The test directory contains EXACTLY the W036 suites (no stray
    // implementation files smuggled in): the harness + the full-path
    // scenario + AC-01..AC-10.
    const w036Files = (await readdir(W036_DIR)).filter((f) => f.endsWith(".ts"));
    expect(w036Files.sort()).toEqual(
      W036_TEST_FILES.filter((f) =>
        f.startsWith("tests/demand-procurement-benefit-lifecycle/"),
      )
        .map((f) => f.slice("tests/demand-procurement-benefit-lifecycle/".length))
        .sort(),
    );
    // The ONE declared adjustment: the AC-04 suite-inventory pin was
    // extended 11→12 filenames when the AC-10 suite joined the
    // directory (a PURE filename-list extension; the write-token and
    // determinism pins in that file are unchanged and now cover the
    // new file).
    const ac04 = await readFile(
      join(
        REPO,
        "tests/demand-procurement-benefit-lifecycle/net-w036-ac-04-fulfillment-lifecycle.test.ts",
      ),
      "utf8",
    );
    expect(ac04).toContain('"net-w036-ac-10-replay-concurrency-atomicity.test.ts"');
    expect(ac04).toContain("AC-01..AC-10");
  });

  test("the W036 composition tests compose ONLY through the owning boundaries (no direct repository writes; no local lifecycle vocabulary)", async () => {
    // The composition suites (this regression suite necessarily NAMES
    // the banned patterns — it is not part of the scanned suite
    // directory, the W035 self-exemption technique).
    const compositionFiles = W036_TEST_FILES.filter(
      (f) =>
        f.startsWith("tests/demand-procurement-benefit-lifecycle/") &&
        f.endsWith(".ts"),
    );
    for (const rel of compositionFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      const code = stripComments(content);
      // No direct authority/repository mutation from the test tier:
      // the scenario composes services + composites only (the
      // commit-failing wrapper delegates through the REAL transaction
      // interface — the generic-delegate form keeps the write token
      // out of the suite code).
      expect(code, `${rel} must not write repositories`).not.toMatch(
        /\.put\(/,
      );
      expect(code).not.toMatch(/saveWithinTx/);
      expect(code).not.toMatch(/deleteWithinTx/);
      // No second lifecycle machinery (the structural no-second-
      // state-machine pin, whole suite).
      expect(code).not.toMatch(/statusTransition\(/);
      expect(code).not.toMatch(/statusMachine\(/);
      // No new demand/procurement/benefit lifecycle vocabulary (W036
      // must not introduce a new module boundary — the sanctioned
      // workflow metadata label `demandProcurementLifecycle` is a
      // prefixed string literal, never the bare token).
      expect(code).not.toMatch(/\bprocurementLifecycle\b/i);
      expect(code).not.toMatch(/\bsourcingLifecycle\b/i);
      expect(code).not.toMatch(/\bbenefitLifecycle\b/i);
      // NO W037 behavior — no next-milestone token anywhere.
      expect(code).not.toMatch(/W037/);
    }
  });

  test("the composition root remains the ONLY cross-domain join (wiring pins for the composed composites)", async () => {
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    // The composites the canonical W036 path runs through are wired
    // at the composition root EXACTLY as before (W036 adds nothing).
    expect(runtime).toContain("procurementSavingsService");
    expect(runtime).toContain("benefitPoolService");
    expect(runtime).toContain("async submitMeasurementReport(");
    // The gates the composed path honors (risk + dispute — the W009/
    // W010 controls over maturation).
    expect(runtime).toContain("refuseWhenGated(");
    expect(runtime).toContain("refuseWhenDisputed(");
    // The economic draw the benefit composite executes (the
    // settlement reward-allocation primitive on the caller's
    // transaction).
    expect(runtime).toContain("allocateRewardsWithinTx");
    // No W036 marker in the composition root.
    expect(runtime).not.toContain("NET-W036");
  });

  test("the secret boundary holds: no key material in the W036 files; NO new secret/config surface", async () => {
    for (const rel of W036_TEST_FILES) {
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
    // The schema declares no W036-specific secret key and no new
    // procurement/benefit secret-key surface (beyond the pre-existing
    // measurement/attestation/settlement trust keys).
    expect(schema).not.toMatch(/W036\w*KEY/);
    expect(schema).not.toMatch(/PROCUREMENT\w*KEY/);
    expect(schema).not.toMatch(/BENEFIT\w*KEY/);
    expect(schema).not.toMatch(/DEMAND\w*KEY/);
    expect(schema).not.toMatch(/SUPPLIER\w*KEY/);
  });

  test("the frozen architecture files carry NO W036-era amendment (no silent changes)", async () => {
    // The W036 milestone sanctions NO shared-file amendment.
    for (const rel of [
      "spec/architecture.md",
      "spec/architecture-lock.md",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toContain("NET-W036");
    }
  });

  test("the W036 determinism contract: the ENTIRE suite is wall-clock/random-FREE (zero Date.now/randomUUID/new Date code tokens — STRONGER than W035: no sanctioned freshness exception)", async () => {
    // The mechanical sweep over EVERY W036 suite file (comment-
    // stripped): `Date.now(` === 0, `randomUUID` === 0 AND
    // `new Date(` === 0. W036 is the zero-wall-clock milestone —
    // every fixture timestamp is a FIXED anchor or an
    // authoritative-subject-derived value (the baseline window is
    // derived from the pool's own server-set createdAt via pure
    // ISO-string arithmetic), so unlike W035 there is NO sanctioned
    // `new Date(` freshness exception anywhere in the suite.
    const suiteFiles = W036_TEST_FILES.filter((f) =>
      f.startsWith("tests/demand-procurement-benefit-lifecycle/"),
    );
    for (const rel of suiteFiles) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(
        countCodeToken(content, "Date.now("),
        `${rel} code must be Date.now-free`,
      ).toBe(0);
      expect(
        countCodeToken(content, "randomUUID"),
        `${rel} code must be randomUUID-free`,
      ).toBe(0);
      expect(
        countCodeToken(content, "new Date("),
        `${rel} code must be new-Date-free`,
      ).toBe(0);
    }

    // The canonical FIXED anchors exist with their EXACT values (the
    // export declarations in the harness source + the imported
    // constants).
    const harnessSource = await readFile(
      join(REPO, "tests/demand-procurement-benefit-lifecycle/_net-w036-harness.ts"),
      "utf8",
    );
    expect(harnessSource).toContain(
      'export const W036_EVIDENCE_CAPTURED_AT = "2026-09-02T10:00:00.000Z"',
    );
    expect(harnessSource).toContain(
      'export const W036_RISK_CONTROL_EVALUATED_AT = "2026-09-01T12:00:00.000Z"',
    );
    expect(harnessSource).toContain(
      'export const W036_NOTICE_COLLECTED_AT = "2026-08-30T10:00:00.000Z"',
    );
    expect(harnessSource).toContain(
      'export const W036_STALE_COLLECTED_AT = "2020-01-01T00:00:00.000Z"',
    );
    expect(harnessSource).toContain(
      'export const W036_STALE_BASELINE_WINDOW_ENDS_AT = "2020-01-01T00:00:00.000Z"',
    );
    expect(harnessSource).toContain(
      "export const W036_BASELINE_WINDOW_DAYS = 30",
    );
    expect(harnessSource).toContain(
      "export const W036_BASELINE_WINDOW_ENDS_DAYS_AGO = 1",
    );
    // The imported anchor VALUES (the runtime pin).
    expect(W036_EVIDENCE_CAPTURED_AT).toBe("2026-09-02T10:00:00.000Z");
    expect(W036_RISK_CONTROL_EVALUATED_AT).toBe("2026-09-01T12:00:00.000Z");
    expect(W036_NOTICE_COLLECTED_AT).toBe("2026-08-30T10:00:00.000Z");
    expect(W036_STALE_COLLECTED_AT).toBe("2020-01-01T00:00:00.000Z");
    expect(W036_STALE_BASELINE_WINDOW_ENDS_AT).toBe("2020-01-01T00:00:00.000Z");
    expect(W036_BASELINE_WINDOW_DAYS).toBe(30);
    expect(W036_BASELINE_WINDOW_ENDS_DAYS_AGO).toBe(1);

    // The pure-arithmetic ISO helper is present and correct (whole-day
    // subtraction; time-of-day preserved; leap-year safe — never a
    // Date object).
    expect(harnessSource).toContain(
      "export function w036IsoMinusDays(iso: string, days: number): string",
    );
    expect(w036IsoMinusDays("2026-09-02T10:00:00.000Z", 31)).toBe(
      "2026-08-02T10:00:00.000Z",
    );
    expect(w036IsoMinusDays("2024-03-01T00:00:00.000Z", 1)).toBe(
      "2024-02-29T00:00:00.000Z",
    );
    expect(w036IsoMinusDays("2026-01-01T00:00:00.000Z", 0)).toBe(
      "2026-01-01T00:00:00.000Z",
    );

    // All idempotency keys in the canonical path are FIXED `w036-*`
    // literals (a representative set of the exact key literals the
    // harness carries — no fabricated identities anywhere).
    for (const keyLiteral of [
      'idempotencyKey: "w036-pool-create"',
      'idempotencyKey: "w036-selection"',
      'idempotencyKey: "w036-baseline"',
      'idempotencyKey: "w036-savings"',
      'idempotencyKey: "w036-value-record"',
      'idempotencyKey: "w036-benefit-policy"',
      'idempotencyKey: "w036-benefit-pool"',
      'idempotencyKey: "w036-allocation"',
      'idempotencyKey: "w036-observation"',
      'idempotencyKey: "w036-pov-verify"',
      'idempotencyKey: "w036-mo-finalize"',
    ]) {
      expect(harnessSource).toContain(keyLiteral);
    }
    // The fixed-key discipline extends to the per-stage transition
    // keys (the deterministic `w036-t*` walk).
    expect(harnessSource).toContain("`w036-t${String(step)}`");
  });
});
