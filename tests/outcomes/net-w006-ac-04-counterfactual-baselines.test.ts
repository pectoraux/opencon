/**
 * NET-W006-AC-04 — Explicit counterfactual/baselines.
 *
 * Counterfactual/baseline measurements are explicit and auditable:
 *  - distinct kinds (`counterfactual` = estimated no-treatment outcome;
 *    `baseline` = reference level);
 *  - method/version provenance REQUIRED;
 *  - quantified uncertainty (interval REQUIRED for counterfactuals —
 *    an exact counterfactual claim without quantified uncertainty is
 *    manufactured and rejected);
 *  - optional comparison (observed) values;
 *  - atomic audit lineage.
 *
 * Evidence: baseline/counterfactual domain tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW006Harness,
  actorCtx,
  createMeasuredSubject,
  type NetW006Harness,
} from "./_net-w006-harness.ts";
import type { CounterfactualBaseline } from "../../src/outcomes/port.ts";

let harness: NetW006Harness;

beforeEach(async () => {
  harness = await createNetW006Harness();
});

afterEach(async () => {
  await harness.teardown();
});

interface BaselineOptions {
  readonly baselineKind?: string;
  readonly point?: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly withComparison?: boolean;
}

async function createBaseline(
  subjectId: string,
  opts: BaselineOptions = {},
): Promise<CounterfactualBaseline> {
  const ctx = actorCtx(harness, "ac04-baseline");
  return harness.runtime.baselineService.createCounterfactualBaseline(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId, subjectType: "contribution" },
    outcomeType: "savings",
    baselineKind: opts.baselineKind ?? "counterfactual",
    baselineValue: { value: 5000, unit: "USD" },
    ...(opts.withComparison ? { comparisonValue: { value: 6200, unit: "USD" } } : {}),
    confidence: {
      point: opts.point ?? 0.8,
      ...(opts.lower !== undefined ? { lower: opts.lower } : {}),
      ...(opts.upper !== undefined ? { upper: opts.upper } : {}),
    },
    provenance: {
      sourceType: "platform",
      sourceId: "procurement-analytics",
      method: "matched-market",
      methodVersion: "3.1.0",
    },
  });
}

describe("NET-W006-AC-04 explicit counterfactual/baselines", () => {
  test("a counterfactual records the no-treatment estimate with method/version + quantified interval + comparison", async () => {
    const subject = await createMeasuredSubject(harness);
    const baseline = await createBaseline(subject.id, {
      baselineKind: "counterfactual",
      lower: 0.7,
      upper: 0.9,
      withComparison: true,
    });
    expect(baseline.baselineKind).toBe("counterfactual");
    expect(baseline.outcomeType).toBe("savings");
    expect(baseline.baselineValue).toEqual({ value: 5000, unit: "USD" });
    expect(baseline.comparisonValue).toEqual({ value: 6200, unit: "USD" });
    expect(baseline.confidence.lower).toBe(0.7);
    expect(baseline.confidence.upper).toBe(0.9);
    expect(baseline.provenance.method).toBe("matched-market");
    expect(baseline.provenance.methodVersion).toBe("3.1.0");
    // Auditable: the audit record committed atomically with the record.
    const events = await harness.runtime.auditWriter.query({
      eventType: "counterfactual_baseline.created",
      resourceId: baseline.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toMatchObject({
      baselineKind: "counterfactual",
      baselineValue: 5000,
      comparisonValue: 6200,
      methodVersion: "3.1.0",
    });
  });

  test("a plain baseline (reference level) needs no interval", async () => {
    const subject = await createMeasuredSubject(harness);
    const baseline = await createBaseline(subject.id, {
      baselineKind: "baseline",
      point: 0.9,
    });
    expect(baseline.baselineKind).toBe("baseline");
    expect(baseline.comparisonValue).toBeNull();
    expect(baseline.confidence.lower).toBeUndefined();
  });

  test("a counterfactual WITHOUT a quantified interval is rejected (manufactured exactness)", async () => {
    const subject = await createMeasuredSubject(harness);
    try {
      await createBaseline(subject.id, { baselineKind: "counterfactual", point: 0.8 });
      throw new Error("expected interval-less counterfactual to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
      expect((oce as { context?: Record<string, unknown> }).context).toMatchObject({
        baselineKind: "counterfactual",
      });
    }
  });

  test("an unknown baselineKind is rejected with a stable error code", async () => {
    const subject = await createMeasuredSubject(harness);
    try {
      await createBaseline(subject.id, { baselineKind: "wishful-thinking" });
      throw new Error("expected unknown baselineKind to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("the outcome type must come from the OUT-001 vocabulary", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac04-type");
    try {
      await harness.runtime.baselineService.createCounterfactualBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType: "good-vibes" as "savings",
        baselineKind: "baseline",
        baselineValue: { value: 1, unit: "vibes" },
        confidence: { point: 0.9 },
        provenance: {
          sourceType: "platform",
          method: "none",
          methodVersion: "1.0.0",
        },
      });
      throw new Error("expected unsupported outcome type to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("UNSUPPORTED_OUTCOME_TYPE");
    }
  });

  test("baselines persist durably through the authoritative store with lineage", async () => {
    const subject = await createMeasuredSubject(harness);
    const baseline = await createBaseline(subject.id, {
      baselineKind: "baseline",
      point: 0.9,
    });
    const rec = await harness.runtime.postgresAuthority.get<{ id: string }>(
      "counterfactual_baselines",
      baseline.id,
    );
    expect(rec).not.toBeNull();
    expect(rec!.value.id).toBe(baseline.id);
    expect(rec!.executionId).toBe(baseline.executionId);

    const fetched = await harness.runtime.baselineService.getCounterfactualBaseline(
      actorCtx(harness, "ac04-read"),
      baseline.id,
    );
    expect(fetched).toEqual(baseline);
  });
});
