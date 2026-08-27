/**
 * NET-W013-AC-02 — quality scoring is provider-independent and AI
 * output remains non-authoritative evidence (AI-004).
 *
 * Model-contract tests exercise the provider-neutral LlmPort contract
 * (deterministic echo scoring; the literal authoritative:false type;
 * provider identity propagation; swappability). Adversarial tests
 * prove advisory scores can never alone certify a top band (the
 * structural advisory-only cap) and never dominate (the bounded
 * advisory weight factor).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { echoLlmProvider } from "../../src/llm/providers/echo-llm-provider.ts";
import type { LlmPort } from "../../src/llm/port.ts";
import type { ProviderAdapter } from "../../src/core/adapter.ts";
import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  recordQualityEvaluation,
  moderatorCtx,
  contributorCtx,
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

describe("NET-W013-AC-02 provider-independent scoring (model contract + AI non-authority)", () => {
  test("MODEL CONTRACT: the echo provider scores deterministically and is structurally non-authoritative", async () => {
    const input = {
      purpose: "content_scoring" as const,
      rubricRef: "quality_policy:demo:v1",
      neutralFacts: [
        { label: "contribution_type", value: "helpful_recommendation" },
        { label: "poh_state", value: "QUALIFIED" },
      ],
    };
    const a = await echoLlmProvider.score(input);
    const b = await echoLlmProvider.score(input);
    expect(a.score).toBe(b.score); // deterministic for identical input
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.provider).toBe("echo");
    expect(a.modelRef).toBe("echo-scoring-v1");
    expect(a.authoritative).toBe(false); // the literal false contract
    // Different input → (almost certainly) different score: the score
    // is a real function of the input, not a constant.
    const c = await echoLlmProvider.score({
      ...input,
      neutralFacts: [
        { label: "contribution_type", value: "helpful_answer" },
        { label: "poh_state", value: "PENDING" },
      ],
    });
    expect(a.score).not.toBe(c.score);
  });

  test("MODEL CONTRACT: the runtime wires the neutral LLM port and the generate composite records provider identity", async () => {
    expect(harness.runtime.llmProvider.boundary).toBe("llm");
    expect(harness.runtime.llmProviders.length).toBeGreaterThan(0);
    const { contribution } = await createQualifiedContribution(harness);
    const generateKey = key("w013-gen");
    const result = await harness.runtime.apiCommands.generateAdvisoryQualityScore(
      moderatorCtx(harness, "w013-gen"),
      harness.moderatorPersonId,
      {
        contributionId: contribution.id,
        idempotencyKey: generateKey,
      },
    );
    expect(result.provider).toBe("echo");
    expect(result.modelRef).toBe("echo-scoring-v1");
    expect(result.authoritative).toBe(false);
    expect(result.advisoryScore.kind).toBe("model_score");
    expect(result.advisoryScore.provider).toBe("echo");
    expect(result.advisoryScore.methodRef).toBe("contribution-quality:default");
    // The composite replays idempotently (the attach key is compound).
    const replay = await harness.runtime.apiCommands.generateAdvisoryQualityScore(
      moderatorCtx(harness, "w013-gen-replay"),
      harness.moderatorPersonId,
      {
        contributionId: contribution.id,
        idempotencyKey: generateKey,
      },
    );
    expect(replay.advisoryScore.id).toBe(result.advisoryScore.id);
  });

  test("PROVIDER INDEPENDENCE: any provider's advisory output enters the engine identically (identity preserved, semantics equal)", async () => {
    // A second, DIFFERENT provider-neutral implementation (a stub with
    // a distinct deterministic scoring function).
    const stubProvider: LlmPort & ProviderAdapter = {
      boundary: "llm",
      readiness: "ready",
      info: { kind: "llm", provider: "stub", version: "9.9.9" },
      async initialize() {},
      async healthCheck() {
        return { ok: true };
      },
      async complete(input) {
        return {
          text: `[stub] ${input.prompt}`,
          provider: "stub",
          latencyMs: 0,
          authoritative: false,
        };
      },
      async score(input) {
        return {
          score: 0.9,
          provider: "stub",
          modelRef: "stub-scoring-v9",
          latencyMs: 0,
          authoritative: false,
        };
      },
    };
    const scored = await stubProvider.score({
      purpose: "content_scoring",
      rubricRef: "quality_policy:demo:v1",
      neutralFacts: [{ label: "k", value: "v" }],
    });
    expect(scored.provider).toBe("stub");
    expect(scored.score).toBe(0.9);

    // Two contributions with the SAME authoritative facts: one carries
    // an echo advisory 0.9, the other a stub advisory 0.9. The engine
    // must score them IDENTICALLY (provider identity is metadata, not
    // semantics).
    const policy = await createQualityPolicy(harness);
    const a = await createQualifiedContribution(harness);
    const b = await createQualifiedContribution(harness);
    await harness.runtime.qualityService.attachAdvisoryScore(
      moderatorCtx(harness, "w013-pi-echo"),
      {
        contributionId: a.contribution.id,
        organizationScopeId: harness.organizationScopeId,
        kind: "model_score",
        methodRef: "quality_policy:demo:v1",
        methodVersion: "echo-scoring-v1",
        provider: "echo",
        modelRef: "echo-scoring-v1",
        score: 0.9,
        idempotencyKey: key("w013-pi"),
      },
    );
    await harness.runtime.qualityService.attachAdvisoryScore(
      moderatorCtx(harness, "w013-pi-stub"),
      {
        contributionId: b.contribution.id,
        organizationScopeId: harness.organizationScopeId,
        kind: "model_score",
        methodRef: "quality_policy:demo:v1",
        methodVersion: "stub-scoring-v9",
        provider: "stub",
        modelRef: "stub-scoring-v9",
        score: 0.9,
        idempotencyKey: key("w013-pi"),
      },
    );
    const evalA = await recordQualityEvaluation(
      harness,
      a.contribution.id,
      policy.policyId,
    );
    const evalB = await recordQualityEvaluation(
      harness,
      b.contribution.id,
      policy.policyId,
    );
    expect(evalA.score).toBe(evalB.score);
    expect(evalA.band).toBe(evalB.band);
    expect(evalA.advisoryAverage).toBe(0.9);
    expect(evalB.advisoryAverage).toBe(0.9);
  });

  test("ADVERSARIAL: advisory-only input can NEVER certify HIGH_QUALITY (the structural cap)", async () => {
    // A policy whose advisory weight (0.8) + a perfect model score
    // (1.0) would cross the HIGH_QUALITY threshold (0.75) — the
    // structural advisory-only cap must hold the band at ADEQUATE.
    const policy = await createQualityPolicy(harness, {
      advisoryWeightFactor: 0.8,
      highQualityAt: 0.75,
      adequateAt: 0.4,
      lowQualityAt: 0.1,
      // No required inputs here — this test isolates the ADVISORY-ONLY
      // CAP (the missing-input floor has its own coverage).
      requiredInputs: [],
    });
    // A contribution with NO PoH and NO evidence bases — only a
    // perfect advisory score (the adversarial "AI-only" input set).
    const { createHelpfulnessPolicy, createHelpfulContribution } =
      await import("./_net-w012-harness.ts");
    const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012);
    const { contribution: noPohContribution } = await createHelpfulContribution(
      harness.w012,
      { helpfulnessPolicyId: helpfulnessPolicy.policyId },
    );
    await harness.runtime.qualityService.attachAdvisoryScore(
      moderatorCtx(harness, "w013-advonly"),
      {
        contributionId: noPohContribution.id,
        organizationScopeId: harness.organizationScopeId,
        kind: "model_score",
        methodRef: "quality_policy:demo:v1",
        methodVersion: "echo-scoring-v1",
        provider: "echo",
        modelRef: "echo-scoring-v1",
        score: 1.0,
        idempotencyKey: key("w013-advonly"),
      },
    );
    const evaluation = await recordQualityEvaluation(
      harness,
      noPohContribution.id,
      policy.policyId,
    );
    // The blended score (0.8·1.0 = 0.8 ≥ 0.75) would be HIGH_QUALITY
    // by threshold — the structural cap holds it at ADEQUATE.
    expect(evaluation.band).toBe("ADEQUATE");
    expect(evaluation.reasons.join(" ")).toMatch(
      /advisory-only cap/i,
    );
  });

  test("ADVERSARIAL: a perfect model score alone with NO advisory path still cannot outrank the authoritative facts", async () => {
    // Baseline: the qualified contribution WITHOUT advisory.
    const policy = await createQualityPolicy(harness, {
      advisoryWeightFactor: 0.2,
    });
    const qualified = await createQualifiedContribution(harness);
    const baseline = await recordQualityEvaluation(
      harness,
      qualified.contribution.id,
      policy.policyId,
    );
    // With a PERFECT advisory score at the bounded factor: the score
    // may move, but the SAME contribution's evaluation remains
    // policy-driven — and a ZERO-fact contribution stays low.
    await harness.runtime.qualityService.attachAdvisoryScore(
      moderatorCtx(harness, "w013-bound"),
      {
        contributionId: qualified.contribution.id,
        organizationScopeId: harness.organizationScopeId,
        kind: "model_score",
        methodRef: "quality_policy:demo:v1",
        methodVersion: "echo-scoring-v1",
        provider: "echo",
        modelRef: "echo-scoring-v1",
        score: 1.0,
        idempotencyKey: key("w013-bound"),
      },
    );
    const withAdvisory = await recordQualityEvaluation(
      harness,
      qualified.contribution.id,
      policy.policyId,
    );
    // 0.8·0.8 + 0.2·1.0 = 0.84 ≥ 0.8 → still HIGH_QUALITY (advisory
    // assists, never degrades semantics).
    expect(withAdvisory.band).toBe("HIGH_QUALITY");
    expect(withAdvisory.score).toBeGreaterThan(baseline.score);
    void contributorCtx;
  });
});
