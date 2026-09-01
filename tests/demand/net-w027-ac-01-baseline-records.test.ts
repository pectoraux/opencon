/**
 * NET-W027 AC-01 — Baselines are first-class, explicit, versioned and
 * provenance-backed: durable, tenant/pool-scoped, pool-creator-
 * authorized records with method/version lineage, bounded historical
 * windows, traceable subject-bound evidence references and record-
 * format lineage; invalid vocabulary, bounds, provenance, confidence
 * or evidence references fail closed (issue #54 acceptance
 * criterion 1).
 *
 * Work order: spec/work-orders/NET-W027.md §4.1 / §7 AC-01.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW027Harness,
  createBaseline,
  createPoolEvidence,
  createSavingsObservation,
  seedSavingsScenario,
  poolCreatorCtx,
  key,
  daysAgoIso,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import { personCtx } from "./_net-w026-harness.ts";
import {
  PROCUREMENT_BASELINE_RECORD_FORMAT,
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

describe("NET-W027-AC-01 first-class baseline records", () => {
  test("a baseline is a durable, tenant/pool-scoped, versioned, provenance-backed record with the exact contract", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-01 Record Pool",
    });

    const baseline = scenario.baseline;
    expect(baseline.id).toBeTruthy();
    expect(baseline.organizationScopeId).toBe(harness.organizationScopeId);
    expect(baseline.poolId).toBe(scenario.poolId);
    // The creator IS the acting pool creator — server-resolved.
    expect(baseline.createdBy).toBe(harness.w026.w025.buyerAPersonId);
    // The explicit kind + closed-vocabulary method + REQUIRED version
    // (method identity never collapsed).
    expect(baseline.baselineKind).toBe("counterfactual");
    expect(baseline.method).toBe("prior_period");
    expect(baseline.methodVersion).toBe("1");
    // The bounded HISTORICAL comparison window round-trips (30-day
    // duration, ending 1 day before submission — never exact
    // wall-clock instants: the same-millisecond pitfall).
    expect(
      Date.parse(baseline.comparisonWindow.endsAt) -
        Date.parse(baseline.comparisonWindow.startsAt),
    ).toBe(30 * 24 * 60 * 60 * 1000);
    expect(Date.parse(baseline.comparisonWindow.endsAt)).toBeLessThan(
      Date.now(),
    );
    // The bounded population/assumptions description.
    expect(baseline.population).toContain("Historical spend");
    // The baseline value + unit and the quantified confidence.
    expect(baseline.baselineValue).toEqual({ value: 1000, unit: "usd" });
    expect(baseline.confidence.point).toBe(0.9);
    expect(baseline.confidence.lower).toBe(0.8);
    expect(baseline.confidence.upper).toBe(0.95);
    // The measurement provenance (sourceType + method + version +
    // collectedAt).
    expect(baseline.provenance.sourceType).toBe("platform");
    expect(baseline.provenance.method).toBe("prior_period");
    expect(baseline.provenance.methodVersion).toBe("1");
    expect(typeof baseline.provenance.collectedAt).toBe("string");
    // The traceable evidence references round-trip.
    expect(baseline.evidenceIds).toEqual([scenario.evidence.id]);
    // One-way invalidation fields start clean.
    expect(baseline.invalidatedAt).toBeNull();
    expect(baseline.invalidationReason).toBeNull();
    // Record-format + idempotency/execution lineage.
    expect(baseline.recordFormat).toBe(PROCUREMENT_BASELINE_RECORD_FORMAT);
    expect(typeof baseline.idempotencyKey).toBe("string");
    expect(typeof baseline.executionId).toBe("string");
    expect(typeof baseline.correlationId).toBe("string");
    // The audit event commits atomically with the record.
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_baseline.created",
      resourceId: baseline.id,
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata["organizationScopeId"]).toBe(harness.organizationScopeId);
    expect(metadata["poolId"]).toBe(scenario.poolId);
    expect(metadata["baselineKind"]).toBe("counterfactual");
    expect(metadata["method"]).toBe("prior_period");
    expect(metadata["evidenceIds"]).toEqual([scenario.evidence.id]);
    expect(metadata["transactionId"]).toBeTruthy();
  });

  test("same-key replay is exactly-once (one durable record, one audit event)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-01 Replay Pool",
    });
    const idempotencyKey = key("w027-ac01-replay");
    const ctx = poolCreatorCtx(harness, "w027-ac01-replay");

    const first = await harness.runtime.procurementSavingsService
      .createProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
        baselineKind: "baseline",
        method: "market_index",
        methodVersion: "2",
        comparisonWindow: {
          startsAt: daysAgoIso(31),
          endsAt: daysAgoIso(1),
        },
        population: "Market index reference population",
        baselineValue: { value: 900, unit: "usd" },
        confidence: { point: 0.85 },
        provenance: { sourceType: "attested", collectedAt: daysAgoIso(1) },
        evidenceIds: [scenario.evidence.id],
        idempotencyKey,
      });
    expect(first.created).toBe(true);

    // A FRESH execution context with the SAME key replays the
    // committed record exactly once.
    const replayCtx = poolCreatorCtx(harness, "w027-ac01-replay-2");
    const replay = await harness.runtime.procurementSavingsService
      .createProcurementBaseline(replayCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
        baselineKind: "baseline",
        method: "market_index",
        methodVersion: "2",
        comparisonWindow: {
          startsAt: daysAgoIso(31),
          endsAt: daysAgoIso(1),
        },
        population: "Market index reference population",
        baselineValue: { value: 900, unit: "usd" },
        confidence: { point: 0.85 },
        provenance: { sourceType: "attested", collectedAt: daysAgoIso(1) },
        evidenceIds: [scenario.evidence.id],
        idempotencyKey,
      });
    expect(replay.created).toBe(false);
    expect(replay.baseline).toEqual(first.baseline);

    const baselines = await harness.runtime.procurementSavingsService
      .listPoolBaselines(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      });
    expect(
      baselines.filter((entry) => entry.id === first.baseline.id).length,
    ).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_baseline.created",
      resourceId: first.baseline.id,
    });
    expect(events.length).toBe(1);
  });

  test("closed vocabularies and bounds fail closed", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-01 Validation Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac01-validation");
    const base = {
      organizationScopeId: harness.organizationScopeId,
      poolId: scenario.poolId,
      baselineKind: "baseline",
      method: "prior_period",
      methodVersion: "1",
      comparisonWindow: {
        startsAt: daysAgoIso(31),
        endsAt: daysAgoIso(1),
      },
      population: "Historical spend population",
      baselineValue: { value: 1000, unit: "usd" },
      confidence: { point: 0.9 },
      provenance: { sourceType: "platform", collectedAt: daysAgoIso(1) },
      evidenceIds: [scenario.evidence.id],
      idempotencyKey: key("w027-ac01-valid"),
    };

    const cases: readonly { readonly name: string; readonly input: Record<string, unknown> }[] =
      [
        {
          name: "unknown baseline kind",
          input: { baselineKind: "projection" },
        },
        {
          name: "unknown method",
          input: { method: "ai_projection" },
        },
        {
          name: "empty method version",
          input: { methodVersion: "" },
        },
        {
          name: "too-short window",
          input: {
            comparisonWindow: { startsAt: daysAgoIso(1), endsAt: daysAgoIso(1) },
          },
        },
        {
          name: "too-long window",
          input: {
            comparisonWindow: { startsAt: daysAgoIso(400), endsAt: daysAgoIso(1) },
          },
        },
        {
          name: "future window end",
          input: {
            comparisonWindow: {
              startsAt: daysAgoIso(31),
              endsAt: new Date(Date.now() + 86400000).toISOString(),
            },
          },
        },
        {
          name: "missing population",
          input: { population: "" },
        },
        {
          name: "value out of bounds",
          input: { baselineValue: { value: -5, unit: "usd" } },
        },
        {
          name: "empty unit",
          input: { baselineValue: { value: 100, unit: "" } },
        },
        {
          name: "empty evidence references",
          input: { evidenceIds: [] },
        },
        {
          name: "unknown provenance source type",
          input: { provenance: { sourceType: "oracle", collectedAt: daysAgoIso(1) } },
        },
        {
          name: "future provenance collection",
          input: {
            provenance: {
              sourceType: "platform",
              collectedAt: new Date(Date.now() + 86400000).toISOString(),
            },
          },
        },
      ];
    for (const testCase of cases) {
      const promise = harness.runtime.procurementSavingsService
        .createProcurementBaseline(ctx, {
          ...base,
          ...testCase.input,
          idempotencyKey: key("w027-ac01-invalid"),
        } as typeof base);
      await expect(promise).rejects.toThrow(InvalidProcurementSavingsError);
    }
  });

  test("evidence references resolve fail-closed through the neutral /evidence lookup", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-01 Evidence Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac01-evidence");

    // An unknown evidence id is indistinguishable from a cross-tenant
    // one (no existence oracle).
    const unknown = harness.runtime.procurementSavingsService
      .createProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
        baselineKind: "baseline",
        method: "prior_period",
        methodVersion: "1",
        comparisonWindow: { startsAt: daysAgoIso(31), endsAt: daysAgoIso(1) },
        population: "Historical spend population",
        baselineValue: { value: 1000, unit: "usd" },
        confidence: { point: 0.9 },
        provenance: { sourceType: "platform", collectedAt: daysAgoIso(1) },
        evidenceIds: [key("w027-nonexistent-evidence")],
        idempotencyKey: key("w027-ac01-unknown-evidence"),
      });
    await expect(unknown).rejects.toThrow(NotFoundError);
    await expect(unknown).rejects.toThrow(
      "evidence record not found: w027-nonexistent-evidence",
    );

    // A cross-scope evidence record is equally "not found".
    const otherScopeEvidence = await createPoolEvidence(harness, {
      poolId: scenario.poolId,
      ctx,
      organizationScopeId: "w027-other-tenant-scope",
    });
    const crossScope = harness.runtime.procurementSavingsService
      .createProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
        baselineKind: "baseline",
        method: "prior_period",
        methodVersion: "1",
        comparisonWindow: { startsAt: daysAgoIso(31), endsAt: daysAgoIso(1) },
        population: "Historical spend population",
        baselineValue: { value: 1000, unit: "usd" },
        confidence: { point: 0.9 },
        provenance: { sourceType: "platform", collectedAt: daysAgoIso(1) },
        evidenceIds: [otherScopeEvidence.id],
        idempotencyKey: key("w027-ac01-cross-scope"),
      });
    await expect(crossScope).rejects.toThrow(NotFoundError);

    // An evidence record bound to ANOTHER subject is a binding
    // violation (it exists in scope — the binding rule names it).
    const otherPool = await seedSavingsScenario(harness, {
      name: "AC-01 Other Pool",
    });
    const wrongSubject = harness.runtime.procurementSavingsService
      .createProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
        baselineKind: "baseline",
        method: "prior_period",
        methodVersion: "1",
        comparisonWindow: { startsAt: daysAgoIso(31), endsAt: daysAgoIso(1) },
        population: "Historical spend population",
        baselineValue: { value: 1000, unit: "usd" },
        confidence: { point: 0.9 },
        provenance: { sourceType: "platform", collectedAt: daysAgoIso(1) },
        evidenceIds: [otherPool.evidence.id],
        idempotencyKey: key("w027-ac01-wrong-subject"),
      });
    await expect(wrongSubject).rejects.toThrow(InvalidProcurementSavingsError);
    await expect(wrongSubject).rejects.toThrow(
      "evidence reference is not bound to this procurement pool",
    );
  });

  test("non-creator members fail closed; the baseline listing is pool-creator-only", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-01 Authorization Pool",
    });
    const creatorCtx = poolCreatorCtx(harness, "w027-ac01-auth-creator");

    // A buyer-B member (tenant member, NOT the pool creator).
    const buyerBCtx = personCtx(
      harness.w026.w025.buyerBPersonId,
      "w027-ac01-auth-buyer-b",
    );
    await expect(
      createBaseline(harness, {
        poolId: scenario.poolId,
        evidenceIds: [scenario.evidence.id],
        ctx: buyerBCtx,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // A supplier-side member is equally not the creator.
    const supplierCtx = personCtx(
      harness.w026.supplierAPersonId,
      "w027-ac01-auth-supplier",
    );
    await expect(
      createBaseline(harness, {
        poolId: scenario.poolId,
        evidenceIds: [scenario.evidence.id],
        ctx: supplierCtx,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // The listing gate mirrors the mutation gate.
    await expect(
      harness.runtime.procurementSavingsService.listPoolBaselines(buyerBCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // The creator sees the pool's baselines (the seed's baseline).
    const listed = await harness.runtime.procurementSavingsService
      .listPoolBaselines(creatorCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      });
    expect(listed.map((entry) => entry.id)).toContain(
      scenario.baseline.id,
    );
  });
});
