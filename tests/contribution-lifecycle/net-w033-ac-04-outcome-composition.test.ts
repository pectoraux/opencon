/**
 * NET-W033-AC-04 — Outcome / measurement composition (issue #67 §4
 * AC-04).
 *
 * A normalized outcome is produced through /outcomes with an explicit
 * anchor; uncertainty, attribution and provenance are preserved and
 * traceable to evidence:
 *  - the canonical measured outcome is VERIFIED through the /outcomes
 *    maturation lifecycle with the IMMEDIATE strategy (the explicit
 *    deterministic anchor — no wall clock);
 *  - the observation's uncertainty (confidence interval) and
 *    provenance (platform method + version) are preserved on the
 *    committed records;
 *  - the outcome is traceable to evidence: the observation carries
 *    the explicit evidenceId link; the evidence's subject IS the
 *    contribution (the full lineage chain);
 *  - the rollup aggregates the observation chain (server-derived,
 *    not caller-asserted);
 *  - a maturation OUTSIDE the recorded strategy (finalize before the
 *    rollup) fails closed;
 *  - the verified-outcome read for the subject resolves exactly the
 *    canonical measurement.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  type NetW033Harness,
} from "./_net-w033-harness.ts";

let harness: NetW033Harness;
let scenario: Awaited<ReturnType<typeof runCanonicalScenario>>;

beforeAll(async () => {
  harness = await createNetW033Harness();
  scenario = await runCanonicalScenario(harness, {
    skipBenefitAllocation: true,
  });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033-AC-04 outcome / measurement composition", () => {
  test("the canonical normalized outcome is VERIFIED through /outcomes with the explicit immediate anchor", async () => {
    const ctx = harness.contributorCtx("w033-ac04-mo");
    const measurement =
      await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
        ctx,
        scenario.measuredOutcomeId,
      );
    expect(measurement.state).toBe("VERIFIED");
    // The explicit deterministic anchor: the IMMEDIATE maturation
    // strategy (never a wall-clock window).
    expect(measurement.maturation.strategy).toBe("immediate");
    expect(measurement.outcomeType).toBe("helpfulness");
    expect(measurement.subjectReference.subjectId).toBe(
      scenario.contribution.id,
    );
    expect(measurement.subjectReference.subjectType).toBe("contribution");
  });

  test("uncertainty + provenance are preserved on the committed observation", async () => {
    const ctx = harness.contributorCtx("w033-ac04-obs");
    const observation =
      await harness.runtime.outcomeObservationService.getOutcomeObservation(
        ctx,
        scenario.observationId,
      );
    // Uncertainty preserved (the point + interval).
    expect(observation.confidence.point).toBe(0.95);
    expect(observation.confidence.lower).toBe(0.9);
    expect(observation.confidence.upper).toBe(0.98);
    // Provenance preserved (source type, method + version).
    expect(observation.provenance.sourceType).toBe("platform");
    expect(observation.provenance.method).toBe("platform-counter");
    expect(observation.provenance.methodVersion).toBe("1.0.0");
    // The observed value + unit.
    expect(observation.observedValue.value).toBe(1);
    expect(observation.observedValue.unit).toBe("helpful-resolutions");
  });

  test("the outcome is traceable to evidence through the observation's explicit evidence link (full lineage chain)", async () => {
    const ctx = harness.contributorCtx("w033-ac04-lineage");
    // measured outcome → observation → evidence → contribution.
    const measurement =
      await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
        ctx,
        scenario.measuredOutcomeId,
      );
    expect(measurement.observationIds).toContain(scenario.observationId);
    const observation =
      await harness.runtime.outcomeObservationService.getOutcomeObservation(
        ctx,
        scenario.observationId,
      );
    expect(observation.evidenceId).toBe(scenario.povPlatformEvidenceId);
    const evidence = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povPlatformEvidenceId,
    );
    expect(evidence.subjectReference.subjectId).toBe(scenario.contribution.id);
    expect(evidence.subjectReference.subjectType).toBe("contribution");
    // The evidence is a committed /evidence record (MEASURED grade).
    expect(evidence.grade).toBe("MEASURED");
  });

  test("the rollup is server-derived over the observation chain (recorded before finalization)", async () => {
    const ctx = harness.contributorCtx("w033-ac04-rollup");
    const measurement =
      await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
        ctx,
        scenario.measuredOutcomeId,
      );
    // The rollup is recorded (non-null) + aggregated the platform
    // observation chain (the exact chain-head ids + measured value).
    expect(measurement.rollup).not.toBeNull();
    expect(measurement.rollup?.observationIds).toEqual([
      scenario.observationId,
    ]);
    expect(measurement.rollup?.measuredValue.value).toBe(1);
    expect(measurement.rollup?.confidence.point).toBe(0.95);
    // The audit trail records the maturation transitions.
    const events = await harness.runtime.auditWriter.query({
      resourceType: "outcome_measurement",
      resourceId: scenario.measuredOutcomeId,
    });
    const types = events.map((e) => e.eventType);
    expect(types).toContain("outcome_measurement.transition.draft_to_measuring");
    expect(types).toContain("outcome_measurement.transition.measuring_to_verified");
  });

  test("finalization WITHOUT the recorded rollup fails closed (the maturation gate)", async () => {
    const ctx = harness.contributorCtx("w033-ac04-gate");
    const observation =
      await harness.runtime.outcomeObservationService.createOutcomeObservation(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          observerId: harness.contributorPersonId,
          subjectReference: {
            subjectId: scenario.contribution.id,
            subjectType: "contribution",
          },
          outcomeType: "helpfulness",
          observedValue: { value: 2, unit: "helpful-resolutions" },
          confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
          provenance: {
            sourceType: "platform",
            sourceId: "platform-counter-w033-gate",
            method: "platform-counter",
            methodVersion: "1.0.0",
          },
        },
      );
    const measurement =
      await harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.contributorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        outcomeType: "helpfulness",
        maturation: { strategy: "immediate" },
        observationIds: [observation.id],
      });
    await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
      measurementId: measurement.id,
      expectedVersion: 0,
      idempotencyKey: key("w033-ac04-gate-begin"),
      actorPersonId: harness.contributorPersonId,
    });
    // NO rollup recorded: finalize fails closed.
    await expect(
      harness.runtime.measuredOutcomeService.finalize(ctx, {
        measurementId: measurement.id,
        expectedVersion: 1,
        idempotencyKey: key("w033-ac04-gate-finalize"),
        actorPersonId: harness.contributorPersonId,
      }),
    ).rejects.toThrow(/rollup/i);
  });

  test("the verified-outcome read for the subject resolves exactly the canonical measurement", async () => {
    const ctx = harness.contributorCtx("w033-ac04-list");
    const verified =
      await harness.runtime.measuredOutcomeService.listVerifiedMeasuredOutcomesBySubject(
        ctx,
        harness.organizationScopeId,
        scenario.contribution.id,
      );
    // The canonical measurement (the scenario's own — earlier W014
    // fixtures in this harness chain used OTHER contributions).
    const ids = verified.map((m) => m.id);
    expect(ids).toContain(scenario.measuredOutcomeId);
    for (const m of verified) {
      expect(m.subjectReference.subjectId).toBe(scenario.contribution.id);
    }
  });
});
