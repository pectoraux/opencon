/**
 * NET-W007-AC-01 — Dimensions are first-class, independent and
 * reconstructable.
 *
 * Reputation dimensions are first-class, independently persisted and
 * reconstructable:
 *  - the frozen 8-dimension vocabulary is the only accepted dimension
 *    set (policies must cover ALL dimensions exactly once);
 *  - dimension scores are computed INDEPENDENTLY (a dimension is scored
 *    only from its own inputs — mechanically enforced by the engine);
 *  - every snapshot records the exact inputIds it covers so the score
 *    set is fully reconstructable from (inputIds, policyVersion,
 *    referenceAt).
 *
 * Evidence: domain integration tests over the NET-W003 persistence
 * boundary (file-backed authority shim).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createVerifiedContribution,
  DEFAULT_POLICY_RULES,
  REF_AT,
  type NetW007Harness,
} from "./_net-w007-harness.ts";
import { REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";

let harness: NetW007Harness;

beforeEach(async () => {
  harness = await createNetW007Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W007-AC-01 dimensions", () => {
  test("the frozen dimension vocabulary is the canonical eight (REP-001)", () => {
    expect(REPUTATION_DIMENSIONS).toEqual([
      "helpfulness",
      "content_quality",
      "creator_performance",
      "inventory_quality",
      "measurement_reliability",
      "commerce_reliability",
      "fraud_resistance",
      "fulfillment_reliability",
    ]);
  });

  test("a policy must cover ALL dimensions exactly once (partial rejected, duplicate rejected)", async () => {
    const ctx = actorCtx(harness, "ac01-policy-validation");
    // Partial coverage: 7 of 8 dimensions.
    const partial = DEFAULT_POLICY_RULES.slice(0, 7);
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-partial",
        version: 1,
        rules: partial,
      }),
    ).rejects.toThrow(/missing: fulfillment_reliability/);

    // Duplicate dimension rule.
    const duplicated = [
      ...DEFAULT_POLICY_RULES,
      { ...DEFAULT_POLICY_RULES[0]! },
    ];
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-duplicated",
        version: 1,
        rules: duplicated,
      }),
    ).rejects.toThrow(/more than one rule for dimension helpfulness/);
  });

  test("every computation emits one score per dimension — always all eight, in vocabulary order", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac01-all-dimensions");
    const result = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    expect(result.scores.map((s) => s.dimension)).toEqual([...REPUTATION_DIMENSIONS]);
  });

  test("dimensions are independent: inputs to one dimension NEVER affect another (mechanical independence)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac01-independence");

    // 3 verified inputs for helpfulness only.
    for (let i = 0; i < 3; i++) {
      const contributionId = await createVerifiedContribution(harness);
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: `ac01-helpfulness-${i}`,
      });
    }

    // Baseline: helpfulness reflects exactly its 3 inputs; every other
    // dimension is untouched (score 0, zero inputs).
    const before = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulnessBefore = before.scores.find((s) => s.dimension === "helpfulness")!;
    expect(helpfulnessBefore.inputCount).toBe(3);
    expect(helpfulnessBefore.verifiedInputCount).toBe(3);
    expect(helpfulnessBefore.score).toBe(3);
    for (const score of before.scores) {
      if (score.dimension !== "helpfulness") {
        expect(score.score).toBe(0);
        expect(score.inputCount).toBe(0);
      }
    }

    // Add 5 inputs to content_quality — helpfulness must not move.
    for (let i = 0; i < 5; i++) {
      const contributionId = await createVerifiedContribution(harness);
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "content_quality",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: `ac01-content-${i}`,
      });
    }
    const after = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulnessAfter = after.scores.find((s) => s.dimension === "helpfulness")!;
    const contentAfter = after.scores.find((s) => s.dimension === "content_quality")!;
    expect(helpfulnessAfter.score).toBe(helpfulnessBefore.score);
    expect(helpfulnessAfter.inputCount).toBe(3);
    expect(contentAfter.inputCount).toBe(5);
    expect(contentAfter.score).toBe(5);
  });

  test("inputs are first-class persisted records with their upstream sources", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac01-inputs-first-class");
    const recorded = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "fraud_resistance",
      sources: [{ kind: "contribution", id: contributionId }],
      description: "Clean dispute history",
      occurredAt: REF_AT,
      idempotencyKey: "ac01-first-class",
    });
    expect(recorded.created).toBe(true);
    const listed = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(recorded.input.id);
    expect(listed[0]!.dimension).toBe("fraud_resistance");
    expect(listed[0]!.sources).toEqual([{ kind: "contribution", id: contributionId }]);

    // Fetched by id too.
    const fetched = await harness.runtime.reputationInputService.getInput(ctx, recorded.input.id);
    expect(fetched.id).toBe(recorded.input.id);
    expect(fetched.basis).toBe("verified");
  });

  test("snapshots are reconstructable: recorded inputIds + policyVersion + referenceAt reproduce the exact scores and digest", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac01-reconstruct");
    for (const dimension of ["helpfulness", "helpfulness", "inventory_quality"] as const) {
      const contributionId = await createVerifiedContribution(harness);
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension,
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: "2024-06-15T00:00:00.000Z",
        idempotencyKey: `ac01-reconstruct-${dimension}-${contributionId}`,
      });
    }
    const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac01-reconstruct-snapshot",
    });
    expect(snapshot.snapshot.inputIds).toHaveLength(3);

    // Re-run the SAME computation from the recorded triple — the scores
    // and digest reproduce exactly (AUD-004 reconstructability).
    const recomputed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: snapshot.snapshot.policyId,
      version: snapshot.snapshot.policyVersion,
      referenceAt: snapshot.snapshot.referenceAt,
    });
    expect(recomputed.scores).toEqual(snapshot.snapshot.scores);
    expect(recomputed.digest).toBe(snapshot.snapshot.digest);
    expect(recomputed.inputIds).toEqual(snapshot.snapshot.inputIds);
  });

  test("snapshot history is ordered and every entry is independently reconstructable", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac01-history");
    const snapshotIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const contributionId = await createVerifiedContribution(harness);
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: `ac01-history-input-${i}`,
      });
      const result = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        policyId: policy.policyId,
        version: 1,
        referenceAt: REF_AT,
        idempotencyKey: `ac01-history-snapshot-${i}`,
      });
      snapshotIds.push(result.snapshot.id);
    }
    const history = await harness.runtime.reputationSnapshotService.getSnapshotHistory(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(history.map((s) => s.id)).toEqual(snapshotIds);
    // Scores grow monotonically as inputs accumulate (1 → 2 → 3).
    expect(history.map((s) => s.scores.find((x) => x.dimension === "helpfulness")!.score))
      .toEqual([1, 2, 3]);
    const latest = await harness.runtime.reputationSnapshotService.getLatestSnapshot(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(latest!.id).toBe(snapshotIds[2]!);
  });
});
