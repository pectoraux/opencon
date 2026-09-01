/**
 * NET-W027 AC-05 — Unsupported/uncertain/stale evidence fails closed for
 * authoritative savings use: intervals and method/version lineage are
 * preserved and conservatively combined; non-qualifying-only source
 * types, superseded observations, stale evidence, invalidated
 * baselines and mixed units all fail closed (issue #54 acceptance
 * criterion 5).
 *
 * Work order: spec/work-orders/NET-W027.md §4.2/§4.5 / §7 AC-05.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW027Harness,
  createBaseline,
  createPoolEvidence,
  createSavingsObservation,
  seedSavingsScenario,
  evaluateSavings,
  recordSavings,
  poolCreatorCtx,
  daysAgoIso,
  key,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import {
  InvalidProcurementSavingsError,
  PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES,
  PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
} from "../../src/core/procurement-savings.ts";

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-05 uncertainty preservation + fail-closed evidence", () => {
  test("uncertainty is PRESERVED and conservatively combined (MIN point + interval envelope)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-05 Uncertainty Pool",
    });

    // The counterfactual baseline interval [0.8, 0.95] with point
    // 0.9; the observation is point-only 0.95 → the combined claim
    // carries the interval and the LEAST confident point.
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(view.confidence?.point).toBe(0.9);
    expect(view.confidence?.lower).toBe(0.8);
    expect(view.confidence?.upper).toBe(0.95);
    expect(view.confidence?.method).toBe("conservative-savings-derivation");
    expect(
      view.checks.find((check) => check.check === "uncertainty_preserved")
        ?.satisfied,
    ).toBe(true);

    // An observation with its OWN interval [0.85, 0.99] widens the
    // envelope: [min(0.8, 0.85), max(0.95, 0.99)].
    const withInterval = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      value: 100,
      confidence: { point: 0.88, lower: 0.85, upper: 0.99 },
    });
    const widened = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id, withInterval.id],
    });
    expect(widened.confidence?.point).toBe(0.88);
    expect(widened.confidence?.lower).toBe(0.8);
    expect(widened.confidence?.upper).toBe(0.99);
    expect(
      widened.checks.find((check) => check.check === "uncertainty_preserved")
        ?.satisfied,
    ).toBe(true);
  });

  test("model/self evidence alone never qualifies — both the baseline evidence and the observation source gates fail closed", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-05 Model Pool",
      evidenceSourceType: "model",
      observationSourceType: "self",
    });
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(view.supported).toBe(false);
    expect(
      view.checks.find((check) => check.check === "baseline_evidence_supported")
        ?.satisfied,
    ).toBe(false);
    expect(
      view.checks.find((check) => check.check === "observation_supported")
        ?.satisfied,
    ).toBe(false);
    // The record fails closed (never an authoritative claim).
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
    // The qualifying set is exactly the frozen three.
    expect([...PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES]).toEqual([
      "platform",
      "attested",
      "provider",
    ]);
    // A MIXED setup (qualifying observation + model-only baseline
    // evidence) still fails closed — BOTH gates are load-bearing.
    const mixed = await seedSavingsScenario(harness, {
      name: "AC-05 Mixed Pool",
      evidenceSourceType: "model",
    });
    const mixedView = await evaluateSavings(harness, {
      poolId: mixed.poolId,
      baselineId: mixed.baseline.id,
      outcomeObservationIds: [mixed.observation.id],
    });
    expect(mixedView.supported).toBe(false);
  });

  test("a SUPERSEDED observation (corrected by a later /outcomes record) fails closed", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-05 Superseded Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac05-correct");

    // Correct the observation: the correction supersedes the original
    // chain head (the /outcomes append-correction semantics).
    const corrected =
      await harness.runtime.outcomeObservationService.correctOutcomeObservation(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          observerId: (ctx.actor as { readonly id: string }).id,
          observedValue: { value: 900, unit: "usd" },
          confidence: { point: 0.95 },
          provenance: {
            sourceType: "platform",
            method: "procurement-fulfillment-ledger",
            methodVersion: "1",
          },
          correctsObservationId: scenario.observation.id,
        },
      );

    // The DERIVED view is a decision: the chain-head check fails on
    // the superseded original.
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(view.supported).toBe(false);
    expect(
      view.checks.find((check) => check.check === "observation_chain_head")
        ?.satisfied,
    ).toBe(false);

    // Referencing the CURRENT chain head (the correction) derives
    // over the corrected value instead.
    const correctedView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [corrected.id],
    });
    expect(correctedView.supported).toBe(true);
    expect(correctedView.observedValue).toEqual({ value: 900, unit: "usd" });

    // The authoritative record over the superseded observation fails
    // closed.
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
  });

  test("STALE evidence fails closed: the frozen 365-day bound applies to both the baseline window and the observation collection time", async () => {
    const beyond = PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS + 35;
    // A stale BASELINE: the comparison window ended beyond the bound.
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-05 Stale Baseline Pool",
    });
    const staleBaseline = await createBaseline(harness, {
      poolId: scenario.poolId,
      evidenceIds: [scenario.evidence.id],
      baselineKind: "counterfactual",
      windowEndsDaysAgo: beyond,
      windowDays: 30,
    });
    const baselineView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: staleBaseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(baselineView.supported).toBe(false);
    expect(
      baselineView.checks.find(
        (check) => check.check === "baseline_evidence_fresh",
      )?.satisfied,
    ).toBe(false);
    expect(
      (baselineView.checks
        .find((check) => check.check === "baseline_evidence_fresh")
        ?.detail as Record<string, unknown>)["reason"],
    ).toBe("baseline_evidence_stale");

    // A stale OBSERVATION: collected beyond the bound.
    const freshScenario = await seedSavingsScenario(harness, {
      name: "AC-05 Stale Observation Pool",
    });
    const staleObservation = await createSavingsObservation(harness, {
      poolId: freshScenario.poolId,
      value: 800,
      collectedAt: daysAgoIso(beyond),
    });
    const observationView = await evaluateSavings(harness, {
      poolId: freshScenario.poolId,
      baselineId: freshScenario.baseline.id,
      outcomeObservationIds: [staleObservation.id],
    });
    expect(observationView.supported).toBe(false);
    expect(
      observationView.checks.find(
        (check) => check.check === "observation_evidence_fresh",
      )?.satisfied,
    ).toBe(false);

    // An observation collected in the FUTURE relative to the anchor
    // is equally not fresh (clock-skew defense).
    const futureObservation = await createSavingsObservation(harness, {
      poolId: freshScenario.poolId,
      value: 800,
      collectedAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const futureView = await evaluateSavings(harness, {
      poolId: freshScenario.poolId,
      baselineId: freshScenario.baseline.id,
      outcomeObservationIds: [futureObservation.id],
    });
    expect(futureView.supported).toBe(false);
    expect(
      futureView.checks.find(
        (check) => check.check === "observation_evidence_fresh",
      )?.satisfied,
    ).toBe(false);

    // The authoritative record fails closed for both staleness
    // directions.
    await expect(
      recordSavings(harness, {
        poolId: freshScenario.poolId,
        baselineId: freshScenario.baseline.id,
        outcomeObservationIds: [staleObservation.id],
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
  });

  test("mixed units fail closed (the derivation sums/compares ONE unit)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-05 Units Pool",
    });
    const eurObservation = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      value: 700,
      unit: "eur",
    });
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id, eurObservation.id],
    });
    expect(view.supported).toBe(false);
    expect(
      view.checks.find((check) => check.check === "unit_consistent")
        ?.satisfied,
    ).toBe(false);
    // The values are NOT combinable — no manufactured point claim.
    expect(view.observedValue).toBeNull();
    expect(view.savings).toBeNull();
    expect(view.confidence).toBeNull();
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id, eurObservation.id],
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
  });

  test("missing observations fail closed as a DERIVED decision (empty set is a legitimate failing input)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-05 Empty Pool",
    });
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [],
    });
    expect(view.supported).toBe(false);
    expect(
      view.checks.find((check) => check.check === "observation_present")
        ?.satisfied,
    ).toBe(false);
    expect(view.savings).toBeNull();
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [],
      }),
    ).rejects.toThrow("savings derivation is not supported");
    // The rejection carries the machine-readable failing checks.
    try {
      await recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [],
        idempotencyKey: key("w027-ac05-empty"),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProcurementSavingsError);
      const context = (error as InvalidProcurementSavingsError)
        .context as Record<string, unknown>;
      const failed = context["failedChecks"] as { readonly check: string }[];
      expect(failed.map((entry) => entry.check)).toContain(
        "observation_present",
      );
    }
  });
});
