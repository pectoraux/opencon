/**
 * NET-W001-AC-04 — Configuration validation.
 *
 * Evidence: automated configuration tests.
 *
 * Invalid required environment/configuration prevents startup with a
 * classified validation error; valid development configuration starts
 * successfully.
 */

import { describe, test, expect } from "bun:test";
import { loadConfig } from "../../src/config/provider.ts";
import { ConfigurationValidationError, SecretAccessError } from "../../src/core/errors.ts";

describe("NET-W001-AC-04 configuration validation", () => {
  test("invalid PORT prevents startup with a classified validation error", () => {
    expect(() =>
      loadConfig({ source: { APP_ENV: "development", PORT: "not-a-number" } }),
    ).toThrow(ConfigurationValidationError);
  });

  test("invalid APP_ENV prevents startup with a classified validation error", () => {
    expect(() =>
      loadConfig({ source: { APP_ENV: "preprod", PORT: "1234" } }),
    ).toThrow(ConfigurationValidationError);
  });

  test("valid development configuration starts successfully", () => {
    const { provider, snapshot } = loadConfig({
      source: {
        APP_ENV: "development",
        APP_NAME: "opencon",
        PORT: "8787",
        LOG_LEVEL: "info",
      },
    });
    expect(snapshot.environment).toBe("development");
    expect(snapshot.appName).toBe("opencon");
    expect(snapshot.port).toBe(8787);
    expect(snapshot.logLevel).toBe("info");
    // Secrets absent in development are permitted (safe defaults).
    expect(provider.isSecret("DATABASE_URL")).toBe(true);
    const dbDescriptor = provider.describe().find((d) => d.key === "DATABASE_URL");
    expect(dbDescriptor!.hasValue).toBe(false);
    expect(dbDescriptor!.redactedPreview).toBe("<unset>");
  });

  test("production startup fails fast when required secrets are missing", () => {
    expect(() =>
      loadConfig({
        source: { APP_ENV: "production", PORT: "8787" },
      }),
    ).toThrow(ConfigurationValidationError);
  });

  test("production startup succeeds when required secrets are present", () => {
    const { snapshot } = loadConfig({
      source: {
        APP_ENV: "production",
        PORT: "8787",
        DATABASE_URL: "postgres://u:p@h:5432/opencon",
        REDIS_URL: "redis://h:6379",
        OBJECT_STORAGE_BUCKET: "opencon-prod",
      },
    });
    expect(snapshot.environment).toBe("production");
  });

  test("the full runtime boots from valid development config", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    const runtime = createRuntime({
      env: { APP_ENV: "development", PORT: "0" },
      port: 0,
    });
    const states = await runtime.initialize();
    expect(states.length).toBe(31);
    expect(states.every((s) => s.initialized)).toBe(true);
    await runtime.api.start();
    expect(runtime.api.port).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  test("the full runtime fails fast from invalid config", async () => {
    const { createRuntime } = await import("../../src/bootstrap/runtime.ts");
    expect(() =>
      createRuntime({ env: { APP_ENV: "development", PORT: "NaN" } }),
    ).toThrow(ConfigurationValidationError);
  });

  test("configuration snapshot is frozen and immutable", () => {
    const { snapshot } = loadConfig({
      source: { APP_ENV: "development" },
    });
    expect(() => {
      (snapshot as { port: number }).port = 99999;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Secrets boundary regression (architect review on PR #2, remediation #2).
// The ConfigurationProvider MUST NOT be a source of secret material.
// Secret values are resolved exclusively through the SecretProvider;
// get() throws for secret keys and getSecretReference() returns an opaque
// reference that never carries the value.
// ---------------------------------------------------------------------------

describe("NET-W001-AC-04 configuration secrets boundary", () => {
  // NOTE: these are SYNTHETIC test-fixture values, NOT real credentials.
  // They are deliberately distinctive so the test can assert they never
  // leak through the ConfigurationProvider's redacted surface. The
  // values are chosen to look obviously fake (no real host/credential
  // shape) so they cannot be mistaken for real secrets by a scanner.
  const SECRET_SOURCE = {
    APP_ENV: "development",
    APP_NAME: "opencon",
    PORT: "8787",
    DATABASE_URL: "TESTFIXTURE-db-cred-value-AAA",
    REDIS_URL: "TESTFIXTURE-redis-cred-value-BBB",
    OBJECT_STORAGE_BUCKET: "TESTFIXTURE-bucket-cred-value-CCC",
  } as const;
  const SECRET_VALUE_TOKENS = [
    "TESTFIXTURE-db-cred-value-AAA",
    "TESTFIXTURE-redis-cred-value-BBB",
    "TESTFIXTURE-bucket-cred-value-CCC",
  ];

  function load() {
    return loadConfig({ source: SECRET_SOURCE }).provider;
  }

  test("get() throws SecretAccessError for every classified secret key", () => {
    const provider = load();
    for (const key of ["DATABASE_URL", "REDIS_URL", "OBJECT_STORAGE_BUCKET"] as const) {
      expect(() => provider.get(key)).toThrow(SecretAccessError);
      const err = (() => {
        try {
          provider.get(key);
        } catch (e) {
          return e as SecretAccessError;
        }
        return null;
      })();
      expect(err).not.toBeNull();
      expect(err!.code).toBe("SECRET_ACCESS");
      expect(err!.classification).toBe("invariant");
      expect(err!.retryable).toBe(false);
    }
  });

  test("get() still returns non-secret values (boundary is scoped to secrets)", () => {
    const provider = load();
    const appName: string = provider.get<string>("APP_NAME");
    const port: number = provider.get<number>("PORT");
    expect(appName).toBe("opencon");
    expect(port).toBe(8787);
  });

  test("get() throws for unknown keys (unchanged contract)", () => {
    const provider = load();
    expect(() => provider.get("DOES_NOT_EXIST")).toThrow(ConfigurationValidationError);
  });

  test("getSecretReference() returns an opaque reference that NEVER carries the value", () => {
    const provider = load();
    const ref = provider.getSecretReference("DATABASE_URL");
    // Reference shape: key + redacted diagnostics only.
    expect(ref.key).toBe("DATABASE_URL");
    expect(ref.hasValue).toBe(true);
    expect(ref.redactedPreview).toBe("<present:DATABASE_URL>");
    // The reference object itself is immutable.
    expect(() => {
      (ref as { key: string }).key = "tampered";
    }).toThrow();
    // CRITICAL: no reachable property of the reference leaks the value.
    const serialized = JSON.stringify(ref);
    for (const token of SECRET_VALUE_TOKENS) {
      expect(serialized).not.toContain(token);
    }
  });

  test("getSecretReference() for an absent secret reports hasValue=false and never leaks", () => {
    const { provider } = loadConfig({
      source: { APP_ENV: "development" },
    });
    const ref = provider.getSecretReference("DATABASE_URL");
    expect(ref.hasValue).toBe(false);
    expect(ref.redactedPreview).toBe("<unset>");
  });

  test("getSecretReference() rejects non-secret keys (only secrets yield references)", () => {
    const provider = load();
    expect(() => provider.getSecretReference("APP_NAME")).toThrow(SecretAccessError);
  });

  test("getSecretReference() throws for unknown keys", () => {
    const provider = load();
    expect(() => provider.getSecretReference("DOES_NOT_EXIST")).toThrow(ConfigurationValidationError);
  });

  test("isSecret() classifies secrets and only secrets", () => {
    const provider = load();
    expect(provider.isSecret("DATABASE_URL")).toBe(true);
    expect(provider.isSecret("REDIS_URL")).toBe(true);
    expect(provider.isSecret("OBJECT_STORAGE_BUCKET")).toBe(true);
    expect(provider.isSecret("APP_NAME")).toBe(false);
    expect(provider.isSecret("PORT")).toBe(false);
    expect(provider.isSecret("APP_ENV")).toBe(false);
  });

  test("describe() never leaks secret values through redactedPreview", () => {
    const provider = load();
    const serialized = JSON.stringify(provider.describe());
    for (const token of SECRET_VALUE_TOKENS) {
      expect(serialized).not.toContain(token);
    }
  });
});

