/**
 * NET-W012-AC-02 — explicit, deterministic, evidence-backed criteria.
 *
 * The helpfulness policy lineage is explicit and versioned (the
 * W007-W011 lineage pattern); the PURE engine derives outcomes
 * deterministically from resolved authority facts (grade, confidence,
 * outcome type, state, subject, scope) — never from caller assertion.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  evaluateProofOfHelpfulness,
  evaluateBasis,
  gradeAtLeast,
  computeIndependentSourceKey,
  type PohBasisInput,
  type PohEngineInput,
  type PohPolicyView,
} from "../../src/contributions/poh-engine.ts";
import type { EvidenceGrade } from "../../src/core/evidence.ts";
import {
  evaluateCampaignEligibility,
} from "../../src/core/contributions.ts";
import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  defaultPolicySections,
  contributorCtx,
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

// A resolved, qualifying evidence basis for the synthetic engine tests.
function evidenceBasis(
  overrides: Partial<
    NonNullable<PohBasisInput["resolution"]>
  > = {},
  referenceId = "ev-1",
): PohBasisInput {
  return {
    kind: "evidence_record",
    referenceId,
    resolution: {
      organizationScopeId: "org-1",
      subjectId: "c-1",
      subjectType: "contribution",
      sourceType: "attested",
      grade: "ATTESTED",
      confidencePoint: 0.9,
      provenanceKey: "src-a",
      ...overrides,
    },
  };
}

function engineInput(
  overrides: Partial<PohEngineInput> = {},
): PohEngineInput {
  return {
    policy: {
      qualifyingBasisKinds: ["evidence_record", "measured_outcome", "proof_of_value"],
      minimumGrade: "ATTESTED",
      qualifyingSourceTypes: ["platform", "attested"],
      qualifyingOutcomeTypes: ["helpfulness"],
      minimumConfidence: 0.7,
      minimumIndependentSources: 1,
      minimumQualifyingBases: 1,
      requiresDisclosure: true,
    },
    bases: [evidenceBasis()],
    advisoryCount: 0,
    disclosureCompliant: true,
    hasCommercialMentions: false,
    contributionState: "SUBMITTED",
    organizationScopeId: "org-1",
    contributionId: "c-1",
    ...overrides,
  };
}

describe("NET-W012-AC-02 policy + engine", () => {
  test("policy versions are immutable, monotonic, tuple-idempotent under the lineage mutex", async () => {
    const policyId = key("w012-ac02-lineage");
    const v1Key = key("w012-ac02-v1");
    const v2Key = key("w012-ac02-v2");
    const first = await harness.runtime.helpfulnessService.defineHelpfulnessPolicy(
      contributorCtx(harness, "w012-ac02"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        sections: defaultPolicySections(),
        idempotencyKey: v1Key,
      },
    );
    expect(first.policy.version).toBe(1);
    expect(first.created).toBe(true);

    const second = await harness.runtime.helpfulnessService.defineHelpfulnessPolicy(
      contributorCtx(harness, "w012-ac02"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        sections: defaultPolicySections({ minimumConfidence: 0.8 }),
        idempotencyKey: v2Key,
      },
    );
    expect(second.policy.version).toBe(2);
    expect(second.policy.sections.minimumConfidence).toBe(0.8);

    // Tuple idempotency: the SAME key replays v2, never creates v3.
    const replay = await harness.runtime.helpfulnessService.defineHelpfulnessPolicy(
      contributorCtx(harness, "w012-ac02"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        sections: defaultPolicySections({ minimumConfidence: 0.8 }),
        idempotencyKey: v2Key,
      },
    );
    expect(replay.policy.version).toBe(2);
    expect(replay.created).toBe(false);

    const versions = await harness.runtime.helpfulnessService.listPolicyVersions(
      harness.bootstrapCtx,
      policyId,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    // Existing versions are NEVER rewritten (v1 keeps its sections).
    const v1 = versions[0]!;
    expect(v1.sections.minimumConfidence).toBe(0.7);
  });

  test("cross-scope lineage fork is rejected INCLUDING version 1 (org-independent mutex)", async () => {
    const policyId = key("w012-ac02-fork");
    await createHelpfulnessPolicy(harness, { policyId });
    await expect(
      harness.runtime.helpfulnessService.defineHelpfulnessPolicy(
        {
          correlationId: "w012-ac02-fork",
          executionId: "w012-ac02-fork",
          actor: { id: harness.secondOrgPersonId, kind: "person" },
        } as never,
        {
          organizationScopeId: harness.secondOrgId,
          policyId,
          sections: defaultPolicySections(),
          idempotencyKey: key("w012-ac02-fork"),
        },
      ),
    ).rejects.toThrow(/cross-scope lineage fork rejected/);
  });

  test("policy sections validate against the frozen vocabularies (grade floor, qualifying sources, outcome types)", async () => {
    // MODEL_ASSESSED can never be the policy minimum (AI is advisory).
    await expect(
      createHelpfulnessPolicy(harness, { minimumGrade: "MODEL_ASSESSED" }),
    ).rejects.toThrow(/advisory-only and can never be the policy minimum/);
    // model/self source types never qualify.
    await expect(
      createHelpfulnessPolicy(harness, {
        qualifyingSourceTypes: ["platform", "model"],
      }),
    ).rejects.toThrow(/model and self evidence NEVER qualify/);
    // Unknown outcome types are rejected.
    await expect(
      createHelpfulnessPolicy(harness, {
        qualifyingOutcomeTypes: ["not-an-outcome"],
      }),
    ).rejects.toThrow(/standard outcome types/);
    // Confidence bounds.
    await expect(
      createHelpfulnessPolicy(harness, { minimumConfidence: 1.5 }),
    ).rejects.toThrow(/\[0, 1\]/);
  });

  test("gradeAtLeast uses the frozen independence ordering (lower rank = stronger)", () => {
    expect(gradeAtLeast("MEASURED", "ATTESTED")).toBe(true);
    expect(gradeAtLeast("ATTESTED", "ATTESTED")).toBe(true);
    expect(gradeAtLeast("PROVIDER_REPORTED", "ATTESTED")).toBe(false);
    expect(gradeAtLeast("MODEL_ASSESSED", "PROVIDER_REPORTED")).toBe(false);
  });

  test("the engine qualifies a fully-resolved qualifying evidence basis", () => {
    const result = evaluateProofOfHelpfulness(engineInput());
    expect(result.outcome).toBe("QUALIFIED");
    expect(result.qualifyingBasisCount).toBe(1);
    expect(result.independentSourceCount).toBe(1);
    expect(result.reasons).toEqual([]);
  });

  test("grade below the policy minimum disqualifies the basis", () => {
    const result = evaluateProofOfHelpfulness(
      engineInput({
        bases: [evidenceBasis({ grade: "PROVIDER_REPORTED" as EvidenceGrade })],
      }),
    );
    expect(result.outcome).toBe("NOT_QUALIFIED");
    expect(result.reasons.join(" ")).toMatch(/below the policy minimum/);
  });

  test("confidence below the policy minimum disqualifies the basis (uncertainty is quantified)", () => {
    const result = evaluateProofOfHelpfulness(
      engineInput({ bases: [evidenceBasis({ confidencePoint: 0.5 })] }),
    );
    expect(result.outcome).toBe("NOT_QUALIFIED");
    expect(result.reasons.join(" ")).toMatch(/below the policy minimum 0.7/);
  });

  test("an unresolvable basis disqualifies (re-resolved at evaluation time)", () => {
    const result = evaluateProofOfHelpfulness(
      engineInput({
        bases: [{ kind: "evidence_record", referenceId: "gone-1", resolution: null }],
      }),
    );
    expect(result.outcome).toBe("NOT_QUALIFIED");
    expect(result.reasons.join(" ")).toMatch(/does not resolve/);
  });

  test("scope mismatch and subject mismatch disqualify (tenant isolation + subject binding)", () => {
    expect(
      evaluateProofOfHelpfulness(
        engineInput({ bases: [evidenceBasis({ organizationScopeId: "org-2" })] }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
    expect(
      evaluateProofOfHelpfulness(
        engineInput({ bases: [evidenceBasis({ subjectId: "other-contribution" })] }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
    expect(
      evaluateProofOfHelpfulness(
        engineInput({ bases: [evidenceBasis({ subjectType: "opportunity" })] }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
  });

  test("measured-outcome bases require VERIFIED + rollup confidence + a qualifying outcome type", () => {
    const ok: PohBasisInput = {
      kind: "measured_outcome",
      referenceId: "mo-1",
      resolution: {
        organizationScopeId: "org-1",
        subjectId: "c-1",
        subjectType: "contribution",
        outcomeType: "helpfulness",
        state: "VERIFIED",
        rollupConfidencePoint: 0.85,
      },
    };
    expect(evaluateProofOfHelpfulness(engineInput({ bases: [ok] })).outcome).toBe(
      "QUALIFIED",
    );
    // Not finalized.
    expect(
      evaluateProofOfHelpfulness(
        engineInput({
          bases: [
            { ...ok, resolution: { ...ok.resolution!, state: "MEASURING" } },
          ],
        }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
    // Wrong outcome type.
    expect(
      evaluateProofOfHelpfulness(
        engineInput({
          bases: [
            {
              ...ok,
              resolution: { ...ok.resolution!, outcomeType: "install" },
            },
          ],
        }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
    // No rollup confidence (uncertainty not quantified).
    expect(
      evaluateProofOfHelpfulness(
        engineInput({
          bases: [
            { ...ok, resolution: { ...ok.resolution!, rollupConfidencePoint: null } },
          ],
        }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
  });

  test("proof-of-value bases require VERIFIED (the /evidence gate)", () => {
    const pov: PohBasisInput = {
      kind: "proof_of_value",
      referenceId: "pov-1",
      resolution: {
        organizationScopeId: "org-1",
        subjectId: "c-1",
        subjectType: "contribution",
        state: "VERIFIED",
      },
    };
    expect(evaluateProofOfHelpfulness(engineInput({ bases: [pov] })).outcome).toBe(
      "QUALIFIED",
    );
    expect(
      evaluateProofOfHelpfulness(
        engineInput({
          bases: [{ ...pov, resolution: { ...pov.resolution!, state: "EVALUATING" } }],
        }),
      ).outcome,
    ).toBe("NOT_QUALIFIED");
  });

  test("minimumQualifyingBases and minimumIndependentSources are enforced independently", () => {
    // Two bases, ONE source type but distinct provenance keys → 2 sources.
    const twoSources = [
      evidenceBasis({ provenanceKey: "src-a" }),
      evidenceBasis({ provenanceKey: "src-b" }, "ev-2"),
    ];
    const strict = evaluateProofOfHelpfulness(
      engineInput({
        bases: twoSources,
        policy: {
          ...engineInput().policy,
          minimumQualifyingBases: 2,
          minimumIndependentSources: 2,
        },
      }),
    );
    expect(strict.outcome).toBe("QUALIFIED");
    expect(strict.independentSourceCount).toBe(2);

    // One basis cannot satisfy a 2-basis minimum.
    const short = evaluateProofOfHelpfulness(
      engineInput({
        policy: {
          ...engineInput().policy,
          minimumQualifyingBases: 2,
        },
      }),
    );
    expect(short.outcome).toBe("NOT_QUALIFIED");
    expect(short.reasons.join(" ")).toMatch(/requires at least 2/);

    // Same provenance key twice → ONE independent source.
    const dupSource = evaluateProofOfHelpfulness(
      engineInput({
        bases: [evidenceBasis({ provenanceKey: "src-a" }), evidenceBasis({ provenanceKey: "src-a" }, "ev-2")],
        policy: {
          ...engineInput().policy,
          minimumIndependentSources: 2,
        },
      }),
    );
    expect(dupSource.outcome).toBe("NOT_QUALIFIED");
    expect(dupSource.reasons.join(" ")).toMatch(/independent source/);
  });

  test("computeIndependentSourceKey derives deterministic provenance keys per basis kind", () => {
    expect(
      computeIndependentSourceKey(evidenceBasis()),
    ).toBe("evidence:attested:src-a");
    expect(
      computeIndependentSourceKey({
        kind: "measured_outcome",
        referenceId: "mo-9",
        resolution: {
          organizationScopeId: "org-1",
          subjectId: "c-1",
          subjectType: "contribution",
        },
      }),
    ).toBe("measurement:mo-9");
    expect(
      computeIndependentSourceKey({
        kind: "proof_of_value",
        referenceId: "pov-9",
        resolution: {
          organizationScopeId: "org-1",
          subjectId: "c-1",
          subjectType: "contribution",
        },
      }),
    ).toBe("pov:pov-9");
  });

  test("evaluateBasis rejects a kind the policy does not enable", () => {
    const failure = evaluateBasis(
      engineInput({ policy: { ...engineInput().policy, qualifyingBasisKinds: ["proof_of_value"] } }),
      evidenceBasis(),
    );
    expect(failure).toMatch(/not a qualifying basis kind/);
  });

  test("the PURE campaign-eligibility evaluator is deterministic and fail-closed", () => {
    const rules = [
      { attribute: "participant_class", operator: "equals", values: ["contributor"] },
      { attribute: "region", operator: "in", values: ["eu", "us"] },
    ] as const;
    expect(
      evaluateCampaignEligibility(rules, {
        participant_class: ["contributor"],
        region: ["eu"],
      }),
    ).toEqual({ eligible: true, failures: [] });
    expect(
      evaluateCampaignEligibility(rules, {
        participant_class: ["viewer"],
        region: ["eu"],
      }).eligible,
    ).toBe(false);
    // Missing attribute → fail-closed.
    const missing = evaluateCampaignEligibility(rules, {
      participant_class: ["contributor"],
    });
    expect(missing.eligible).toBe(false);
    expect(missing.failures.join(" ")).toMatch(/did not declare attribute 'region'/);
    // operators: not_in / gte / lte determinism.
    expect(
      evaluateCampaignEligibility(
        [{ attribute: "region", operator: "not_in", values: [" sanctioned-x"] }],
        { region: ["eu"] },
      ).eligible,
    ).toBe(true);
    expect(
      evaluateCampaignEligibility(
        [{ attribute: "region", operator: "gte", values: ["10"] }],
        { region: ["25"] },
      ).eligible,
    ).toBe(true);
    expect(
      evaluateCampaignEligibility(
        [{ attribute: "region", operator: "lte", values: ["10"] }],
        { region: ["25"] },
      ).eligible,
    ).toBe(false);
  });
});
