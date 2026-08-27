/**
 * NET-W013 PR #26 REMEDIATION — mention isolation on the ADVISORY
 * (LLM) path (HELP-002).
 *
 * The original composite passed a `mention_count` feature into the
 * LLM scoring input, creating an actual
 *
 *     mention → LLM score → AdvisoryQualityScore
 *
 * path — contradicting HELP-002 and the PR's own AC-03 claim that
 * mentions have NO path into quality scoring. The remediation removes
 * every mention-derived feature from the LLM scoring input.
 *
 * This suite proves, MUTATION-CHECKED, that mention-only differences:
 *  1. reach the provider as BIT-FOR-BIT IDENTICAL scoring inputs
 *     (captured through a recording LlmPort double injected via the
 *     harness `llm.providers` threading — robust to any provider
 *     implementation, not just the echo hash);
 *  2. produce IDENTICAL advisory results (score/provider/modelRef);
 *  3. produce IDENTICAL deterministic evaluation digests (the AC-03
 *     engine claim, now tied end-to-end to the advisory blend);
 *  4. are structurally absent from the composite's source (token-level
 *     pins on the mention source, mirroring the quality-engine pin).
 *
 * The CONTROL test proves the reference provider IS sensitive to a
 * mention_count feature — so the identity proofs above have teeth:
 * re-introducing any mention-derived feature fails test 1 loudly.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { echoLlmProvider } from "../../src/llm/providers/echo-llm-provider.ts";
import type { LlmPort, LlmScoringInput } from "../../src/llm/port.ts";
import type { ProviderAdapter } from "../../src/core/adapter.ts";
import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  recordQualityEvaluation,
  moderatorCtx,
  key,
  type NetW013Harness,
} from "./_net-w013-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
  declareDefaultDisclosure,
  contributorCtx,
} from "./_net-w012-harness.ts";
import type { Contribution } from "../../src/contributions/port.ts";

// ---------------------------------------------------------------------------
// The recording LlmPort double (delegates to the echo reference provider;
// records every scoring input the composition root assembles).
// ---------------------------------------------------------------------------

const scoringInputs: LlmScoringInput[] = [];

const recordingLlmProvider: LlmPort & ProviderAdapter = {
  boundary: "llm",
  readiness: "ready",
  info: { kind: "llm", provider: "echo", version: "0.2.0" },
  async initialize() {
    await echoLlmProvider.initialize();
  },
  async healthCheck() {
    return echoLlmProvider.healthCheck();
  },
  async complete(input) {
    return echoLlmProvider.complete(input);
  },
  async score(input) {
    scoringInputs.push(input);
    return echoLlmProvider.score(input);
  },
};

let harness: NetW013Harness;

beforeAll(async () => {
  harness = await createNetW013Harness({
    llm: { providers: [recordingLlmProvider] },
  });
});

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAIN_MENTIONS = [
  { productRef: "product:acme-widget", disclosed: true, commercialRelationshipRef: null },
  { productRef: "product:beta-tool", disclosed: false, commercialRelationshipRef: null },
  { productRef: "product:gamma", disclosed: true, commercialRelationshipRef: null },
  { productRef: "product:delta-service", disclosed: false, commercialRelationshipRef: null },
] as const;

/**
 * A QUALIFIED contribution carrying a COMMERCIAL mention covered by a
 * compliant active disclosure (the maximal-mention fixture: plain
 * mentions + a disclosed commercial relationship — the mention set at
 * its most loaded, the quality facts unchanged).
 */
async function createQualifiedCommercialMentionContribution(
  h: NetW013Harness,
): Promise<Contribution> {
  const helpfulnessPolicy = await createHelpfulnessPolicy(h.w012);
  const { contribution } = await createHelpfulContribution(h.w012, {
    helpfulnessPolicyId: helpfulnessPolicy.policyId,
    mentions: [
      {
        productRef: "product:acme-widget",
        disclosed: false,
        commercialRelationshipRef: "rel-acme",
      },
      {
        productRef: "product:beta-tool",
        disclosed: true,
        commercialRelationshipRef: null,
      },
    ],
  });
  await declareDefaultDisclosure(h.w012, contribution.id, {
    relationshipRef: "rel-acme",
  });
  await attachEvidenceBasis(h.w012, contribution.id);
  await publishHelpfulContribution(h.w012, contribution.id);
  const poh = await h.runtime.helpfulnessService.evaluateHelpfulness(
    contributorCtx(h.w012, "w013-remediation-poh"),
    { contributionId: contribution.id, idempotencyKey: key("w013-remediation-poh") },
  );
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `Remediation fixture failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  return contribution;
}

/** Generate an advisory score through the composition-root composite. */
async function generateAdvisory(
  h: NetW013Harness,
  contributionId: string,
) {
  return h.runtime.apiCommands.generateAdvisoryQualityScore(
    moderatorCtx(h, "w013-remediation-generate"),
    h.moderatorPersonId,
    {
      contributionId,
      idempotencyKey: key("w013-remediation-generate"),
    },
  );
}

// ---------------------------------------------------------------------------
// The remediation proofs
// ---------------------------------------------------------------------------

describe("NET-W013 PR #26 remediation — mentions have no path into quality scoring (advisory path)", () => {
  test("mention-only differences reach the LLM as BIT-FOR-BIT IDENTICAL scoring inputs", async () => {
    const none = await createQualifiedContribution(harness, { mentions: [] });
    const plain = await createQualifiedContribution(harness, {
      mentions: PLAIN_MENTIONS,
    });
    const commercial =
      await createQualifiedCommercialMentionContribution(harness);

    const before = scoringInputs.length;
    const rNone = await generateAdvisory(harness, none.contribution.id);
    const rPlain = await generateAdvisory(harness, plain.contribution.id);
    const rCommercial = await generateAdvisory(harness, commercial.id);
    // Exactly ONE scoring request per generate call.
    const captured = scoringInputs.slice(before);
    expect(captured.length).toBe(3);
    const iNone = captured[0]!;
    const iPlain = captured[1]!;
    const iCommercial = captured[2]!;

    // The provider CANNOT distinguish the three contributions: the
    // scoring inputs are deep-equal (purpose + rubricRef + the entire
    // neutralFacts list, order included).
    expect(iPlain).toEqual(iNone);
    expect(iCommercial).toEqual(iNone);

    // No mention-derived label exists in ANY captured fact.
    for (const input of [iNone, iPlain, iCommercial]) {
      for (const fact of input.neutralFacts) {
        expect(fact.label).not.toMatch(/mention/i);
      }
    }

    // Identical advisory results (the persisted AdvisoryQualityScore
    // values are identical; only record ids/keys differ).
    expect(rPlain.advisoryScore.score).toBe(rNone.advisoryScore.score);
    expect(rCommercial.advisoryScore.score).toBe(rNone.advisoryScore.score);
    expect(rPlain.advisoryScore.provider).toBe(rNone.advisoryScore.provider);
    expect(rPlain.advisoryScore.modelRef).toBe(rNone.advisoryScore.modelRef);
    expect(rCommercial.advisoryScore.modelRef).toBe(
      rNone.advisoryScore.modelRef,
    );
    expect(rCommercial.advisoryScore.kind).toBe("model_score");
    expect(rNone.authoritative).toBe(false);
  });

  test("END-TO-END: mention-only differences produce identical advisory results AND identical deterministic evaluation digests", async () => {
    const policy = await createQualityPolicy(harness);
    const none = await createQualifiedContribution(harness, { mentions: [] });
    const heavy = await createQualifiedContribution(harness, {
      mentions: PLAIN_MENTIONS,
    });

    // The advisory (LLM) layer first.
    const advisoryNone = await generateAdvisory(harness, none.contribution.id);
    const advisoryHeavy = await generateAdvisory(harness, heavy.contribution.id);
    expect(advisoryHeavy.advisoryScore.score).toBe(
      advisoryNone.advisoryScore.score,
    );
    expect(advisoryHeavy.provider).toBe(advisoryNone.provider);
    expect(advisoryHeavy.modelRef).toBe(advisoryNone.modelRef);

    // Then the deterministic evaluation OVER that advisory blend.
    const evalNone = await recordQualityEvaluation(
      harness,
      none.contribution.id,
      policy.policyId,
    );
    const evalHeavy = await recordQualityEvaluation(
      harness,
      heavy.contribution.id,
      policy.policyId,
    );
    expect(evalHeavy.score).toBe(evalNone.score);
    expect(evalHeavy.band).toBe(evalNone.band);
    // Bit-for-bit identical digest: the (policy, facts, anchor)
    // triples are IDENTICAL — mentions do not participate in the
    // evaluation payload at all.
    expect(evalHeavy.digest).toBe(evalNone.digest);
    expect(evalHeavy.advisoryCount).toBe(evalNone.advisoryCount);
    expect(evalHeavy.advisoryAverage).toBe(evalNone.advisoryAverage);
    expect(evalHeavy.inputContributions).toEqual(evalNone.inputContributions);
    expect(evalHeavy.reasons).toEqual(evalNone.reasons);
  });

  test("CONTROL (mutation check): the reference provider IS sensitive to a mention_count feature — the identity proofs have teeth", async () => {
    const base = {
      purpose: "content_scoring" as const,
      rubricRef: "contribution-quality:default",
      neutralFacts: [
        { label: "contribution_type", value: "helpful_recommendation" },
        { label: "contribution_state", value: "SUBMITTED" },
        { label: "poh_state", value: "QUALIFIED" },
        { label: "poh_qualifying_basis_count", value: "1" },
        { label: "poh_independent_source_count", value: "1" },
      ],
    };
    // The EXACT pre-remediation input shape: the same facts plus the
    // mention_count feature the composite used to assemble.
    const withMentionCount = {
      ...base,
      neutralFacts: [
        ...base.neutralFacts.slice(0, 2),
        { label: "mention_count", value: "4" },
        ...base.neutralFacts.slice(2),
      ],
    };
    const a = await echoLlmProvider.score(base);
    const b = await echoLlmProvider.score(withMentionCount);
    // A mention-derived feature WOULD move the advisory score — so
    // the input-level identity above is a REAL isolation proof, not a
    // provider-side coincidence.
    expect(b.score).not.toBe(a.score);
  });

  test("STRUCTURAL: the composition-root composite assembles no mention-derived scoring feature (source-level pin)", async () => {
    const source = await readFile("src/bootstrap/runtime.ts", "utf8");
    // The remediated label is gone from the ENTIRE runtime wiring.
    expect(source).not.toMatch(/mention_count/);
    // The composite region: from the composite's declaration to the
    // next apiCommand. No mention token, no mention-count variable,
    // no read of the mentions field — and no read of the submission
    // (the only place mention data could come from).
    const start = source.indexOf("async generateAdvisoryQualityScore");
    const end = source.indexOf("async previewQualityEvaluation");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const composite = source.slice(start, end);
    expect(composite).not.toMatch(/mention_count/);
    expect(composite).not.toMatch(/mentionCount/);
    expect(composite).not.toMatch(/\.mentions/);
    expect(composite).not.toMatch(/submission/);
  });
});
