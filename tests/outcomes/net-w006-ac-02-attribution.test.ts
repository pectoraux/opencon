/**
 * NET-W006-AC-02 — Distinct attribution representations.
 *
 * Deterministic, probabilistic and experimental attribution are
 * represented DISTINCTLY with uncertainty and method/version
 * metadata. Mode-specific validation fails closed with stable error
 * codes:
 *  - deterministic REQUIRES a mechanical link;
 *  - probabilistic FORBIDS a mechanical link and REQUIRES a quantified
 *    interval (uncertainty preserved, never collapsed);
 *  - experimental REQUIRES a non-invalidated experiment reference and
 *    a quantified interval.
 *
 * Evidence: exhaustive mode-rule tests over the attribution service.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW006Harness,
  actorCtx,
  createMeasuredSubject,
  createObservation,
  createCompletedExperiment,
  type NetW006Harness,
} from "./_net-w006-harness.ts";
import type { AttributionRecord } from "../../src/outcomes/port.ts";

let harness: NetW006Harness;

beforeEach(async () => {
  harness = await createNetW006Harness();
});

afterEach(async () => {
  await harness.teardown();
});

interface AttributionOptions {
  readonly mode: string;
  readonly link?: { linkType: string; linkIdentifier: string };
  readonly experimentId?: string;
  readonly point?: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
}

async function createAttribution(
  observationId: string,
  subjectId: string,
  opts: AttributionOptions,
): Promise<AttributionRecord> {
  const ctx = actorCtx(harness, "ac02-attribution");
  return harness.runtime.attributionService.createAttribution(ctx, {
    organizationScopeId: harness.organizationScopeId,
    observationId,
    attributedSubject: { subjectId, subjectType: "contribution" },
    mode: opts.mode,
    attributionValue: { value: 0.8, unit: "share" },
    confidence: {
      point: opts.point ?? 0.9,
      ...(opts.lower !== undefined ? { lower: opts.lower } : {}),
      ...(opts.upper !== undefined ? { upper: opts.upper } : {}),
    },
    provenance: {
      sourceType: opts.sourceType ?? "platform",
      sourceId: "attribution-engine",
      method:
        opts.mode === "probabilistic"
          ? "mmm"
          : opts.mode === "deterministic"
            ? "identity-match"
            : "geo-holdout",
      methodVersion: "2.0.0",
    },
    ...(opts.link !== undefined ? { deterministicLink: opts.link } : {}),
    ...(opts.experimentId !== undefined ? { experimentId: opts.experimentId } : {}),
  });
}

describe("NET-W006-AC-02 distinct attribution representations", () => {
  test("deterministic attribution carries the mechanical link + method/version metadata", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const attribution = await createAttribution(observation.id, subject.id, {
      mode: "deterministic",
      link: { linkType: "click-id", linkIdentifier: "clk_123" },
      // An interval is OPTIONAL for a mechanical link.
      point: 1,
    });
    expect(attribution.mode).toBe("deterministic");
    expect(attribution.deterministicLink).toEqual({
      linkType: "click-id",
      linkIdentifier: "clk_123",
    });
    expect(attribution.provenance.method).toBe("identity-match");
    expect(attribution.provenance.methodVersion).toBe("2.0.0");
    expect(attribution.experimentId).toBeNull();
    // Audit lineage committed with the mutation.
    const events = await harness.runtime.auditWriter.query({
      eventType: "attribution.created",
      resourceId: attribution.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toMatchObject({
      mode: "deterministic",
      deterministicLinkType: "click-id",
    });
  });

  test("deterministic attribution WITHOUT a link is rejected (INVALID_ATTRIBUTION)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    try {
      await createAttribution(observation.id, subject.id, { mode: "deterministic" });
      throw new Error("expected deterministic without link to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
    }
  });

  test("probabilistic attribution preserves model identity + a quantified interval", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const attribution = await createAttribution(observation.id, subject.id, {
      mode: "probabilistic",
      point: 0.72,
      lower: 0.55,
      upper: 0.85,
    });
    expect(attribution.mode).toBe("probabilistic");
    expect(attribution.deterministicLink).toBeNull();
    expect(attribution.provenance.method).toBe("mmm");
    expect(attribution.provenance.methodVersion).toBe("2.0.0");
    expect(attribution.confidence.lower).toBe(0.55);
    expect(attribution.confidence.upper).toBe(0.85);
  });

  test("probabilistic attribution WITHOUT an interval is rejected (uncertainty is never collapsed)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    try {
      await createAttribution(observation.id, subject.id, {
        mode: "probabilistic",
        point: 0.72,
      });
      throw new Error("expected probabilistic without interval to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
      expect((oce as { context?: Record<string, unknown> }).context).toMatchObject({
        mode: "probabilistic",
      });
    }
  });

  test("probabilistic attribution WITH a mechanical link is rejected (modes are distinct)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    try {
      await createAttribution(observation.id, subject.id, {
        mode: "probabilistic",
        lower: 0.5,
        upper: 0.9,
        link: { linkType: "click-id", linkIdentifier: "clk_123" },
      });
      throw new Error("expected probabilistic with link to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
    }
  });

  test("experimental attribution references a RUNNING/COMPLETED experiment + a quantified interval", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const experiment = await createCompletedExperiment(harness, "geo-split");
    const attribution = await createAttribution(observation.id, subject.id, {
      mode: "experimental",
      experimentId: experiment.id,
      point: 0.68,
      lower: 0.6,
      upper: 0.76,
    });
    expect(attribution.mode).toBe("experimental");
    expect(attribution.experimentId).toBe(experiment.id);
    expect(attribution.confidence.lower).toBe(0.6);

    // A RUNNING experiment also backs experimental attribution.
    const ctx = actorCtx(harness, "ac02-running");
    const planned = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
      },
    );
    const running = await harness.runtime.measurementExperimentService.startExperiment(ctx, {
      experimentId: planned.id,
      expectedVersion: planned.version,
    });
    const runningAttribution = await createAttribution(observation.id, subject.id, {
      mode: "experimental",
      experimentId: running.id,
      point: 0.68,
      lower: 0.6,
      upper: 0.76,
    });
    expect(runningAttribution.experimentId).toBe(running.id);
  });

  test("experimental attribution referencing an INVALIDATED experiment is rejected (fail closed)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const ctx = actorCtx(harness, "ac02-invalidated");
    const experiment = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
      },
    );
    const invalidated = await harness.runtime.measurementExperimentService.invalidateExperiment(
      ctx,
      { experimentId: experiment.id, expectedVersion: experiment.version, reason: "contaminated" },
    );
    try {
      await createAttribution(observation.id, subject.id, {
        mode: "experimental",
        experimentId: invalidated.id,
        point: 0.68,
        lower: 0.6,
        upper: 0.76,
      });
      throw new Error("expected invalidated experiment reference to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
    }
  });

  test("experimental attribution without an experiment reference is rejected", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    try {
      await createAttribution(observation.id, subject.id, {
        mode: "experimental",
        point: 0.68,
        lower: 0.6,
        upper: 0.76,
      });
      throw new Error("expected experimental without experiment to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
    }
  });

  test("experimental attribution without an interval is rejected (statistical estimate)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const experiment = await createCompletedExperiment(harness);
    try {
      await createAttribution(observation.id, subject.id, {
        mode: "experimental",
        experimentId: experiment.id,
        point: 0.68,
      });
      throw new Error("expected experimental without interval to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
    }
  });

  test("an unknown mode is rejected with a stable error code", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    try {
      await createAttribution(observation.id, subject.id, { mode: "vibes-based" });
      throw new Error("expected unknown mode to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_ATTRIBUTION");
    }
  });

  test("the attributed observation must exist in the same organization scope", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    // Non-existent observation.
    try {
      await createAttribution("urn:missing-observation", subject.id, {
        mode: "deterministic",
        link: { linkType: "click-id", linkIdentifier: "clk_x" },
      });
      throw new Error("expected missing observation to be rejected");
    } catch (err) {
      expect((err as { classification?: string }).classification).toBe("not_found");
    }
    // Cross-scope attribution: the observation EXISTS but belongs to a
    // second organization in the same authoritative store.
    const secondOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Other Attribution Org", creatorId: harness.personId },
    );
    const ctx = actorCtx(harness, "ac02-cross-scope");
    try {
      await harness.runtime.attributionService.createAttribution(ctx, {
        organizationScopeId: secondOrg.id,
        observationId: observation.id,
        attributedSubject: { subjectId: subject.id, subjectType: "contribution" },
        mode: "deterministic",
        attributionValue: { value: 0.8, unit: "share" },
        confidence: { point: 0.9 },
        provenance: {
          sourceType: "platform",
          method: "identity-match",
          methodVersion: "2.0.0",
        },
        deterministicLink: { linkType: "click-id", linkIdentifier: "clk_x" },
      });
      throw new Error("expected cross-scope attribution to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });
});
