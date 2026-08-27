/**
 * NET-W009-AC-01 — Risk signals are first-class, durable, scoped,
 * provenance-backed records.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.2, §4 invariant 3
 * (evidence-backed material decisions), invariant 6 (tenant
 * isolation).
 * Issue #17 acceptance evidence 1.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { OpenConError } from "../../src/core/errors.ts";
import {
  createNetW009Harness,
  createDefaultSignal,
  actorCtx,
  type NetW009Harness,
} from "./_net-w009-harness.ts";

let h: NetW009Harness;
beforeAll(async () => {
  h = await createNetW009Harness();
});
afterAll(async () => {
  await h.teardown();
});

describe("NET-W009-AC-01 first-class provenance-backed risk signals", () => {
  test("a signal persists with source/provenance, confidence, scope, detection lineage", async () => {
    const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
    const pov = await createVerifiedPoV(h.w008);
    const ctx = actorCtx(h, "ac01-full");
    const { signal, created } = await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      subjectRef: { subjectType: "proof_of_value", subjectId: pov.id },
      category: "duplicate_pattern",
      severity: "HIGH",
      confidence: 0.87,
      provenance: {
        kind: "rule_detection",
        detectionMethod: "duplicate-fingerprint",
        detectionVersion: "2.1.0",
        sources: [{ kind: "proof_of_value", id: pov.id }],
      },
      description: "Same PoV cited by two value records",
      detectedAt: "2024-05-01T00:00:00.000Z",
      idempotencyKey: "ac01-full-1",
    });
    expect(created).toBe(true);
    expect(signal.organizationScopeId).toBe(h.organizationScopeId);
    expect(signal.subjectPersonId).toBe(h.personId);
    expect(signal.subjectRef).toEqual({
      subjectType: "proof_of_value",
      subjectId: pov.id,
    });
    expect(signal.category).toBe("duplicate_pattern");
    expect(signal.severity).toBe("HIGH");
    expect(signal.confidence).toBe(0.87);
    expect(signal.provenance.kind).toBe("rule_detection");
    expect(signal.provenance.detectionMethod).toBe("duplicate-fingerprint");
    expect(signal.provenance.detectionVersion).toBe("2.1.0");
    expect(signal.provenance.sources).toHaveLength(1);
    expect(signal.advisory).toBe(false);
    expect(signal.executionId).toBe(ctx.executionId);
    expect(signal.correlationId).toBe("ac01-full");
    // Durable: reads back through the authority.
    const fetched = await h.runtime.riskSignalService.getSignal(ctx, signal.id);
    expect(fetched.id).toBe(signal.id);
    expect(fetched.detectedAt).toBe("2024-05-01T00:00:00.000Z");
  });

  test("≥1 authoritative source ref is REQUIRED — a bare assertion is rejected", async () => {
    const ctx = actorCtx(h, "ac01-nosource");
    try {
      await h.runtime.riskSignalService.createSignal(ctx, {
        organizationScopeId: h.organizationScopeId,
        subjectPersonId: h.personId,
        category: "identity",
        severity: "HIGH",
        confidence: 1,
        provenance: {
          kind: "rule_detection",
          detectionMethod: "bare",
          detectionVersion: "1.0.0",
          sources: [],
        },
        detectedAt: "2024-05-01T00:00:00.000Z",
        idempotencyKey: "ac01-nosource-1",
      });
      throw new Error("expected a validation error");
    } catch (err) {
      expect((err as OpenConError).code).toBe("RISK_SIGNAL_VALIDATION");
      expect((err as Error).message).toMatch(/at least one authoritative source/i);
    }
  });

  test("a source that does not resolve is rejected; a cross-org source is rejected (tenant isolation)", async () => {
    const ctx = actorCtx(h, "ac01-scope");
    // Unresolvable id.
    await expect(
      h.runtime.riskSignalService.createSignal(ctx, {
        organizationScopeId: h.organizationScopeId,
        subjectPersonId: h.personId,
        category: "identity",
        severity: "LOW",
        confidence: 1,
        provenance: {
          kind: "rule_detection",
          detectionMethod: "x",
          detectionVersion: "1",
          sources: [{ kind: "evidence", id: "does-not-exist" }],
        },
        detectedAt: "2024-05-01T00:00:00.000Z",
        idempotencyKey: "ac01-unresolvable",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });

    // Cross-org: a PoV in org A cited by a signal in org B.
    const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
    const pov = await createVerifiedPoV(h.w008); // org A
    await expect(
      h.runtime.riskSignalService.createSignal(ctx, {
        organizationScopeId: h.secondOrgId,
        subjectPersonId: h.personId,
        category: "identity",
        severity: "LOW",
        confidence: 1,
        provenance: {
          kind: "rule_detection",
          detectionMethod: "x",
          detectionVersion: "1",
          sources: [{ kind: "proof_of_value", id: pov.id }],
        },
        detectedAt: "2024-05-01T00:00:00.000Z",
        idempotencyKey: "ac01-cross-org",
      }),
    ).rejects.toMatchObject({
      code: "RISK_SIGNAL_VALIDATION",
      message: expect.stringMatching(/belongs to organization scope/),
    });
  });

  test("vocabulary gates: unknown category / severity / provenance kind are rejected", async () => {
    const ctx = actorCtx(h, "ac01-vocab");
    const base = {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      severity: "LOW",
      confidence: 1,
      provenance: {
        kind: "rule_detection",
        detectionMethod: "x",
        detectionVersion: "1",
        sources: [{ kind: "evidence", id: "x" }],
      },
      detectedAt: "2024-05-01T00:00:00.000Z",
    } as const;
    await expect(
      h.runtime.riskSignalService.createSignal(ctx, {
        ...base,
        category: "psychic_vibes",
        idempotencyKey: "ac01-cat",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
    await expect(
      h.runtime.riskSignalService.createSignal(ctx, {
        ...base,
        category: "identity",
        severity: "CATASTROPHIC",
        idempotencyKey: "ac01-sev",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
    await expect(
      h.runtime.riskSignalService.createSignal(ctx, {
        ...base,
        category: "identity",
        provenance: { ...base.provenance, kind: "oracle" },
        idempotencyKey: "ac01-prov",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
  });

  test("economic records are valid authoritative sources (the velocity use case)", async () => {
    const { createPendingValue } = await import("../settlement/_net-w008-harness.ts");
    const value = await createPendingValue(h.w008);
    const { signal } = await createDefaultSignal(h, {
      category: "velocity",
      provenanceKind: "rule_detection",
      detectionMethod: "velocity-window",
      sourceRefs: [{ kind: "economic_value", id: value.id }],
    });
    expect(signal.provenance.sources[0]!.kind).toBe("economic_value");
    expect(signal.category).toBe("velocity");
  });

  test("subject listing is scoped to the organization + subject (tenant isolation)", async () => {
    await createDefaultSignal(h, { subjectPersonId: h.personId, idempotencyKey: "ac01-ls-p1" });
    await createDefaultSignal(h, { subjectPersonId: h.secondPersonId, idempotencyKey: "ac01-ls-p2" });
    const ctx = actorCtx(h, "ac01-list");
    const mine = await h.runtime.riskSignalService.listSignals(
      ctx,
      h.organizationScopeId,
      h.personId,
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((s) => s.subjectPersonId === h.personId)).toBe(true);
    // Another org sees NOTHING from this org.
    const other = await h.runtime.riskSignalService.listSignals(ctx, h.secondOrgId);
    expect(other.filter((s) => s.organizationScopeId === h.organizationScopeId)).toHaveLength(0);
  });

  test("idempotent recording: the same key replays the SAME record (created=false)", async () => {
    const first = await createDefaultSignal(h, { idempotencyKey: "ac01-idem-1" });
    const ctx = actorCtx(h, "ac01-idem");
    const replay = await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      category: first.signal.category,
      severity: first.signal.severity,
      confidence: first.signal.confidence,
      provenance: {
        kind: first.signal.provenance.kind,
        detectionMethod: first.signal.provenance.detectionMethod,
        detectionVersion: first.signal.provenance.detectionVersion,
        sources: first.signal.provenance.sources.map((s) => ({ kind: s.kind, id: s.id })),
      },
      detectedAt: first.signal.detectedAt,
      idempotencyKey: "ac01-idem-1",
    });
    expect(replay.created).toBe(false);
    expect(replay.signal.id).toBe(first.signal.id);
  });
});
