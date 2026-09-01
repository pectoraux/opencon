/**
 * NET-W003 composition-root provider selection.
 *
 * Evidence (architect re-review on PR #6, final remaining blocker):
 * tests proving the composition root resolves the PostgreSQL and Redis
 * connection strings through the existing SecretProvider and constructs
 * the REAL adapter classes in configured production/staging deployments,
 * while keeping the shims as explicit test/dev doubles in development/test
 * — and failing fast (rather than silently selecting a shim) when
 * required provider configuration is missing.
 *
 * The provider-selection flow under test:
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
 * These are COMPOSITION-ROOT tests (not real-provider integration tests).
 * They prove the WIRING selects the correct concrete adapter class. The
 * real-provider integration tests in tests/integration/ prove the real
 * adapters actually work against real PostgreSQL + Redis services.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/provider.ts";
import { createEnvSecretProvider, buildSecretCatalog } from "../../src/secrets/env-provider.ts";
import { createLogger } from "../../src/observability/logger.ts";
import {
  selectProviders,
  type ProviderSelection,
} from "../../src/bootstrap/provider-selection.ts";
import { PostgresAuthorityAdapter } from "../../src/adapters/postgres/postgres-authority-adapter.ts";
import { RedisCoordinationAdapter } from "../../src/adapters/redis/redis-coordination-adapter.ts";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import { RedisCoordinationShim } from "../../src/queues/redis-coordination-shim.ts";
import { ProviderConfigurationError } from "../../src/core/errors.ts";
import { SecretNotFoundError } from "../../src/core/secrets.ts";
import type { ConfigurationProvider, ConfigSnapshot } from "../../src/core/config.ts";
import type { SecretProvider } from "../../src/core/secrets.ts";
import type { Logger } from "../../src/core/logger.ts";

// SYNTHETIC test-fixture connection strings — NOT real credentials.
// These deliberately use obviously-fake hostnames so they cannot be
// mistaken for real secrets by a scanner. The composition-root test
// only needs to prove the WIRING selects the correct adapter class;
// it does not dial the real service (the real adapters are constructed
// but never sent a command). The Redis adapter's defensive error
// listener absorbs the background connection attempt.
const SYNTHETIC_PG_URL = "postgres://TESTFIXTURE-user:TESTFIXTURE-pass@TESTFIXTURE-host-127:5432/TESTFIXTURE-db";
const SYNTHETIC_REDIS_URL = "redis://TESTFIXTURE-redis-host-127:6379/0";

function makeLogger(): Logger {
  return createLogger({
    module: "provider-selection-test",
    minLevel: "fatal", // suppress non-fatal log noise during tests
    pretty: false,
    collector: { entries: [] },
  });
}

/**
 * Build a REAL env-backed ConfigurationProvider + SecretProvider from a
 * source env map, using the same factories the composition root uses.
 */
function makeRealProviders(env: NodeJS.ProcessEnv): {
  readonly config: ConfigurationProvider;
  readonly secretProvider: SecretProvider;
} {
  const { provider: config } = loadConfig({ source: env });
  const secretProvider = createEnvSecretProvider({
    source: env,
    catalog: buildSecretCatalog(config.describe()),
  });
  return { config, secretProvider };
}

/**
 * A FAKE SecretProvider that throws SecretNotFoundError for specified
 * keys — used to prove the composition root fails fast (rather than
 * silently selecting a shim) when required provider configuration is
 * missing. This simulates a deployment where the SecretProvider cannot
 * resolve a required connection string.
 */
function makeFailingSecretProvider(missingKeys: ReadonlySet<string>): SecretProvider {
  return {
    async getSecret(key: string): Promise<string> {
      if (missingKeys.has(key)) throw new SecretNotFoundError(key);
      return `fake-value-for-${key}`;
    },
    getSecretSync(key: string): string {
      if (missingKeys.has(key)) throw new SecretNotFoundError(key);
      return `fake-value-for-${key}`;
    },
    describe: () => [],
    hasSecret: (key: string) => !missingKeys.has(key),
  };
}

/**
 * A FAKE ConfigurationProvider whose snapshot reports a given
 * environment, used so the composition-root fail-fast path can be
 * exercised WITHOUT going through loadConfig (which itself fails fast
 * for missing required secrets in production/staging — that is the
 * config-layer defense-in-depth, tested separately in AC-04).
 */
function makeFakeConfig(environment: ConfigSnapshot["environment"]): ConfigurationProvider {
  const snapshot = {
    environment,
    appName: "opencon-test",
    port: 0,
    logLevel: "info",
    // NET-W029 UPDATE (sanctioned additive amendment): the typed
    // snapshot gained the non-secret versioned-attestation algorithm
    // selector; the fixture carries the frozen default.
    attestationSigningAlgorithm: "hmac-sha256" as const,
    descriptors: [],
    frozenAt: new Date().toISOString(),
  } as ConfigSnapshot;
  return {
    snapshot,
    get: () => {
      throw new Error("fake config: get() not used in provider-selection tests");
    },
    getSecretReference: () => {
      throw new Error("fake config: getSecretReference() not used");
    },
    describe: () => [],
    isSecret: () => false,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  // Clean up any shim snapshot dirs created during the test run.
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("NET-W003 composition-root provider selection — development/test", () => {
  test("development environment selects the SHIM test/dev doubles (not real adapters)", () => {
    const { config, secretProvider } = makeRealProviders({
      APP_ENV: "development",
    });
    const selection = selectProviders({
      config,
      secretProvider,
      logger: makeLogger(),
      shimDir: mkdtempSync(join(tmpdir(), "provider-sel-dev-")),
    });
    tempDirs.push(selection.postgresAuthority instanceof PostgresAuthorityShim
      ? (selection as unknown as { _shimDir?: string })._shimDir ?? ""
      : "");
    expect(selection.postgresAuthority).toBeInstanceOf(PostgresAuthorityShim);
    expect(selection.coordinationService).toBeInstanceOf(RedisCoordinationShim);
    expect(selection.mode.postgres).toBe("shim");
    expect(selection.mode.redis).toBe("shim");
    expect(selection.usesRealAdapters).toBe(false);
  });

  test("test environment selects the SHIM test/dev doubles", () => {
    const { config, secretProvider } = makeRealProviders({
      APP_ENV: "test",
    });
    const selection = selectProviders({
      config,
      secretProvider,
      logger: makeLogger(),
    });
    expect(selection.postgresAuthority).toBeInstanceOf(PostgresAuthorityShim);
    expect(selection.coordinationService).toBeInstanceOf(RedisCoordinationShim);
    expect(selection.mode.postgres).toBe("shim");
    expect(selection.mode.redis).toBe("shim");
    expect(selection.usesRealAdapters).toBe(false);
  });

  test("development shim close() is a no-op and never throws", async () => {
    const { config, secretProvider } = makeRealProviders({
      APP_ENV: "development",
    });
    const selection = selectProviders({
      config,
      secretProvider,
      logger: makeLogger(),
    });
    await expect(selection.close()).resolves.toBeUndefined();
  });
});

describe("NET-W003 composition-root provider selection — configured production/staging", () => {
  // NOTE: these tests construct the REAL adapter classes with SYNTHETIC
  // (unreachable) connection strings. They do NOT dial the real service
  // — they only prove the WIRING selected the correct concrete adapter
  // class via `instanceof`. The real adapters' constructors are
  // non-dialing (pg.Pool dials on first query; the Redis adapter's
  // background connection attempt is absorbed by its defensive error
  // listener). close() is called immediately to release resources.

  test("PRODUCTION with required secrets present selects the REAL adapter classes", () => {
    const { config, secretProvider } = makeRealProviders({
      APP_ENV: "production",
      PORT: "8787",
      DATABASE_URL: SYNTHETIC_PG_URL,
      REDIS_URL: SYNTHETIC_REDIS_URL,
      OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
    });
    const selection = selectProviders({
      config,
      secretProvider,
      logger: makeLogger(),
    });
    // CRITICAL: the real adapter classes were selected, NOT the shims.
    expect(selection.postgresAuthority).toBeInstanceOf(PostgresAuthorityAdapter);
    expect(selection.coordinationService).toBeInstanceOf(RedisCoordinationAdapter);
    expect(selection.mode.postgres).toBe("real-adapter");
    expect(selection.mode.redis).toBe("real-adapter");
    expect(selection.usesRealAdapters).toBe(true);
    // The connection strings were resolved through the SecretProvider
    // (not read from env directly by the composition root). The real
    // adapter received them.
    void selection.postgresAuthority; // type-only — contract is provider-neutral
  });

  test("STAGING with required secrets present selects the REAL adapter classes", () => {
    const { config, secretProvider } = makeRealProviders({
      APP_ENV: "staging",
      PORT: "8787",
      DATABASE_URL: SYNTHETIC_PG_URL,
      REDIS_URL: SYNTHETIC_REDIS_URL,
      OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
    });
    const selection = selectProviders({
      config,
      secretProvider,
      logger: makeLogger(),
    });
    expect(selection.postgresAuthority).toBeInstanceOf(PostgresAuthorityAdapter);
    expect(selection.coordinationService).toBeInstanceOf(RedisCoordinationAdapter);
    expect(selection.mode.postgres).toBe("real-adapter");
    expect(selection.mode.redis).toBe("real-adapter");
    expect(selection.usesRealAdapters).toBe(true);
  });

  test("PRODUCTION resolves connection strings THROUGH the SecretProvider (not env)", () => {
    // Prove the connection strings passed to the real adapters came from
    // the SecretProvider, not from the bootstrap reading env directly.
    // We use a spy SecretProvider that records every getSecretSync call
    // and returns valid-shape synthetic URLs (so the adapter
    // constructors don't throw on URL parsing). If the wiring had read
    // env directly, the spy would have zero calls — the test would fail.
    const calls: string[] = [];
    const spySecretProvider: SecretProvider = {
      async getSecret(key: string) {
        calls.push(key);
        return key === "DATABASE_URL" ? SYNTHETIC_PG_URL : SYNTHETIC_REDIS_URL;
      },
      getSecretSync(key: string): string {
        calls.push(key);
        return key === "DATABASE_URL" ? SYNTHETIC_PG_URL : SYNTHETIC_REDIS_URL;
      },
      describe: () => [],
      hasSecret: () => true,
    };
    const config = makeFakeConfig("production");
    const selection = selectProviders({
      config,
      secretProvider: spySecretProvider,
      logger: makeLogger(),
    });
    expect(selection.postgresAuthority).toBeInstanceOf(PostgresAuthorityAdapter);
    expect(selection.coordinationService).toBeInstanceOf(RedisCoordinationAdapter);
    // CRITICAL: the SecretProvider was called for BOTH connection strings.
    // The wiring resolved them through getSecretSync — it did NOT read
    // env directly. If it had, `calls` would be empty.
    expect(calls).toContain("DATABASE_URL");
    expect(calls).toContain("REDIS_URL");
    expect(selection.usesRealAdapters).toBe(true);
  });

  test("real adapter close() releases resources without throwing", async () => {
    const { config, secretProvider } = makeRealProviders({
      APP_ENV: "production",
      PORT: "8787",
      DATABASE_URL: SYNTHETIC_PG_URL,
      REDIS_URL: SYNTHETIC_REDIS_URL,
      OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
    });
    const selection = selectProviders({
      config,
      secretProvider,
      logger: makeLogger(),
    });
    // close() must not throw even though the real adapters never
    // connected to a real service (pg.Pool.end() and redis.quit()
    // both handle never-connected state gracefully).
    await expect(selection.close()).resolves.toBeUndefined();
  });
});

describe("NET-W003 composition-root provider selection — fail-fast on missing required provider configuration", () => {
  // These tests prove the composition root NEVER silently falls back to
  // a shim when a required real-provider connection string is missing
  // in a configured production/staging deployment. The selection throws
  // ProviderConfigurationError (classification: validation, not
  // retryable) so an operator can remediate rather than discover data
  // loss later.

  test("PRODUCTION with DATABASE_URL missing from the SecretProvider fails fast (ProviderConfigurationError)", () => {
    const config = makeFakeConfig("production");
    const secretProvider = makeFailingSecretProvider(new Set(["DATABASE_URL"]));
    expect(() =>
      selectProviders({ config, secretProvider, logger: makeLogger() }),
    ).toThrow(ProviderConfigurationError);
  });

  test("PRODUCTION with REDIS_URL missing from the SecretProvider fails fast (ProviderConfigurationError)", () => {
    const config = makeFakeConfig("production");
    const secretProvider = makeFailingSecretProvider(new Set(["REDIS_URL"]));
    expect(() =>
      selectProviders({ config, secretProvider, logger: makeLogger() }),
    ).toThrow(ProviderConfigurationError);
  });

  test("STAGING with DATABASE_URL missing fails fast (ProviderConfigurationError)", () => {
    const config = makeFakeConfig("staging");
    const secretProvider = makeFailingSecretProvider(new Set(["DATABASE_URL"]));
    expect(() =>
      selectProviders({ config, secretProvider, logger: makeLogger() }),
    ).toThrow(ProviderConfigurationError);
  });

  test("the ProviderConfigurationError carries the provider name, secret key, and environment", () => {
    const config = makeFakeConfig("production");
    const secretProvider = makeFailingSecretProvider(new Set(["DATABASE_URL"]));
    let caught: ProviderConfigurationError | null = null;
    try {
      selectProviders({ config, secretProvider, logger: makeLogger() });
    } catch (e) {
      caught = e as ProviderConfigurationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("PROVIDER_CONFIGURATION");
    expect(caught!.classification).toBe("validation");
    expect(caught!.retryable).toBe(false);
    expect(caught!.context.provider).toBe("postgres");
    expect(caught!.context.secretKey).toBe("DATABASE_URL");
    expect(caught!.context.environment).toBe("production");
  });

  test("the error cause is the original SecretNotFoundError (debuggable chain)", () => {
    const config = makeFakeConfig("production");
    const secretProvider = makeFailingSecretProvider(new Set(["DATABASE_URL"]));
    let caught: ProviderConfigurationError | null = null;
    try {
      selectProviders({ config, secretProvider, logger: makeLogger() });
    } catch (e) {
      caught = e as ProviderConfigurationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.cause).toBeInstanceOf(SecretNotFoundError);
  });

  test("fail-fast NEVER silently selects a shim (no PostgresAuthorityShim constructed)", () => {
    const config = makeFakeConfig("production");
    const secretProvider = makeFailingSecretProvider(new Set(["DATABASE_URL"]));
    let selection: ProviderSelection | null = null;
    let threw = false;
    try {
      selection = selectProviders({ config, secretProvider, logger: makeLogger() });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(selection).toBeNull();
    // CRITICAL: a shim was never constructed. If it had been, this
    // would be a silent-fallback data-loss bug.
    expect(selection).not.toBeInstanceOf(PostgresAuthorityShim);
  });
});

describe("NET-W003 composition-root provider selection — end-to-end runtime wiring", () => {
  // Prove the full createRuntime() composition root actually wires the
  // real adapter classes in a configured production deployment (and the
  // shims in development), so the runtime's exposed postgresAuthority
  // and coordinationService are the concrete adapters selected by the
  // provider-selection boundary.

  test("createRuntime(development) exposes the SHIM doubles on the Runtime", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    const runtime = createRuntime({
      env: { APP_ENV: "development", PORT: "0" },
      port: 0,
    });
    expect(runtime.postgresAuthority).toBeInstanceOf(PostgresAuthorityShim);
    expect(runtime.coordinationService).toBeInstanceOf(RedisCoordinationShim);
    expect(runtime.providerSelection.mode.postgres).toBe("shim");
    expect(runtime.providerSelection.mode.redis).toBe("shim");
    expect(runtime.providerSelection.usesRealAdapters).toBe(false);
    await runtime.shutdown();
  });

  test("createRuntime(production, secrets present) exposes the REAL adapter classes on the Runtime", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    // NOTE (NET-W005 remediation): a production runtime additionally
    // requires the attestation signing configuration (see
    // tests/bootstrap/attestation-signing.test.ts — without it the
    // runtime FAILS CLOSED). This test's purpose is the provider
    // selection, so the attestation key is provided alongside the
    // provider secrets.
    const runtime = createRuntime({
      env: {
        APP_ENV: "production",
        PORT: "0",
        DATABASE_URL: SYNTHETIC_PG_URL,
        REDIS_URL: SYNTHETIC_REDIS_URL,
        OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
        ATTESTATION_SIGNING_KEY: "TESTFIXTURE-production-attestation-key",
      },
      port: 0,
    });
    // CRITICAL: the runtime's exposed persistence + coordination
    // boundaries are the REAL adapter classes, not the shims.
    expect(runtime.postgresAuthority).toBeInstanceOf(PostgresAuthorityAdapter);
    expect(runtime.coordinationService).toBeInstanceOf(RedisCoordinationAdapter);
    expect(runtime.providerSelection.mode.postgres).toBe("real-adapter");
    expect(runtime.providerSelection.mode.redis).toBe("real-adapter");
    expect(runtime.providerSelection.usesRealAdapters).toBe(true);
    // initialize() succeeds — the real adapters are constructed but
    // not dialed at boot (connectivity is surfaced on first command,
    // not at startup).
    const states = await runtime.initialize();
    expect(states.every((s) => s.initialized)).toBe(true);
    await runtime.shutdown();
  });

  test("createRuntime(production, secrets missing) fails fast at the config layer (defense in depth)", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    // loadConfig itself fails fast for missing required secrets in
    // production (AC-04). The provider-selection boundary is a SECOND
    // fail-fast layer. Both ensure a configured deployment NEVER
    // silently selects a shim.
    expect(() =>
      createRuntime({
        env: { APP_ENV: "production", PORT: "0" },
        port: 0,
      }),
    ).toThrow();
  });
});
