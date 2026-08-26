/**
 * Composition-root provider selection.
 *
 * Work order ref: NET-W003 §4.1 (PostgreSQL authoritative persistence),
 * §4.2 (Redis non-authoritative coordination), architecture-lock §3
 * (PostgreSQL is authoritative application state in v1.0), §16 (Redis/
 * caches/queues are NEVER authoritative state), §14 (provider-specific
 * SDK/types do not cross into core domain modules), §18 (`/adapters` =
 * external platform/provider integrations).
 *
 * Architect re-review on PR #6 (composition-root wiring): the runtime
 * must select the REAL provider adapters in configured production/
 * staging deployments — resolving the connection strings through the
 * existing {@link SecretProvider} — and MUST NOT silently fall back to
 * the file/in-memory test doubles when required provider configuration
 * is missing. The shims remain available ONLY as explicit test/dev
 * doubles for environments that do not require a real provider.
 *
 * Provider selection flow (configured production/staging):
 *
 *         configured production/staging
 *                 ↓
 *         SecretProvider.getSecretSync
 *           ↓                 ↓
 *  DATABASE_URL         REDIS_URL
 *        ↓                   ↓
 *  PostgresAuthorityAdapter
 *           +
 *  RedisCoordinationAdapter
 *
 * Provider isolation (frozen architecture §14): this file is part of
 * the composition root (`src/bootstrap/**`, treated as the bootstrap
 * tier by the architecture checker). It is the ONLY non-adapter tier
 * permitted to import the concrete `PostgresAuthorityAdapter` /
 * `RedisCoordinationAdapter` classes — and it does so ONLY to construct
 * them. The exposed runtime fields are typed by the provider-neutral
 * contracts (`PostgresAuthority`, `CoordinationService`); domain and
 * infrastructure modules consume those contracts and never see the
 * concrete driver classes.
 *
 * Fail-fast contract: when `production` or `staging` is selected and a
 * required provider connection string cannot be resolved through the
 * SecretProvider, selection throws {@link ProviderConfigurationError}
 * (classification `validation`, not retryable). It never silently
 * selects a shim in place of a required real provider.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigurationProvider } from "../core/config.ts";
import type { Logger } from "../core/logger.ts";
import type { SecretProvider } from "../core/secrets.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import type { CoordinationService } from "../core/coordination.ts";
import { ProviderConfigurationError } from "../core/errors.ts";
// Concrete provider adapters — imported ONLY here (composition root).
// The architecture checker permits the bootstrap tier to import from
// the adapter tier; the adapter tier is the only place `pg`/`ioredis`
// are imported.
import { PostgresAuthorityAdapter } from "../adapters/postgres/postgres-authority-adapter.ts";
import { RedisCoordinationAdapter } from "../adapters/redis/redis-coordination-adapter.ts";
// Concrete test/dev doubles — imported ONLY here (composition root).
import { PostgresAuthorityShim } from "../persistence/postgres-authority-shim.ts";
import { RedisCoordinationShim } from "../queues/redis-coordination-shim.ts";

/** The PostgreSQL connection-string secret key (env-backed). */
export const POSTGRES_CONNECTION_SECRET_KEY = "DATABASE_URL";
/** The Redis connection-string secret key (env-backed). */
export const REDIS_CONNECTION_SECRET_KEY = "REDIS_URL";

/** Which concrete implementation was selected for each provider. */
export interface ProviderMode {
  readonly postgres: "real-adapter" | "shim";
  readonly redis: "real-adapter" | "shim";
}

/**
 * The result of composition-root provider selection. The exposed
 * `postgresAuthority` and `coordinationService` fields are typed by
 * the provider-neutral contracts so the rest of the runtime never
 * sees a concrete driver class. `mode` records which concrete
 * implementation was selected for diagnostics and tests.
 */
export interface ProviderSelection {
  /** The selected authoritative-persistence boundary. */
  readonly postgresAuthority: PostgresAuthority;
  /** The selected non-authoritative coordination boundary. */
  readonly coordinationService: CoordinationService;
  /** Which concrete implementation was selected, per provider. */
  readonly mode: ProviderMode;
  /** True iff at least one real provider adapter was selected. */
  readonly usesRealAdapters: boolean;
  /** Release the selected providers' resources (best-effort). */
  close(): Promise<void>;
}

export interface SelectProvidersOptions {
  readonly config: ConfigurationProvider;
  readonly secretProvider: SecretProvider;
  readonly logger: Logger;
  /**
   * Override the environment classification (test helper). When unset,
   * the environment is read from the configuration snapshot.
   */
  readonly forceEnv?: "development" | "test" | "staging" | "production";
  /**
   * Directory for the dev/test `PostgresAuthorityShim` snapshot. When
   * unset, a unique subdirectory under the OS temp dir is used (the
   * shim's durability is best-effort in dev/test).
   */
  readonly shimDir?: string;
}

/**
 * Select the persistence + coordination providers for the runtime.
 *
 * In `production` / `staging`: resolve `DATABASE_URL` and `REDIS_URL`
 * synchronously through the {@link SecretProvider} (via
 * `getSecretSync`) and construct the REAL
 * {@link PostgresAuthorityAdapter} + {@link RedisCoordinationAdapter}.
 * If either connection string cannot be resolved, throw
 * {@link ProviderConfigurationError} — NEVER silently fall back to a
 * shim.
 *
 * In `development` / `test`: construct the file-backed /
 * in-process shims ({@link PostgresAuthorityShim},
 * {@link RedisCoordinationShim}) as explicit test/dev doubles so the
 * runtime is operable out-of-the-box without a real PostgreSQL or
 * Redis.
 */
export function selectProviders(opts: SelectProvidersOptions): ProviderSelection {
  const environment =
    opts.forceEnv ?? opts.config.snapshot.environment;
  const isConfiguredDeployment =
    environment === "production" || environment === "staging";
  const logger = opts.logger.child("providers");

  if (isConfiguredDeployment) {
    // Resolve connection strings through the SecretProvider. The
    // SecretProvider is the ONLY boundary that returns secret material;
    // the bootstrap never reads env directly for secrets. The sync
    // accessor is used because the composition root constructs the
    // adapters eagerly at boot time (a remote-backed SecretProvider
    // that cannot resolve synchronously throws, which is wrapped in
    // a ProviderConfigurationError so the deployment fails fast).
    let pgConnectionString: string;
    try {
      pgConnectionString = opts.secretProvider.getSecretSync(
        POSTGRES_CONNECTION_SECRET_KEY,
      );
    } catch (err) {
      throw new ProviderConfigurationError(
        `Required PostgreSQL provider configuration is not resolvable through the SecretProvider for environment "${environment}" (secret key: ${POSTGRES_CONNECTION_SECRET_KEY}). A configured ${environment} deployment MUST NOT silently fall back to a file/in-memory test double.`,
        {
          provider: "postgres",
          secretKey: POSTGRES_CONNECTION_SECRET_KEY,
          environment,
        },
        err,
      );
    }
    let redisConnectionString: string;
    try {
      redisConnectionString = opts.secretProvider.getSecretSync(
        REDIS_CONNECTION_SECRET_KEY,
      );
    } catch (err) {
      throw new ProviderConfigurationError(
        `Required Redis provider configuration is not resolvable through the SecretProvider for environment "${environment}" (secret key: ${REDIS_CONNECTION_SECRET_KEY}). A configured ${environment} deployment MUST NOT silently fall back to an in-memory test double.`,
        {
          provider: "redis",
          secretKey: REDIS_CONNECTION_SECRET_KEY,
          environment,
        },
        err,
      );
    }

    const postgresAuthority = new PostgresAuthorityAdapter({
      connectionString: pgConnectionString,
      logger: { debug: (m, f) => logger.debug(m, f) },
    });
    const coordinationService = new RedisCoordinationAdapter({
      connectionString: redisConnectionString,
      logger: { debug: (m, f) => logger.debug(m, f) },
    });
    logger.info("providers.selected", {
      environment,
      postgres: "real-adapter",
      redis: "real-adapter",
    });
    return {
      postgresAuthority,
      coordinationService,
      mode: { postgres: "real-adapter", redis: "real-adapter" },
      usesRealAdapters: true,
      async close() {
        // Best-effort: close both, never let one failure mask the other.
        await Promise.allSettled([
          postgresAuthority.close(),
          coordinationService.close(),
        ]);
      },
    };
  }

  // Development / test: deliberate test/dev doubles so the runtime is
  // operable out-of-the-box without a real PostgreSQL or Redis. The
  // shims are clearly marked as test doubles in their own module docs;
  // they are NEVER selected for a configured production/staging
  // deployment (the branch above fails fast on missing config).
  const shimDir =
    opts.shimDir ?? join(tmpdir(), `opencon-shim-${randomUUID()}`);
  const postgresAuthority = new PostgresAuthorityShim({
    dir: shimDir,
    logger: { debug: (m, f) => logger.debug(m, f) },
  });
  const coordinationService = new RedisCoordinationShim({
    logger: { debug: (m, f) => logger.debug(m, f) },
  });
  logger.info("providers.selected", {
    environment,
    postgres: "shim",
    redis: "shim",
  });
  return {
    postgresAuthority,
    coordinationService,
    mode: { postgres: "shim", redis: "shim" },
    usesRealAdapters: false,
    async close() {
      // The PostgresAuthorityShim has a no-op close(); the Redis shim
      // has no close(). Both are inert in dev/test.
      await Promise.allSettled([postgresAuthority.close()]);
    },
  };
}
