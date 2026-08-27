/**
 * NET-W008-AC-05 — Reward allocation is deterministic, policy/version
 * aware and fully lineage-backed.
 *
 *  - reward policies are immutable versioned lineages (the NET-W007
 *    pattern incl. monotonic versioning + cross-scope fork rejection
 *    under concurrency — org-independent lineage lock);
 *  - the split is deterministic: identical (source, policy version)
 *    always produces identical shares; Σ shares === source EXACTLY
 *    (last-share remainder absorption — conservation);
 *  - allocations reference policyId + policyVersion + the source
 *    record + full execution lineage;
 *  - weights are validated (> 0, unique beneficiaries, existing
 *    persons).
 *
 * Evidence: domain/integration tests incl. the pure split function.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW008Harness,
  createMatureValue,
  createDefaultRewardPolicy,
  assertGlobalConservation,
  actorCtx,
  type NetW008Harness,
} from "./_net-w008-harness.ts";
import { computeRewardSplit } from "../../src/settlement/ledger.ts";

let harness: NetW008Harness;

beforeEach(async () => {
  harness = await createNetW008Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W008-AC-05 deterministic, policy/version-aware reward allocation", () => {
  test("the pure split is deterministic and conserves the source EXACTLY (remainder absorption)", () => {
    // 100 split 3:2 → 60 / 40.
    expect(
      computeRewardSplit(100, [
        { beneficiaryPersonId: "a", weight: 3 },
        { beneficiaryPersonId: "b", weight: 2 },
      ]),
    ).toEqual([
      { beneficiaryPersonId: "a", amount: 60 },
      { beneficiaryPersonId: "b", amount: 40 },
    ]);

    // 10 split three ways → 3.333333 / 3.333333 / 3.333334 (Σ === 10).
    const shares = computeRewardSplit(10, [
      { beneficiaryPersonId: "a", weight: 1 },
      { beneficiaryPersonId: "b", weight: 1 },
      { beneficiaryPersonId: "c", weight: 1 },
    ]);
    expect(shares.map((s) => s.amount)).toEqual([3.333333, 3.333333, 3.333334]);
    const sum = shares.reduce((acc, s) => acc + s.amount, 0);
    expect(Math.round(sum * 1e6)).toBe(10_000_000); // exact at 6 decimals

    // Deterministic: identical inputs → identical outputs.
    expect(
      computeRewardSplit(10, [{ beneficiaryPersonId: "x", weight: 1 }]),
    ).toEqual(computeRewardSplit(10, [{ beneficiaryPersonId: "x", weight: 1 }]));
  });

  test("allocation splits a mature record deterministically and consumes it exactly once", async () => {
    await createDefaultRewardPolicy(harness);
    const source = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac05-allocate");

    const { allocation, created } = await harness.runtime.rewardService.allocateRewards(ctx, {
      organizationScopeId: harness.organizationScopeId,
      sourceValueRecordId: source.id,
      policyId: "reward-policy-w008-default",
      idempotencyKey: "ac05-allocate",
    });
    expect(created).toBe(true);
    expect(allocation.policyId).toBe("reward-policy-w008-default");
    expect(allocation.policyVersion).toBe(1);
    expect(allocation.sourceValueRecordId).toBe(source.id);
    expect(allocation.sourceValueAmount).toBe(100);
    expect(allocation.totalAllocated).toBe(100);
    expect(allocation.shares.map((s) => s.amount)).toEqual([60, 40]);
    expect(allocation.shares[0]!.beneficiaryPersonId).toBe(harness.personId);
    expect(allocation.shares[1]!.beneficiaryPersonId).toBe(harness.secondPersonId);
    expect(allocation.executionId).toBeTruthy();

    // The source record is CONSUMED by the allocation.
    const record = await harness.runtime.economicValueService.getValue(ctx, source.id);
    expect(record.state).toBe("CONSUMED");
    expect(record.consumedBy).toEqual({ kind: "reward_allocation", id: allocation.id });

    // Balances: source holder's mature value moved to rewards
    // accounts (holder 60, beneficiary 40).
    const holder = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    const beneficiary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.secondPersonId,
    );
    expect(holder.matureValue).toBe(0);
    expect(holder.rewards).toBe(60);
    expect(beneficiary.rewards).toBe(40);
    await assertGlobalConservation(harness);

    // A second allocation against the consumed source is rejected.
    let err: Error | null = null;
    try {
      await harness.runtime.rewardService.allocateRewards(ctx, {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: source.id,
        policyId: "reward-policy-w008-default",
        idempotencyKey: "ac05-allocate-2",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/is CONSUMED, not MATURE/);
  });

  test("identical source + policy version ALWAYS produce identical splits (determinism across records)", async () => {
    await createDefaultRewardPolicy(harness);
    const sourceA = await createMatureValue(harness, { amount: 100 });
    const sourceB = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac05-determinism");
    const a = await harness.runtime.rewardService.allocateRewards(ctx, {
      organizationScopeId: harness.organizationScopeId,
      sourceValueRecordId: sourceA.id,
      policyId: "reward-policy-w008-default",
      idempotencyKey: "ac05-det-a",
    });
    const b = await harness.runtime.rewardService.allocateRewards(ctx, {
      organizationScopeId: harness.organizationScopeId,
      sourceValueRecordId: sourceB.id,
      policyId: "reward-policy-w008-default",
      idempotencyKey: "ac05-det-b",
    });
    expect(a.allocation.shares).toEqual(b.allocation.shares);
    await assertGlobalConservation(harness);
  });

  test("policies are immutable versioned lineages: monotonic versions, no rewrites, exact-version allocation", async () => {
    const ctx = actorCtx(harness, "ac05-versioning");
    const v1 = await createDefaultRewardPolicy(harness, "ac05-lineage");
    expect(v1.version).toBe(1);
    const v2 = await harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: "ac05-lineage",
      version: 2,
      allocations: [
        { beneficiaryPersonId: harness.personId, weight: 1 },
        { beneficiaryPersonId: harness.secondPersonId, weight: 4 },
      ],
    });
    expect(v2.version).toBe(2);

    // A skipped version is rejected (monotonicity: 4 when the next is 3).
    let err: Error | null = null;
    try {
      await harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "ac05-lineage",
        version: 4,
        allocations: [{ beneficiaryPersonId: harness.personId, weight: 1 }],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/next version is exactly 3/);

    // Re-creating a COMMITTED (policyId, version) tuple is the designed
    // deterministic replay (the same tuple-idempotent semantics as the
    // NET-W007 policy engine): the committed record is returned, NOT
    // duplicated.
    const replay = await harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: "ac05-lineage",
      version: 2,
      allocations: [{ beneficiaryPersonId: harness.personId, weight: 1 }],
    });
    expect(replay.id).toBe(v2.id);
    const versions = await harness.runtime.rewardPolicyService.listPolicyVersions(
      ctx,
      "ac05-lineage",
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    // Allocating against the EXACT version 1 uses the 60/40 split.
    const source = await createMatureValue(harness, { amount: 100 });
    const exact = await harness.runtime.rewardService.allocateRewards(ctx, {
      organizationScopeId: harness.organizationScopeId,
      sourceValueRecordId: source.id,
      policyId: "ac05-lineage",
      version: 1,
      idempotencyKey: "ac05-exact-v1",
    });
    expect(exact.allocation.policyVersion).toBe(1);
    expect(exact.allocation.shares.map((s) => s.amount)).toEqual([60, 40]);

    // Omitting the version uses the LATEST (v2: 20/80).
    const source2 = await createMatureValue(harness, { amount: 100 });
    const latest = await harness.runtime.rewardService.allocateRewards(ctx, {
      organizationScopeId: harness.organizationScopeId,
      sourceValueRecordId: source2.id,
      policyId: "ac05-lineage",
      idempotencyKey: "ac05-latest",
    });
    expect(latest.allocation.policyVersion).toBe(2);
    expect(latest.allocation.shares.map((s) => s.amount)).toEqual([20, 80]);
    await assertGlobalConservation(harness);
  });

  test("CONCURRENT cross-organization policy-lineage creates cannot fork (the NET-W007 remediation pattern)", async () => {
    const ctx = actorCtx(harness, "ac05-fork-race");
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Reward Fork Rival Org", creatorId: harness.personId },
    );
    const policyId = "ac05-fork-race-policy";
    const allocations = [{ beneficiaryPersonId: harness.personId, weight: 1 }];

    const outcomes = await Promise.allSettled([
      harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId,
        version: 1,
        allocations,
      }),
      harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: otherOrg.id,
        policyId,
        version: 1,
        allocations,
      }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as Error).message).toMatch(
      /cannot fork across organization scopes/,
    );
    const versions = await harness.runtime.rewardPolicyService.listPolicyVersions(
      ctx,
      policyId,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
  });

  test("policy validation: weights > 0, unique beneficiaries, existing persons", async () => {
    const ctx = actorCtx(harness, "ac05-validation");
    const cases: Array<{
      allocations: { beneficiaryPersonId: string; weight: number }[];
      match: RegExp;
    }> = [
      {
        allocations: [{ beneficiaryPersonId: harness.personId, weight: 0 }],
        match: /weight must be > 0/,
      },
      {
        allocations: [
          { beneficiaryPersonId: harness.personId, weight: 1 },
          { beneficiaryPersonId: harness.personId, weight: 2 },
        ],
        match: /appears more than once/,
      },
      {
        allocations: [{ beneficiaryPersonId: "no-such-person", weight: 1 }],
        match: /beneficiary person not found/,
      },
    ];
    for (const [i, testCase] of cases.entries()) {
      let err: Error | null = null;
      try {
        await harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
          organizationScopeId: harness.organizationScopeId,
          policyId: `ac05-invalid-${i}`,
          version: 1,
          allocations: testCase.allocations,
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect((err as Error).message).toMatch(testCase.match);
    }
  });
});
