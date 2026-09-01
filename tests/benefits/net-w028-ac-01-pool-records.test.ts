/**
 * NET-W028 AC-01 — Benefit Pools are first-class records: tenant-
 * scoped pool records with explicit funding REFERENCES (never
 * amounts), versioned immutable allocation-policy lineages with
 * organization-independent fork safety, server-derived benefit type
 * and policy pinning, one-way closure, idempotency/execution lineage
 * and atomic audit (issue #56 key invariant 1).
 *
 * Work order: spec/work-orders/NET-W028.md §3.1/§3.3 / §6 AC-01.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW028Harness,
  createBenefitPolicy,
  createBenefitPool,
  seedValueFundedPool,
  key,
  type NetW028Harness,
} from "./_net-w028-harness.ts";
import {
  BENEFIT_POOL_POLICY_RECORD_FORMAT,
  BENEFIT_POOL_RECORD_FORMAT,
  InvalidBenefitPoolError,
} from "../../src/benefits/port.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W028-AC-01 first-class benefit pool records", () => {
  test("a policy version is a durable, tenant-scoped, immutable, versioned record with the exact contract", async () => {
    const policy = await createBenefitPolicy(harness, {
      policyId: "ac01-policy",
    });
    expect(policy.id).toBeTruthy();
    expect(policy.policyId).toBe("ac01-policy");
    expect(policy.version).toBe(1);
    expect(policy.organizationScopeId).toBe(harness.organizationScopeId);
    // The benefit type is the closed-vocabulary classification.
    expect(policy.benefitType).toBe("credits");
    // The closed-vocabulary eligibility criteria + declaration set.
    expect(policy.eligibilityCriteria).toEqual(["active_membership"]);
    expect(policy.memberDeclarations).toHaveLength(3);
    expect(policy.memberDeclarations[0]!.personId).toBe(
      harness.poolCreatorPersonId,
    );
    expect(policy.memberDeclarations[0]!.weight).toBe(3);
    // The remainder disposition + optional reward policy mirror.
    expect(policy.remainderDisposition).toBe("last_member_absorbs");
    expect(policy.rewardPolicyId).toBeNull();
    // The creator IS the acting person — server-resolved.
    expect(policy.createdBy).toBe(harness.poolCreatorPersonId);
    // Record-format + idempotency/execution lineage.
    expect(policy.recordFormat).toBe(BENEFIT_POOL_POLICY_RECORD_FORMAT);
    expect(typeof policy.idempotencyKey).toBe("string");
    expect(typeof policy.executionId).toBe("string");
    expect(typeof policy.correlationId).toBe("string");
    // The audit event commits atomically with the record.
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_policy.version_created",
      resourceId: policy.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.policyId).toBe("ac01-policy");
    expect(events[0]!.metadata.version).toBe(1);
  });

  test("policy versions are append-only with strict version monotonicity (latest+1 or fresh v1)", async () => {
    const v1 = await createBenefitPolicy(harness, {
      policyId: "ac01-monotonic",
    });
    expect(v1.version).toBe(1);
    const v2 = await createBenefitPolicy(harness, {
      policyId: "ac01-monotonic",
      version: 2,
      remainderDisposition: "retained_in_pool",
    });
    expect(v2.version).toBe(2);
    // v1 is unchanged (immutable lineage — a new version is a NEW record).
    expect(v1.remainderDisposition).toBe("last_member_absorbs");
    // The lineage lists both versions in order.
    const versions = await harness.runtime.benefitPoolService.listPolicyVersions(
      harness.poolCreatorCtx("ac01"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: "ac01-monotonic",
      },
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    // Wrong next version fails closed.
    await expect(
      createBenefitPolicy(harness, {
        policyId: "ac01-monotonic",
        version: 4,
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Re-starting an existing lineage at v1 fails closed.
    await expect(
      createBenefitPolicy(harness, { policyId: "ac01-monotonic", version: 1 }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
  });

  test("a policy lineage can never fork across tenant scope (the org-independent mutex)", async () => {
    // Create the lineage v1 in the harness org.
    await createBenefitPolicy(harness, { policyId: "ac01-fork" });
    // A SECOND organization with the same person as an active member.
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "AC-01 Fork Org", creatorId: "bootstrap" },
    );
    await harness.runtime.membershipService.grantMembership(
      harness.bootstrapCtx,
      {
        personId: harness.poolCreatorPersonId,
        organizationId: otherOrg.id,
        grantedBy: "bootstrap",
      },
    );
    const otherOrgCtx = createExecutionContext({
      correlationId: "ac01-fork",
      actor: { id: harness.poolCreatorPersonId, kind: "person" },
    });
    // The same policyId in the OTHER scope is rejected — a lineage
    // can never fork (fail closed).
    await expect(
      harness.runtime.benefitPoolService.createPolicyVersion(otherOrgCtx, {
        organizationScopeId: otherOrg.id,
        policyId: "ac01-fork",
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.poolCreatorPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        idempotencyKey: key("ac01-fork"),
      }),
    ).rejects.toThrow(/can never fork/i);
  });

  test("policy + pool creation are idempotent (same-key replay returns the committed record, created:false)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac01-replay",
    });
    // Policy replay.
    const replayPolicy = await harness.runtime.benefitPoolService.createPolicyVersion(
      harness.poolCreatorCtx("ac01-replay"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: "ac01-replay",
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.poolCreatorPersonId, weight: 3 },
          { personId: harness.memberBPersonId, weight: 2 },
          { personId: harness.memberCPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        rewardPolicyId: scenario.rewardPolicyId,
        idempotencyKey: scenario.policy.idempotencyKey,
      },
    );
    expect(replayPolicy.created).toBe(false);
    expect(replayPolicy.policy.id).toBe(scenario.policy.id);
    // Pool replay.
    const replayPool = await harness.runtime.benefitPoolService.createBenefitPool(
      harness.poolCreatorCtx("ac01-replay"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: "ac01-replay",
        fundingRefs: [{ kind: "economic_value", id: scenario.value.id }],
        idempotencyKey: scenario.pool.idempotencyKey,
      },
    );
    expect(replayPool.created).toBe(false);
    expect(replayPool.pool.id).toBe(scenario.pool.id);
  });

  test("a pool is a durable, tenant-scoped record with funding REFERENCES and a server-pinned policy version", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac01-pool",
    });
    const pool = scenario.pool;
    expect(pool.id).toBeTruthy();
    expect(pool.organizationScopeId).toBe(harness.organizationScopeId);
    expect(pool.policyId).toBe("ac01-pool");
    expect(pool.policyVersion).toBe(scenario.policy.version);
    // The benefit type is SERVER-DERIVED from the pinned policy (no
    // caller input exists for it).
    expect(pool.benefitType).toBe(scenario.policy.benefitType);
    // The funding reference set is kind + id ONLY — there is no
    // amount, balance or funded-value field on the record.
    expect(pool.fundingRefs).toEqual([
      { kind: "economic_value", id: scenario.value.id },
    ]);
    expect(Object.keys(pool)).not.toContain("fundedAmount");
    expect(Object.keys(pool)).not.toContain("balance");
    // The creator IS the acting person — server-resolved.
    expect(pool.createdBy).toBe(harness.poolCreatorPersonId);
    // One-way closure starts clean.
    expect(pool.closedAt).toBeNull();
    // Record-format + idempotency/execution lineage.
    expect(pool.recordFormat).toBe(BENEFIT_POOL_RECORD_FORMAT);
    // The audit event commits atomically with the record.
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.created",
      resourceId: pool.id,
    });
    expect(events).toHaveLength(1);
  });

  test("pool creation validates the funding reference shape fail-closed (no caller amounts anywhere)", async () => {
    await createBenefitPolicy(harness, { policyId: "ac01-shape" });
    // Empty set rejected.
    await expect(
      createBenefitPool(harness, {
        policyId: "ac01-shape",
        fundingRefs: [],
      }),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // Unknown kind rejected (closed vocabulary).
    await expect(
      createBenefitPool(harness, {
        policyId: "ac01-shape",
        fundingRefs: [{ kind: "caller_asserted_cash", id: "x" }],
      }),
    ).rejects.toThrow(/closed vocabulary/i);
    // Duplicate references rejected.
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac01-shape-2",
    });
    await expect(
      createBenefitPool(harness, {
        policyId: "ac01-shape-2",
        fundingRefs: [
          { kind: "economic_value", id: scenario.value.id },
          { kind: "economic_value", id: scenario.value.id },
        ],
      }),
    ).rejects.toThrow(/more than once/i);
    // An unknown policy fails closed (NotFound).
    await expect(
      createBenefitPool(harness, {
        policyId: "ac01-does-not-exist",
        fundingRefs: [{ kind: "economic_value", id: scenario.value.id }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("pool closure is ONE-WAY: a closed pool never re-opens and never allocates again", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac01-close",
    });
    const closed = await harness.runtime.benefitPoolService.closeBenefitPool(
      harness.poolCreatorCtx("ac01-close"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
        idempotencyKey: key("ac01-close"),
      },
    );
    expect(closed.closedAt).not.toBeNull();
    // The closure audit event commits atomically.
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.closed",
      resourceId: scenario.pool.id,
    });
    expect(events).toHaveLength(1);
    // A second close under a FOREIGN key conflicts deterministically.
    await expect(
      harness.runtime.benefitPoolService.closeBenefitPool(
        harness.poolCreatorCtx("ac01-close"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.pool.id,
          idempotencyKey: key("ac01-close-2"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidBenefitPoolError);
    // A closed pool can never allocate again (fail-closed).
    await expect(
      harness.runtime.benefitPoolService.allocatePoolBenefits(
        harness.poolCreatorCtx("ac01-close"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.pool.id,
          idempotencyKey: key("ac01-close-alloc"),
        },
      ),
    ).rejects.toThrow(/closed/i);
  });
});
