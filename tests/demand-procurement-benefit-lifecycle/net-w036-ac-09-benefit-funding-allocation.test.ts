/**
 * NET-W036 AC-09 — Benefit funding and allocation (work order §5 AC-09 +
 * §3.4 + §4 invariant 9): W028 consumes AUTHORITATIVE funded value by
 * reference; the eligibility/allocation derivation is deterministic;
 * the allocation can never exceed the funded source; the remainder and
 * the conservation arithmetic are explicit; and no private
 * supplier/buyer detail crosses the member views — `/benefits` never
 * becomes a second ledger (the economic draw executes through the
 * EXISTING /settlement reward-allocation primitive on the pool
 * allocation's own authoritative transaction).
 *
 * The suite runs the canonical scenario ONCE (stages 1–14 — the pool →
 * … → the verified savings → the PoV → the risk/dispute-gated
 * maturation; the benefit stages are skipped so the MATURE value
 * record stays unconsumed for THIS suite's own funding fixtures) and
 * then exercises the W028 boundary over the scenario's authoritative
 * records: the value-funded draw pool (weights 3/2/1, the mirrored
 * reward policy), the W028 funding fail-closed reason vocabulary
 * (PENDING / CONSUMED / nonexistent / cross-scope / reversed), the
 * caller-supplied-amount impossibility, the server-derived eligibility
 * (a revoked member fails the allocation closed — the conservative
 * REAL semantics, never a re-split), the explicit retained remainder
 * arithmetic, the savings-funded entitlement-only allocation (draw
 * null; NO postings) with the one-way baseline invalidation closing
 * the CURRENT re-derivation, and the member-view privacy.
 *
 * Mutation targets covered (ledger §4):
 *  - fund from caller-supplied value → there is NO amount input on a
 *    funded pool; an explicit draw amount is rejected outright
 *    (BENEFITS_VALIDATION) and the allocation total is ALWAYS the
 *    in-tx re-derived authoritative record amount;
 *  - allocate beyond the funded amount → the in-tx conservation check
 *    + the exactly-once consumption backstop;
 *  - bypass eligibility → the eligibility re-derivation is in-tx and
 *    server-side (an inactive declared member fails the whole
 *    allocation closed);
 *  - collapse privacy dimensions → the member view carries ONLY the
 *    member's own shares + the sanctioned totals;
 *  - write economic state outside settlement → the savings-funded
 *    allocation posts NOTHING (ledger unchanged), the economic draw
 *    runs through the settlement primitive, and stale savings
 *    snapshots cannot authorize new effects after the one-way
 *    invalidation.
 *
 * DEVIATION OF RECORD (the brief's "drops out of the plan" wording):
 * the REAL source semantics of a revoked declared member is NOT a
 * re-split among the remaining members — `deriveEligibility` returns
 * eligible:false and `applyAllocation` fails the whole allocation
 * closed (BENEFITS_VALIDATION, the inactive member ids named). The
 * suite proves the REAL fail-closed rule (the conservative behavior).
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac09-…`),
 * the scenario/harness anchors only — NO wall-clock read, NO random
 * id in this file (the code-token self-pins at the end prove it).
 * ONE harness per file.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW036Harness,
  runW036Scenario,
  personCtx,
  W036_EVIDENCE_CAPTURED_AT,
  type NetW036Harness,
  type W036Scenario,
} from "./_net-w036-harness.ts";
import {
  assertGlobalConservation,
  createMatureValue,
  createPendingValue,
} from "../settlement/_net-w008-harness.ts";
import { toEconomicMinorUnits } from "../../src/core/economics.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import type { OpenConError } from "../../src/core/errors.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  BenefitPool,
  BenefitPoolAllocation,
  BenefitPoolAllocationView,
} from "../../src/benefits/port.ts";
import type { EconomicLedgerEntry } from "../../src/settlement/port.ts";

let harness: NetW036Harness;
let scenario: W036Scenario;

// The AC-09 value-funded draw fixtures (built in test 1, consumed by
// the later proofs — the AC-07 canonicalPov pattern).
let drawPool: BenefitPool;
let drawAllocation: BenefitPoolAllocation;
let drawView: BenefitPoolAllocationView;

beforeAll(async () => {
  harness = await createNetW036Harness();
  // The canonical chain through the risk/dispute-gated maturation;
  // the benefit stages are skipped so the MATURE value record stays
  // unconsumed for this suite's OWN funding-by-reference fixtures.
  scenario = await runW036Scenario(harness, {
    skipBenefitAllocation: true,
  });
}, 240_000);

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Catch an expected service error and return it (null when none). */
async function expectRejection(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

/** Σ amount (scaled minor units) over one direction of an entry set. */
function sumMinor(
  entries: readonly EconomicLedgerEntry[],
  direction: "debit" | "credit",
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.direction === direction) {
      total += toEconomicMinorUnits(entry.amount);
    }
  }
  return total;
}

/** The committed economic ledger entry count (the no-posting proof). */
async function ledgerEntryCount(): Promise<number> {
  return (await harness.runtime.postgresAuthority.scan("economic_ledger_entries"))
    .length;
}

// ---------------------------------------------------------------------------
// The AC-09 proofs
// ---------------------------------------------------------------------------

describe("NET-W036-AC-09 benefit funding and allocation", () => {
  test("VALUE-FUNDED ALLOCATION: funding by REFERENCE to the MATURE value, the deterministic 3/2/1 plan, the REAL settlement draw in the same authoritative transaction, exactly-once consumption, conservation, and the same-key replay", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac09-allocate");

    // (a) The canonical benefit composition (the harness stage-15
    //     shape with this suite's fixed keys): the /settlement reward
    //     policy mirroring the three buyers at weights 3/2/1, the
    //     /benefits allocation policy (credits, active_membership,
    //     last_member_absorbs, the mirrored reward policy), and the
    //     pool funded BY REFERENCE to the scenario's MATURE value
    //     record (funding refs only — never amounts).
    await runtime.rewardPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: scope,
      policyId: "w036-ac09-reward-policy",
      version: 1,
      description: "NET-W036 AC-09 reward policy (mirrors the benefits policy)",
      allocations: [
        { beneficiaryPersonId: harness.buyerAPersonId, weight: 3 },
        { beneficiaryPersonId: harness.buyerBPersonId, weight: 2 },
        { beneficiaryPersonId: harness.buyerCPersonId, weight: 1 },
      ],
    });
    const policy = (
      await runtime.benefitPoolService.createPolicyVersion(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac09-benefit-policy",
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.buyerAPersonId, weight: 3 },
          { personId: harness.buyerBPersonId, weight: 2 },
          { personId: harness.buyerCPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        rewardPolicyId: "w036-ac09-reward-policy",
        idempotencyKey: "w036-ac09-benefit-policy",
      })
    ).policy;
    expect(policy.version).toBe(1);
    expect(policy.memberDeclarations.map((m) => m.weight)).toEqual([3, 2, 1]);
    drawPool = (
      await runtime.benefitPoolService.createBenefitPool(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac09-benefit-policy",
        fundingRefs: [
          { kind: "economic_value", id: scenario.maturedValue.id },
        ],
        idempotencyKey: "w036-ac09-benefit-pool",
      })
    ).pool;
    expect(drawPool.fundingRefs).toEqual([
      { kind: "economic_value", id: scenario.maturedValue.id },
    ]);
    expect(drawPool.policyVersion).toBe(1);

    // (b) The derived plan preview (evaluate): eligible, the draw
    //     flagged, the deterministic shares, the REPRODUCIBLE digest.
    drawView = await runtime.benefitPoolService.evaluatePoolAllocation(
      ctx,
      { organizationScopeId: scope, poolId: drawPool.id },
    );
    const drawViewReplay =
      await runtime.benefitPoolService.evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: drawPool.id,
      });
    expect(drawView.eligible).toBe(true);
    expect(drawView.checks.map((c) => [c.check, c.satisfied])).toEqual([
      ["pool_active", true],
      ["policy_version_pinned", true],
      ["funding_qualified", true],
      ["funding_available", true],
      ["members_eligible", true],
      ["draw_policy_consistent", true],
      ["conservation_preserved", true],
    ]);
    expect(drawView.funding[0]).toMatchObject({
      kind: "economic_value",
      id: scenario.maturedValue.id,
      qualified: true,
      resolvedAmount: 120,
      reason: null,
    });
    expect(drawView.availableFunding).toBe(120);
    expect(drawView.priorAllocatedTotal).toBe(0);
    expect(drawView.plan).not.toBeNull();
    expect(drawView.plan!.draw).toBe(true);
    expect(drawView.plan!.amount).toBe(120);
    expect(
      drawView.plan!.shares.map((s) => [s.personId, s.amount]),
    ).toEqual([
      [harness.buyerAPersonId, 60],
      [harness.buyerBPersonId, 40],
      [harness.buyerCPersonId, 20],
    ]);
    expect(drawView.plan!.totalAllocated).toBe(120);
    expect(drawView.plan!.remainderAmount).toBe(0);
    expect(drawView.digest).toBe(drawViewReplay.digest);
    expect(drawView.digest).not.toBeNull();

    // (c) The atomic allocation: the deterministic plan + the REAL
    //     economic draw through the reward policy.
    const entriesBefore = await ledgerEntryCount();
    const result = await runtime.benefitPoolService.allocatePoolBenefits(
      ctx,
      {
        organizationScopeId: scope,
        poolId: drawPool.id,
        idempotencyKey: "w036-ac09-allocation",
      },
    );
    expect(result.created).toBe(true);
    drawAllocation = result.allocation;
    expect(drawAllocation.status).toBe("recorded");
    expect(drawAllocation.policyId).toBe("w036-ac09-benefit-policy");
    expect(drawAllocation.policyVersion).toBe(1);
    expect(drawAllocation.benefitType).toBe("credits");
    expect(drawAllocation.funding).toEqual([
      { kind: "economic_value", id: scenario.maturedValue.id, resolvedAmount: 120 },
    ]);
    // Σ member shares === the funded amount EXACTLY (scaled
    // minor-unit arithmetic — the exact 3/2/1 shares over 120).
    expect(
      drawAllocation.shares.map((s) => [s.personId, s.amount]),
    ).toEqual([
      [harness.buyerAPersonId, 60],
      [harness.buyerBPersonId, 40],
      [harness.buyerCPersonId, 20],
    ]);
    const scaledTotal = drawAllocation.shares.reduce(
      (sum, s) => sum + toEconomicMinorUnits(s.amount),
      0,
    );
    expect(scaledTotal).toBe(120_000_000);
    expect(drawAllocation.totalAllocated).toBe(120);
    expect(drawAllocation.remainderAmount).toBe(0);
    expect(drawAllocation.remainderDisposition).toBe("last_member_absorbs");
    expect(drawAllocation.availableFunding).toBe(120);
    expect(drawAllocation.priorAllocatedTotal).toBe(0);
    expect(drawAllocation.digest).toBe(drawView.digest!);
    expect(drawAllocation.members.map((m) => m.weight)).toEqual([3, 2, 1]);

    // (d) The REAL economic draw: reward records + BALANCED ledger
    //     postings through the settlement reward policy — the draw's
    //     transaction posts debit mature_value(source holder) +
    //     credit rewards(beneficiary_i) and is lineage-bound to the
    //     pool allocation (the same authoritative commit).
    expect(drawAllocation.draw).not.toBeNull();
    const draw = drawAllocation.draw!;
    const drawTx = await runtime.economicLedgerService.getTransaction(
      ctx,
      draw.transactionId,
    );
    expect(drawTx.kind).toBe("reward_allocation");
    expect(drawTx.subject).toEqual({ kind: "reward_allocation", id: draw.resultId });
    expect(drawTx.entries).toHaveLength(4);
    expect(
      drawTx.entries.filter((e) => e.direction === "debit").map((e) => [
        e.accountKind,
        e.ownerPersonId,
        e.amount,
      ]),
    ).toEqual([["mature_value", harness.poolCreatorPersonId, 120]]);
    expect(
      drawTx.entries
        .filter((e) => e.direction === "credit")
        .map((e) => [e.accountKind, e.ownerPersonId, e.amount]),
    ).toEqual([
      ["rewards", harness.buyerAPersonId, 60],
      ["rewards", harness.buyerBPersonId, 40],
      ["rewards", harness.buyerCPersonId, 20],
    ]);
    expect(sumMinor(drawTx.entries, "debit")).toBe(
      sumMinor(drawTx.entries, "credit"),
    );
    expect(sumMinor(drawTx.entries, "debit")).toBe(120_000_000);
    // The reward record + the pool allocation committed as ONE
    // authoritative unit (the shared ledger-transaction lineage).
    const rewardEvents = await runtime.auditWriter.query({
      eventType: "reward_allocation.recorded",
      resourceId: draw.resultId,
    });
    expect(rewardEvents).toHaveLength(1);
    const rewardMetadata = rewardEvents[0]!.metadata as Record<
      string,
      unknown
    >;
    expect(rewardMetadata["ledgerTransactionId"]).toBe(draw.transactionId);
    expect(rewardMetadata["sourceValueRecordId"]).toBe(
      scenario.maturedValue.id,
    );
    expect(rewardMetadata["policyId"]).toBe("w036-ac09-reward-policy");
    expect(rewardMetadata["sourceValueAmount"]).toBe(120);
    // Exactly ONE benefits_pool.allocation_recorded audit event, with
    // the draw lineage + conservation facts.
    const allocationEvents = await runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
      resourceId: drawAllocation.id,
    });
    expect(allocationEvents).toHaveLength(1);
    const allocationMetadata = allocationEvents[0]!.metadata as Record<
      string,
      unknown
    >;
    expect(Object.keys(allocationMetadata).sort()).toEqual([
      "availableFunding",
      "benefitType",
      "derivationPolicy",
      "drawResultId",
      "drawTransactionId",
      "idempotencyRecordId",
      "organizationScopeId",
      "policyId",
      "policyVersion",
      "poolId",
      "priorAllocatedTotal",
      "remainderAmount",
      "remainderDisposition",
      "totalAllocated",
      "transactionId",
    ]);
    expect(allocationMetadata["drawResultId"]).toBe(draw.resultId);
    expect(allocationMetadata["drawTransactionId"]).toBe(draw.transactionId);
    expect(allocationMetadata["derivationPolicy"]).toEqual({
      version: 1,
      method: "proportional-weights-scaled-floor",
    });
    expect(allocationMetadata["totalAllocated"]).toBe(120);
    expect(allocationMetadata["remainderAmount"]).toBe(0);

    // (e) The value record is CONSUMED exactly-once by the draw.
    const consumed = await runtime.economicValueService.getValue(
      ctx,
      scenario.maturedValue.id,
    );
    expect(consumed.state).toBe("CONSUMED");
    expect(consumed.version).toBe(scenario.maturedValue.version + 1);
    expect(consumed.consumedBy).toEqual({
      kind: "reward_allocation",
      id: draw.resultId,
    });

    // (f) GLOBAL CONSERVATION still holds (the draw posted balanced
    //     entries; /benefits created no parallel ledger).
    await assertGlobalConservation(harness.w008);
    expect(await ledgerEntryCount()).toBeGreaterThan(entriesBefore);

    // (g) The same-key replay: created:false, the IDENTICAL
    //     allocation, and the draw is NOT repeated (one reward
    //     record, one allocation lineage record, no new entries).
    const entriesAtReplay = await ledgerEntryCount();
    const replay = await runtime.benefitPoolService.allocatePoolBenefits(
      ctx,
      {
        organizationScopeId: scope,
        poolId: drawPool.id,
        idempotencyKey: "w036-ac09-allocation",
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.allocation).toEqual(drawAllocation);
    expect(await ledgerEntryCount()).toBe(entriesAtReplay);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "reward_allocation.recorded",
          resourceId: draw.resultId,
        })
      ).length,
    ).toBe(1);
    const poolAllocations =
      await runtime.benefitPoolService.listPoolAllocations(ctx, {
        organizationScopeId: scope,
        poolId: drawPool.id,
      });
    expect(poolAllocations).toHaveLength(1);
    expect(poolAllocations[0]!.id).toBe(drawAllocation.id);
  }, 180_000);

  test("FUNDING FAIL-CLOSED (the W028 reason vocabulary through the real APIs): PENDING, CONSUMED, nonexistent, cross-scope and reversed references all fail closed — with NO partial allocation state", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac09-funding");

    const allocationAuditBefore = (
      await runtime.auditWriter.query({
        eventType: "benefits_pool.allocation_recorded",
      })
    ).length;
    const rewardAuditBefore = (
      await runtime.auditWriter.query({
        eventType: "reward_allocation.recorded",
      })
    ).length;

    // The shared negative policy (mirrors the reward policy so the
    // draw PRECONDITIONS pass and the FUNDING gate itself surfaces).
    await runtime.benefitPoolService.createPolicyVersion(ctx, {
      organizationScopeId: scope,
      policyId: "w036-ac09-policy-negative",
      version: 1,
      benefitType: "credits",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations: [
        { personId: harness.buyerAPersonId, weight: 3 },
        { personId: harness.buyerBPersonId, weight: 2 },
        { personId: harness.buyerCPersonId, weight: 1 },
      ],
      remainderDisposition: "last_member_absorbs",
      rewardPolicyId: "w036-ac09-reward-policy",
      idempotencyKey: "w036-ac09-policy-negative",
    });

    /** One negative funding pool + its derived reason + the refusal. */
    const negativePool = async (
      poolKey: string,
      valueRef: { kind: string; id: string },
    ): Promise<BenefitPool> => {
      return (
        await runtime.benefitPoolService.createBenefitPool(ctx, {
          organizationScopeId: scope,
          policyId: "w036-ac09-policy-negative",
          fundingRefs: [valueRef],
          idempotencyKey: poolKey,
        })
      ).pool;
    };

    // (a) A PENDING (unmatured) value record: pending value is not
    //     consumable (architecture-lock invariant 19).
    const pendingValue = await createPendingValue(harness.w008, {
      maturation: {
        strategy: "fixed_window",
        windowEndAt: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(pendingValue.state).toBe("PENDING");
    const pendingPool = await negativePool("w036-ac09-pool-pending", {
      kind: "economic_value",
      id: pendingValue.id,
    });
    const pendingView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: pendingPool.id,
      });
    expect(pendingView.eligible).toBe(false);
    expect(pendingView.funding[0]!.qualified).toBe(false);
    expect(pendingView.funding[0]!.resolvedAmount).toBeNull();
    expect(pendingView.funding[0]!.reason).toMatch(
      /value record state PENDING is not MATURE/,
    );
    expect(pendingView.plan).toBeNull();
    const pendingError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: pendingPool.id,
        idempotencyKey: "w036-ac09-allocate-pending",
      }),
    );
    expect(pendingError).toBeInstanceOf(Error);
    expect((pendingError as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((pendingError as OpenConError).message).toMatch(/not qualified/);
    expect((pendingError as OpenConError).message).toMatch(
      /is not MATURE \(pending value is not consumable/,
    );
    // The PENDING record was untouched.
    expect(
      (await runtime.economicValueService.getValue(ctx, pendingValue.id))
        .state,
    ).toBe("PENDING");

    // (b) An ALREADY-CONSUMED value record: exactly-once consumption
    //     is the backstop (the scenario's value was consumed by the
    //     draw in the previous test) — a NEW pool over the same
    //     record cannot fund again, and neither can the SAME pool
    //     under a NEW key.
    const consumedPool = await negativePool("w036-ac09-pool-consumed", {
      kind: "economic_value",
      id: scenario.maturedValue.id,
    });
    const consumedView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: consumedPool.id,
      });
    expect(consumedView.eligible).toBe(false);
    expect(consumedView.funding[0]!.reason).toBe(
      "value record already consumed exactly-once",
    );
    const consumedError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: consumedPool.id,
        idempotencyKey: "w036-ac09-allocate-consumed",
      }),
    );
    expect((consumedError as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((consumedError as OpenConError).message).toMatch(
      /already consumed exactly-once/,
    );
    const samePoolError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: drawPool.id,
        idempotencyKey: "w036-ac09-allocate-consumed-again",
      }),
    );
    expect((samePoolError as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((samePoolError as OpenConError).message).toMatch(
      /already consumed exactly-once/,
    );

    // (c) A NONEXISTENT value-record id: no existence oracle — the
    //     derived reason is "value record not found" and the command
    //     fails as a scoped NotFound.
    const unknownPool = await negativePool("w036-ac09-pool-unknown", {
      kind: "economic_value",
      id: "w036-ac09-no-such-value-record",
    });
    const unknownView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: unknownPool.id,
      });
    expect(unknownView.eligible).toBe(false);
    expect(unknownView.funding[0]!.reason).toBe("value record not found");
    const unknownError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: unknownPool.id,
        idempotencyKey: "w036-ac09-allocate-unknown",
      }),
    );
    expect(unknownError).toBeInstanceOf(NotFoundError);
    expect((unknownError as OpenConError).message).toMatch(
      /not found in scope/,
    );

    // (d) A CROSS-SCOPE value record: a real value record minted in a
    //     SECOND organization (through the real /evidence +
    //     /settlement APIs — a platform-evidence source in that scope)
    //     can never fund a pool in this scope.
    const otherOrg = await runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "W036 AC-09 Foreign Org", creatorId: "bootstrap" },
    );
    const foreignEvidence = await runtime.evidenceService.createEvidence(
      personCtx(harness, harness.poolCreatorPersonId, "w036-ac09-foreign"),
      {
        organizationScopeId: otherOrg.id,
        ownerId: harness.poolCreatorPersonId,
        subjectReference: {
          subjectId: "w036-ac09-foreign-pool",
          subjectType: "procurement_pool",
        },
        provenance: {
          sourceType: "platform",
          sourceId: "w036-ac09-foreign-spend-ledger",
          method: "historical-spend-report",
          collectedAt: W036_EVIDENCE_CAPTURED_AT,
        },
        confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
        sensitivity: "standard",
        payload: { kind: "spend_report", note: "W036 AC-09 foreign evidence" },
      },
    );
    const foreignValue = (
      await runtime.economicValueService.recordPendingValue(
        personCtx(harness, harness.poolCreatorPersonId, "w036-ac09-foreign-v"),
        {
          organizationScopeId: otherOrg.id,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 77,
          sources: [{ kind: "evidence", id: foreignEvidence.id }],
          idempotencyKey: "w036-ac09-foreign-value",
        },
      )
    ).value;
    expect(foreignValue.state).toBe("PENDING");
    const crossScopePool = await negativePool("w036-ac09-pool-cross-scope", {
      kind: "economic_value",
      id: foreignValue.id,
    });
    const crossScopeView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: crossScopePool.id,
      });
    expect(crossScopeView.eligible).toBe(false);
    expect(crossScopeView.funding[0]!.reason).toBe("cross-scope value record");
    const crossScopeError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: crossScopePool.id,
        idempotencyKey: "w036-ac09-allocate-cross-scope",
      }),
    );
    expect(crossScopeError).toBeInstanceOf(NotFoundError);
    expect((crossScopeError as OpenConError).message).toMatch(
      /not found in scope/,
    );

    // (e) A REVERSED value record: the append-only /settlement
    //     reversal (the real API) makes the funding fail closed.
    const reversedSource = await createMatureValue(harness.w008, {
      amount: 60,
    });
    const reversed = await runtime.economicValueService.reverseValue(ctx, {
      valueRecordId: reversedSource.id,
      reason: "W036 AC-09: the source recognition failed post-hoc review",
      idempotencyKey: "w036-ac09-reverse",
    });
    expect(reversed.state).toBe("REVERSED");
    const reversedPool = await negativePool("w036-ac09-pool-reversed", {
      kind: "economic_value",
      id: reversedSource.id,
    });
    const reversedView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: reversedPool.id,
      });
    expect(reversedView.eligible).toBe(false);
    expect(reversedView.funding[0]!.reason).toBe("value record reversed");
    const reversedError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: reversedPool.id,
        idempotencyKey: "w036-ac09-allocate-reversed",
      }),
    );
    expect((reversedError as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((reversedError as OpenConError).message).toMatch(
      /value record reversed/,
    );

    // (f) NO partial state on any refusal: no allocation lineage
    //     record, no draw, no audit — and conservation still holds
    //     (the foreign recognition + the reversal are balanced).
    for (const pool of [
      pendingPool,
      consumedPool,
      unknownPool,
      crossScopePool,
      reversedPool,
    ]) {
      const allocations =
        await runtime.benefitPoolService.listPoolAllocations(ctx, {
          organizationScopeId: scope,
          poolId: pool.id,
        });
      expect(allocations).toHaveLength(0);
    }
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "benefits_pool.allocation_recorded",
        })
      ).length,
    ).toBe(allocationAuditBefore);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "reward_allocation.recorded",
        })
      ).length,
    ).toBe(rewardAuditBefore);
    await assertGlobalConservation(harness.w008);
  }, 180_000);

  test("CALLER-SUPPLIED VALUE CANNOT FUND: an explicit amount on an economic draw is rejected outright, the draw source must be a DECLARED reference, and the allocation total is ALWAYS the authoritative record amount", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac09-caller");

    // (a) The REAL rule from source: an explicit amount on an
    //     economic draw is FORBIDDEN — the draw allocates the
    //     authoritative value record amount exactly (no partial
    //     draws, no caller arithmetic). Any caller-injected amount —
    //     equal, smaller or LARGER than the funded amount — fails
    //     closed before any mutation.
    for (const amount of [120, 50, 999]) {
      const error = await expectRejection(() =>
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: drawPool.id,
          amount,
          idempotencyKey: `w036-ac09-caller-amount-${String(amount)}`,
        }),
      );
      expect(error).toBeTruthy();
      expect((error as OpenConError).code).toBe("BENEFITS_VALIDATION");
      expect((error as OpenConError).message).toMatch(
        /an explicit amount is forbidden for economic draws/,
      );
      expect((error as OpenConError).message).toMatch(
        /no partial draws, no caller arithmetic/,
      );
    }

    // (b) The draw source must be a DECLARED economic_value funding
    //     reference of the pool — a foreign valueRecordId cannot
    //     redirect the draw.
    const redirectError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: drawPool.id,
        valueRecordId: "w036-ac09-not-a-declared-reference",
        idempotencyKey: "w036-ac09-caller-redirect",
      }),
    );
    expect(redirectError).toBeTruthy();
    expect((redirectError as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((redirectError as OpenConError).message).toMatch(
      /is not a declared economic_value funding reference/,
    );

    // (c) The structural proof: the pool record carries NO amount
    //     field at all (funding is references only — the authoritative
    //     amounts are re-derived at every use), and the committed
    //     allocation's total is EXACTLY the authoritative record
    //     amount (server-derived in-tx), never a caller figure.
    const poolJson = JSON.stringify(drawPool).toLowerCase();
    expect(poolJson).not.toContain('"amount"');
    expect(poolJson).not.toContain('"fundedamount"');
    expect(drawAllocation.totalAllocated).toBe(
      scenario.maturedValue.amount,
    );
    expect(drawAllocation.totalAllocated).toBe(120);
    expect(drawAllocation.funding[0]!.resolvedAmount).toBe(
      scenario.maturedValue.amount,
    );
    // No new allocation/draw state was created by any of the refusals.
    expect(
      (
        await runtime.benefitPoolService.listPoolAllocations(ctx, {
          organizationScopeId: scope,
          poolId: drawPool.id,
        })
      ).length,
    ).toBe(1);
  }, 120_000);

  test("ELIGIBILITY: the member set is re-derived in-tx — a declared member whose membership is revoked between policy creation and allocation fails the allocation CLOSED (the conservative real semantics); a person not in the memberDeclarations is never allocated", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac09-eligibility");

    // A DEDICATED fourth member (the W028 AC-03 precedent — a
    // dedicated person avoids disturbing the canonical buyers).
    const memberD = await runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W036 AC-09 Dedicated Member D",
        subjectReferences: [
          { subjectId: "w036-ac09-member-d@example.com", providerKind: "internal" },
        ],
      },
    );
    await runtime.membershipService.grantMembership(harness.bootstrapCtx, {
      personId: memberD.id,
      organizationId: scope,
      grantedBy: "bootstrap",
    });
    const members = [
      { personId: harness.buyerAPersonId, weight: 3 },
      { personId: harness.buyerBPersonId, weight: 2 },
      { personId: memberD.id, weight: 1 },
    ];
    // The mirrored settlement reward policy + the benefits policy.
    await runtime.rewardPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: scope,
      policyId: "w036-ac09-reward-policy-inactive",
      version: 1,
      description: "NET-W036 AC-09 inactive-member mirror reward policy",
      allocations: members.map((m) => ({
        beneficiaryPersonId: m.personId,
        weight: m.weight,
      })),
    });
    await runtime.benefitPoolService.createPolicyVersion(ctx, {
      organizationScopeId: scope,
      policyId: "w036-ac09-policy-inactive",
      version: 1,
      benefitType: "credits",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations: members,
      remainderDisposition: "last_member_absorbs",
      rewardPolicyId: "w036-ac09-reward-policy-inactive",
      idempotencyKey: "w036-ac09-policy-inactive",
    });
    const freshValue = await createMatureValue(harness.w008, { amount: 90 });
    const inactivePool = (
      await runtime.benefitPoolService.createBenefitPool(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac09-policy-inactive",
        fundingRefs: [{ kind: "economic_value", id: freshValue.id }],
        idempotencyKey: "w036-ac09-pool-inactive",
      })
    ).pool;

    // Sanity: with D ACTIVE the derivation is eligible.
    const activeView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: inactivePool.id,
      });
    expect(activeView.eligible).toBe(true);
    expect(activeView.plan).not.toBeNull();
    expect(activeView.plan!.shares.map((s) => s.personId)).toEqual(
      members.map((m) => m.personId),
    );

    // Revoke D's membership (the authoritative participant input
    // changes BETWEEN policy creation and the allocation).
    const memberships = await runtime.membershipService.listForPerson(
      harness.bootstrapCtx,
      memberD.id,
    );
    const membership = memberships.find(
      (m) => m.organizationId === scope,
    )!;
    await runtime.membershipService.revokeMembership(
      harness.bootstrapCtx,
      membership.id,
      "bootstrap",
    );

    // The CURRENT re-derivation: members_eligible FALSE, D named, the
    // plan NULL — the server NEVER re-splits among the remainder.
    const revokedView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: inactivePool.id,
      });
    expect(revokedView.eligible).toBe(false);
    const eligibilityCheck = revokedView.checks.find(
      (c) => c.check === "members_eligible",
    )!;
    expect(eligibilityCheck.satisfied).toBe(false);
    expect(eligibilityCheck.detail).toMatchObject({
      memberCount: 3,
      ineligibleMemberIds: [memberD.id],
      criteria: ["active_membership"],
    });
    expect(revokedView.plan).toBeNull();

    // The allocation command fails CLOSED in-tx (after the draw
    // preconditions): the inactive member is named, eligibility is
    // server-derived, never caller-asserted.
    const error = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: inactivePool.id,
        idempotencyKey: "w036-ac09-allocate-inactive",
      }),
    );
    expect(error).toBeTruthy();
    expect((error as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((error as OpenConError).message).toMatch(/is not satisfied/);
    expect((error as OpenConError).message).toMatch(/inactive members/);
    expect((error as OpenConError).message).toMatch(
      /eligibility is server-derived, never caller-asserted/,
    );
    expect((error as OpenConError).context).toMatchObject({
      ineligibleMemberIds: [memberD.id],
    });

    // NO partial state: no allocation record, the source value stays
    // MATURE (unconsumed), no draw was recorded.
    expect(
      (
        await runtime.benefitPoolService.listPoolAllocations(ctx, {
          organizationScopeId: scope,
          poolId: inactivePool.id,
        })
      ).length,
    ).toBe(0);
    expect(
      (await runtime.economicValueService.getValue(ctx, freshValue.id)).state,
    ).toBe("MATURE");
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "reward_allocation.recorded",
        })
      ).filter((event) =>
        (event.metadata as Record<string, unknown>)[
          "sourceValueRecordId"
        ] === freshValue.id,
      ).length,
    ).toBe(0);

    // A person NOT in the policy memberDeclarations is never
    // allocated: the committed draw allocation's member set is
    // EXACTLY the declared triple (no supplier, no non-declared
    // buyer, no foreign person).
    expect(drawAllocation.members.map((m) => m.personId)).toEqual([
      harness.buyerAPersonId,
      harness.buyerBPersonId,
      harness.buyerCPersonId,
    ]);
    for (const outsider of [
      harness.supplierAPersonId,
      harness.supplierBPersonId,
      harness.supplierCPersonId,
      memberD.id,
    ]) {
      expect(drawAllocation.members.map((m) => m.personId)).not.toContain(
        outsider,
      );
      expect(drawAllocation.shares.map((s) => s.personId)).not.toContain(
        outsider,
      );
    }
  }, 180_000);

  test("REMAINDER/CONSERVATION: a retained_in_pool plan over an amount that does not divide evenly carries an EXPLICIT remainder — Σ shares + remainder === the amount EXACTLY (scaled-integer arithmetic)", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac09-remainder");

    // A savings-funded entitlement pool with retained_in_pool (the
    // disposition for which the remainder stays EXPLICIT — the
    // scenario's recorded 120-usd savings is the envelope).
    await runtime.benefitPoolService.createPolicyVersion(ctx, {
      organizationScopeId: scope,
      policyId: "w036-ac09-policy-retained",
      version: 1,
      benefitType: "rebate",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations: [
        { personId: harness.buyerAPersonId, weight: 3 },
        { personId: harness.buyerBPersonId, weight: 2 },
        { personId: harness.buyerCPersonId, weight: 1 },
      ],
      remainderDisposition: "retained_in_pool",
      idempotencyKey: "w036-ac09-policy-retained",
    });
    const retainedPool = (
      await runtime.benefitPoolService.createBenefitPool(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac09-policy-retained",
        fundingRefs: [{ kind: "verified_savings", id: scenario.savings.id }],
        idempotencyKey: "w036-ac09-pool-retained",
      })
    ).pool;

    // 100 over 3/2/1 does NOT divide evenly: the floored shares are
    // 50 / 33.333333 / 16.666666 (Σ 99.999999) and the 1-minor-unit
    // remainder is EXPLICIT — conserved in the envelope, never lost,
    // never silently redistributed.
    const result = await runtime.benefitPoolService.allocatePoolBenefits(
      ctx,
      {
        organizationScopeId: scope,
        poolId: retainedPool.id,
        amount: 100,
        idempotencyKey: "w036-ac09-allocation-retained",
      },
    );
    const allocation = result.allocation;
    expect(allocation.shares.map((s) => s.amount)).toEqual([
      50, 33.333333, 16.666666,
    ]);
    expect(allocation.totalAllocated).toBe(99.999999);
    expect(allocation.remainderAmount).toBe(0.000001);
    expect(allocation.remainderDisposition).toBe("retained_in_pool");
    // Σ shares + remainder === 100 EXACTLY at scaled-integer
    // precision (the ECONOMIC_SCALE discipline — no drift).
    const conservedScaled =
      allocation.shares.reduce(
        (sum, s) => sum + toEconomicMinorUnits(s.amount),
        0,
      ) + toEconomicMinorUnits(allocation.remainderAmount);
    expect(conservedScaled).toBe(100_000_000);
    // The envelope still holds the conserved remainder: 120 −
    // 99.999999 = 20.000001 remains available (the remainder never
    // left the pool's funding envelope).
    const view = await runtime.benefitPoolService.evaluatePoolAllocation(
      ctx,
      { organizationScopeId: scope, poolId: retainedPool.id },
    );
    expect(view.availableFunding).toBe(120);
    expect(view.priorAllocatedTotal).toBe(99.999999);
    expect(
      toEconomicMinorUnits(view.availableFunding) -
        toEconomicMinorUnits(view.priorAllocatedTotal),
    ).toBe(20_000_001);
    // The conservation check on the derived view stays satisfied
    // with the explicit conservation facts (the preview's own plan
    // facts + the committed prior total).
    const conservationCheck = view.checks.find(
      (c) => c.check === "conservation_preserved",
    )!;
    expect(conservationCheck.satisfied).toBe(true);
    expect(conservationCheck.detail).toMatchObject({
      priorAllocatedTotal: 99.999999,
      availableFunding: 120,
    });
    // Entitlement-only: NOTHING posted (the retained disposition has
    // no drawable economic value — the proof is the next test's
    // no-posting invariant).
    expect(allocation.draw).toBeNull();
  }, 120_000);

  test("SAVINGS-FUNDED POOL: the allocation is entitlement-ONLY (draw null, ZERO new ledger postings, conservation unchanged); the one-way baseline invalidation makes the CURRENT savings re-derivation fail closed — stale economic snapshots cannot authorize new effects", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac09-savings");

    // (a) The savings-funded entitlement pool (last_member_absorbs —
    //     the deterministic split; no reward policy: there is no
    //     drawable economic value behind a savings claim).
    await runtime.benefitPoolService.createPolicyVersion(ctx, {
      organizationScopeId: scope,
      policyId: "w036-ac09-policy-savings",
      version: 1,
      benefitType: "rebate",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations: [
        { personId: harness.buyerAPersonId, weight: 3 },
        { personId: harness.buyerBPersonId, weight: 2 },
        { personId: harness.buyerCPersonId, weight: 1 },
      ],
      remainderDisposition: "last_member_absorbs",
      idempotencyKey: "w036-ac09-policy-savings",
    });
    const savingsPool = (
      await runtime.benefitPoolService.createBenefitPool(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac09-policy-savings",
        fundingRefs: [{ kind: "verified_savings", id: scenario.savings.id }],
        idempotencyKey: "w036-ac09-pool-savings",
      })
    ).pool;

    // (b) The CURRENT funding re-derivation is supported (120 usd).
    const view = await runtime.benefitPoolService.evaluatePoolAllocation(
      ctx,
      { organizationScopeId: scope, poolId: savingsPool.id },
    );
    expect(view.eligible).toBe(true);
    expect(view.funding[0]!).toMatchObject({
      kind: "verified_savings",
      id: scenario.savings.id,
      qualified: true,
      resolvedAmount: 120,
      reason: null,
    });

    // (c) The entitlement allocation: draw null and NO new ledger
    //     postings — conservation is UNCHANGED (the entry count is
    //     byte-identical before/after; nothing economic happened).
    const entriesBefore = await ledgerEntryCount();
    const result = await runtime.benefitPoolService.allocatePoolBenefits(
      ctx,
      {
        organizationScopeId: scope,
        poolId: savingsPool.id,
        idempotencyKey: "w036-ac09-allocation-savings",
      },
    );
    const allocation = result.allocation;
    expect(allocation.draw).toBeNull();
    expect(allocation.totalAllocated).toBe(120);
    expect(allocation.shares.map((s) => s.amount)).toEqual([60, 40, 20]);
    expect(allocation.remainderAmount).toBe(0);
    expect(await ledgerEntryCount()).toBe(entriesBefore);
    await assertGlobalConservation(harness.w008);

    // (d) The ONE-WAY baseline invalidation (the real W027 API): the
    //     recorded savings snapshot's CURRENT re-derivation no longer
    //     supports the claim — a NEW savings-funded allocation over
    //     that savings id fails closed (funding fails closed; a stale
    //     economic snapshot cannot authorize new effects).
    await runtime.procurementSavingsService.invalidateProcurementBaseline(
      ctx,
      {
        organizationScopeId: scope,
        baselineId: scenario.baseline.id,
        reason: "method_superseded",
        idempotencyKey: "w036-ac09-invalidate",
      },
    );
    const stalePool = (
      await runtime.benefitPoolService.createBenefitPool(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac09-policy-savings",
        fundingRefs: [{ kind: "verified_savings", id: scenario.savings.id }],
        idempotencyKey: "w036-ac09-pool-savings-stale",
      })
    ).pool;
    const staleView = await runtime.benefitPoolService
      .evaluatePoolAllocation(ctx, {
        organizationScopeId: scope,
        poolId: stalePool.id,
      });
    expect(staleView.eligible).toBe(false);
    expect(staleView.funding[0]!.qualified).toBe(false);
    expect(staleView.funding[0]!.resolvedAmount).toBeNull();
    expect(staleView.funding[0]!.reason).toMatch(
      /current savings re-derivation is not supported/,
    );
    expect(staleView.plan).toBeNull();
    const staleError = await expectRejection(() =>
      runtime.benefitPoolService.allocatePoolBenefits(ctx, {
        organizationScopeId: scope,
        poolId: stalePool.id,
        idempotencyKey: "w036-ac09-allocate-stale",
      }),
    );
    expect(staleError).toBeTruthy();
    expect((staleError as OpenConError).code).toBe("BENEFITS_VALIDATION");
    expect((staleError as OpenConError).message).toMatch(/not qualified/);
    expect((staleError as OpenConError).message).toMatch(
      /CURRENT savings re-derivation is not supported/,
    );
    // NO partial state: no allocation for the stale pool, and still
    // ZERO new ledger postings after the refusal.
    expect(
      (
        await runtime.benefitPoolService.listPoolAllocations(ctx, {
          organizationScopeId: scope,
          poolId: stalePool.id,
        })
      ).length,
    ).toBe(0);
    expect(await ledgerEntryCount()).toBe(entriesBefore);
    await assertGlobalConservation(harness.w008);
  }, 180_000);

  test("PRIVACY: getMemberBenefitView exposes ONLY the member's own share and the sanctioned totals (no other members' shares/weights, no supplier or buyer-organization identity); the allocation record leaks no commercial detail beyond the sanctioned member set", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;

    // (a) Each canonical member sees ONLY their own share: 60 / 40 /
    //     20 over the committed draw allocation, with the pool total
    //     as the single aggregate.
    const views: readonly [
      string,
      ExecutionContext,
      number,
    ][] = [
      ["buyerA", harness.poolCreatorCtx("w036-ac09-view-a"), 60],
      ["buyerB", harness.buyerBCtx("w036-ac09-view-b"), 40],
      ["buyerC", harness.buyerCCtx("w036-ac09-view-c"), 20],
    ];
    const otherMembers = (self: string): readonly string[] =>
      views
        .filter(([label]) => label !== self)
        .map(([label]) =>
          label === "buyerA"
            ? harness.buyerAPersonId
            : label === "buyerB"
              ? harness.buyerBPersonId
              : harness.buyerCPersonId,
        );
    for (const [label, ctx, ownAmount] of views) {
      const view = await runtime.benefitPoolService.getMemberBenefitView(
        ctx,
        { organizationScopeId: scope, poolId: drawPool.id },
      );
      expect(view.ownShares).toHaveLength(1);
      expect(view.ownShares[0]!.allocationId).toBe(drawAllocation.id);
      expect(view.ownShares[0]!.amount).toBe(ownAmount);
      expect(view.ownTotal).toBe(ownAmount);
      expect(view.poolTotalAllocated).toBe(120);
      expect(view.policyId).toBe("w036-ac09-benefit-policy");
      expect(view.policyVersion).toBe(1);
      expect(view.benefitType).toBe("credits");
      // The EXACT sanctioned view shape (8 keys — no weights, no
      // fundingRefs, no member set).
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
      // PRIVACY: no OTHER member's identity, weight or share amount
      // ever crosses; no supplier identity, no buyer-organization
      // identity, no commercial vocabulary.
      const serialized = JSON.stringify(view);
      for (const otherId of otherMembers(label)) {
        expect(serialized).not.toContain(otherId);
      }
      expect(serialized).not.toMatch(/"weight"/i);
      expect(serialized).not.toMatch(/funding/i);
      expect(serialized).not.toMatch(/members/i);
      for (const forbidden of [
        harness.supplierAPersonId,
        harness.supplierBPersonId,
        harness.supplierCPersonId,
        harness.buyerOrgAId,
        harness.buyerOrgBId,
        harness.buyerOrgCId,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      for (const commercial of ["price_", "band_", "NA_EAST", "budget"]) {
        expect(serialized.toLowerCase()).not.toContain(
          commercial.toLowerCase(),
        );
      }
    }

    // (b) A NON-DECLARED active member (supplier B — an active tenant
    //     member absent from the memberDeclarations) is never
    //     allocated: the own-shares set is EMPTY and the own total 0
    //     (only the sanctioned pool aggregate is visible).
    const outsiderView =
      await runtime.benefitPoolService.getMemberBenefitView(
        harness.supplierBCtx("w036-ac09-view-outsider"),
        { organizationScopeId: scope, poolId: drawPool.id },
      );
    expect(outsiderView.ownShares).toEqual([]);
    expect(outsiderView.ownTotal).toBe(0);
    expect(outsiderView.poolTotalAllocated).toBe(120);

    // (c) The ALLOCATION view (the pool-creator lineage surface)
    //     leaks no commercial detail beyond the sanctioned member
    //     set: the members + shares + the funding-by-reference
    //     resolution (kind/id/resolvedAmount — settlement lineage
    //     ONLY), never supplier identities, buyer-organization ids,
    //     regions, price bands or budget bands.
    const allocationRecord =
      await runtime.benefitPoolService.getBenefitPoolAllocation(
        harness.poolCreatorCtx("w036-ac09-allocation-read"),
        { organizationScopeId: scope, allocationId: drawAllocation.id },
      );
    expect(allocationRecord.id).toBe(drawAllocation.id);
    const allocationJson = JSON.stringify(allocationRecord);
    for (const forbidden of [
      harness.supplierAPersonId,
      harness.supplierBPersonId,
      harness.supplierCPersonId,
      harness.buyerOrgAId,
      harness.buyerOrgBId,
      harness.buyerOrgCId,
    ]) {
      expect(allocationJson).not.toContain(forbidden);
    }
    for (const commercial of [
      "price_a_under_10",
      "price_b_10_49",
      "band_b_1k_9k",
      "NA_EAST",
      "q_100_999",
      "budgetBand",
      "unitPriceBand",
    ]) {
      expect(allocationJson).not.toContain(commercial);
    }
    // The sanctioned member set is EXACTLY the three declared buyers.
    expect(allocationRecord.members.map((m) => m.personId).sort()).toEqual(
      [
        harness.buyerAPersonId,
        harness.buyerBPersonId,
        harness.buyerCPersonId,
      ].sort(),
    );

    // (d) Determinism self-pins for THIS file (comments stripped;
    // assembled literals — the whole token never appears in code).
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .replace(/[ \t]\/\/.*$/gm, "");
    const ownCode = stripComments(
      await readFile(
        join(
          import.meta.dir,
          "net-w036-ac-09-benefit-funding-allocation.test.ts",
        ),
        "utf8",
      ),
    );
    for (const token of [
      "new " + "Date" + "(",
      "Date." + "now" + "(",
      "random" + "UUID",
    ]) {
      expect(ownCode.split(token).length - 1).toBe(0);
    }
    // Fixed-key discipline: every idempotency key in this file is a
    // fixed w036-ac09 literal (no fabricated identities).
    expect(ownCode.split('"w036-ac09-').length - 1).toBeGreaterThanOrEqual(
      20,
    );
  }, 120_000);
});
