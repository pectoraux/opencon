/**
 * NET-W009-AC-05 — Anomaly/velocity/duplicate controls are
 * tenant-scoped and authoritative-data based; the control decisions
 * gate downstream workflow/economic operations.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.4 (detectors), §3.7
 * (control hooks + the composition-root gates);
 * spec/architecture-lock.md §13 invariant 21 (a fraud-held claim
 * cannot mature); work item definition-of-done ("suspicious value can
 * be held").
 * Issue #17 acceptance evidence 5.
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
import {
  createPendingValue,
  createContribution,
} from "../settlement/_net-w008-harness.ts";
import { evaluateVelocityRule, evaluateDuplicatePatternRule } from "../../src/disputes/risk-engine.ts";

let h: NetW009Harness;
beforeAll(async () => {
  h = await createNetW009Harness();
});
afterAll(async () => {
  await h.teardown();
});

describe("NET-W009-AC-05 tenant-scoped authoritative-data controls + the gates", () => {
  test("the velocity detector fires over AUTHORITATIVE records, tenant-scoped, deterministically", async () => {
    // Three pending value records for the harness person (authoritative
    // economic records the detector cites).
    const v1 = await createPendingValue(h.w008);
    const v2 = await createPendingValue(h.w008);
    const v3 = await createPendingValue(h.w008);
    const views = [v1, v2, v3].map((v) => ({
      id: v.id,
      organizationScopeId: v.organizationScopeId,
      beneficiaryPersonId: v.beneficiaryPersonId,
      state: v.state,
      recordedAt: v.recordedAt,
    }));
    // Window covering all three; max 3 ⇒ triggered.
    const fired = evaluateVelocityRule(
      views,
      h.organizationScopeId,
      h.personId,
      "2020-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
      3,
    );
    expect(fired.triggered).toBe(true);
    expect(fired.recordIds).toHaveLength(3);
    // The SAME records are invisible to another org / person (tenant
    // scope by construction).
    const other = evaluateVelocityRule(
      views,
      h.secondOrgId,
      h.secondOrgPersonId,
      "2020-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
      3,
    );
    expect(other.triggered).toBe(false);
    expect(other.recordIds).toHaveLength(0);
    // Deterministic: same inputs ⇒ same output.
    const again = evaluateVelocityRule(
      views,
      h.organizationScopeId,
      h.personId,
      "2020-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
      3,
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(fired));
  });

  test("the duplicate-pattern detector groups ≥2 records sharing a fingerprint", async () => {
    const a = await createPendingValue(h.w008);
    const b = await createPendingValue(h.w008);
    const c = await createPendingValue(h.w008);
    const views = [a, b, c].map((v) => ({
      id: v.id,
      organizationScopeId: v.organizationScopeId,
      beneficiaryPersonId: v.beneficiaryPersonId,
      state: v.state,
      recordedAt: v.recordedAt,
    }));
    // Fingerprint by beneficiary (a+b+c share it).
    const dup = evaluateDuplicatePatternRule(
      views,
      (r) => r.beneficiaryPersonId,
    );
    expect(dup.triggered).toBe(true);
    expect(dup.groups).toHaveLength(1);
    expect(dup.groups[0]).toHaveLength(3);
    // A unique fingerprint finds nothing.
    const none = evaluateDuplicatePatternRule(views, (r) => r.id);
    expect(none.triggered).toBe(false);
  });

  test("THE GOLDEN PATH: velocity signal → HOLD assessment → control → maturation REFUSED → case cleared → maturation succeeds", async () => {
    const ctx = actorCtx(h, "ac05-golden");
    const subject = await freshSubject(h);
    const policy = await createDefaultRiskPolicy(h, "ac05-golden-policy");

    // 1. Suspicious authoritative records: pending value for the
    //    subject beneficiary... (the W008 factory pays the harness
    //    person; the risk subject here IS the harness person.)
    const pending = await createPendingValue(h.w008, {
      beneficiaryPersonId: subject,
      idempotencyKey: `ac05-golden-value-${subject}`,
    });

    // 2. A velocity signal citing that record (rule_detection).
    const velocity = await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      category: "velocity",
      severity: "CRITICAL",
      confidence: 1,
      provenance: {
        kind: "rule_detection",
        detectionMethod: "velocity-window",
        detectionVersion: "1.0.0",
        sources: [{ kind: "economic_value", id: pending.id }],
      },
      description: "Beneficiary value velocity far above policy",
      detectedAt: "2024-05-15T00:00:00.000Z",
      idempotencyKey: `ac05-golden-signal-${subject}`,
    });
    expect(velocity.signal.advisory).toBe(false);

    // 3. Assessment: CRITICAL velocity (8) + identity present ⇒ HOLD.
    const assessment = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: policy.policyId,
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: `ac05-golden-assessment-${subject}`,
    });
    expect(assessment.assessment.state).toBe("HOLD");

    // 4. Review case FIRST (the control will cite both origins), then
    //    the control: HOLD value_maturation scoped to the RECORD.
    const riskCase = await h.runtime.riskCaseService.openCase(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      title: "Velocity hold review",
      reasonCodes: ["velocity_anomaly"],
      sourceRefs: [
        { kind: "risk_signal", id: velocity.signal.id },
        { kind: "economic_value", id: pending.id },
      ],
      idempotencyKey: `ac05-golden-case-${subject}`,
    });
    const control = await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectRef: { subjectType: "economic_value", subjectId: pending.id },
      originAssessmentId: assessment.assessment.id,
      originCaseId: riskCase.riskCase.id,
      reasonCodes: ["velocity_anomaly", "hold_maturation"],
      idempotencyKey: `ac05-golden-control-${subject}`,
    });
    expect(control.control.state).toBe("ACTIVE");

    // 5. THE GATE: maturation through the composition-root command is
    //    REFUSED; the record stays PENDING (lock invariant 21 — a
    //    fraud-held claim cannot mature). The settlement domain code
    //    is untouched — the gate consults the control registry first.
    await expect(
      h.runtime.apiCommands.matureEconomicValue(ctx, {
        valueRecordId: pending.id,
        idempotencyKey: `ac05-golden-mature-attempt-${subject}`,
      }),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL",
      message: expect.stringMatching(/value_maturation is refused/),
    });
    const stillPending = await h.runtime.economicValueService.getValue(ctx, pending.id);
    expect(stillPending.state).toBe("PENDING");

    // 6. Review: resolve the case CLEAR → resolve the control via the
    //    resolving decision (full resolution lineage).
    const reviewer = (await import("./_net-w009-harness.ts")).reviewerCtx(h, "ac05-review");
    const resolvedCase = await h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.riskCase.id,
      decision: "resolve_clear",
      reasonCodes: ["legitimate_burst"],
      sourceRefs: [{ kind: "risk_signal", id: velocity.signal.id }],
      idempotencyKey: `ac05-golden-resolve-${subject}`,
    });
    expect(resolvedCase.resolution).toBe("CLEARED");
    await h.runtime.riskControlService.resolveControl(ctx, {
      controlDecisionId: control.control.id,
      caseDecisionId:
        resolvedCase.decisions[resolvedCase.decisions.length - 1]!.id,
      idempotencyKey: `ac05-golden-release-${subject}`,
    });

    // 7. Maturation now SUCCEEDS (the hold is gone).
    const matured = await h.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      idempotencyKey: `ac05-golden-mature-ok-${subject}`,
    });
    expect(matured.state).toBe("MATURE");
  });

  test("person-scoped controls gate credit issuance for the beneficiary", async () => {
    const ctx = actorCtx(h, "ac05-person-gate");
    const subject = await freshSubject(h);
    const policy = await createDefaultRiskPolicy(h, "ac05-person-policy");
    const pending = await createPendingValue(h.w008, {
      beneficiaryPersonId: subject,
      idempotencyKey: `ac05-pg-value-${subject}`,
    });
    // Identity CRITICAL signal ⇒ HOLD (critical floor).
    await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      category: "identity",
      severity: "CRITICAL",
      confidence: 1,
      provenance: {
        kind: "authoritative_record",
        detectionMethod: "sybil-graph",
        detectionVersion: "1",
        sources: [{ kind: "economic_value", id: pending.id }],
      },
      detectedAt: "2024-05-15T00:00:00.000Z",
      idempotencyKey: `ac05-pg-signal-${subject}`,
    });
    const assessment = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: policy.policyId,
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: `ac05-pg-assessment-${subject}`,
    });
    // Person-scoped HOLD on credit_issuance.
    await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "credit_issuance",
      action: "HOLD",
      subjectPersonId: subject,
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["sybil_suspect"],
      idempotencyKey: `ac05-pg-control-${subject}`,
    });
    // Mature the value (NOT gated for this person) then attempt
    // issuance FOR the held person ⇒ refused through the runtime gate.
    const matured = await h.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      idempotencyKey: `ac05-pg-mature-${subject}`,
    });
    expect(matured.state).toBe("MATURE");
    await expect(
      h.runtime.apiCommands.issueCredits(ctx, {
        organizationScopeId: h.organizationScopeId,
        beneficiaryPersonId: subject,
        sourceValueRecordId: pending.id,
        creditsPerValueUnit: 1,
        idempotencyKey: `ac05-pg-issue-${subject}`,
      }),
    ).rejects.toMatchObject({ code: "RISK_CONTROL" });
  });

  test("controls of one org do NOT gate another org's operations (tenant isolation)", async () => {
    const ctx = actorCtx(h, "ac05-iso");
    const subject = await freshSubject(h);
    const policy = await createDefaultRiskPolicy(h, "ac05-iso-policy");
    const pending = await createPendingValue(h.w008, {
      beneficiaryPersonId: subject,
      idempotencyKey: `ac05-iso-value-${subject}`,
    });
    const { signal } = await createDefaultSignal(h, {
      subjectPersonId: subject,
      idempotencyKey: `ac05-iso-signal-${subject}`,
    });
    const assessment = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: policy.policyId,
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: `ac05-iso-assessment-${subject}`,
    });
    await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "BLOCK",
      subjectPersonId: subject,
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["org_a_hold"],
      idempotencyKey: `ac05-iso-control-${subject}`,
    });
    void signal;
    // Another org's gating read sees nothing.
    const other = await h.runtime.riskControlService.findGatingControl(
      ctx,
      h.secondOrgId,
      "value_maturation",
      pending.id,
      subject,
    );
    expect(other).toBeNull();
  });

  test("the WORKFLOW GATE: a risk hold moves a contribution to FRAUD_REVIEW through the workflow service; clearing returns it", async () => {
    const ctx = actorCtx(h, "ac05-workflow-gate");
    // Drive a contribution to SUBMITTED (FRAUD_REVIEW-eligible).
    const subject = await createContribution(h.w008);
    const { policyActionFor } = await import("../../src/core/workflow.ts");
    const transition = async (from: string, to: string, version: number) =>
      h.runtime.workflowService.requestTransition(
        {
          subjectId: subject.id,
          subjectKind: "contribution",
          targetState: to as never,
          expectedVersion: version,
          idempotencyKey: `ac05-wf-${from}-${to}-${subject.id}`,
          actorPersonId: h.personId,
          policyAction: policyActionFor("contribution", from as never, to as never),
        },
        ctx,
      );
    await transition("DRAFT", "READY", 0);
    await transition("READY", "ASSIGNED", 1);
    await transition("ASSIGNED", "IN_PROGRESS", 2);
    await transition("IN_PROGRESS", "SUBMITTED", 3);

    // Evidence for the hold: signal → assessment.
    const riskSubject = await freshSubject(h);
    void riskSubject;
    const policy = await createDefaultRiskPolicy(h, "ac05-wf-policy");
    const { signal } = await createDefaultSignal(h, { severity: "CRITICAL", idempotencyKey: `ac05-wf-signal-${subject.id}` });
    const assessment = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      policyId: policy.policyId,
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: `ac05-wf-assessment-${subject.id}`,
    });
    // CRITICAL identity signal: 8 points = the hold threshold + the
    // critical floor ⇒ HOLD (blocked needs 12).
    expect(assessment.assessment.state).toBe("HOLD");

    // Apply the workflow hold (composition root: control + authorized
    // transition through the workflow service).
    const held = await h.runtime.apiCommands.applyWorkflowHold(ctx, h.personId, {
      contributionId: subject.id,
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["fraud_review"],
      description: "Risk hold on submitted contribution",
      idempotencyKey: `ac05-wf-hold-${subject.id}`,
    });
    expect(held.transition.state).toBe("FRAUD_REVIEW");
    expect(held.control.action).toBe("HOLD");
    expect(held.control.state).toBe("ACTIVE");
    // The risk domain never mutated lifecycle state directly — the
    // transition carries the workflow service's audit event + tx id.
    expect(held.transition.transitionId).toBeTruthy();
    void signal;

    // Clear the hold: control resolved + FRAUD_REVIEW → SUBMITTED.
    const cleared = await h.runtime.apiCommands.clearWorkflowHold(ctx, h.personId, {
      contributionId: subject.id,
      controlDecisionId: held.control.id,
      idempotencyKey: `ac05-wf-clear-${subject.id}`,
    });
    expect(cleared.transition.state).toBe("SUBMITTED");
    expect(cleared.control.state).toBe("RESOLVED");
  });

  test("REQUIRE_REVIEW controls do not hard-refuse gates (decision support, not block)", async () => {
    const ctx = actorCtx(h, "ac05-require-review");
    const subject = await freshSubject(h);
    const policy = await createDefaultRiskPolicy(h, "ac05-rr-policy");
    const pending = await createPendingValue(h.w008, {
      beneficiaryPersonId: subject,
      idempotencyKey: `ac05-rr-value-${subject}`,
    });
    await createDefaultSignal(h, {
      subjectPersonId: subject,
      idempotencyKey: `ac05-rr-signal-${subject}`,
    });
    const assessment = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: policy.policyId,
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: `ac05-rr-assessment-${subject}`,
    });
    await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "REQUIRE_REVIEW",
      subjectPersonId: subject,
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["watch"],
      idempotencyKey: `ac05-rr-control-${subject}`,
    });
    // REQUIRE_REVIEW is advisory for the gate: maturation proceeds
    // (only HOLD/BLOCK refuse — the gate is the control surface).
    const matured = await h.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pending.id,
      idempotencyKey: `ac05-rr-mature-${subject}`,
    });
    expect(matured.state).toBe("MATURE");
  });
});
