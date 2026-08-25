/**
 * ConfigurationProvider contract — centralized, typed, validated configuration.
 *
 * Work order ref: NET-W001 §4.3 (Configuration).
 *
 * The concrete provider lives in src/config/provider.ts. It validates
 * environment with zod, fails fast on invalid required configuration,
 * exposes safe development defaults, and classifies secrets. Domain
 * modules consume the typed snapshot ONLY through this interface so
 * they never read process.env directly.
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

export interface ConfigSnapshot {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly appName: string;
  readonly port: number;
  readonly logLevel: string;
  /** Catalog of recognized fields with redacted diagnostics. */
  readonly descriptors: readonly ConfigFieldDescriptor[];
  /** Frozen at validation time; immutable for the process lifetime. */
  readonly frozenAt: string;
}

export interface ConfigurationProvider {
  readonly snapshot: ConfigSnapshot;
  /** Resolve a non-secret config value. Throws for unknown keys. */
  get<T = string>(key: string): T;
  /**
   * Resolve a secret by reference. NEVER returns the value into a domain
   * module's hands directly — the SecretProvider is the authority for
   * secret material. This accessor is reserved for infrastructure wiring.
   */
  getSecretReference(key: string): string;
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
