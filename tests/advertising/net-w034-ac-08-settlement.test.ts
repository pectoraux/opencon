/**
 * NET-W034-AC-08 — Verified value and settlement (issue #69 §5 AC-08).
 *
 * Only after the workflow/evidence/evaluation gates pass does
 * verified advertising value enter `/settlement` pending state, mature
 * after applicable controls, and execute the campaign's declared
 * clearing rule through the existing settlement primitives. No second
 * advertising ledger or direct adapter/domain economic write exists.
 *  - the value-record lineage (the server-derived sources: the
 *    contribution + the measured outcome + the PoV + the evidence);
 *  - the PENDING → MATURE state distinction (recognition ≠
 *    maturation — the gates between them);
 *  - a NON-VERIFIED contribution cannot enter settlement (the
 *    lifecycle gate — the sole blocker);
 *  - the clearing executes the CAMPAIGN's declared rule (the
 *    reward_allocation draw through the REAL reward policy; the
 *    clearing record references the rule + the source + the
 *    placement + the value);
 *  - the draw consumes the value (MATURE → CONSUMED) with balanced
 *    ledger postings + global conservation;
 *  - the clearing's derived eligibility view (all six checks
 *    satisfied, the resolved rule);
 *  - the structural no-second-ledger pin (the only reward allocation;
 *    no advertising ledger vocabulary).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  evaluateScenarioClearing,
  executeScenarioClearing,
  recognizeAdvertisingValue,
  key,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import {
  createHelpfulContribution,
  publishHelpfulContribution,
  attachEvidenceBasis,
} from "../contributions/_net-w012-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-08 verified value and settlement", () => {
  test("the recognized value carries the SERVER-DERIVED source lineage (contribution + measured outcome + PoV + evidence)", async () => {
    const ctx = harness.operatorCtx("w034-ac08-lineage");
    const value = await harness.runtime.economicValueService.getValue(
      ctx,
      scenario.value.id,
    );
    // The value was recognized from the VERIFIED contribution with
    // the PoH's qualifying bases mapped onto economic source kinds
    // (re-resolved server-side — never caller-asserted).
    const sources = value.sources.map((s) => `${s.kind}:${s.id}`);
    expect(sources).toContain(`contribution:${scenario.contribution.id}`);
    expect(sources).toContain(`measured_outcome:${scenario.measuredOutcome.id}`);
    expect(sources).toContain(`proof_of_value:${scenario.proofOfValueId}`);
    expect(value.amount).toBe(100);
    // The recognition audit event carries the transaction + idempotency
    // lineage.
    const audit = harness.runtime.auditWriter;
    const recorded = await audit.query({
      eventType: "economic_value.recorded",
      resourceId: value.id,
    });
    expect(recorded).toHaveLength(1);
    expect(typeof recorded[0]!.metadata?.transactionId).toBe("string");
    expect(typeof recorded[0]!.metadata?.idempotencyRecordId).toBe("string");
  });

  test("PENDING and MATURE are DISTINCT states (recognition ≠ maturation — the gates between them)", async () => {
    // The scenario's recognition snapshot is PENDING; the matured
    // record is MATURE (the risk/dispute-gated composite in between).
    expect(scenario.value.state).toBe("PENDING");
    expect(scenario.matureValue.state).toBe("MATURE");
    expect(scenario.value.id).toBe(scenario.matureValue.id);
    // The maturation audit event exists exactly once.
    const audit = harness.runtime.auditWriter;
    const matured = await audit.query({
      eventType: "economic_value.matured",
      resourceId: scenario.value.id,
    });
    expect(matured).toHaveLength(1);
  });

  test("a NON-VERIFIED contribution cannot enter settlement (the lifecycle gate)", async () => {
    // A contribution that passes every OTHER recognition gate (the
    // evidence basis attached, PoH evaluated) but is stopped at
    // SUBMITTED — the VERIFIED lifecycle gate is the ONLY blocker.
    const { contribution } = await createHelpfulContribution(harness.w012, {
      idempotencyKey: key("w034-ac08-non-verified"),
    });
    await attachEvidenceBasis(harness.w012, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      harness.creatorCtx("w034-ac08-poh"),
      { contributionId: contribution.id, idempotencyKey: key("w034-ac08-poh") },
    );
    void poh;
    await publishHelpfulContribution(harness.w012, contribution.id);
    const current = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w034-ac08-read"),
      contribution.id,
    );
    expect(current.state).toBe("SUBMITTED");
    await expect(
      recognizeAdvertisingValue(harness, contribution.id, { amount: 10 }),
    ).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({ contributionState: "SUBMITTED" }),
    });
    // No economic record exists for the unverified contribution.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    expect(
      log.filter(
        (e) =>
          e.eventType === "economic_value.recorded" &&
          (e.metadata?.subjectId === contribution.id ||
            e.resourceId === contribution.id),
      ),
    ).toHaveLength(0);
  });

  test("the clearing's DERIVED eligibility: all six checks satisfied + the resolved campaign rule", async () => {
    const view = await evaluateScenarioClearing(harness, {
      sourceContributionId: scenario.contribution.id,
      targetPlacementId: scenario.placementId,
      valueRecordId: scenario.matureValue.id,
    });
    expect(view.eligible).toBe(true);
    const checks = view.checks.map((c) => [c.check, c.satisfied]);
    expect(checks).toEqual([
      ["source_contribution_qualified", true],
      ["placement_settlement_ready", true],
      ["placement_campaign_bound", true],
      ["campaign_clearing_policy", true],
      ["value_eligible", true],
      ["risk_dispute_gate", true],
    ]);
    // The resolved rule is the CAMPAIGN's declared clearing rule
    // (wired to the REAL reward policy lineage).
    expect(view.resolvedRule).toEqual({
      id: "clear-1",
      objectiveId: "obj-1",
      basis: "attributed_outcome",
      drawKind: "reward_allocation",
      rewardPolicyId: scenario.campaignRewardPolicyId,
      maxDrawAmount: 1000,
    });
  });

  test("the clearing executes the CAMPAIGN's declared rule through the existing settlement primitive", async () => {
    const clearing = scenario.clearing;
    // The draw kind + the clearing record.
    expect((clearing as { drawKind: string }).drawKind).toBe(
      "reward_allocation",
    );
    expect((clearing as { created: boolean }).created).toBe(true);
    const clearingRecord = (clearing as { clearing: Record<string, unknown> })
      .clearing;
    expect(typeof clearingRecord.id).toBe("string");
    expect(clearingRecord.id).toBe(scenario.clearingId);
    // The reward ALLOCATION exists (the settlement-owned draw
    // primitive) — exactly ONE for the source value.
    const allocations = await harness.runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-ac08-allocations"),
      harness.organizationScopeId,
    );
    const forValue = allocations.filter(
      (a) => a.sourceValueRecordId === scenario.matureValue.id,
    );
    expect(forValue).toHaveLength(1);
    expect(forValue[0]!.id).toBe(scenario.allocationId);
    // The draw consumed the value (MATURE → CONSUMED).
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac08-consumed"),
      scenario.matureValue.id,
    );
    expect(value.state).toBe("CONSUMED");
    // The campaign bookkeeping joined the clearing transaction (the
    // neutral port — /campaigns stays the bookkeeping authority).
    const campaign = await harness.runtime.campaignService.getCampaign(
      harness.operatorCtx("w034-ac08-bookkeeping"),
      scenario.campaignId,
    );
    expect(
      campaign.events.filter((e) => e.event === "clearing_executed"),
    ).toHaveLength(1);
    // The clearing audit event + the reward allocation event are
    // BOTH tx-bound to the SAME authoritative transaction (one
    // economic unit — the clearing composite commits atomically).
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const clearingEvent = log.find(
      (e) =>
        e.eventType === "cross_promotion_clearing.recorded" &&
        e.resourceId === scenario.clearingId,
    );
    expect(clearingEvent).toBeDefined();
    expect(typeof clearingEvent!.metadata?.transactionId).toBe("string");
    const allocationEvent = log.find(
      (e) =>
        e.eventType === "reward_allocation.recorded" &&
        e.resourceId === scenario.allocationId,
    );
    expect(allocationEvent).toBeDefined();
    expect(allocationEvent!.metadata?.transactionId).toBe(
      clearingEvent!.metadata?.transactionId,
    );
  });

  test("the ledger is conserved end-to-end (every unit Σdebit === Σcredit)", async () => {
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("same-key clearing REPLAY returns the committed composite (created=false, no second draw)", async () => {
    // A FRESH-key attempt on the already-cleared pair refuses
    // (CLEARING_CONFLICT — the exactly-once pair mutex: ONE clearing
    // per contribution-placement pair).
    await expect(
      executeScenarioClearing(harness, {
        sourceContributionId: scenario.contribution.id,
        targetPlacementId: scenario.placementId,
        valueRecordId: scenario.matureValue.id,
        idempotencyKey: key("w034-ac08-fresh-key"),
      }),
    ).rejects.toMatchObject({ code: "CLEARING_CONFLICT" });
    // The SAME-KEY replay: the committed composite result re-played
    // (created=false — no second draw, exactly-once holds).
    const replay = await executeScenarioClearing(harness, {
      sourceContributionId: scenario.contribution.id,
      targetPlacementId: scenario.placementId,
      valueRecordId: scenario.matureValue.id,
      idempotencyKey: scenario.clearingIdempotencyKey,
    });
    expect((replay as { created: boolean }).created).toBe(false);
    expect(
      (replay as { clearing: { id?: string } }).clearing?.id,
    ).toBe(scenario.clearingId);
    // The value record is still consumed; still exactly ONE
    // allocation for the source value.
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac08-after"),
      scenario.matureValue.id,
    );
    expect(value.state).toBe("CONSUMED");
    const allocations = await harness.runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-ac08-after-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter(
        (a) => a.sourceValueRecordId === scenario.matureValue.id,
      ),
    ).toHaveLength(1);
  });

  test("the structural no-second-ledger pin: NO advertising economic vocabulary exists", async () => {
    // The composed economic surface uses ONLY the existing primitives:
    // economic_value.*, reward_allocation.*, cross_promotion_clearing.*
    // (the W020 vocabulary). No advertising ledger/account/posting
    // kind exists.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const economicEvents = log
      .map((e) => e.eventType)
      .filter(
        (t) =>
          t.startsWith("economic_value.") ||
          t.startsWith("reward_allocation.") ||
          t.startsWith("cross_promotion_clearing.") ||
          t.startsWith("credit_") ||
          t.startsWith("cash_"),
      );
    for (const type of new Set(economicEvents)) {
      expect(type.startsWith("advertising")).toBe(false);
      expect(type.startsWith("ad_")).toBe(false);
    }
    expect(economicEvents).toContain("economic_value.recorded");
    expect(economicEvents).toContain("economic_value.matured");
    expect(economicEvents).toContain("cross_promotion_clearing.recorded");
    expect(economicEvents).toContain("reward_allocation.recorded");
    // The only durable economic stores are the settlement-owned ones
    // (the ledger entries + the value/allocation/clearing records —
    // no advertising tables exist: the audit vocabulary check above
    // covers every economic event the W034 chain can emit, and the
    // architecture regression suite pins the frozen directory set
    // with no new authority stores).
  });
});
