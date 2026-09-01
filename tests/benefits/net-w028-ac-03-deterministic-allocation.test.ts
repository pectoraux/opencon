/**
 * NET-W028 AC-03 — Deterministic policy/eligibility/allocation:
 * server-derived member eligibility (authoritative participant
 * inputs, never caller assertions), deterministic allocation plans
 * (declaration order, scaled-integer floor arithmetic), the
 * draw-policy consistency bridge (the settlement reward policy must
 * mirror the benefits policy exactly — fail closed on drift) and the
 * anchor-excluded decision digest (issue #56 key invariants 4/5).
 *
 * Work order: spec/work-orders/NET-W028.md §3.3/§3.4/§3.5 / §6 AC-03.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW028Harness,
  createBenefitPolicy,
  createBenefitPool,
  seedValueFundedPool,
  seedSavingsFundedPool,
  allocateBenefits,
  evaluateAllocation,
  key,
  type NetW028Harness,
} from "./_net-w028-harness.ts";
import { computeRewardSplit } from "../../src/settlement/ledger.ts";
import { createMatureValue } from "../settlement/_net-w008-harness.ts";
import {
  BENEFIT_ALLOCATION_METHOD,
  BENEFIT_ALLOCATION_POLICY_VERSION,
  InvalidBenefitPoolError,
} from "../../src/benefits/port.ts";
import { computeBenefitAllocationPlan } from "../../src/benefits/allocation-engine.ts";

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W028-AC-03 deterministic policy / eligibility / allocation", () => {
  test("the plan is the EXACT settlement deterministic split semantics (floor + last-share absorption; Σ === source)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac03-split",
      amount: 100,
    });
    const result = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
    });
    const allocation = result.allocation;
    // The shares match the settlement reward split for the same
    // amount + weights (the two systems MUST agree exactly).
    const expected = computeRewardSplit(100, [
      { beneficiaryPersonId: harness.poolCreatorPersonId, weight: 3 },
      { beneficiaryPersonId: harness.memberBPersonId, weight: 2 },
      { beneficiaryPersonId: harness.memberCPersonId, weight: 1 },
    ]);
    expect(allocation.shares.map((s) => [s.personId, s.amount])).toEqual(
      expected.map((s) => [s.beneficiaryPersonId, s.amount]),
    );
    // Conservation: Σ shares === 100 EXACTLY at scaled-integer
    // precision (the settlement net-w008-ac-05 precedent — the float
    // display sum can carry representation noise, the minor-unit
    // arithmetic never drifts).
    const scaledTotal = allocation.shares.reduce(
      (sum, s) => sum + Math.round(s.amount * 1_000_000),
      0,
    );
    expect(scaledTotal).toBe(100_000_000);
    expect(allocation.totalAllocated).toBe(100);
    expect(allocation.remainderAmount).toBe(0);
    expect(allocation.remainderDisposition).toBe("last_member_absorbs");
    // The derivation-policy snapshot is recorded on the record.
    expect(allocation.recordFormat).toBe("NET-W028:1");
    // The allocation references the settlement draw (lineage only).
    expect(allocation.draw).not.toBeNull();
    expect(typeof allocation.draw!.transactionId).toBe("string");
  });

  test("the plan is a pure deterministic function of (amount, members, disposition) — identical inputs, identical plans", () => {
    const members = [
      { personId: "p1", weight: 3 },
      { personId: "p2", weight: 2 },
      { personId: "p3", weight: 1 },
    ];
    const a = computeBenefitAllocationPlan(100, members, "last_member_absorbs");
    const b = computeBenefitAllocationPlan(100, members, "last_member_absorbs");
    expect(a).toEqual(b);
    // Order matters (declaration order is canonical).
    const reordered = computeBenefitAllocationPlan(
      100,
      [members[1]!, members[0]!, members[2]!],
      "last_member_absorbs",
    );
    expect(reordered.shares[0]!.personId).toBe("p2");
    // The retained disposition keeps an EXPLICIT remainder.
    const retained = computeBenefitAllocationPlan(10, members, "retained_in_pool");
    expect(retained.remainderAmount).toBeGreaterThan(0);
    expect(retained.remainderAmount).toBeLessThan(1);
    // Σ shares + remainder === 10 EXACTLY at scaled-integer
    // precision (the floor is per-share at 6-decimal minor units —
    // 10 over 3/2/1 floors to 5 / 3.333333 / 1.666666 with the
    // 1-minor remainder EXPLICIT, never lost).
    const retainedScaled =
      retained.shares.reduce((sum, s) => sum + Math.round(s.amount * 1_000_000), 0) +
      Math.round(retained.remainderAmount * 1_000_000);
    expect(retainedScaled).toBe(10_000_000);
    expect(retained.totalAllocated).toBe(9.999999);
    expect(retained.remainderAmount).toBe(0.000001);
  });

  test("the digest is deterministic over canonical facts and EXCLUDES the anchor", async () => {
    const scenarioA = await seedSavingsFundedPool(harness, {
      policyId: "ac03-digest-a",
    });
    const viewA1 = await evaluateAllocation(harness, {
      poolId: scenarioA.pool.id,
    });
    const viewA2 = await evaluateAllocation(harness, {
      poolId: scenarioA.pool.id,
    });
    // Same authoritative state ⇒ same digest (the anchors differ).
    expect(viewA1.digest).toBe(viewA2.digest);
    // The anchors are ordered but MAY share a millisecond (the
    // ISO-millisecond timestamp granularity) — the anchor-exclusion
    // proof is the digest EQUALITY across evaluations plus the
    // engine's structural anchor-free canonical facts; the strict
    // inequality flaked on same-millisecond anchors (the W027
    // same-millisecond lesson — replaced with ordering).
    expect(viewA2.evaluatedAt >= viewA1.evaluatedAt).toBe(true);
    // A DIFFERENT funding state ⇒ a different digest.
    const scenarioB = await seedSavingsFundedPool(harness, {
      policyId: "ac03-digest-b",
    });
    const viewB = await evaluateAllocation(harness, {
      poolId: scenarioB.pool.id,
    });
    expect(viewB.digest).not.toBe(viewA1.digest);
  });

  test("eligibility is server-derived: an inactive member fails the allocation closed", async () => {
    // A DEDICATED fourth member (granted, then revoked) proves the
    // CURRENT re-derivation catches the authoritative participant
    // input change. A dedicated person avoids the org service's
    // terminal revoked-membership state (re-grant requires a fresh
    // record) while keeping member B eligible for the later suites.
    const personD = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-03 Dedicated Member D",
        subjectReferences: [
          { subjectId: "ac03-member-d@example.com", providerKind: "internal" },
        ],
      },
    );
    await harness.runtime.membershipService.grantMembership(
      harness.bootstrapCtx,
      {
        personId: personD.id,
        organizationId: harness.organizationScopeId,
        grantedBy: "bootstrap",
      },
    );
    const members = [
      { personId: harness.poolCreatorPersonId, weight: 3 },
      { personId: harness.memberBPersonId, weight: 2 },
      { personId: personD.id, weight: 1 },
    ];
    // The mirrored settlement reward policy + the benefits policy.
    const rewardPolicyId = `reward-policy-ac03-inactive-${key("ac03")}`;
    await harness.runtime.rewardPolicyService.createPolicyVersion(
      harness.poolCreatorCtx("ac03-inactive-reward"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: rewardPolicyId,
        version: 1,
        description: "AC-03 inactive-member mirror reward policy",
        allocations: members.map((m) => ({
          beneficiaryPersonId: m.personId,
          weight: m.weight,
        })),
      },
    );
    const policy = await createBenefitPolicy(harness, {
      policyId: "ac03-inactive",
      rewardPolicyId,
      members,
    });
    const w008 = harness.w027.w026.w025.w024.w008;
    const value = await createMatureValue(w008, { amount: 100 });
    const pool = await createBenefitPool(harness, {
      policyId: policy.policyId,
      fundingRefs: [{ kind: "economic_value", id: value.id }],
    });
    // Sanity: with D active the derivation is eligible.
    const activeView = await evaluateAllocation(harness, { poolId: pool.id });
    expect(activeView.eligible).toBe(true);
    // Revoke D's membership (the authoritative participant input
    // changes — one-way terminal, fine for a dedicated member).
    const memberships = await harness.runtime.membershipService.listForPerson(
      harness.bootstrapCtx,
      personD.id,
    );
    const membership = memberships.find(
      (m) => m.organizationId === harness.organizationScopeId,
    )!;
    await harness.runtime.membershipService.revokeMembership(
      harness.bootstrapCtx,
      membership.id,
      "bootstrap",
    );
    // The derived view reports the eligibility failure.
    const view = await evaluateAllocation(harness, {
      poolId: pool.id,
    });
    expect(view.eligible).toBe(false);
    const eligibilityCheck = view.checks.find(
      (c) => c.check === "members_eligible",
    );
    expect(eligibilityCheck?.satisfied).toBe(false);
    expect(
      (eligibilityCheck?.detail as { ineligibleMemberIds: string[] })
        .ineligibleMemberIds,
    ).toContain(personD.id);
    // The allocation command fails closed (nothing caller-asserted
    // can waive eligibility).
    await expect(
      allocateBenefits(harness, { poolId: pool.id }),
    ).rejects.toThrow(/eligibility/i);
  });

  test("the draw-policy consistency bridge: a settlement policy that does NOT mirror the member declarations fails closed", async () => {
    // A settlement reward policy with DIFFERENT members than the
    // benefits policy.
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac03-mirror-good",
    });
    const divergentRewardPolicyId = `reward-policy-divergent-${key("ac03")}`;
    await harness.runtime.rewardPolicyService.createPolicyVersion(
      harness.poolCreatorCtx("ac03-divergent"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: divergentRewardPolicyId,
        version: 1,
        description: "Divergent reward policy (different members)",
        allocations: [
          { beneficiaryPersonId: harness.poolCreatorPersonId, weight: 1 },
          { beneficiaryPersonId: harness.memberBPersonId, weight: 1 },
        ],
      },
    );
    await createBenefitPolicy(harness, {
      policyId: "ac03-mirror-bad",
      rewardPolicyId: divergentRewardPolicyId,
    });
    const pool = await createBenefitPool(harness, {
      policyId: "ac03-mirror-bad",
      fundingRefs: [{ kind: "economic_value", id: scenario.value.id }],
    });
    await expect(
      allocateBenefits(harness, { poolId: pool.id }),
    ).rejects.toThrow(/mirror/i);
  });

  test("economic draws REQUIRE last_member_absorbs (the settlement split semantics)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac03-ignored",
    });
    // A retained_in_pool policy that references a reward policy: the
    // draw precondition fails closed.
    const retainedPolicy = await createBenefitPolicy(harness, {
      policyId: "ac03-retained-draw",
      remainderDisposition: "retained_in_pool",
      rewardPolicyId: scenario.rewardPolicyId,
    });
    const pool = await createBenefitPool(harness, {
      policyId: retainedPolicy.policyId,
      fundingRefs: [{ kind: "economic_value", id: scenario.value.id }],
    });
    await expect(
      allocateBenefits(harness, { poolId: pool.id }),
    ).rejects.toThrow(/last_member_absorbs/i);
  });

  test("the policy validation vocabulary fails closed (weights, duplicates, dispositions, criteria)", async () => {
    const base = {
      organizationScopeId: harness.organizationScopeId,
      policyId: "ac03-validation",
      version: 1,
      benefitType: "credits",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations: [
        { personId: harness.poolCreatorPersonId, weight: 1 },
      ],
      remainderDisposition: "last_member_absorbs",
      idempotencyKey: key("ac03-validation"),
    };
    const ctx = harness.poolCreatorCtx("ac03-validation");
    // Unknown benefit type.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(ctx, {
        ...base,
        benefitType: "gold" as never,
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Unknown criterion.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(ctx, {
        ...base,
        eligibilityCriteria: ["spend_threshold"],
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Unknown remainder disposition.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(ctx, {
        ...base,
        remainderDisposition: "round_robin",
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Zero weight.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(ctx, {
        ...base,
        memberDeclarations: [
          { personId: harness.poolCreatorPersonId, weight: 0 },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Duplicate member.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(ctx, {
        ...base,
        memberDeclarations: [
          { personId: harness.poolCreatorPersonId, weight: 1 },
          { personId: harness.poolCreatorPersonId, weight: 2 },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Empty member set.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(ctx, {
        ...base,
        memberDeclarations: [],
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
  });
});
