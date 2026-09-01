/**
 * NET-W027 AC-02 — Counterfactuals preserve assumptions, method/version
 * and uncertainty: the counterfactual representation carries the
 * explicit method + version + population + window assumptions, REQUIRES
 * a quantified confidence interval (the NET-W006 rule — an exact
 * counterfactual claim without quantified uncertainty is manufactured
 * and rejected), and carries one-way invalidation semantics that fail
 * closed on every later savings derivation (issue #54 acceptance
 * criterion 2).
 *
 * Work order: spec/work-orders/NET-W027.md §4.1/§4.2 / §7 AC-02.
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
  daysAgoIso,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import {
  InvalidProcurementSavingsError,
  ProcurementSavingsConflictError,
  PROCUREMENT_BASELINE_INVALIDATION_REASONS,
} from "../../src/core/procurement-savings.ts";

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-02 counterfactual representation", () => {
  test("a counterfactual baseline REQUIRES a quantified confidence interval (the W006-aligned rule)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-02 Interval Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac02-interval");

    // A point-only counterfactual is manufactured uncertainty —
    // rejected at creation.
    await expect(
      createBaseline(harness, {
        poolId: scenario.poolId,
        evidenceIds: [scenario.evidence.id],
        ctx,
        baselineKind: "counterfactual",
        confidence: { point: 0.9 },
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
    await expect(
      createBaseline(harness, {
        poolId: scenario.poolId,
        evidenceIds: [scenario.evidence.id],
        ctx,
        baselineKind: "counterfactual",
        confidence: { point: 0.9, lower: 0.8 },
      }),
    ).rejects.toThrow(
      "a counterfactual baseline requires a quantified confidence interval",
    );

    // The quantified-interval counterfactual IS creatable (the seed
    // default).
    expect(scenario.baseline.baselineKind).toBe("counterfactual");
    expect(scenario.baseline.confidence.lower).toBe(0.8);
    expect(scenario.baseline.confidence.upper).toBe(0.95);
  });

  test("the counterfactual assumptions — method, version, population, window — are explicit and versioned on the record", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-02 Assumptions Pool",
    });
    const baseline = await createBaseline(harness, {
      poolId: scenario.poolId,
      evidenceIds: [scenario.evidence.id],
      baselineKind: "counterfactual",
      method: "matched_control",
      methodVersion: "3",
      population: "Matched-control population of comparable procurement",
      windowDays: 90,
    });
    expect(baseline.method).toBe("matched_control");
    expect(baseline.methodVersion).toBe("3");
    expect(baseline.population).toContain("Matched-control");
    // The 90-day historical window round-trips exactly.
    expect(
      Date.parse(baseline.comparisonWindow.endsAt) -
        Date.parse(baseline.comparisonWindow.startsAt),
    ).toBe(90 * 24 * 60 * 60 * 1000);
    // A distinct method/version is a DISTINCT baseline (lineage, not
    // mutation): a second baseline coexists.
    const second = await createBaseline(harness, {
      poolId: scenario.poolId,
      evidenceIds: [scenario.evidence.id],
      baselineKind: "baseline",
      method: "market_index",
      methodVersion: "1",
    });
    expect(second.id).not.toBe(baseline.id);
    expect(second.method).toBe("market_index");
  });

  test("invalidation is ONE-WAY with a closed reason vocabulary; a second invalidation conflicts", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-02 Invalidation Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac02-invalidate");
    const firstKey = key("w027-ac02-invalidate");

    const invalidated = await harness.runtime.procurementSavingsService
      .invalidateProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        baselineId: scenario.baseline.id,
        reason: "population_changed",
        idempotencyKey: firstKey,
      });
    expect(invalidated.invalidatedAt).toBeTruthy();
    expect(invalidated.invalidationReason).toBe("population_changed");

    // The invalidation audit event commits atomically.
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_baseline.invalidated",
      resourceId: scenario.baseline.id,
    });
    expect(events.length).toBe(1);

    // A FRESH key invalidating the already-invalidated baseline is a
    // stable conflict (one-way semantics — invalidation is terminal).
    await expect(
      harness.runtime.procurementSavingsService.invalidateProcurementBaseline(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          baselineId: scenario.baseline.id,
          reason: "quality_review",
          idempotencyKey: key("w027-ac02-invalidate-2"),
        },
      ),
    ).rejects.toThrow(ProcurementSavingsConflictError);

    // Same-key replay is exactly-once (the invalidated record returns
    // unchanged).
    const replay = await harness.runtime.procurementSavingsService
      .invalidateProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        baselineId: scenario.baseline.id,
        reason: "population_changed",
        idempotencyKey: firstKey,
      });
    expect(replay.invalidatedAt).toBe(invalidated.invalidatedAt);

    // The closed invalidation-reason vocabulary rejects unknown
    // reasons.
    const freshScenario = await seedSavingsScenario(harness, {
      name: "AC-02 Reason Pool",
    });
    await expect(
      harness.runtime.procurementSavingsService.invalidateProcurementBaseline(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          baselineId: freshScenario.baseline.id,
          reason: "changed_my_mind",
          idempotencyKey: key("w027-ac02-bad-reason"),
        },
      ),
    ).rejects.toThrow(InvalidProcurementSavingsError);
    expect(PROCUREMENT_BASELINE_INVALIDATION_REASONS).toContain(
      "population_changed",
    );
  });

  test("an invalidated baseline FAILS CLOSED for every later savings derivation (the record command and the check verdict)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-02 Fail-Closed Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac02-fail-closed");

    // Before invalidation the derivation is supported.
    const before = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(before.supported).toBe(true);

    await harness.runtime.procurementSavingsService
      .invalidateProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        baselineId: scenario.baseline.id,
        reason: "evidence_withdrawn",
        idempotencyKey: key("w027-ac02-fc-invalidate"),
      });

    // The DERIVED view is still a 200 decision — with the
    // baseline_valid check failing.
    const after = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(after.supported).toBe(false);
    const baselineValid = after.checks.find(
      (check) => check.check === "baseline_valid",
    );
    expect(baselineValid?.satisfied).toBe(false);
    expect(
      (baselineValid?.detail as Record<string, unknown>)["reason"],
    ).toBe("baseline_invalidated");

    // The AUTHORITATIVE record fails closed.
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
      }),
    ).rejects.toThrow(InvalidProcurementSavingsError);
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
      }),
    ).rejects.toThrow("savings derivation is not supported");
  });

  test("a plain `baseline` kind is a legitimate measured reference (point confidence allowed; the interval check passes for it)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-02 Plain Pool",
      baselineKind: "baseline",
    });
    expect(scenario.baseline.baselineKind).toBe("baseline");

    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(view.supported).toBe(true);
    const kindInterval = view.checks.find(
      (check) => check.check === "baseline_kind_interval",
    );
    expect(kindInterval?.satisfied).toBe(true);
  });
});
