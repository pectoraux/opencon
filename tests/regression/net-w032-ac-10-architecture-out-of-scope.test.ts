/**
 * NET-W032-AC-10 — architecture/out-of-scope regression (issue #65).
 *
 * NET-W032 ships INSIDE the frozen /disputes boundary (the SOLE
 * risk/control/dispute authority — no seventeenth domain). Validators
 * produce independent observations; the deterministic quorum derives
 * an accepted result; ONLY the owning authority applies it (the
 * composition root is the ONLY join); validator stakes escrow in
 * /settlement and accepted outcomes against W031 proofs apply through
 * the /reputation authority's own revocation command. The W009/W010
 * foundation (signals, policies, assessments, cases, controls,
 * challenges/disputes/appeals) is preserved; /evidence (W029),
 * /reputation (W031) and /workflows are untouched by W032 (no new
 * attestation surface, no lifecycle machinery — round state is
 * immutable facts + explicit outcome records, never a status
 * machine); no end-to-end flows (W033+), no token economics, no
 * consensus/network protocol, no AI authority, no new cryptographic
 * primitive (W029/W031 integrity is REFERENCED opaquely, never
 * re-implemented). Key material resolves only through the
 * SecretProvider and never enters the domain; no new secret or
 * configuration surface was minted.
 *
 * The shared-file amendments are scoped exactly to the sanctioned
 * NET-W032 additions (the core economics stake-purpose vocabulary
 * gains validation_assignment; the two regression suites that pin
 * that vocabulary were amended in lockstep; the disputes module
 * summary + the DisputesPort audit vocabulary carry the additive
 * validation events; the boundary index re-exports the pure quorum
 * engine).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  VALIDATION_CHALLENGE_EVENTS,
} from "../../src/disputes/port.ts";
import {
  VALIDATION_PROTOCOL_VERSION,
  VALIDATION_CHALLENGE_WINDOW_MS,
  VALIDATION_TARGET_KINDS,
  VALIDATION_VERDICTS,
  VALIDATION_DECISIONS,
  ACCEPTED_VALIDATION_DECISIONS,
  VALIDATOR_EXCLUSION_REASONS,
  VALIDATION_EVIDENCE_REF_KINDS,
  VALIDATOR_STAKE_DISPOSITIONS,
  VALIDATION_OUTCOME_APPLICATIONS,
} from "../../src/core/validation.ts";
import {
  DISPUTE_STATES,
  DISPUTE_OUTCOMES,
  DISPUTE_SUBJECT_TYPES,
} from "../../src/core/disputes.ts";
import {
  ECONOMIC_STAKE_PURPOSE_KINDS,
} from "../../src/core/economics.ts";
import { REPUTATION_PROOF_VERIFICATION_REASONS } from "../../src/reputation/port.ts";
import { REQUIRED_IN_PRODUCTION } from "../../src/config/schema.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W032_FILES = [
  "src/disputes/quorum-engine.ts",
  "src/disputes/validation-policy-service.ts",
  "src/disputes/validator-registry-service.ts",
  "src/disputes/validation-service.ts",
  "src/disputes/authority-validation-policy-repository.ts",
  "src/disputes/authority-validator-participant-repository.ts",
  "src/disputes/authority-validation-challenge-repository.ts",
  "src/disputes/authority-validation-observation-repository.ts",
  "src/disputes/authority-validation-outcome-repository.ts",
  "src/core/validation.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W032-AC-10 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W032 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(322);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(322);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /disputes stays the sole validation coordination authority)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // NET-W032 adds NO boundary and NO second dispute/validation
    // authority (the coordination layer lives inside /disputes).
    for (const forbiddenBoundary of [
      "- `/validation`",
      "- `/validators`",
      "- `/quorum`",
      "- `/decentralized-validation`",
    ]) {
      expect(lock).not.toContain(forbiddenBoundary);
      expect(arch).not.toContain(forbiddenBoundary);
    }
  });

  test("the NET-W032 work order exists and binds to frozen Architecture v1.0 + Issue #65", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W032.md"), "utf8");
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#65");
    expect(workOrder).toContain("Decentralized validation/dispute layer");
    expect(workOrder).toContain("/disputes");
    expect(workOrder).toContain("deterministic");
    expect(workOrder).toContain("fail-closed");
    expect(workOrder).toContain("GOV-001");
    expect(workOrder).toContain("owning authority");
    expect(workOrder).toContain("/settlement");
    expect(workOrder).toContain("versioned policy");
    expect(workOrder).toContain("No second workflow/lifecycle engine");
    expect(workOrder).toContain("No new cryptographic primitive");
    expect(workOrder).toContain("sanctioned mutation primitive");
  });

  test("the validation vocabularies are pinned; the W010 + W031 foundation vocabularies are UNCHANGED", () => {
    // The NEW NET-W032 vocabularies (closed, versioned, bounded).
    expect(VALIDATION_PROTOCOL_VERSION).toBe("NET-W032:1");
    expect(VALIDATION_CHALLENGE_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect([...VALIDATION_TARGET_KINDS]).toEqual([
      "reputation_proof",
      "contribution",
      "measured_outcome",
      "economic_value",
    ]);
    expect([...VALIDATION_VERDICTS]).toEqual(["UPHOLD", "REJECT", "ABSTAIN"]);
    expect([...VALIDATION_DECISIONS]).toEqual([
      "UPHELD",
      "DENIED",
      "INSUFFICIENT_PARTICIPATION",
      "NO_QUORUM",
      "CONFLICTED_QUORUM",
      "WINDOW_EXPIRED",
    ]);
    expect([...ACCEPTED_VALIDATION_DECISIONS]).toEqual(["UPHELD", "DENIED"]);
    expect([...VALIDATOR_EXCLUSION_REASONS]).toEqual([
      "suspended",
      "target_subject",
      "target_beneficiary",
      "challenge_initiator",
      "explicitly_conflicted",
    ]);
    expect([...VALIDATION_EVIDENCE_REF_KINDS]).toEqual([
      "signed_attestation",
      "reputation_proof",
    ]);
    expect([...VALIDATOR_STAKE_DISPOSITIONS]).toEqual(["RELEASE", "FORFEIT"]);
    expect([...VALIDATION_OUTCOME_APPLICATIONS]).toEqual([
      "reputation_proof_revocation",
    ]);
    expect([...VALIDATION_CHALLENGE_EVENTS]).toEqual([
      "opened",
      "conflict_marked",
      "assignments_derived",
      "validator_stake_bonded",
      "outcome_derived",
    ]);
    // The REUSED W010 dispute vocabulary is unchanged (extend, never
    // rewrite — the challenge/dispute/appeal lifecycle is untouched).
    expect([...DISPUTE_STATES]).toEqual([
      "PENDING_STAKE",
      "OPEN",
      "UNDER_REVIEW",
      "APPEALED",
      "RESOLVED",
      "REJECTED",
      "WITHDRAWN",
    ]);
    expect([...DISPUTE_OUTCOMES]).toEqual(["UPHELD", "DENIED", "DISMISSED"]);
    expect(DISPUTE_SUBJECT_TYPES).toHaveLength(8);
    // The COMPOSED W031 verification reasons are unchanged (referenced
    // opaquely; the validation layer never mirrors them).
    expect([...REPUTATION_PROOF_VERIFICATION_REASONS]).toHaveLength(9);
    for (const rel of W032_FILES) {
      const content = readFileSync(join(REPO, rel), "utf8");
      // No mirrored W029 algorithm/key vocabulary constants.
      expect(content).not.toMatch(/export const SIGNED_ATTESTATION_\w+/);
      expect(content).not.toMatch(/SIGNED_ATTESTATION_ALGORITHMS/);
    }
  });

  test("the W009/W010 foundation contracts are preserved (the /disputes W032 files never touch the dispute lifecycle surfaces)", async () => {
    const portSource = readFileSync(join(REPO, "src/disputes/port.ts"), "utf8");
    // The W009/W010 contracts remain declared (structural pins).
    for (const pin of [
      "export interface DisputeRecord {",
      "export interface DisputeService {",
      "export interface OpenDisputeInput {",
      "export interface RiskSignal {",
      "export interface RiskPolicy {",
      "export interface RiskCase {",
      "export interface RiskControlDecision {",
    ]) {
      expect(portSource).toContain(pin);
    }
    // The W032 files never touch the W010 lifecycle surfaces.
    for (const rel of W032_FILES) {
      const content = readFileSync(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bopenDispute\b/);
      expect(content).not.toMatch(/\bbondStake\b/);
      expect(content).not.toMatch(/\bresolveDispute\b/);
      expect(content).not.toMatch(/\bappealDispute\b/);
      expect(content).not.toMatch(/\bwithdrawDispute\b/);
      expect(content).not.toMatch(/\bstartReview\b/);
    }
    // The pure risk engine still exports from the boundary index
    // (the quorum engine joined it, additive).
    const index = await readFile(join(REPO, "src/disputes/index.ts"), "utf8");
    expect(index).toContain('export * from "./risk-engine.ts";');
    expect(index).toContain('export * from "./quorum-engine.ts";');
  });

  test("DISPUTES STAYS A NON-LIFECYCLE/NON-AI/NON-CONSENSUS/NON-ECONOMIC layer in the NET-W032 files", async () => {
    for (const rel of W032_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: round state is immutable facts + outcome records).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      expect(content).not.toMatch(/\brequestTransition\b/);
      // No AI authority: no advisory machinery can establish
      // eligibility, resolve a dispute, set quorum, determine stake
      // effects or override deterministic rules (§5).
      expect(content).not.toMatch(/\baiEligibility\b/);
      expect(content).not.toMatch(/\baiSufficiency\b/);
      expect(content).not.toMatch(/\badvisoryRanking\b/);
      // No consensus/network/blockchain vocabulary (§7: coordination
      // is deterministic multi-validator coordination INSIDE /disputes
      // — no decentralized consensus protocol).
      expect(content).not.toMatch(/\bconsensusNode\b/i);
      expect(content).not.toMatch(/\bverificationNode\b/i);
      expect(content).not.toMatch(/\bblockchain\b/i);
      expect(content).not.toMatch(/\btokenEconomics\b/i);
      expect(content).not.toMatch(/\bvalidateOnNetwork\b/i);
      expect(content).not.toMatch(/\bzeroKnowledge\b/i);
      // No end-to-end flow vocabulary (W033+ excluded).
      expect(content).not.toMatch(/\bendToEndFlow\b/i);
      // No economic mutation vocabulary (/settlement stays the sole
      // economic authority; the domain only verifies + records).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\bmatureEconomicValue\b/);
      // No NEW cryptographic primitive (W029/W031 integrity is
      // referenced opaquely; node:crypto is used exclusively for
      // record ids (randomUUID), never for primitives or keys).
      expect(content).not.toMatch(/\bcreateHmac\b/);
      expect(content).not.toMatch(/\bcreateSign\b/);
      expect(content).not.toMatch(/\bcreateVerify\b/);
      expect(content).not.toMatch(/\bgenerateKeyPair\b/);
      expect(content).not.toMatch(/\bcreatePrivateKey\b/);
    }
  });

  test("TIER COMPLIANCE: the /disputes W032 files import core + self only (the neutral lookups are declared, never the owning domains)", async () => {
    for (const rel of W032_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No domain imports outside itself/core (the owning authorities'
      // surfaces are composed through the NEUTRAL lookup contracts
      // wired at the root).
      expect(
        content,
        `${rel} must import core + self only`,
      ).not.toMatch(
        /from ["']\.\.\/(evidence|outcomes|campaigns|inventory|settlement|reputation|creators|workflows|demand|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
    }
    // The whole /disputes boundary stays free of owner-domain imports.
    for (const file of await readdir(join(SRC, "disputes"))) {
      if (!file.endsWith(".ts")) continue;
      const content = await readFile(join(SRC, "disputes", file), "utf8");
      expect(content, `disputes/${file} must not import /settlement`).not.toMatch(
        /from ["']\.\.\/settlement\//,
      );
      expect(content, `disputes/${file} must not import /reputation`).not.toMatch(
        /from ["']\.\.\/reputation\//,
      );
      expect(content, `disputes/${file} must not import /workflows`).not.toMatch(
        /from ["']\.\.\/workflows\//,
      );
    }
  });

  test("VALIDATION COMMAND VOCABULARY containment: confined to the /disputes boundary + guarded routes", async () => {
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    for (const action of [
      "validationPolicy.create",
      "validator.create",
      "validator.read",
      "validator.suspend",
      "validation.challenge.create",
      "validation.challenge.read",
      "validation.challenge.markConflict",
      "validation.assignment.derive",
      "validation.assignment.bond",
      "validation.observation.create",
      "validation.outcome.derive",
      "validation.outcome.apply",
      "validation.outcome.read",
    ]) {
      expect(apiServer).toContain(`"${action}"`);
    }
    expect(apiServer).toContain("/api/validation/challenges");
    expect(apiServer).toContain("/api/validation/validators");
    expect(apiServer).toContain("/api/validation/policies");
    expect(apiServer).toContain("/api/validation/outcomes");
    // No other domain carries the W032 command vocabulary (the
    // /disputes boundary owns it exclusively).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "disputes") continue;
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry W032 command vocabulary`,
        ).not.toMatch(/\bopenChallenge\b/);
        expect(content).not.toMatch(/\bderiveAssignments\b/);
        expect(content).not.toMatch(/\bderiveOutcome\b/);
        expect(content).not.toMatch(/\bsubmitObservation\b/);
        expect(content).not.toMatch(/\bmarkOutcomeApplied\b/);
        expect(content).not.toMatch(/\bregisterValidator\b/);
        expect(content).not.toMatch(/\bValidationService\b/);
        expect(content).not.toMatch(/\bValidatorRegistryService\b/);
      }
    }
    // The api layer consumes the port types only (never the
    // implementation files).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/validation-service\.ts/);
    expect(apiPort).not.toMatch(/quorum-engine\.ts/);
    expect(apiPort).not.toMatch(/validator-registry-service\.ts/);
    expect(apiPort).not.toMatch(/authority-validation-\w+-repository\.ts/);
  });

  test("the /evidence + /settlement + /reputation + /workflows authorities are UNTOUCHED by NET-W032", async () => {
    // /evidence: the W029 machinery port gains NO validation coupling.
    const evidencePort = await readFile(join(REPO, "src/evidence/port.ts"), "utf8");
    expect(evidencePort).not.toMatch(/ValidationLookup|ValidationAttestation/i);
    // /settlement: the economic authority port is unchanged by W032
    // (the purpose-kind vocabulary extension lives in CORE, not in
    // the boundary port).
    const settlementPort = await readFile(join(REPO, "src/settlement/port.ts"), "utf8");
    expect(settlementPort).not.toMatch(/\bValidationService\b/);
    expect(settlementPort).not.toMatch(/validation_assignment/);
    // /reputation: the W031 proof surface is untouched (the outcome
    // application composes the EXISTING revocation command).
    const reputationPort = await readFile(join(REPO, "src/reputation/port.ts"), "utf8");
    expect(reputationPort).not.toMatch(/\bValidationService\b/);
    // /workflows: the lifecycle authority is untouched (round state
    // is immutable facts — never a transition).
    const workflowPort = await readFile(join(REPO, "src/workflows/port.ts"), "utf8");
    expect(workflowPort).not.toMatch(/\bValidationService\b/);
  });

  test("the composition root is the ONLY join between the validation layer and the owning authorities (wiring pins)", async () => {
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    // The services are wired at the root over the authority
    // repositories + the idempotency store + the transactional audit
    // writer.
    expect(runtime).toContain("createValidationService(");
    expect(runtime).toContain("createValidatorRegistryService(");
    expect(runtime).toContain("createValidationPolicyService(");
    expect(runtime).toContain("createAuthorityValidationChallengeRepository");
    expect(runtime).toContain("createAuthorityValidationOutcomeRepository");
    // The NEUTRAL lookups are wired over the OWNING domains'
    // repositories (the only join): the target/proof lookups read the
    // W031 proof store; the attestation lookup reads the W029 store.
    expect(runtime).toContain("validationTargetLookup: ValidationTargetLookup = {");
    expect(runtime).toContain("reputationProofRepo.findById(id)");
    expect(runtime).toContain("signedAttestationRepo.findById(id)");
    expect(runtime).toContain("validationLookups: ValidationLookups = {");
    // The API command surface is wired (incl. the composites).
    expect(runtime).toContain("async resolveValidationRound(");
    expect(runtime).toContain("async applyValidationOutcome(");
    expect(runtime).toContain("async bondValidatorAssignmentStake(");
    // The composite's owner-authority mutations happen ONLY here
    // (through the owners' own commands).
    expect(runtime).toContain("stakeService.commitStake(");
    expect(runtime).toContain("reputationProofService.revokeProof(execution, {");
    // The deterministic closure→stake mapping is composed from the
    // pure core function (single source of truth).
    expect(runtime).toContain("validatorStakeDispositionForClosure");
    // The Runtime exposes the services.
    expect(runtime).toContain("readonly validationService: ValidationService;");
    expect(runtime).toContain("readonly validatorRegistryService: ValidatorRegistryService;");
  });

  test("the secret boundary holds: no key material in the NET-W032 files; NO new secret/config surface was minted", async () => {
    for (const rel of W032_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(false);
    }
    // No NEW required-in-production secret (the validation surface
    // composes the EXISTING services — zero new names).
    expect([...REQUIRED_IN_PRODUCTION]).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "OBJECT_STORAGE_BUCKET",
    ]);
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(schema).not.toMatch(/VALIDATION\w*KEY/);
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).not.toMatch(/VALIDATION\w*KEY/);
  });

  test("the NET-W032 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W032.md",
      "src/core/validation.ts",
      ...W032_FILES.filter((f) => !f.startsWith("src/core")),
      "tests/disputes/_net-w032-harness.ts",
      "tests/disputes/net-w032-ac-01-validator-model.test.ts",
      "tests/disputes/net-w032-ac-02-deterministic-assignment.test.ts",
      "tests/disputes/net-w032-ac-03-challenges.test.ts",
      "tests/disputes/net-w032-ac-04-observations.test.ts",
      "tests/disputes/net-w032-ac-05-quorum-outcome.test.ts",
      "tests/disputes/net-w032-ac-06-conflict-tenancy.test.ts",
      "tests/disputes/net-w032-ac-07-authority-containment.test.ts",
      "tests/disputes/net-w032-ac-08-economic-containment.test.ts",
      "tests/disputes/net-w032-ac-09-atomicity-concurrency.test.ts",
      "tests/regression/net-w032-ac-10-architecture-out-of-scope.test.ts",
      "docs/net-w032-decentralized-validation-dispute.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("the sanctioned shared-file amendments are scoped EXACTLY to the sanctioned NET-W032 additions", async () => {
    // The core economics stake-purpose vocabulary gains the validator
    // assignment kind (the additive frozen-vocabulary extension).
    expect([...ECONOMIC_STAKE_PURPOSE_KINDS]).toEqual([
      "campaign_budget",
      "dispute_challenge",
      // NET-W032 (additive, sanctioned shared-file amendment): the
      // validator per-round eligibility bond purpose kind.
      "validation_assignment",
    ]);
    // The two regression suites that pin that vocabulary were amended
    // in lockstep (the pins stay honest).
    for (const pin of [
      "tests/regression/net-w012-ac-07-architecture-out-of-scope.test.ts",
      "tests/regression/net-w013-ac-07-architecture-out-of-scope.test.ts",
    ]) {
      const content = await readFile(join(REPO, pin), "utf8");
      expect(content).toContain("NET-W032 (additive, sanctioned shared-file amendment)");
      expect(content).toContain('"validation_assignment"');
    }
    // The module registry summary carries the additive behaviour.
    const module = await readFile(join(REPO, "src/disputes/module.ts"), "utf8");
    expect(module).toContain("NET-W032");
    // The DisputesPort audit vocabulary carries the validation events.
    const port = await readFile(join(REPO, "src/disputes/port.ts"), "utf8");
    expect(port).toContain(
      'validationChallengeOpened: "validation_challenge.opened"',
    );
    expect(port).toContain(
      'validationOutcomeDerived: "validation_outcome.derived"',
    );
    expect(port).toContain(
      'validationOutcomeApplied: "validation_outcome.applied"',
    );
    // The W010 dispute service file is untouched by W032 (byte-stable
    // W010 form — no W032 marker).
    const disputeService = await readFile(
      join(REPO, "src/disputes/dispute-service.ts"),
      "utf8",
    );
    expect(disputeService).not.toContain("NET-W032");
    // The W031 proof files are untouched (the validation layer READS
    // the proof store through the composition root; it never joins
    // the proof implementation).
    for (const rel of [
      "src/reputation/proof-service.ts",
      "src/reputation/proof-input.ts",
      "src/reputation/scoring.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toContain("NET-W032");
    }
  });
});
