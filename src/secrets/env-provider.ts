/**
 * Concrete SecretProvider — environment-backed.
 *
 * Work order ref: NET-W001 §4.3, §9 (no committed secrets), §6
 * (SecretProvider). Reads secret material from the environment only.
 * In production, missing required secrets cause fail-fast startup
 * (enforced by the config layer; this provider resolves what is present).
 *
 * Secret material is NEVER returned into domain modules — only
 * infrastructure wiring calls getSecret(), and the value must not be
 * persisted or logged.
 */

import type { SecretDescriptor, SecretProvider } from "../core/secrets.ts";
import { SecretNotFoundError } from "../core/secrets.ts";

export interface EnvSecretProviderOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly catalog: readonly SecretDescriptor[];
}

export function createEnvSecretProvider(
  opts: EnvSecretProviderOptions,
): SecretProvider {
  const source = opts.source ?? process.env;
  const catalog = opts.catalog;

  const provider: SecretProvider = {
    async getSecret(key: string): Promise<string> {
      const value = source[key];
      if (value === undefined || value === "") {
        throw new SecretNotFoundError(key);
      }
      return value;
    },
    getSecretSync(key: string): string {
      // Synchronous resolution for the composition root (bootstrap),
      // which needs the connection string at construction time to wire
      // a real provider adapter. The env-backed store is a synchronous
      // map read, so this is trivially correct here. A future
      // remote-backed SecretProvider (e.g. Vault) that cannot resolve
      // synchronously would throw SecretNotFoundError, which the
      // composition root wraps in a ProviderConfigurationError.
      const value = source[key];
      if (value === undefined || value === "") {
        throw new SecretNotFoundError(key);
      }
      return value;
    },
    describe: () =>
      catalog.map((d) => ({
        ...d,
        hasValue: Boolean(source[d.key]),
      })),
    hasSecret: (key: string) => Boolean(source[key]),
  };

  return provider;
}

/**
 * Build the secret catalog from the configuration field classifications.
 * Returns descriptors for every field classified as a secret.
 */
export function buildSecretCatalog(
  configDescriptors: ReadonlyArray<{ readonly key: string; readonly classification: string }>,
): readonly SecretDescriptor[] {
  return configDescriptors
    .filter((d) => d.classification === "secret")
    .map((d) => ({
      key: d.key,
      required: false,
      hasValue: false,
      redactedPreview: `<secret:${d.key}>`,
    }));
}
