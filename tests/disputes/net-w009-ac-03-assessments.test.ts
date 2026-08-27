/**
 * NET-W009-AC-03 — Multi-signal assessments preserve signal-level
 * provenance; evaluation is deterministic and reproducible.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.4/§3.5, §4
 * invariants 4 + 8 (determinism; fail-safe controls).
 * Issue #17 acceptance evidence 3.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW009Harness,
  createDefaultRiskPolicy,
  createDefaultSignal,
  actorCtx,
  freshSubject,
  EVALUATED_AT,
  EVALUATED_AT_LATER,
  type NetW009Harness,
} from "./_net-w009-harness.ts";

let h: NetW009Harness;
beforeAll(async () => {
  h = await createNetW009Harness();
});
afterAll(async () => {
  await h.teardown();
});

describe("NET-W009-AC-03 provenance-preserving deterministic assessments", () => {
  test("per-signal contributions are preserved (never collapsed into an opaque score)", async () => {
    await createDefaultRiskPolicy(h, "ac03-policy");
    const subject = await freshSubject(h);
    const s1 = await createDefaultSignal(h, { subjectPersonId: subject, category: "identity", severity: "MEDIUM", idempotencyKey: "ac03-s1" });
    const s2 = await createDefaultSignal(h, { subjectPersonId: subject, category: "velocity", severity: "HIGH", idempotencyKey: "ac03-s2" });
    const ctx = actorCtx(h, "ac03-contrib");
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac03-contrib-1",
    });
    expect(assessment.contributions).toHaveLength(2);
    const byId = new Map(assessment.contributions.map((c) => [c.signalId, c]));
    const c1 = byId.get(s1.signal.id)!;
    const c2 = byId.get(s2.signal.id)!;
    expect(c1.category).toBe("identity");
    expect(c1.severity).toBe("MEDIUM");
    expect(c1.weight).toBe(1);
    expect(c1.advisory).toBe(false);
    expect(c1.points).toBe(2_000_000); // MEDIUM=2, weight 1, confidence 1 (scaled 6dp)
    expect(c2.category).toBe("velocity");
    expect(c2.points).toBe(4_000_000);
    expect(assessment.score).toBe(6_000_000);
    // signalIds = the EXACT contributing set (deterministic order).
    expect(assessment.signalIds).toContain(s1.signal.id);
    expect(assessment.signalIds).toContain(s2.signal.id);
  });

  test("determinism: same signals + policy/version + evaluatedAt ⇒ identical digest; different time ⇒ different digest", async () => {
    await createDefaultRiskPolicy(h, "ac03-det");
    const subject = await freshSubject(h);
    await createDefaultSignal(h, { subjectPersonId: subject, idempotencyKey: "ac03-det-s1" });
    const ctx = actorCtx(h, "ac03-det-ctx");
    const a1 = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-det",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac03-det-1",
    });
    // Preview (pure) over the same inputs reproduces the SAME digest.
    const preview = await h.runtime.riskAssessmentService.previewAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-det",
      evaluatedAt: EVALUATED_AT,
    });
    expect(preview.digest).toBe(a1.assessment.digest);
    expect(preview.score).toBe(a1.assessment.score);
    expect(preview.state).toBe(a1.assessment.state);
    // A different evaluatedAt changes the digest (time is a
    // deterministic input, not ambient state).
    const a2 = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-det",
      evaluatedAt: EVALUATED_AT_LATER,
      idempotencyKey: "ac03-det-2",
    });
    expect(a2.assessment.digest).not.toBe(a1.assessment.digest);
  });

  test("the pure engine is a pure function (same inputs, twice, bit-for-bit)", async () => {
    const { evaluateRisk } = await import("../../src/disputes/risk-engine.ts");
    const policy = await createDefaultRiskPolicy(h, "ac03-pure");
    const signals = [
      {
        id: "sig-a",
        category: "identity",
        severity: "HIGH",
        confidence: 0.5,
        advisory: false,
        recordedAt: "2024-05-01T00:00:00.000Z",
        supersededBySignalId: null,
      },
      {
        id: "sig-b",
        category: "model_advisory",
        severity: "CRITICAL",
        confidence: 1,
        advisory: true,
        recordedAt: "2024-05-02T00:00:00.000Z",
        supersededBySignalId: null,
      },
    ];
    const r1 = evaluateRisk(policy, h.personId, signals, EVALUATED_AT);
    const r2 = evaluateRisk(policy, h.personId, signals, EVALUATED_AT);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    // advisory CRITICAL: 8 × 1 × 0.25 = 2.0 scaled = 2_000_000; HIGH
    // identity non-advisory: 4 × 1 × 0.5 = 2_000_000. Total 4_000_000
    // ⇒ REVIEW threshold (4). Mixed set → no advisory cap.
    expect(r1.score).toBe(4_000_000);
    expect(r1.state).toBe("REVIEW");
    expect(r1.digest).toHaveLength(64);
  });

  test("fail-safe: a policy-required category with no signals fails CLOSED to missingDataState", async () => {
    await createDefaultRiskPolicy(h, "ac03-failclosed");
    const subject = await freshSubject(h);
    // A signal in a category the policy does NOT consume (graph) —
    // the required `identity` category stays EMPTY.
    const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
    const pov = await createVerifiedPoV(h.w008);
    const ctx = actorCtx(h, "ac03-fc");
    await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      category: "graph",
      severity: "LOW",
      confidence: 1,
      provenance: {
        kind: "rule_detection",
        detectionMethod: "graph-scan",
        detectionVersion: "1",
        sources: [{ kind: "proof_of_value", id: pov.id }],
      },
      detectedAt: "2024-05-01T00:00:00.000Z",
      idempotencyKey: "ac03-fc-graph",
    });
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-failclosed",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac03-fc-1",
    });
    // The uncategorized signal contributes NOTHING; identity is
    // missing ⇒ fail closed to HOLD (never silently CLEAR).
    expect(assessment.contributions).toHaveLength(0);
    expect(assessment.missingCategories).toEqual(["identity"]);
    expect(assessment.state).toBe("HOLD");
  });

  test("re-evaluation supersedes append-only: new record references the previous; history preserved", async () => {
    await createDefaultRiskPolicy(h, "ac03-supersede");
    const subject = await freshSubject(h);
    await createDefaultSignal(h, { subjectPersonId: subject, idempotencyKey: "ac03-sup-s1" });
    const ctx = actorCtx(h, "ac03-sup");
    const first = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-supersede",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac03-sup-1",
    });
    const second = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-supersede",
      evaluatedAt: EVALUATED_AT_LATER,
      idempotencyKey: "ac03-sup-2",
    });
    expect(second.assessment.supersedesAssessmentId).toBe(first.assessment.id);
    // The PREVIOUS record's back-pointer flipped atomically; its
    // content is otherwise byte-identical.
    const history = await h.runtime.riskAssessmentService.getAssessmentHistory(
      ctx,
      h.organizationScopeId,
      subject,
    );
    expect(history).toHaveLength(2);
    const old = history.find((a) => a.id === first.assessment.id)!;
    expect(old.supersededByAssessmentId).toBe(second.assessment.id);
    expect(old.digest).toBe(first.assessment.digest);
    // The latest read is the new assessment.
    const latest = await h.runtime.riskAssessmentService.getLatestAssessment(
      ctx,
      h.organizationScopeId,
      subject,
    );
    expect(latest!.id).toBe(second.assessment.id);
  });

  test("superseded signals stop contributing (corrections change future assessments)", async () => {
    await createDefaultRiskPolicy(h, "ac03-corrected");
    const subject = await freshSubject(h);
    const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
    const pov = await createVerifiedPoV(h.w008);
    const ctx = actorCtx(h, "ac03-corr");
    const { signal } = await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      category: "identity",
      severity: "HIGH",
      confidence: 1,
      provenance: {
        kind: "authoritative_record",
        detectionMethod: "d",
        detectionVersion: "1",
        sources: [{ kind: "proof_of_value", id: pov.id }],
      },
      detectedAt: "2024-05-01T00:00:00.000Z",
      idempotencyKey: "ac03-corr-s1",
    });
    // Correct the signal down to LOW.
    await h.runtime.riskSignalService.supersedeSignal(ctx, {
      signalId: signal.id,
      category: "identity",
      severity: "LOW",
      confidence: 1,
      provenance: {
        kind: "authoritative_record",
        detectionMethod: "d",
        detectionVersion: "1",
        sources: [{ kind: "proof_of_value", id: pov.id }],
      },
      detectedAt: "2024-05-01T00:00:00.000Z",
      idempotencyKey: "ac03-corr-fix",
    });
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac03-corrected",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac03-corr-1",
    });
    // Only the LOW correction contributes (1 point, identity present —
    // no fail-closed); 1 < the WATCH threshold 2 ⇒ CLEAR.
    expect(assessment.contributions).toHaveLength(1);
    expect(assessment.contributions[0]!.points).toBe(1_000_000);
    expect(assessment.missingCategories).toHaveLength(0);
    expect(assessment.state).toBe("CLEAR");
  });

  test("assessments are tenant-scoped: a policy from another org cannot evaluate here", async () => {
    const policy = await createDefaultRiskPolicy(h, "ac03-tenant");
    const ctx = actorCtx(h, "ac03-tenant-ctx");
    await expect(
      h.runtime.riskAssessmentService.recordAssessment(ctx, {
        organizationScopeId: h.secondOrgId,
        subjectPersonId: h.personId,
        policyId: policy.policyId,
        evaluatedAt: EVALUATED_AT,
        idempotencyKey: "ac03-tenant-1",
      }),
    ).rejects.toMatchObject({
      code: "RISK_ASSESSMENT_VALIDATION",
      message: expect.stringMatching(/belongs to organization scope/),
    });
    // And the other org's history is invisible here.
    const history = await h.runtime.riskAssessmentService.getAssessmentHistory(
      ctx,
      h.secondOrgId,
      h.personId,
    );
    expect(history).toHaveLength(0);
  });
});
