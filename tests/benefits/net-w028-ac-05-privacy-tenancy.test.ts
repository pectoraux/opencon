/**
 * NET-W028 AC-05 — Privacy, tenancy and authorization: pool/member
 * views expose only policy-authorized information (the member sees
 * THEIR OWN shares and totals ONLY — never other members'
 * identities, weights or amounts, never protected procurement
 * demand); cross-tenant and unauthorized access fails closed without
 * existence oracles (issue #56 key invariants 5 + 8).
 *
 * Work order: spec/work-orders/NET-W028.md §3.6 / §6 AC-05.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW028Harness,
  seedValueFundedPool,
  seedSavingsFundedPool,
  allocateBenefits,
  memberView,
  key,
  type NetW028Harness,
} from "./_net-w028-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { AuthorizationError, NotFoundError } from "../../src/core/errors.ts";

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W028-AC-05 privacy / tenancy / authorization", () => {
  test("the member view exposes ONLY the requesting member's own shares and totals", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac05-member-view",
    });
    await allocateBenefits(harness, { poolId: scenario.pool.id });
    // Member B reads THEIR OWN view.
    const view = await memberView(harness, {
      poolId: scenario.pool.id,
      ctx: harness.memberBCtx("ac05-member-view"),
    });
    expect(view.ownShares).toHaveLength(1);
    // Member B's own share: 100 × 2/6 floored = 33.333333.
    expect(Math.round(view.ownShares[0]!.amount * 1_000_000)).toBe(
      Math.round(33.333333 * 1_000_000),
    );
    expect(view.ownTotal).toBeCloseTo(33.333333, 9);
    // The pool total is the aggregate (no other-member data).
    expect(view.poolTotalAllocated).toBeCloseTo(100, 9);
    // PRIVACY: the serialized view contains NO other-member
    // identifiers, weights or share amounts (only the acting
    // member's own personId may appear, and even that is not a field
    // of the view — the view is keyed BY the requesting member).
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(harness.memberCPersonId);
    expect(serialized).not.toContain(harness.poolCreatorPersonId);
    expect(serialized).not.toMatch(/"weight"/i);
    expect(serialized).not.toMatch(/fundingRefs/i);
    // The other members' share amounts never appear (66.66... and
    // the creator's share are absent — only 33.333333 + totals).
    expect(serialized).not.toContain("50.0000");
    expect(Object.keys(view)).toEqual([
      "poolId",
      "organizationScopeId",
      "benefitType",
      "policyId",
      "policyVersion",
      "ownShares",
      "ownTotal",
      "poolTotalAllocated",
    ]);
  });

  test("the member view exposes NO procurement demand data (savings-funded pools)", async () => {
    const scenario = await seedSavingsFundedPool(harness, {
      policyId: "ac05-savings-privacy",
    });
    await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      amount: 12,
    });
    const view = await memberView(harness, {
      poolId: scenario.pool.id,
    });
    const serialized = JSON.stringify(view);
    // No funding reference resolution details cross the member view.
    expect(serialized).not.toContain(scenario.savings.id);
    expect(serialized).not.toMatch(/funding/i);
    expect(serialized).not.toMatch(/commitment/i);
    expect(serialized).not.toMatch(/buyerOrganization/i);
    expect(serialized).not.toMatch(/savingsId/i);
  });

  test("a NON-member's member-view read is indistinguishable from a nonexistent pool (no existence oracle)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac05-nonmember",
    });
    // A person with NO membership in the org.
    const outsider = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-05 Outsider",
        subjectReferences: [
          { subjectId: "ac05-outsider", providerKind: "internal" },
        ],
      },
    );
    const outsiderCtx = createExecutionContext({
      correlationId: "ac05-nonmember",
      actor: { id: outsider.id, kind: "person" },
    });
    // The read fails closed as NOT FOUND (never "forbidden" — a
    // rejected read must not reveal the pool's existence).
    await expect(
      harness.runtime.benefitPoolService.getMemberBenefitView(outsiderCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("cross-tenant reads fail closed as not-found (no existence oracle)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac05-cross-tenant",
    });
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "AC-05 Other Org", creatorId: "bootstrap" },
    );
    // A member of the OTHER org reads our pool id in THEIR scope →
    // not found (indistinguishable from nonexistent).
    await expect(
      harness.runtime.benefitPoolService.getBenefitPool(
        harness.poolCreatorCtx("ac05-cross-tenant"),
        {
          organizationScopeId: otherOrg.id,
          poolId: scenario.pool.id,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.benefitPoolService.listPoolAllocations(
        harness.poolCreatorCtx("ac05-cross-tenant"),
        {
          organizationScopeId: otherOrg.id,
          poolId: scenario.pool.id,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("non-creator members cannot administer pools (authorization fails closed)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac05-authorization",
    });
    const memberBCtx = harness.memberBCtx("ac05-authorization");
    // Member B (an active member, but NOT the creator) cannot read
    // the pool detail.
    await expect(
      harness.runtime.benefitPoolService.getBenefitPool(memberBCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // ...cannot close the pool.
    await expect(
      harness.runtime.benefitPoolService.closeBenefitPool(memberBCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
        idempotencyKey: key("ac05-close"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // ...and cannot execute allocations.
    await expect(
      harness.runtime.benefitPoolService.allocatePoolBenefits(memberBCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
        idempotencyKey: key("ac05-allocate"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // Unauthenticated actors are rejected outright.
    const serviceCtx = createExecutionContext({
      correlationId: "ac05-service",
    });
    await expect(
      harness.runtime.benefitPoolService.allocatePoolBenefits(serviceCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
        idempotencyKey: key("ac05-service"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // A non-member actor cannot even create a policy.
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(
        createExecutionContext({
          correlationId: "ac05-policy-x",
          actor: { id: "person-not-a-member", kind: "person" },
        }),
        {
          organizationScopeId: harness.organizationScopeId,
          policyId: "ac05-not-a-member",
          version: 1,
          benefitType: "credits",
          eligibilityCriteria: ["active_membership"],
          memberDeclarations: [
            { personId: harness.poolCreatorPersonId, weight: 1 },
          ],
          remainderDisposition: "last_member_absorbs",
          idempotencyKey: key("ac05-policy-x"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
