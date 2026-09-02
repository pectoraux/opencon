/**
 * NET-W034-AC-07 — Workflow completion, risk and dispute controls
 * (issue #69 §5 AC-07).
 *
 * After measurement/evidence exist, the canonical lifecycle completes
 * through `/workflows`. At least one applicable risk/dispute control
 * blocks maturation or consumption, then after sanctioned resolution
 * the same authoritative path succeeds. No advertising-specific
 * risk/dispute authority exists.
 *  - the workflow completion ordering (the completed VERIFIED walk
 *    AFTER the measurement/outcomes/evidence stages — witnesses +
 *    the durable audit commit order);
 *  - the risk HOLD gate: the maturation REFUSES (RISK_CONTROL) while
 *    the value stays PENDING, NOTHING drawn;
 *  - the resolution re-opens the SAME authoritative path (no bypass);
 *  - the ACTIVE dispute gate: the maturation REFUSES
 *    (DISPUTE_CHALLENGE), the due-process resolution (review first —
 *    never the challenger — then DISMISSED) re-opens;
 *  - the economic gate refuses the CLEARING while blocked (risk/
 *    dispute gate over the source contexts — before any draw);
 *  - the final lifecycle state/version witness + the structural
 *    no-advertising-risk pin.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  holdMaturationOn,
  resolveHold,
  openBondedDisputeOn,
  resolveDispute,
  recognizeAdvertisingValue,
  matureAdvertisingValue,
  executeScenarioClearing,
  key,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-07 workflow completion and risk/dispute controls", () => {
  test("the workflow completion occurs ONLY after the measurement/outcomes/evidence stages (witnesses + audit order)", async () => {
    // (a) The ordered stage witnesses: the completed VERIFIED walk
    // (v10) is witnessed AFTER every measurement/outcomes/evidence
    // stage (each witnessed IN MEASURING at v5).
    const stages = scenario.traversal.map((w) => w.stage);
    const completedIdx = stages.indexOf("lifecycle-completed");
    for (const stage of [
      "measurement-normalized",
      "outcome-verified",
      "evidence-pov-verified",
      "poh-evaluated",
    ]) {
      expect(stages.indexOf(stage)).toBeLessThan(completedIdx);
    }
    const completedWitness = scenario.traversal[completedIdx]!;
    expect(completedWitness.contributionState).toBe("VERIFIED");
    expect(completedWitness.contributionVersion).toBe(10);
    // (b) The durable audit commit order: the walk resumption
    // (measuring → evaluating) committed AFTER the PoV aggregation +
    // the outcome verification.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    const povAggregated = pos(
      "proof_of_value.aggregated",
      scenario.proofOfValueId,
    );
    const outcomeVerified = pos(
      "outcome_measurement.transition.measuring_to_verified",
      scenario.measuredOutcome.id,
    );
    const walkResumed = pos(
      "contribution.transition.measuring_to_evaluating",
      scenario.contribution.id,
    );
    const walkCompleted = pos(
      "contribution.transition.settled_to_verified",
      scenario.contribution.id,
    );
    expect(walkResumed).toBeGreaterThan(povAggregated);
    expect(walkResumed).toBeGreaterThan(outcomeVerified);
    expect(walkCompleted).toBeGreaterThan(walkResumed);
    // The scenario contribution is at the terminal VERIFIED v10.
    expect(scenario.contribution.state).toBe("VERIFIED");
    expect(scenario.contribution.version).toBe(10);
  });

  test("the risk HOLD gate REFUSES the maturation (RISK_CONTROL — the value stays PENDING, nothing drawn)", async () => {
    // A fresh recognized (PENDING) value for the scenario's VERIFIED
    // contribution.
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 40 },
    );
    expect(recognized.value.state).toBe("PENDING");
    // The HOLD control on the CONTRIBUTION (the upstream source).
    const controlId = await holdMaturationOn(
      harness,
      "contribution",
      scenario.contribution.id,
    );
    await expect(
      matureAdvertisingValue(harness, recognized.value.id),
    ).rejects.toMatchObject({
      code: "RISK_CONTROL",
      context: expect.objectContaining({
        recordSubjectId: scenario.contribution.id,
      }),
    });
    // No partial state: the value stays PENDING.
    const still = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac07-gated-read"),
      recognized.value.id,
    );
    expect(still.state).toBe("PENDING");
    // NOTHING drawn (no allocations referencing this value).
    const allocations = await harness.runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-ac07-gate-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === recognized.value.id)
        .length,
    ).toBe(0);
    // The resolution lifts the gate — the SAME authoritative path.
    await resolveHold(harness, controlId);
    const matured = await matureAdvertisingValue(harness, recognized.value.id);
    expect(matured.state).toBe("MATURE");
  });

  test("the ACTIVE dispute gate REFUSES the maturation (DISPUTE_CHALLENGE) until the due-process resolution", async () => {
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 40 },
    );
    // An OPEN + BONDED dispute on the CONTRIBUTION (the upstream
    // source — the gate covers all upstream records).
    const disputeId = await openBondedDisputeOn(
      harness,
      "contribution",
      scenario.contribution.id,
    );
    await expect(
      matureAdvertisingValue(harness, recognized.value.id),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
    // The value stays PENDING (no partial maturation).
    const still = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac07-disputed-read"),
      recognized.value.id,
    );
    expect(still.state).toBe("PENDING");
    // The due-process resolution (review first — the reviewer is NEVER
    // the challenger — then DISMISSED): the SAME authoritative path
    // re-opens.
    await resolveDispute(harness, disputeId, scenario.contribution.id);
    const matured = await matureAdvertisingValue(harness, recognized.value.id);
    expect(matured.state).toBe("MATURE");
    // The resolution audit trail (review → resolved, tx-bound).
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      resourceType: "dispute",
      resourceId: disputeId,
    });
    const types = events.map((e) => e.eventType);
    expect(types).toContain("dispute.opened");
    expect(types).toContain("dispute.stake_bonded");
    expect(types).toContain("dispute.review_started");
    expect(types).toContain("dispute.resolved");
  });

  test("the economic gate refuses the CLEARING while a risk control is ACTIVE (before any draw)", async () => {
    // A MATURE value + a fresh HOLD on it (operation class
    // reward_allocation — the clearing's risk gate consults the
    // draw-kind-mapped class): the clearing REFUSES.
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 40 },
    );
    const matured = await matureAdvertisingValue(harness, recognized.value.id);
    const controlId = await holdMaturationOn(
      harness,
      "economic_value",
      matured.id,
      "reward_allocation",
    );
    await expect(
      executeScenarioClearing(harness, {
        sourceContributionId: scenario.contribution.id,
        targetPlacementId: scenario.placementId,
        valueRecordId: matured.id,
      }),
    ).rejects.toMatchObject({ code: "RISK_CONTROL" });
    // NOTHING drawn; no allocation references the blocked value.
    const allocations = await harness.runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-ac07-gated-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === matured.id).length,
    ).toBe(0);
    // The resolution re-opens the SAME composite (the W020 AC-06
    // precedent).
    await resolveHold(harness, controlId);
    const result = await executeScenarioClearing(harness, {
      sourceContributionId: scenario.contribution.id,
      targetPlacementId: scenario.placementId,
      valueRecordId: matured.id,
    });
    expect((result as { created: boolean }).created).toBe(true);
  });

  test("the scenario's own risk/dispute gate witnesses are ordered BEFORE the maturation (the frozen order)", async () => {
    // The FULL canonical scenario (the frozen order: the gates run
    // BEFORE the economic maturation + clearing).
    const full = await runAdvertisingScenario(harness);
    const stages = full.traversal.map((w) => w.stage);
    const refusedIdx = stages.indexOf("risk-gate-refused");
    const riskResolvedIdx = stages.indexOf("risk-gate-resolved");
    const disputeRefusedIdx = stages.indexOf("dispute-gate-refused");
    const disputeResolvedIdx = stages.indexOf("dispute-gate-resolved");
    const maturedIdx = stages.indexOf("settlement-matured");
    expect(maturedIdx).toBeGreaterThan(refusedIdx);
    expect(maturedIdx).toBeGreaterThan(riskResolvedIdx);
    expect(maturedIdx).toBeGreaterThan(disputeRefusedIdx);
    expect(maturedIdx).toBeGreaterThan(disputeResolvedIdx);
    // Every gate witness carries the AUTHORITATIVE VERIFIED v10 state
    // (the gates run AFTER the workflow completion, BEFORE the
    // maturation — the economic witnesses cannot precede the gates).
    for (const idx of [
      refusedIdx,
      riskResolvedIdx,
      disputeRefusedIdx,
      disputeResolvedIdx,
    ]) {
      const witness = full.traversal[idx]!;
      expect(witness.contributionState).toBe("VERIFIED");
      expect(witness.contributionVersion).toBe(10);
    }
    // The audit commit order corroborates: the control resolution +
    // the dispute resolution committed BEFORE the maturation.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    const riskResolved = pos("risk_control.resolved", full.riskControlId);
    const disputeResolved = pos("dispute.resolved", full.disputeId);
    const valueMatured = pos("economic_value.matured", full.matureValue.id);
    const clearingCommitted = pos(
      "cross_promotion_clearing.recorded",
      full.clearingId,
    );
    expect(riskResolved).toBeGreaterThanOrEqual(0);
    expect(disputeResolved).toBeGreaterThan(riskResolved);
    expect(valueMatured).toBeGreaterThan(disputeResolved);
    expect(clearingCommitted).toBeGreaterThan(valueMatured);
  });

  test("NO advertising-specific risk/dispute authority exists (the structural pin)", async () => {
    // The W034 surface exercises ONLY the existing /disputes
    // primitives (risk policy → assessment → control; dispute →
    // stake → bond → review → resolution). The control's operation
    // class is the EXISTING vocabulary; the dispute subject types
    // are the EXISTING closed set — no advertising vocabulary
    // exists.
    const { DISPUTE_SUBJECT_TYPES } = await import(
      "../../src/core/disputes.ts"
    );
    expect(DISPUTE_SUBJECT_TYPES).toContain("contribution");
    expect(DISPUTE_SUBJECT_TYPES).toContain("economic_value");
    expect(DISPUTE_SUBJECT_TYPES).not.toContain("advertising_execution");
    expect(DISPUTE_SUBJECT_TYPES).not.toContain("ad_placement");
    // The audit vocabulary of the composed chain contains NO
    // advertising-specific risk/dispute events.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const riskishEvents = log
      .map((e) => e.eventType)
      .filter((t) => t.startsWith("risk_control.") || t.startsWith("dispute."));
    for (const type of new Set(riskishEvents)) {
      expect(type.startsWith("advertising")).toBe(false);
    }
    expect(riskishEvents).toContain("risk_control.activated");
    expect(riskishEvents).toContain("risk_control.resolved");
    expect(riskishEvents).toContain("dispute.opened");
    expect(riskishEvents).toContain("dispute.resolved");
  });
});
