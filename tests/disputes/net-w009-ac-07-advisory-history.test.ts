/**
 * NET-W009-AC-07 — Model/AI inputs remain advisory/non-authoritative
 * and risk history remains append-only/correctable.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.1 (advisory
 * provenance), §3.4 (the advisory-only cap), §4 invariants 5 (model
 * non-authority) + history correctness.
 * spec/architecture-lock.md §4/§5 (model output is input evidence,
 * never authoritative); architecture §14 + §19.
 * Issue #17 acceptance evidence 7.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW009Harness,
  createDefaultRiskPolicy,
  createDefaultSignal,
  actorCtx,
  freshSubject,
  EVALUATED_AT,
  type NetW009Harness,
} from "./_net-w009-harness.ts";

let h: NetW009Harness;
beforeAll(async () => {
  h = await createNetW009Harness();
});
afterAll(async () => {
  await h.teardown();
});

describe("NET-W009-AC-07 advisory model inputs + append-only correctable history", () => {
  test("model_output provenance is STRUCTURALLY advisory — never caller-asserted", async () => {
    const { signal } = await createDefaultSignal(h, {
      provenanceKind: "model_output",
      detectionMethod: "ensemble-fraud-v4",
      category: "model_advisory",
      severity: "CRITICAL",
      idempotencyKey: "ac07-model-1",
    });
    expect(signal.provenance.kind).toBe("model_output");
    expect(signal.advisory).toBe(true); // DERIVED, not caller-asserted
    // Non-model kinds are never advisory.
    const { signal: ruleSignal } = await createDefaultSignal(h, {
      provenanceKind: "rule_detection",
      category: "velocity",
      idempotencyKey: "ac07-rule-1",
    });
    expect(ruleSignal.advisory).toBe(false);
    const { signal: manualSignal } = await createDefaultSignal(h, {
      provenanceKind: "manual_review",
      category: "identity",
      idempotencyKey: "ac07-manual-1",
    });
    expect(manualSignal.advisory).toBe(false);
  });

  test("advisory-only signal sets can NEVER alone produce HOLD/BLOCKED — capped at REVIEW", async () => {
    const ctx = actorCtx(h, "ac07-cap");
    const subject = await freshSubject(h);
    // A policy with NO required categories (the pure cap demo — with
    // a required category the fail-closed floor would legitimately
    // dominate, which the precedence test proves separately).
    await h.runtime.riskPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: h.organizationScopeId,
      policyId: "ac07-cap-policy",
      version: 1,
      rules: [
        { category: "model_advisory", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
      ],
      thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
      criticalFloorState: "HOLD",
      advisoryOnlyCapState: "REVIEW",
      requiredCategories: [],
      missingDataState: "REVIEW",
    });
    // FOUR CRITICAL advisory signals — a wall of model alarm. Score:
    // 8 × 1 × 0.25 × 4 = 8 ≥ hold threshold 8... but advisory-only ⇒
    // capped at REVIEW (the structural rule, regardless of volume).
    for (let i = 0; i < 4; i++) {
      await createDefaultSignal(h, {
        subjectPersonId: subject,
        provenanceKind: "model_output",
        category: "model_advisory",
        severity: "CRITICAL",
        idempotencyKey: `ac07-cap-signal-${i}`,
      });
    }
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac07-cap-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac07-cap-assessment",
    });
    expect(assessment.score).toBe(8_000_000); // the score crosses the hold threshold...
    expect(assessment.state).toBe("REVIEW"); // ...but the state is CAPPED
    expect(assessment.contributions.every((c) => c.advisory)).toBe(true);
  });

  test("a single non-advisory signal unlocks material states (mixed sets are not capped)", async () => {
    const ctx = actorCtx(h, "ac07-mixed");
    const subject = await freshSubject(h);
    // No required categories (the mixed-set cap demo).
    await h.runtime.riskPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: h.organizationScopeId,
      policyId: "ac07-mixed-policy",
      version: 1,
      rules: [
        { category: "model_advisory", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        { category: "velocity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
      ],
      thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
      criticalFloorState: "HOLD",
      advisoryOnlyCapState: "REVIEW",
      requiredCategories: [],
      missingDataState: "REVIEW",
    });
    await createDefaultSignal(h, {
      subjectPersonId: subject,
      provenanceKind: "model_output",
      category: "model_advisory",
      severity: "CRITICAL",
      idempotencyKey: "ac07-mixed-model",
    });
    await createDefaultSignal(h, {
      subjectPersonId: subject,
      provenanceKind: "rule_detection",
      category: "velocity",
      severity: "HIGH",
      idempotencyKey: "ac07-mixed-rule",
    });
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac07-mixed-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac07-mixed-assessment",
    });
    // Rule CRITICAL floor: none here; score = 2 (advisory CRITICAL
    // 8×0.25) + 4 (rule HIGH) = 6 ≥ hold 8? No: 6 < 8 ⇒ REVIEW. The
    // point: the set is mixed, contributions differ in advisory flags.
    expect(assessment.state).toBe("REVIEW");
    const byAdvisory = assessment.contributions.filter((c) => c.advisory);
    expect(byAdvisory).toHaveLength(1);
    expect(byAdvisory[0]!.points).toBe(2_000_000);
    // A non-advisory CRITICAL in a mixed set floors at HOLD.
    const subject2 = await freshSubject(h);
    await createDefaultSignal(h, {
      subjectPersonId: subject2,
      provenanceKind: "model_output",
      category: "model_advisory",
      severity: "LOW",
      idempotencyKey: "ac07-mixed2-model",
    });
    await createDefaultSignal(h, {
      subjectPersonId: subject2,
      provenanceKind: "rule_detection",
      category: "identity",
      severity: "CRITICAL",
      idempotencyKey: "ac07-mixed2-rule",
    });
    const a2 = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject2,
      policyId: "ac07-mixed-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac07-mixed2-assessment",
    });
    expect(a2.assessment.state).toBe("HOLD"); // critical floor
  });

  test("the advisory cap cannot mask a fail-closed missing-data state (invariant precedence)", async () => {
    const ctx = actorCtx(h, "ac07-precedence");
    const subject = await freshSubject(h);
    await createDefaultRiskPolicy(h, "ac07-prec-policy");
    // ONLY an advisory signal — and the required identity category is
    // missing. The fail-closed missing-data floor (HOLD) dominates the
    // advisory cap: the HOLD is caused by MISSING required data, not
    // by model output (work order §3.4 composition order).
    await createDefaultSignal(h, {
      subjectPersonId: subject,
      provenanceKind: "model_output",
      category: "model_advisory",
      severity: "HIGH",
      idempotencyKey: "ac07-prec-signal",
    });
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac07-prec-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac07-prec-assessment",
    });
    expect(assessment.missingCategories).toEqual(["identity"]);
    expect(assessment.state).toBe("HOLD");
  });

  test("an advisory-only HOLD-producing policy shape is IMPOSSIBLE to express (validator)", async () => {
    const ctx = actorCtx(h, "ac07-validator");
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: h.organizationScopeId,
        policyId: "ac07-bad-cap",
        version: 1,
        rules: [
          { category: "model_advisory", weight: 1, advisoryWeightFactor: 1, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        ],
        thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "BLOCKED", // > REVIEW — structurally rejected
        requiredCategories: [],
        missingDataState: "REVIEW",
      }),
    ).rejects.toMatchObject({
      code: "RISK_POLICY_VALIDATION",
      message: expect.stringMatching(/advisoryOnlyCapState/),
    });
  });

  test("signal corrections are append-only: the original record survives byte-identical (content fields)", async () => {
    const ctx = actorCtx(h, "ac07-correction");
    const original = await createDefaultSignal(h, {
      severity: "HIGH",
      idempotencyKey: "ac07-corr-original",
    });
    const { original: flipped, correction } =
      await h.runtime.riskSignalService.supersedeSignal(ctx, {
        signalId: original.signal.id,
        category: "identity",
        severity: "LOW",
        confidence: 0.4,
        provenance: {
          kind: "authoritative_record",
          detectionMethod: original.signal.provenance.detectionMethod,
          detectionVersion: original.signal.provenance.detectionVersion,
          sources: original.signal.provenance.sources.map((s) => ({ kind: s.kind, id: s.id })),
        },
        description: "Downgraded after re-examination",
        detectedAt: original.signal.detectedAt,
        idempotencyKey: "ac07-corr-correction",
      });
    // The correction references the original; the original's ONLY
    // change is the back-pointer (content fields stay identical).
    expect(correction.supersedesSignalId).toBe(original.signal.id);
    expect(correction.severity).toBe("LOW");
    expect(flipped.supersededBySignalId).toBe(correction.id);
    expect(flipped.category).toBe(original.signal.category);
    expect(flipped.severity).toBe(original.signal.severity);
    expect(flipped.confidence).toBe(original.signal.confidence);
    expect(flipped.provenance).toEqual(original.signal.provenance);
    expect(flipped.detectedAt).toBe(original.signal.detectedAt);
    expect(flipped.recordedAt).toBe(original.signal.recordedAt);
    // Double supersession is a conflict (history is linear).
    await expect(
      h.runtime.riskSignalService.supersedeSignal(ctx, {
        signalId: original.signal.id,
        category: "identity",
        severity: "LOW",
        confidence: 1,
        provenance: {
          kind: "authoritative_record",
          detectionMethod: "x",
          detectionVersion: "1",
          sources: original.signal.provenance.sources.map((s) => ({ kind: s.kind, id: s.id })),
        },
        detectedAt: original.signal.detectedAt,
        idempotencyKey: "ac07-corr-second",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("case decision history is append-only and every decision is auditable", async () => {
    const ctx = actorCtx(h, "ac07-history");
    const { signal } = await createDefaultSignal(h, { idempotencyKey: "ac07-hist-signal" });
    const { riskCase } = await h.runtime.riskCaseService.openCase(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      title: "History probe",
      reasonCodes: ["probe"],
      sourceRefs: [{ kind: "risk_signal", id: signal.id }],
      idempotencyKey: "ac07-hist-case",
    });
    const reviewer = (await import("./_net-w009-harness.ts")).reviewerCtx(h, "ac07-hist-review");
    await h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "escalate",
      reasonCodes: ["severe"],
      sourceRefs: [{ kind: "risk_signal", id: signal.id }],
      idempotencyKey: "ac07-hist-escalate",
    });
    const escalated = await h.runtime.riskCaseService.getCase(ctx, riskCase.id);
    expect(escalated.decisions.map((d) => d.decision)).toEqual(["open", "escalate"]);
    // Every decision carries reviewer + reason codes + refs.
    for (const d of escalated.decisions) {
      expect(d.reviewerPersonId).toBeTruthy();
      expect(d.reasonCodes.length).toBeGreaterThan(0);
      expect(d.sourceRefs.length).toBeGreaterThan(0);
    }
    // Audit lineage for each decision event.
    const opened = (await h.runtime.auditWriter.query({
      eventType: "risk_case.opened",
    })) as readonly { resourceId: string }[];
    const decided = (await h.runtime.auditWriter.query({
      eventType: "risk_case.decision_recorded",
    })) as readonly { resourceId: string }[];
    expect(
      opened.filter((e) => e.resourceId === riskCase.id).length +
        decided.filter((e) => e.resourceId === riskCase.id).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
