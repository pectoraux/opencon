/**
 * NET-W007-AC-04 — Time decay is deterministic and testable without
 * dependence on wall-clock race conditions (REP-003).
 *
 *  - the decay reference timestamp is an EXPLICIT input everywhere
 *    (computeScores / recordSnapshot require referenceAt — no hidden
 *    wall clock anywhere in the engine);
 *  - the pure decay function produces exact exponential half-life
 *    values (0.5^(elapsedDays / halfLifeDays));
 *  - inputs occurring AFTER the reference timestamp are excluded
 *    (temporal scoping — no future leakage);
 *  - occurredAt (the decay anchor) is independent from recordedAt;
 *  - per-dimension half-lives are policy data (versioned).
 *
 * Evidence: pure-engine unit tests + domain integration tests, all
 * with fixed timestamps.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createVerifiedContribution,
  DEFAULT_POLICY_RULES,
  REF_AT,
  REF_AT_LATER,
  type NetW007Harness,
} from "./_net-w007-harness.ts";
import { decayFactor, computeDimensionScore, round6 } from "../../src/reputation/scoring.ts";
import type { ReputationInput } from "../../src/reputation/port.ts";
import type { ReputationScoringRule } from "../../src/core/reputation.ts";

let harness: NetW007Harness;

beforeEach(async () => {
  harness = await createNetW007Harness();
});

afterEach(async () => {
  await harness.teardown();
});

/** A synthetic verified input at a fixed time (pure-engine fixtures). */
function synthInput(id: string, occurredAt: string, dimension = "helpfulness"): ReputationInput {
  return {
    id,
    organizationScopeId: "org",
    subjectPersonId: "person",
    dimension: dimension as ReputationInput["dimension"],
    basis: "verified",
    sources: [{ kind: "contribution", id: `c-${id}` }],
    description: null,
    occurredAt,
    recordedAt: "2024-07-01T00:00:00.000Z",
    idempotencyKey: `key-${id}`,
    executionId: "exec",
    correlationId: "corr",
    causationId: null,
  };
}

const RULE: ReputationScoringRule = {
  dimension: "helpfulness",
  inputWeight: 2,
  decayHalfLifeDays: 90,
  maxScore: 100,
  indicatedWeightFactor: 0.25,
  indicatedOnlyCap: 10,
};

describe("NET-W007-AC-04 deterministic time decay", () => {
  test("decayFactor produces exact exponential half-life values (pure function)", () => {
    const t0 = "2024-01-01T00:00:00.000Z";
    // At t0: full weight.
    expect(decayFactor(t0, t0, 90)).toBe(1);
    // +90 days = exactly one half-life.
    expect(decayFactor(t0, "2024-03-31T00:00:00.000Z", 90)).toBeCloseTo(0.5, 12);
    // +180 days = two half-lives.
    expect(decayFactor(t0, "2024-06-29T00:00:00.000Z", 90)).toBeCloseTo(0.25, 12);
    // +30 days = one third of a half-life.
    expect(decayFactor(t0, "2024-01-31T00:00:00.000Z", 90)).toBeCloseTo(0.5 ** (1 / 3), 12);
    // A different half-life is different policy DATA.
    expect(decayFactor(t0, "2024-03-31T00:00:00.000Z", 30)).toBeCloseTo(0.5 ** 3, 12);
  });

  test("decayFactor fails closed on invalid inputs", () => {
    expect(() => decayFactor("not-a-timestamp", REF_AT, 90)).toThrow();
    expect(() => decayFactor(REF_AT, "not-a-timestamp", 90)).toThrow();
    expect(() => decayFactor(REF_AT, REF_AT, 0)).toThrow();
    expect(() => decayFactor(REF_AT, REF_AT, -5)).toThrow();
  });

  test("a future reference timestamp never earns decay BONUS (factor clamped to 1)", () => {
    // occurredAt AFTER referenceAt: the pure factor is clamped to 1
    // (though the engine excludes such inputs entirely — temporal
    // scoping — this clamp is defense in depth).
    expect(decayFactor("2024-08-01T00:00:00.000Z", REF_AT, 90)).toBe(1);
  });

  test("computeDimensionScore applies exact decay: one 90-day-old input at half-life 90 → exactly half the weight", () => {
    const input = synthInput("i1", "2024-04-02T00:00:00.000Z"); // REF_AT - 90d
    const score = computeDimensionScore(RULE, [input], REF_AT);
    expect(score.score).toBe(1); // 2 × 0.5
    expect(score.decayedVerifiedWeight).toBe(1);
    expect(score.verifiedInputCount).toBe(1);
  });

  test("decay composes across multiple inputs with exact expected totals", () => {
    // Two inputs: one at t0 (full weight), one 90 days old (half).
    const fresh = synthInput("i1", REF_AT);
    const old = synthInput("i2", "2024-04-02T00:00:00.000Z");
    const score = computeDimensionScore(RULE, [fresh, old], REF_AT);
    expect(score.decayedVerifiedWeight).toBe(3); // 2 + 1
    expect(score.score).toBe(3);
  });

  test("inputs occurring AFTER the reference timestamp are EXCLUDED (temporal scoping)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac04-future");
    const contributionId = await createVerifiedContribution(harness);
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: "2024-08-01T00:00:00.000Z", // AFTER REF_AT
      idempotencyKey: "ac04-future-input",
    });
    expect(result.input.basis).toBe("verified");
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT, // 2024-07-01 — before the input occurred
    });
    const helpfulness = computed.scores.find((s) => s.dimension === "helpfulness")!;
    expect(helpfulness.score).toBe(0);
    expect(helpfulness.inputCount).toBe(0);
    // The future input is not in the covered input ids.
    expect(computed.inputIds).not.toContain(result.input.id);
  });

  test("decay is observed across fixed reference timestamps WITHOUT any wall-clock dependency", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac04-fixed");
    const contributionId = await createVerifiedContribution(harness);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac04-fixed-input",
    });
    // Compute at t0 and at t0+90d (exactly one half-life with the
    // default policy's 90-day half-life).
    const at0 = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const at90 = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT_LATER,
    });
    const s0 = at0.scores.find((s) => s.dimension === "helpfulness")!;
    const s90 = at90.scores.find((s) => s.dimension === "helpfulness")!;
    expect(s0.score).toBe(1);
    expect(s90.score).toBe(0.5);
    // The results are exact — no timing jitter can appear because no
    // wall clock is read (referenceAt is an explicit input).
    expect(s90.score).toBe(s0.score / 2);
  });

  test("occurredAt is the decay anchor — independent of recordedAt (backdated history decays from when it HAPPENED)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac04-anchor");
    const contributionId = await createVerifiedContribution(harness);
    // The input is RECORDED now (recordedAt = now) but OCCURRED 90 days
    // before REF_AT.
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: "2024-04-02T00:00:00.000Z",
      idempotencyKey: "ac04-anchor-input",
    });
    expect(Date.parse(result.input.recordedAt)).toBeGreaterThanOrEqual(
      Date.parse("2024-07-01T00:00:00.000Z"),
    );
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulness = computed.scores.find((s) => s.dimension === "helpfulness")!;
    // Exactly one half-life elapsed since occurredAt → 0.5, regardless
    // of when the input was recorded.
    expect(helpfulness.score).toBe(0.5);
  });

  test("half-lives are per-dimension VERSIONED policy data (decay parameters are reproducible)", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac04-per-dimension");
    // v2: helpfulness keeps the 90-day half-life; content_quality gets
    // a 30-day half-life.
    const v2 = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: policy.policyId,
      version: 2,
      rules: DEFAULT_POLICY_RULES.map((r) =>
        r.dimension === "content_quality" ? { ...r, decayHalfLifeDays: 30 } : r,
      ),
    });
    expect(v2.rules.find((r) => r.dimension === "content_quality")!.decayHalfLifeDays).toBe(30);
    expect(v2.rules.find((r) => r.dimension === "helpfulness")!.decayHalfLifeDays).toBe(90);

    // Same input age (30 days before REF_AT) decays differently per
    // dimension: 0.5^(30/90) under v1 vs 0.5^(30/30) under v2.
    const input = synthInput("pure", "2024-06-01T00:00:00.000Z", "content_quality");
    const rule90 = { ...RULE, dimension: "content_quality" as const };
    const rule30 = { ...rule90, decayHalfLifeDays: 30 };
    const under90 = computeDimensionScore(rule90, [input], REF_AT);
    const under30 = computeDimensionScore(rule30, [input], REF_AT);
    expect(under90.decayedVerifiedWeight).toBe(round6(2 * 0.5 ** (1 / 3)));
    expect(under30.decayedVerifiedWeight).toBe(1);
  });
});
