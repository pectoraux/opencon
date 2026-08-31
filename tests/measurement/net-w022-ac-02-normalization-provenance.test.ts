/**
 * NET-W022-AC-02 — Deterministic normalization with explicit
 * provenance, method and method-version data (issue #44 scopes 2-3:
 * provider-neutral reference adapters + canonical observations with
 * provenance).
 *
 * Platform measurements arrive as normalized evidence: the raw vendor
 * report is reduced to the frozen neutral contract with FULL
 * method/version/collectedAt provenance, the provider id as source
 * identity, and the unambiguous provider-side subject reference.
 * Normalization is deterministic (same payload + key ⇒ identical
 * report) and preserves uncertainty (confidence with interval).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW022Harness,
  browserRawReport,
  iosRawPostback,
  submitReport,
  createSubject,
  BROWSER_TEST_SECRET,
  IOS_TEST_SECRET,
  type NetW022Harness,
} from "./_net-w022-harness.ts";
import { BrowserAttributionAdapter } from "../../src/measurement/providers/browser-attribution-adapter.ts";
import { IOSAttributionAdapter } from "../../src/measurement/providers/ios-attribution-adapter.ts";

describe("NET-W022-AC-02 deterministic normalization + provenance", () => {
  let harness: NetW022Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("a browser attribution report normalizes into the NEUTRAL contract with full provenance", async () => {
    const adapter = new BrowserAttributionAdapter({ verificationSecret: BROWSER_TEST_SECRET });
    const raw = browserRawReport();
    const { report } = await adapter.normalizeReport({
      providerId: "browser-attribution",
      payload: raw,
    });
    // ONLY the neutral contract fields cross — exact shape pin.
    expect(Object.keys(report).sort()).toEqual([
      "attributionMode",
      "collectedAt",
      "confidence",
      "externalSubjectRef",
      "method",
      "methodVersion",
      "observedValue",
      "outcomeType",
      "providerId",
    ]);
    expect(report.providerId).toBe("browser-attribution");
    expect(report.externalSubjectRef).toBe("ext-browser-subject-42");
    expect(report.outcomeType).toBe("install");
    expect(report.observedValue).toEqual({ value: 18, unit: "installs" });
    expect(report.confidence).toEqual({ point: 0.9, lower: 0.85, upper: 0.95 });
    expect(report.method).toBe("browser-attribution-model");
    expect(report.methodVersion).toBe("3.1.0");
    expect(report.collectedAt).toBe("2026-08-24T12:00:00.000Z");
    expect(report.attributionMode).toBe("probabilistic");
  });

  test("an iOS attribution postback normalizes into the SAME neutral contract", async () => {
    const adapter = new IOSAttributionAdapter({ verificationSecret: IOS_TEST_SECRET });
    const raw = iosRawPostback();
    const { report } = await adapter.normalizeReport({
      providerId: "ios-attribution",
      payload: raw,
    });
    expect(Object.keys(report).sort()).toEqual([
      "attributionMode",
      "collectedAt",
      "confidence",
      "externalSubjectRef",
      "method",
      "methodVersion",
      "observedValue",
      "outcomeType",
      "providerId",
    ]);
    expect(report.providerId).toBe("ios-attribution");
    expect(report.externalSubjectRef).toBe("ext-ios-subject-99");
    expect(report.outcomeType).toBe("purchase");
    expect(report.observedValue).toEqual({ value: 3, unit: "purchases" });
    expect(report.method).toBe("ios-attribution-record");
    expect(report.methodVersion).toBe("2.4.0");
    expect(report.attributionMode).toBe("deterministic");
  });

  test("normalization is DETERMINISTIC: the same payload + key ⇒ the identical report (repeated + fresh adapter)", async () => {
    const adapter = new BrowserAttributionAdapter({ verificationSecret: BROWSER_TEST_SECRET });
    const raw = browserRawReport();
    const first = await adapter.normalizeReport({ providerId: "browser-attribution", payload: raw });
    const second = await adapter.normalizeReport({ providerId: "browser-attribution", payload: raw });
    const freshAdapter = new BrowserAttributionAdapter({ verificationSecret: BROWSER_TEST_SECRET });
    const third = await freshAdapter.normalizeReport({ providerId: "browser-attribution", payload: raw });
    expect(second.report).toEqual(first.report);
    expect(third.report).toEqual(first.report);
    expect(second.redactedFieldNames).toEqual(first.redactedFieldNames);
    // A DIFFERENT payload (field-order shuffled only) still normalizes
    // identically — canonical signing is key-sorted, not order-sensitive.
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort().reverse()) {
      reordered[key] = raw[key];
    }
    const fourth = await adapter.normalizeReport({ providerId: "browser-attribution", payload: reordered });
    expect(fourth.report).toEqual(first.report);
  });

  test("the provider id on the neutral report is enforced against SPOOFING (identity integrity)", async () => {
    // A mis-implemented adapter claiming another provider's identity
    // is rejected at the ingestion boundary (fail closed).
    const { createMeasurementProviderRegistry } = await import("../../src/measurement/registry.ts");
    const { createMeasurementIngestionService } = await import("../../src/measurement/ingestion.ts");
    const { createLogger } = await import("../../src/observability/logger.ts");
    const spoofingAdapter = {
      info: { kind: "measurement" as const, provider: "spoofing-provider", version: "1.0.0" },
      initialize: async () => {},
      healthCheck: async () => ({ ok: true }) as { ok: boolean; detail?: string },
      fetchObservations: async () => ({ observations: [], nextCursor: null }),
      normalizeReport: async () => ({
        // biome-ignore lint/suspicious/noExplicitAny: test double (deliberately claims another provider's identity)
        report: {
          providerId: "browser-attribution", // CLAIMS ANOTHER IDENTITY
          externalSubjectRef: "x",
          outcomeType: "install",
          observedValue: { value: 1, unit: "installs" },
          confidence: { point: 0.9 },
          method: "m",
          methodVersion: "1",
          collectedAt: "2026-01-01T00:00:00.000Z",
        } as any,
        redactedFieldNames: [],
      }),
    };
    const registry = createMeasurementProviderRegistry();
    registry.register(spoofingAdapter);
    const ingestion = createMeasurementIngestionService({
        registry,
        logger: createLogger({ module: "test", minLevel: "fatal", pretty: false }),
      });
    let caught: unknown;
    try {
      await ingestion.normalizeSubmission({ providerId: "spoofing-provider", payload: {} });
      throw new Error("expected rejection");
    } catch (err) {
      caught = err;
    }
    const { MeasurementReportRejectedError } = await import("../../src/measurement/port.ts");
    expect(caught).toBeInstanceOf(MeasurementReportRejectedError);
    expect((caught as InstanceType<typeof MeasurementReportRejectedError>).reason).toBe("malformed_report");
    expect((caught as Error).message).toMatch(/claims provider id/);
  });

  test("an adapter output violating the NEUTRAL contract is rejected at the boundary (fail closed)", async () => {
    const { createMeasurementProviderRegistry } = await import("../../src/measurement/registry.ts");
    const { createMeasurementIngestionService } = await import("../../src/measurement/ingestion.ts");
    const { createLogger } = await import("../../src/observability/logger.ts");
    const { MeasurementReportRejectedError } = await import("../../src/measurement/port.ts");
    const baseReport = {
      providerId: "bad-output-provider",
      externalSubjectRef: "x",
      outcomeType: "install",
      observedValue: { value: 1, unit: "installs" },
      confidence: { point: 0.9 },
      method: "m",
      methodVersion: "1",
      collectedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const [label, report] of [
      ["non-standard outcome type", { ...baseReport, outcomeType: "made-up" }],
      ["missing methodVersion", { ...baseReport, methodVersion: "" }],
      ["missing collectedAt", { ...baseReport, collectedAt: "" }],
      ["empty subject ref", { ...baseReport, externalSubjectRef: "" }],
      ["negative observed value", { ...baseReport, observedValue: { value: -1, unit: "u" } }],
    ] as const) {
      const registry = createMeasurementProviderRegistry();
      registry.register({
        info: { kind: "measurement" as const, provider: "bad-output-provider", version: "1.0.0" },
        initialize: async () => {},
        healthCheck: async () => ({ ok: true }) as { ok: boolean; detail?: string },
        fetchObservations: async () => ({ observations: [], nextCursor: null }),
        normalizeReport: async () => ({
          // biome-ignore lint/suspicious/noExplicitAny: test double
          report: report as any,
          redactedFieldNames: [],
        }),
      });
      const ingestion = createMeasurementIngestionService({
        registry,
        logger: createLogger({ module: "test", minLevel: "fatal", pretty: false }),
      });
      let caught: unknown;
      try {
        await ingestion.normalizeSubmission({ providerId: "bad-output-provider", payload: {} });
        throw new Error(`expected rejection for ${label}`);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MeasurementReportRejectedError);
      expect((caught as InstanceType<typeof MeasurementReportRejectedError>).reason).toBe("malformed_report");
    }
  });

  test("the composed command records provenance on the PERSISTED observation (provider as source identity)", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const view = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac02-browser",
      subjectId: subject.id,
    });
    expect(view.providerId).toBe("browser-attribution");
    expect(view.providerVersion).toBe("1.0.0");
    expect(view.created).toBe(true);
    const observation = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      harness.w006.bootstrapCtx,
      view.observation.id,
    );
    // Full provenance persisted: provider-sourced, method + version,
    // collectedAt, provider-reported attribution mode as a provenance
    // fact (NOT a protocol attribution record).
    expect(observation.provenance.sourceType).toBe("provider");
    expect(observation.provenance.sourceId).toBe("browser-attribution");
    expect(observation.provenance.method).toBe("browser-attribution-model");
    expect(observation.provenance.methodVersion).toBe("3.1.0");
    expect(observation.provenance.collectedAt).toBe("2026-08-24T12:00:00.000Z");
    expect(observation.provenance.collectorId).toBe(harness.personId);
    expect(observation.externalSubjectRef).toBe("ext-browser-subject-42");
    expect(observation.providerAttributionMode).toBe("probabilistic");
    // Uncertainty preserved: the confidence interval crossed intact.
    expect(observation.confidence).toEqual({ point: 0.9, lower: 0.85, upper: 0.95 });
  });
});
