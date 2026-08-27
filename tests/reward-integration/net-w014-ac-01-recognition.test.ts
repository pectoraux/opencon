/**
 * NET-W014-AC-01 — verified helpful contribution/outcome can
 * deterministically enter canonical pending value (ECON-003; issue
 * #27 invariant 1).
 *
 * The recognition composite's qualification gate (VERIFIED lifecycle +
 * QUALIFIED PoH + moderation + quality floor) and the deterministic
 * source derivation (the contribution itself + the PoH's qualifying
 * bases) are proven end-to-end against the REAL authority chain.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW014Harness,
  createVerifiedSettledContribution,
  createRecognizedMatureValue,
  recognizeContributionValue,
  contributorCtx,
  key,
  type NetW014Harness,
} from "./_net-w014-harness.ts";
import { createQualifiedContribution } from "../contributions/_net-w013-harness.ts";
import { recordModerationDecision } from "../contributions/_net-w013-harness.ts";
import { defaultQualityShape } from "../contributions/_net-w013-harness.ts";
import { EVALUATED_AT } from "../contributions/_net-w013-harness.ts";

let harness: NetW014Harness;

beforeAll(async () => {
  harness = await createNetW014Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W014-AC-01 recognition of verified contribution value", () => {
  test("a VERIFIED + QUALIFIED contribution deterministically enters canonical PENDING value", async () => {
    const { contribution } = await createVerifiedSettledContribution(
      harness,
      { withMeasuredOutcomeBasis: true },
    );
    const result = await recognizeContributionValue(harness, contribution.id, {
      amount: 120.5,
    });
    expect(result.created).toBe(true);
    expect(result.value.state).toBe("PENDING");
    expect(result.value.amount).toBe(120.5);
    expect(result.value.beneficiaryPersonId).toBe(
      harness.contributorPersonId,
    );
    expect(result.value.organizationScopeId).toBe(harness.organizationScopeId);
    // The source derivation: the CONTRIBUTION itself (first-class
    // NET-W014 economic source) + the PoH's bases (evidence +
    // measured outcome), all re-resolved + VERIFIED-enforced by the
    // settlement input gate.
    const kinds = result.value.sources.map((s) => s.kind).sort();
    expect(kinds).toEqual([
      "contribution",
      "evidence",
      "measured_outcome",
    ]);
    const contributionSource = result.value.sources.find(
      (s) => s.kind === "contribution",
    )!;
    expect(contributionSource.id).toBe(contribution.id);
    // The recognition is a REAL ledger transaction (balanced,
    // audited lineage).
    expect(result.value.recognitionTransactionId).toBeTruthy();
  });

  test("determinism: the same contribution + amount + key replays idempotently (exactly-once)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const idem = key("w014-determinism");
    const first = await recognizeContributionValue(harness, contribution.id, {
      amount: 50,
      idempotencyKey: idem,
    });
    const replay = await recognizeContributionValue(harness, contribution.id, {
      amount: 50,
      idempotencyKey: idem,
    });
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(first.value.id);
    expect(replay.value.version).toBe(first.value.version);
    // The beneficiary's value list contains exactly ONE record for
    // this recognition.
    const values = await harness.runtime.economicValueService.listValues(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    const forThisKey = values.filter((v) => v.idempotencyKey === idem);
    expect(forThisKey.length).toBe(1);
  });

  test("an UNVERIFIED contribution (SUBMITTED) is REFUSED at the composite gate", async () => {
    // A qualified + published contribution that has NOT been driven
    // to VERIFIED (state SUBMITTED).
    const { contribution } = await createQualifiedContribution(harness.w013);
    await expect(
      recognizeContributionValue(harness, contribution.id, { amount: 10 }),
    ).rejects.toThrow(/not VERIFIED/i);
  });

  test("a contribution with an UNQUALIFIED PoH is REFUSED (verified helpfulness is required)", async () => {
    // A published contribution with NO qualifying basis: the PoH
    // evaluates INSUFFICIENT. It still reaches VERIFIED through the
    // lifecycle (the workflow authority does not check helpfulness),
    // but the recognition composite must refuse it.
    const { createHelpfulnessPolicy, createHelpfulContribution, publishHelpfulContribution } =
      await import("../contributions/_net-w012-harness.ts");
    const policy = await createHelpfulnessPolicy(harness.w012, {
      minimumQualifyingBases: 3,
    });
    const { contribution } = await createHelpfulContribution(harness.w012, {
      helpfulnessPolicyId: policy.policyId,
    });
    await publishHelpfulContribution(harness.w012, contribution.id);
    await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w014-ac01-poh"),
      { contributionId: contribution.id, idempotencyKey: key("w014-poh") },
    );
    // Drive to VERIFIED through the lifecycle (helpfulness does not
    // gate the workflow).
    const ctx = contributorCtx(harness, "w014-ac01-walk");
    const { policyActionFor } = await import("../../src/core/workflow.ts");
    const path = [
      "MEASURING",
      "EVALUATING",
      "CHALLENGE_WINDOW",
      "SETTLING",
      "SETTLED",
      "VERIFIED",
    ] as const;
    let current = await harness.runtime.contributionService.getContribution(
      ctx,
      contribution.id,
    );
    while (current.state !== "VERIFIED") {
      const from = current.state;
      const to = path[path.indexOf(from as (typeof path)[number]) + 1]!;
      await harness.runtime.workflowService.requestTransition(
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: to,
          expectedVersion: current.version,
          idempotencyKey: key("w014-ac01-t"),
          actorPersonId: harness.contributorPersonId,
          policyAction: policyActionFor(
            "contribution",
            from as "MEASURING",
            to as "VERIFIED",
          ),
        },
        ctx,
      );
      current = await harness.runtime.contributionService.getContribution(
        ctx,
        contribution.id,
      );
    }
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      ctx,
      contribution.id,
    );
    expect(poh.state).not.toBe("QUALIFIED");
    await expect(
      recognizeContributionValue(harness, contribution.id, { amount: 10 }),
    ).rejects.toThrow(/not QUALIFIED/i);
  });

  test("a REJECTED moderation decision blocks recognition (W013 integration)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const decision = await recordModerationDecision(harness.w013, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
    });
    expect(decision.decision.decision).toBe("REJECT");
    await expect(
      recognizeContributionValue(harness, contribution.id, { amount: 10 }),
    ).rejects.toThrow(/moderation status is REJECTED/i);
  });

  test("an UNSATISFACTORY latest quality evaluation blocks recognition (the deterministic W013 record)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    // A quality policy requiring an input kind (proof_of_value) the
    // contribution cannot satisfy: zero facts for a REQUIRED input →
    // the missing-input floor holds the band at UNSATISFACTORY.
    const { createQualityPolicy, recordQualityEvaluation } =
      await import("../contributions/_net-w013-harness.ts");
    const policy = await createQualityPolicy(harness.w013, {
      inputs: [
        { kind: "proof_of_value", weight: 1, minimumCount: 1 },
      ],
      requiredInputs: ["proof_of_value"],
      missingInputFloorBand: "UNSATISFACTORY",
    });
    const evaluation = await recordQualityEvaluation(
      harness.w013,
      contribution.id,
      policy.policyId,
    );
    expect(evaluation.band).toBe("UNSATISFACTORY");
    await expect(
      recognizeContributionValue(harness, contribution.id, { amount: 10 }),
    ).rejects.toThrow(/UNSATISFACTORY latest quality evaluation/i);
  });

  test("a QUALITY-carrying contribution (non-bottom band) recognizes fine — the gate is a floor, not a requirement", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness);
    const { createQualityPolicy, recordQualityEvaluation } =
      await import("../contributions/_net-w013-harness.ts");
    const policy = await createQualityPolicy(harness.w013);
    const evaluation = await recordQualityEvaluation(
      harness.w013,
      contribution.id,
      policy.policyId,
    );
    expect(evaluation.band).not.toBe("UNSATISFACTORY");
    const result = await recognizeContributionValue(harness, contribution.id, {
      amount: 30,
    });
    expect(result.value.state).toBe("PENDING");
    void EVALUATED_AT;
    void defaultQualityShape;
  });

  test("the SETTLEMENT input gate independently rejects a non-VERIFIED contribution source (double enforcement)", async () => {
    // The composite gate is a pre-flight; the AUTHORITATIVE gate is
    // inside recordPendingValue. A contribution source that is not
    // VERIFIED is rejected by the settlement domain itself.
    const { contribution } = await createQualifiedContribution(harness.w013);
    await expect(
      harness.runtime.economicValueService.recordPendingValue(
        harness.bootstrapCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.contributorPersonId,
          amount: 10,
          sources: [
            { kind: "contribution", id: contribution.id },
          ],
          idempotencyKey: key("w014-input-gate"),
        },
      ),
    ).rejects.toThrow(/not VERIFIED/i);
  });

  test("the full pipeline reaches MATURE through the existing maturation authority", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
    });
    expect(value.state).toBe("MATURE");
    expect(value.maturedAt).toBeTruthy();
    expect(value.maturationTransactionId).toBeTruthy();
  });
});
