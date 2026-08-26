/**
 * NET-W005 remediation (architect review on PR #10) — production
 * attestation signing FAILS CLOSED.
 *
 * The previous runtime wiring permitted the well-known
 * `dev-insecure-attestation-key` fallback outside test environments
 * (and — because it read a field the configuration snapshot never
 * carried — the fallback was effectively unconditional: even a
 * configured ATTESTATION_SIGNING_KEY was ignored).
 *
 * These are COMPOSITION-ROOT tests (the same pattern as
 * tests/bootstrap/provider-selection.test.ts). They prove:
 *  - production/staging WITHOUT the ATTESTATION_SIGNING_KEY secret and
 *    WITHOUT explicit signer/verifier adapters FAILS STARTUP
 *    (ProviderConfigurationError) — never the dev default;
 *  - the well-known dev literal is REJECTED as a production key;
 *  - the key is resolved THROUGH the SecretProvider (not env);
 *  - an explicit signer/verifier adapter PAIR satisfies production
 *    (and partial wiring is rejected in every environment);
 *  - development/test keep the dev default (warned in development,
 *    silent in test);
 *  - the full createRuntime() composition root enforces all of this.
 */

import { describe, test, expect } from "bun:test";
import { createEnvSecretProvider } from "../../src/secrets/env-provider.ts";
import { createLogger, type LogEntrySink } from "../../src/observability/logger.ts";
import {
  selectAttestationSigning,
  ATTESTATION_SIGNING_SECRET_KEY,
  type AttestationSigningSelection,
} from "../../src/bootstrap/attestation-signing.ts";
import {
  createHmacAttestationSignerVerifier,
  DEV_INSECURE_ATTESTATION_KEY,
  HMAC_ATTESTATION_ALGORITHM,
} from "../../src/evidence/hmac-attestation-verifier.ts";
import { buildAttestationDigestInput } from "../../src/evidence/attestation-service.ts";
import { ProviderConfigurationError } from "../../src/core/errors.ts";
import { SecretNotFoundError } from "../../src/core/secrets.ts";
import type { SecretProvider } from "../../src/core/secrets.ts";
import type { Logger } from "../../src/core/logger.ts";
import type { AttestationSigner, AttestationVerifier } from "../../src/evidence/port.ts";

function makeLogger(collector: LogEntrySink = { entries: [] }): Logger {
  return createLogger({
    module: "attestation-signing-test",
    minLevel: "trace",
    pretty: false,
    collector,
  });
}

/**
 * An env-backed SecretProvider for the attestation key (the same
 * env-provider the composition root uses, built directly — the
 * selector consumes only the SecretProvider, never the config
 * provider, and loadConfig would enforce the OTHER production-required
 * secrets which are irrelevant here).
 */
function makeEnvSecretProvider(env: NodeJS.ProcessEnv): SecretProvider {
  return createEnvSecretProvider({
    source: env,
    catalog: [
      {
        key: ATTESTATION_SIGNING_SECRET_KEY,
        required: false,
        hasValue: Boolean(env[ATTESTATION_SIGNING_SECRET_KEY]),
        redactedPreview: `<secret:${ATTESTATION_SIGNING_SECRET_KEY}>`,
      },
    ],
  });
}

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

const CANONICAL = buildAttestationDigestInput("test statement", "verifier-1", [
  { evidenceId: "ev-1", digest: "d1" },
]);

describe("attestation signing selection — development/test", () => {
  test("development WITHOUT a configured key selects the dev default and WARNS", () => {
    const collector: LogEntrySink = { entries: [] };
    const selection = selectAttestationSigning({
      environment: "development",
      secretProvider: makeEnvSecretProvider({ APP_ENV: "development" }),
      logger: makeLogger(collector),
    });
    expect(selection.mode).toBe("dev-default");
    const warned = collector.entries.find(
      (e) => e.message === "attestation.signing_key_fallback",
    );
    expect(warned).toBeTruthy();
  });

  test("test WITHOUT a configured key selects the dev default SILENTLY (no warning noise)", () => {
    const collector: LogEntrySink = { entries: [] };
    const selection = selectAttestationSigning({
      environment: "test",
      secretProvider: makeEnvSecretProvider({ APP_ENV: "test" }),
      logger: makeLogger(collector),
    });
    expect(selection.mode).toBe("dev-default");
    expect(
      collector.entries.find((e) => e.message === "attestation.signing_key_fallback"),
    ).toBeUndefined();
  });

  test("development/test WITH a configured key honours it (configured-secret)", async () => {
    for (const environment of ["development", "test"] as const) {
      const selection = selectAttestationSigning({
        environment,
        secretProvider: makeEnvSecretProvider({
          APP_ENV: environment,
          ATTESTATION_SIGNING_KEY: "dev-configured-strong-key",
        }),
        logger: makeLogger(),
      });
      expect(selection.mode).toBe("configured-secret");
      // Roundtrip: sign + verify with the SELECTED pair works.
      const signed = await selection.signer.sign(CANONICAL);
      expect(signed.algorithm).toBe(HMAC_ATTESTATION_ALGORITHM);
      const decision = await selection.verifier.verify(CANONICAL, signed);
      expect(decision.valid).toBe(true);
      // And a signature from a DIFFERENT key does NOT verify.
      const other = createHmacAttestationSignerVerifier({ key: "a-different-key" });
      const otherSigned = await other.sign(CANONICAL);
      const rejected = await selection.verifier.verify(CANONICAL, otherSigned);
      expect(rejected.valid).toBe(false);
    }
  });
});

describe("attestation signing selection — configured production/staging (FAIL CLOSED)", () => {
  test("PRODUCTION without the secret and without explicit adapters FAILS FAST (ProviderConfigurationError)", () => {
    expect(() =>
      selectAttestationSigning({
        environment: "production",
        secretProvider: makeFailingSecretProvider(new Set([ATTESTATION_SIGNING_SECRET_KEY])),
        logger: makeLogger(),
      }),
    ).toThrow(ProviderConfigurationError);
  });

  test("STAGING without the secret and without explicit adapters FAILS FAST", () => {
    expect(() =>
      selectAttestationSigning({
        environment: "staging",
        secretProvider: makeFailingSecretProvider(new Set([ATTESTATION_SIGNING_SECRET_KEY])),
        logger: makeLogger(),
      }),
    ).toThrow(ProviderConfigurationError);
  });

  test("the error names the provider, secret key, and environment (operator-actionable)", () => {
    let caught: ProviderConfigurationError | null = null;
    try {
      selectAttestationSigning({
        environment: "production",
        secretProvider: makeFailingSecretProvider(new Set([ATTESTATION_SIGNING_SECRET_KEY])),
        logger: makeLogger(),
      });
    } catch (e) {
      caught = e as ProviderConfigurationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("PROVIDER_CONFIGURATION");
    expect(caught!.classification).toBe("validation");
    expect(caught!.retryable).toBe(false);
    expect(caught!.context.provider).toBe("attestation");
    expect(caught!.context.secretKey).toBe(ATTESTATION_SIGNING_SECRET_KEY);
    expect(caught!.context.environment).toBe("production");
    expect(caught!.message).toMatch(/MUST NOT silently fall back/i);
  });

  test("the error cause is the original SecretNotFoundError (debuggable chain)", () => {
    let caught: ProviderConfigurationError | null = null;
    try {
      selectAttestationSigning({
        environment: "production",
        secretProvider: makeFailingSecretProvider(new Set([ATTESTATION_SIGNING_SECRET_KEY])),
        logger: makeLogger(),
      });
    } catch (e) {
      caught = e as ProviderConfigurationError;
    }
    expect(caught!.cause).toBeInstanceOf(SecretNotFoundError);
  });

  test("PRODUCTION resolves the key THROUGH the SecretProvider (spy proves it — not env)", () => {
    const calls: string[] = [];
    const spySecretProvider: SecretProvider = {
      async getSecret(key: string) {
        calls.push(key);
        return "spied-production-key";
      },
      getSecretSync(key: string): string {
        calls.push(key);
        return "spied-production-key";
      },
      describe: () => [],
      hasSecret: () => true,
    };
    const selection = selectAttestationSigning({
      environment: "production",
      secretProvider: spySecretProvider,
      logger: makeLogger(),
    });
    expect(calls).toContain(ATTESTATION_SIGNING_SECRET_KEY);
    expect(selection.mode).toBe("configured-secret");
  });

  test("the WELL-KNOWN dev literal is REJECTED as a production key (public knowledge is not a secret)", () => {
    expect(() =>
      selectAttestationSigning({
        environment: "production",
        secretProvider: makeEnvSecretProvider({
          APP_ENV: "production",
          ATTESTATION_SIGNING_KEY: DEV_INSECURE_ATTESTATION_KEY,
        }),
        logger: makeLogger(),
      }),
    ).toThrow(/well-known insecure development literal/i);
    expect(() =>
      selectAttestationSigning({
        environment: "staging",
        secretProvider: makeEnvSecretProvider({
          APP_ENV: "staging",
          ATTESTATION_SIGNING_KEY: DEV_INSECURE_ATTESTATION_KEY,
        }),
        logger: makeLogger(),
      }),
    ).toThrow(ProviderConfigurationError);
  });

  test("PRODUCTION with a configured strong key selects configured-secret and the pair verifies", async () => {
    const selection = selectAttestationSigning({
      environment: "production",
      secretProvider: makeEnvSecretProvider({
        APP_ENV: "production",
        ATTESTATION_SIGNING_KEY: "TESTFIXTURE-production-attestation-key",
      }),
      logger: makeLogger(),
    });
    expect(selection.mode).toBe("configured-secret");
    const signed = await selection.signer.sign(CANONICAL);
    const decision = await selection.verifier.verify(CANONICAL, signed);
    expect(decision.valid).toBe(true);
    // The dev default key's signatures do NOT verify against the
    // production-configured key.
    const devSigned = await createHmacAttestationSignerVerifier({
      key: DEV_INSECURE_ATTESTATION_KEY,
    }).sign(CANONICAL);
    const devDecision = await selection.verifier.verify(CANONICAL, devSigned);
    expect(devDecision.valid).toBe(false);
  });
});

describe("attestation signing selection — explicit production adapters", () => {
  function makeExplicitPair(): AttestationSigner & AttestationVerifier {
    return createHmacAttestationSignerVerifier({ key: "explicit-adapter-key" });
  }

  test("an explicit signer/verifier PAIR is selected in production (no secret required)", () => {
    const pair = makeExplicitPair();
    const selection = selectAttestationSigning({
      environment: "production",
      secretProvider: makeFailingSecretProvider(new Set([ATTESTATION_SIGNING_SECRET_KEY])),
      logger: makeLogger(),
      attestation: { signer: pair, verifier: pair },
    });
    expect(selection.mode).toBe("explicit-adapters");
    expect(selection.signer).toBe(pair);
    expect(selection.verifier).toBe(pair);
  });

  test("an explicit pair takes precedence over a configured secret in EVERY environment", () => {
    const pair = makeExplicitPair();
    const selection = selectAttestationSigning({
      environment: "test",
      secretProvider: makeEnvSecretProvider({
        APP_ENV: "test",
        ATTESTATION_SIGNING_KEY: "configured-but-overridden",
      }),
      logger: makeLogger(),
      attestation: { signer: pair, verifier: pair },
    });
    expect(selection.mode).toBe("explicit-adapters");
  });

  test("PARTIAL wiring (signer without verifier) is rejected in EVERY environment (fail closed)", () => {
    const pair = makeExplicitPair();
    for (const environment of ["development", "test", "staging", "production"] as const) {
      expect(() =>
        selectAttestationSigning({
          environment,
          secretProvider: makeEnvSecretProvider({ APP_ENV: environment }),
          logger: makeLogger(),
          attestation: { signer: pair },
        }),
      ).toThrow(/must be configured as a PAIR/i);
      expect(() =>
        selectAttestationSigning({
          environment,
          secretProvider: makeEnvSecretProvider({ APP_ENV: environment }),
          logger: makeLogger(),
          attestation: { verifier: pair },
        }),
      ).toThrow(ProviderConfigurationError);
    }
  });
});

describe("attestation signing selection — end-to-end runtime wiring", () => {
  // SYNTHETIC test-fixture values — NOT real credentials (the same
  // convention as provider-selection tests). The runtime is constructed
  // but the real adapters are never dialed.
  const SYNTHETIC_PG_URL =
    "postgres://TESTFIXTURE-user:TESTFIXTURE-pass@TESTFIXTURE-host-127:5432/TESTFIXTURE-db";
  const SYNTHETIC_REDIS_URL = "redis://TESTFIXTURE-redis-host-127:6379/0";

  test("createRuntime(production, provider secrets present, NO attestation key/adapters) FAILS STARTUP", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    let caught: unknown = null;
    try {
      createRuntime({
        env: {
          APP_ENV: "production",
          PORT: "0",
          DATABASE_URL: SYNTHETIC_PG_URL,
          REDIS_URL: SYNTHETIC_REDIS_URL,
          OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
        },
        port: 0,
      });
    } catch (err) {
      caught = err;
    }
    // CRITICAL: this exact configuration previously booted with the
    // well-known insecure development key (with only a warning). It
    // must now fail closed.
    expect(caught).toBeInstanceOf(ProviderConfigurationError);
    expect((caught as ProviderConfigurationError).context.provider).toBe("attestation");
    expect((caught as ProviderConfigurationError).context.secretKey).toBe(
      ATTESTATION_SIGNING_SECRET_KEY,
    );
  });

  test("createRuntime(production, provider secrets + ATTESTATION_SIGNING_KEY) BOOTS with the configured secret", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
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
    expect(runtime.attestationSigning.mode).toBe("configured-secret");
    await runtime.shutdown();
  });

  test("createRuntime(production, provider secrets + explicit adapter pair) BOOTS with the explicit adapters", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    const pair = createHmacAttestationSignerVerifier({ key: "explicit-runtime-pair-key" });
    const runtime = createRuntime({
      env: {
        APP_ENV: "production",
        PORT: "0",
        DATABASE_URL: SYNTHETIC_PG_URL,
        REDIS_URL: SYNTHETIC_REDIS_URL,
        OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket",
      },
      port: 0,
      attestation: { signer: pair, verifier: pair },
    });
    expect(runtime.attestationSigning.mode).toBe("explicit-adapters");
    await runtime.shutdown();
  });

  test("createRuntime(test, nothing configured) keeps the dev default (existing harness behaviour preserved)", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    const runtime = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "warn" },
      port: 0,
    });
    expect(runtime.attestationSigning.mode).toBe("dev-default");
    await runtime.shutdown();
  });
});
