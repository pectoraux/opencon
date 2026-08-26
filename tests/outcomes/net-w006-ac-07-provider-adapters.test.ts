/**
 * NET-W006-AC-07 — Provider-neutral adapters, non-authoritative models.
 *
 * External measurement providers are behind provider-neutral
 * adapters:
 *  - the domain consumes ONLY the neutral MeasurementProviderAdapter
 *    contract (the composition root wires concrete adapters — test
 *    stubs today, NET-W022 platform attribution adapters later);
 *  - provider ingestion normalizes reports into observations with
 *    full method/version/confidence provenance (sourceType
 *    "provider", provider id as source id);
 *  - invalid provider reports are rejected fail-closed (a provider
 *    cannot inject malformed facts);
 *  - model outputs are admissible inputs but never authoritative
 *    (the rollup gate — proven in AC-05 — is restated here from the
 *    ingestion angle);
 *  - the reference ECHO adapter satisfies the adapter contract.
 *
 * Evidence: provider-ingestion tests (stub adapter through the
 * composition root) + architecture isolation tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  createNetW006Harness,
  createStubProvider,
  actorCtx,
  createMeasuredSubject,
  type NetW006Harness,
} from "./_net-w006-harness.ts";
import type { ProviderObservationReport } from "../../src/measurement/port.ts";
import { echoMeasurementProvider } from "../../src/measurement/providers/echo-measurement-provider.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

function providerReport(
  overrides: Partial<ProviderObservationReport> = {},
): ProviderObservationReport {
  return {
    providerId: "acme-attribution",
    externalSubjectRef: "ext-conv-77",
    outcomeType: "install",
    observedValue: { value: 18, unit: "installs" },
    confidence: { point: 0.88, lower: 0.8, upper: 0.94 },
    method: "device-graph",
    methodVersion: "4.2.1",
    collectedAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

describe("NET-W006-AC-07 provider-neutral adapters, non-authoritative models", () => {
  let harness: NetW006Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("provider observations are ingested through the neutral adapter with full provenance", async () => {
    harness = await createNetW006Harness({
      measurement: {
        providers: [createStubProvider("acme-attribution", [providerReport()])],
      },
    });
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac07-ingest");

    const result = await harness.runtime.outcomeObservationService.ingestProviderObservations(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      },
    );
    expect(result.providerId).toBe("acme-attribution");
    expect(result.createdObservations.length).toBe(1);

    const observation = result.createdObservations[0]!;
    // Normalized + provider-sourced with full provenance.
    expect(observation.provenance.sourceType).toBe("provider");
    expect(observation.provenance.sourceId).toBe("acme-attribution");
    expect(observation.provenance.method).toBe("device-graph");
    expect(observation.provenance.methodVersion).toBe("4.2.1");
    expect(observation.provenance.collectedAt).toBe("2026-08-24T12:00:00.000Z");
    expect(observation.observedValue).toEqual({ value: 18, unit: "installs" });
    expect(observation.confidence.lower).toBe(0.8);
    expect(observation.externalSubjectRef).toBe("ext-conv-77");
    expect(observation.providerAttributionMode).toBeNull();
    // Durable through the authoritative store + audited atomically.
    const stored = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      observation.id,
    );
    expect(stored).toEqual(observation);
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: observation.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toMatchObject({
      ingestedFromProvider: "acme-attribution",
      externalSubjectRef: "ext-conv-77",
    });
  });

  test("a provider-reported attribution mode is recorded as a provenance fact (NOT a protocol attribution)", async () => {
    harness = await createNetW006Harness({
      measurement: {
        providers: [
          createStubProvider("beta-attribution", [
            providerReport({
              providerId: "beta-attribution",
              attributionMode: "probabilistic",
            }),
          ]),
        ],
      },
    });
    const subject = await createMeasuredSubject(harness);
    const result = await harness.runtime.outcomeObservationService.ingestProviderObservations(
      actorCtx(harness, "ac07-attribution-mode"),
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      },
    );
    const observation = result.createdObservations[0]!;
    // The provider's attribution MODE is carried as provenance — it is
    // NOT a validated protocol AttributionRecord (those are created
    // only through createAttribution with the mode-specific rules).
    expect(observation.providerAttributionMode).toBe("probabilistic");
    // The observation is provider-sourced regardless.
    expect(observation.provenance.sourceId).toBe("beta-attribution");
  });

  test("multiple providers ingest independently through the same neutral contract", async () => {
    harness = await createNetW006Harness({
      measurement: {
        providers: [
          createStubProvider("acme-attribution", [
            providerReport({ providerId: "acme-attribution", observedValue: { value: 10, unit: "installs" } }),
          ]),
          createStubProvider("gamma-mmm", [
            providerReport({
              providerId: "gamma-mmm",
              externalSubjectRef: "gamma-conv-9",
              observedValue: { value: 7, unit: "installs" },
              method: "mmm",
              methodVersion: "2.0.0",
            }),
          ]),
        ],
      },
    });
    const subject = await createMeasuredSubject(harness);
    const result = await harness.runtime.outcomeObservationService.ingestProviderObservations(
      actorCtx(harness, "ac07-multi"),
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      },
    );
    expect(result.createdObservations.length).toBe(2);
    expect(result.createdObservations.map((o) => o.provenance.sourceId).sort()).toEqual([
      "acme-attribution",
      "gamma-mmm",
    ]);
  });

  test("invalid provider reports are rejected FAIL-CLOSED (a provider cannot inject malformed facts)", async () => {
    harness = await createNetW006Harness({
      measurement: {
        providers: [
          createStubProvider("bad-provider", [
            providerReport({ outcomeType: "made-up-outcome" as "install" }),
          ]),
        ],
      },
    });
    const subject = await createMeasuredSubject(harness);
    try {
      await harness.runtime.outcomeObservationService.ingestProviderObservations(
        actorCtx(harness, "ac07-invalid"),
        {
          organizationScopeId: harness.organizationScopeId,
          observerId: harness.personId,
          subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        },
      );
      throw new Error("expected invalid provider report to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("UNSUPPORTED_OUTCOME_TYPE");
    }
    // Nothing was ingested.
    const listed = await harness.runtime.outcomeObservationService.listObservationsBySubject(
      actorCtx(harness, "ac07-invalid-list"),
      subject.id,
    );
    expect(listed.length).toBe(0);
  });

  test("model outputs are admissible inputs but never authoritative (ingestion → rollup gate)", async () => {
    // A provider-sourced observation unblocks the rollup; a pure
    // model/self observation set does not (the gate itself is proven
    // exhaustively in AC-05; this test proves the provider ingestion
    // path produces observations that SATISFY the supporting-source
    // gate).
    harness = await createNetW006Harness({
      measurement: {
        providers: [
          createStubProvider("acme-attribution", [
            providerReport({ observedValue: { value: 21, unit: "installs" } }),
          ]),
        ],
      },
    });
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac07-gate");
    const ingested = await harness.runtime.outcomeObservationService.ingestProviderObservations(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      },
    );
    const observation = ingested.createdObservations[0]!;
    const measurement = await harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "install",
      maturation: { strategy: "immediate" },
      observationIds: [observation.id],
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      {
        measurementId: measurement.id,
        expectedVersion: 0,
        idempotencyKey: "ac07-begin",
        actorPersonId: harness.personId,
      },
    );
    const rolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      measurement.id,
    );
    expect(rolled.rollup!.measuredValue).toEqual({ value: 21, unit: "installs" });
  });

  test("the reference ECHO adapter satisfies the neutral adapter contract", async () => {
    const echo = echoMeasurementProvider;
    expect(echo.info.kind).toBe("measurement");
    expect(echo.info.provider).toBe("echo");
    await echo.initialize();
    const health = await echo.healthCheck();
    expect(health.ok).toBe(true);
    const fetch = await echo.fetchObservations({
      subjectId: "any",
      subjectType: "contribution",
    });
    expect(fetch.observations).toEqual([]);
    expect(fetch.nextCursor).toBeNull();
  });

  test("the outcomes domain consumes ONLY the neutral measurement port (static isolation)", async () => {
    // Every outcomes-domain file imports only core, self, and the
    // NEUTRAL measurement port (port.ts at the measurement boundary
    // root — never providers/).
    const { listTsFiles } = await import("../_test-utils.ts");
    const files = await listTsFiles(join(SRC, "outcomes"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(/from ["']\.\.\/measurement\/providers\//);
      expect(content).not.toMatch(/from ["']\.\.\/(evidence|workflows|opportunities|contributions|reputation|settlement)\//);
    }
    // The neutral port itself is the ONLY measurement import.
    const portFile = await readFile(join(SRC, "outcomes/port.ts"), "utf8");
    expect(portFile).toMatch(/from ["']\.\.\/measurement\/port\.ts["']/);
  });

  test("the runtime exposes the wired provider adapters (composition-root wiring)", async () => {
    const stub = createStubProvider("wired-stub", []);
    harness = await createNetW006Harness({
      measurement: { providers: [stub] },
    });
    expect(harness.runtime.measurementProviders.length).toBe(1);
    expect(harness.runtime.measurementProviders[0]!.info.provider).toBe("wired-stub");
    // Default runtime (no opts) wires the reference ECHO adapter.
    const defaultHarness = await createNetW006Harness();
    try {
      expect(defaultHarness.runtime.measurementProviders.length).toBe(1);
      expect(defaultHarness.runtime.measurementProviders[0]!.info.provider).toBe("echo");
    } finally {
      await defaultHarness.teardown();
    }
  });
});
