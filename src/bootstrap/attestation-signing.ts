/**
 * Composition-root attestation signing selection.
 *
 * Architect review on PR #10 (NET-W005 remediation): production
 * attestation signing must FAIL CLOSED. The previous wiring permitted
 * the well-known `dev-insecure-attestation-key` fallback outside test
 * environments (and — because it read a field the configuration
 * snapshot never carried — the fallback was effectively unconditional,
 * even when ATTESTATION_SIGNING_KEY was configured).
 *
 * This selector follows the NET-W003 provider-selection pattern:
 *
 *         configured production/staging
 *                 ↓
 *   explicit signer/verifier adapters (preferred)?
 *           ↓ no
 *   SecretProvider.getSecretSync(ATTESTATION_SIGNING_KEY)
 *           ↓ missing / well-known dev literal
 *   ProviderConfigurationError (fail fast — NEVER the dev default)
 *
 *   development / test
 *           ↓
 *   ATTESTATION_SIGNING_KEY if configured, otherwise the
 *   clearly-marked dev/test default (warn in development;
 *   silent in test).
 *
 * Fail-fast contract: when `production` or `staging` is selected and
 * neither an explicit signer/verifier adapter pair NOR a resolvable
 * ATTESTATION_SIGNING_KEY secret is available, selection throws
 * {@link ProviderConfigurationError} (classification `validation`,
 * not retryable). It NEVER silently falls back to the insecure
 * development key in a configured deployment.
 *
 * Provider isolation (frozen architecture §14): this file is part of
 * the composition root (`src/bootstrap/**`). The concrete HMAC
 * signer/verifier is constructed HERE only; the evidence domain
 * consumes the verifier-neutral `AttestationSigner` /
 * `AttestationVerifier` structural interfaces and never sees the key.
 */

import type { Logger } from "../core/logger.ts";
import type { SecretProvider } from "../core/secrets.ts";
import { ProviderConfigurationError } from "../core/errors.ts";
import type {
  AttestationSigner,
  AttestationVerifier,
} from "../evidence/port.ts";
import {
  createHmacAttestationSignerVerifier,
  DEV_INSECURE_ATTESTATION_KEY,
} from "../evidence/hmac-attestation-verifier.ts";
import { createHmac, createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { sign as nodeSign, verify as nodeVerify } from "node:crypto";
import type {
  SignedAttestationSigner,
  SignedAttestationVerifier,
} from "../evidence/port.ts";

/** The attestation signing key secret (env-backed). */
export const ATTESTATION_SIGNING_SECRET_KEY = "ATTESTATION_SIGNING_KEY";

/** Which attestation signing implementation was selected. */
export type AttestationSigningMode =
  | "explicit-adapters"
  | "configured-secret"
  | "dev-default";

/**
 * The result of attestation signing selection. The signer/verifier are
 * typed by the verifier-neutral evidence-domain interfaces; `mode`
 * records which implementation was selected for diagnostics and tests.
 * No key material is ever exposed.
 */
export interface AttestationSigningSelection {
  readonly signer: AttestationSigner;
  readonly verifier: AttestationVerifier;
  readonly mode: AttestationSigningMode;
}

/**
 * Explicitly configured attestation adapters (e.g. a production
 * Ed25519 signing service behind an adapter). Must be provided as a
 * PAIR — signing with one implementation and verifying with another
 * would make every signature unverifiable, so partial wiring is a
 * configuration error in EVERY environment.
 */
export interface AttestationAdapters {
  readonly signer?: AttestationSigner;
  readonly verifier?: AttestationVerifier;
}

export interface SelectAttestationSigningOptions {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly secretProvider: SecretProvider;
  readonly logger: Logger;
  /** Explicitly configured production signer/verifier adapters. */
  readonly attestation?: AttestationAdapters;
}

export function selectAttestationSigning(
  opts: SelectAttestationSigningOptions,
): AttestationSigningSelection {
  const logger = opts.logger.child("attestation-signing");
  const environment = opts.environment;

  // Explicit adapters take precedence in every environment (an
  // operator-provided production signer/verifier pair is the most
  // explicit configuration possible). Partial wiring is rejected
  // outright — fail closed rather than half-wire crypto.
  if (opts.attestation?.signer && opts.attestation?.verifier) {
    logger.info("attestation.signing.selected", {
      environment,
      mode: "explicit-adapters",
    });
    return {
      signer: opts.attestation.signer,
      verifier: opts.attestation.verifier,
      mode: "explicit-adapters",
    };
  }
  if (opts.attestation?.signer || opts.attestation?.verifier) {
    throw new ProviderConfigurationError(
      "Attestation signing adapters must be configured as a PAIR (signer + verifier); partial wiring would produce signatures that can never verify. Provide both or neither.",
      { provider: "attestation", environment },
    );
  }

  const isConfiguredDeployment =
    environment === "production" || environment === "staging";

  if (isConfiguredDeployment) {
    // FAIL CLOSED: resolve the signing key through the SecretProvider
    // (the ONLY boundary that returns secret material — the bootstrap
    // never reads env directly for secrets). A configured deployment
    // without a resolvable key throws; it NEVER falls back to the
    // well-known development literal.
    let key: string;
    try {
      key = opts.secretProvider.getSecretSync(ATTESTATION_SIGNING_SECRET_KEY);
    } catch (err) {
      throw new ProviderConfigurationError(
        `Required attestation signing configuration is not resolvable through the SecretProvider for environment "${environment}" (secret key: ${ATTESTATION_SIGNING_SECRET_KEY}). A configured ${environment} deployment must either configure this secret or supply an explicit production signer/verifier adapter pair via the composition root — it MUST NOT silently fall back to the insecure development key.`,
        {
          provider: "attestation",
          secretKey: ATTESTATION_SIGNING_SECRET_KEY,
          environment,
        },
        err,
      );
    }
    // The development fallback literal is committed to the repository —
    // it is public knowledge, not a secret. Reject it explicitly so a
    // placeholder value can never stand in for a production key.
    if (key === DEV_INSECURE_ATTESTATION_KEY) {
      throw new ProviderConfigurationError(
        `ATTESTATION_SIGNING_KEY is configured with the well-known insecure development literal for environment "${environment}". Configure a strong secret or supply an explicit production signer/verifier adapter pair.`,
        {
          provider: "attestation",
          secretKey: ATTESTATION_SIGNING_SECRET_KEY,
          environment,
        },
      );
    }
    logger.info("attestation.signing.selected", {
      environment,
      mode: "configured-secret",
    });
    const signerVerifier = createHmacAttestationSignerVerifier({ key });
    return { signer: signerVerifier, verifier: signerVerifier, mode: "configured-secret" };
  }

  // Development / test: a configured key is honoured; otherwise the
  // clearly-marked dev/test default (warn in development so operators
  // see it; silent in test to keep test output clean).
  if (opts.secretProvider.hasSecret(ATTESTATION_SIGNING_SECRET_KEY)) {
    const key = opts.secretProvider.getSecretSync(ATTESTATION_SIGNING_SECRET_KEY);
    logger.info("attestation.signing.selected", {
      environment,
      mode: "configured-secret",
    });
    const signerVerifier = createHmacAttestationSignerVerifier({ key });
    return { signer: signerVerifier, verifier: signerVerifier, mode: "configured-secret" };
  }
  if (environment === "development") {
    logger.warn("attestation.signing_key_fallback", {
      message:
        "ATTESTATION_SIGNING_KEY is not configured — using the insecure development default (configure a strong key or supply a production signer/verifier adapter pair; production/staging fail closed)",
      environment,
    });
  }
  const devDefault = createHmacAttestationSignerVerifier({
    key: DEV_INSECURE_ATTESTATION_KEY,
  });
  return {
    signer: devDefault,
    verifier: devDefault,
    mode: "dev-default",
  };
}

// ----------------------------------------------------------------------
// NET-W029 — VERSIONED attestation signing (issue #58).
//
// The production-grade SIGNED-attestation surface: closed, versioned
// algorithm + key-reference vocabularies (declared in the /evidence
// port) and REAL asymmetric cryptography (Ed25519 / ECDSA P-256 via
// node:crypto) implemented HERE, in the composition root, behind the
// injected SignedAttestationSigner / SignedAttestationVerifier
// interfaces. The evidence domain never sees provider-specific code
// or key material; private keys resolve ONLY through the
// SecretProvider and are never committed, logged or persisted.
//
// Selection discipline (the same fail-closed pattern as the W005
// selector above):
//
//         explicit versioned signer/verifier adapters (PAIR required)
//                 ↓ no
//         ATTESTATION_SIGNING_ALGORITHM (config, default "hmac-sha256")
//           ├─ "ed25519"     → SecretProvider: ATTESTATION_SIGNING_ED25519_PRIVATE_KEY
//           ├─ "ecdsa-p256"  → SecretProvider: ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY
//           └─ "hmac-sha256" → SecretProvider: ATTESTATION_SIGNING_KEY (the W005 secret)
//                 ↓ missing/unusable in production/staging
//         ProviderConfigurationError (fail fast — NEVER the dev default)
//
//   development / test
//           ↓
//   the algorithm-specific secret if present, otherwise the
//   clearly-marked dev-insecure HMAC default (warned in development,
//   silent in test) — never selected in production/staging.
//
// The DEFAULT algorithm is "hmac-sha256" so existing configured
// deployments keep booting unchanged (the W005 remediation contract);
// operators opt IN to the asymmetric production algorithms through
// ATTESTATION_SIGNING_ALGORITHM + the algorithm-specific private-key
// secret.
// ----------------------------------------------------------------------

/** The non-secret config key selecting the production signing algorithm. */
export const ATTESTATION_SIGNING_ALGORITHM_KEY = "ATTESTATION_SIGNING_ALGORITHM";

/** The Ed25519 production private key secret (PKCS#8 PEM). */
export const ATTESTATION_SIGNING_ED25519_PRIVATE_KEY_SECRET =
  "ATTESTATION_SIGNING_ED25519_PRIVATE_KEY";

/** The ECDSA P-256 production private key secret (PKCS#8 PEM). */
export const ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY_SECRET =
  "ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY";

export type VersionedAttestationSigningAlgorithm = "ed25519" | "ecdsa-p256" | "hmac-sha256";

export type VersionedAttestationSigningMode =
  | "explicit-adapters"
  | "configured-secret"
  | "dev-default";

export interface VersionedAttestationSigningSelection {
  readonly signer: SignedAttestationSigner;
  readonly verifier: SignedAttestationVerifier;
  readonly mode: VersionedAttestationSigningMode;
  /** The ACTIVE closed-vocabulary algorithm id (e.g. "ed25519/v1"). */
  readonly algorithm: string;
  /** The ACTIVE closed-vocabulary key reference (e.g. "attestation-signing/ed25519/v1"). */
  readonly keyReference: string;
}

/**
 * A REAL Ed25519 versioned signer/verifier over a PKCS#8 PEM private
 * key (the public key is derived from it). Signature = hex(Ed25519(
 * canonicalInput)); verification recomputes and compares through
 * node:crypto's constant-time primitives. Constructed in the
 * composition root ONLY; the PEM never leaves this boundary.
 */
export function createEd25519VersionedSignerVerifier(opts: {
  readonly privateKeyPem: string;
  readonly keyReference?: string;
}): SignedAttestationSigner & SignedAttestationVerifier {
  const privateKey = createPrivateKey(opts.privateKeyPem);
  // FAIL CLOSED at construction: the key material must actually be an
  // Ed25519 private key and must sign+verify a fixed probe — garbage
  // PEM, mismatched key types and unusable material are startup
  // errors (wrapped by the selector as ProviderConfigurationError),
  // never first-sign surprises.
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `the provided private key is not an Ed25519 key (asymmetricKeyType: ${String(privateKey.asymmetricKeyType)})`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  const PROBE = Buffer.from("opencon-attestation-key-probe/v1", "utf8");
  const probeSignature = nodeSign(null, PROBE, privateKey);
  if (!nodeVerify(null, PROBE, publicKey, probeSignature)) {
    throw new Error("the provided Ed25519 key material failed the sign/verify probe");
  }
  const keyReference = opts.keyReference ?? "attestation-signing/ed25519/v1";

  function signCanonical(canonicalInput: string): string {
    return nodeSign(null, Buffer.from(canonicalInput, "utf8"), privateKey).toString("hex");
  }

  return {
    algorithm: "ed25519/v1",
    keyReference,
    async signVersioned(canonicalInput) {
      return {
        algorithm: "ed25519/v1",
        signature: signCanonical(canonicalInput),
        keyReference,
      };
    },
    async verifyVersioned(canonicalInput, attestation) {
      if (attestation.algorithm !== "ed25519/v1") {
        return {
          valid: false,
          reason: `unsupported attestation algorithm ${String(attestation.algorithm)} (this verifier accepts ed25519/v1)`,
        };
      }
      if (attestation.keyReference !== keyReference) {
        return {
          valid: false,
          reason: `unknown key reference ${String(attestation.keyReference)} (this verifier accepts ${keyReference})`,
        };
      }
      let signature: Buffer;
      try {
        signature = Buffer.from(attestation.signature ?? "", "hex");
      } catch {
        return { valid: false, reason: "attestation signature is not valid hex" };
      }
      const valid = nodeVerify(
        null,
        Buffer.from(canonicalInput, "utf8"),
        publicKey,
        signature,
      );
      return valid
        ? { valid: true, reason: "attestation signature verified" }
        : {
            valid: false,
            reason:
              "attestation signature does not match the rebuilt canonical input (tampered statement, covered set, commitments, algorithm, key reference or signature)",
          };
    },
  };
}

/**
 * A REAL ECDSA P-256 versioned signer/verifier over a PKCS#8 PEM
 * private key. Signature = hex(DER(ECDSA-SHA256(canonicalInput)));
 * verification recomputes through node:crypto. Constructed in the
 * composition root ONLY.
 */
export function createEcdsaP256VersionedSignerVerifier(opts: {
  readonly privateKeyPem: string;
  readonly keyReference?: string;
}): SignedAttestationSigner & SignedAttestationVerifier {
  const privateKey = createPrivateKey(opts.privateKeyPem);
  // FAIL CLOSED at construction (same discipline as the Ed25519
  // factory): an EC P-256 key that actually signs+verifies via
  // ECDSA-SHA256. Mismatched key shapes (e.g. an Ed25519 PEM) are
  // startup errors, never first-sign surprises.
  if (privateKey.asymmetricKeyType !== "ec") {
    throw new Error(
      `the provided private key is not an EC key (asymmetricKeyType: ${String(privateKey.asymmetricKeyType)})`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  const PROBE = Buffer.from("opencon-attestation-key-probe/v1", "utf8");
  const probeSignature = nodeSign("sha256", PROBE, privateKey);
  if (!nodeVerify("sha256", PROBE, publicKey, probeSignature)) {
    throw new Error("the provided EC key material failed the sign/verify probe");
  }
  const keyReference = opts.keyReference ?? "attestation-signing/ecdsa-p256/v1";

  function signCanonical(canonicalInput: string): string {
    return nodeSign("sha256", Buffer.from(canonicalInput, "utf8"), privateKey).toString("hex");
  }

  return {
    algorithm: "ecdsa-p256/v1",
    keyReference,
    async signVersioned(canonicalInput) {
      return {
        algorithm: "ecdsa-p256/v1",
        signature: signCanonical(canonicalInput),
        keyReference,
      };
    },
    async verifyVersioned(canonicalInput, attestation) {
      if (attestation.algorithm !== "ecdsa-p256/v1") {
        return {
          valid: false,
          reason: `unsupported attestation algorithm ${String(attestation.algorithm)} (this verifier accepts ecdsa-p256/v1)`,
        };
      }
      if (attestation.keyReference !== keyReference) {
        return {
          valid: false,
          reason: `unknown key reference ${String(attestation.keyReference)} (this verifier accepts ${keyReference})`,
        };
      }
      let signature: Buffer;
      try {
        signature = Buffer.from(attestation.signature ?? "", "hex");
      } catch {
        return { valid: false, reason: "attestation signature is not valid hex" };
      }
      const valid = nodeVerify(
        "sha256",
        Buffer.from(canonicalInput, "utf8"),
        publicKey,
        signature,
      );
      return valid
        ? { valid: true, reason: "attestation signature verified" }
        : {
            valid: false,
            reason:
              "attestation signature does not match the rebuilt canonical input (tampered statement, covered set, commitments, algorithm, key reference or signature)",
          };
    },
  };
}

/**
 * The versioned HMAC-SHA256 signer/verifier (the symmetric production
 * path reusing the existing ATTESTATION_SIGNING_KEY secret, and the
 * clearly-marked dev/test default). Signature = hex(HMAC-SHA256(key,
 * canonicalInput)); constant-time comparison.
 */
export function createHmacVersionedSignerVerifier(opts: {
  readonly key: string;
  readonly keyReference: "attestation-signing/hmac/v1" | "attestation-signing/dev-insecure/v1";
}): SignedAttestationSigner & SignedAttestationVerifier {
  const key = opts.key;
  const keyReference = opts.keyReference;

  function signCanonical(canonicalInput: string): string {
    return createHmac("sha256", key).update(canonicalInput, "utf8").digest("hex");
  }

  return {
    algorithm: "hmac-sha256/v1",
    keyReference,
    async signVersioned(canonicalInput) {
      return {
        algorithm: "hmac-sha256/v1",
        signature: signCanonical(canonicalInput),
        keyReference,
      };
    },
    async verifyVersioned(canonicalInput, attestation) {
      if (attestation.algorithm !== "hmac-sha256/v1") {
        return {
          valid: false,
          reason: `unsupported attestation algorithm ${String(attestation.algorithm)} (this verifier accepts hmac-sha256/v1)`,
        };
      }
      if (attestation.keyReference !== keyReference) {
        return {
          valid: false,
          reason: `unknown key reference ${String(attestation.keyReference)} (this verifier accepts ${keyReference})`,
        };
      }
      const expected = Buffer.from(signCanonical(canonicalInput), "utf8");
      const actual = Buffer.from(attestation.signature ?? "", "utf8");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return {
          valid: false,
          reason:
            "attestation signature does not match the rebuilt canonical input (tampered statement, covered set, commitments, algorithm, key reference or signature)",
        };
      }
      return { valid: true, reason: "attestation signature verified" };
    },
  };
}

export interface SelectVersionedAttestationSigningOptions {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly secretProvider: SecretProvider;
  readonly logger: Logger;
  /** The configured production algorithm (ATTESTATION_SIGNING_ALGORITHM; default "hmac-sha256"). */
  readonly algorithm?: VersionedAttestationSigningAlgorithm;
  /** Explicitly configured versioned adapters (operator-provided or test-injected; PAIR required). */
  readonly attestation?: {
    readonly versionedSigner?: SignedAttestationSigner;
    readonly versionedVerifier?: SignedAttestationVerifier;
  };
}

export function selectVersionedAttestationSigning(
  opts: SelectVersionedAttestationSigningOptions,
): VersionedAttestationSigningSelection {
  const logger = opts.logger.child("attestation-signing");
  const environment = opts.environment;

  // Explicit versioned adapters take precedence in every environment;
  // partial wiring is rejected outright — fail closed, never half-wire
  // crypto (the same rule as the W005 selector).
  if (opts.attestation?.versionedSigner && opts.attestation?.versionedVerifier) {
    logger.info("attestation.versioned_signing.selected", {
      environment,
      mode: "explicit-adapters",
      algorithm: opts.attestation.versionedSigner.algorithm,
      keyReference: opts.attestation.versionedSigner.keyReference,
    });
    return {
      signer: opts.attestation.versionedSigner,
      verifier: opts.attestation.versionedVerifier,
      mode: "explicit-adapters",
      algorithm: opts.attestation.versionedSigner.algorithm,
      keyReference: opts.attestation.versionedSigner.keyReference,
    };
  }
  if (opts.attestation?.versionedSigner || opts.attestation?.versionedVerifier) {
    throw new ProviderConfigurationError(
      "Versioned attestation signing adapters must be configured as a PAIR (versionedSigner + versionedVerifier); partial wiring would produce signatures that can never verify. Provide both or neither.",
      { provider: "attestation", environment },
    );
  }

  const isConfiguredDeployment = environment === "production" || environment === "staging";
  const algorithm = opts.algorithm ?? "hmac-sha256";

  if (algorithm === "ed25519" || algorithm === "ecdsa-p256") {
    const secretKey =
      algorithm === "ed25519"
        ? ATTESTATION_SIGNING_ED25519_PRIVATE_KEY_SECRET
        : ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY_SECRET;

    // Development / test WITHOUT the algorithm-specific secret fall
    // back to the clearly-marked dev-insecure HMAC default (warned in
    // development; silent in test) — exactly like the W005 selector.
    if (!isConfiguredDeployment && !opts.secretProvider.hasSecret(secretKey)) {
      if (environment === "development") {
        logger.warn("attestation.versioned_signing_key_fallback", {
          message: `${secretKey} is not configured — using the insecure development default (configure the ${algorithm} private key, select a different algorithm, or supply explicit versioned adapters; production/staging fail closed)`,
          environment,
        });
      }
      const devDefault = createHmacVersionedSignerVerifier({
        key: DEV_INSECURE_ATTESTATION_KEY,
        keyReference: "attestation-signing/dev-insecure/v1",
      });
      return {
        signer: devDefault,
        verifier: devDefault,
        mode: "dev-default",
        algorithm: devDefault.algorithm,
        keyReference: devDefault.keyReference,
      };
    }

    // FAIL CLOSED: resolve the private key through the SecretProvider
    // (the ONLY boundary that returns secret material) and construct
    // the REAL asymmetric signer/verifier. Missing or unusable key
    // material fails startup — never a fallback.
    let pem: string;
    try {
      pem = opts.secretProvider.getSecretSync(secretKey);
    } catch (err) {
      throw new ProviderConfigurationError(
        `Required versioned attestation signing configuration is not resolvable through the SecretProvider for environment "${environment}" (algorithm "${algorithm}", secret key: ${secretKey}). A configured ${environment} deployment must either configure this secret or supply an explicit versioned signer/verifier adapter pair via the composition root — it MUST NOT silently fall back to an insecure default.`,
        { provider: "attestation", secretKey, environment, algorithm },
        err,
      );
    }
    try {
      const pair =
        algorithm === "ed25519"
          ? createEd25519VersionedSignerVerifier({ privateKeyPem: pem })
          : createEcdsaP256VersionedSignerVerifier({ privateKeyPem: pem });
      logger.info("attestation.versioned_signing.selected", {
        environment,
        mode: "configured-secret",
        algorithm: pair.algorithm,
        keyReference: pair.keyReference,
      });
      return {
        signer: pair,
        verifier: pair,
        mode: "configured-secret",
        algorithm: pair.algorithm,
        keyReference: pair.keyReference,
      };
    } catch (err) {
      throw new ProviderConfigurationError(
        `The ${secretKey} secret does not resolve to a usable ${algorithm} private key for environment "${environment}" (expected PKCS#8 PEM). Configure a valid key or supply an explicit versioned signer/verifier adapter pair.`,
        { provider: "attestation", secretKey, environment, algorithm },
        err,
      );
    }
  }

  // hmac-sha256 (the DEFAULT — existing configured deployments keep
  // booting unchanged; the W005 remediation contract applies verbatim).
  const hmacSecretKey = ATTESTATION_SIGNING_SECRET_KEY;
  if (isConfiguredDeployment) {
    let key: string;
    try {
      key = opts.secretProvider.getSecretSync(hmacSecretKey);
    } catch (err) {
      throw new ProviderConfigurationError(
        `Required versioned attestation signing configuration is not resolvable through the SecretProvider for environment "${environment}" (algorithm "hmac-sha256", secret key: ${hmacSecretKey}). A configured ${environment} deployment must either configure this secret, select an asymmetric algorithm, or supply an explicit versioned signer/verifier adapter pair — it MUST NOT silently fall back to the insecure development key.`,
        { provider: "attestation", secretKey: hmacSecretKey, environment },
        err,
      );
    }
    if (key === DEV_INSECURE_ATTESTATION_KEY) {
      throw new ProviderConfigurationError(
        `ATTESTATION_SIGNING_KEY is configured with the well-known insecure development literal for environment "${environment}". Configure a strong secret, select an asymmetric algorithm, or supply an explicit versioned signer/verifier adapter pair.`,
        { provider: "attestation", secretKey: hmacSecretKey, environment },
      );
    }
    const pair = createHmacVersionedSignerVerifier({
      key,
      keyReference: "attestation-signing/hmac/v1",
    });
    logger.info("attestation.versioned_signing.selected", {
      environment,
      mode: "configured-secret",
      algorithm: pair.algorithm,
      keyReference: pair.keyReference,
    });
    return {
      signer: pair,
      verifier: pair,
      mode: "configured-secret",
      algorithm: pair.algorithm,
      keyReference: pair.keyReference,
    };
  }

  if (opts.secretProvider.hasSecret(hmacSecretKey)) {
    const key = opts.secretProvider.getSecretSync(hmacSecretKey);
    const pair = createHmacVersionedSignerVerifier({
      key,
      keyReference: "attestation-signing/hmac/v1",
    });
    logger.info("attestation.versioned_signing.selected", {
      environment,
      mode: "configured-secret",
      algorithm: pair.algorithm,
      keyReference: pair.keyReference,
    });
    return {
      signer: pair,
      verifier: pair,
      mode: "configured-secret",
      algorithm: pair.algorithm,
      keyReference: pair.keyReference,
    };
  }
  if (environment === "development") {
    logger.warn("attestation.versioned_signing_key_fallback", {
      message:
        "no versioned attestation signing key is configured — using the insecure development default (configure a strong key, select an asymmetric algorithm, or supply explicit versioned adapters; production/staging fail closed)",
      environment,
    });
  }
  const devDefault = createHmacVersionedSignerVerifier({
    key: DEV_INSECURE_ATTESTATION_KEY,
    keyReference: "attestation-signing/dev-insecure/v1",
  });
  return {
    signer: devDefault,
    verifier: devDefault,
    mode: "dev-default",
    algorithm: devDefault.algorithm,
    keyReference: devDefault.keyReference,
  };
}
