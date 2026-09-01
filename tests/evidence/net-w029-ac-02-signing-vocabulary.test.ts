/**
 * NET-W029 AC-02 — signed attestations: versioned algorithms +
 * SecretProvider key references (issue #58; work order §3.2, §6).
 *
 * Production signature algorithms are REAL asymmetric cryptography
 * (Ed25519 / ECDSA P-256 via node:crypto) behind the injected signer/
 * verifier interfaces; algorithm identifiers and key references form
 * closed, versioned vocabularies; private keys resolve ONLY through
 * the SecretProvider and fail closed in production when missing or
 * unusable. The dev/test HMAC default stays clearly marked.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createEnvSecretProvider } from "../../src/secrets/env-provider.ts";
import { createLogger } from "../../src/observability/logger.ts";
import {
  selectVersionedAttestationSigning,
  createEd25519VersionedSignerVerifier,
  createEcdsaP256VersionedSignerVerifier,
  ATTESTATION_SIGNING_SECRET_KEY,
  ATTESTATION_SIGNING_ED25519_PRIVATE_KEY_SECRET,
  ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY_SECRET,
  type VersionedAttestationSigningSelection,
} from "../../src/bootstrap/attestation-signing.ts";
import { ProviderConfigurationError } from "../../src/core/errors.ts";
import { buildSignedAttestationDigestInput } from "../../src/evidence/signed-attestation-input.ts";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  seedReputationInput,
  seedSettlementValue,
  makeEd25519Adapters,
  makeEcdsaP256Adapters,
  type NetW029Harness,
} from "./_net-w029-harness.ts";

const CANONICAL = buildSignedAttestationDigestInput(
  "test statement",
  "verifier-1",
  "ed25519/v1",
  "attestation-signing/ed25519/v1",
  [{ family: "evidence", recordId: "ev-1", algorithm: "sha256", digest: "d1" }],
);

function makeSecretProvider(env: Record<string, string>) {
  const catalog = [
    ATTESTATION_SIGNING_SECRET_KEY,
    ATTESTATION_SIGNING_ED25519_PRIVATE_KEY_SECRET,
    ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY_SECRET,
  ].map((k) => ({
    key: k,
    required: false,
    hasValue: Boolean(env[k]),
    redactedPreview: `<secret:${k}>`,
  }));
  return createEnvSecretProvider({ source: env as NodeJS.ProcessEnv, catalog });
}

describe("NET-W029-AC-02 versioned algorithms + SecretProvider key references", () => {
  let harness: NetW029Harness;

  beforeAll(async () => {
    harness = await createNetW029Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("the dev/test default is the clearly-marked HMAC pair (never silently asymmetric)", () => {
    expect(harness.runtime.attestationSigning.mode).toBe("dev-default");
    expect(harness.runtime.attestationSigning.algorithm).toBe("hmac-sha256/v1");
    expect(harness.runtime.attestationSigning.keyReference).toBe(
      "attestation-signing/dev-insecure/v1",
    );
  });

  test("explicit REAL Ed25519 adapters: records carry ed25519/v1 + its key reference and verify", async () => {
    const adapters = makeEd25519Adapters();
    const edHarness = await createNetW029Harness({
      attestation: {
        versionedSigner: adapters.versionedSigner,
        versionedVerifier: adapters.versionedVerifier,
      },
    });
    try {
      const evidence = await createEvidenceRecord(edHarness);
      const result = await createSignedAttestation(edHarness, [
        { family: "evidence", recordId: evidence.id },
      ]);
      expect(result.attestation.algorithm).toBe("ed25519/v1");
      expect(result.attestation.keyReference).toBe("attestation-signing/ed25519/v1");
      // A REAL Ed25519 signature (64 raw bytes → 128 hex chars).
      expect(result.attestation.signature).toMatch(/^[0-9a-f]{128}$/);
      const verdict = await edHarness.runtime.signedAttestationService.verifySignedAttestation(
        edHarness.bootstrapCtx,
        edHarness.organizationScopeId,
        result.attestation.id,
      );
      expect(verdict.valid).toBe(true);
      expect(verdict.reason).toBe("verified");
    } finally {
      await edHarness.teardown();
    }
  });

  test("explicit REAL ECDSA P-256 adapters: records carry ecdsa-p256/v1 + its key reference and verify", async () => {
    const adapters = makeEcdsaP256Adapters();
    const ecHarness = await createNetW029Harness({
      attestation: {
        versionedSigner: adapters.versionedSigner,
        versionedVerifier: adapters.versionedVerifier,
      },
    });
    try {
      const evidence = await createEvidenceRecord(ecHarness);
      const result = await createSignedAttestation(ecHarness, [
        { family: "evidence", recordId: evidence.id },
      ]);
      expect(result.attestation.algorithm).toBe("ecdsa-p256/v1");
      expect(result.attestation.keyReference).toBe("attestation-signing/ecdsa-p256/v1");
      const verdict = await ecHarness.runtime.signedAttestationService.verifySignedAttestation(
        ecHarness.bootstrapCtx,
        ecHarness.organizationScopeId,
        result.attestation.id,
      );
      expect(verdict.valid).toBe(true);
      // Signatures from the Ed25519 pair do NOT verify under the ECDSA pair.
      const edAdapters = makeEd25519Adapters();
      const decision = await adapters.versionedVerifier.verifyVersioned(CANONICAL, {
        algorithm: "ed25519/v1",
        keyReference: "attestation-signing/ed25519/v1",
        signature: await (async () => (await edAdapters.versionedSigner.signVersioned(CANONICAL)).signature)(),
      });
      expect(decision.valid).toBe(false);
    } finally {
      await ecHarness.teardown();
    }
  });

  test("signing/verification ROUND-TRIPS over ALL THREE record families (real Ed25519)", async () => {
    const adapters = makeEd25519Adapters();
    const edHarness = await createNetW029Harness({
      attestation: {
        versionedSigner: adapters.versionedSigner,
        versionedVerifier: adapters.versionedVerifier,
      },
    });
    try {
      const evidence = await createEvidenceRecord(edHarness);
      const input = await seedReputationInput(edHarness, { sourceEvidenceId: evidence.id });
      const value = await seedSettlementValue(edHarness, { sourceEvidenceId: evidence.id });
      const result = await createSignedAttestation(edHarness, [
        { family: "evidence", recordId: evidence.id },
        { family: "reputation_input", recordId: input.id },
        { family: "settlement_value", recordId: value.id },
      ]);
      const verdict = await edHarness.runtime.signedAttestationService.verifySignedAttestation(
        edHarness.bootstrapCtx,
        edHarness.organizationScopeId,
        result.attestation.id,
      );
      expect(verdict.valid).toBe(true);
      expect(verdict.reason).toBe("verified");
      // Every check passed, in the deterministic order.
      expect(verdict.checks.every((c) => c.passed)).toBe(true);
      expect(verdict.checks.map((c) => c.check)).toEqual([
        "revocation",
        "algorithm_vocabulary",
        "key_reference_vocabulary",
        "algorithm_key_reference_pairing",
        "signature",
        "covered_current_state",
        "covered_integrity",
        "covered_current_state",
        "covered_integrity",
        "covered_current_state",
        "covered_integrity",
      ]);
    } finally {
      await edHarness.teardown();
    }
  });

  test("PRODUCTION with ed25519 selected + the private key resolved through the SecretProvider selects the real pair", async () => {
    const adapters = makeEd25519Adapters();
    const selection: VersionedAttestationSigningSelection =
      selectVersionedAttestationSigning({
        environment: "production",
        secretProvider: makeSecretProvider({
          ATTESTATION_SIGNING_ED25519_PRIVATE_KEY: adapters.privateKeyPem,
        }),
        logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
        algorithm: "ed25519",
      });
    expect(selection.mode).toBe("configured-secret");
    expect(selection.algorithm).toBe("ed25519/v1");
    expect(selection.keyReference).toBe("attestation-signing/ed25519/v1");
    // The production pair round-trips against the SAME key material.
    const signed = await selection.signer.signVersioned(CANONICAL);
    const decision = await selection.verifier.verifyVersioned(CANONICAL, signed);
    expect(decision.valid).toBe(true);
    // A signature from a DIFFERENT key does not verify.
    const other = createEd25519VersionedSignerVerifier({
      privateKeyPem: makeEd25519Adapters().privateKeyPem,
    });
    const otherSigned = await other.signVersioned(CANONICAL);
    const rejected = await selection.verifier.verifyVersioned(CANONICAL, otherSigned);
    expect(rejected.valid).toBe(false);
  });

  test("PRODUCTION with an asymmetric algorithm selected and the secret MISSING fails closed", () => {
    expect(() =>
      selectVersionedAttestationSigning({
        environment: "production",
        secretProvider: makeSecretProvider({}),
        logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
        algorithm: "ed25519",
      }),
    ).toThrow(ProviderConfigurationError);
    expect(() =>
      selectVersionedAttestationSigning({
        environment: "staging",
        secretProvider: makeSecretProvider({}),
        logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
        algorithm: "ecdsa-p256",
      }),
    ).toThrow(ProviderConfigurationError);
  });

  test("PRODUCTION with an UNUSABLE (non-PEM) private key fails closed with the operator-actionable error", () => {
    let caught: unknown = null;
    try {
      selectVersionedAttestationSigning({
        environment: "production",
        secretProvider: makeSecretProvider({
          ATTESTATION_SIGNING_ED25519_PRIVATE_KEY: "not-a-pem-at-all",
        }),
        logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
        algorithm: "ed25519",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderConfigurationError);
    expect((caught as ProviderConfigurationError).message).toMatch(/usable ed25519 private key/i);
    // Same for a well-formed PEM that is NOT an EC P-256 key.
    let caughtEcdsa: unknown = null;
    try {
      selectVersionedAttestationSigning({
        environment: "production",
        secretProvider: makeSecretProvider({
          ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY: makeEd25519Adapters().privateKeyPem,
        }),
        logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
        algorithm: "ecdsa-p256",
      });
    } catch (err) {
      caughtEcdsa = err;
    }
    expect(caughtEcdsa).toBeInstanceOf(ProviderConfigurationError);
  });

  test("PARTIAL versioned adapter wiring (signer without verifier) is rejected in EVERY environment (fail closed)", () => {
    const adapters = makeEd25519Adapters();
    for (const environment of ["development", "test", "staging", "production"] as const) {
      expect(() =>
        selectVersionedAttestationSigning({
          environment,
          secretProvider: makeSecretProvider({}),
          logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
          attestation: { versionedSigner: adapters.versionedSigner },
        }),
      ).toThrow(/must be configured as a PAIR/i);
      expect(() =>
        selectVersionedAttestationSigning({
          environment,
          secretProvider: makeSecretProvider({}),
          logger: createLogger({ module: "w029-ac02", minLevel: "warn", pretty: false }),
          attestation: { versionedVerifier: adapters.versionedVerifier },
        }),
      ).toThrow(ProviderConfigurationError);
    }
  });

  test("the full composition root boots PRODUCTION with ed25519 selected + the SecretProvider key", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    const adapters = makeEd25519Adapters();
    const runtime = createRuntime({
      env: {
        APP_ENV: "production",
        PORT: "0",
        DATABASE_URL:
          "postgres://TESTFIXTURE-user:TESTFIXTURE-pass@TESTFIXTURE-host-127:5432/TESTFIXTURE-db",
        REDIS_URL: "redis://TESTFIXTURE-redis-host-127:6379/0",
        OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
        // The W005 (v1) surface keeps its own independent production key.
        ATTESTATION_SIGNING_KEY: "TESTFIXTURE-production-attestation-key",
        // The W029 (v2) surface selects the asymmetric production path.
        ATTESTATION_SIGNING_ALGORITHM: "ed25519",
        ATTESTATION_SIGNING_ED25519_PRIVATE_KEY: adapters.privateKeyPem,
      },
      port: 0,
    });
    expect(runtime.attestationSigning.algorithm).toBe("ed25519/v1");
    expect(runtime.attestationSigning.keyReference).toBe("attestation-signing/ed25519/v1");
    await runtime.shutdown();
  });

  test("the ECDSA composition-root helper rejects a mismatched key shape (defense in depth)", () => {
    expect(() =>
      createEcdsaP256VersionedSignerVerifier({
        privateKeyPem: makeEd25519Adapters().privateKeyPem,
      }),
    ).toThrow();
  });
});
