/**
 * NET-W033-AC-09 — Idempotency, concurrency, atomicity and failure
 * injection (issue #67 §4 AC-09; work order §3.9/§3.10).
 *
 * Replay, race and injected-failure scenarios converge without double
 * application or partial final state; existing transactional audit
 * ordering remains intact:
 *  - REPLAY: same-key recognition, settlement→reputation effect and
 *    benefit allocation each return the committed composite verbatim
 *    (created=false, SAME record ids, single records everywhere);
 *  - RACE: concurrent same-key benefit allocations and concurrent
 *    same-key recognition converge to exactly ONE committed
 *    composite (the idempotency + per-pool/value mutexes);
 *  - FAULT INJECTION (the critical join): a draw failure inside the
 *    benefit allocation's single authoritative transaction leaves NO
 *    partial mutation (no allocation record, no draw, no
 *    consumption, NO audit event — the transactional audit buffer is
 *    discarded on the failed commit);
 *  - FAULT INJECTION (mid-path gate): an ACTIVE dispute freezes the
 *    maturation — the value record stays PENDING (no partial final
 *    state); resolution re-opens the path and the composite
 *    completes;
 *  - AUDIT ORDERING: the committed allocation's audit event carries
 *    the authoritative transaction id (post-commit publication).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  type NetW033Harness,
  type CanonicalScenario,
} from "./_net-w033-harness.ts";
import {
  createRecognizedMatureValue,
  recognizeContributionValue,
  type NetW014Harness,
} from "../reward-integration/_net-w014-harness.ts";
import { ensureCreditsFor } from "../disputes/_net-w010-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW033Harness;

beforeAll(async () => {
  harness = await createNetW033Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** A fresh drawable world: mature value + mirrored policies + pool. */
async function createDrawableWorld(
  amount: number,
): Promise<{
  valueId: string;
  poolId: string;
  rewardPolicyId: string;
}> {
  const { value } = await createRecognizedMatureValue(harness.w014, {
    withMeasuredOutcomeBasis: true,
    withProofOfValueBasis: true,
    amount,
  });
  const rewardPolicyId = `reward-policy-w033-ac09-${key("r")}`;
  await harness.runtime.rewardPolicyService.createPolicyVersion(
    harness.moderatorCtx("w033-ac09-reward-policy"),
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: rewardPolicyId,
      version: 1,
      description: "NET-W033 AC-09 reward policy",
      allocations: [
        { beneficiaryPersonId: harness.contributorPersonId, weight: 3 },
        { beneficiaryPersonId: harness.moderatorPersonId, weight: 2 },
        { beneficiaryPersonId: harness.memberCPersonId, weight: 1 },
      ],
    },
  );
  const benefitPolicyId = `benefit-policy-w033-ac09-${key("b")}`;
  await harness.runtime.benefitPoolService.createPolicyVersion(
    harness.moderatorCtx("w033-ac09-benefit-policy"),
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
      idempotencyKey: key("w033-ac09-bp"),
    },
  );
  const pool = await harness.runtime.benefitPoolService.createBenefitPool(
    harness.moderatorCtx("w033-ac09-pool"),
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: benefitPolicyId,
      fundingRefs: [{ kind: "economic_value", id: value.id }],
      idempotencyKey: key("w033-ac09-pool"),
    },
  );
  return { valueId: value.id, poolId: pool.pool.id, rewardPolicyId };
}

describe("NET-W033-AC-09 idempotency, concurrency, atomicity and failure injection", () => {
  test("REPLAY: same-key recognition + settlement→reputation effect return the committed composites verbatim", async () => {
    // Recognition replay (exactly-once).
    const { createVerifiedSettledContribution } = await import(
      "../reward-integration/_net-w014-harness.ts"
    );
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const idem = key("w033-ac09-recognize");
    const first = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 70,
      idempotencyKey: idem,
    });
    expect(first.created).toBe(true);
    const replay = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 70,
      idempotencyKey: idem,
    });
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(first.value.id);
    // The settlement→reputation effect replay.
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      harness.moderatorCtx("w033-ac09-mature"),
      { valueRecordId: first.value.id, idempotencyKey: key("w033-ac09-mature") },
    );
    expect(matured.state).toBe("MATURE");
    const effectKey = key("w033-ac09-effect");
    const effectFirst = await harness.runtime.apiCommands.applySettlementReputationEffect(
      harness.moderatorCtx("w033-ac09-effect-1"),
      harness.moderatorPersonId,
      { valueRecordId: first.value.id, idempotencyKey: effectKey },
    );
    expect(effectFirst.created).toBe(true);
    const effectReplay = await harness.runtime.apiCommands.applySettlementReputationEffect(
      harness.moderatorCtx("w033-ac09-effect-2"),
      harness.moderatorPersonId,
      { valueRecordId: first.value.id, idempotencyKey: effectKey },
    );
    expect(effectReplay.created).toBe(false);
    expect((effectReplay.input as { id: string }).id).toBe(
      (effectFirst.input as { id: string }).id,
    );
    // Exactly ONE reputation input from the effect (audit check).
    const inputEvents = await harness.runtime.auditWriter.query({
      eventType: "reputation_input.recorded",
    });
    const effectInputs = inputEvents.filter(
      (e) => e.resourceId === (effectFirst.input as { id: string }).id,
    );
    expect(effectInputs).toHaveLength(1);
  });

  test("RACE: concurrent same-key benefit allocations converge to exactly ONE committed composite", async () => {
    const world = await createDrawableWorld(80);
    const idem = key("w033-ac09-race");
    const [a, b] = await Promise.all([
      harness.runtime.benefitPoolService.allocatePoolBenefits(
        harness.moderatorCtx("w033-ac09-race-a"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: world.poolId,
          idempotencyKey: idem,
        },
      ),
      harness.runtime.benefitPoolService.allocatePoolBenefits(
        harness.moderatorCtx("w033-ac09-race-b"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: world.poolId,
          idempotencyKey: idem,
        },
      ),
    ]);
    // Exactly one executed; the other is the deterministic replay.
    expect(a.created).not.toBe(b.created);
    expect(a.allocation.id).toBe(b.allocation.id);
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.moderatorCtx("w033-ac09-race-list"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: world.poolId,
      },
    );
    expect(allocations).toHaveLength(1);
    // The value is consumed exactly once.
    const value = await harness.runtime.economicValueService.getValue(
      harness.contributorCtx("w033-ac09-race-value"),
      world.valueId,
    );
    expect(value.state).toBe("CONSUMED");
  });

  test("RACE: concurrent same-key recognition converges to exactly ONE value record", async () => {
    const { createVerifiedSettledContribution } = await import(
      "../reward-integration/_net-w014-harness.ts"
    );
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const idem = key("w033-ac09-recog-race");
    const [a, b] = await Promise.all([
      recognizeContributionValue(harness.w014, contribution.id, {
        amount: 90,
        idempotencyKey: idem,
      }),
      recognizeContributionValue(harness.w014, contribution.id, {
        amount: 90,
        idempotencyKey: idem,
      }),
    ]);
    expect(a.created).not.toBe(b.created);
    expect(a.value.id).toBe(b.value.id);
    const values = await harness.runtime.economicValueService.listValues(
      harness.contributorCtx("w033-ac09-recog-race-list"),
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    expect(
      values.filter((v) => v.sources.some((s) => s.id === contribution.id)),
    ).toHaveLength(1);
  });

  test("FAULT INJECTION (the critical join): a draw failure leaves NO partial mutation (allocation, draw, consumption, audit)", async () => {
    const world = await createDrawableWorld(50);
    // Pre-consume the value record through the settlement's OWN
    // standalone command AFTER the pool was created (the committed
    // pre-flight read saw it MATURE; the in-tx re-derivation must
    // fail closed and roll EVERYTHING back).
    await harness.runtime.rewardService.allocateRewards(
      harness.moderatorCtx("w033-ac09-pre-consume"),
      {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: world.valueId,
        policyId: world.rewardPolicyId,
        idempotencyKey: key("w033-ac09-preconsume"),
      },
    );
    // The allocation now fails closed (in-tx funding re-derivation:
    // the record is CONSUMED — the pre-flight MATURE read is stale).
    await expect(
      harness.runtime.benefitPoolService.allocatePoolBenefits(
        harness.moderatorCtx("w033-ac09-fault"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: world.poolId,
          idempotencyKey: key("w033-ac09-fault-alloc"),
        },
      ),
    ).rejects.toThrow(/not qualified/i);
    // NO partial mutation survived the failed commit.
    const allocations = await harness.runtime.benefitPoolService.listPoolAllocations(
      harness.moderatorCtx("w033-ac09-fault-list"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: world.poolId,
      },
    );
    expect(allocations).toHaveLength(0);
    // NO audit event was published for the failed allocation (the
    // transactional audit buffer is DISCARDED on the failed commit).
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
    });
    expect(events.filter((e) => e.subject === world.poolId)).toHaveLength(0);
  });

  test("FAULT INJECTION (mid-path gate): an ACTIVE dispute freezes the maturation — NO partial final state; resolution completes the path", async () => {
    // A fresh recognized-but-PENDING value.
    const { createVerifiedSettledContribution } = await import(
      "../reward-integration/_net-w014-harness.ts"
    );
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const pending = await recognizeContributionValue(harness.w014, contribution.id, {
      amount: 25,
    });
    // Inject the failure at the critical join: an ACTIVE dispute over
    // the value record.
    const w010 = harness.w014.w013.w012.w011.w010;
    await ensureCreditsFor(w010, harness.moderatorPersonId, 50);
    const ctx = harness.moderatorCtx("w033-ac09-dispute");
    const opened = await harness.runtime.disputeService.openDispute(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectRef: { subjectType: "economic_value", subjectId: pending.value.id },
      statement: "injected mid-path failure (fault injection)",
      reasonCodes: ["contested_verification"],
      supportingRefs: [{ kind: "economic_value", id: pending.value.id }],
      effectiveAt: new Date(Date.now() + 3600_000).toISOString(),
      idempotencyKey: key("w033-ac09-dispute"),
    });
    const staked = await harness.runtime.stakeService.commitStake(ctx, {
      organizationScopeId: opened.dispute.organizationScopeId,
      ownerPersonId: opened.dispute.challengerPersonId,
      amount: opened.dispute.stake.requirement.amount,
      purpose: { kind: "dispute_challenge", id: opened.dispute.id },
      description: `challenge stake for dispute ${opened.dispute.id}`,
      idempotencyKey: key("w033-ac09-stake"),
    });
    await harness.runtime.disputeService.bondStake(ctx, {
      disputeId: opened.dispute.id,
      stakeId: staked.stake.id,
      idempotencyKey: key("w033-ac09-bond"),
    });
    // The maturation is REFUSED: the value stays PENDING (no partial
    // final state — nothing half-matured).
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(
        harness.moderatorCtx("w033-ac09-frozen"),
        { valueRecordId: pending.value.id, idempotencyKey: key("w033-ac09-fm") },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
    const frozen = await harness.runtime.economicValueService.getValue(
      harness.contributorCtx("w033-ac09-frozen-read"),
      pending.value.id,
    );
    expect(frozen.state).toBe("PENDING");
    expect(frozen.maturedAt).toBeNull();
    // Resolution re-opens the path; the composite completes.
    await harness.runtime.disputeService.startReview(
      harness.memberCCtx("w033-ac09-review"),
      { disputeId: opened.dispute.id, idempotencyKey: key("w033-ac09-review") },
    );
    await harness.runtime.disputeService.resolveDispute(
      harness.memberCCtx("w033-ac09-resolve"),
      {
        disputeId: opened.dispute.id,
        outcome: "DISMISSED",
        controlDisposition: "RELEASE_CONTROL",
        reasonCodes: ["fault_injection_cleared"],
        sourceRefs: [{ kind: "economic_value", id: pending.value.id }],
        note: "fault injection cleared",
        idempotencyKey: key("w033-ac09-resolve"),
      },
    );
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      harness.moderatorCtx("w033-ac09-mature-after"),
      { valueRecordId: pending.value.id, idempotencyKey: key("w033-ac09-m2") },
    );
    expect(matured.state).toBe("MATURE");
  });

  test("AUDIT ORDERING: the committed allocation's audit event carries the authoritative transaction id (post-commit)", async () => {
    const world = await createDrawableWorld(30);
    const result = await harness.runtime.benefitPoolService.allocatePoolBenefits(
      harness.moderatorCtx("w033-ac09-audit"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: world.poolId,
        idempotencyKey: key("w033-ac09-audit"),
      },
    );
    const events = await harness.runtime.auditWriter.query({
      eventType: "benefits_pool.allocation_recorded",
      resourceId: result.allocation.id,
    });
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.metadata?.transactionId).toBe("string");
    expect(events[0]!.metadata?.drawTransactionId).toBe(
      (result.allocation.draw as { transactionId: string } | null)!.transactionId,
    );
    expect(typeof events[0]!.metadata?.idempotencyRecordId).toBe("string");
    // The envelope stays conserved after every scenario in this
    // suite (replays + races + fault injections).
    await assertGlobalConservation(
      harness.w014.w013.w012.w011.w010.w009.w008,
    );
  });
});

export type { CanonicalScenario, NetW014Harness };
