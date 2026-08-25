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
import { ConfigurationValidationError } from "../../src/core/errors.ts";

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
