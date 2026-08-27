/**
 * NET-W009-AC-04 — Risk states and review/hold semantics are explicit,
 * authorized, and auditable.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.6/§3.7, §4 invariants
 * 3 (evidence-backed material decisions) + 6 (tenant isolation).
 * Issue #17 acceptance evidence 4.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW009Harness,
  createDefaultRiskPolicy,
  createDefaultSignal,
  actorCtx,
  reviewerCtx,
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

describe("NET-W009-AC-04 explicit authorized auditable cases and controls", () => {
  async function openDefaultCase(originSignalId: string) {
    const ctx = actorCtx(h, "ac04-open");
    return h.runtime.riskCaseService.openCase(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      title: "Velocity anomaly review",
      description: "Suspicious pending-value velocity",
      reasonCodes: ["velocity_anomaly"],
      sourceRefs: [{ kind: "risk_signal", id: originSignalId }],
      idempotencyKey: `ac04-case-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
  }

  test("the case state machine is deterministic: OPEN → UNDER_REVIEW → RESOLVED with derived state", async () => {
    const { signal } = await createDefaultSignal(h, { idempotencyKey: "ac04-sm-signal" });
    const { riskCase } = await openDefaultCase(signal.id);
    expect(riskCase.state).toBe("OPEN");
    expect(riskCase.decisions).toHaveLength(1);
    expect(riskCase.decisions[0]!.decision).toBe("open");

    const reviewer = reviewerCtx(h, "ac04-review");
    const underReview = await h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "start_review",
      reasonCodes: ["triage"],
      sourceRefs: [],
      idempotencyKey: "ac04-start-review",
    });
    expect(underReview.state).toBe("UNDER_REVIEW");
    expect(underReview.decisions).toHaveLength(2);

    const resolved = await h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "resolve_clear",
      reasonCodes: ["false_positive"],
      sourceRefs: [{ kind: "risk_signal", id: signal.id }],
      idempotencyKey: "ac04-resolve",
    });
    expect(resolved.state).toBe("RESOLVED");
    expect(resolved.resolution).toBe("CLEARED");
    expect(resolved.decisions).toHaveLength(3);
    expect(resolved.resolvedAt).toBeTruthy();
    // No further decisions on a RESOLVED case (deterministic reject).
    await expect(
      h.runtime.riskCaseService.recordDecision(reviewer, {
        caseId: riskCase.id,
        decision: "start_review",
        reasonCodes: ["late"],
        sourceRefs: [],
        idempotencyKey: "ac04-after-resolve",
      }),
    ).rejects.toMatchObject({
      code: "RISK_CASE_VALIDATION",
      message: expect.stringMatching(/RESOLVED/),
    });
  });

  test("reviewer identity comes from the execution actor — different reviewers are recorded distinctly", async () => {
    const { signal } = await createDefaultSignal(h, { idempotencyKey: "ac04-rev-signal" });
    const { riskCase } = await openDefaultCase(signal.id);
    const reviewer = reviewerCtx(h, "ac04-second-reviewer");
    const updated = await h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "resolve_uphold",
      reasonCodes: ["confirmed_fraud_pattern"],
      sourceRefs: [{ kind: "risk_signal", id: signal.id }],
      idempotencyKey: "ac04-uphold",
    });
    expect(updated.resolution).toBe("UPHELD");
    const resolveDecision = updated.decisions[1]!;
    expect(resolveDecision.reviewerPersonId).toBe(h.secondPersonId);
    expect(resolveDecision.reasonCodes).toEqual(["confirmed_fraud_pattern"]);
  });

  test("material decisions require ≥1 supporting reference (evidence-backed decisions)", async () => {
    const { signal } = await createDefaultSignal(h, { idempotencyKey: "ac04-mat-signal" });
    const { riskCase } = await openDefaultCase(signal.id);
    const reviewer = reviewerCtx(h, "ac04-material");
    await expect(
      h.runtime.riskCaseService.recordDecision(reviewer, {
        caseId: riskCase.id,
        decision: "resolve_uphold",
        reasonCodes: ["confirmed"],
        sourceRefs: [],
        idempotencyKey: "ac04-material-noref",
      }),
    ).rejects.toMatchObject({
      code: "RISK_SIGNAL_VALIDATION",
      message: expect.stringMatching(/at least one authoritative source/i),
    });
    // Opening a case without refs is likewise rejected.
    await expect(
      h.runtime.riskCaseService.openCase(actorCtx(h, "ac04-mat-open"), {
        organizationScopeId: h.organizationScopeId,
        title: "No evidence",
        reasonCodes: ["x"],
        sourceRefs: [],
        idempotencyKey: "ac04-mat-open-noref",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
  });

  test("a control REQUIRES an assessment/case origin (no hidden decisions); origins are org-scoped + current", async () => {
    const ctx = actorCtx(h, "ac04-control-origin");
    await expect(
      h.runtime.riskControlService.activateControl(ctx, {
        organizationScopeId: h.organizationScopeId,
        operationClass: "value_maturation",
        action: "HOLD",
        subjectPersonId: h.personId,
        reasonCodes: ["hunch"],
        idempotencyKey: "ac04-no-origin",
      }),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL_VALIDATION",
      message: expect.stringMatching(/requires an origin/i),
    });
    // An assessment from another org cannot origin a control here.
    await createDefaultRiskPolicy(h, "ac04-origin-policy");
    const foreignCtx = actorCtx(h, "ac04-foreign");
    const foreignAssessment = await h.runtime.riskAssessmentService.recordAssessment(
      foreignCtx,
      {
        organizationScopeId: h.organizationScopeId,
        subjectPersonId: h.personId,
        policyId: "ac04-origin-policy",
        evaluatedAt: EVALUATED_AT,
        idempotencyKey: "ac04-origin-assessment",
      },
    );
    await expect(
      h.runtime.riskControlService.activateControl(ctx, {
        organizationScopeId: h.secondOrgId,
        operationClass: "value_maturation",
        action: "HOLD",
        subjectPersonId: h.personId,
        originAssessmentId: foreignAssessment.assessment.id,
        reasonCodes: ["cross-org"],
        idempotencyKey: "ac04-cross-org-origin",
      }),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL_VALIDATION",
      message: expect.stringMatching(/belongs to organization scope/),
    });
    // A superseded assessment cannot origin a control.
    const superseded = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      policyId: "ac04-origin-policy",
      evaluatedAt: "2024-06-03T00:00:00.000Z",
      idempotencyKey: "ac04-origin-assessment-2",
    });
    await expect(
      h.runtime.riskControlService.activateControl(ctx, {
        organizationScopeId: h.organizationScopeId,
        operationClass: "value_maturation",
        action: "HOLD",
        subjectPersonId: h.personId,
        originAssessmentId: foreignAssessment.assessment.id,
        reasonCodes: ["stale"],
        idempotencyKey: "ac04-stale-origin",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(superseded.assessment.supersedesAssessmentId).toBe(
      foreignAssessment.assessment.id,
    );
  });

  test("control lifecycle: ACTIVE → RESOLVED is an auditable state flip; resolution links case decisions", async () => {
    const ctx = actorCtx(h, "ac04-lifecycle");
    await createDefaultRiskPolicy(h, "ac04-lc-policy");
    await createDefaultSignal(h, { idempotencyKey: "ac04-lc-signal" });
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      policyId: "ac04-lc-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac04-lc-assessment",
    });
    const { control } = await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectPersonId: h.personId,
      originAssessmentId: assessment.id,
      reasonCodes: ["risk_hold"],
      description: "Hold maturation pending review",
      idempotencyKey: "ac04-lc-control",
    });
    expect(control.state).toBe("ACTIVE");
    expect(control.originAssessmentId).toBe(assessment.id);
    // The gate registry sees it.
    const gating = await h.runtime.riskControlService.findGatingControl(
      ctx,
      h.organizationScopeId,
      "value_maturation",
      null,
      h.personId,
    );
    expect(gating!.id).toBe(control.id);
    // Resolve it; double resolution conflicts.
    const resolved = await h.runtime.riskControlService.resolveControl(ctx, {
      controlDecisionId: control.id,
      note: "review cleared",
      idempotencyKey: "ac04-lc-resolve",
    });
    expect(resolved.state).toBe("RESOLVED");
    expect(resolved.resolvedBy).toBe(h.personId);
    await expect(
      h.runtime.riskControlService.resolveControl(ctx, {
        controlDecisionId: control.id,
        idempotencyKey: "ac04-lc-resolve-2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // The gate registry no longer gates.
    const after = await h.runtime.riskControlService.findGatingControl(
      ctx,
      h.organizationScopeId,
      "value_maturation",
      null,
      h.personId,
    );
    expect(after).toBeNull();
  });

  test("case-decision-linked resolution validates the linkage", async () => {
    const ctx = actorCtx(h, "ac04-case-link");
    const { signal } = await createDefaultSignal(h, { idempotencyKey: "ac04-cl-signal" });
    const { riskCase } = await openDefaultCase(signal.id);
    await createDefaultRiskPolicy(h, "ac04-cl-policy");
    const { assessment } = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      policyId: "ac04-cl-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac04-cl-assessment",
    });
    const { control } = await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectPersonId: h.personId,
      originAssessmentId: assessment.id,
      originCaseId: riskCase.id,
      reasonCodes: ["linked"],
      idempotencyKey: "ac04-cl-control",
    });
    // The case is still OPEN: a decision-linked resolution is refused
    // until the case RESOLVES.
    const openDecision = riskCase.decisions[0]!;
    await expect(
      h.runtime.riskControlService.resolveControl(ctx, {
        controlDecisionId: control.id,
        caseDecisionId: openDecision.id,
        idempotencyKey: "ac04-cl-early",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Resolve the case, then link the control resolution to the
    // resolving decision.
    const reviewer = reviewerCtx(h, "ac04-cl-reviewer");
    const resolvedCase = await h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "resolve_clear",
      reasonCodes: ["cleared"],
      sourceRefs: [{ kind: "risk_signal", id: signal.id }],
      idempotencyKey: "ac04-cl-case-resolve",
    });
    const resolveDecision = resolvedCase.decisions[resolvedCase.decisions.length - 1]!;
    const resolved = await h.runtime.riskControlService.resolveControl(ctx, {
      controlDecisionId: control.id,
      caseDecisionId: resolveDecision.id,
      idempotencyKey: "ac04-cl-resolve",
    });
    expect(resolved.state).toBe("RESOLVED");
    expect(resolved.resolvedViaCaseDecisionId).toBe(resolveDecision.id);
  });

  test("case + control listings are tenant-scoped", async () => {
    const ctx = actorCtx(h, "ac04-tenant");
    const otherOrgCases = await h.runtime.riskCaseService.listCases(ctx, h.secondOrgId);
    const otherOrgControls = await h.runtime.riskControlService.listControls(ctx, h.secondOrgId);
    expect(otherOrgCases).toHaveLength(0);
    expect(otherOrgControls).toHaveLength(0);
  });
});
