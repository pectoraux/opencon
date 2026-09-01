/**
 * Composition-root external settlement authentication selection
 * (NET-W030; the attestation-signing / seller-authorization trust
 * wiring precedents).
 *
 * Provider isolation (frozen architecture §14.24, invariant 25):
 * this file is part of the composition root (`src/bootstrap/**`) —
 * the ONLY join between the provider trust material and the
 * /settlement authority. The concrete HMAC-SHA256 authenticator is
 * constructed HERE with per-provider material resolved exclusively
 * through the SecretProvider; the settlement domain consumes the
 * verifier-neutral `ExternalSettlementAuthenticator` structural
 * interface and never sees key material.
 *
 * Resolution order per provider (the W023 PR #47 trust-channel rule):
 *
 *         explicit composition override (test wiring / operator key)
 *                 ↓ absent
 *         SecretProvider.getSecretSync(<provider key>)
 *                 ↓ absent
 *         NOT configured — ingestion for that provider fails closed
 *         (`unauthenticated`); NOTHING is ever recorded
 *
 * There is NO development default: an unconfigured trust channel can
 * never authenticate a submission (fail closed — the W022 "no secret
 * → fail closed" wiring rule). Unlike the attestation signing key
 * (required in production/staging), the external settlement channel
 * is an OPTIONAL integration: absence fails closed at INGESTION,
 * never at boot.
 *
 * Privacy (PRIV-002): key material, signatures and payload content
 * never appear in logs, audit events, or error contexts. The
 * verification is PURE, deterministic and NON-THROWING — comparison
 * is timing-safe.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../core/logger.ts";
import type { SecretProvider } from "../core/secrets.ts";
import type {
  ExternalSettlementAuthenticator,
  ExternalSettlementIntegrityBlock,
} from "../settlement/port.ts";
import { EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS } from "../settlement/port.ts";
import { externalSettlementCanonicalFacts } from "../settlement/external-settlement-input.ts";

/**
 * The per-provider trust-material secret keys (closed map over the
 * frozen provider vocabulary — a new provider is a vocabulary entry
 * AND a key mapping, never a silent wildcard).
 */
export const EXTERNAL_SETTLEMENT_TRUST_SECRET_KEYS: Readonly<
  Record<string, string>
> = Object.freeze({
  reference: "EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY",
});

/** Hex-encoded HMAC-SHA256 signatures (64 hex chars). */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

/** The result of the trust-channel selection (no key material exposed). */
export interface ExternalSettlementAuthenticationSelection {
  readonly authenticator: ExternalSettlementAuthenticator;
  /** The providers with resolvable trust material (diagnostics only). */
  readonly configuredProviders: readonly string[];
  /** Whether each closed-vocabulary provider is configured. */
  readonly configured: Readonly<Record<string, boolean>>;
}

export interface SelectExternalSettlementAuthenticationOptions {
  readonly secretProvider: SecretProvider;
  readonly logger: Logger;
  /**
   * Explicit per-provider trust keys (test wiring or an
   * operator-provided channel key) — takes precedence over the
   * SecretProvider in every environment.
   */
  readonly overrides?: Readonly<Record<string, string>>;
}

export function selectExternalSettlementAuthentication(
  opts: SelectExternalSettlementAuthenticationOptions,
): ExternalSettlementAuthenticationSelection {
  const logger = opts.logger.child("external-settlement-authentication");
  const trustKeys: Record<string, string> = {};
  const configured: Record<string, boolean> = {};

  for (const [provider, secretKey] of Object.entries(EXTERNAL_SETTLEMENT_TRUST_SECRET_KEYS)) {
    const override = opts.overrides?.[provider];
    if (override !== undefined && override.length > 0) {
      trustKeys[provider] = override;
      configured[provider] = true;
      continue;
    }
    if (opts.secretProvider.hasSecret(secretKey)) {
      trustKeys[provider] = opts.secretProvider.getSecretSync(secretKey);
      configured[provider] = true;
      continue;
    }
    // NOT configured: ingestion for this provider fails closed
    // (every submission is `unauthenticated` — never silently
    // recorded). This is the intended optional-integration state,
    // not an error.
    configured[provider] = false;
  }

  const configuredProviders = Object.keys(EXTERNAL_SETTLEMENT_TRUST_SECRET_KEYS).filter(
    (provider) => configured[provider],
  );
  logger.info("external_settlement.authentication.selected", {
    configuredProviders,
    unconfiguredProviders: Object.keys(EXTERNAL_SETTLEMENT_TRUST_SECRET_KEYS).filter(
      (provider) => !configured[provider],
    ),
  });

  return {
    authenticator: createHmacExternalSettlementAuthenticator({ trustKeys }),
    configuredProviders,
    configured,
  };
}

/**
 * The REAL HMAC-SHA256 trust-envelope verifier (the composition-root
 * implementation behind the neutral interface). PURE, deterministic
 * and NON-THROWING: no configured key, absent/malformed envelope,
 * unsupported algorithm, or signature mismatch all return `false`
 * (fail closed). Comparison is timing-safe. Never inspects or
 * returns secret material; the signature never crosses this boundary
 * in logs or errors.
 */
export function createHmacExternalSettlementAuthenticator(options: {
  readonly trustKeys: Readonly<Record<string, string>>;
}): ExternalSettlementAuthenticator {
  const trustKeys = options.trustKeys;
  return {
    verify(submission) {
      const key = trustKeys[submission.provider];
      // No configured trust material → nothing can be authenticated
      // (fail closed; the W022 no-secret wiring rule).
      if (key === undefined || key.length === 0) return false;
      const integrity: ExternalSettlementIntegrityBlock | undefined =
        submission.integrity;
      if (integrity === undefined || integrity === null) return false;
      if (
        typeof integrity.algorithm !== "string" ||
        !(EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS as readonly string[]).includes(
          integrity.algorithm,
        )
      ) {
        return false;
      }
      if (
        typeof integrity.signature !== "string" ||
        !SIGNATURE_RE.test(integrity.signature)
      ) {
        return false;
      }
      if (
        typeof integrity.signedAt !== "string" ||
        Number.isNaN(Date.parse(integrity.signedAt))
      ) {
        return false;
      }
      const expected = computeExternalSettlementSignature(submission, key);
      const expectedBytes = Buffer.from(expected, "utf8");
      const actualBytes = Buffer.from(integrity.signature, "utf8");
      if (expectedBytes.length !== actualBytes.length) return false;
      return timingSafeEqual(expectedBytes, actualBytes);
    },
  };
}

/**
 * Compute the trust-envelope HMAC-SHA256 signature over the canonical
 * attested facts. Exported for the TRUSTED PROVIDER SIDE (tests
 * construct signed notifications with it); the authenticator above
 * uses it to VERIFY. Pure function of the submission facts + the
 * trust key.
 */
export function computeExternalSettlementSignature(
  submission: {
    readonly provider: string;
    readonly externalId: string;
    readonly internalTransactionId: string;
    readonly reportedAmount: number;
    readonly reportedUnit: string;
    readonly observedAt: string;
    readonly correctionOf: string | null;
  },
  trustKey: string,
): string {
  return createHmac("sha256", trustKey).update(externalSettlementCanonicalFacts(submission)).digest("hex");
}

/**
 * Build a valid trust envelope for a submission (the trusted
 * provider side — tests and future collector integrations).
 */
export function buildExternalSettlementIntegrity(
  submission: {
    readonly provider: string;
    readonly externalId: string;
    readonly internalTransactionId: string;
    readonly reportedAmount: number;
    readonly reportedUnit: string;
    readonly observedAt: string;
    readonly correctionOf: string | null;
  },
  trustKey: string,
  signedAt: string,
): ExternalSettlementIntegrityBlock {
  return Object.freeze({
    algorithm: EXTERNAL_SETTLEMENT_INTEGRITY_ALGORITHMS[0],
    signature: computeExternalSettlementSignature(submission, trustKey),
    signedAt,
  });
}
