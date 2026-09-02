/**
 * NET-W033-AC-06 — Settlement composition (issue #67 §4 AC-06).
 *
 * Verified contribution value reaches /settlement through sanctioned
 * pending/mature paths, with existing risk/dispute controls honored;
 * no second economic record is created by W033:
 *  - recognition → exactly ONE PENDING record whose sources are the
 *    contribution + its PoH bases (references, resolved by
 *    /settlement's own input gate);
 *  - maturation → MATURE with the recorded maturation anchor;
 *  - an ACTIVE HOLD risk control (value_maturation) over the
 *    contribution REFUSES the maturation (RISK_CONTROL, before the
 *    settlement mutation); resolving the control re-opens it;
 *  - an ACTIVE OPEN dispute over the value record REFUSES the
 *    maturation (DISPUTE_CHALLENGE); resolving the dispute re-opens
 *    it (the value stays PENDING — no partial state);
 *  - recognition of a NON-VERIFIED contribution fails closed
 *    (ECONOMIC_VALIDATION);
 *  - same-key recognition replay is exactly-once (created=false, the
 *    SAME record id, exactly ONE record for the contribution);
 *  - the global envelope stays conserved end-to-end.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  type NetW033Harness,
} from "./_net-w033-harness.ts";
import {
  createVerifiedSettledContribution,
  recognizeContributionValue,
  type NetW014Harness,
} from "../reward-integration/_net-w014-harness.ts";
import { createDefaultRiskPolicy } from "../disputes/_net-w009-harness.ts";
import { ensureCreditsFor } from "../disputes/_net-w010-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW033Harness;
let scenario: Awaited<ReturnType<typeof runCanonicalScenario>>;

beforeAll(async () => {
  harness = await createNetW033Harness();
  scenario = await runCanonicalScenario(harness, {
    skipBenefitAllocation: true,
  });
});

afterAll(async () => {
  await harness.teardown();
});

/** Activate a HOLD risk control on value_maturation over the subject. */
async function holdMaturation(
  subjectType:
    | "contribution"
    | "proof_of_value"
    | "measured_outcome"
    | "economic_value"
    | "credit_issuance"
    | "cash_obligation",
  subjectId: string,
): Promise<string> {
  const w009 = harness.w014.w013.w012.w011.w010.w009;
  const policy = await createDefaultRiskPolicy(w009, key("w033-risk-policy"));
  const ctx = harness.moderatorCtx("w033-ac06-assessment");
  const assessment = await harness.runtime.riskAssessmentService.recordAssessment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.contributorPersonId,
      policyId: policy.policyId,
      evaluatedAt: "2024-07-01T00:00:00.000Z",
      idempotencyKey: key("w033-ac06-assessment"),
    },
  );
  const { control } = await harness.runtime.riskControlService.activateControl(
    harness.moderatorCtx("w033-ac06-control"),
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectRef: { subjectType, subjectId },
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["collusion_pattern"],
      idempotencyKey: key("w033-ac06-control"),
    },
  );
  return control.id;
}

/** Open + bond a dispute over the subject (the challenger holds credits). */
async function openBondedDisputeOn(
  subjectType: "contribution" | "proof_of_value" | "measured_outcome" | "economic_value",
  subjectId: string,
): Promise<string> {
  const w010 = harness.w014.w013.w012.w011.w010;
  await ensureCreditsFor(w010, harness.moderatorPersonId, 50);
  const ctx = harness.moderatorCtx("w033-ac06-dispute");
  const opened = await harness.runtime.disputeService.openDispute(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectRef: { subjectType, subjectId },
    statement: "the challenged value misstates verified contribution value",
    reasonCodes: ["contested_verification"],
    supportingRefs: [{ kind: subjectType, id: subjectId }],
    effectiveAt: new Date(Date.now() + 3600_000).toISOString(),
    idempotencyKey: key("w033-ac06-dispute"),
  });
  const dispute = opened.dispute;
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: dispute.organizationScopeId,
    ownerPersonId: dispute.challengerPersonId,
    amount: dispute.stake.requirement.amount,
    purpose: { kind: "dispute_challenge", id: dispute.id },
    description: `challenge stake for dispute ${dispute.id}`,
    idempotencyKey: key("w033-ac06-stake"),
  });
  const bonded = await harness.runtime.disputeService.bondStake(ctx, {
    disputeId: dispute.id,
    stakeId: staked.stake.id,
    idempotencyKey: key("w033-ac06-bond"),
  });
  return bonded.id;
}

describe("NET-W033-AC-06 settlement composition", () => {
  test("recognition produces exactly ONE PENDING record with reference sources resolved by /settlement's own gate", async () => {
    const ctx = harness.contributorCtx("w033-ac06-pending");
    const value = await harness.runtime.economicValueService.getValue(
      ctx,
      scenario.value.id,
    );
    expect(value.state).toBe("MATURE"); // recognized then matured.
    expect(value.amount).toBe(100);
    // The sources are REFERENCES (kind + id) — resolved server-side
    // against the same-scope VERIFIED authority records.
    const kinds = value.sources.map((s) => s.kind).sort();
    expect(kinds).toContain("contribution");
    expect(value.sources.map((s) => s.id)).toContain(scenario.contribution.id);
    // Exactly ONE economic value record exists for the contribution
    // (no second record created by W033).
    const values = await harness.runtime.economicValueService.listValues(
      ctx,
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    const forThisContribution = values.filter((v) =>
      v.sources.some((s) => s.id === scenario.contribution.id),
    );
    expect(forThisContribution).toHaveLength(1);
  });

  test("maturation records the anchor (MATURE with maturedAt)", async () => {
    const ctx = harness.contributorCtx("w033-ac06-mature");
    const value = await harness.runtime.economicValueService.getValue(
      ctx,
      scenario.matureValue.id,
    );
    expect(value.state).toBe("MATURE");
    expect(typeof value.maturedAt).toBe("string");
    expect(Date.parse(value.maturedAt as string)).not.toBeNaN();
    // The maturation audit event carries the lineage.
    const events = await harness.runtime.auditWriter.query({
      eventType: "economic_value.matured",
      resourceId: value.id,
    });
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.metadata?.transactionId).toBe("string");
  });

  test("an ACTIVE HOLD risk control over the CONTRIBUTION refuses the maturation (before the settlement mutation)", async () => {
    // A fresh PENDING record (the canonical one is already MATURE).
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const pending = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 30,
    });
    expect(pending.value.state).toBe("PENDING");
    const controlId = await holdMaturation("contribution", contribution.id);
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        harness.moderatorCtx("w033-ac06-gated"),
        { valueRecordId: pending.value.id, idempotencyKey: key("w033-ac06-mature") },
      ),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL",
      context: expect.objectContaining({ recordSubjectId: contribution.id }),
    });
    // The value record is UNCHANGED (still PENDING — no partial state).
    const still = await harness.runtime.economicValueService.getValue(
      harness.contributorCtx("w033-ac06-gated-read"),
      pending.value.id,
    );
    expect(still.state).toBe("PENDING");
    // Resolving the control lifts the gate.
    await harness.runtime.riskControlService.resolveControl(
      harness.moderatorCtx("w033-ac06-resolve-control"),
      {
        controlDecisionId: controlId,
        note: "cleared after review",
        idempotencyKey: key("w033-ac06-resolve"),
      },
    );
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      harness.moderatorCtx("w033-ac06-mature-after"),
      { valueRecordId: pending.value.id, idempotencyKey: key("w033-ac06-mature2") },
    );
    expect(matured.state).toBe("MATURE");
  });

  test("an ACTIVE OPEN dispute over the value record refuses the maturation until resolved", async () => {
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const pending = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 20,
    });
    const disputeId = await openBondedDisputeOn("economic_value", pending.value.id);
    expect(disputeId).not.toBe("");
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        harness.moderatorCtx("w033-ac06-disputed"),
        { valueRecordId: pending.value.id, idempotencyKey: key("w033-ac06-dm") },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
    // The record stays PENDING — no partial maturation.
    const still = await harness.runtime.economicValueService.getValue(
      harness.contributorCtx("w033-ac06-disputed-read"),
      pending.value.id,
    );
    expect(still.state).toBe("PENDING");
    // Resolving the dispute re-opens the maturation (due process:
    // review first, then resolution — the reviewer must not be the
    // challenger: conflict of interest).
    await harness.runtime.disputeService.startReview(
      harness.memberCCtx("w033-ac06-review"),
      {
        disputeId,
        idempotencyKey: key("w033-ac06-review"),
      },
    );
    await harness.runtime.disputeService.resolveDispute(
      harness.memberCCtx("w033-ac06-resolve-dispute"),
      {
        disputeId,
        outcome: "DISMISSED",
        controlDisposition: "RELEASE_CONTROL",
        reasonCodes: ["no_merit"],
        sourceRefs: [{ kind: "economic_value", id: pending.value.id }],
        note: "no merit",
        idempotencyKey: key("w033-ac06-resolve-d"),
      },
    );
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      harness.moderatorCtx("w033-ac06-mature-after-d"),
      { valueRecordId: pending.value.id, idempotencyKey: key("w033-ac06-dm2") },
    );
    expect(matured.state).toBe("MATURE");
  });

  test("recognition of a NON-VERIFIED contribution fails closed (ECONOMIC_VALIDATION)", async () => {
    // A contribution that passes EVERY OTHER recognition gate (the
    // evidence/PoV/measured-outcome bases attached, PoH QUALIFIED,
    // published) but is stopped at SUBMITTED — the VERIFIED
    // lifecycle gate is the ONLY thing standing between it and the
    // economic record.
    const {
      createHelpfulnessPolicy,
      createHelpfulContribution,
      attachEvidenceBasis,
      publishHelpfulContribution,
    } = await import("../contributions/_net-w012-harness.ts");
    const { attachProofOfValueBasis, attachMeasuredOutcomeBasis } = await import(
      "../reward-integration/_net-w014-harness.ts"
    );
    const policy = await createHelpfulnessPolicy(harness.w014.w012);
    const { contribution } = await createHelpfulContribution(harness.w014.w012, {
      helpfulnessPolicyId: policy.policyId,
      idempotencyKey: key("w033-ac06-unverified"),
    });
    await attachEvidenceBasis(harness.w014.w012, contribution.id);
    await attachProofOfValueBasis(harness.w014, contribution.id);
    await attachMeasuredOutcomeBasis(harness.w014, contribution.id);
    await publishHelpfulContribution(harness.w014.w012, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      harness.contributorCtx("w033-ac06-unverified-poh"),
      { contributionId: contribution.id, idempotencyKey: key("w033-ac06-poh") },
    );
    expect(poh.state).toBe("QUALIFIED");
    const current = await harness.runtime.contributionService.getContribution(
      harness.contributorCtx("w033-ac06-unverified-read"),
      contribution.id,
    );
    expect(current.state).toBe("SUBMITTED");
    await expect(
      recognizeContributionValue(harness.w014, contribution.id, { amount: 10 }),
    ).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      classification: "precondition",
    });
    // And NO economic record was created for it.
    const values = await harness.runtime.economicValueService.listValues(
      harness.contributorCtx("w033-ac06-unverified-list"),
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    expect(
      values.filter((v) => v.sources.some((s) => s.id === contribution.id)),
    ).toHaveLength(0);
  });

  test("same-key recognition replay is exactly-once (created=false, SAME record, ONE record total)", async () => {
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const idempotencyKey = key("w033-ac06-replay");
    const first = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 55,
      idempotencyKey,
    });
    expect(first.created).toBe(true);
    const replay = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 55,
      idempotencyKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(first.value.id);
    // Exactly ONE record for the contribution (list read).
    const ctx = harness.contributorCtx("w033-ac06-replay-read");
    const values = await harness.runtime.economicValueService.listValues(
      ctx,
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    const forThis = values.filter((v) =>
      v.sources.some((s) => s.id === contribution.id),
    );
    expect(forThis).toHaveLength(1);
  });

  test("the global economic envelope stays conserved across the composed path", async () => {
    await assertGlobalConservation(
      harness.w014.w013.w012.w011.w010.w009.w008,
    );
  });
});

export type { NetW014Harness };
