/**
 * NET-W012-AC-03 — product mention alone has NO final reward
 * authority.
 *
 * Mentions are recorded metadata for disclosure compliance ONLY.
 * Structurally: the engine receives mentions solely through the
 * disclosure-compliance boolean; no count, weight, score or bonus
 * path exists from a mention to qualification. Mentions + advisory
 * scores + no qualifying basis ⇒ NOT_QUALIFIED — always.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { evaluateProofOfHelpfulness } from "../../src/contributions/poh-engine.ts";
import {
  createNetW012Harness,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
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

const POLICY = {
  qualifyingBasisKinds: ["evidence_record", "measured_outcome", "proof_of_value"] as const,
  minimumGrade: "ATTESTED" as const,
  qualifyingSourceTypes: ["platform", "attested"],
  qualifyingOutcomeTypes: ["helpfulness"],
  minimumConfidence: 0.7,
  minimumIndependentSources: 1,
  minimumQualifyingBases: 1,
  requiresDisclosure: true,
};

const MANY_MENTIONS = Array.from({ length: 50 }, (_, i) => ({
  productRef: `product:mentioned-${String(i)}`,
  disclosed: true,
  commercialRelationshipRef: null,
}));

describe("NET-W012-AC-03 mention ≠ helpfulness", () => {
  test("an engine input with ZERO bases and maximal mentions can never qualify (mentions are not an engine input at all)", () => {
    const result = evaluateProofOfHelpfulness({
      policy: POLICY,
      bases: [],
      // 50 recorded mentions exist on the PoH — the engine only sees
      // the disclosure boolean; mentions cannot create a basis.
      advisoryCount: 0,
      disclosureCompliant: true,
      hasCommercialMentions: false,
      contributionState: "SUBMITTED",
      organizationScopeId: "org-1",
      contributionId: "c-1",
    });
    expect(result.outcome).toBe("NOT_QUALIFIED");
    expect(result.qualifyingBasisCount).toBe(0);
    expect(result.reasons.join(" ")).toMatch(/helpfulness must be evidenced/);
    void MANY_MENTIONS;
  });

  test("mentions + advisory scores + NO qualifying basis ⇒ NOT_QUALIFIED end-to-end", async () => {
    const { contribution } = await createHelpfulContribution(harness, {
      mentions: [
        { productRef: "product:acme-widget", disclosed: true, commercialRelationshipRef: null },
        { productRef: "product:gadget-pro", disclosed: false, commercialRelationshipRef: null },
      ],
    });
    // Publish (user-controlled path) — mentions never block a
    // non-commercial publication.
    await publishHelpfulContribution(harness, contribution.id);
    // Attach TWO advisory scores (perfect 1.0 model scores).
    for (let i = 0; i < 2; i++) {
      await harness.runtime.helpfulnessService.attachAdvisoryScore(
        contributorCtx(harness, "w012-ac03-advisory"),
        {
          contributionId: contribution.id,
          kind: "model_score",
          methodRef: "opencon/helpfulness-ranker",
          methodVersion: "1.2.3",
          score: 1,
          idempotencyKey: key("w012-ac03-advisory"),
        },
      );
    }
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac03-evaluate"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac03-evaluate") },
    );
    expect(poh.state).toBe("NOT_QUALIFIED");
    const evaluation = poh.evaluations[poh.evaluations.length - 1]!;
    expect(evaluation.outcome).toBe("NOT_QUALIFIED");
    expect(evaluation.qualifyingBasisCount).toBe(0);
    expect(evaluation.advisoryCount).toBe(2);
    expect(evaluation.reasons.join(" ")).toMatch(/helpfulness must be evidenced/);
  });

  test("the same mentions WITH a qualifying evidence basis qualify — mentions neither help nor hurt qualification", async () => {
    const { contribution } = await createHelpfulContribution(harness, {
      mentions: [
        { productRef: "product:acme-widget", disclosed: true, commercialRelationshipRef: null },
      ],
    });
    await attachEvidenceBasis(harness, contribution.id, {
      sourceType: "attested",
      point: 0.9,
    });
    await publishHelpfulContribution(harness, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac03-qualify"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac03-qualify") },
    );
    expect(poh.state).toBe("QUALIFIED");
    const evaluation = poh.evaluations[poh.evaluations.length - 1]!;
    expect(evaluation.qualifyingBasisCount).toBe(1);
    // QUALIFIED is terminal: a fresh evaluation key is a conflict.
    await expect(
      harness.runtime.helpfulnessService.evaluateHelpfulness(
        contributorCtx(harness, "w012-ac03-terminal"),
        { contributionId: contribution.id, idempotencyKey: key("w012-ac03-terminal") },
      ),
    ).rejects.toThrow(/QUALIFIED \(terminal\)/);
  });

  test("evaluation requires publication first — an unpublished draft with a qualifying basis still cannot qualify", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    await attachEvidenceBasis(harness, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac03-unpublished"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac03-unpublished") },
    );
    expect(poh.state).toBe("NOT_QUALIFIED");
    const evaluation = poh.evaluations[poh.evaluations.length - 1]!;
    expect(evaluation.reasons.join(" ")).toMatch(/not published/);
  });

  test("NOT_QUALIFIED is re-evaluable when new bases attach (evidenced path stays open)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    await publishHelpfulContribution(harness, contribution.id);
    const first = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac03-reeval-1"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac03-reeval-1") },
    );
    expect(first.state).toBe("NOT_QUALIFIED");
    await attachEvidenceBasis(harness, contribution.id);
    const second = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac03-reeval-2"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac03-reeval-2") },
    );
    expect(second.state).toBe("QUALIFIED");
    expect(second.evaluations.length).toBe(2);
    // Append-only: the first evaluation is preserved byte-identically.
    expect(second.evaluations[0]!.outcome).toBe("NOT_QUALIFIED");
  });
});
