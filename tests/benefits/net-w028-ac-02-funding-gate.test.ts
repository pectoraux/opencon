/**
 * NET-W028 AC-02 — The authoritative funding gate: only already-
 * authoritative upstream value may fund a pool (settlement
 * EconomicValueRecords resolved in-tx; W027 verified savings consumed
 * as re-derived facts); unqualified, stale, revoked, consumed or
 * cross-scope funding fails closed; caller-supplied amounts are
 * never authority (issue #56 key invariants 2 + 8).
 *
 * Work order: spec/work-orders/NET-W028.md §3.2/§3.7 / §6 AC-02.
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
import {
  createPendingValue,
  createMatureValue,
} from "../settlement/_net-w008-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  createBaseline,
  createPoolEvidence,
  createSavingsObservation,
  recordSavings,
  seedSavingsScenario,
} from "../demand/_net-w027-harness.ts";

let harness: NetW028Harness;

beforeAll(async () => {
  harness = await createNetW028Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W028-AC-02 authoritative funding gate", () => {
  test("a PENDING value record cannot fund a draw (pending value is not consumable)", async () => {
    const w008 = harness.w027.w026.w025.w024.w008;
    // A PENDING (unmatured) value record.
    const pending = await createPendingValue(w008, {
      maturation: { strategy: "fixed_window", windowEndAt: "2099-01-01T00:00:00.000Z" },
    });
    await createBenefitPolicy(harness, {
      policyId: "ac02-pending",
      rewardPolicyId: (await seedValueFundedPool(harness, { policyId: "ac02-pending-x" }))
        .rewardPolicyId,
    });
    const pool = await createBenefitPool(harness, {
      policyId: "ac02-pending",
      fundingRefs: [{ kind: "economic_value", id: pending.id }],
    });
    // The derived view reports the unqualified funding.
    const view = await evaluateAllocation(harness, { poolId: pool.id });
    expect(view.eligible).toBe(false);
    const fundingCheck = view.checks.find((c) => c.check === "funding_qualified");
    expect(fundingCheck?.satisfied).toBe(false);
    // The allocation command fails closed.
    await expect(
      allocateBenefits(harness, { poolId: pool.id }),
    ).rejects.toThrow(/not qualified/i);
  });

  test("a CONSUMED value record cannot fund a second draw (exactly-once consumption is the backstop)", async () => {
    // A second MATURE value record funded pool, then consumed by an
    // allocation, cannot fund again.
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac02-consumed",
    });
    const first = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
    });
    expect(first.created).toBe(true);
    // The record is now CONSUMED exactly-once.
    const after = await harness.runtime.economicValueService.getValue(
      harness.poolCreatorCtx("ac02-consumed"),
      scenario.value.id,
    );
    expect(after.state).toBe("CONSUMED");
    // A second allocation under a NEW key fails closed (the funding
    // no longer resolves as MATURE).
    await expect(
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        idempotencyKey: key("ac02-consumed-2"),
      }),
    ).rejects.toThrow(/not qualified/i);
  });

  test("an UNKNOWN or cross-scope funding reference fails closed without existence oracles", async () => {
    // The policy carries the reward-policy mirror so the draw
    // preconditions pass and the FAILURE surfaces from the funding
    // gate itself (the authoritative-bar check).
    const rewardPolicyId = `reward-policy-ac02-unknown-${key("ac02")}`;
    await harness.runtime.rewardPolicyService.createPolicyVersion(
      harness.poolCreatorCtx("ac02-unknown-reward"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: rewardPolicyId,
        version: 1,
        description: "AC-02 unknown-ref mirror reward policy",
        allocations: [
          { beneficiaryPersonId: harness.poolCreatorPersonId, weight: 3 },
          { beneficiaryPersonId: harness.memberBPersonId, weight: 2 },
          { beneficiaryPersonId: harness.memberCPersonId, weight: 1 },
        ],
      },
    );
    await createBenefitPolicy(harness, {
      policyId: "ac02-unknown",
      rewardPolicyId,
    });
    const pool = await createBenefitPool(harness, {
      policyId: "ac02-unknown",
      fundingRefs: [{ kind: "economic_value", id: "no-such-value-record" }],
    });
    // The DERIVED view resolves the reference as unqualified (no
    // existence oracle — unknown and cross-scope are both simply
    // "not found in scope", resolvedAmount null).
    const view = await evaluateAllocation(harness, { poolId: pool.id });
    expect(view.eligible).toBe(false);
    const fundingCheck = view.checks.find((c) => c.check === "funding_qualified");
    expect(fundingCheck?.satisfied).toBe(false);
    expect(view.funding[0]!.qualified).toBe(false);
    expect(view.funding[0]!.resolvedAmount).toBeNull();
    // The allocation command fails closed: a scoped NotFound —
    // cross-scope is INDISTINGUISHABLE from nonexistent (no oracle).
    await expect(
      allocateBenefits(harness, { poolId: pool.id }),
    ).rejects.toThrow(/not found in scope/i);
    // Cross-scope pools: a reader in ANOTHER org sees the same
    // scoped NotFound for the pool itself (no existence oracle).
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "AC-02 Other Org", creatorId: "bootstrap" },
    );
    const otherOrgCtx = createExecutionContext({
      correlationId: "ac02-cross-scope",
      actor: { id: harness.poolCreatorPersonId, kind: "person" },
    });
    await expect(
      harness.runtime.benefitPoolService.getBenefitPool(otherOrgCtx, {
        organizationScopeId: otherOrg.id,
        poolId: pool.id,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("verified savings fund entitlement-only allocations; an INVALIDATED baseline fails funding closed (current re-derivation, never stale snapshots)", async () => {
    // The supported savings scenario funds an entitlement allocation.
    const scenario = await seedSavingsFundedPool(harness, {
      policyId: "ac02-savings",
    });
    const view = await evaluateAllocation(harness, {
      poolId: scenario.pool.id,
    });
    expect(view.eligible).toBe(true);
    expect(view.funding[0]!.qualified).toBe(true);
    expect(view.funding[0]!.resolvedAmount).toBe(200);
    const allocation = await allocateBenefits(harness, {
      poolId: scenario.pool.id,
      amount: 200,
    });
    // 200 over 3/2/1 with retained_in_pool floors per-share at
    // 6-decimal minor units: 100 / 66.666666 / 33.333333 → Σ =
    // 199.999999 + the EXPLICIT 0.000001 remainder — 200 conserved
    // EXACTLY at scaled-integer precision (never lost to rounding).
    expect(allocation.allocation.totalAllocated).toBe(199.999999);
    expect(allocation.allocation.remainderAmount).toBe(0.000001);
    const conservedScaled =
      Math.round(allocation.allocation.totalAllocated * 1_000_000) +
      Math.round(allocation.allocation.remainderAmount * 1_000_000);
    expect(conservedScaled).toBe(200_000_000);
    expect(allocation.allocation.draw).toBeNull();

    // Invalidate the baseline (ONE-WAY) → the CURRENT re-derivation
    // no longer supports the savings → the funding fails closed.
    await harness.runtime.procurementSavingsService.invalidateProcurementBaseline(
      harness.poolCreatorCtx("ac02-invalidate"),
      {
        organizationScopeId: harness.organizationScopeId,
        baselineId: scenario.savings.baselineId,
        reason: "method_superseded",
        idempotencyKey: key("ac02-invalidate"),
      },
    );
    const staleView = await evaluateAllocation(harness, {
      poolId: scenario.pool.id,
    });
    expect(staleView.eligible).toBe(false);
    expect(staleView.funding[0]!.qualified).toBe(false);
    await expect(
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        amount: 1,
        idempotencyKey: key("ac02-stale"),
      }),
    ).rejects.toThrow(/not qualified/i);
  });

  test("caller-supplied amounts are NEVER draw authority: an explicit amount on an economic draw is rejected", async () => {
    const scenario = await seedValueFundedPool(harness, {
      policyId: "ac02-no-caller-amount",
    });
    // The draw allocates the authoritative record amount exactly —
    // any caller amount is forbidden (no partial draws, no caller
    // arithmetic).
    await expect(
      allocateBenefits(harness, {
        poolId: scenario.pool.id,
        amount: 50,
      }),
    ).rejects.toThrow(/forbidden for economic draws/i);
    // The structural proof: the pool record carries NO amount field
    // at all (funding is references only).
    expect(Object.keys(scenario.pool)).not.toContain("amount");
    expect(Object.keys(scenario.pool)).not.toContain("fundedAmount");
  });

  test("the savings funding facts expose ONLY the derived verdict — never procurement internals", async () => {
    // The savings scenario with an observation that is NOT chain
    // head (a correction supersedes it) makes the CURRENT derivation
    // fail closed (the W027 observation_chain_head check).
    const scenario = await seedSavingsScenario(harness.w027, {
      name: "AC-02 Chain Pool",
    });
    const savings = await recordSavings(harness.w027, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    // A later observation CORRECTS the recorded one → the recorded
    // observation is no longer chain head → the savings funding's
    // current re-derivation fails closed.
    await harness.runtime.outcomeObservationService.correctOutcomeObservation(
      harness.poolCreatorCtx("ac02-correction"),
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.poolCreatorPersonId,
        observedValue: { value: 900, unit: "usd" },
        confidence: { point: 0.95, method: "platform-counter" },
        provenance: {
          sourceType: "platform",
          method: "procurement-fulfillment-ledger",
          methodVersion: "1",
        },
        correctsObservationId: scenario.observation.id,
      },
    );
    await createBenefitPolicy(harness, {
      policyId: "ac02-chain",
      remainderDisposition: "retained_in_pool",
    });
    const pool = await createBenefitPool(harness, {
      policyId: "ac02-chain",
      fundingRefs: [{ kind: "verified_savings", id: savings.id }],
    });
    const view = await evaluateAllocation(harness, { poolId: pool.id });
    // The funding fails closed — the CURRENT re-derivation no longer
    // supports the claim (the recorded observation is superseded).
    expect(view.eligible).toBe(false);
    expect(view.funding[0]!.qualified).toBe(false);
    // The funding facts in the view expose ONLY kind/id/qualified/
    // resolvedAmount/reason — never demand aggregates, commitment
    // counts or procurement internals.
    const fact = JSON.stringify(view.funding);
    expect(fact).not.toMatch(/commitment/i);
    expect(fact).not.toMatch(/aggregate/i);
    expect(fact).not.toMatch(/buyerOrganization/i);
  });
});
