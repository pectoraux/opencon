/**
 * NET-W020-AC-06 — risk/dispute gates are consulted on source contexts
 * BEFORE settlement mutation (issue #39 AC-6; invariant 4).
 *
 * Active HOLD/BLOCK risk controls (operation class + the value
 * record, ALL upstream sources incl. the contribution, and the
 * placement as record subjects; the value beneficiary AND the
 * placement owner as person subjects) and ACTIVE disputes refuse the
 * clearing; an UNBONDED (PENDING_STAKE) dispute NEVER gates — no
 * griefing vector; resolving the control/dispute re-opens clearing.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  evaluateClearingEligibility,
  operatorCtx,
  creatorCtx,
  key,
  personCtx,
  type NetW020Harness,
} from "./_net-w020-harness.ts";
import { createDefaultRiskPolicy } from "../disputes/_net-w009-harness.ts";
import {
  openDefaultDispute,
  openBondedDispute,
} from "../disputes/_net-w010-harness.ts";

let harness: NetW020Harness;

beforeAll(async () => {
  harness = await createNetW020Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Activate a HOLD risk control sourced from a real assessment. */
async function holdSubject(
  subjectType: "contribution" | "economic_value",
  subjectId: string,
  operationClass: "reward_allocation" | "credit_issuance" | "cash_settlement",
): Promise<string> {
  const w009 = harness.w019.w017.w016.w015.w013.w012.w011.w010.w009;
  const policy = await createDefaultRiskPolicy(w009, key("w020-risk-policy"));
  const ctx = operatorCtx(harness, "w020-assessment");
  const assessment = await harness.runtime.riskAssessmentService.recordAssessment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.creatorPersonId,
      policyId: policy.policyId,
      evaluatedAt: new Date().toISOString(),
      idempotencyKey: key("w020-assessment"),
    },
  );
  const { control } = await harness.runtime.riskControlService.activateControl(
    operatorCtx(harness, "w020-control"),
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass,
      action: "HOLD",
      subjectRef: { subjectType, subjectId },
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["collusion_pattern"],
      idempotencyKey: key("w020-control"),
    },
  );
  return control.id;
}

describe("NET-W020-AC-06 risk/dispute gates (before settlement mutation)", () => {
  test("a HOLD risk control on the CONTRIBUTION refuses the clearing (RISK_CONTROL, before any draw)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const controlId = await holdSubject(
      "contribution",
      world.contribution.id,
      "reward_allocation",
    );
    void controlId;
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL",
      context: expect.objectContaining({
        recordSubjectId: world.contribution.id,
      }),
    });
    // NOTHING was drawn (the gate ran BEFORE the settlement mutation).
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-gate-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(0);
    // Resolving the control lifts the gate.
    await harness.runtime.riskControlService.resolveControl(
      operatorCtx(harness, "w020-resolve-control"),
      {
        controlDecisionId: controlId,
        note: "cleared after review",
        idempotencyKey: key("w020-resolve-control"),
      },
    );
    const result = await executeCrossPromotionClearing(harness, world);
    expect(result.created).toBe(true);
  });

  test("an ACTIVE (bonded, OPEN) dispute on the value record refuses the clearing until resolved", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const w010 = harness.w010;
    const { dispute } = await openBondedDispute(w010, {
      subjectType: "economic_value",
      subjectId: world.value.id,
    });
    expect(dispute.state).toBe("OPEN");
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({
      code: "DISPUTE_CHALLENGE",
      context: expect.objectContaining({
        disputeId: dispute.id,
      }),
    });
    // The derived eligibility view reports the same gate (the
    // risk_dispute_gate check, machine-readable).
    const view = await evaluateClearingEligibility(harness, world);
    expect(view.eligible).toBe(false);
    const gate = view.checks.find((c) => c.check === "risk_dispute_gate");
    expect(gate?.satisfied).toBe(false);
    expect(gate?.reason).toBe("gated");
    expect(gate?.detail).toMatchObject({ disputeId: dispute.id });
    // NOTHING was drawn.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-dispute-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(0);
    // Rejecting the dispute (inadmissible) lifts the gate — the
    // challenger withdraws is PENDING-only, so reject via the
    // reviewer.
    await harness.runtime.disputeService.rejectDispute(
      personCtx(harness, harness.w010.reviewerPersonId, "w020-reject"),
      {
        disputeId: dispute.id,
        reasonCodes: ["insufficient_evidence"],
        sourceRefs: [{ kind: "economic_value", id: world.value.id }],
        idempotencyKey: key("w020-reject"),
      },
    );
    const result = await executeCrossPromotionClearing(harness, world);
    expect(result.created).toBe(true);
  });

  test("an UNBONDED (PENDING_STAKE) dispute NEVER gates clearing — no griefing vector", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const w010 = harness.w010;
    const { dispute } = await openDefaultDispute(w010, {
      subjectType: "economic_value",
      subjectId: world.value.id,
    });
    // The unbonded challenge request is PENDING_STAKE — never an
    // ACTIVE dispute.
    expect(dispute.state).toBe("PENDING_STAKE");
    // The clearing proceeds (the griefing-resistance semantics).
    const result = await executeCrossPromotionClearing(harness, world);
    expect(result.created).toBe(true);
    const clearing = result.clearing as { drawResultId: string };
    expect(clearing.drawResultId).toBeTruthy();
  });

  test("a HOLD control on the PLACEMENT OWNER (person-wide) refuses the clearing", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    // The creator owns the supply (the placement's registered owner);
    // a person-wide HOLD on the reward_allocation class for them
    // gates the composite's placement-owner person check.
    const w009 = harness.w019.w017.w016.w015.w013.w012.w011.w010.w009;
    const policy = await createDefaultRiskPolicy(w009, key("w020-owner-policy"));
    const ctx = operatorCtx(harness, "w020-owner-assessment");
    const assessment = await harness.runtime.riskAssessmentService.recordAssessment(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.creatorPersonId,
        policyId: policy.policyId,
        evaluatedAt: new Date().toISOString(),
        idempotencyKey: key("w020-owner-assessment"),
      },
    );
    const { control } = await harness.runtime.riskControlService.activateControl(
      operatorCtx(harness, "w020-owner-control"),
      {
        organizationScopeId: harness.organizationScopeId,
        operationClass: "reward_allocation",
        action: "HOLD",
        subjectPersonId: harness.creatorPersonId,
        originAssessmentId: assessment.assessment.id,
        reasonCodes: ["supply_provenance_review"],
        idempotencyKey: key("w020-owner-control"),
      },
    );
    void control;
    await expect(
      executeCrossPromotionClearing(harness, world),
    ).rejects.toMatchObject({ code: "RISK_CONTROL" });
    // The creator's placement is the gated source context; nothing
    // was drawn.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-owner-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(0);
  });
});
