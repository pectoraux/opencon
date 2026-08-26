/**
 * NET-W006-AC-03 — Experiments, holdouts, incrementality.
 *
 * Experiment/holdout and incrementality semantics represent measured
 * lift without claiming causality where no valid experiment exists:
 *  - the experiment status lifecycle is deterministic (PLANNED →
 *    RUNNING → COMPLETED; INVALIDATED from PLANNED/RUNNING), versioned
 *    and audited atomically;
 *  - `experiment_backed` incrementality requires a COMPLETED
 *    experiment (PLANNED/RUNNING/INVALIDATED references are rejected —
 *    fail closed);
 *  - observational lift (no experiment reference) is explicitly
 *    non-causal (`causalStatus: "observational"`);
 *  - a lift estimate REQUIRES a quantified confidence interval.
 *
 * Evidence: experiment lifecycle tests + incrementality causality-rule
 * tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW006Harness,
  actorCtx,
  createMeasuredSubject,
  createCompletedExperiment,
  type NetW006Harness,
} from "./_net-w006-harness.ts";
import type { IncrementalityObservation } from "../../src/outcomes/port.ts";

let harness: NetW006Harness;

beforeEach(async () => {
  harness = await createNetW006Harness();
});

afterEach(async () => {
  await harness.teardown();
});

interface IncrementalityOptions {
  readonly experimentId?: string;
  readonly point?: number;
  readonly lower?: number;
  readonly upper?: number;
}

async function createIncrementality(
  subjectId: string,
  opts: IncrementalityOptions = {},
): Promise<IncrementalityObservation> {
  const ctx = actorCtx(harness, "ac03-incrementality");
  return harness.runtime.incrementalityService.createIncrementalityObservation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId, subjectType: "contribution" },
    outcomeType: "install",
    lift: { value: 4.2, unit: "installs" },
    baselineValue: { value: 38, unit: "installs" },
    confidence: {
      point: opts.point ?? 0.85,
      ...(opts.lower !== undefined ? { lower: opts.lower } : {}),
      ...(opts.upper !== undefined ? { upper: opts.upper } : {}),
    },
    provenance: {
      sourceType: "platform",
      sourceId: "experiment-platform",
      method: "difference-in-means",
      methodVersion: "1.0.0",
    },
    ...(opts.experimentId !== undefined ? { experimentId: opts.experimentId } : {}),
  });
}

describe("NET-W006-AC-03 experiments/holdouts and incrementality", () => {
  test("the experiment lifecycle is deterministic: PLANNED → RUNNING → COMPLETED, each step audited + versioned", async () => {
    const ctx = actorCtx(harness, "ac03-lifecycle");
    const experiment = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
        hypothesis: "holdout measures incremental installs",
      },
    );
    expect(experiment.status).toBe("PLANNED");
    expect(experiment.version).toBe(0);

    const started = await harness.runtime.measurementExperimentService.startExperiment(ctx, {
      experimentId: experiment.id,
      expectedVersion: 0,
    });
    expect(started.status).toBe("RUNNING");
    expect(started.version).toBe(1);
    expect(started.startedAt).toBeTruthy();

    const completed = await harness.runtime.measurementExperimentService.completeExperiment(
      ctx,
      { experimentId: started.id, expectedVersion: 1 },
    );
    expect(completed.status).toBe("COMPLETED");
    expect(completed.version).toBe(2);
    expect(completed.completedAt).toBeTruthy();

    // Every status change emitted an atomic audit record.
    const startedEvents = await harness.runtime.auditWriter.query({
      eventType: "measurement_experiment.started",
      resourceId: experiment.id,
    });
    const completedEvents = await harness.runtime.auditWriter.query({
      eventType: "measurement_experiment.completed",
      resourceId: experiment.id,
    });
    expect(startedEvents.length).toBe(1);
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.metadata).toMatchObject({
      fromStatus: "RUNNING",
      toStatus: "COMPLETED",
    });
  });

  test("illegal experiment status transitions are rejected (PLANNED → COMPLETED, COMPLETED → anything)", async () => {
    const ctx = actorCtx(harness, "ac03-illegal");
    const planned = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
      },
    );
    // PLANNED → COMPLETED is illegal (must run first).
    try {
      await harness.runtime.measurementExperimentService.completeExperiment(ctx, {
        experimentId: planned.id,
        expectedVersion: 0,
      });
      throw new Error("expected PLANNED → COMPLETED to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
    // COMPLETED is terminal.
    const completed = await createCompletedExperiment(harness);
    try {
      await harness.runtime.measurementExperimentService.startExperiment(ctx, {
        experimentId: completed.id,
        expectedVersion: completed.version,
      });
      throw new Error("expected COMPLETED → RUNNING to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("a stale expectedVersion on an experiment status change is rejected (optimistic concurrency)", async () => {
    const ctx = actorCtx(harness, "ac03-stale");
    const experiment = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
      },
    );
    try {
      await harness.runtime.measurementExperimentService.startExperiment(ctx, {
        experimentId: experiment.id,
        expectedVersion: 99,
      });
      throw new Error("expected stale writer to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("CONFLICT");
    }
  });

  test("INVALIDATED records the reason and is reachable from PLANNED and RUNNING", async () => {
    const ctx = actorCtx(harness, "ac03-invalidate");
    const planned = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "geo-split",
      },
    );
    const invalidatedFromPlanned =
      await harness.runtime.measurementExperimentService.invalidateExperiment(ctx, {
        experimentId: planned.id,
        expectedVersion: planned.version,
        reason: "misconfigured arms",
      });
    expect(invalidatedFromPlanned.status).toBe("INVALIDATED");
    expect(invalidatedFromPlanned.invalidationReason).toBe("misconfigured arms");

    // A reason is REQUIRED.
    const other = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
      },
    );
    try {
      await harness.runtime.measurementExperimentService.invalidateExperiment(ctx, {
        experimentId: other.id,
        expectedVersion: other.version,
        reason: "  ",
      });
      throw new Error("expected missing reason to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("an experiment_backed incrementality observation requires a COMPLETED experiment (fail closed on non-COMPLETED)", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac03-experiment-backed");

    // COMPLETED → experiment_backed.
    const completed = await createCompletedExperiment(harness);
    const backed = await createIncrementality(subject.id, {
      experimentId: completed.id,
      point: 0.85,
      lower: 0.8,
      upper: 0.9,
    });
    expect(backed.experimentId).toBe(completed.id);
    expect(backed.causalStatus).toBe("experiment_backed");

    // PLANNED → rejected.
    const planned = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        experimentType: "holdout",
      },
    );
    try {
      await createIncrementality(subject.id, {
        experimentId: planned.id,
        lower: 0.8,
        upper: 0.9,
      });
      throw new Error("expected PLANNED experiment reference to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
      expect((oce as { context?: Record<string, unknown> }).context).toMatchObject({
        experimentStatus: "PLANNED",
      });
    }

    // RUNNING → rejected.
    const running = await harness.runtime.measurementExperimentService.startExperiment(ctx, {
      experimentId: planned.id,
      expectedVersion: planned.version,
    });
    try {
      await createIncrementality(subject.id, {
        experimentId: running.id,
        lower: 0.8,
        upper: 0.9,
      });
      throw new Error("expected RUNNING experiment reference to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }

    // INVALIDATED → rejected.
    const invalidated = await harness.runtime.measurementExperimentService.invalidateExperiment(
      ctx,
      { experimentId: running.id, expectedVersion: running.version, reason: "leaked" },
    );
    try {
      await createIncrementality(subject.id, {
        experimentId: invalidated.id,
        lower: 0.8,
        upper: 0.9,
      });
      throw new Error("expected INVALIDATED experiment reference to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("observational lift (no experiment reference) is explicitly NON-CAUSAL", async () => {
    const subject = await createMeasuredSubject(harness);
    const observational = await createIncrementality(subject.id, {
      point: 0.7,
      lower: 0.6,
      upper: 0.8,
    });
    expect(observational.experimentId).toBeNull();
    expect(observational.causalStatus).toBe("observational");
    // The lift + baseline + interval are still fully represented
    // (measured lift WITHOUT a causality claim).
    expect(observational.lift).toEqual({ value: 4.2, unit: "installs" });
    expect(observational.baselineValue).toEqual({ value: 38, unit: "installs" });
    expect(observational.confidence.lower).toBe(0.6);
    expect(observational.confidence.upper).toBe(0.8);
  });

  test("a lift estimate without a quantified interval is rejected (manufactured exactness)", async () => {
    const subject = await createMeasuredSubject(harness);
    try {
      await createIncrementality(subject.id, { point: 0.85 });
      throw new Error("expected interval-less lift to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("the incrementality audit record carries the derived causal status", async () => {
    const subject = await createMeasuredSubject(harness);
    const completed = await createCompletedExperiment(harness);
    const backed = await createIncrementality(subject.id, {
      experimentId: completed.id,
      lower: 0.8,
      upper: 0.9,
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "incrementality_observation.created",
      resourceId: backed.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toMatchObject({
      causalStatus: "experiment_backed",
      experimentId: completed.id,
      liftValue: 4.2,
    });
  });
});
