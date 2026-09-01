/**
 * ConfigurationProvider contract — centralized, typed, validated configuration.
 *
 * Work order ref: NET-W001 §4.3 (Configuration), §6 (SecretProvider).
 *
 * The concrete provider lives in src/config/provider.ts. It validates
 * environment with zod, fails fast on invalid required configuration,
 * exposes safe development defaults, and classifies secrets. Domain
 * modules consume the typed snapshot ONLY through this interface so
 * they never read process.env directly.
 *
 * SECRETS BOUNDARY (architectural invariant):
 * The ConfigurationProvider is NOT a source of secret material. It
 * returns ONLY non-secret configuration values via {@link get}, and
 * returns opaque secret *references* via {@link getSecretReference}.
 * A reference never carries the secret value; it is resolved to the
 * value exclusively by the {@link SecretProvider} at the infrastructure
 * boundary. Any attempt to read a classified secret through {@link get}
 * raises a {@link SecretAccessError}.
 */

import type { ErrorClassification } from "./errors.ts";

export type ConfigClassification = "required" | "optional" | "secret";

export interface ConfigFieldDescriptor {
  readonly key: string;
  readonly classification: ConfigClassification;
  readonly required: boolean;
  readonly hasValue: boolean;
  /**
   * NEVER the secret value. For secrets this is a redacted placeholder.
   * Provided only so audit/diagnostics can confirm presence.
   */
  readonly redactedPreview: string;
}

/**
 * Opaque reference to a classified secret. NEVER carries the secret
 * value — only the logical key plus redacted diagnostics. The value
 * is resolved by the {@link SecretProvider} (see core/secrets.ts).
 *
 * Infrastructure wiring obtains a reference from the
 * ConfigurationProvider and passes `reference.key` to
 * `secretProvider.getSecret(key)`; the value never lives in the
 * ConfigurationProvider.
 */
export interface SecretReference {
  /** Logical catalog key (e.g. "DATABASE_URL"). NEVER the secret value. */
  readonly key: string;
  /** NEVER the secret value. Redacted presence indicator only. */
  readonly redactedPreview: string;
  /** True iff a value is present in the configured source. */
  readonly hasValue: boolean;
}

export interface ConfigSnapshot {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly appName: string;
  readonly port: number;
  readonly logLevel: string;
  /**
   * NET-W029 (additive, non-breaking): the configured production
   * signature algorithm for the versioned (signed-attestation)
   * surface — "ed25519" | "ecdsa-p256" | "hmac-sha256" (default
   * "hmac-sha256"). NON-SECRET: a vocabulary choice; the key material
   * itself resolves only through the SecretProvider.
   */
  readonly attestationSigningAlgorithm: "ed25519" | "ecdsa-p256" | "hmac-sha256";
  /** Catalog of recognized fields with redacted diagnostics. */
  readonly descriptors: readonly ConfigFieldDescriptor[];
  /** Frozen at validation time; immutable for the process lifetime. */
  readonly frozenAt: string;
}

export interface ConfigurationProvider {
  readonly snapshot: ConfigSnapshot;
  /**
   * Resolve a NON-SECRET config value. Throws for unknown keys.
   * Throws {@link SecretAccessError} for any key classified as a
   * secret — secret material MUST be resolved through the
   * {@link SecretProvider}. This method never returns secret material.
   */
  get<T = string>(key: string): T;
  /**
   * Resolve an opaque reference to a classified secret. NEVER returns
   * the secret value — only a reference ({@link SecretReference})
   * carrying the logical key and redacted diagnostics. The reference
   * is resolved to the value exclusively by the {@link SecretProvider}
   * at the infrastructure boundary. Reserved for infrastructure wiring.
   */
  getSecretReference(key: string): SecretReference;
  /** Enumerate redacted field diagnostics (safe to log/audit). */
  describe(): readonly ConfigFieldDescriptor[];
  /** Returns true iff `key` is a classified secret. */
  isSecret(key: string): boolean;
}

export interface ConfigurationValidationErrorDetail {
  readonly key: string;
  readonly classification: ConfigClassification;
  readonly message: string;
  readonly classificationCode: ErrorClassification;
}
