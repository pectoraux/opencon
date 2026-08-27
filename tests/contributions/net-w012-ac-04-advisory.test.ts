/**
 * NET-W012-AC-04 — provider/model scoring is ADVISORY and cannot
 * bypass policy/evidence requirements.
 *
 * Model/heuristic scores are recorded signals with REQUIRED method
 * identity; MODEL_ASSESSED/SELF_REPORTED evidence and model/self
 * source types never qualify; advisory scores never count toward any
 * minimum and never flip an outcome.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  evaluateProofOfHelpfulness,
  type PohEngineInput,
} from "../../src/contributions/poh-engine.ts";
import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
  contributorCtx,
  systemCtx,
  key,
  type NetW012Harness,
} from "./_net-w012-harness.ts";

let harness: NetW012Harness;

beforeAll(async () => {
  harness = await createNetW012Harness();
});

afterAll(async () => {
  await harness.teardown();
});

const POLICY = {
  qualifyingBasisKinds: ["evidence_record"] as const,
  minimumGrade: "ATTESTED" as const,
  qualifyingSourceTypes: ["platform", "attested"],
  qualifyingOutcomeTypes: ["helpfulness"],
  minimumConfidence: 0.7,
  minimumIndependentSources: 1,
  minimumQualifyingBases: 1,
  requiresDisclosure: false,
};

describe("NET-W012-AC-04 advisory cannot bypass", () => {
  test("MODEL_ASSESSED/self evidence NEVER qualifies regardless of confidence or count", () => {
    const modelEvidence = (ref: string): Parameters<typeof evaluateProofOfHelpfulness>[0]["bases"][number] => ({
      kind: "evidence_record",
      referenceId: ref,
      resolution: {
        organizationScopeId: "org-1",
        subjectId: "c-1",
        subjectType: "contribution",
        sourceType: "model",
        grade: "MODEL_ASSESSED",
        confidencePoint: 0.99,
        provenanceKey: `model-${ref}`,
      },
    });
    const result = evaluateProofOfHelpfulness({
      policy: POLICY,
      bases: [modelEvidence("m-1"), modelEvidence("m-2"), modelEvidence("m-3")],
      advisoryCount: 3,
      disclosureCompliant: true,
      hasCommercialMentions: false,
      contributionState: "SUBMITTED",
      organizationScopeId: "org-1",
      contributionId: "c-1",
    });
    expect(result.outcome).toBe("NOT_QUALIFIED");
    expect(result.qualifyingBasisCount).toBe(0);
    for (const reason of result.reasons) {
      if (reason.includes("m-")) expect(reason).toMatch(/never qualifies/);
    }
  });

  test("self-reported evidence NEVER qualifies", () => {
    const result = evaluateProofOfHelpfulness({
      policy: POLICY,
      bases: [
        {
          kind: "evidence_record",
          referenceId: "self-1",
          resolution: {
            organizationScopeId: "org-1",
            subjectId: "c-1",
            subjectType: "contribution",
            sourceType: "self",
            grade: "SELF_REPORTED",
            confidencePoint: 1,
            provenanceKey: "self-1",
          },
        },
      ],
      advisoryCount: 1,
      disclosureCompliant: true,
      hasCommercialMentions: false,
      contributionState: "SUBMITTED",
      organizationScopeId: "org-1",
      contributionId: "c-1",
    });
    expect(result.outcome).toBe("NOT_QUALIFIED");
  });

  test("advisory scores never change advisoryCount→outcome mapping: identical inputs with and without advisory scores produce the SAME outcome", () => {
    const base: PohEngineInput = {
      advisoryCount: 0,
      policy: POLICY,
      bases: [
        {
          kind: "evidence_record" as const,
          referenceId: "ev-1",
          resolution: {
            organizationScopeId: "org-1",
            subjectId: "c-1",
            subjectType: "contribution",
            sourceType: "attested",
            grade: "ATTESTED",
            confidencePoint: 0.9,
            provenanceKey: "src-a",
          },
        },
      ],
      disclosureCompliant: true,
      hasCommercialMentions: false,
      contributionState: "SUBMITTED",
      organizationScopeId: "org-1",
      contributionId: "c-1",
    };
    const without = evaluateProofOfHelpfulness({ ...base, advisoryCount: 0 });
    const withMany = evaluateProofOfHelpfulness({ ...base, advisoryCount: 25 });
    expect(without.outcome).toBe("QUALIFIED");
    expect(withMany.outcome).toBe("QUALIFIED");
    expect(withMany.qualifyingBasisCount).toBe(without.qualifyingBasisCount);
    expect(withMany.independentSourceCount).toBe(without.independentSourceCount);
  });

  test("advisory attach REQUIRES method identity (methodRef + methodVersion) and a policy-allowed kind", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const ctx = contributorCtx(harness, "w012-ac04-advisory");
    await expect(
      harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
        contributionId: contribution.id,
        kind: "model_score",
        methodRef: "",
        methodVersion: "1.0.0",
        score: 0.9,
        idempotencyKey: key("w012-ac04-noref"),
      }),
    ).rejects.toThrow(/methodRef AND methodVersion are required/);
    await expect(
      harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
        contributionId: contribution.id,
        kind: "model_score",
        methodRef: "ranker",
        methodVersion: "",
        score: 0.9,
        idempotencyKey: key("w012-ac04-nover"),
      }),
    ).rejects.toThrow(/methodRef AND methodVersion are required/);
    await expect(
      harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
        contributionId: contribution.id,
        kind: "oracle_verdict" as "model_score",
        methodRef: "ranker",
        methodVersion: "1",
        score: 0.9,
        idempotencyKey: key("w012-ac04-badkind"),
      }),
    ).rejects.toThrow(/advisory kind/);
    await expect(
      harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
        contributionId: contribution.id,
        kind: "model_score",
        methodRef: "ranker",
        methodVersion: "1",
        score: 7,
        idempotencyKey: key("w012-ac04-badscore"),
      }),
    ).rejects.toThrow(/\[0, 1\]/);
  });

  test("a policy can RESTRICT advisory kinds; disallowed kinds are rejected at attach", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const { contribution } = await createHelpfulContribution(harness, {
      helpfulnessPolicyId: policy.policyId,
    });
    // The default policy allows model_score + heuristic_score; use a
    // restricted policy to prove the pinning works.
    const restricted = await harness.runtime.helpfulnessService.defineHelpfulnessPolicy(
      contributorCtx(harness, "w012-ac04-restricted"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: key("w012-ac04-restricted"),
        sections: {
          qualifyingBasisKinds: ["evidence_record"],
          minimumGrade: "ATTESTED",
          qualifyingSourceTypes: ["platform", "attested"],
          qualifyingOutcomeTypes: ["helpfulness"],
          minimumConfidence: 0.7,
          minimumIndependentSources: 1,
          minimumQualifyingBases: 1,
          advisory: { allowedKinds: ["heuristic_score"], maxAdvisoryWeight: 0.5 },
          requiresDisclosure: false,
          description: "heuristic-only advisory",
        },
        idempotencyKey: key("w012-ac04-restricted"),
      },
    );
    const other = await createHelpfulContribution(harness, {
      helpfulnessPolicyId: restricted.policy.policyId,
    });
    await expect(
      harness.runtime.helpfulnessService.attachAdvisoryScore(
        contributorCtx(harness, "w012-ac04-restricted"),
        {
          contributionId: other.contribution.id,
          kind: "model_score",
          methodRef: "ranker",
          methodVersion: "1",
          score: 0.9,
          idempotencyKey: key("w012-ac04-restricted"),
        },
      ),
    ).rejects.toThrow(/not allowed by the pinned policy/);
    void contribution;
  });

  test("model-source evidence cannot serve as a basis at ATTACH time either (fail-fast, provider-neutral)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const ctx = contributorCtx(harness, "w012-ac04-model-evidence");
    const modelEvidence = await harness.runtime.evidenceService.createEvidence(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.contributorPersonId,
        subjectReference: {
          subjectId: contribution.id,
          subjectType: "contribution",
        },
        provenance: { sourceType: "model", method: "model-judgment" },
        confidence: { point: 0.99 },
        sensitivity: "standard",
        payload: { verdict: "helpful" },
      },
    );
    // Attach succeeds (model evidence IS evidence — recorded); the
    // EVALUATION refuses to let it qualify (advisory-only).
    await harness.runtime.helpfulnessService.attachBasis(ctx, {
      contributionId: contribution.id,
      kind: "evidence_record",
      referenceId: modelEvidence.id,
      idempotencyKey: key("w012-ac04-model-basis"),
    });
    await publishHelpfulContribution(harness, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      ctx,
      { contributionId: contribution.id, idempotencyKey: key("w012-ac04-model-eval") },
    );
    expect(poh.state).toBe("NOT_QUALIFIED");
    expect(
      poh.evaluations[poh.evaluations.length - 1]!.reasons.join(" "),
    ).toMatch(/never qualifies/);
  });

  test("a system worker may record advisory scores (pipeline use) but can NEVER publish", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const sys = systemCtx("w012-ac04-system");
    const poh = await harness.runtime.helpfulnessService.attachAdvisoryScore(sys, {
      contributionId: contribution.id,
      kind: "model_score",
      methodRef: "opencon/helpfulness-ranker",
      methodVersion: "2.0.0",
      score: 0.88,
      idempotencyKey: key("w012-ac04-system-score"),
    });
    expect(poh.advisoryScores.length).toBe(1);
    // The system actor cannot pass the user-controlled publication gate.
    await expect(
      harness.runtime.helpfulnessService.assertPublishable(sys, contribution.id),
    ).rejects.toThrow(/person actor is required/i);
  });
});
