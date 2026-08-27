/**
 * NET-W013-AC-03 — product mention alone has NO quality authority
 * (HELP-002 — "score contextual relevance and usefulness rather than
 * mere product mention").
 *
 * The engine input carries NO mention field at all: two contributions
 * differing ONLY in their mentions evaluate IDENTICALLY, and a
 * mention-heavy contribution with no evidence-backed facts scores at
 * the bottom regardless of mention volume.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  recordQualityEvaluation,
  moderatorCtx,
  key,
  EVALUATED_AT,
  type NetW013Harness,
} from "./_net-w013-harness.ts";

let harness: NetW013Harness;

beforeAll(async () => {
  harness = await createNetW013Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W013-AC-03 mention ≠ quality", () => {
  test("contributions differing ONLY in mentions evaluate IDENTICALLY (mentions are not a quality input)", async () => {
    const policy = await createQualityPolicy(harness);
    const noMentions = await createQualifiedContribution(harness, {
      mentions: [],
    });
    const manyMentions = await createQualifiedContribution(harness, {
      mentions: [
        { productRef: "product:acme-widget", disclosed: false, commercialRelationshipRef: null },
        { productRef: "product:beta-tool", disclosed: true, commercialRelationshipRef: null },
        { productRef: "product:gamma", disclosed: false, commercialRelationshipRef: null },
      ],
    });
    const evalNoMentions = await recordQualityEvaluation(
      harness,
      noMentions.contribution.id,
      policy.policyId,
    );
    const evalManyMentions = await recordQualityEvaluation(
      harness,
      manyMentions.contribution.id,
      policy.policyId,
    );
    expect(evalManyMentions.score).toBe(evalNoMentions.score);
    expect(evalManyMentions.band).toBe(evalNoMentions.band);
    // Bit-for-bit identical digest: the (policy, facts, anchor)
    // triples are IDENTICAL — mentions do not participate in the
    // evaluation payload at all.
    expect(evalManyMentions.digest).toBe(evalNoMentions.digest);
  });

  test("a mention-heavy contribution with NO evidence-backed facts scores at the BOTTOM regardless of mention volume", async () => {
    const { createHelpfulnessPolicy, createHelpfulContribution } =
      await import("./_net-w012-harness.ts");
    const policy = await createQualityPolicy(harness);
    const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012);
    const mentionHeavy = await createHelpfulContribution(harness.w012, {
      helpfulnessPolicyId: helpfulnessPolicy.policyId,
      mentions: [
        {
          productRef: "product:acme-widget",
          disclosed: false,
          commercialRelationshipRef: "rel-acme",
        },
        {
          productRef: "product:beta-tool",
          disclosed: false,
          commercialRelationshipRef: "rel-beta",
        },
      ],
    });
    const evaluation = await recordQualityEvaluation(
      harness,
      mentionHeavy.contribution.id,
      policy.policyId,
    );
    // No PoH (unpublished/unevaluated), no evidence bases → the
    // score is 0 → UNSATISFACTORY (already at/below the
    // missing-input floor — floors only worsen, never improve).
    expect(evaluation.score).toBe(0);
    expect(evaluation.band).toBe("UNSATISFACTORY");
    expect(evaluation.reasons.join(" ")).toMatch(
      /required input proof_of_helpfulness has no qualifying facts/i,
    );
    for (const contribution of evaluation.inputContributions) {
      expect(contribution.count).toBe(0);
    }
  });

  test("the engine input type carries NO mention field (structural absence)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/contributions/quality-engine.ts",
      "utf8",
    );
    // The facts interface deliberately has no mention member.
    expect(source).toMatch(
      /there is deliberately NO mention field[\s\S]*?HELP-002/,
    );
    expect(source).not.toMatch(/mentionCount/);
    expect(source).not.toMatch(/mentions:/);
  });

  test("sentiment-style advisory kinds do not exist in the vocabulary (incentives are never conditioned on sentiment)", async () => {
    const core = await import("../../src/core/moderation.ts");
    expect(core.QUALITY_ADVISORY_KINDS).toEqual([
      "model_score",
      "heuristic_score",
    ]);
    expect(
      (core.QUALITY_ADVISORY_KINDS as readonly string[]).includes(
        "sentiment_score",
      ),
    ).toBe(false);
    // An adversarial sentiment-style attach is rejected by the closed
    // vocabulary.
    const { contribution } = await createQualifiedContribution(harness);
    await expect(
      harness.runtime.qualityService.attachAdvisoryScore(
        moderatorCtx(harness, "w013-sentiment"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          kind: "sentiment_score" as never,
          methodRef: "sentiment-v1",
          methodVersion: "1",
          score: 0.99,
          idempotencyKey: key("w013-sentiment"),
        },
      ),
    ).rejects.toThrow(/kind must be an advisory kind/i);
    void EVALUATED_AT;
  });
});
