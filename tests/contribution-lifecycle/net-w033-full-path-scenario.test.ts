/**
 * NET-W033 — The deterministic FULL-PATH scenario (work order §5:
 * "at least one deterministic full-path scenario from contribution
 * creation through benefit outcome").
 *
 * ONE canonical contribution traverses the ENTIRE frozen authoritative
 * chain — opportunity → contribution → /workflows publication →
 * MEASURING → /evidence Proof-of-Value → /outcomes measurement →
 * PoH evaluation → /workflows walk completion (VERIFIED) →
 * /reputation → /settlement pending/mature → /benefits allocation —
 * through the OWNING boundary at every step, with fixed evaluation
 * anchors, and the end state is globally conserved. The AC suites
 * then pin each authority's composition contract in depth, and the
 * third test below proves the CANONICAL TRAVERSAL ORDER itself
 * (stage witnesses + the audit commit order) — not just the
 * eventual end-state lineage (the PR #68 architect-remediation
 * requirement).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  type NetW033Harness,
} from "./_net-w033-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW033Harness;

beforeAll(async () => {
  harness = await createNetW033Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033 full-path scenario (contribution → benefit)", () => {
  test("ONE contribution traverses the complete authoritative chain end-to-end", async () => {
    const scenario = await runCanonicalScenario(harness);
    const runtime = harness.runtime;
    const ctx = harness.contributorCtx("w033-full-path");

    // Stage 1 — the opportunity and the contribution exist with the
    // durable identifiers the chain references.
    const opportunity = await runtime.opportunityService.getOpportunity(
      ctx,
      scenario.opportunityId,
    );
    expect(opportunity.id).toBe(scenario.opportunityId);
    expect(opportunity.organizationScopeId).toBe(harness.organizationScopeId);
    const contribution = await runtime.contributionService.getContribution(
      ctx,
      scenario.contribution.id,
    );
    expect(contribution.state).toBe("VERIFIED");

    // Stage 3 — the PoV is VERIFIED over real evidence + attestation.
    const proof = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    expect(proof.evidenceIds).toContain(scenario.povPlatformEvidenceId);
    expect(proof.evidenceIds).toContain(scenario.povProviderEvidenceId);
    expect(proof.attestationIds).toContain(scenario.attestationId);

    // Stage 4 — the normalized measured outcome is VERIFIED with the
    // observation explicitly linked to the evidence lineage.
    const measurement = await runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      scenario.measuredOutcomeId,
    );
    expect(measurement.state).toBe("VERIFIED");
    const observation = await runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      scenario.observationId,
    );
    expect(observation.evidenceId).toBe(scenario.povPlatformEvidenceId);

    // Stage 5 — reputation: BOTH inputs recorded (the direct
    // evidence/outcome-derived one and the settlement-effect one).
    const direct = await runtime.reputationInputService.getInput(
      ctx,
      scenario.directInputId,
    );
    expect(direct.basis).toBe("verified");
    const effect = await runtime.reputationInputService.getInput(
      ctx,
      scenario.settlementEffectInputId,
    );
    expect(effect.basis).toBe("verified");
    const snapshot = await runtime.reputationSnapshotService.getSnapshot(
      ctx,
      scenario.snapshot.id,
    );
    // The fixed 2024 reference anchor covers every input that occurred
    // at/before it — the direct evidence/outcome-derived input. (The
    // settlement-effect input's decay anchor is the maturation
    // timestamp, later than this anchor — AC-05 pins its coverage with
    // a fact-anchored snapshot.)
    expect(snapshot.inputIds).toContain(scenario.directInputId);

    // Stage 6 — settlement: the value record matured, then consumed
    // by the benefit draw (ONE economic unit, conserved).
    const value = await runtime.economicValueService.getValue(
      ctx,
      scenario.matureValue.id,
    );
    expect(value.state).toBe("CONSUMED");
    expect(value.sources.map((s) => s.id)).toContain(contribution.id);

    // Stage 7 — benefits: the allocation drew the mature value
    // through the settlement reward primitive (deterministic plan).
    expect(scenario.allocation.totalAllocated).toBe(100);
    expect(scenario.allocation.id).not.toBe("");
    const pool = await runtime.benefitPoolService.getBenefitPool(
      harness.moderatorCtx("w033-pool-read"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      },
    );
    expect(pool.fundingRefs.map((r) => r.id)).toContain(scenario.matureValue.id);

    // The global economic envelope is conserved end-to-end.
    await assertGlobalConservation(
      harness.w014.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the full-path audit lineage exists for EVERY material stage (durable, ordered)", async () => {
    const scenario = await runCanonicalScenario(harness, { amount: 60 });
    const audit = harness.runtime.auditWriter;

    // The lifecycle transitions (10 = 4 publication + 6 maturation).
    const transitions = await audit.query({
      resourceType: "contribution",
      resourceId: scenario.contribution.id,
    });
    const transitionEvents = transitions.filter((e) =>
      e.eventType.startsWith("contribution.transition."),
    );
    expect(transitionEvents.map((e) => e.eventType)).toEqual([
      "contribution.transition.draft_to_ready",
      "contribution.transition.ready_to_assigned",
      "contribution.transition.assigned_to_in_progress",
      "contribution.transition.in_progress_to_submitted",
      "contribution.transition.submitted_to_measuring",
      "contribution.transition.measuring_to_evaluating",
      "contribution.transition.evaluating_to_challenge_window",
      "contribution.transition.challenge_window_to_settling",
      "contribution.transition.settling_to_settled",
      "contribution.transition.settled_to_verified",
    ]);

    // The economic chain: pending → mature → consumed (draw).
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

    // The reputation chain: two inputs + the snapshot.
    const inputEvents = await audit.query({
      eventType: "reputation_input.recorded",
    });
    expect(
      inputEvents.filter(
        (e) =>
          e.resourceId === scenario.directInputId ||
          e.resourceId === scenario.settlementEffectInputId,
      ),
    ).toHaveLength(2);

    // The benefit allocation.
    const allocationEvents = await audit.query({
      eventType: "benefits_pool.allocation_recorded",
      resourceId: scenario.allocationId,
    });
    expect(allocationEvents).toHaveLength(1);

    await assertGlobalConservation(
      harness.w014.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the CANONICAL TRAVERSAL ORDER is proven (stage witnesses + the audit commit order)", async () => {
    const scenario = await runCanonicalScenario(harness);

    // (a) The scenario's ordered stage witnesses: the AUTHORITATIVE
    // contribution state + version (read through the owning
    // boundary) at EVERY stage boundary. The contribution version
    // increments only on /workflows lifecycle mutations (v0 DRAFT →
    // v4 SUBMITTED → v5 MEASURING → v10 VERIFIED), so this array is
    // the deterministic executable-order proof: publication
    // (SUBMITTED v4) and the lifecycle's MEASURING point (v5) are
    // reached BEFORE the /evidence and /outcomes stages (each
    // witnessed IN MEASURING at v5 — after five lifecycle mutations
    // committed, before the sixth), and the walk completes VERIFIED
    // (v10) before reputation/settlement/benefits.
    expect(scenario.traversal).toEqual([
      { stage: "contribution-created", contributionState: "DRAFT", contributionVersion: 0 },
      { stage: "contribution-submitted", contributionState: "SUBMITTED", contributionVersion: 4 },
      { stage: "lifecycle-measuring", contributionState: "MEASURING", contributionVersion: 5 },
      { stage: "evidence-pov-verified", contributionState: "MEASURING", contributionVersion: 5 },
      { stage: "outcome-measured", contributionState: "MEASURING", contributionVersion: 5 },
      { stage: "poh-evaluated", contributionState: "MEASURING", contributionVersion: 5 },
      { stage: "contribution-verified", contributionState: "VERIFIED", contributionVersion: 10 },
      { stage: "reputation-input-recorded", contributionState: "VERIFIED", contributionVersion: 10 },
      { stage: "settlement-pending", contributionState: "VERIFIED", contributionVersion: 10 },
      { stage: "settlement-mature", contributionState: "VERIFIED", contributionVersion: 10 },
      { stage: "settlement-reputation-effect", contributionState: "VERIFIED", contributionVersion: 10 },
      { stage: "reputation-snapshot-recorded", contributionState: "VERIFIED", contributionVersion: 10 },
      { stage: "benefit-allocated", contributionState: "VERIFIED", contributionVersion: 10 },
    ]);

    // (b) The durable audit commit order: the global append-only log
    // preserves insertion order (= committed-mutation order; every
    // material mutation publishes its audit strictly post-commit).
    // The canonical stage markers appear in EXACTLY the declared
    // order: publication → the MEASURING lifecycle point → /evidence
    // (basis, PoV, attestation, aggregation) → /outcomes
    // (observation, rollup, VERIFIED) → the lifecycle walk
    // resumption + completion → reputation → settlement → the
    // settlement→reputation join → benefits.
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
    const contributionId = scenario.contribution.id;
    const markers: readonly [string, string][] = [
      ["contribution.transition.in_progress_to_submitted", contributionId],
      ["contribution.transition.submitted_to_measuring", contributionId],
      ["evidence.created", scenario.basisEvidenceId],
      ["proof_of_value.created", scenario.proofOfValueId],
      ["attestation.created", scenario.attestationId],
      ["proof_of_value.aggregated", scenario.proofOfValueId],
      ["outcome_observation.created", scenario.observationId],
      ["measured_outcome.rollup_recorded", scenario.measuredOutcomeId],
      ["outcome_measurement.transition.measuring_to_verified", scenario.measuredOutcomeId],
      ["contribution.transition.measuring_to_evaluating", contributionId],
      ["contribution.transition.settled_to_verified", contributionId],
      ["reputation_input.recorded", scenario.directInputId],
      ["economic_value.recorded", scenario.value.id],
      ["economic_value.matured", scenario.value.id],
      ["reputation_input.recorded", scenario.settlementEffectInputId],
      ["benefits_pool.allocation_recorded", scenario.allocationId],
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

    await assertGlobalConservation(
      harness.w014.w013.w012.w011.w010.w009.w008,
    );
  });
});
