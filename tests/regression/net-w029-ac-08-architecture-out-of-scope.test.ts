/**
 * NET-W029-AC-08 — architecture/out-of-scope regression (issue #58).
 *
 * NET-W029 ships INSIDE the frozen /evidence boundary (the SAME
 * boundary W005 created — no 17th domain). /reputation and /settlement
 * keep their authorities untouched (their records are covered read-only
 * through neutral lookups wired at the composition root); /workflows is
 * not extended (revocation is a ONE-WAY field mutation, never a
 * transition); the W005 contracts are byte-preserved (the v1 canonical
 * input, the commitments primitive, the Attestation trio). No
 * consensus/blockchain/network validation, no token economics, no
 * external payment execution, no portable-proof presentation surface
 * (W031), no external settlement adapters (W030), no decentralized
 * validation participants (W032), no AI authority. Key material
 * resolves only through the SecretProvider and never enters the
 * domain; the secret scan stays clean.
 *
 * The shared-file amendments are scoped exactly to the sanctioned
 * NET-W029 additions (the W005 harness forwards the versioned adapters;
 * the provider-selection fixture carries the new snapshot field; the
 * attestation-signing boot test pairs the versioned surface).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanAuthorityBoundaries } from "../../scripts/check-authority-boundaries.ts";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import {
  SIGNED_ATTESTATION_RECORD_FORMAT,
  SIGNED_ATTESTATION_ALGORITHMS,
  SIGNED_ATTESTATION_KEY_REFERENCES,
  SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM,
  SIGNED_ATTESTATION_COVERAGE_FAMILIES,
  SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS,
  SIGNED_ATTESTATION_VERIFICATION_REASONS,
} from "../../src/evidence/port.ts";
import { COMMITMENT_ALGORITHMS } from "../../src/core/evidence.ts";
import { buildAttestationDigestInput } from "../../src/evidence/attestation-service.ts";
import {
  createEvidenceCommitment,
  verifyEvidenceCommitment,
} from "../../src/evidence/commitments.ts";
import { REQUIRED_IN_PRODUCTION } from "../../src/config/schema.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W029_FILES = [
  "src/evidence/signed-attestation-input.ts",
  "src/evidence/signed-attestation-service.ts",
  "src/evidence/authority-signed-attestation-repository.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const SECRET_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;

describe("NET-W029-AC-08 architecture / out-of-scope", () => {
  test("the architecture + authority guards pass with all NET-W029 files (0 violations)", async () => {
    const authority = await scanAuthorityBoundaries(SRC);
    expect(authority.violations).toEqual([]);
    expect(authority.filesScanned).toBeGreaterThanOrEqual(304);
    const architecture = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(architecture.violations).toEqual([]);
    expect(architecture.filesScanned).toBeGreaterThanOrEqual(304);
  });

  test("spec/architecture.md and spec/architecture-lock.md remain FROZEN (no 17th domain; /evidence stays the single home of attestation semantics)", async () => {
    const lock = await readFile(join(REPO, "spec/architecture-lock.md"), "utf8");
    expect(lock).toContain("FROZEN");
    const arch = await readFile(join(REPO, "spec/architecture.md"), "utf8");
    expect(arch).toContain("FROZEN");
    // NET-W029 adds NO boundary and NO second attestation authority.
    expect(lock).not.toContain("- `/signed-attestations`");
    expect(lock).not.toContain("- `/attestations`");
    expect(lock).not.toContain("- `/integrity`");
    expect(lock).not.toContain("- `/cryptography`");
  });

  test("the NET-W029 work order exists and binds to frozen Architecture v1.0 + Issue #58", async () => {
    const workOrder = await readFile(join(REPO, "spec/work-orders/NET-W029.md"), "utf8");
    expect(workOrder).toContain("v1.0 FROZEN");
    expect(workOrder).toContain("#58");
    expect(workOrder).toContain("Cryptographic attestations and commitments");
    expect(workOrder).toContain("SecretProvider");
    expect(workOrder).toContain("fail closed");
    expect(workOrder).toContain("deterministic");
    expect(workOrder).toContain("PRIV-003");
    expect(workOrder).toContain("EVID-006");
    expect(workOrder).toContain("never rewrite");
  });

  test("the signed-attestation vocabularies are pinned; the W005 foundation vocabulary is UNCHANGED", () => {
    // The NEW NET-W029 vocabularies (closed, versioned, bounded).
    expect(SIGNED_ATTESTATION_RECORD_FORMAT).toBe("NET-W029:1");
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
    expect([...SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM["ed25519/v1"]]).toEqual([
      "attestation-signing/ed25519/v1",
    ]);
    expect([...SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM["ecdsa-p256/v1"]]).toEqual([
      "attestation-signing/ecdsa-p256/v1",
    ]);
    expect([...SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM["hmac-sha256/v1"]]).toEqual([
      "attestation-signing/hmac/v1",
      "attestation-signing/dev-insecure/v1",
    ]);
    expect([...SIGNED_ATTESTATION_COVERAGE_FAMILIES]).toEqual([
      "evidence",
      "reputation_input",
      "settlement_value",
    ]);
    expect(SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS).toBe(64);
    expect([...SIGNED_ATTESTATION_VERIFICATION_REASONS]).toEqual([
      "verified",
      "attestation_revoked",
      "unsupported_algorithm",
      "unknown_key_reference",
      "algorithm_key_reference_mismatch",
      "signature_mismatch",
      "covered_record_missing",
      "covered_record_mutated",
      "covered_state_invalid",
    ]);
    // The REUSED W005 vocabulary is unchanged (extend, never rewrite).
    expect([...COMMITMENT_ALGORITHMS]).toEqual(["sha256", "sha512"]);
  });

  test("the W005 foundation contracts are BEHAVIORALLY preserved (the v1 discipline + the commitments primitive)", () => {
    // The "attestation/v1" canonical digest input discipline — unchanged.
    const v1 = buildAttestationDigestInput("s", "v", [{ evidenceId: "e1", digest: "d1" }]);
    expect(v1.split("\n")[0]).toBe("attestation/v1");
    expect(v1).toContain("statement:s");
    expect(v1).toContain("verifier:v");
    expect(v1).toContain("evidence:e1:d1");
    // The W005 commitment primitive still round-trips (constant-time).
    const commitment = createEvidenceCommitment("payload", { algorithm: "sha512", salt: "s" });
    expect(verifyEvidenceCommitment("payload", commitment)).toBe(true);
    expect(verifyEvidenceCommitment("tampered", commitment)).toBe(false);
    // The W005 contracts remain declared in the port (structural pins).
    const portSource = requireBundledPort();
    expect(portSource).toContain("export interface Attestation {");
    expect(portSource).toContain("export interface AttestationSigner {");
    expect(portSource).toContain("export interface AttestationVerifier {");
    expect(portSource).toContain("sign(canonicalInput: string): Promise<{ algorithm: string; signature: string }>");
    // The v1 input BUILDER is never used by the W029 source files (the
    // v2 discipline is separate and additive; prose references to the
    // v1 contract in comments are documentation, not usage).
    for (const rel of W029_FILES) {
      const content = readFileSyncSafe(join(REPO, rel));
      expect(content).not.toMatch(/\bbuildAttestationDigestInput\b/);
      expect(content).not.toMatch(/\bresolveStoredCommitmentDigests\b/);
    }
  });

  test("EVIDENCE STAYS A NON-LIFECYCLE/NON-AI/NON-DECENTRALIZED layer: no lifecycle machinery, no AI authority, no consensus/external vocabulary in the NET-W029 files", async () => {
    for (const rel of W029_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: revocation is a one-way field mutation).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      // No domain imports outside itself/core (tier matrix: the
      // /reputation + /settlement facts cross through the NEUTRAL
      // lookups declared in the port and wired at the composition root).
      expect(content).not.toMatch(
        /from ["']\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|demand|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
      // No AI authority: no advisory machinery can authorize
      // attestations, commitments or verification outcomes.
      expect(content).not.toMatch(/\baiEligibility\b/);
      expect(content).not.toMatch(/\baiSufficiency\b/);
      expect(content).not.toMatch(/\badvisoryRanking\b/);
      // No consensus / decentralization vocabulary (work order §4).
      expect(content).not.toMatch(/\bconsensusNode\b/i);
      expect(content).not.toMatch(/\bverificationNode\b/i);
      expect(content).not.toMatch(/\bblockchain\b/i);
      expect(content).not.toMatch(/\btokenEconomics\b/i);
      expect(content).not.toMatch(/\bvalidateOnNetwork\b/i);
      // No portable-proof presentation surface (W031) and no external
      // settlement adapters (W030) / decentralized participants (W032).
      expect(content).not.toMatch(/\bportableReputationProof\b/i);
      expect(content).not.toMatch(/\bportableProof\b/i);
      expect(content).not.toMatch(/\bexternalSettlementAdapter\b/i);
      expect(content).not.toMatch(/\bpaymentAdapter\b/i);
      expect(content).not.toMatch(/\bexecuteExternalPayment\b/i);
      // No economic vocabulary (an attestation never moves value).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
    }
  });

  test("EVIDENCE CONTAINMENT: the W029 command vocabulary is confined to the /evidence boundary and guarded routes", async () => {
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    for (const action of [
      "signedAttestation.create",
      "signedAttestation.read",
      "signedAttestation.verify",
      "signedAttestation.revoke",
    ]) {
      expect(apiServer).toContain(`"${action}"`);
    }
    // The routes exist under the /api/evidence/ surface.
    expect(apiServer).toContain("/api/evidence/signed-attestations");
    // No other domain carries the W029 command vocabulary (the
    // /evidence boundary owns it exclusively).
    for (const dir of DOMAIN_DIRS) {
      if (dir === "evidence") {
        continue;
      }
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry W029 command vocabulary`,
        ).not.toMatch(/\bcreateSignedAttestation\b/);
        expect(content).not.toMatch(/\bverifySignedAttestation\b/);
        expect(content).not.toMatch(/\brevokeSignedAttestation\b/);
        expect(content).not.toMatch(/\bSignedAttestationService\b/);
        expect(content).not.toMatch(/\bSignedAttestationRepository\b/);
      }
    }
  });

  test("the reputation + settlement + workflows authorities are UNTOUCHED by NET-W029", async () => {
    // /reputation: the reputation authority port has NO
    // signed-attestation coupling (the coverage lookup lives in the
    // /evidence port + the composition root only).
    const reputationPort = await readFile(join(REPO, "src/reputation/port.ts"), "utf8");
    expect(reputationPort).not.toMatch(/signedAttestation|SignedAttestation/i);
    // /settlement: the economic authority port is UNCHANGED by W029.
    const settlementPort = await readFile(join(REPO, "src/settlement/port.ts"), "utf8");
    expect(settlementPort).not.toMatch(/signedAttestation|SignedAttestation/i);
    // /workflows: the lifecycle authority is untouched by W029
    // (revocation is a one-way field mutation — never a transition;
    // the table's W005-era PoV attestation gating is legitimate W005
    // vocabulary, NOT W029's signed-attestation surface).
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/signedAttestation|SignedAttestation/);
  });

  test("the composition root is the ONLY join between /evidence and the /reputation + /settlement authorities (wiring pins)", async () => {
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    // The signed-attestation service is wired at the root over the
    // authority repository + the neutral coverage lookups + the
    // idempotency store + the transactional audit writer.
    expect(runtime).toContain("createSignedAttestationService(");
    expect(runtime).toContain("createAuthoritySignedAttestationRepository");
    expect(runtime).toContain("reputationInputCoverageLookup");
    expect(runtime).toContain("settlementValueCoverageLookup");
    // The versioned signing selection (the fail-closed provider
    // selection for the W029 surface).
    expect(runtime).toContain("selectVersionedAttestationSigning");
    // The API command surface is wired.
    expect(runtime).toContain("async createSignedAttestation(");
    expect(runtime).toContain("async verifySignedAttestation(");
    expect(runtime).toContain("async revokeSignedAttestation(");
    // The Runtime exposes the service.
    expect(runtime).toContain(
      "readonly signedAttestationService: SignedAttestationService;",
    );
    // The api layer consumes the port types only (never the
    // implementation files).
    const apiPort = await readFile(join(REPO, "src/api/port.ts"), "utf8");
    expect(apiPort).not.toMatch(/signed-attestation-service\.ts/);
    expect(apiPort).not.toMatch(/signed-attestation-input\.ts/);
    expect(apiPort).not.toMatch(/authority-signed-attestation-repository\.ts/);
    const apiServer = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(apiServer).not.toMatch(/signed-attestation-service\.ts/);
    expect(apiServer).not.toMatch(/signed-attestation-input\.ts/);
    expect(apiServer).not.toMatch(/authority-signed-attestation-repository\.ts/);
    expect(apiServer).toContain("signedAttestation.create");
    expect(apiServer).toContain("signedAttestation.verify");
    expect(apiServer).toContain("signedAttestation.revoke");
  });

  test("the secret boundary holds: no key material in the NET-W029 files; the new config entries are names only", async () => {
    for (const rel of W029_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(SECRET_VALUE_PATTERN.test(content), `${rel} must be secret-free`).toBe(false);
    }
    // The composition-root signing selection ALSO stays secret-free
    // (key material lives only in KeyObjects built from the
    // SecretProvider-resolved PEM, never as literals).
    const signing = await readFile(join(REPO, "src/bootstrap/attestation-signing.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(signing)).toBe(false);
    // The config schema carries the new entries as NAMES + the
    // algorithm selector as NON-SECRET; the private-key PEMs are
    // classified secrets resolved only through the SecretProvider.
    const schema = await readFile(join(REPO, "src/config/schema.ts"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(schema)).toBe(false);
    expect(schema).toContain("ATTESTATION_SIGNING_ALGORITHM");
    expect(schema).toContain("ATTESTATION_SIGNING_ED25519_PRIVATE_KEY");
    expect(schema).toContain("ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY");
    // No new REQUIRED-in-production secret was minted (the keys are
    // conditionally required only when the algorithm is selected).
    expect([...REQUIRED_IN_PRODUCTION]).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "OBJECT_STORAGE_BUCKET",
    ]);
    // .env.example documents them as commented names, never values.
    const envExample = await readFile(join(REPO, ".env.example"), "utf8");
    expect(SECRET_VALUE_PATTERN.test(envExample)).toBe(false);
    expect(envExample).toContain("# ATTESTATION_SIGNING_ALGORITHM=hmac-sha256");
    expect(envExample).toContain("# ATTESTATION_SIGNING_ED25519_PRIVATE_KEY=");
    expect(envExample).toContain("# ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY=");
  });

  test("the NET-W029 file list (every artifact this work order introduced exists)", async () => {
    const expected = [
      "spec/work-orders/NET-W029.md",
      ...W029_FILES,
      "tests/evidence/_net-w029-harness.ts",
      "tests/evidence/net-w029-ac-01-coverage-records.test.ts",
      "tests/evidence/net-w029-ac-02-signing-vocabulary.test.ts",
      "tests/evidence/net-w029-ac-03-deterministic-verification.test.ts",
      "tests/evidence/net-w029-ac-04-commitment-privacy.test.ts",
      "tests/evidence/net-w029-ac-05-privacy-tenancy.test.ts",
      "tests/evidence/net-w029-ac-06-idempotency-concurrency.test.ts",
      "tests/evidence/net-w029-ac-07-authority-containment.test.ts",
      "tests/regression/net-w029-ac-08-architecture-out-of-scope.test.ts",
      "docs/net-w029-cryptographic-attestations.md",
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO, rel)), `${rel} should exist`).toBe(true);
    }
  });

  test("the sanctioned shared-file amendments are scoped EXACTLY to the sanctioned NET-W029 additions", async () => {
    // The W005 harness forwards the versioned adapters (additive).
    const w005Harness = await readFile(
      join(REPO, "tests/evidence/_net-w005-harness.ts"),
      "utf8",
    );
    expect(w005Harness).toContain("versionedSigner?: SignedAttestationSigner");
    expect(w005Harness).toContain("NET-W029 (additive)");
    // The provider-selection fixture carries the new snapshot field.
    const providerSelectionTest = await readFile(
      join(REPO, "tests/bootstrap/provider-selection.test.ts"),
      "utf8",
    );
    expect(providerSelectionTest).toContain('attestationSigningAlgorithm: "hmac-sha256"');
    expect(providerSelectionTest).toContain("NET-W029 UPDATE");
    // The attestation-signing boot test pairs the versioned surface.
    const signingTest = await readFile(
      join(REPO, "tests/bootstrap/attestation-signing.test.ts"),
      "utf8",
    );
    expect(signingTest).toContain("versionedSigner: versionedPair");
    expect(signingTest).toContain("NET-W029 UPDATE");
    // The W005 attestation-service + port files still carry their
    // original contracts (spot-pin the v1 discipline's home).
    const attestationService = await readFile(
      join(REPO, "src/evidence/attestation-service.ts"),
      "utf8",
    );
    expect(attestationService).toContain("attestation/v1");
    expect(attestationService).toContain("buildAttestationDigestInput");
  });
});

// -- helpers ------------------------------------------------------------

import { readFileSync } from "node:fs";

function requireBundledPort(): string {
  return readFileSync(join(REPO, "src/evidence/port.ts"), "utf8");
}

function readFileSyncSafe(path: string): string {
  return readFileSync(path, "utf8");
}
