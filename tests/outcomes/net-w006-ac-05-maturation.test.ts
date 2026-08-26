/**
 * NET-W006-AC-05 — Maturation cannot silently finalize.
 *
 * Delayed outcomes support pending/maturation/finalized states
 * (DRAFT/MEASURING/VERIFIED) and cannot silently become final:
 *  - the transition matrix is exhaustive: DRAFT → MEASURING →
 *    VERIFIED, DRAFT|MEASURING → CANCELLED; there is NO DRAFT →
 *    VERIFIED edge (finalization always passes through maturation);
 *  - finalization requires a recorded deterministic rollup (the value
 *    is DERIVED, never caller-asserted);
 *  - fixed_window measurements cannot finalize before windowEndAt;
 *  - event_driven measurements require an explicit maturationEvent;
 *  - finalization is an authorized, idempotent, audited workflow
 *    transition carrying the authoritative transaction id;
 *  - attachments freeze at VERIFIED.
 *
 * Evidence: maturation gate tests + transition-matrix exhaustiveness
 * tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW006Harness,
  actorCtx,
  createMeasuredSubject,
  createObservation,
  createMeasuredOutcome,
  measurementTransitionInput,
  type NetW006Harness,
} from "./_net-w006-harness.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE, legalTargets, ALL_LIFECYCLE_STATES } from "../../src/workflows/transition-table.ts";

let harness: NetW006Harness;

beforeEach(async () => {
  harness = await createNetW006Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W006-AC-05 maturation cannot silently finalize", () => {
  test("the measured-outcome transition matrix is exhaustive: DRAFT→MEASURING→VERIFIED + CANCELLED; NO DRAFT→VERIFIED edge", () => {
    const edges = OUTCOME_MEASUREMENT_TRANSITION_TABLE.map(
      (r) => `${r.from}->${r.to}`,
    ).sort();
    expect(edges).toEqual([
      "DRAFT->CANCELLED",
      "DRAFT->MEASURING",
      "MEASURING->CANCELLED",
      "MEASURING->VERIFIED",
    ]);
    // Every legal target set excludes the silent-finalization edge.
    expect([...legalTargets("outcome_measurement", "DRAFT")].sort()).toEqual([
      "CANCELLED",
      "MEASURING",
    ]);
    expect([...legalTargets("outcome_measurement", "MEASURING")].sort()).toEqual([
      "CANCELLED",
      "VERIFIED",
    ]);
    // Terminal states admit no transitions.
    for (const terminal of ["VERIFIED", "CANCELLED"]) {
      expect(legalTargets("outcome_measurement", terminal as "VERIFIED")).toEqual([]);
    }
    // Every rule carries a policy action + audit event name (§8 shape).
    for (const rule of OUTCOME_MEASUREMENT_TRANSITION_TABLE) {
      expect(rule.policyAction).toMatch(/^outcome_measurement\.transition\./);
      expect(rule.auditEventName).toMatch(/^outcome_measurement\.transition\./);
    }
    // No transition may originate from a state outside the lifecycle
    // vocabulary.
    for (const rule of OUTCOME_MEASUREMENT_TRANSITION_TABLE) {
      expect(ALL_LIFECYCLE_STATES()).toContain(rule.from);
      expect(ALL_LIFECYCLE_STATES()).toContain(rule.to);
    }
  });

  test("the full happy path: DRAFT → MEASURING → rollup → VERIFIED with authorized, audited transitions", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id, { value: 30 });
    const ctx = actorCtx(harness, "ac05-happy");

    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "immediate",
    });
    expect(measurement.state).toBe("DRAFT");
    expect(measurement.version).toBe(0);

    const begin = await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-begin"),
    );
    expect(begin.executed).toBe(true);
    expect(begin.measurement.state).toBe("MEASURING");
    expect(begin.measurement.version).toBe(1);
    // The transition carries the AUTHORITATIVE transaction id.
    expect(begin.transactionId).toBeTruthy();
    expect(begin.auditEventName).toBe(
      "outcome_measurement.transition.draft_to_measuring",
    );

    const rolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      measurement.id,
    );
    expect(rolled.rollup).not.toBeNull();
    expect(rolled.rollup!.measuredValue).toEqual({ value: 30, unit: "installs" });

    const finalized = await harness.runtime.measuredOutcomeService.finalize(
      ctx,
      measurementTransitionInput(harness, measurement.id, 1, "ac05-finalize"),
    );
    expect(finalized.executed).toBe(true);
    expect(finalized.measurement.state).toBe("VERIFIED");
    expect(finalized.measurement.version).toBe(2);
    expect(finalized.auditEventName).toBe(
      "outcome_measurement.transition.measuring_to_verified",
    );
    // The transition audit record exists and carries tx lineage.
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_measurement.transition.measuring_to_verified",
      resourceId: measurement.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toMatchObject({
      fromState: "MEASURING",
      toState: "VERIFIED",
      transactionId: finalized.transactionId,
    });
  });

  test("finalization WITHOUT a recorded rollup is rejected (the value is derived, never assumed)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const ctx = actorCtx(harness, "ac05-no-rollup");
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-nr-begin"),
    );
    try {
      await harness.runtime.measuredOutcomeService.finalize(
        ctx,
        measurementTransitionInput(harness, measurement.id, 1, "ac05-nr-finalize"),
      );
      throw new Error("expected finalize without rollup to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
    // The measurement is still MEASURING (nothing silently finalized).
    const stored = await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      measurement.id,
    );
    expect(stored.state).toBe("MEASURING");
    expect(stored.rollup).toBeNull();
  });

  test("the rollup requires observations: an empty measurement cannot record a rollup (or finalize)", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac05-empty");
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-empty-begin"),
    );
    try {
      await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
        ctx,
        measurement.id,
      );
      throw new Error("expected empty rollup to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("the rollup gate: model/self observations alone can NEVER produce a finalized measurement", async () => {
    const subject = await createMeasuredSubject(harness);
    const modelObservation = await createObservation(harness, subject.id, {
      sourceType: "model",
      value: 5,
    });
    const selfObservation = await createObservation(harness, subject.id, {
      sourceType: "self",
      value: 7,
    });
    const ctx = actorCtx(harness, "ac05-model-only");
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [modelObservation.id, selfObservation.id],
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-mo-begin"),
    );
    try {
      await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
        ctx,
        measurement.id,
      );
      throw new Error("expected model/self-only rollup to be rejected");
    } catch (err) {
      const oce = err as { code?: string; context?: Record<string, unknown> };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
      expect((oce.context ?? {}).sourceTypes).toEqual(["model", "self"]);
    }
    // Adding ONE platform observation unblocks the rollup (model
    // inputs remain admissible as INPUTS — they are simply never
    // sufficient alone; architecture-lock §4).
    const platformObservation = await createObservation(harness, subject.id, {
      sourceType: "platform",
      value: 9,
    });
    await harness.runtime.measuredOutcomeService.attachObservation(
      ctx,
      measurement.id,
      platformObservation.id,
    );
    const rolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      measurement.id,
    );
    expect(rolled.rollup!.measuredValue.value).toBe(5 + 7 + 9);
  });

  test("fixed_window: finalization before windowEndAt is rejected; after it succeeds", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const ctx = actorCtx(harness, "ac05-window");

    // A window that ends in the FUTURE.
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const futureMeasurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "fixed_window",
      windowEndAt: future,
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, futureMeasurement.id, 0, "ac05-fw-begin"),
    );
    await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      futureMeasurement.id,
    );
    try {
      await harness.runtime.measuredOutcomeService.finalize(
        ctx,
        measurementTransitionInput(harness, futureMeasurement.id, 1, "ac05-fw-early"),
      );
      throw new Error("expected early finalization to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
      expect((oce as { context?: Record<string, unknown> }).context).toMatchObject({
        windowEndAt: future,
      });
    }

    // A window that ALREADY elapsed finalizes cleanly (the window
    // started an hour ago and ended a minute ago).
    const pastStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const pastMeasurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "fixed_window",
      windowStartAt: pastStart,
      windowEndAt: past,
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, pastMeasurement.id, 0, "ac05-pw-begin"),
    );
    await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      pastMeasurement.id,
    );
    const finalized = await harness.runtime.measuredOutcomeService.finalize(
      ctx,
      measurementTransitionInput(harness, pastMeasurement.id, 1, "ac05-pw-finalize"),
    );
    expect(finalized.measurement.state).toBe("VERIFIED");
  });

  test("fixed_window creation REQUIRES windowEndAt (after windowStartAt)", async () => {
    const subject = await createMeasuredSubject(harness);
    try {
      await createMeasuredOutcome(harness, subject.id, {
        maturationStrategy: "fixed_window",
      });
      throw new Error("expected missing windowEndAt to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
    try {
      await createMeasuredOutcome(harness, subject.id, {
        maturationStrategy: "fixed_window",
        windowStartAt: "2026-01-10T00:00:00.000Z",
        windowEndAt: "2026-01-01T00:00:00.000Z",
      });
      throw new Error("expected inverted window to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("event_driven: finalization requires an explicit, auditable maturationEvent", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const ctx = actorCtx(harness, "ac05-event");
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "event_driven",
      maturationBasis: "subscription-period-close",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-ed-begin"),
    );
    await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      measurement.id,
    );
    // Without the event reference → rejected.
    try {
      await harness.runtime.measuredOutcomeService.finalize(
        ctx,
        measurementTransitionInput(harness, measurement.id, 1, "ac05-ed-no-event"),
      );
      throw new Error("expected event_driven finalize without event to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
    // With the event reference → the transition carries it in metadata.
    const finalized = await harness.runtime.measuredOutcomeService.finalize(
      ctx,
      {
        ...measurementTransitionInput(harness, measurement.id, 1, "ac05-ed-finalize"),
        maturationEvent: "billing-period-2026-08-closed",
      },
    );
    expect(finalized.measurement.state).toBe("VERIFIED");
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_measurement.transition.measuring_to_verified",
      resourceId: measurement.id,
    });
    expect(events[0]!.metadata).toMatchObject({
      maturationEvent: "billing-period-2026-08-closed",
    });
  });

  test("attachments freeze at VERIFIED (a finalized measurement is immutable)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const ctx = actorCtx(harness, "ac05-freeze");
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-fz-begin"),
    );
    await harness.runtime.measuredOutcomeService.recordMeasurementRollup(ctx, measurement.id);
    await harness.runtime.measuredOutcomeService.finalize(
      ctx,
      measurementTransitionInput(harness, measurement.id, 1, "ac05-fz-finalize"),
    );
    const lateObservation = await createObservation(harness, subject.id, { value: 99 });
    try {
      await harness.runtime.measuredOutcomeService.attachObservation(
        ctx,
        measurement.id,
        lateObservation.id,
      );
      throw new Error("expected attachment to a finalized measurement to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
    // The rollup cannot be re-recorded either.
    try {
      await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
        ctx,
        measurement.id,
      );
      throw new Error("expected rollup re-record on finalized measurement to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("the deterministic rollup: sum + latest strategies with conservative confidence + chain-head resolution", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac05-rollup");

    // SUM strategy over two observations with intervals.
    const o1 = await createObservation(harness, subject.id, {
      value: 10,
      point: 0.9,
      lower: 0.85,
      upper: 0.95,
      collectedAt: "2026-08-18T00:00:00.000Z",
    });
    const o2 = await createObservation(harness, subject.id, {
      value: 20,
      point: 0.8,
      lower: 0.7,
      upper: 0.9,
      collectedAt: "2026-08-20T00:00:00.000Z",
    });
    const sumMeasurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [o1.id, o2.id],
      rollupStrategy: "sum",
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, sumMeasurement.id, 0, "ac05-rs-begin"),
    );
    const sumRolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      sumMeasurement.id,
    );
    expect(sumRolled.rollup!.strategy).toBe("sum");
    expect(sumRolled.rollup!.measuredValue).toEqual({ value: 30, unit: "installs" });
    // Conservative confidence: MIN point + envelope interval.
    expect(sumRolled.rollup!.confidence.point).toBe(0.8);
    expect(sumRolled.rollup!.confidence.lower).toBe(0.7);
    expect(sumRolled.rollup!.confidence.upper).toBe(0.95);
    expect(sumRolled.rollup!.observationIds).toEqual([o1.id, o2.id]);

    // LATEST strategy: the most-recently-collected head wins.
    const latestMeasurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [o1.id, o2.id],
      rollupStrategy: "latest",
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, latestMeasurement.id, 0, "ac05-rl-begin"),
    );
    const latestRolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      latestMeasurement.id,
    );
    expect(latestRolled.rollup!.strategy).toBe("latest");
    expect(latestRolled.rollup!.measuredValue.value).toBe(20);

    // Chain-head resolution: correcting an attached observation
    // changes the rollup (the correction supersedes).
    const correction = await harness.runtime.outcomeObservationService.correctOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        observedValue: { value: 25, unit: "installs" },
        confidence: { point: 0.9 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "1.1.0",
        },
        correctsObservationId: o1.id,
      },
    );
    const reRolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      sumMeasurement.id,
    );
    expect(reRolled.rollup!.measuredValue.value).toBe(25 + 20);
    expect(reRolled.rollup!.observationIds).toContain(correction.id);
    expect(reRolled.rollup!.observationIds).not.toContain(o1.id);
    expect(reRolled.rollup!.supersededObservationCount).toBe(1);
  });

  test("mixed units in the rollup are rejected with a stable error code", async () => {
    const subject = await createMeasuredSubject(harness);
    const installs = await createObservation(harness, subject.id, {
      unit: "installs",
    });
    const signups = await createObservation(harness, subject.id, {
      unit: "signups",
      outcomeType: "signup",
    });
    const ctx = actorCtx(harness, "ac05-units");
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [installs.id, signups.id],
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac05-units-begin"),
    );
    try {
      await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
        ctx,
        measurement.id,
      );
      throw new Error("expected mixed-unit rollup to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("a measurement can be CANCELLED from DRAFT or MEASURING (terminal)", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac05-cancel");
    const draft = await createMeasuredOutcome(harness, subject.id, {
      maturationStrategy: "immediate",
    });
    const cancelledFromDraft = await harness.runtime.measuredOutcomeService.cancel(
      ctx,
      measurementTransitionInput(harness, draft.id, 0, "ac05-cancel-draft"),
    );
    expect(cancelledFromDraft.measurement.state).toBe("CANCELLED");

    const observation = await createObservation(harness, subject.id);
    const maturing = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
      maturationStrategy: "immediate",
    });
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, maturing.id, 0, "ac05-cancel-begin"),
    );
    const cancelledFromMeasuring = await harness.runtime.measuredOutcomeService.cancel(
      ctx,
      measurementTransitionInput(harness, maturing.id, 1, "ac05-cancel-measuring"),
    );
    expect(cancelledFromMeasuring.measurement.state).toBe("CANCELLED");
  });

  test("the measured outcome carries NO economic dimension (measurement ≠ economic truth)", async () => {
    const subject = await createMeasuredSubject(harness);
    const finalized = await (async () => {
      const observation = await createObservation(harness, subject.id, { value: 30 });
      const ctx = actorCtx(harness, "ac05-non-economic");
      const measurement = await createMeasuredOutcome(harness, subject.id, {
        observationIds: [observation.id],
        maturationStrategy: "immediate",
      });
      await harness.runtime.measuredOutcomeService.beginMaturation(
        ctx,
        measurementTransitionInput(harness, measurement.id, 0, "ac05-ne-begin"),
      );
      await harness.runtime.measuredOutcomeService.recordMeasurementRollup(ctx, measurement.id);
      const result = await harness.runtime.measuredOutcomeService.finalize(
        ctx,
        measurementTransitionInput(harness, measurement.id, 1, "ac05-ne-finalize"),
      );
      return result.measurement;
    })();
    // The finalized measurement is a measured fact with uncertainty —
    // no credit, cash, reward or pricing field exists on the entity.
    const serialized = JSON.stringify(finalized);
    expect(serialized).toContain("measuredValue");
    for (const forbidden of ["credit", "cash", "payout", "reward", "price", "settlement"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});
