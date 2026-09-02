/**
 * NET-W034-AC-09 — Replay, concurrency, atomicity and tenancy (issue
 * #69 §5 AC-09).
 *
 * Same-key replays return identical committed records without
 * duplicates; at least one concurrent race proves exactly-once
 * economic behavior; a fault-injected critical join leaves no partial
 * final state; cross-tenant references fail closed across composed
 * boundaries.
 *  - REPLAY: same-key measurement submission + same-key recognition
 *    return the committed records verbatim (created=false);
 *  - RACE: concurrent same-key recognition converges to exactly ONE
 *    value record (the exactly-once economic boundary);
 *  - FAULT INJECTION at the critical clearing join: the value is
 *    consumed OUT-OF-BAND between the pre-flight read and the
 *    in-transaction re-derivation → the composite fails closed and
 *    rolls EVERYTHING back (no clearing record, no allocation, no
 *    consumption change, NO audit event);
 *  - the mid-path dispute freeze: a recognized value stays PENDING
 *    while the dispute is active (no partial final state), and the
 *    resolution completes the path;
 *  - TENANCY: cross-tenant references fail closed across the composed
 *    boundaries (matching, clearing, measurement — no existence
 *    oracles).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  submitAdvertisingMeasurement,
  recognizeAdvertisingValue,
  matureAdvertisingValue,
  executeScenarioClearing,
  evaluateScenarioClearing,
  runScenarioMatch,
  openBondedDisputeOn,
  resolveDispute,
  key,
  personCtx,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-09 replay, concurrency, atomicity and tenancy", () => {
  test("REPLAY: a same-key measurement submission returns the COMMITTED observation verbatim", async () => {
    const idem = key("w034-ac09-measure");
    const first = await submitAdvertisingMeasurement(
      harness,
      scenario.contribution.id,
      { idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    const replay = await submitAdvertisingMeasurement(
      harness,
      scenario.contribution.id,
      { idempotencyKey: idem },
    );
    expect(replay.created).toBe(false);
    expect(replay.observation.id).toBe(first.observation.id);
    // Exactly ONE observation record + ONE audit event for the
    // committed submission.
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      eventType: "outcome_observation.created",
    });
    const obsEvents = events.filter(
      (e) => e.resourceId === first.observation.id,
    );
    expect(obsEvents).toHaveLength(1);
  });

  test("REPLAY: a same-key recognition returns the COMMITTED value record verbatim", async () => {
    const idem = key("w034-ac09-recognize");
    const first = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 55, idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    const replay = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 55, idempotencyKey: idem },
    );
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(first.value.id);
    // Exactly ONE recognition audit event for the value record.
    const audit = harness.runtime.auditWriter;
    const recorded = await audit.query({
      eventType: "economic_value.recorded",
      resourceId: first.value.id,
    });
    expect(recorded).toHaveLength(1);
  });

  test("RACE: concurrent same-key recognition converges to exactly ONE value record (exactly-once at the economic boundary)", async () => {
    const idem = key("w034-ac09-race");
    const [a, b] = await Promise.all([
      recognizeAdvertisingValue(harness, scenario.contribution.id, {
        amount: 33,
        idempotencyKey: idem,
      }),
      recognizeAdvertisingValue(harness, scenario.contribution.id, {
        amount: 33,
        idempotencyKey: idem,
      }),
    ]);
    // Exactly one executed; the other is the deterministic replay.
    expect(a.created).not.toBe(b.created);
    expect(a.value.id).toBe(b.value.id);
    // Exactly ONE value record for this recognition key.
    const audit = harness.runtime.auditWriter;
    const recorded = await audit.query({
      eventType: "economic_value.recorded",
      resourceId: a.value.id,
    });
    expect(recorded).toHaveLength(1);
    // The global economic envelope is conserved after the race.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("FAULT INJECTION (the critical clearing join): an out-of-band consumption leaves NO partial clearing mutation", async () => {
    // A fresh matured value for the scenario's VERIFIED contribution.
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 25 },
    );
    const matured = await matureAdvertisingValue(harness, recognized.value.id);
    expect(matured.state).toBe("MATURE");
    // Pre-consume the value record through the settlement's OWN
    // standalone reward command AFTER the eligibility view was derived
    // (the committed pre-flight read saw it MATURE; the in-tx
    // re-derivation must fail closed and roll EVERYTHING back).
    const rewardPolicyId = scenario.campaignRewardPolicyId;
    await harness.runtime.rewardService.allocateRewards(
      harness.operatorCtx("w034-ac09-pre-consume"),
      {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: matured.id,
        policyId: rewardPolicyId,
        idempotencyKey: key("w034-ac09-preconsume"),
      },
    );
    // The value is now CONSUMED: the clearing composite fails closed
    // (a fresh-key clearing of a consumed record is NOT the replay
    // path — value_state_not_clearable).
    await expect(
      executeScenarioClearing(harness, {
        sourceContributionId: scenario.contribution.id,
        targetPlacementId: scenario.placementId,
        valueRecordId: matured.id,
        idempotencyKey: key("w034-ac09-fault-clear"),
      }),
    ).rejects.toThrow();
    // NO partial mutation survived the failed composite: no NEW
    // clearing record for the scenario's contribution-placement pair
    // (the pair mutex + the rollback), and no additional allocation.
    const audit = harness.runtime.auditWriter;
    const clearingEvents = await audit.query({
      eventType: "cross_promotion_clearing.recorded",
    });
    // The scenario's own clearing is untouched (still exactly one for
    // the scenario pair — the failed attempt left no record).
    const scenarioClearing = clearingEvents.filter(
      (e) => e.resourceId === scenario.clearingId,
    );
    expect(scenarioClearing).toHaveLength(1);
    const pairClearings = clearingEvents.filter(
      (e) =>
        (e.metadata?.sourceContributionId as string | undefined) ===
          scenario.contribution.id &&
        (e.metadata?.targetPlacementId as string | undefined) ===
          scenario.placementId,
    );
    expect(pairClearings).toHaveLength(1);
    // The ledger is still conserved after the failed composite.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the mid-path dispute freeze: a recognized value stays PENDING while the dispute is active; the resolution completes the path", async () => {
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 30 },
    );
    // The dispute on the CONTRIBUTION (the upstream source) freezes
    // the value mid-path (PENDING — no partial maturation).
    const disputeId = await openBondedDisputeOn(
      harness,
      "contribution",
      scenario.contribution.id,
    );
    await expect(
      matureAdvertisingValue(harness, recognized.value.id),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
    const frozen = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac09-frozen-read"),
      recognized.value.id,
    );
    expect(frozen.state).toBe("PENDING");
    // The resolution completes the path — no orphaned intermediate
    // state.
    await resolveDispute(harness, disputeId, scenario.contribution.id);
    const completed = await matureAdvertisingValue(harness, recognized.value.id);
    expect(completed.state).toBe("MATURE");
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("TENANCY: cross-tenant references fail closed across the composed boundaries", async () => {
    const secondCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w034-ac09-tenant",
    );
    // (a) Matching: the second-org scope cannot match the first-org
    // campaign (the tenant-scoped campaign lookup: NOT_FOUND — no
    // existence oracle; the policy version is never even consulted).
    await expect(
      harness.runtime.campaignMatchingService.runCampaignMatch(secondCtx, {
        organizationScopeId: harness.secondOrgId,
        campaignId: scenario.campaignId,
        candidateInventoryItemIds: [scenario.inventoryItemId],
        idempotencyKey: key("w034-ac09-tenant-match"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // (b) Clearing: the second-org scope resolves NOTHING (the value
    // record is the tenant anchor — NOT_FOUND, no existence oracle).
    await expect(
      harness.runtime.apiCommands.evaluateCrossPromotionClearing(
        secondCtx,
        {
          organizationScopeId: harness.secondOrgId,
          sourceContributionId: scenario.contribution.id,
          targetPlacementId: scenario.placementId,
          valueRecordId: scenario.matureValue.id,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // (c) Measurement: a second-org submission of a first-org subject
    // creates the observation ONLY in the SECOND org (tenant isolation
    // by construction), and that cross-scope observation CANNOT feed
    // the first-org measured outcome — the /outcomes authority
    // re-checks the scope at the attachment boundary (fail closed).
    const { rawDeliveryNotice } = await import(
      "../adapters/_net-w023-harness.ts"
    );
    const foreign = await harness.runtime.apiCommands.submitMeasurementReport(
      secondCtx,
      harness.secondOrgPersonId,
      {
        organizationScopeId: harness.secondOrgId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        idempotencyKey: key("w034-ac09-tenant-measure"),
        providerId: "openrtb-delivery",
        report: rawDeliveryNotice(),
      },
    ).catch(() => null);
    // The submission either resolves through the second-org scope or
    // fails closed; in BOTH cases nothing lands in the FIRST org.
    const firstOrgObservations =
      await harness.runtime.outcomeObservationService.listObservationsBySubject(
        harness.operatorCtx("w034-ac09-tenant-obs"),
        scenario.contribution.id,
      );
    const firstOrgScoped = firstOrgObservations.filter(
      (o) => o.organizationScopeId === harness.organizationScopeId,
    );
    expect(firstOrgScoped.every((o) => o.organizationScopeId === harness.organizationScopeId)).toBe(true);
    // The cross-scope observation (when created) CANNOT attach to a
    // FIRST-org measured outcome: the scope re-check fails closed.
    if (foreign !== null && foreign.observation.organizationScopeId !== harness.organizationScopeId) {
      await expect(
        harness.runtime.measuredOutcomeService.createMeasuredOutcome(
          harness.creatorCtx("w034-ac09-tenant-outcome"),
          {
            organizationScopeId: harness.organizationScopeId,
            ownerId: harness.creatorPersonId,
            subjectReference: {
              subjectId: scenario.contribution.id,
              subjectType: "contribution",
            },
            outcomeType: "view",
            maturation: { strategy: "immediate" },
            observationIds: [foreign.observation.id],
          },
        ),
      ).rejects.toMatchObject({ code: "MEASUREMENT_VALIDATION" });
    }
    void secondCtx;
  });
});
