/**
 * Concrete ConfigurationProvider.
 *
 * Validates environment with the zod schema, builds an immutable typed
 * snapshot, and exposes redacted diagnostics. Fail-fast on invalid
 * required configuration (AC-04). Domain modules consume the snapshot
 * through the {@link ConfigurationProvider} interface declared in core.
 */

import { ConfigSchema, CONFIG_FIELD_CLASSIFICATIONS, REQUIRED_IN_PRODUCTION } from "./schema.ts";
import { ConfigurationValidationError } from "../core/errors.ts";
import type {
  ConfigFieldDescriptor,
  ConfigSnapshot,
  ConfigurationProvider,
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

  const store = new Map<string, unknown>(Object.entries(raw));
  const provider: ConfigurationProvider = {
    snapshot,
    get<T = string>(key: string): T {
      if (!store.has(key)) {
        throw new ConfigurationValidationError(
          `Unknown configuration key: ${key}`,
          { key },
        );
      }
      return store.get(key) as T;
    },
    getSecretReference(key: string): string {
      if (!store.has(key)) {
        throw new ConfigurationValidationError(
          `Secret not configured: ${key}`,
          { key },
        );
      }
      return String(store.get(key));
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
