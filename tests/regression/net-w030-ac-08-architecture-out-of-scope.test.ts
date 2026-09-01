/**
 * NET-W030-AC-08 — architecture / out-of-scope regression (issue #61;
 * work order §4, §6).
 *
 * Pins the frozen-architecture guarantees around the NET-W030
 * extension: the tier checks pass with every new file; the frozen
 * architecture documents remain FROZEN; the W030 vocabularies are
 * closed and pinned exactly; the fact layer stays inside /settlement
 * (no 17th domain, no second economic authority); the adapter tier
 * stays pure (no domain imports, no mutation machinery); the API
 * transport stays provider-neutral; W031/W032/W033 behavior is
 * structurally deferred; the secret boundary holds (no committed key
 * material; .env.example entries are names only); and the sanctioned
 * shared-file amendments are scoped exactly to the NET-W030
 * additions.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import {
  EXTERNAL_SETTLEMENT_PROVIDERS,
  EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS,
  EXTERNAL_SETTLEMENT_MAX_AGE_MS,
  EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS,
  EXTERNAL_SETTLEMENT_RECONCILIATION_VERDICTS,
  EXTERNAL_SETTLEMENT_RECONCILIATION_REASONS,
  EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT,
} from "../../src/settlement/port.ts";
import { EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_REASONS } from "../../src/settlement/external-settlement-input.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

/** Every artifact this work order introduced. */
const W030_FILES = [
  "src/settlement/external-settlement-input.ts",
  "src/settlement/external-settlement-service.ts",
  "src/settlement/authority-external-settlement-repository.ts",
  "src/adapters/settlement/reference-adapter.ts",
  "src/bootstrap/external-settlement-authentication.ts",
  "tests/settlement/_net-w030-harness.ts",
  "tests/settlement/net-w030-ac-01-fact-records.test.ts",
  "tests/settlement/net-w030-ac-02-authenticated-ingestion.test.ts",
  "tests/settlement/net-w030-ac-03-reconciliation.test.ts",
  "tests/settlement/net-w030-ac-04-no-bypass.test.ts",
  "tests/settlement/net-w030-ac-05-tenancy-authorization.test.ts",
  "tests/settlement/net-w030-ac-06-idempotency-concurrency.test.ts",
  "tests/settlement/net-w030-ac-07-traceability-containment.test.ts",
] as const;

const SETTLEMENT_FACT_FILES = [
  "src/settlement/external-settlement-input.ts",
  "src/settlement/external-settlement-service.ts",
  "src/settlement/authority-external-settlement-repository.ts",
] as const;

describe("NET-W030-AC-08 architecture / out-of-scope", () => {
  test("the architecture + authority-boundary guards pass with every NET-W030 file (0 violations)", async () => {
    const arch = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(arch.violations).toEqual([]);
    expect(arch.filesScanned).toBeGreaterThanOrEqual(309);
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(309);
  });

  test("THE NO-17TH-DOMAIN PIN: the frozen architecture documents remain FROZEN with /settlement + /adapters already among the boundaries", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // The lock's §14 invariant 25 is the governing sentence.
    expect(lock).toContain(
      "Measurement and payment adapters provide evidence/transaction facts; `/outcomes` and `/settlement` retain semantic authority",
    );
    // No new boundary was invented (no /external-settlement dir).
    const srcDirs = await readdir(SRC);
    expect(srcDirs).not.toContain("external-settlement");
    expect(srcDirs).not.toContain("settlement-adapters");
  });

  test("the NET-W030 work order + issue binding exist", async () => {
    const workOrder = await readFile(
      join(REPO, "spec/work-orders/NET-W030.md"),
      "utf8",
    );
    expect(workOrder).toContain("READY_FOR_IMPLEMENTATION");
    expect(workOrder).toContain("#61");
    expect(workOrder).toContain("ADAPTER-008");
    expect(workOrder).toContain(
      "`/settlement` remains the SOLE economic authority",
    );
    expect(workOrder).toContain("No 17th domain");
    const ledger = await readFile(
      join(REPO, "docs/net-w030-external-settlement-adapters.md"),
      "utf8",
    );
    expect(ledger).toContain("#61");
  });

  test("the W030 vocabularies are CLOSED and pinned exactly (frozen)", () => {
    expect([...EXTERNAL_SETTLEMENT_PROVIDERS]).toEqual(["reference"]);
    expect([...EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS]).toEqual(["hmac-sha256/v1"]);
    expect(EXTERNAL_SETTLEMENT_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT).toBe("NET-W030:1");
    expect([...EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS]).toEqual([
      "unsupported_provider",
      "unsupported_algorithm",
      "malformed_submission",
      "unauthenticated",
      "stale",
      "conflicting_fact",
      "correction_target_not_found",
    ]);
    expect([...EXTERNAL_SETTLEMENT_RECONCILIATION_VERDICTS]).toEqual([
      "matched",
      "pending",
      "mismatched",
    ]);
    expect([...EXTERNAL_SETTLEMENT_RECONCILIATION_REASONS]).toEqual([
      "internal_lineage_not_found",
      "amount_matched",
      "amount_mismatched",
      "unit_absent_in_lineage",
    ]);
    expect([...EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_REASONS]).toEqual([
      "internal_lineage_not_found",
      "lineage_resolved",
      "unit_absent_in_lineage",
      "unit_present",
      "amount_matched",
      "amount_mismatched",
    ]);
  });

  test("THE SETTLEMENT FACT LAYER STAYS A FACT LAYER: no economic authority, no lifecycle machinery, no W031+/W032/W033 vocabulary", async () => {
    for (const rel of SETTLEMENT_FACT_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic command vocabulary (the EXISTING /settlement
      // commands are the only economic primitives).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\bmatureEconomicValue\b/);
      // No lifecycle machinery (reconciliation is DERIVED, never a
      // local status machine — /workflows stays the sole lifecycle
      // authority).
      expect(content).not.toMatch(/\bstatusTransition\(/);
      expect(content).not.toMatch(/\bstatusMachine\(/);
      // No consensus / decentralization / portable-proof vocabulary
      // (W031/W032 deferrals; work order §4).
      expect(content).not.toMatch(/\bconsensusNode\b/i);
      expect(content).not.toMatch(/\bverificationNode\b/i);
      expect(content).not.toMatch(/\bblockchain\b/i);
      expect(content).not.toMatch(/\btokenEconomics\b/i);
      expect(content).not.toMatch(/\bvalidateOnNetwork\b/i);
      expect(content).not.toMatch(/\bportableReputationProof\b/i);
      expect(content).not.toMatch(/\bportableProof\b/i);
      // No external payment execution.
      expect(content).not.toMatch(/\bexecuteExternalPayment\b/);
      expect(content).not.toMatch(/\bpaymentProviderId\b/);
      // No AI authority.
      expect(content).not.toMatch(/\baiSufficiency\b/);
    }
  });

  test("ADAPTER PURITY: the reference adapter carries NO domain imports and NO mutation machinery", async () => {
    const adapter = await readFile(
      join(REPO, "src/adapters/settlement/reference-adapter.ts"),
      "utf8",
    );
    // No domain imports (the tier matrix's adapter-must-not-import-domain).
    expect(adapter).not.toMatch(
      /from ["']\.\.\/\.\.?\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|demand|benefits|opportunities|contributions|identity|organizations|participants)\//,
    );
    // No mutation/authority machinery in the adapter tier.
    expect(adapter).not.toMatch(/\bissueCredits\b/);
    expect(adapter).not.toMatch(/\bsettleCash\b/);
    expect(adapter).not.toMatch(/\bapplyIdempotent\b/);
    expect(adapter).not.toMatch(/\bsaveWithinTx\b/);
    expect(adapter).not.toMatch(/\bforTransaction\b/);
    // No secrets in the adapter.
    expect(adapter).not.toMatch(/(SECRET|PRIVATE)_KEY\s*[:=]/i);
    // src/adapters/index.ts does NOT re-export the settlement tier
    // (the composition root is the only join — the W023 pin).
    const adaptersIndex = await readFile(join(REPO, "src/adapters/index.ts"), "utf8");
    expect(adaptersIndex).not.toContain("settlement/");
  });

  test("the API transport stays provider-neutral (no provider vocabulary in server.ts)", async () => {
    const server = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(server).not.toMatch(/["']reference["']/);
    expect(server).not.toMatch(/\bstripe\b/i);
    expect(server).not.toMatch(/\bpaypal\b/i);
    // The W030 routes are registered under the /api/settlement/ surface.
    expect(server).toContain('"/api/settlement/external-facts"');
    for (const action of [
      "externalSettlementFact.record",
      "externalSettlementFact.read",
      "externalSettlementFact.reconcile",
    ]) {
      expect(server).toContain(`"${action}"`);
    }
    // src/api/port.ts must not import the adapter tier (only neutral
    // contracts — the W023 pin pattern).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/from ["']\.\.\/adapters\/settlement\//);
  });

  test("the secret boundary holds: no committed key material; the new config entries are names only", async () => {
    const SECRET_VALUE_PATTERN =
      /(EXTERNAL_SETTLEMENT[A-Z_]*TRUST_KEY|SECRET|PRIVATE[_-]?KEY|PASSWORD|TOKEN)\s*[:=]\s*["'][^"'{}\s]{8,}["']/;
    for (const rel of [
      ...W030_FILES.filter((f) => f.startsWith("src/")),
      "src/config/schema.ts",
      "src/bootstrap/runtime.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content, `${rel} must not carry committed key material`).not.toMatch(
        SECRET_VALUE_PATTERN,
      );
    }
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).toContain("# EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY=");
    expect(envExample).not.toMatch(/EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY=\S+/);
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(schema).toContain("EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY: z.string().optional()");
    expect(schema).toContain(
      '{ key: "EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY", classification: "secret", required: false }',
    );
  });

  test("the composition-root trust selection resolves per-provider material with NO development fallback", async () => {
    const selection = await readFile(
      join(REPO, "src/bootstrap/external-settlement-authentication.ts"),
      "utf8",
    );
    // The trust-channel map is closed over the frozen vocabulary.
    expect(selection).toContain("EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY");
    // Fail-closed semantics: absent material ⇒ unauthenticated.
    expect(selection).toContain("fail closed");
    // There is NO development default literal for the trust channel.
    expect(selection).not.toMatch(/DEV_INSECURE_EXTERNAL_SETTLEMENT/);
    // The real authenticator is constructed in the composition root
    // (the ONLY join between material and the domain).
    expect(selection).toContain("createHmacExternalSettlementAuthenticator");
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    expect(runtime).toContain("selectExternalSettlementAuthentication({");
    expect(runtime).toContain("externalSettlementTrustKeys");
  });

  test("the NET-W030 file list (every artifact this work order introduced exists)", async () => {
    for (const rel of W030_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("the sanctioned shared-file amendments are scoped EXACTLY to the sanctioned NET-W030 additions", async () => {
    // 1. The W008 harness threads the W030 options ONLY (no other
    //    behavior change).
    const w008Harness = await readFile(
      join(REPO, "tests/settlement/_net-w008-harness.ts"),
      "utf8",
    );
    expect(w008Harness).toContain("externalSettlementTrustKeys");
    expect(w008Harness).toContain("externalSettlementProviders");
    // 2. The ledger repository gained ONLY the in-tx transaction twin.
    const ledgerRepo = await readFile(
      join(REPO, "src/settlement/authority-ledger-repository.ts"),
      "utf8",
    );
    expect(ledgerRepo).toContain("findTransactionWithinTx");
    expect(ledgerRepo).not.toMatch(/\bissueCredits\b/);
    // 3. The /payments boundary stays skeletal (invariant 25).
    const paymentsPort = await readFile(join(REPO, "src/payments/port.ts"), "utf8");
    expect(paymentsPort).toContain('readiness: "skeleton"');
  });

  test("settlement/port.ts stays interface-declared with additive vocabularies only (the frozen pins hold)", async () => {
    const port = await readFile(join(REPO, "src/settlement/port.ts"), "utf8");
    // The pre-existing W008 pins (net-w008-ac-08) remain intact.
    expect(port).toContain("balances derived from entries");
    expect(port).not.toMatch(
      /\b(currentBalance|setBalance|adjustBalance|incrementBalance|balanceVersion|updateBalance)\b/,
    );
    // The W029 pin: no signed-attestation vocabulary in the settlement
    // port (the coverage lookup lives in /evidence only).
    expect(port).not.toMatch(/signedAttestation|SignedAttestation/i);
    // The audit-event vocabulary is ADDITIVE only.
    expect(port).toContain('externalSettlementFactRecorded: "external_settlement_fact.recorded"');
    expect(port).toContain(
      'externalSettlementMismatchObserved: "external_settlement_fact.mismatch_observed"',
    );
    expect(port).toContain('crossPromotionClearingRecorded: "cross_promotion_clearing.recorded"');
  });
});
