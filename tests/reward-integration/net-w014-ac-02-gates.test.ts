/**
 * NET-W014-AC-02 — settlement respects maturation + fraud/dispute
 * gates and cannot bypass /disputes (issue #27 invariant 2; lock
 * invariant 21).
 *
 * The NET-W014 contribution source lineage closes the loop: a risk
 * control or ACTIVE dispute covering the CONTRIBUTION (or any basis)
 * now gates maturation/consumption of value recognized from it —
 * through the EXISTING composition-root gate machinery, with the
 * settlement domain untouched.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW014Harness,
  createRecognizedMatureValue,
  createVerifiedSettledContribution,
  recognizeContributionValue,
  createClearingCampaign,
  contributorCtx,
  moderatorCtx,
  key,
  type NetW014Harness,
} from "./_net-w014-harness.ts";
import { createDefaultRiskPolicy } from "../disputes/_net-w009-harness.ts";
import {
  openDefaultDispute,
  openBondedDispute,
} from "../disputes/_net-w010-harness.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";

let harness: NetW014Harness;

beforeAll(async () => {
  harness = await createNetW014Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Activate a HOLD risk control sourced from a real assessment. */
async function holdContribution(
  contributionId: string,
  operationClass: "value_maturation" | "reward_allocation" | "credit_issuance",
): Promise<string> {
  const w009 = harness.w012.w011.w010.w009;
  const policy = await createDefaultRiskPolicy(w009, key("w014-risk-policy"));
  const ctx = moderatorCtx(harness, "w014-assessment");
  const assessment = await harness.runtime.riskAssessmentService.recordAssessment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.contributorPersonId,
      policyId: policy.policyId,
      evaluatedAt: new Date().toISOString(),
      idempotencyKey: key("w014-assessment"),
    },
  );
  const controlCtx = moderatorCtx(harness, "w014-control");
  const { control } = await harness.runtime.riskControlService.activateControl(
    controlCtx,
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass,
      action: "HOLD",
      subjectRef: { subjectType: "contribution", subjectId: contributionId },
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["collusion_pattern"],
      idempotencyKey: key("w014-control"),
    },
  );
  return control.id;
}

describe("NET-W014-AC-02 maturation/consumption gates (no /disputes bypass)", () => {
  test("a HOLD risk control on the CONTRIBUTION refuses maturation of value recognized from it", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 40,
    });
    const controlId = await holdContribution(
      contribution.id,
      "value_maturation",
    );
    void controlId;
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        moderatorCtx(harness, "w014-mature-blocked"),
        {
          valueRecordId: recognized.value.id,
          idempotencyKey: key("w014-mature"),
        },
      ),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL",
      context: expect.objectContaining({
        recordSubjectId: contribution.id,
      }),
    });
  });

  test("resolving the control lifts the gate (maturation then succeeds)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 40,
    });
    const controlId = await holdContribution(
      contribution.id,
      "value_maturation",
    );
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        moderatorCtx(harness, "w014-mature-blocked"),
        {
          valueRecordId: recognized.value.id,
          idempotencyKey: key("w014-mature"),
        },
      ),
    ).rejects.toMatchObject({ code: "RISK_CONTROL" });
    await harness.runtime.riskControlService.resolveControl(
      moderatorCtx(harness, "w014-resolve"),
      {
        controlDecisionId: controlId,
        note: "cleared after review",
        idempotencyKey: key("w014-resolve"),
      },
    );
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      moderatorCtx(harness, "w014-mature-open"),
      {
        valueRecordId: recognized.value.id,
        idempotencyKey: key("w014-mature-open"),
      },
    );
    expect((matured as unknown as EconomicValueRecord).state).toBe("MATURE");
  });

  test("an ACTIVE dispute on the CONTRIBUTION refuses maturation (the contribution source lineage)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 40,
    });
    // A bonded (staked, formal) dispute over the contribution itself.
    await openBondedDispute(harness.w012.w011.w010, {
      subjectType: "contribution",
      subjectId: contribution.id,
      supportingRefs: [{ kind: "contribution", id: contribution.id }],
      effectiveAt: new Date().toISOString(),
      challengerPersonId: harness.w012.w011.w010.challengerPersonId,
    });
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        moderatorCtx(harness, "w014-mature-disputed"),
        {
          valueRecordId: recognized.value.id,
          idempotencyKey: key("w014-mature"),
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_CHALLENGE",
      context: expect.objectContaining({
        subjectType: "contribution",
        subjectId: contribution.id,
      }),
    });
  });

  test("an ACTIVE dispute on a BASIS record refuses maturation (the basis source lineage)", async () => {
    const { contribution, measuredOutcomeId } =
      await createVerifiedSettledContribution(harness, {
        withMeasuredOutcomeBasis: true,
      });
    expect(measuredOutcomeId).toBeTruthy();
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 40,
    });
    await openBondedDispute(harness.w012.w011.w010, {
      subjectType: "measured_outcome",
      subjectId: measuredOutcomeId!,
      supportingRefs: [
        { kind: "measured_outcome", id: measuredOutcomeId! },
      ],
      effectiveAt: new Date().toISOString(),
      challengerPersonId: harness.w012.w011.w010.challengerPersonId,
    });
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        moderatorCtx(harness, "w014-mature-basis-disputed"),
        {
          valueRecordId: recognized.value.id,
          idempotencyKey: key("w014-mature"),
        },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
  });

  test("an UNBONDED (PENDING_STAKE) dispute does NOT freeze value (griefing resistance holds at the integration level)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 40,
    });
    // openDefaultDispute leaves the dispute PENDING_STAKE (unbonded).
    await openDefaultDispute(harness.w012.w011.w010, {
      subjectType: "contribution",
      subjectId: contribution.id,
      supportingRefs: [{ kind: "contribution", id: contribution.id }],
      effectiveAt: new Date().toISOString(),
      challengerPersonId: harness.w012.w011.w010.challengerPersonId,
    });
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      moderatorCtx(harness, "w014-mature-unbonded"),
      {
        valueRecordId: recognized.value.id,
        idempotencyKey: key("w014-mature"),
      },
    );
    expect((matured as unknown as EconomicValueRecord).state).toBe("MATURE");
  });

  test("a person-scoped HOLD control refuses the reward-allocation consumption", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 40,
    });
    await harness.runtime.apiCommands.matureEconomicValue(
      moderatorCtx(harness, "w014-mature-ok"),
      {
        valueRecordId: recognized.value.id,
        idempotencyKey: key("w014-mature"),
      },
    );
    // A person-wide HOLD on reward_allocation for the contributor.
    const w009 = harness.w012.w011.w010.w009;
    const policy = await createDefaultRiskPolicy(w009, key("w014-person-policy"));
    const ctx = moderatorCtx(harness, "w014-person-assessment");
    const assessment =
      await harness.runtime.riskAssessmentService.recordAssessment(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        policyId: policy.policyId,
        evaluatedAt: new Date().toISOString(),
        idempotencyKey: key("w014-person-assessment"),
      });
    await harness.runtime.riskControlService.activateControl(
      moderatorCtx(harness, "w014-person-control"),
      {
        organizationScopeId: harness.organizationScopeId,
        operationClass: "reward_allocation",
        action: "HOLD",
        subjectPersonId: harness.contributorPersonId,
        originAssessmentId: assessment.assessment.id,
        reasonCodes: ["sybil_pattern"],
        idempotencyKey: key("w014-person-control"),
      },
    );
    await expect(
      harness.runtime.apiCommands.allocateRewards(
        moderatorCtx(harness, "w014-allocate-blocked"),
        {
          organizationScopeId: harness.organizationScopeId,
          sourceValueRecordId: recognized.value.id,
          policyId: "any-policy",
          idempotencyKey: key("w014-allocate"),
        },
      ),
    ).rejects.toMatchObject({ code: "RISK_CONTROL" });
  });

  test("clearing is refused while an ACTIVE dispute covers the value record (AC-03 gate wiring)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const campaign = await createClearingCampaign(harness);
    await openBondedDispute(harness.w012.w011.w010, {
      subjectType: "economic_value",
      subjectId: value.id,
      supportingRefs: [{ kind: "economic_value", id: value.id }],
      effectiveAt: new Date(
        Date.parse(value.recordedAt) + 60_000,
      ).toISOString(),
      challengerPersonId: harness.w012.w011.w010.challengerPersonId,
    });
    await expect(
      harness.runtime.apiCommands.executeCampaignClearing(
        contributorCtx(harness, "w014-clear-disputed"),
        harness.contributorPersonId,
        {
          campaignId: campaign.id,
          valueRecordId: value.id,
          idempotencyKey: key("w014-clear"),
        },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
  });
});
