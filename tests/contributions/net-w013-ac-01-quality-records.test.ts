/**
 * NET-W013-AC-01 — quality policies, advisory scores and quality
 * evaluations are first-class durable scoped records.
 *
 * The policy lineage is versioned (version = latest + 1 under the
 * org-independent lineage mutex) and cannot be forked across
 * organization scopes; the shape validator enforces the deterministic
 * fail-safes; advisory scores carry REQUIRED method identity (+ the
 * provider identity when model-generated); evaluations carry the
 * explicit determinism anchor, the SHA-256 digest and the append-only
 * supersession chain.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  defaultQualityShape,
  recordQualityEvaluation,
  moderatorCtx,
  contributorCtx,
  key,
  EVALUATED_AT,
  EVALUATED_AT_LATER,
  type NetW013Harness,
} from "./_net-w013-harness.ts";

let harness: NetW013Harness;

beforeAll(async () => {
  harness = await createNetW013Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W013-AC-01 quality records", () => {
  test("a quality policy lineage versions deterministically (v1 → v2 = latest+1) and replays idempotently", async () => {
    const policyId = key("w013-lineage");
    const first = await harness.runtime.qualityService.defineQualityPolicy(
      moderatorCtx(harness, "w013-lineage-1"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        shape: defaultQualityShape(),
        idempotencyKey: `${policyId}-v1`,
      },
    );
    expect(first.created).toBe(true);
    expect(first.policy.version).toBe(1);
    expect(first.policy.organizationScopeId).toBe(harness.organizationScopeId);
    expect(first.policy.formatVersion).toBe("NET-W013:1");

    // Replay with the SAME key → the same version, created=false.
    const replay = await harness.runtime.qualityService.defineQualityPolicy(
      moderatorCtx(harness, "w013-lineage-1r"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        shape: defaultQualityShape(),
        idempotencyKey: `${policyId}-v1`,
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.policy.version).toBe(1);

    const second = await harness.runtime.qualityService.defineQualityPolicy(
      moderatorCtx(harness, "w013-lineage-2"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        shape: defaultQualityShape({ lowQualityAt: 0.25 }),
        idempotencyKey: `${policyId}-v2`,
      },
    );
    expect(second.created).toBe(true);
    expect(second.policy.version).toBe(2);

    const versions = await harness.runtime.qualityService.listQualityPolicyVersions(
      harness.bootstrapCtx,
      policyId,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  test("a quality policy lineage cannot be forked across organization scopes (including version 1)", async () => {
    const policy = await createQualityPolicy(harness);
    await expect(
      harness.runtime.qualityService.defineQualityPolicy(
        moderatorCtx(harness, "w013-fork"),
        {
          organizationScopeId: harness.secondOrgId,
          policyId: policy.policyId,
          shape: defaultQualityShape(),
          idempotencyKey: key("w013-fork"),
        },
      ),
    ).rejects.toThrow(/cross-scope lineage fork rejected/i);
  });

  test("the shape validator rejects structurally unsafe policies (fail-closed)", async () => {
    const base = defaultQualityShape();
    // No inputs.
    await expect(
      harness.runtime.qualityService.defineQualityPolicy(
        moderatorCtx(harness, "w013-shape-1"),
        {
          organizationScopeId: harness.organizationScopeId,
          policyId: key("w013-shape"),
          shape: { ...base, inputs: [] },
          idempotencyKey: key("w013-shape"),
        },
      ),
    ).rejects.toThrow(/at least one input rule/i);
    // Advisory-only cap above ADEQUATE.
    await expect(
      harness.runtime.qualityService.defineQualityPolicy(
        moderatorCtx(harness, "w013-shape-2"),
        {
          organizationScopeId: harness.organizationScopeId,
          policyId: key("w013-shape"),
          shape: defaultQualityShape({ advisoryOnlyCapBand: "HIGH_QUALITY" }),
          idempotencyKey: key("w013-shape"),
        },
      ),
    ).rejects.toThrow(/advisoryOnlyCapBand may be at best ADEQUATE/i);
    // Missing-input floor above LOW_QUALITY.
    await expect(
      harness.runtime.qualityService.defineQualityPolicy(
        moderatorCtx(harness, "w013-shape-3"),
        {
          organizationScopeId: harness.organizationScopeId,
          policyId: key("w013-shape"),
          shape: defaultQualityShape({ missingInputFloorBand: "ADEQUATE" }),
          idempotencyKey: key("w013-shape"),
        },
      ),
    ).rejects.toThrow(/missingInputFloorBand may be at best LOW_QUALITY/i);
    // Non-monotonic thresholds.
    await expect(
      harness.runtime.qualityService.defineQualityPolicy(
        moderatorCtx(harness, "w013-shape-4"),
        {
          organizationScopeId: harness.organizationScopeId,
          policyId: key("w013-shape"),
          shape: defaultQualityShape({
            highQualityAt: 0.5,
            adequateAt: 0.8,
          }),
          idempotencyKey: key("w013-shape"),
        },
      ),
    ).rejects.toThrow(/monotonic/i);
    // Advisory weight factor > 1.
    await expect(
      harness.runtime.qualityService.defineQualityPolicy(
        moderatorCtx(harness, "w013-shape-5"),
        {
          organizationScopeId: harness.organizationScopeId,
          policyId: key("w013-shape"),
          shape: defaultQualityShape({ advisoryWeightFactor: 1.5 }),
          idempotencyKey: key("w013-shape"),
        },
      ),
    ).rejects.toThrow(/advisoryWeightFactor/i);
  });

  test("advisory quality scores are append-only records with REQUIRED method identity (+ provider identity when model-generated)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    // Method identity is required.
    await expect(
      harness.runtime.qualityService.attachAdvisoryScore(
        moderatorCtx(harness, "w013-adv-1"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          kind: "model_score",
          methodRef: "",
          methodVersion: "1",
          score: 0.9,
          idempotencyKey: key("w013-adv"),
        },
      ),
    ).rejects.toThrow(/methodRef AND methodVersion are required/i);
    // Score domain [0,1].
    await expect(
      harness.runtime.qualityService.attachAdvisoryScore(
        moderatorCtx(harness, "w013-adv-2"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          kind: "model_score",
          methodRef: "rubric-a",
          methodVersion: "1",
          score: 1.5,
          idempotencyKey: key("w013-adv"),
        },
      ),
    ).rejects.toThrow(/score must be a number in \[0, 1\]/i);
    // Heuristic score without provider identity.
    const heuristic = await harness.runtime.qualityService.attachAdvisoryScore(
      moderatorCtx(harness, "w013-adv-3"),
      {
        contributionId: contribution.id,
        organizationScopeId: harness.organizationScopeId,
        kind: "heuristic_score",
        methodRef: "heuristic-content-v2",
        methodVersion: "1.1",
        score: 0.6,
        idempotencyKey: key("w013-adv"),
      },
    );
    expect(heuristic.kind).toBe("heuristic_score");
    expect(heuristic.provider).toBeNull();
    expect(heuristic.modelRef).toBeNull();
    // Model score WITH provider identity.
    const model = await harness.runtime.qualityService.attachAdvisoryScore(
      moderatorCtx(harness, "w013-adv-4"),
      {
        contributionId: contribution.id,
        organizationScopeId: harness.organizationScopeId,
        kind: "model_score",
        methodRef: "quality_policy:rubric-x:v1",
        methodVersion: "echo-scoring-v1",
        provider: "echo",
        modelRef: "echo-scoring-v1",
        score: 0.75,
        idempotencyKey: key("w013-adv"),
      },
    );
    expect(model.provider).toBe("echo");
    expect(model.modelRef).toBe("echo-scoring-v1");
    const listed = await harness.runtime.qualityService.listAdvisoryScores(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(listed.length).toBe(2);
  });

  test("quality evaluations carry the determinism anchor, the digest and the append-only supersession chain", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    const first = await recordQualityEvaluation(
      harness,
      contribution.id,
      qualityPolicy.policyId,
    );
    expect(first.band).toBe("HIGH_QUALITY");
    expect(first.supersedesEvaluationId).toBeNull();
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.evaluator).toBe("deterministic_policy_v1");
    // The per-input breakdown is recorded (never an opaque score).
    expect(first.inputContributions.length).toBe(3);

    // A re-evaluation at a LATER anchor supersedes (atomic back-pointer
    // flip; the previous record is NEVER rewritten — only the pointer).
    const second = await recordQualityEvaluation(
      harness,
      contribution.id,
      qualityPolicy.policyId,
      { evaluatedAt: EVALUATED_AT_LATER },
    );
    expect(second.supersedesEvaluationId).toBe(first.id);
    const firstAfter = await harness.runtime.qualityService.getQualityEvaluation(
      harness.bootstrapCtx,
      first.id,
    );
    expect(firstAfter.supersededByEvaluationId).toBe(second.id);
    const latest = await harness.runtime.qualityService.getLatestQualityEvaluation(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(latest?.id).toBe(second.id);
    const history = await harness.runtime.qualityService.listQualityEvaluationHistory(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(history.length).toBe(2);

    // DETERMINISM: the same (policy, facts, anchor) reproduces the same
    // digest bit-for-bit.
    const third = await recordQualityEvaluation(
      harness,
      contribution.id,
      qualityPolicy.policyId,
      { evaluatedAt: EVALUATED_AT_LATER },
    );
    // (different idempotency key → a fresh record; identical payload.)
    expect(third.digest).toBe(second.digest);
  });

  test("the evaluation pins the EXACT requested policy version (version pinning, not latest)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const policyId = key("w013-pin");
    await harness.runtime.qualityService.defineQualityPolicy(
      moderatorCtx(harness, "w013-pin-1"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        shape: defaultQualityShape(),
        idempotencyKey: `${policyId}-v1`,
      },
    );
    await harness.runtime.qualityService.defineQualityPolicy(
      moderatorCtx(harness, "w013-pin-2"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        shape: defaultQualityShape({ highQualityAt: 0.95 }),
        idempotencyKey: `${policyId}-v2`,
      },
    );
    // Pin v1 explicitly: the band follows v1's thresholds.
    const pinned = await harness.runtime.qualityService.recordQualityEvaluation(
      moderatorCtx(harness, "w013-pin-eval"),
      {
        contributionId: contribution.id,
        organizationScopeId: harness.organizationScopeId,
        qualityPolicyId: policyId,
        qualityPolicyVersion: 1,
        evaluatedAt: EVALUATED_AT,
        idempotencyKey: key("w013-pin-eval"),
      },
    );
    expect(pinned.evaluation.qualityPolicyVersion).toBe(1);
    expect(pinned.evaluation.band).toBe("HIGH_QUALITY");
    // Latest (v2) would NOT certify HIGH_QUALITY at 0.8 with the 0.95
    // threshold — version pinning is real.
    const latestEval = await harness.runtime.qualityService.recordQualityEvaluation(
      moderatorCtx(harness, "w013-pin-eval-latest"),
      {
        contributionId: contribution.id,
        organizationScopeId: harness.organizationScopeId,
        qualityPolicyId: policyId,
        evaluatedAt: EVALUATED_AT,
        idempotencyKey: key("w013-pin-eval-latest"),
      },
    );
    expect(latestEval.evaluation.qualityPolicyVersion).toBe(2);
    expect(latestEval.evaluation.band).toBe("ADEQUATE");
  });

  test("a cross-scope policy pin is rejected (tenant isolation at the evaluation boundary)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const foreignPolicy = await createQualityPolicy(harness, {
      organizationScopeId: harness.secondOrgId,
    });
    await expect(
      harness.runtime.qualityService.recordQualityEvaluation(
        moderatorCtx(harness, "w013-cross"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          qualityPolicyId: foreignPolicy.policyId,
          evaluatedAt: EVALUATED_AT,
          idempotencyKey: key("w013-cross"),
        },
      ),
    ).rejects.toThrow(/QUALITY_POLICY_SCOPE_MISMATCH|belongs to organization scope/i);
    void contributorCtx;
  });
});
