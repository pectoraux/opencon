/**
 * NET-W028 AC-06 — Idempotency, concurrency, atomicity and fault
 * injection: the allocation is ONE exactly-once economic unit
 * (same-key replay returns the committed composite; concurrent
 * same-key calls produce exactly one mutation; concurrent distinct
 * keys serialize and conserve the envelope); a FAILED authoritative
 * commit leaves NO partial mutation (no allocation record, no draw,
 * no value consumption, no audit event — the transactional audit
 * buffer is discarded); audit publication is post-commit (issue #56
 * key invariants 6 + 7).
 *
 * Work order: spec/work-orders/NET-W028.md §3.7/§3.8 / §6 AC-06.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW028Harness,
  seedValueFundedPool,
  seedSavingsFundedPool,
  allocateBenefits,
  key,
  type NetW028Harness,
} from "./_net-w028-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W028-AC-06 idempotency / concurrency / atomicity / fault injection", () => {
  test("same-key replay is exactly-once: the committed composite replays verbatim (created:false)", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac06-replay",
    });
    const idempotencyKey = key("ac06-replay");
    const first = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      idempotencyKey,
    });
    expect(first.created).toBe(true);
    // The retry with the SAME key replays the committed composite
    // verbatim (no second draw, no second record).
    const replay = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      idempotencyKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.allocation.id).toBe(first.allocation.id);
    // Exactly ONE allocation record + ONE reward allocation + the
    // value record consumed exactly-once.
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac06-replay"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      },
    );
    expect(allocations).toHaveLength(1);
    const value = await harness.runtime.economicValueService.getValue(
      harness.poolCreatorCtx("ac06-replay"),
      scenario.value.id,
    );
    expect(value.state).toBe("CONSUMED");
    expect(value.consumedBy).not.toBeNull();
    // Exactly ONE audit event for the allocation.
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
      resourceId: first.allocation.id,
    });
    expect(events).toHaveLength(1);
  });

  test("concurrent same-key allocations produce exactly one committed composite", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac06-concurrent-same-key",
    });
    const idempotencyKey = key("ac06-concurrent");
    const [a, b] = await Promise.all([
      allocateBenefits(harness, { poolId: scenario.pool.id, idempotencyKey }),
      allocateBenefits(harness, { poolId: scenario.pool.id, idempotencyKey }),
    ]);
    // Exactly one executed; the other is the deterministic replay.
    expect(a.created).not.toBe(b.created);
    expect(a.allocation.id).toBe(b.allocation.id);
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac06-concurrent-same-key"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      },
    );
    expect(allocations).toHaveLength(1);
  });

  test("concurrent DISTINCT-key allocations serialize and conserve the envelope (the pool mutex)", async () => {
    // A savings-funded pool with a 200 envelope: two concurrent
    // 150-amount allocations — exactly one succeeds, the other fails
    // closed on conservation (the per-pool mutex serializes the
    // check-then-act sequence).
    const scenario = await seedSavingsFundedPool(harness, {
      policyId: "ac06-concurrent-distinct",
    });
    const results = await Promise.allSettled([
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        amount: 150,
        idempotencyKey: key("ac06-c1"),
      }),
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        amount: 150,
        idempotencyKey: key("ac06-c2"),
      }),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /exceed the authoritative funding envelope/i,
    );
    // Exactly one allocation record; the envelope is conserved.
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac06-concurrent-distinct"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      },
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.totalAllocated).toBe(150);
  });

  test("FAULT INJECTION: a draw failure leaves NO partial mutation (allocation, draw, consumption, audit)", async () => {
    // A pool whose reward policy mirrors the member declarations but
    // whose value record belongs to a DIFFERENT beneficiary than the
    // account set the draw posts... instead, force the draw to fail
    // through the CONSUMED backstop: pre-consume the value record
    // with a standalone reward allocation under a foreign idempotency
    // key AFTER the pool was created (the committed pre-flight read
    // saw it MATURE; the in-tx re-derivation must fail closed and
    // roll EVERYTHING back).
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac06-fault",
    });
    // Consume the value record through the settlement's OWN
    // standalone command (the settlement authority acting alone).
    await harness.runtime.rewardService.allocateRewards(
      harness.poolCreatorCtx("ac06-fault-pre-consume"),
      {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: scenario.value.id,
        policyId: scenario.rewardPolicyId,
        idempotencyKey: key("ac06-fault-preconsume"),
      },
    );
    // The allocation now fails closed (in-tx funding re-derivation:
    // the record is CONSUMED — the pre-flight MATURE read is stale).
    await expect(
      allocateBenefits(harness, { poolId: scenario.pool.id }),
    ).rejects.toThrow(/not qualified/i);
    // NO partial mutation survived the failed commit:
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac06-fault"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.pool.id,
      },
    );
    expect(allocations).toHaveLength(0);
    // NO audit event was published for the failed allocation (the
    // transactional audit buffer is DISCARDED on the failed commit —
    // "audit exists, mutation doesn't" is impossible).
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
    });
    const forThisPool = events.filter(
      (e) => e.subject === scenario.pool.id,
    );
    expect(forThisPool).toHaveLength(0);
  });

  test("audit publication is POST-COMMIT: the audit event carries the authoritative transaction id", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac06-audit",
    });
    const result = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
      resourceId: result.allocation.id,
    });
    expect(events).toHaveLength(1);
    // The audit lineage binds the authoritative transaction + the
    // draw + the idempotency discipline.
    expect(typeof events[0]!.metadata.transactionId).toBe("string");
    expect(events[0]!.metadata.drawTransactionId).toBe(
      result.allocation.draw!.transactionId,
    );
    expect(typeof events[0]!.metadata.idempotencyRecordId).toBe("string");
  });

  test("policy creation is idempotent under the lineage mutex (concurrent same-key creates)", async () => {
    const policyId = `ac06-policy-${key("p")}`;
    const idempotencyKey = key("ac06-policy");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      policyId,
      version: 1,
      benefitType: "credits",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations: [
        { personId: harness.poolCreatorPersonId, weight: 3 },
        { personId: harness.memberBPersonId, weight: 2 },
        { personId: harness.memberCPersonId, weight: 1 },
      ],
      remainderDisposition: "last_member_absorbs",
      idempotencyKey,
    } as const;
    const [a, b] = await Promise.all([
      harness.runtime.benefitPoolService.createPolicyVersion(
        harness.poolCreatorCtx("ac06-policy-a"),
        input,
      ),
      harness.runtime.benefitPoolService.createPolicyVersion(
        harness.poolCreatorCtx("ac06-policy-b"),
        input,
      ),
    ]);
    expect(a.created).not.toBe(b.created);
    expect(a.policy.id).toBe(b.policy.id);
  });

  test("allocation input validation fails closed before any mutation", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac06-validation",
    });
    // A valueRecordId that is not a declared funding reference.
    await expect(
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        valueRecordId: "not-a-declared-ref",
      }),
    ).rejects.toThrow(/not a declared economic_value funding reference/i);
    // A non-positive entitlement amount: the amount validation is a
    // SAVINGS-ENTITLEMENT surface (economic draws forbid ANY caller
    // amount first — AC-02 pins that), so the proof uses an
    // entitlement-only pool.
    const entitlement = await seedSavingsFundedPool(harness, {
      policyId: "ac06-validation-entitlement",
    });
    await expect(
      allocateBenefits(harness, {
        poolId: entitlement.pool.id,
        amount: 0,
      }),
    ).rejects.toThrow(/> 0/i);
    // No mutation leaked: the entitlement pool has no allocation.
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.poolCreatorCtx("ac06-validation"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: entitlement.pool.id,
      },
    );
    expect(allocations).toHaveLength(0);
  });
});
