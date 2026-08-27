/**
 * NET-W010-AC-08 — Architecture and out-of-scope regression.
 *
 * The architecture checker passes, frozen architecture files remain
 * unchanged, the disputes domain carries the challenge/dispute/appeal
 * foundation WITHOUT hidden authority (no economic mutation — stakes
 * execute only through the settlement authority's commands wired at
 * the composition root; no reputation/evidence mutation; no workflow
 * lifecycle mutation; no provider-specific dispute SDK semantics; no
 * blockchain/decentralized validation), the dispute gate stays at the
 * composition root, and the domain remains provider-independent
 * (core + self only).
 *
 * Evidence: static architecture check + regression tests.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

async function listTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listTsFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NET-W010-AC-08 architecture/out-of-scope regression", () => {
  test("the architecture check passes with all NET-W010 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (unchanged)", async () => {
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(arch).toContain("FROZEN");
    expect(lock).toContain("FROZEN");
    // Lock invariant 21 (the NET-W010 gate's authority anchor) and the
    // frozen 16-domain list remain intact.
    expect(lock).toContain(
      "A disputed or fraud-held claim cannot mature until the applicable resolution policy permits it.",
    );
    expect(lock).toContain("- `/disputes`");
    // No seventeenth domain was added.
    expect(lock).not.toContain("- `/staking`");
    expect(lock).not.toContain("- `/challenges`");
  });

  test("the NET-W010 work order exists and binds to frozen Architecture v1.0 + Issue #19", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W010.md"), "utf8");
    expect(workOrder).toContain("Architecture:** v1.0 (FROZEN");
    expect(workOrder).toContain("NET-W010-AC-01..08");
    expect(workOrder).toContain("DISPUTE-001..005");
    expect(workOrder).toContain("AUD-006");
    expect(workOrder).toContain("No hidden economic authority");
    expect(workOrder).toContain("Authority separation");
    expect(workOrder).toContain("Append-only resolution");
  });

  test("the disputes domain is non-skeletal (module readiness references NET-W009 + NET-W010)", async () => {
    const mod = await import("../../src/disputes/module.ts");
    const disputesModule = Object.values(mod)[0] as {
      tier: string;
      describe?: () => string;
    };
    expect(disputesModule.tier).toBe("domain");
    expect(disputesModule.describe?.() ?? "").toMatch(/NET-W009/);
    expect(disputesModule.describe?.() ?? "").toMatch(/NET-W010/);
    expect(disputesModule.describe?.() ?? "").not.toMatch(/skeleton/i);
  });

  test("the disputes domain introduces NO hidden authority patterns (economic/reputation/evidence/workflow mutation, provider SDKs, decentralized validation)", async () => {
    const files = await listTsFiles(join(SRC, "disputes"));
    expect(files.length).toBeGreaterThan(0);
    // Patterns that would indicate the disputes domain became a
    // hidden economic ledger, reputation engine, evidence authority,
    // lifecycle mutator, or provider/decentralized construct. The
    // stake COMMANDS (commitStake/releaseStake/forfeitStake) live in
    // /settlement only — disputes may only READ stakes and RECORD
    // outcomes (bondStake/markStakeOutcome are the audited
    // bookkeeping commands, NET-W010-scoped).
    const forbidden: RegExp[] = [
      /\bissueCredits?\b/i,
      /\bmintCredit/i,
      /\bmatureValue\b/,
      /\brecordPendingValue\b/,
      /\bsettleCashObligation\b/,
      /\brecordConversion\b/,
      /\ballocateRewards?\b/i,
      /\bcommitStake\b/i,
      /\breleaseStake\b/i,
      /\bforfeitStake\b/i,
      /\bmutateReputation\b/i,
      /\brecordReputationInput\b/,
      /\brecordSnapshot\b/,
      /\bcreateProofOfValue\b/i,
      /\battachEvidence\b/i,
      /\bverifyProofOfValue\b/i,
      /\brequestTransition\b/,
      /\bslashStake\b/i,
      /\bopenChallenge\b/i,
      /\bfrom\s+["']pg["']/,
      /\bfrom\s+["']ioredis["']/,
      /openrtb/i,
      /sellersJson/i,
      /blockchain/i,
      /\bconsensus\b/i,
      /\bweb3\b/i,
      /\bnft\b/i,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(
            `Out-of-scope pattern ${pattern} found in ${file.replace(SRC, "src")}`,
          );
        }
      }
    }
  });

  test("the disputes domain never imports other domains (the stake/economic execution lives at the composition root)", async () => {
    const files = await listTsFiles(join(SRC, "disputes"));
    const domainImport =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|contributions|campaigns|inventory|creators|demand|benefits|reputation|evidence|outcomes|settlement|workflows)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (domainImport.test(content)) {
        throw new Error(
          `Domain-to-domain import found in ${file.replace(SRC, "src")} (the tier matrix + the work order §3 require composition-root wiring)`,
        );
      }
    }
  });

  test("the settlement domain carries the stake commands; the disputes boundary does NOT (economic authority separation, invariant 1)", async () => {
    const stakeService = await readFile(
      join(SRC, "settlement/stake-service.ts"),
      "utf8",
    );
    expect(stakeService).toContain("commitStake");
    expect(stakeService).toContain("releaseStake");
    expect(stakeService).toContain("forfeitStake");
    // The settlement side carries NO dispute lifecycle (W008's guard
    // stands): no dispute states, no challenge windows, no lifecycle.
    const settlementFiles = await listTsFiles(join(SRC, "settlement"));
    for (const file of settlementFiles) {
      const content = await readFile(file, "utf8");
      expect(
        content,
        `${file.replace(SRC, "src")} must not carry the dispute lifecycle`,
      ).not.toMatch(/\bdisputeState\b/);
      expect(content).not.toMatch(/\bdisputeLifecycle\b/);
      expect(content).not.toMatch(/\bchallengeWindow\b/i);
    }
    // The disputes side has no stake POSTING path (only bookkeeping).
    const disputeService = await readFile(
      join(SRC, "disputes/dispute-service.ts"),
      "utf8",
    );
    expect(disputeService).not.toMatch(/\bcommitStake\b/i);
    expect(disputeService).not.toMatch(/\breleaseStake\b/i);
    expect(disputeService).not.toMatch(/\bforfeitStake\b/i);
    expect(disputeService).not.toMatch(/postLedgerTransaction/);
    // The ONLY settlement touchpoints: the read-only stake lookup and
    // the recorded-outcome bookkeeping.
    expect(disputeService).toContain("resolveStake");
  });

  test("the dispute gate is wired ONLY at the composition root (runtime), not inside any domain", async () => {
    const runtime = await readFile(join(SRC, "bootstrap/runtime.ts"), "utf8");
    expect(runtime).toContain("refuseWhenDisputed");
    expect(runtime).toContain("DISPUTE_CHALLENGE");
    // The composite stake orchestration lives at the composition root
    // (compound idempotency keys — the applyWorkflowHold precedent).
    expect(runtime).toContain(":stake");
    expect(runtime).toContain(":bond");
    // The guarded routes carry the dispute actions (the API surface).
    const server = await readFile(join(SRC, "api/server.ts"), "utf8");
    for (const action of [
      "dispute.open",
      "dispute.bond",
      "dispute.review",
      "dispute.reject",
      "dispute.resolve",
      "dispute.appeal",
      "dispute.withdraw",
    ]) {
      expect(server).toContain(`"${action}"`);
    }
    // No domain file performs the gate.
    for (const dir of ["settlement", "disputes"]) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(content).not.toContain("refuseWhenDisputed");
      }
    }
  });

  test("the evidence/reputation domains were NOT modified by NET-W010 (invariants 2–3)", async () => {
    for (const dir of ["evidence", "reputation", "workflows"]) {
      const files = await listTsFiles(join(SRC, dir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(file, "utf8");
        expect(
          content,
          `${file.replace(SRC, "src")} must not import the disputes boundary`,
        ).not.toMatch(/from\s+["']\.\.\/disputes\//);
      }
    }
  });

  test("the core dispute vocabulary exports the frozen sets + deterministic mappings", async () => {
    const core = await import("../../src/core/disputes.ts");
    expect(core.DISPUTE_KINDS).toEqual(["CHALLENGE", "APPEAL"]);
    expect([...core.DISPUTE_STATES]).toEqual([
      "PENDING_STAKE",
      "OPEN",
      "UNDER_REVIEW",
      "APPEALED",
      "RESOLVED",
      "REJECTED",
      "WITHDRAWN",
    ]);
    expect(core.ACTIVE_DISPUTE_STATES).toEqual([
      "OPEN",
      "UNDER_REVIEW",
      "APPEALED",
    ]);
    expect(core.DISPUTE_OUTCOMES).toEqual(["UPHELD", "DENIED", "DISMISSED"]);
    expect(core.DISPUTE_CONTROL_DISPOSITIONS).toEqual([
      "MAINTAIN_CONTROL",
      "RELEASE_CONTROL",
      "REQUIRE_REEVALUATION",
    ]);
    expect(core.DISPUTE_STAKE_DISPOSITIONS).toEqual(["NONE", "RELEASE", "FORFEIT"]);
    // The deterministic outcome→stake mapping (invariant 4).
    expect(core.stakeDispositionForOutcome("UPHELD")).toBe("RELEASE");
    expect(core.stakeDispositionForOutcome("DISMISSED")).toBe("RELEASE");
    expect(core.stakeDispositionForOutcome("DENIED")).toBe("FORFEIT");
    // The frozen windows + requirement + policy lineage.
    expect(core.DISPUTE_CHALLENGE_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(core.DISPUTE_APPEAL_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(core.DISPUTE_STAKE_REQUIREMENT_CREDITS).toBe(10);
    expect(core.DISPUTE_POLICY_VERSION).toBe("NET-W010:1");
    expect(core.isDisputeState("OPEN")).toBe(true);
    expect(core.isDisputeState("SETTLED")).toBe(false);
  });

  test("the core economic vocabulary gained the additive stake sets (frozen superset)", async () => {
    const core = await import("../../src/core/economics.ts");
    expect([...core.ECONOMIC_ACCOUNT_KINDS]).toEqual([
      "pending_value",
      "mature_value",
      "credits",
      "rewards",
      "cash_payable",
      "cash_receivable",
      "protocol_recognition",
      // NET-W010 additive.
      "stake_escrow",
    ]);
    expect(core.economicAccountNormalSide("stake_escrow")).toBe("credit");
    expect(core.economicAccountUnit("stake_escrow")).toBe("credits");
    expect([...core.ECONOMIC_STAKE_STATES]).toEqual([
      "COMMITTED",
      "RELEASED",
      "FORFEITED",
    ]);
    // NET-W011 (additive, deliberate amendment — the exact pattern
    // NET-W010 itself used on the W008 pins): `campaign_budget` joins
    // the stake purpose vocabulary. Campaign budget escrows post
    // through the SAME settlement stake commands; the ad-hoc
    // `ad_campaign` kind remains rejected.
    expect([...core.ECONOMIC_STAKE_PURPOSE_KINDS]).toEqual([
      "campaign_budget",
      "dispute_challenge",
    ]);
    expect(core.isEconomicStakeState("COMMITTED")).toBe(true);
    expect(core.isEconomicStakePurposeKind("ad_campaign")).toBe(false);
  });

  test("the expected NET-W010 boundary files exist (documented structure)", async () => {
    for (const file of [
      "src/core/disputes.ts",
      "src/disputes/port.ts",
      "src/disputes/dispute-service.ts",
      "src/disputes/authority-dispute-repository.ts",
      "src/disputes/source-validation.ts",
      "src/disputes/module.ts",
      "src/disputes/README.md",
      "src/settlement/stake-service.ts",
      "src/settlement/authority-stake-repository.ts",
      "docs/net-w010-disputes.md",
    ]) {
      expect(existsSync(join(REPO, file)), `${file} should exist`).toBe(true);
    }
  });

  test("no secrets or credentials are committed in the NET-W010 files", async () => {
    const SECRET_VALUE_PATTERN =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    const files = await listTsFiles(join(SRC, "disputes"));
    const settlementFiles = await listTsFiles(join(SRC, "settlement"));
    files.push(...settlementFiles, join(SRC, "core/disputes.ts"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${file} must be secret-free`).toBe(
        false,
      );
    }
  });
});
