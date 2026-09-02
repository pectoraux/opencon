/**
 * NET-W031-AC-09 — architecture/out-of-scope regression (issue #63).
 *
 * NET-W031 ships INSIDE the frozen /reputation boundary (the SOLE
 * reputation authority — no 18th domain). Proofs COMPOSE the W029
 * signed-attestation machinery through the NEUTRAL contracts declared
 * on the reputation port (the composition root is the ONLY join); the
 * W007 foundation contracts (inputs, policies, snapshots, the pure
 * scoring engine) are preserved; /evidence, /settlement, /demand,
 * /creators, /disputes and /workflows are untouched by W031 (no
 * new attestation surface, no lifecycle machinery — revocation is a
 * ONE-WAY field mutation; no decentralized validation (W032), no
 * end-to-end flows (W033+), no token economics, no AI authority, no
 * zero-knowledge infrastructure). Key material resolves only through
 * the SecretProvider and never enters the domain; no new secret or
 * configuration surface was minted.
 *
 * The shared-file amendments are scoped exactly to the sanctioned
 * NET-W031 additions (the W007 harness forwards the attestation
 * adapters; the snapshot repository gains the in-tx listing twin; the
 * reputation module summary + the ReputationPort audit vocabulary
 * carry the additive proof events).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  REPUTATION_PROOF_RECORD_FORMAT,
  REPUTATION_PROOF_FRESHNESS_WINDOW_MS,
  REPUTATION_PROOF_VERIFICATION_REASONS,
} from "../../src/reputation/port.ts";
import { REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";
import {
  SIGNED_ATTESTATION_ALGORITHMS,
  SIGNED_ATTESTATION_KEY_REFERENCES,
  SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM,
  SIGNED_ATTESTATION_COVERAGE_FAMILIES,
} from "../../src/evidence/port.ts";
import { REQUIRED_IN_PRODUCTION } from "../../src/config/schema.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W031_FILES = [
  "src/reputation/proof-input.ts",
  "src/reputation/proof-service.ts",
  "src/reputation/authority-proof-repository.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W031-AC-09 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W031 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(312);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(312);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 18th domain; /reputation stays the sole reputation authority)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // NET-W031 adds NO boundary and NO second reputation authority.
    for (const forbiddenBoundary of [
      "- `/portable-proofs`",
      "- `/proofs`",
      "- `/reputation-proofs`",
      "- `/portable-reputation`",
    ]) {
      expect(lock).not.toContain(forbiddenBoundary);
      expect(arch).not.toContain(forbiddenBoundary);
    }
  });

  test("the NET-W031 work order exists and binds to frozen Architecture v1.0 + Issue #63", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W031.md"), "utf8");
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#63");
    expect(workOrder).toContain("Portable reputation proofs");
    expect(workOrder).toContain("SOLE reputation authority");
    expect(workOrder).toContain("no new crypto");
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("deterministic");
    expect(workOrder).toContain("PRIV-00");
    expect(workOrder).toContain("REP-00");
    expect(workOrder).toContain("aggregate disclosure");
    expect(workOrder).toContain("SecretProvider");
  });

  test("the portable-proof vocabularies are pinned; the W007 + W029 foundation vocabularies are UNCHANGED", () => {
    // The NEW NET-W031 vocabularies (closed, versioned, bounded).
    expect(REPUTATION_PROOF_RECORD_FORMAT).toBe("NET-W031:1");
    expect(REPUTATION_PROOF_FRESHNESS_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect([...REPUTATION_PROOF_VERIFICATION_REASONS]).toEqual([
      "verified",
      "proof_revoked",
      "malformed_proof",
      "unsupported_algorithm",
      "unknown_key_reference",
      "algorithm_key_reference_mismatch",
      "signature_mismatch",
      "proof_stale",
    ]);
    // The REUSED W007 dimension vocabulary is unchanged (extend,
    // never rewrite — proofs disclose exactly the frozen eight).
    expect([...REPUTATION_DIMENSIONS]).toHaveLength(8);
    expect(REPUTATION_DIMENSIONS[0]).toBe("helpfulness");
    // The COMPOSED W029 vocabularies are unchanged and UNMIRRORED
    // (injected as data at the composition root — single source of
    // truth; the W031 files never re-declare them).
    expect([...SIGNED_ATTESTATION_ALGORITHMS]).toEqual([
      "ed25519/v1",
      "ecdsa-p256/v1",
      "hmac-sha256/v1",
    ]);
    expect([...SIGNED_ATTESTATION_KEY_REFERENCES]).toEqual([
      "attestation-signing/ed25519/v1",
      "attestation-signing/ecdsa-p256/v1",
      "attestation-signing/hmac/v1",
      "attestation-signing/dev-insecure/v1",
    ]);
    expect([...SIGNED_ATTESTATION_COVERAGE_FAMILIES]).toEqual([
      "evidence",
      "reputation_input",
      "settlement_value",
    ]);
    for (const rel of W031_FILES) {
      const content = readFileSync(join(REPO, rel), "utf8");
      // No mirrored algorithm/key vocabulary constants.
      expect(content).not.toMatch(/export const SIGNED_ATTESTATION_\w+/);
      // No coverage-family extension (a proof is NOT a signed
      // attestation and does not join the W029 coverage model).
      expect(content).not.toMatch(/SIGNED_ATTESTATION_COVERAGE_FAMILIES/);
    }
    void SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM;
  });

  test("the W007 foundation contracts are BEHAVIORALLY preserved (the pure scoring engine + the snapshot discipline are untouched by the W031 files)", async () => {
    const portSource = readFileSync(join(REPO, "src/reputation/port.ts"), "utf8");
    // The W007 contracts remain declared (structural pins).
    for (const pin of [
      "export interface ReputationInput {",
      "export interface ReputationScoringPolicy {",
      "export interface ReputationSnapshot {",
      "export interface ReputationSnapshotService {",
      "export interface ReputationInputService {",
      "export interface ReputationPolicyService {",
    ]) {
      expect(portSource).toContain(pin);
    }
    // The W031 files never touch the W007 engine surfaces.
    for (const rel of W031_FILES) {
      const content = readFileSync(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/\bcomputeDimensionScores\b/);
      expect(content).not.toMatch(/\bcomputeScoresDigest\b/);
      expect(content).not.toMatch(/\brecordSnapshot\b/);
      expect(content).not.toMatch(/\brecordInput\b/);
      expect(content).not.toMatch(/\bcreatePolicyVersion\b/);
    }
    // The pure engine still behaves (spot-check the digest discipline).
    const { computeScoresDigest } = await import("../../src/reputation/scoring.ts");
    const scores = REPUTATION_DIMENSIONS.map((dimension) => ({
      dimension,
      score: 0,
      inputCount: 0,
      verifiedInputCount: 0,
      indicatedInputCount: 0,
      decayedVerifiedWeight: 0,
      decayedIndicatedWeight: 0,
      capped: false,
    }));
    const a = computeScoresDigest("p", 1, "2024-07-01T00:00:00.000Z", scores);
    const b = computeScoresDigest("p", 1, "2024-07-01T00:00:00.000Z", scores);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("REPUTATION STAYS A NON-LIFECYCLE/NON-AI/NON-DECENTRALIZED/NON-ECONOMIC layer in the NET-W031 files", async () => {
    for (const rel of W031_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: revocation is a one-way field mutation).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      // No AI authority: no advisory machinery can authorize proof
      // issuance or verification outcomes.
      expect(content).not.toMatch(/\baiEligibility\b/);
      expect(content).not.toMatch(/\baiSufficiency\b/);
      expect(content).not.toMatch(/\badvisoryRanking\b/);
      // No consensus / decentralization vocabulary (W032 excluded).
      expect(content).not.toMatch(/\bconsensusNode\b/i);
      expect(content).not.toMatch(/\bverificationNode\b/i);
      expect(content).not.toMatch(/\bblockchain\b/i);
      expect(content).not.toMatch(/\btokenEconomics\b/i);
      expect(content).not.toMatch(/\bvalidateOnNetwork\b/i);
      expect(content).not.toMatch(/\bzeroKnowledge\b/i);
      // No end-to-end flow vocabulary (W033+ excluded).
      expect(content).not.toMatch(/\bendToEndFlow\b/i);
      // No economic vocabulary (a proof never moves value).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      // No NEW cryptographic primitive (composition only — the domain
      // signs through the injected neutral surface; node:crypto is
      // used exclusively for record ids (randomUUID), exactly like the
      // W029 service, never for primitives or key material).
      expect(content).not.toMatch(/\bcreateHmac\b/);
      expect(content).not.toMatch(/\bcreateSign\b/);
      expect(content).not.toMatch(/\bcreateVerify\b/);
      expect(content).not.toMatch(/\bgenerateKeyPair\b/);
      expect(content).not.toMatch(/\bcreatePrivateKey\b/);
    }
  });

  test("TIER COMPLIANCE: the /reputation W031 files import core + self only (the neutral contracts are declared, never /evidence)", async () => {
    for (const rel of W031_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No domain imports outside itself/core (the W029 machinery is
      // composed through the NEUTRAL contracts wired at the root).
      expect(content).not.toMatch(
        /from ["']\.\.\/(evidence|outcomes|campaigns|inventory|settlement|disputes|creators|workflows|demand|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
    }
    // The whole /reputation boundary stays free of /evidence imports.
    for (const file of await readdir(join(SRC, "reputation"))) {
      if (!file.endsWith(".ts")) continue;
      const content = await readFile(join(SRC, "reputation", file), "utf8");
      expect(content, `reputation/${file} must not import /evidence`).not.toMatch(
        /from ["']\.\.\/evidence\//,
      );
    }
  });

  test("PROOF COMMAND VOCABULARY containment: confined to the /reputation boundary + guarded routes", async () => {
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    for (const action of [
      "reputationProof.create",
      "reputationProof.read",
      "reputationProof.verify",
      "reputationProof.revoke",
    ]) {
      expect(apiServer).toContain(`"${action}"`);
    }
    expect(apiServer).toContain("/api/reputation/proofs");
    // No other domain carries the W031 command vocabulary (the
    // /reputation boundary owns it exclusively).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "reputation") continue;
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry W031 command vocabulary`,
        ).not.toMatch(/\bissueProof\b/);
        expect(content).not.toMatch(/\bverifyPresentedProof\b/);
        expect(content).not.toMatch(/\brevokeProof\b/);
        expect(content).not.toMatch(/\bReputationProofService\b/);
        expect(content).not.toMatch(/\bReputationProofRepository\b/);
      }
    }
    // The api layer consumes the port types only (never the
    // implementation files).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/proof-service\.ts/);
    expect(apiPort).not.toMatch(/proof-input\.ts/);
    expect(apiPort).not.toMatch(/authority-proof-repository\.ts/);
  });

  test("the /evidence + /settlement + /workflows authorities are UNTOUCHED by NET-W031", async () => {
    // /evidence: the W029 machinery port gains NO proof coupling.
    const evidencePort = await readFile(join(REPO, "src/evidence/port.ts"), "utf8");
    expect(evidencePort).not.toMatch(/reputationProof|ReputationProof/i);
    // /settlement: the economic authority is unchanged by W031.
    const settlementPort = await readFile(join(REPO, "src/settlement/port.ts"), "utf8");
    expect(settlementPort).not.toMatch(/reputationProof|ReputationProof/i);
    // /workflows: the lifecycle authority is untouched (revocation is
    // a one-way field mutation — never a transition).
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/reputationProof|ReputationProof/i);
  });

  test("the composition root is the ONLY join between /reputation proofs and the W029 machinery (wiring pins)", async () => {
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    // The proof service is wired at the root over the proof repository
    // + the authority's OWN snapshot store + the idempotency store +
    // the transactional audit writer.
    expect(runtime).toContain("createReputationProofService(");
    expect(runtime).toContain("createAuthorityReputationProofRepository");
    // The NEUTRAL contracts are wired over the SAME versioned
    // attestation signing pair the W029 surface selected — the only
    // join — and W029's frozen vocabularies are injected as data.
    expect(runtime).toContain("reputationProofSigner: ReputationProofSigner = {");
    expect(runtime).toContain("signProof: (canonicalInput) =>");
    expect(runtime).toContain("verifyProof: (canonicalInput, envelope) =>");
    expect(runtime).toContain("reputationProofSigningVocabulary");
    expect(runtime).toContain("SIGNED_ATTESTATION_ALGORITHMS");
    // The API command surface is wired.
    expect(runtime).toContain("async issueReputationProof(");
    expect(runtime).toContain("async verifyReputationProof(");
    expect(runtime).toContain("async verifyPresentedReputationProof(");
    expect(runtime).toContain("async revokeReputationProof(");
    // The Runtime exposes the service.
    expect(runtime).toContain(
      "readonly reputationProofService: ReputationProofService;",
    );
  });

  test("the secret boundary holds: no key material in the NET-W031 files; NO new secret/config surface was minted", async () => {
    for (const rel of W031_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(false);
    }
    // No NEW required-in-production secret (the proof surface composes
    // the EXISTING attestation signing selection — zero new names).
    expect([...REQUIRED_IN_PRODUCTION]).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "OBJECT_STORAGE_BUCKET",
    ]);
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(schema).not.toMatch(/REPUTATION_PROOF\w*KEY/);
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(envExample).not.toMatch(/REPUTATION_PROOF\w*KEY/);
  });

  test("the NET-W031 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W031.md",
      ...W031_FILES,
      "tests/reputation/_net-w031-harness.ts",
      "tests/reputation/net-w031-ac-01-proof-model.test.ts",
      "tests/reputation/net-w031-ac-02-aggregate-disclosure.test.ts",
      "tests/reputation/net-w031-ac-03-deterministic-verification.test.ts",
      "tests/reputation/net-w031-ac-04-non-purchasable.test.ts",
      "tests/reputation/net-w031-ac-05-decay-consistency.test.ts",
      "tests/reputation/net-w031-ac-06-evidence-lineage.test.ts",
      "tests/reputation/net-w031-ac-07-tenancy-authorization.test.ts",
      "tests/reputation/net-w031-ac-08-atomicity-concurrency.test.ts",
      "tests/regression/net-w031-ac-09-architecture-out-of-scope.test.ts",
      "docs/net-w031-portable-reputation-proofs.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("the sanctioned shared-file amendments are scoped EXACTLY to the sanctioned NET-W031 additions", async () => {
    // The W007 harness forwards the attestation adapters (additive —
    // the W005-harness precedent, for REAL Ed25519/ECDSA pairs and
    // fault injection over the composed machinery).
    const w007Harness = await readFile(
      join(REPO, "tests/reputation/_net-w007-harness.ts"),
      "utf8",
    );
    expect(w007Harness).toContain("NET-W031 (additive)");
    expect(w007Harness).toContain("versionedSigner?: SignedAttestationSigner");
    // The snapshot repository gains the in-tx listing twin.
    const snapshotRepo = await readFile(
      join(REPO, "src/reputation/authority-snapshot-repository.ts"),
      "utf8",
    );
    expect(snapshotRepo).toContain("NET-W031 (additive)");
    expect(snapshotRepo).toContain("listBySubjectWithinTx");
    // The module registry summary carries the additive behaviour.
    const module = await readFile(join(REPO, "src/reputation/module.ts"), "utf8");
    expect(module).toContain("NET-W031");
    // The ReputationPort audit vocabulary carries the proof events.
    const port = await readFile(join(REPO, "src/reputation/port.ts"), "utf8");
    expect(port).toContain('reputationProofIssued: "reputation_proof.issued"');
    expect(port).toContain('reputationProofRevoked: "reputation_proof.revoked"');
    // The W007 scoring engine file is byte-identical to its W007 form
    // (no W031 marker — the pure engine was never touched).
    const scoring = await readFile(join(REPO, "src/reputation/scoring.ts"), "utf8");
    expect(scoring).not.toContain("NET-W031");
  });
});
