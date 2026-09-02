/**
 * NET-W034 — The deterministic FULL-PATH advertising scenario (work
 * order §5: "a deterministic full-path traversal test" + §6).
 *
 * ONE canonical advertising execution traverses the ENTIRE frozen
 * authoritative chain — campaign/policy → supply/provenance (W019 +
 * the W023 OpenRTB evaluation) → the W021 hard-gated selection →
 * placement → the campaign opportunity (the W011 path) → the
 * contribution lifecycle entry + publication → MEASURING → the
 * measurement (the REAL W022 provider-selection path) → the outcomes
 * → the evidence/PoV → the PoH evaluation → the completed VERIFIED
 * walk → the risk/dispute gates (fail closed, resolved) → settlement
 * pending/mature → the campaign's declared clearing rule — through
 * the OWNING boundary at every step, with fixed evaluation anchors,
 * and the end state is globally conserved. The AC suites pin each
 * authority's composition contract in depth, and the third test
 * proves the CANONICAL TRAVERSAL ORDER itself (stage witnesses + the
 * audit commit order) — not just the eventual end-state lineage (the
 * W033 PR #68 architect-remediation discipline carried forward).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  key,
  type NetW034Harness,
} from "./_net-w034-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";

let harness: NetW034Harness;

beforeAll(async () => {
  harness = await createNetW034Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034 full-path scenario (campaign → settlement clearing)", () => {
  test("ONE advertising execution traverses the complete authoritative chain end-to-end", async () => {
    const scenario = await runAdvertisingScenario(harness);
    const runtime = harness.runtime;
    const ctx = harness.creatorCtx("w034-full-path");

    // Stage 1 — the campaign: ACTIVE, pinned policy v1, the clearing
    // rule wired to the real reward policy.
    const campaign = await runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.currentPolicyVersion).toBe(1);

    // Stage 2 — the supply: the registered + verified item; the W023
    // provenance evaluation resolved EXACTLY this item.
    const item = await runtime.inventoryService.getInventoryItem(
      ctx,
      harness.organizationScopeId,
      scenario.inventoryItemId,
    );
    expect(item.verificationEvidenceReference).toBe(
      scenario.supplyVerificationEvidenceId,
    );
    expect(scenario.provenanceEvaluation.admitted).toBe(true);
    expect(scenario.provenanceEvaluation.resolvedSupply?.itemId).toBe(
      scenario.inventoryItemId,
    );

    // Stage 3 — the W021 match: the eligible supply selected at rank
    // 1; the unverified candidate excluded.
    const runs = await runtime.campaignMatchingService.listMatchRuns(
      ctx,
      harness.organizationScopeId,
    );
    const run = runs.find((r) => r.id === scenario.matchRunId);
    expect(run!.results[0]!.inventoryItemId).toBe(scenario.inventoryItemId);
    expect(
      run!.excluded.some(
        (e) => e.inventoryItemId === scenario.excludedItemId,
      ),
    ).toBe(true);

    // Stage 4 — the placement: ELIGIBLE settlement readiness with the
    // pinned policy version.
    const placement = await runtime.inventoryService.getPlacement(
      ctx,
      harness.organizationScopeId,
      scenario.placementId,
    );
    expect(placement.campaignPolicyVersion).toBe(1);
    expect(scenario.readiness.eligible).toBe(true);

    // Stage 5 — the opportunity + the contribution: VERIFIED v10.
    const opportunity = await runtime.opportunityService.getOpportunity(
      ctx,
      scenario.opportunityId,
    );
    expect(opportunity.id).toBe(scenario.opportunityId);
    const contribution = await runtime.contributionService.getContribution(
      ctx,
      scenario.contribution.id,
    );
    expect(contribution.state).toBe("VERIFIED");
    expect(contribution.version).toBe(10);

    // Stage 7 — the measurement: the normalized observation from the
    // REAL provider path (provenance, attribution, uncertainty).
    const observation = await runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      scenario.observation.id,
    );
    expect(observation.provenance.sourceType).toBe("provider");
    expect(observation.provenance.sourceId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(observation.outcomeType).toBe("view");

    // Stage 8 — the outcomes: the VERIFIED measured outcome over the
    // observation.
    const measurement = await runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      scenario.measuredOutcome.id,
    );
    expect(measurement.state).toBe("VERIFIED");
    expect(measurement.observationIds).toEqual([observation.id]);

    // Stage 9 — the evidence/PoV: VERIFIED over real evidence + the
    // independent attestation.
    const proof = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    expect(proof.evidenceIds).toContain(scenario.povPlatformEvidenceId);
    expect(proof.evidenceIds).toContain(scenario.povProviderEvidenceId);
    expect(proof.attestationIds).toContain(scenario.attestationId);

    // Stage 11 — the risk/dispute gates: both resolved (the audit
    // trail proves the exercise).
    const audit = runtime.auditWriter;
    const controlEvents = await audit.query({
      resourceType: "risk_control_decision",
      resourceId: scenario.riskControlId,
    });
    expect(controlEvents.map((e) => e.eventType)).toContain(
      "risk_control.activated",
    );
    expect(controlEvents.map((e) => e.eventType)).toContain(
      "risk_control.resolved",
    );
    const disputeEvents = await audit.query({
      resourceType: "dispute",
      resourceId: scenario.disputeId,
    });
    expect(disputeEvents.map((e) => e.eventType)).toContain("dispute.opened");
    expect(disputeEvents.map((e) => e.eventType)).toContain("dispute.resolved");

    // Stage 12 — the settlement: the value matured, then consumed by
    // the campaign's declared clearing draw.
    const value = await runtime.economicValueService.getValue(
      ctx,
      scenario.matureValue.id,
    );
    expect(value.state).toBe("CONSUMED");
    expect(value.sources.map((s) => s.id)).toContain(contribution.id);
    expect(value.sources.map((s) => s.id)).toContain(measurement.id);
    // The reward allocation drew through the REAL reward policy.
    const allocations = await runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-full-path-alloc"),
      harness.organizationScopeId,
    );
    const draw = allocations.find(
      (a) => a.sourceValueRecordId === scenario.matureValue.id,
    );
    expect(draw).toBeDefined();
    expect(draw!.id).toBe(scenario.allocationId);

    // The global economic envelope is conserved end-to-end.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the full-path audit lineage exists for EVERY material stage (durable, ordered)", async () => {
    const scenario = await runAdvertisingScenario(harness);
    const audit = harness.runtime.auditWriter;

    // The advertising chain: campaign → supply → match → placement →
    // opportunity → contribution lifecycle (10 transitions).
    const contributionTransitions = (
      await audit.query({
        resourceType: "contribution",
        resourceId: scenario.contribution.id,
      })
    ).filter((e) => e.eventType.startsWith("contribution.transition."));
    expect(contributionTransitions).toHaveLength(10);

    // The measurement chain: the normalized observation + the
    // measured outcome lifecycle.
    const observationEvents = await audit.query({
      resourceType: "outcome_observation",
      resourceId: scenario.observation.id,
    });
    expect(
      observationEvents.filter((e) => e.eventType === "outcome_observation.created"),
    ).toHaveLength(1);
    const outcomeEvents = await audit.query({
      resourceType: "measured_outcome",
      resourceId: scenario.measuredOutcome.id,
    });
    expect(outcomeEvents.map((e) => e.eventType)).toContain(
      "measured_outcome.created",
    );
    expect(outcomeEvents.map((e) => e.eventType)).toContain(
      "measured_outcome.rollup_recorded",
    );

    // The evidence chain: the PoV + the attestation.
    const povEvents = await audit.query({
      resourceType: "proof_of_value",
      resourceId: scenario.proofOfValueId,
    });
    expect(povEvents.map((e) => e.eventType)).toContain(
      "proof_of_value.created",
    );
    expect(povEvents.map((e) => e.eventType)).toContain(
      "proof_of_value.aggregated",
    );

    // The economic chain: pending → mature → the clearing draw.
    const recorded = await audit.query({
      eventType: "economic_value.recorded",
      resourceId: scenario.value.id,
    });
    expect(recorded).toHaveLength(1);
    const matured = await audit.query({
      eventType: "economic_value.matured",
      resourceId: scenario.value.id,
    });
    expect(matured).toHaveLength(1);
    const cleared = await audit.query({
      eventType: "cross_promotion_clearing.recorded",
      resourceId: scenario.clearingId,
    });
    expect(cleared).toHaveLength(1);
    const drawn = await audit.query({
      eventType: "reward_allocation.recorded",
      resourceId: scenario.allocationId,
    });
    expect(drawn).toHaveLength(1);

    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the CANONICAL TRAVERSAL ORDER is proven (stage witnesses + the audit commit order)", async () => {
    const scenario = await runAdvertisingScenario(harness);

    // (a) The scenario's ordered stage witnesses: the AUTHORITATIVE
    // contribution state + version (read through the owning boundary)
    // at EVERY stage boundary, PLUS the durable authority record ids
    // for the pre-contribution advertising stages. The contribution
    // version increments only on /workflows lifecycle mutations (v0
    // DRAFT → v4 SUBMITTED → v5 MEASURING → v10 VERIFIED), so this
    // array is the deterministic executable-order proof: the
    // advertising stages (campaign/supply/match/placement/opportunity)
    // precede the lifecycle entry; the MEASURING point (v5) precedes
    // the measurement/outcomes/evidence stages (each witnessed IN
    // MEASURING at v5); the completed VERIFIED walk (v10) precedes the
    // economic stages; the risk/dispute gates precede the maturation.
    expect(
      scenario.traversal.map(
        (w) =>
          `${w.stage}|${w.authority}|${w.contributionState}|${w.contributionVersion}`,
      ),
    ).toEqual([
      "campaign-policy-resolved|/campaigns||-1",
      "supply-provenance-resolved|/inventory+/adapters||-1",
      "matching-run-committed|/campaigns||-1",
      "supply-selected-eligible|/campaigns||-1",
      "placement-committed|/inventory||-1",
      "opportunity-materialized|/opportunities||-1",
      "contribution-created|/contributions|DRAFT|0",
      "lifecycle-submitted|/workflows|SUBMITTED|4",
      "lifecycle-measuring|/workflows|MEASURING|5",
      "measurement-normalized|/measurement→/outcomes|MEASURING|5",
      "outcome-verified|/outcomes|MEASURING|5",
      "evidence-pov-verified|/evidence|MEASURING|5",
      "poh-evaluated|/workflows|MEASURING|5",
      "lifecycle-completed|/workflows|VERIFIED|10",
      "settlement-pending|/settlement|VERIFIED|10",
      "risk-gate-refused|/disputes|VERIFIED|10",
      "risk-gate-resolved|/disputes|VERIFIED|10",
      "dispute-gate-refused|/disputes|VERIFIED|10",
      "dispute-gate-resolved|/disputes|VERIFIED|10",
      "settlement-matured|/settlement|VERIFIED|10",
      "clearing-committed|/settlement|VERIFIED|10",
    ]);

    // (b) The durable audit commit order: the global append-only log
    // preserves insertion order (= committed-mutation order; every
    // material mutation publishes its audit strictly post-commit).
    // The canonical stage markers appear in EXACTLY the declared
    // order: the campaign → the supply (registration + verification)
    // → the match run → the placement → the opportunity → the
    // contribution publication → the MEASURING lifecycle point → the
    // measurement observation → the outcomes → the evidence/PoV → the
    // walk resumption + completion → the recognition → the
    // risk/dispute gates (exercised + resolved) → the maturation →
    // the clearing draw.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number => {
      const index = log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
      expect(
        index,
        `missing audit event ${eventType} for ${resourceId}`,
      ).toBeGreaterThanOrEqual(0);
      return index;
    };
    const markers: readonly [string, string][] = [
      ["campaign.created", scenario.campaignId],
      ["inventory_item.registered", scenario.inventoryItemId],
      ["inventory_item.supply_verification_attached", scenario.inventoryItemId],
      ["campaign_match.recorded", scenario.matchRunId],
      ["placement.recorded", scenario.placementId],
      ["opportunity.created", scenario.opportunityId],
      ["contribution.transition.in_progress_to_submitted", scenario.contribution.id],
      ["contribution.transition.submitted_to_measuring", scenario.contribution.id],
      ["outcome_observation.created", scenario.observation.id],
      ["measured_outcome.created", scenario.measuredOutcome.id],
      ["outcome_measurement.transition.measuring_to_verified", scenario.measuredOutcome.id],
      ["proof_of_value.created", scenario.proofOfValueId],
      ["attestation.created", scenario.attestationId],
      ["proof_of_value.aggregated", scenario.proofOfValueId],
      ["contribution.transition.measuring_to_evaluating", scenario.contribution.id],
      ["contribution.transition.settled_to_verified", scenario.contribution.id],
      ["economic_value.recorded", scenario.value.id],
      ["risk_control.activated", scenario.riskControlId],
      ["risk_control.resolved", scenario.riskControlId],
      ["dispute.opened", scenario.disputeId],
      ["dispute.resolved", scenario.disputeId],
      ["economic_value.matured", scenario.value.id],
      ["reward_allocation.recorded", scenario.allocationId],
      ["cross_promotion_clearing.recorded", scenario.clearingId],
    ];
    const positions = markers.map(([eventType, resourceId]) =>
      pos(eventType, resourceId),
    );
    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i]! > positions[i - 1]!,
        `canonical audit order violated at marker ${String(i)} (${markers[i]![0]} for ${markers[i]![1]})`,
      ).toBe(true);
    }

    // The witnesses 9–10 (the normalized measurement + the PoV) CANNOT
    // occur before witness 8 (MEASURING) — and the economic witnesses
    // cannot occur before the workflow/evidence/evaluation/risk gates:
    // the audit positions prove it (measuring transition BEFORE the
    // observation; the VERIFIED walk + the gate resolutions BEFORE the
    // maturation + the clearing).
    const measuringIdx = markers.findIndex(
      ([t, id]) =>
        t === "contribution.transition.submitted_to_measuring" &&
        id === scenario.contribution.id,
    )!;
    const observationIdx = markers.findIndex(
      ([t, id]) => t === "outcome_observation.created" && id === scenario.observation.id,
    )!;
    expect(positions[observationIdx]!).toBeGreaterThan(positions[measuringIdx]!);

    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });
});
