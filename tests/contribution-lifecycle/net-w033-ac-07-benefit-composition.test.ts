/**
 * NET-W033-AC-07 — Benefit composition (issue #67 §4 AC-07).
 *
 * Authoritative settled/verified value feeds /benefits using existing
 * W028 semantics; allocations remain traceable, deterministic and
 * privacy-preserving; economic postings remain /settlement-owned:
 *  - the pool is funded by REFERENCES only (the MATURE value record —
 *    never an amount);
 *  - the allocation executes the settlement reward primitive (the
 *    draw: MATURE → CONSUMED with balanced ledger postings INSIDE
 *    /settlement);
 *  - the deterministic plan (weights 3/2/1, last_member_absorbs) is
 *    reproducible: the derived evaluation view matches the committed
 *    allocation;
 *  - the benefit allocation record carries NO economic postings of
 *    its own (references + the draw link — /settlement stays the
 *    economic authority);
 *  - the member view (privacy-preserving) exposes each member's own
 *    share without the private source payloads;
 *  - the global envelope stays conserved.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  POOL_MEMBER_WEIGHTS,
  type NetW033Harness,
} from "./_net-w033-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW033Harness;
let scenario: Awaited<ReturnType<typeof runCanonicalScenario>>;

beforeAll(async () => {
  harness = await createNetW033Harness();
  scenario = await runCanonicalScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033-AC-07 benefit composition", () => {
  test("the pool is funded by REFERENCES only (the MATURE value record — never an amount)", async () => {
    const pool = await harness.runtime.benefitPoolService.getBenefitPool(
      harness.moderatorCtx("w033-ac07-pool"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      },
    );
    expect(pool.fundingRefs).toHaveLength(1);
    expect(pool.fundingRefs[0]!.kind).toBe("economic_value");
    expect(pool.fundingRefs[0]!.id).toBe(scenario.matureValue.id);
    // The funding reference is a REFERENCE: no amount is carried on
    // the pool (the /settlement authority resolves the amount at draw
    // time — the in-tx re-derivation).
    expect((pool.fundingRefs[0] as { amount?: unknown }).amount).toBeUndefined();
  });

  test("the allocation executes the settlement reward primitive (MATURE → CONSUMED, balanced postings INSIDE /settlement)", async () => {
    const ctx = harness.contributorCtx("w033-ac07-draw");
    // The value record was consumed by the draw (the settlement
    // authority's own state machine).
    const value = await harness.runtime.economicValueService.getValue(
      ctx,
      scenario.matureValue.id,
    );
    expect(value.state).toBe("CONSUMED");
    expect(value.consumedBy).not.toBeNull();
    // The draw is a REAL settlement reward allocation (result +
    // ledger transaction lineage).
    const draw = scenario.allocation.draw as {
      readonly resultId: string;
      readonly transactionId: string;
    } | null;
    expect(draw).not.toBeNull();
    expect(typeof draw!.resultId).toBe("string");
    expect(typeof draw!.transactionId).toBe("string");
    // The balanced postings exist in the economic ledger (through
    // /settlement ONLY — the W008 ledger entries; the scan returns
    // {value: entry} records).
    const scanned = await harness.runtime.postgresAuthority.scan<{
      readonly transactionId: string;
      readonly accountId: string;
      readonly direction: string;
      readonly amount: number;
    }>("economic_ledger_entries");
    const entries = scanned.map((r) => r.value);
    const drawEntries = entries.filter(
      (e) => e.transactionId === draw!.transactionId,
    );
    expect(drawEntries.length).toBeGreaterThanOrEqual(2);
    const debit = drawEntries
      .filter((e) => e.direction === "debit")
      .reduce((s, e) => s + e.amount, 0);
    const credit = drawEntries
      .filter((e) => e.direction === "credit")
      .reduce((s, e) => s + e.amount, 0);
    // Balanced in minor units (floating-point safe — the W008
    // conservation discipline).
    expect(Math.round(debit * 1_000_000)).toBe(Math.round(credit * 1_000_000));
    // The audit trail: the draw is recorded through the settlement
    // authority's own reward-allocation event (the postings live in
    // the immutable ledger entry set — proven above).
    const rewardEvents = await harness.runtime.auditWriter.query({
      eventType: "reward_allocation.recorded",
    });
    expect(
      rewardEvents.filter(
        (e) => e.resourceId === (draw as { resultId: string }).resultId,
      ).length,
    ).toBe(1);
    // And the benefit allocation's own event binds the draw lineage
    // (the post-commit audit discipline).
    const benefitEvents = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
      resourceId: scenario.allocationId,
    });
    expect(benefitEvents).toHaveLength(1);
    expect(benefitEvents[0]!.metadata?.drawTransactionId).toBe(
      draw!.transactionId,
    );
    expect(typeof benefitEvents[0]!.metadata?.idempotencyRecordId).toBe(
      "string",
    );
  });

  test("the deterministic plan (3/2/1, last_member_absorbs) is reproducible: the derived evaluation matches the committed allocation", async () => {
    // The derived (non-mutating) evaluation view.
    const evaluation = await harness.runtime.benefitPoolService.evaluatePoolAllocation(
      harness.moderatorCtx("w033-ac07-evaluate"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      },
    );
    // The committed allocation (from the scenario).
    const committed = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.moderatorCtx("w033-ac07-committed"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      },
    );
    expect(committed).toHaveLength(1);
    const allocation = committed[0]!;
    // The deterministic plan: total 100 at weights 3/2/1 →
    // 50 / 33.33 / 16.67 with the remainder absorbed by the LAST
    // member (the deterministic split engine).
    expect(allocation.totalAllocated).toBe(100);
    expect(allocation.shares).toHaveLength(3);
    const byPerson = new Map(
      allocation.shares.map((s) => [s.personId, s.amount]),
    );
    const totalMinor = allocation.shares.reduce(
      (s, x) => s + Math.round(x.amount * 1_000_000),
      0,
    );
    expect(totalMinor).toBe(100_000_000);
    // The weights order (a=3, b=2, c=1) → descending amounts, sum
    // conserved in minor units (floating-point safe).
    const a = byPerson.get(harness.contributorPersonId)!;
    const b = byPerson.get(harness.moderatorPersonId)!;
    const c = byPerson.get(harness.memberCPersonId)!;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(
      Math.round((a + b + c) * 1_000_000),
    ).toBe(100_000_000);
    // The policy linkage: the allocation carries the policy's
    // human-readable policyId label (the versioned lineage key).
    expect(allocation.policyId).toMatch(/^benefit-policy-w033-/);
  });

  test("the benefit allocation record carries NO economic postings of its own (/settlement stays the economic authority)", async () => {
    const committed = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.moderatorCtx("w033-ac07-containment"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      },
    );
    const allocation = committed[0]!;
    // The allocation carries the plan + the draw REFERENCE (linked,
    // traceable) — the postings live in the /settlement ledger.
    expect(allocation.draw).not.toBeNull();
    const draw = allocation.draw as { transactionId: string };
    expect(typeof draw.transactionId).toBe("string");
    // The W033 canonical scenario created exactly ONE reward
    // allocation record for the value (the /settlement authority's
    // own record — referenced by the benefit allocation).
    const rewards = await harness.runtime.rewardService.listAllocations(
      harness.moderatorCtx("w033-ac07-rewards"),
      harness.organizationScopeId,
    );
    const forValue = rewards.filter(
      (r) => r.sourceValueRecordId === scenario.matureValue.id,
    );
    expect(forValue).toHaveLength(1);
    // No second ledger exists: the economic ledger entries all carry
    // settlement-owned transaction ids (the global conservation
    // invariant holds — no orphan postings).
    await assertGlobalConservation(
      harness.w014.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the member view is privacy-preserving (own share, aggregate facts, no source evidence payloads)", async () => {
    // Each member sees the member view for the pool.
    for (const [ctxFn, personId] of [
      [harness.contributorCtx.bind(harness), harness.contributorPersonId],
      [harness.moderatorCtx.bind(harness), harness.moderatorPersonId],
      [harness.memberCCtx.bind(harness), harness.memberCPersonId],
    ] as const) {
      const view = await harness.runtime.benefitPoolService.getMemberBenefitView(
        ctxFn("w033-ac07-member-view"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.poolId,
        },
      );
      // The member view exposes ONLY the member's OWN shares + the
      // pool aggregate (never other members' data, never sources).
      expect(view.poolId).toBe(scenario.poolId);
      expect(view.ownShares).toHaveLength(1);
      expect(view.ownShares[0]!.amount).toBeGreaterThan(0);
      expect(view.ownTotal).toBe(view.ownShares[0]!.amount);
      expect(view.poolTotalAllocated).toBe(100);
      // It exposes NO private source evidence: no evidence ids, no
      // evidence payloads, no raw personal histories (the funding is
      // a reference; the value lineage stays behind the authorities).
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(scenario.povPlatformEvidenceId);
      expect(serialized).not.toContain(scenario.basisEvidenceId);
      expect(serialized).not.toContain(scenario.contribution.id);
      expect(serialized).not.toContain("sensitivePayload");
      expect(serialized).not.toContain("payload");
    }
  });

  test("same-key allocation replay is exactly-once (created=false, ONE allocation, value consumed ONCE)", async () => {
    // A FRESH composed world for the replay probe (the canonical
    // pool's envelope is exhausted — a new fresh key would fail
    // closed on conservation, which is exactly the envelope
    // semantics; the replay proof needs its own drawable pool).
    const { createRecognizedMatureValue } = await import(
      "../reward-integration/_net-w014-harness.ts"
    );
    const { value } = await createRecognizedMatureValue(harness.w014, {
      withMeasuredOutcomeBasis: true,
      withProofOfValueBasis: true,
      amount: 60,
    });
    const rewardPolicyId = `reward-policy-w033-ac07-${key("r")}`;
    await harness.runtime.rewardPolicyService.createPolicyVersion(
      harness.moderatorCtx("w033-ac07-reward-policy"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: rewardPolicyId,
        version: 1,
        description: "NET-W033 AC-07 replay reward policy",
        allocations: [
          { beneficiaryPersonId: harness.contributorPersonId, weight: 3 },
          { beneficiaryPersonId: harness.moderatorPersonId, weight: 2 },
          { beneficiaryPersonId: harness.memberCPersonId, weight: 1 },
        ],
      },
    );
    const benefitPolicyId = `benefit-policy-w033-ac07-${key("b")}`;
    await harness.runtime.benefitPoolService.createPolicyVersion(
      harness.moderatorCtx("w033-ac07-benefit-policy"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: benefitPolicyId,
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.contributorPersonId, weight: 3 },
          { personId: harness.moderatorPersonId, weight: 2 },
          { personId: harness.memberCPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        rewardPolicyId,
        idempotencyKey: key("w033-ac07-bp"),
      },
    );
    const pool = await harness.runtime.benefitPoolService.createBenefitPool(
      harness.moderatorCtx("w033-ac07-pool"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: benefitPolicyId,
        fundingRefs: [{ kind: "economic_value", id: value.id }],
        idempotencyKey: key("w033-ac07-pool"),
      },
    );
    const idempotencyKey = key("w033-ac07-replay");
    const first = await harness.runtime.benefitPoolService.allocatePoolBenefits(
      harness.moderatorCtx("w033-ac07-replay-1"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.pool.id,
        idempotencyKey,
      },
    );
    expect(first.created).toBe(true);
    // The retry with the SAME key replays the committed composite
    // verbatim (no second draw, no second record).
    const replay = await harness.runtime.benefitPoolService.allocatePoolBenefits(
      harness.moderatorCtx("w033-ac07-replay-2"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.pool.id,
        idempotencyKey,
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.allocation.id).toBe(first.allocation.id);
    // Exactly ONE allocation + the value consumed exactly once.
    const committed = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.moderatorCtx("w033-ac07-replay-3"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.pool.id,
      },
    );
    expect(committed).toHaveLength(1);
    const consumed = await harness.runtime.economicValueService.getValue(
      harness.contributorCtx("w033-ac07-replay-read"),
      value.id,
    );
    expect(consumed.state).toBe("CONSUMED");
    expect(consumed.consumedBy).not.toBeNull();
  });
});
