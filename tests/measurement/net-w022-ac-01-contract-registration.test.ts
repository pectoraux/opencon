/**
 * NET-W022-AC-01 — Neutral adapter contract + provider registration
 * boundary (issue #44 scope 1).
 *
 * The neutral measurement adapter contract is completed/strengthened
 * additively: the optional normalizeReport surface, the closed
 * rejection-reason vocabulary, the provider registry (one adapter per
 * provider identity, duplicates fail closed), the ingestion routing
 * (unknown providers fail closed), and the composition-root wiring
 * (default runtime unchanged; reference adapters auto-wired from
 * their secrets; echo untouched).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW022Harness,
  browserRawReport,
  type NetW022Harness,
} from "./_net-w022-harness.ts";
import {
  MEASUREMENT_REPORT_REJECTION_REASONS,
  UnknownMeasurementProviderError,
  MeasurementReportRejectedError,
  isMeasurementReportRejectionReason,
} from "../../src/measurement/port.ts";
import type { MeasurementProviderAdapter } from "../../src/measurement/port.ts";
import { createMeasurementProviderRegistry } from "../../src/measurement/registry.ts";
import { createMeasurementIngestionService } from "../../src/measurement/ingestion.ts";
import { echoMeasurementProvider } from "../../src/measurement/providers/echo-measurement-provider.ts";
import { BrowserAttributionAdapter } from "../../src/measurement/providers/browser-attribution-adapter.ts";
import { IOSAttributionAdapter } from "../../src/measurement/providers/ios-attribution-adapter.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import { createLogger } from "../../src/observability/logger.ts";

const CLOSED_REASONS = [
  "malformed_report",
  "unsupported_attribution_mode",
  "invalid_attribution_mode",
  "missing_provenance",
  "ambiguous_subject_mapping",
  "unverifiable_integrity",
  "unsupported_push_ingestion",
] as const;

describe("NET-W022-AC-01 neutral contract + registration boundary", () => {
  let harness: NetW022Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("the rejection-reason vocabulary is CLOSED and pinned", () => {
    expect([...MEASUREMENT_REPORT_REJECTION_REASONS]).toEqual([...CLOSED_REASONS]);
    for (const reason of CLOSED_REASONS) {
      expect(isMeasurementReportRejectionReason(reason)).toBe(true);
    }
    expect(isMeasurementReportRejectionReason("some-new-reason")).toBe(false);
    expect(isMeasurementReportRejectionReason("")).toBe(false);
  });

  test("the registry registers adapters once per provider identity and FAILS CLOSED on duplicates/invalid identity", () => {
    const registry = createMeasurementProviderRegistry();
    const browser = new BrowserAttributionAdapter({ verificationSecret: "k" });
    const ios = new IOSAttributionAdapter({ verificationSecret: "k" });
    registry.register(browser);
    registry.register(ios);
    expect(registry.list().map((a) => a.info.provider).sort()).toEqual([
      "browser-attribution",
      "ios-attribution",
    ]);
    expect(registry.byProviderId("browser-attribution")).toBe(browser);
    // Duplicate provider identity fails closed.
    expect(() => registry.register(new BrowserAttributionAdapter({ verificationSecret: "k2" }))).toThrow(
      /already registered/,
    );
    // Invalid identity fails closed.
    expect(() =>
      registry.register({
        info: { kind: "payment" as "measurement", provider: "x", version: "1" },
        initialize: async () => {},
        healthCheck: async () => ({ ok: true }),
        fetchObservations: async () => ({ observations: [], nextCursor: null }),
      }),
    ).toThrow(/info.kind must be "measurement"/);
    expect(() =>
      registry.register({
        info: { kind: "measurement", provider: "", version: "1" },
        initialize: async () => {},
        healthCheck: async () => ({ ok: true }),
        fetchObservations: async () => ({ observations: [], nextCursor: null }),
      }),
    ).toThrow(/info.provider must be a non-empty string/);
  });

  test("the ingestion service routes by provider id and fails CLOSED on unknown providers", async () => {
    const registry = createMeasurementProviderRegistry();
    registry.register(new BrowserAttributionAdapter({ verificationSecret: "k" }));
    const silentLogger = createLogger({ module: "test", minLevel: "fatal", pretty: false });
    const ingestion = createMeasurementIngestionService({ registry, logger: silentLogger });
    await expect(
      ingestion.normalizeSubmission({ providerId: "not-registered", payload: browserRawReport() }),
    ).rejects.toBeInstanceOf(UnknownMeasurementProviderError);
    await expect(
      ingestion.normalizeSubmission({ providerId: "", payload: browserRawReport() }),
    ).rejects.toBeInstanceOf(UnknownMeasurementProviderError);
  });

  test("push-less adapters fail CLOSED with unsupported_push_ingestion (echo + W006 pull stubs)", async () => {
    const registry = createMeasurementProviderRegistry();
    registry.register(echoMeasurementProvider);
    const silentLogger = createLogger({ module: "test", minLevel: "fatal", pretty: false });
    const ingestion = createMeasurementIngestionService({ registry, logger: silentLogger });
    let caught: unknown;
    try {
      await ingestion.normalizeSubmission({ providerId: "echo", payload: {} });
      throw new Error("expected rejection");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeasurementReportRejectedError);
    expect((caught as MeasurementReportRejectedError).reason).toBe("unsupported_push_ingestion");
    expect((caught as MeasurementReportRejectedError).code).toBe("MEASUREMENT_REPORT_REJECTED");
    // The echo adapter itself is UNCHANGED (no normalizeReport — the
    // W006 pull contract compiles untouched).
    expect(
      (echoMeasurementProvider as MeasurementProviderAdapter).normalizeReport,
    ).toBeUndefined();
    expect(echoMeasurementProvider.info.provider).toBe("echo");
  });

  test("the default runtime is UNCHANGED: echo-only providers (the W006 default), registry + ingestion exposed", async () => {
    const defaultRuntime = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await defaultRuntime.initialize();
    try {
      expect(defaultRuntime.measurementProviders.length).toBe(1);
      expect(defaultRuntime.measurementProviders[0]!.info.provider).toBe("echo");
      // The registry is populated with exactly the wired providers and
      // the ingestion service is the routing boundary.
      expect(defaultRuntime.measurementIngestion).toBeDefined();
      await expect(
        defaultRuntime.measurementIngestion.normalizeSubmission({
          providerId: "browser-attribution",
          payload: browserRawReport(),
        }),
      ).rejects.toBeInstanceOf(UnknownMeasurementProviderError);
    } finally {
      await defaultRuntime.shutdown();
    }
  });

  test("reference adapters auto-wire from their SECRETProvider keys (composition root)", async () => {
    const runtime = createRuntime({
      forceEnv: "test",
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "fatal",
        MEASUREMENT_BROWSER_ATTRIBUTION_KEY: "browser-secret-from-env",
        MEASUREMENT_IOS_ATTRIBUTION_KEY: "ios-secret-from-env",
      },
      port: 0,
    });
    await runtime.initialize();
    try {
      expect(runtime.measurementProviders.map((a) => a.info.provider)).toEqual([
        "echo",
        "browser-attribution",
        "ios-attribution",
      ]);
      // Auto-wired from the env secret: a report signed with the env
      // key normalizes; a report signed with a DIFFERENT key fails
      // closed (unverifiable integrity).
      const { computeReportSignature } = await import(
        "../../src/measurement/providers/report-integrity.ts"
      );
      const body: Record<string, unknown> = {
        reportId: "r1",
        sourceEventId: "s1",
        destination: "https://d.example",
        subjectRefs: ["subj-1"],
        outcomeType: "install",
        observedValue: { value: 1, unit: "installs" },
        confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
        attributionMode: "probabilistic",
        method: "m",
        methodVersion: "1.0.0",
        collectedAt: "2026-08-24T12:00:00.000Z",
      };
      const good = {
        ...body,
        integrity: {
          algorithm: "hmac-sha256",
          signature: computeReportSignature(body, "browser-secret-from-env"),
          signedAt: "2026-09-01T00:00:00.000Z",
        },
      };
      const bad = {
        ...body,
        integrity: {
          algorithm: "hmac-sha256",
          signature: computeReportSignature(body, "WRONG-KEY"),
          signedAt: "2026-09-01T00:00:00.000Z",
        },
      };
      const normalized = await runtime.measurementIngestion.normalizeSubmission({
        providerId: "browser-attribution",
        payload: good,
      });
      expect(normalized.providerVersion).toBe("1.0.0");
      expect(normalized.report.providerId).toBe("browser-attribution");
      let caught: unknown;
      try {
        await runtime.measurementIngestion.normalizeSubmission({
          providerId: "browser-attribution",
          payload: bad,
        });
        throw new Error("expected rejection");
      } catch (err) {
        caught = err;
      }
      expect((caught as MeasurementReportRejectedError).reason).toBe("unverifiable_integrity");
    } finally {
      await runtime.shutdown();
    }
  });

  test("the composed runtime registers the reference adapters exactly once (the harness wiring)", async () => {
    harness = await createNetW022Harness();
    expect(harness.runtime.measurementProviders.map((a) => a.info.provider)).toEqual([
      "browser-attribution",
      "ios-attribution",
    ]);
    expect(harness.runtime.measurementIngestion).toBeDefined();
    const health = await harness.runtime.measurementIngestion.checkHealth();
    expect(health.map((h) => h.provider).sort()).toEqual(["browser-attribution", "ios-attribution"]);
    for (const entry of health) {
      expect(entry.ok).toBe(true);
    }
    // Push-only adapters: the pull surface reports nothing (the W006
    // pull contract still compiles + behaves).
    const pull = await harness.browserAdapter.fetchObservations({
      subjectId: "any",
      subjectType: "contribution",
    });
    expect(pull.observations).toEqual([]);
    expect(pull.nextCursor).toBeNull();
  });

  test("an adapter without a configured secret fails health + reports fail closed", async () => {
    const secretless = new BrowserAttributionAdapter({ verificationSecret: undefined });
    const health = await secretless.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/no verification secret/);
    let caught: unknown;
    try {
      await secretless.normalizeReport({ providerId: "browser-attribution", payload: browserRawReport() });
      throw new Error("expected rejection");
    } catch (err) {
      caught = err;
    }
    expect((caught as MeasurementReportRejectedError).reason).toBe("unverifiable_integrity");
  });
});
