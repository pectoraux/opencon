/**
 * NET-W027 AC-03 — Realized savings derive only from an authoritative
 * baseline + outcome/counterfactual evidence: the server owns the
 * arithmetic; offer price, spend, reputation, raw activity or caller
 * arithmetic alone cannot produce a verified savings claim (issue #54
 * acceptance criterion 3).
 *
 * Work order: spec/work-orders/NET-W027.md §4.3/§4.4 / §7 AC-03.
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
  key,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import { seedCompetitivePool, recordCompetitiveSelection } from "./_net-w026-harness.ts";
import {
  InvalidProcurementSavingsError,
} from "../../src/core/procurement-savings.ts";
import { NotFoundError } from "../../src/core/errors.ts";

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-03 authoritative derivation only", () => {
  test("the derivation is SERVER-OWNED arithmetic over the explicit baseline + authoritative observations", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-03 Arithmetic Pool",
    });
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });

    expect(view.supported).toBe(true);
    // savings = baseline (1000) − observed (800): the SERVER derived it.
    expect(view.baselineValue).toEqual({ value: 1000, unit: "usd" });
    expect(view.observedValue).toEqual({ value: 800, unit: "usd" });
    expect(view.savings).toEqual({ value: 200, unit: "usd" });
    // Multiple observations SUM (each is a realized savings event).
    const second = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      value: 50,
    });
    const twoView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id, second.id],
    });
    expect(twoView.observedValue).toEqual({ value: 850, unit: "usd" });
    expect(twoView.savings).toEqual({ value: 150, unit: "usd" });
    // A negative outcome is an honest realized dis-savings finding
    // (observed above baseline) — reported, not clamped.
    const expensive = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      value: 1100,
    });
    const negativeView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [expensive.id],
    });
    expect(negativeView.savings).toEqual({ value: -100, unit: "usd" });
    expect(negativeView.supported).toBe(true);
  });

  test("caller-asserted savings fields are IGNORED — no input can value or support the claim", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-03 Caller Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac03-caller");
    const junkInput = {
      organizationScopeId: harness.organizationScopeId,
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
      // Caller-asserted savings/support fields — NONE of these are
      // inputs of the contract; the command ignores them entirely.
      savings: { value: 99999, unit: "usd" },
      savingsValue: 99999,
      supported: true,
      confidence: { point: 1, lower: 1, upper: 1 },
      observedValue: { value: 1, unit: "usd" },
    };
    const view = await harness.runtime.procurementSavingsService
      .evaluateProcurementSavings(ctx, junkInput);
    expect(view.savings).toEqual({ value: 200, unit: "usd" });
    expect(view.confidence?.point).toBe(0.9);
    expect(view.supported).toBe(true);

    // The same junk on the AUTHORITATIVE record: the persisted
    // snapshot carries the server-derived values only.
    const record = await harness.runtime.procurementSavingsService
      .recordProcurementSavings(ctx, {
        ...junkInput,
        idempotencyKey: key("w027-ac03-caller"),
      });
    expect(record.savings.savings).toEqual({ value: 200, unit: "usd" });
    expect(record.savings.confidence?.point).toBe(0.9);
    expect(record.savings.supported).toBe(true);
  });

  test("offer prices alone cannot produce a savings claim: a competitive pool with offers but NO realized-outcome observations fails closed", async () => {
    // The full W026 competition model: qualified pool + THREE
    // competing supplier offers + a recorded selection. NONE of it
    // is savings truth.
    const pool = await seedCompetitivePool(harness.w026, {
      name: "AC-03 Offers Pool",
    });
    const selection = await recordCompetitiveSelection(harness.w026, {
      poolId: pool.id,
    });
    const evidence = await createPoolEvidence(harness, { poolId: pool.id });
    const baseline = await createBaseline(harness, {
      poolId: pool.id,
      evidenceIds: [evidence.id],
    });

    // With offers + selection + baseline but NO observations, the
    // derivation fails closed (observation_present).
    const view = await evaluateSavings(harness, {
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [],
      selectionId: selection.id,
    });
    expect(view.supported).toBe(false);
    expect(
      view.checks.find((check) => check.check === "observation_present")
        ?.satisfied,
    ).toBe(false);
    expect(view.observedValue).toBeNull();
    expect(view.savings).toBeNull();

    // The authoritative record fails closed.
    await expect(
      recordSavings(harness, {
        poolId: pool.id,
        baselineId: baseline.id,
        outcomeObservationIds: [],
        selectionId: selection.id,
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
  });

  test("the W026 selection reference is NEUTRAL lineage — it never enters the derivation facts", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-03 Lineage Pool",
    });
    // A selection on a pool with no offers: the derived selection has
    // no eligible offers (null selection) — but it still records
    // lineage.
    const selection = await recordCompetitiveSelection(harness.w026, {
      poolId: scenario.poolId,
    });

    const withLineage = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
      selectionId: selection.id,
    });
    const withoutLineage = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    // The selection reference does NOT touch the derivation: same
    // digest, same values, same checks (offer/selection context is
    // lineage, never savings truth).
    expect(withLineage.digest).toBe(withoutLineage.digest);
    expect(withLineage.savings).toEqual(withoutLineage.savings);
    expect(withLineage.checks).toEqual(withoutLineage.checks);

    // The RECORD carries the neutral reference; an INVALID reference
    // fails closed (scope/pool validated, indistinguishable).
    const record = await recordSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
      selectionId: selection.id,
    });
    expect(record.selectionId).toBe(selection.id);
    await expect(
      evaluateSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
        selectionId: key("w027-nonexistent-selection"),
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("observations that are not THIS pool's realized savings outcomes fail closed", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-03 Subject Pool",
    });
    const otherScenario = await seedSavingsScenario(harness, {
      name: "AC-03 Other Subject Pool",
    });

    // An observation bound to ANOTHER pool: subject-binding failure.
    const wrongSubjectView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [otherScenario.observation.id],
    });
    expect(wrongSubjectView.supported).toBe(false);
    expect(
      wrongSubjectView.checks.find(
        (check) => check.check === "observation_subject_bound",
      )?.satisfied,
    ).toBe(false);

    // A cross-scope observation id is indistinguishable from a
    // nonexistent one (no existence oracle).
    const otherScopeObservation = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      organizationScopeId: "w027-other-tenant-scope",
    });
    await expect(
      evaluateSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [otherScopeObservation.id],
      }),
    ).rejects.toThrow(NotFoundError);

    // An observation of the WRONG outcome type (purchase, not
    // savings) fails closed.
    const ctx = poolCreatorCtx(harness, "w027-ac03-wrong-type");
    const purchaseObservation =
      await harness.runtime.outcomeObservationService.createOutcomeObservation(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          observerId: (ctx.actor as { readonly id: string }).id,
          subjectReference: {
            subjectId: scenario.poolId,
            subjectType: "procurement_pool",
          },
          outcomeType: "purchase",
          observedValue: { value: 700, unit: "usd" },
          confidence: { point: 0.95 },
          provenance: {
            sourceType: "platform",
            method: "procurement-fulfillment-ledger",
            methodVersion: "1",
          },
        },
      );
    const wrongTypeView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [purchaseObservation.id],
    });
    expect(wrongTypeView.supported).toBe(false);
    expect(
      wrongTypeView.checks.find(
        (check) => check.check === "observation_outcome_type_savings",
      )?.satisfied,
    ).toBe(false);
  });

  test("a baseline of ANOTHER pool is never a valid reference for this pool's derivation", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-03 Baseline Pool A",
    });
    const other = await seedSavingsScenario(harness, {
      name: "AC-03 Baseline Pool B",
    });
    await expect(
      evaluateSavings(harness, {
        poolId: scenario.poolId,
        baselineId: other.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
    await expect(
      evaluateSavings(harness, {
        poolId: scenario.poolId,
        baselineId: other.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
      }),
    ).rejects.toThrow("does not belong to pool");
  });
});
