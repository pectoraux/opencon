/**
 * NET-W005-AC-04 — Evidence aggregation without exposure (EVID-004).
 *
 * Multiple independent evidence sources can be aggregated
 * deterministically (grade-weighted confidence + conservative interval
 * envelope + independence count) WITHOUT exposing raw sensitive
 * records — aggregation consumes durable evidence records only.
 *
 * Evidence: aggregation unit tests (determinism, weights, independence,
 * no-raw-payload) + the Proof-of-Value aggregation integration test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  aggregateEvidence,
  hasHighSupportEvidence,
} from "../../src/evidence/aggregation.ts";
import type { Evidence } from "../../src/evidence/port.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  createEvidence,
  createProofOfValue,
  povTransitionInput,
  type NetW005Harness,
} from "./_net-w005-harness.ts";

/** Build a minimal evidence record for pure-function tests. */
function evidenceOf(
  overrides: Partial<Evidence> & { grade: Evidence["grade"]; point: number },
): Evidence {
  const base: Evidence = {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    organizationScopeId: "org-1",
    ownerId: "person-1",
    subjectReference: { subjectId: "sub-1", subjectType: "contribution" },
    provenance: {
      sourceType: "platform",
      method: "test",
      collectedAt: "2026-01-01T00:00:00.000Z",
    },
    grade: overrides.grade,
    confidence: { point: overrides.point },
    sensitivity: "standard",
    payload: null,
    commitment: null,
    payloadReference: null,
    executionId: "exec-1",
    correlationId: "corr-1",
    causationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    confidence: {
      point: overrides.point,
      ...(overrides.confidence ?? {}),
    },
    provenance: {
      ...(base.provenance ?? {}),
      ...(overrides.provenance ?? {}),
    } as Evidence["provenance"],
  };
}

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W005-AC-04 evidence aggregation (pure function)", () => {
  test("aggregating zero evidence records is a deterministic validation error", () => {
    expect(() => aggregateEvidence([])).toThrow(/AGGREGATION_REQUIRES_EVIDENCE|at least one evidence record/i);
  });

  test("the aggregate point is the grade-weighted mean of contributing point estimates", () => {
    // MEASURED (w=1.0, point=0.9) + SELF_REPORTED (w=0.2, point=0.5):
    // weighted mean = (1.0*0.9 + 0.2*0.5) / 1.2 = 0.8333...
    const result = aggregateEvidence([
      evidenceOf({ grade: "MEASURED", point: 0.9 }),
      evidenceOf({ grade: "SELF_REPORTED", point: 0.5 }),
    ]);
    expect(result.evidenceCount).toBe(2);
    expect(result.totalWeight).toBe(1.2);
    expect(result.aggregatePoint).toBeCloseTo((1.0 * 0.9 + 0.2 * 0.5) / 1.2, 12);
    expect(result.dominantGrade).toBe("MEASURED");
    expect(result.gradesPresent).toEqual(["MEASURED", "SELF_REPORTED"]);
  });

  test("higher-grade evidence pulls the aggregate toward its estimate (weights matter)", () => {
    // Two records with the same point spread but different grades: the
    // MEASURED-dominant aggregate must sit closer to the MEASURED point.
    const measuredHeavy = aggregateEvidence([
      evidenceOf({ grade: "MEASURED", point: 1.0 }),
      evidenceOf({ grade: "SELF_REPORTED", point: 0.0 }),
    ]);
    // (1.0*1.0 + 0.2*0.0) / 1.2 = 0.8333
    expect(measuredHeavy.aggregatePoint).toBeCloseTo(0.8333333333, 10);
    const selfHeavy = aggregateEvidence([
      evidenceOf({ grade: "SELF_REPORTED", point: 1.0 }),
      evidenceOf({ grade: "MEASURED", point: 0.0 }),
    ]);
    // (0.2*1.0 + 1.0*0.0) / 1.2 = 0.1667
    expect(selfHeavy.aggregatePoint).toBeCloseTo(0.1666666667, 10);
  });

  test("independence counts DISTINCT sources; same-source records are not independent", () => {
    const result = aggregateEvidence([
      evidenceOf({
        grade: "MEASURED",
        point: 0.9,
        provenance: { sourceId: "source-a", sourceType: "platform", method: "m", collectedAt: "t" },
      }),
      evidenceOf({
        grade: "MEASURED",
        point: 0.85,
        provenance: { sourceId: "source-a", sourceType: "platform", method: "m", collectedAt: "t" },
      }),
      evidenceOf({
        grade: "PROVIDER_REPORTED",
        point: 0.7,
        provenance: { sourceId: "source-b", sourceType: "provider", method: "m", collectedAt: "t" },
      }),
    ]);
    expect(result.evidenceCount).toBe(3);
    // source-a twice + source-b once = 2 DISTINCT sources (conservative).
    expect(result.independentSources).toBe(2);
  });

  test("the interval is a CONSERVATIVE envelope over contributing intervals (EVID-005 preserved)", () => {
    const result = aggregateEvidence([
      evidenceOf({ grade: "MEASURED", point: 0.9, confidence: { point: 0.9, lower: 0.85, upper: 0.95 } }),
      evidenceOf({ grade: "ATTESTED", point: 0.6, confidence: { point: 0.6, lower: 0.4, upper: 0.99 } }),
    ]);
    expect(result.aggregateInterval).not.toBeNull();
    expect(result.aggregateInterval!.lower).toBe(0.4);
    expect(result.aggregateInterval!.upper).toBe(0.99);
  });

  test("the interval is null when NO record quantifies uncertainty (never manufactured)", () => {
    const result = aggregateEvidence([
      evidenceOf({ grade: "MEASURED", point: 0.9 }),
      evidenceOf({ grade: "ATTESTED", point: 0.6 }),
    ]);
    expect(result.aggregateInterval).toBeNull();
  });

  test("aggregation is DETERMINISTIC: same inputs → identical output", () => {
    const records = [
      evidenceOf({
        id: "fixed-1",
        grade: "MEASURED",
        point: 0.9,
        provenance: { sourceId: "s1", sourceType: "platform", method: "m", collectedAt: "t" },
        confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      }),
      evidenceOf({
        id: "fixed-2",
        grade: "MODEL_ASSESSED",
        point: 0.5,
        provenance: { sourceId: "s2", sourceType: "model", method: "m", collectedAt: "t" },
      }),
    ];
    const a = JSON.stringify(aggregateEvidence(records));
    const b = JSON.stringify(aggregateEvidence(records));
    expect(a).toBe(b);
  });

  test("the aggregate result contains NO raw payload fields (no exposure)", () => {
    const records = [
      evidenceOf({ grade: "MEASURED", point: 0.9, payload: { raw: "activity-log-xyz" } }),
      evidenceOf({
        grade: "MEASURED",
        point: 0.8,
        sensitivity: "sensitive",
        payload: null,
        commitment: { algorithm: "sha256", digest: "a".repeat(64) },
      }),
    ];
    const result = aggregateEvidence(records);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw");
    expect(serialized).not.toContain("activity-log");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("sensitivePayload");
    // The result surface is exactly the aggregate facts.
    expect(Object.keys(result).sort()).toEqual([
      "aggregateInterval",
      "aggregatePoint",
      "dominantGrade",
      "evidenceCount",
      "gradesPresent",
      "independentSources",
      "totalWeight",
    ]);
  });

  test("hasHighSupportEvidence requires MEASURED or ATTESTED records", () => {
    expect(
      hasHighSupportEvidence([
        evidenceOf({ grade: "MODEL_ASSESSED", point: 0.9 }),
        evidenceOf({ grade: "SELF_REPORTED", point: 0.9 }),
      ]),
    ).toBe(false);
    expect(
      hasHighSupportEvidence([
        evidenceOf({ grade: "MODEL_ASSESSED", point: 0.9 }),
        evidenceOf({ grade: "ATTESTED", point: 0.5 }),
      ]),
    ).toBe(true);
    expect(hasHighSupportEvidence([evidenceOf({ grade: "MEASURED", point: 0.9 })])).toBe(true);
  });
});

describe("NET-W005-AC-04 Proof-of-Value aggregation (integration)", () => {
  test("aggregateEvidence on a PoV records the deterministic aggregation + audits it (no raw payloads)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    // Evidence from THREE independent sources, mixed grades + sensitivity.
    const eMeasured = await createEvidence(harness, subject.id, {
      sourceType: "platform",
      sourceId: "instrumentation-a",
      point: 0.95,
      lower: 0.9,
      upper: 0.99,
    });
    const eProvider = await createEvidence(harness, subject.id, {
      sourceType: "provider",
      sourceId: "provider-x",
      point: 0.7,
    });
    const eSensitive = await createEvidence(harness, subject.id, {
      sourceType: "platform",
      sourceId: "instrumentation-b",
      point: 0.85,
      sensitivity: "sensitive",
      sensitivePayload: "RAW-SENSITIVE-AGGREGATION-MATERIAL",
    });

    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [eMeasured.id, eProvider.id, eSensitive.id],
    });
    const ctx = actorCtx(harness, "ac04-pov-aggregate");

    // Walk the lifecycle to EVALUATING (evidence set frozen there).
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac04-begin"),
    );
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "ac04-complete"),
    );

    const before = await harness.runtime.auditWriter.count();
    const aggregated = await harness.runtime.proofOfValueService.aggregateEvidence(
      ctx,
      proof.id,
    );
    const after = await harness.runtime.auditWriter.count();

    // The aggregation is recorded on the PoV.
    expect(aggregated.aggregation).not.toBeNull();
    expect(aggregated.aggregation!.evidenceCount).toBe(3);
    expect(aggregated.aggregation!.independentSources).toBe(3);
    // Weighted mean: (1.0*0.95 + 0.6*0.7 + 1.0*0.85) / 2.6 = 0.94615...
    expect(aggregated.aggregation!.aggregatePoint).toBeCloseTo(
      (1.0 * 0.95 + 0.6 * 0.7 + 1.0 * 0.85) / 2.6,
      10,
    );
    expect(aggregated.aggregation!.dominantGrade).toBe("MEASURED");
    // The interval envelope is CONSERVATIVE: it brackets EVERY
    // contributing record (an unquantified record contributes its point
    // as a degenerate bound), so lower = min(0.9, 0.7, 0.85) = 0.7.
    expect(aggregated.aggregation!.aggregateInterval).toEqual({ lower: 0.7, upper: 0.99 });

    // Aggregation is audited (AUD-002) and carries NO raw payload.
    expect(after - before).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "proof_of_value.aggregated",
    });
    const ev = events[events.length - 1]!;
    expect(ev.metadata?.evidenceCount).toBe(3);
    expect(ev.metadata?.independentSources).toBe(3);
    expect(JSON.stringify(ev)).not.toContain("RAW-SENSITIVE-AGGREGATION-MATERIAL");
    expect(JSON.stringify(aggregated.aggregation)).not.toContain("RAW-SENSITIVE");

    // Aggregation is only legal in EVALUATING (deterministic domain
    // rule): a PoV still in MEASURING cannot aggregate.
    const other = await createProofOfValue(harness, subject.id, {
      evidenceIds: [eMeasured.id],
    });
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, other.id, 0, "ac04-other-begin"),
    );
    await expect(
      harness.runtime.proofOfValueService.aggregateEvidence(ctx, other.id),
    ).rejects.toThrow(/only in state EVALUATING/);
  });

  test("aggregating a PoV with no attached evidence is rejected", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac04-empty");

    // An EMPTY PoV enters MEASURING, but completing the evidence
    // gathering is rejected: the deterministic precondition requires
    // ≥1 attached evidence record.
    const empty = await createProofOfValue(harness, subject.id);
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, empty.id, 0, "ac04-empty-begin"),
    );
    await expect(
      harness.runtime.proofOfValueService.completeEvidenceGathering(
        ctx,
        povTransitionInput(harness, empty.id, 1, "ac04-empty-complete"),
      ),
    ).rejects.toThrow(/at least one attached evidence record/);
  });
});
