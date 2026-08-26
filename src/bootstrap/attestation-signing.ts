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
