/**
 * Concrete ConfigurationProvider.
 *
 * Validates environment with the zod schema, builds an immutable typed
 * snapshot, and exposes redacted diagnostics. Fail-fast on invalid
 * required configuration (AC-04). Domain modules consume the snapshot
 * through the {@link ConfigurationProvider} interface declared in core.
 *
 * SECRETS BOUNDARY (architectural invariant, enforced here):
 * Secret material is never returned through this provider. {@link get}
 * throws {@link SecretAccessError} for any key classified as a secret;
 * {@link getSecretReference} returns an opaque {@link SecretReference}
 * (key + redacted diagnostics) that is resolved to the value only by
 * the {@link SecretProvider}. The store of raw values is private and
 * never exposed. This closes the boundary leak where secret values
 * (DATABASE_URL, REDIS_URL, OBJECT_STORAGE_BUCKET, …) could previously
 * be retrieved through the ConfigurationProvider.
 */

import { ConfigSchema, CONFIG_FIELD_CLASSIFICATIONS, REQUIRED_IN_PRODUCTION } from "./schema.ts";
import { ConfigurationValidationError, SecretAccessError } from "../core/errors.ts";
import type {
  ConfigFieldDescriptor,
  ConfigSnapshot,
  ConfigurationProvider,
  SecretReference,
} from "../core/config.ts";

export interface LoadConfigOptions {
  /** Source map; defaults to process.env. */
  readonly source?: NodeJS.ProcessEnv;
  /** Override the environment for tests. */
  readonly forceEnv?: "development" | "test" | "staging" | "production";
  readonly failOnMissingRequiredSecrets?: boolean;
}

export function loadConfig(opts: LoadConfigOptions = {}): {
  readonly provider: ConfigurationProvider;
  readonly snapshot: ConfigSnapshot;
} {
  const source = opts.source ?? process.env;
  const parsed = ConfigSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationValidationError(
      `Configuration validation failed:\n${detail}`,
      { issues: parsed.error.issues },
      parsed.error,
    );
  }
  const raw = parsed.data;
  const environment =
    opts.forceEnv ?? (raw.APP_ENV as ConfigSnapshot["environment"]);

  // Fail-fast: in non-development environments, required secrets must be
  // present (AC-04). In development/test we permit safe defaults so the
  // skeleton is operable out-of-the-box.
  const enforceRequiredSecrets =
    opts.failOnMissingRequiredSecrets === true ||
    environment === "production" ||
    environment === "staging";
  if (enforceRequiredSecrets) {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !source[k]);
    if (missing.length > 0) {
      throw new ConfigurationValidationError(
        `Required secrets are not configured for environment "${environment}": ${missing.join(", ")}`,
        { missing },
      );
    }
  }

  const frozenAt = new Date().toISOString();
  const descriptors: ConfigFieldDescriptor[] = CONFIG_FIELD_CLASSIFICATIONS.map((f) => {
    const hasValue = Boolean(source[f.key]);
    return {
      key: f.key,
      classification: f.classification,
      required: f.required,
      hasValue,
      redactedPreview: hasValue ? redact(f.key) : "<unset>",
    };
  });

  const snapshot: ConfigSnapshot = Object.freeze({
    environment,
    appName: raw.APP_NAME,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    descriptors: Object.freeze(descriptors),
    frozenAt,
  }) as ConfigSnapshot;

  // Private store of raw validated values. This is NEVER exposed
  // outside this closure for secret keys: get() throws on secrets and
  // getSecretReference() returns only a redacted reference. The value
  // is resolved exclusively by the SecretProvider at the infra boundary.
  const store = new Map<string, unknown>(Object.entries(raw));
  // Catalog of ALL recognized keys (secret + non-secret). Used to
  // distinguish "unknown key" (ConfigurationValidationError) from
  // "known secret accessed via get()" (SecretAccessError) — the latter
  // must fire even when the secret is absent in the environment.
  const knownKeys: ReadonlySet<string> = new Set(
    CONFIG_FIELD_CLASSIFICATIONS.map((f) => f.key),
  );
  const secretKeys: ReadonlySet<string> = new Set(
    CONFIG_FIELD_CLASSIFICATIONS
      .filter((f) => f.classification === "secret")
      .map((f) => f.key),
  );

  const provider: ConfigurationProvider = {
    snapshot,
    get<T = string>(key: string): T {
      // Unknown key (not in the catalog at all).
      if (!knownKeys.has(key)) {
        throw new ConfigurationValidationError(
          `Unknown configuration key: ${key}`,
          { key },
        );
      }
      // SECRETS BOUNDARY: never return secret material through get().
      // Fires for every classified secret — present OR absent — so the
      // leak is closed regardless of whether the env value is set.
      if (secretKeys.has(key)) {
        throw new SecretAccessError(
          `Configuration key "${key}" is classified as a secret and must be resolved through the SecretProvider, not via ConfigurationProvider.get()`,
          { key },
        );
      }
      return store.get(key) as T;
    },
    getSecretReference(key: string): SecretReference {
      // Unknown key (not in the catalog at all).
      if (!knownKeys.has(key)) {
        throw new ConfigurationValidationError(
          `Unknown configuration key: ${key}`,
          { key },
        );
      }
      if (!secretKeys.has(key)) {
        throw new SecretAccessError(
          `Configuration key "${key}" is not classified as a secret; use get() for non-secret values`,
          { key },
        );
      }
      // Return an opaque reference: the logical key plus redacted
      // diagnostics. NEVER the secret value. Works whether or not a
      // value is present in the environment (hasValue reflects presence).
      // The SecretProvider resolves reference.key to the value at the
      // infra boundary.
      const hasValue = Boolean(source[key]);
      return Object.freeze({
        key,
        redactedPreview: hasValue ? redact(key) : "<unset>",
        hasValue,
      }) as SecretReference;
    },
    describe: () => descriptors,
    isSecret: (key: string) =>
      descriptors.find((d) => d.key === key)?.classification === "secret",
  };

  return { provider, snapshot };
}

function redact(key: string): string {
  // Never expose secret values. Return a deterministic presence token.
  return `<present:${key}>`;
}
