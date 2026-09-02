/**
 * NET-W036 — The deterministic FULL-PATH demand/procurement/benefit
 * scenario (work order §5 + the frozen ledger §3).
 *
 * ONE canonical tenant-scoped execution traverses the ENTIRE frozen
 * authoritative chain — the procurement pool (three buyer-organization
 * commitments; the frozen privacy floors 3/3 passed as SEPARATE
 * disclosure dimensions) → the gated aggregate disclosure → the
 * qualified demand → four supplier offers with supplier D hard-excluded
 * BEFORE ranking (the revoked-membership supplier_authorized gate) →
 * the deterministic competitive selection (a procurement decision, NO
 * economic mutation) → the fulfillment as a CONTRIBUTION subject
 * through the SANCTIONED /workflows path (DRAFT→READY→ASSIGNED→
 * IN_PROGRESS→SUBMITTED→MEASURING) → the REAL W022 provider measurement
 * (the OpenRTB delivery-notice adapter + the signed fixed notice) →
 * the normalized observation (provenance + uncertainty preserved) →
 * the VERIFIED measured outcome → the completed VERIFIED lifecycle walk
 * → the W027 counterfactual baseline + the supported pool-bound savings
 * (1000 − 880 = 120 usd) → the VERIFIED Proof-of-Value over the
 * fulfillment subject → the /settlement recognition (the three VERIFIED
 * sources; balanced recognition postings) → the risk/dispute gates
 * (fail closed, then resolved) → the maturation (MATURE) → the W028
 * benefit funding by reference to the MATURE value + the deterministic
 * allocation with the REAL economic draw (the value record CONSUMED) →
 * the ordered lineage reconstruction — through the OWNING boundary at
 * every step, and the end state is globally conserved.
 *
 * The three tests assert, in order: (1) the end-to-end terminal states
 * + conservation; (2) the EXACT 17-witness canonical traversal order
 * (the frozen ledger §3 stage names, the owning authorities, the
 * durable record ids, the fulfillment state ladder with strictly
 * increasing versions); (3) the ordered audit-marker list (44 canonical
 * [eventType, resourceId] markers, positions strictly ascending in the
 * global append-only log) + the policy/version/digest reproducibility
 * witnesses. The scenario runs ONCE (beforeAll) — one deterministic
 * execution, three proofs (the W033/W035 traversal-proof discipline
 * carried forward).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW036Harness,
  runW036Scenario,
  type NetW036Harness,
  type W036Scenario,
} from "./_net-w036-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";

let harness: NetW036Harness;
let scenario: W036Scenario;

beforeAll(async () => {
  harness = await createNetW036Harness();
  scenario = await runW036Scenario(harness);
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W036 full-path scenario (demand pool → benefit allocation)", () => {
  test("ONE demand/procurement execution traverses the complete authoritative chain end-to-end", async () => {
    const runtime = harness.runtime;
    const ctx = harness.poolCreatorCtx("w036-full-path");

    // Stage 1 — the demand pool: tenant-scoped, open, the dual-threshold
    // policy (the pool thresholds 2/2 — the frozen server-side privacy
    // floors 3/3 are enforced regardless); three commitments from three
    // DISTINCT buyer organizations.
    const pool = await runtime.procurementService.getProcurementPool(
      ctx,
      harness.organizationScopeId,
      scenario.pool.id,
    );
    expect(pool.createdBy).toBe(harness.poolCreatorPersonId);
    expect(pool.policy.version).toBe(1);
    expect(pool.policy.minimumCommitments).toBe(2);
    expect(pool.policy.minimumOrganizations).toBe(2);
    expect(pool.closedAt).toBeNull();
    expect(scenario.commitments).toHaveLength(3);
    expect(
      new Set(scenario.commitments.map((c) => c.buyerOrganizationId)).size,
    ).toBe(3);

    // Stage 2 — the gated aggregate disclosure: the commitment count AND
    // the distinct buyer-organization count are SEPARATE dimensions,
    // disclosed only under the correct aggregate gate (both frozen
    // floors met + the active requestor membership).
    const facts = scenario.gatedView.aggregate;
    expect(facts!.commitmentCount).toBe(3);
    expect(facts!.organizationCount).toBe(3);
    const checkMap = new Map(
      scenario.gatedView.checks.map((c) => [c.check, c.satisfied]),
    );
    expect(checkMap.get("privacy_floor_met")).toBe(true);
    expect(checkMap.get("organization_floor_met")).toBe(true);
    expect(checkMap.get("requestor_membership")).toBe(true);
    expect(checkMap.get("qualification_thresholds_met")).toBe(true);
    // The named region group (above-floor) is disclosed; no buyer
    // identity or exact commitment term ever crosses.
    expect(
      facts!.regionGroups.find((g) => g.group === "NA_EAST")?.count,
    ).toBe(3);
    expect(JSON.stringify(facts)).not.toContain(
      scenario.commitments[0]!.submittedBy,
    );

    // Stage 3 — the qualified demand resolved (the reproducible digest).
    expect(scenario.qualifiedView.qualified).toBe(true);
    expect(scenario.qualifiedView.digest).toBe(scenario.gatedView.digest);

    // Stage 4/5 — the offers + the hard eligibility: supplier D's offer
    // exists (recorded through /demand) but is hard-ineligible BEFORE
    // ranking (the revoked tenant membership — the supplier_authorized
    // gate).
    const excluded = await runtime.supplierOfferService.getSupplierOffer(
      ctx,
      harness.organizationScopeId,
      scenario.excludedOfferId,
    );
    expect(excluded.withdrawnAt).toBeNull();
    const excludedEvaluation = scenario.selectionView.offerEvaluations.find(
      (e) => e.offerId === scenario.excludedOfferId,
    )!;
    expect(excludedEvaluation.eligible).toBe(false);
    const authorizationCheck = excludedEvaluation.checks.find(
      (c) => c.check === "supplier_authorized",
    )!;
    expect(authorizationCheck.satisfied).toBe(false);
    expect(authorizationCheck.detail.reason).toBe(
      "supplier_membership_not_active",
    );
    // A/B/C remain eligible.
    for (const offerId of scenario.selectionView.eligibleOfferIds) {
      expect(offerId).not.toBe(scenario.excludedOfferId);
    }
    expect(scenario.selectionView.eligibleOfferIds).toHaveLength(3);

    // Stage 6 — the deterministic competitive selection: supplier A (the
    // cheapest band) at rank 1; the selection is a PROCUREMENT decision
    // (no economic mutation — the conservation proof at the end).
    expect(scenario.selectionView.selectedOfferId).toBe(
      scenario.offers[0]!.id,
    );
    expect(scenario.selectionView.ranking[0]!.supplierPersonId).toBe(
      harness.supplierAPersonId,
    );
    expect(scenario.selection.selectedOfferId).toBe(scenario.offers[0]!.id);
    expect(scenario.selection.selectionPolicy.version).toBe(1);
    expect(scenario.selection.selectionPolicy.rankingCriteria[0]).toBe(
      "unit_price_band_ascending",
    );
    expect(scenario.selection.poolDigest).toBe(scenario.qualifiedView.digest);
    expect(scenario.selection.qualified).toBe(true);

    // Stages 7–9 — the fulfillment subject: the contribution contributed
    // by the SELECTED supplier, VERIFIED at v10 after the sanctioned
    // lifecycle walk.
    const contribution = await runtime.contributionService.getContribution(
      ctx,
      scenario.contribution.id,
    );
    expect(contribution.contributorId).toBe(harness.supplierAPersonId);
    expect(contribution.state).toBe("VERIFIED");
    expect(contribution.version).toBe(10);
    const opportunity = await runtime.opportunityService.getOpportunity(
      ctx,
      scenario.opportunityId,
    );
    expect(opportunity.ownerId).toBe(harness.poolCreatorPersonId);

    // Stage 9 — the measurement: the normalized observation from the
    // REAL provider path (provenance, attribution, uncertainty — the
    // raw vendor payload never crosses).
    const observation = await runtime.outcomeObservationService
      .getOutcomeObservation(ctx, scenario.observation.id);
    expect(observation.provenance.sourceType).toBe("provider");
    expect(observation.provenance.sourceId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(observation.outcomeType).toBe("view");
    expect(observation.providerAttributionMode).toBe("deterministic");
    expect(observation.confidence.point).toBe(0.99);
    expect(observation.subjectReference.subjectId).toBe(
      scenario.contribution.id,
    );

    // The measured outcome: VERIFIED over the provider observation.
    const measurement = await runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      scenario.measuredOutcome.id,
    );
    expect(measurement.state).toBe("VERIFIED");
    expect(measurement.observationIds).toEqual([observation.id]);
    expect(measurement.subjectReference.subjectId).toBe(
      scenario.contribution.id,
    );

    // Stage 10 — the counterfactual baseline: historical window, the
    // quantified interval, the pool-bound evidence reference.
    expect(scenario.baseline.baselineKind).toBe("counterfactual");
    expect(scenario.baseline.confidence.lower).toBeDefined();
    expect(scenario.baseline.confidence.upper).toBeDefined();
    expect(scenario.baseline.evidenceIds).toEqual([
      scenario.poolEvidenceId,
    ]);
    expect(scenario.baseline.createdBy).toBe(harness.poolCreatorPersonId);

    // Stage 11 — the verified savings: server-owned arithmetic
    // (1000 − 880 = 120), the uncertainty preserved, the selection
    // lineage; the PoV over the fulfillment subject VERIFIED.
    expect(scenario.savingsView.supported).toBe(true);
    expect(scenario.savingsView.savings!.value).toBe(120);
    expect(scenario.savingsView.savings!.unit).toBe("usd");
    expect(scenario.savingsView.observedValue!.value).toBe(880);
    expect(scenario.savingsView.derivationPolicy.version).toBe(1);
    expect(scenario.savings.baselineId).toBe(scenario.baseline.id);
    expect(scenario.savings.selectionId).toBe(scenario.selection.id);
    expect(scenario.savings.savings!.value).toBe(120);
    expect(scenario.savings.confidence!.lower).toBeDefined();
    expect(scenario.savings.confidence!.upper).toBeDefined();
    expect(scenario.savings.confidence!.lower).toBeLessThanOrEqual(
      scenario.savings.confidence!.point,
    );
    const proof = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    expect(proof.evidenceIds).toContain(scenario.povPlatformEvidenceId);
    expect(proof.evidenceIds).toContain(scenario.povProviderEvidenceId);
    expect(proof.attestationIds).toContain(scenario.attestationId);
    expect(proof.subjectReference.subjectId).toBe(scenario.contribution.id);

    // Stage 12 — the settlement recognition: PENDING value over the
    // three VERIFIED sources, beneficiary = the pool-creator buyer A,
    // the balanced recognition postings.
    expect(scenario.value.state).toBe("PENDING");
    expect(scenario.value.amount).toBe(120);
    expect(scenario.value.beneficiaryPersonId).toBe(
      harness.poolCreatorPersonId,
    );
    expect(
      scenario.value.sources.map((s) => `${s.kind}:${s.id}`),
    ).toEqual([
      `contribution:${scenario.contribution.id}`,
      `proof_of_value:${scenario.proofOfValueId}`,
      `measured_outcome:${scenario.measuredOutcome.id}`,
    ]);
    expect(scenario.value.recognitionTransactionId).not.toBe("");

    // Stage 13 — the risk/dispute gates: exercised + resolved (the
    // durable audit trail proves both).
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

    // Stage 14 — the maturation: MATURE at the stage boundary…
    expect(scenario.maturedValue.state).toBe("MATURE");

    // Stages 15/16 — the benefits: the pool funded by REFERENCE to the
    // matured value; the deterministic allocation with the REAL economic
    // draw — the value record is CONSUMED by the reward allocation and
    // the plan conserves exactly.
    const benefitPool = await runtime.benefitPoolService.getBenefitPool(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.benefitPool!.id,
      },
    );
    expect(benefitPool.fundingRefs).toEqual([
      { kind: "economic_value", id: scenario.maturedValue.id },
    ]);
    expect(scenario.allocationPlan!.eligible).toBe(true);
    expect(scenario.allocationPlan!.plan!.draw).toBe(true);
    const allocation = scenario.allocation!;
    expect(allocation.status).toBe("recorded");
    expect(allocation.policyId).toBe("w036-benefit-policy");
    expect(allocation.policyVersion).toBe(1);
    expect(allocation.totalAllocated).toBe(120);
    expect(allocation.availableFunding).toBe(120);
    expect(allocation.priorAllocatedTotal).toBe(0);
    expect(allocation.remainderAmount).toBe(0);
    expect(allocation.remainderDisposition).toBe("last_member_absorbs");
    expect(allocation.members.map((m) => m.weight)).toEqual([3, 2, 1]);
    // Σ shares === the funded amount exactly (conservation).
    expect(
      allocation.shares.reduce((sum, share) => sum + share.amount, 0),
    ).toBe(120);
    expect(allocation.shares.map((s) => s.amount)).toEqual([60, 40, 20]);
    expect(allocation.draw).not.toBeNull();
    // The economic draw consumed the matured value record exactly-once.
    const consumed = await runtime.economicValueService.getValue(
      ctx,
      scenario.value.id,
    );
    expect(consumed.state).toBe("CONSUMED");
    expect(consumedByKind(consumed.consumedBy)).toBe("reward_allocation");
    expect(consumed.consumedBy!.id).toBe(allocation.draw!.resultId);

    // The global economic envelope is conserved end-to-end.
    await assertGlobalConservation(harness.w008);
  }, 120_000);

  test("the CANONICAL TRAVERSAL ORDER is proven (the exact 17-witness ledger §3 contract)", async () => {
    const witnesses = scenario.witnesses;

    // (a) The exact 17-stage sequence: the frozen ledger §3 stage names
    // IN ORDER, each with its owning authority.
    expect(witnesses.map((w) => `${w.stage}|${w.authority}`)).toEqual([
      "demand-pool-resolved|/demand",
      "aggregate-disclosure-gated|/demand",
      "qualified-demand-resolved|/demand",
      "supplier-offers-recorded|/demand",
      "supplier-eligibility-evaluated|/demand",
      "competitive-selection-committed|/demand",
      "fulfillment-entered-sanctioned|/workflows",
      "execution-state-observed|/workflows",
      "realized-outcome-normalized|/outcomes",
      "baseline-counterfactual-resolved|/demand",
      "savings-verified-pov-qualified|/demand+evidence",
      "settlement-value-recognized-pending|/settlement",
      "risk-dispute-controls-exercised|/settlement",
      "value-matured|/settlement",
      "benefit-funding-reference-resolved|/benefits",
      "benefit-allocation-committed|/benefits",
      "lineage-reconstruction-completed|audit",
    ]);
    expect(witnesses).toHaveLength(17);

    // (b) The durable record ids: every stage 1–16 carries the stage's
    // OWN authoritative record id (never local generation, never array
    // order); stage 17 (the audit reconstruction) carries none.
    expect(witnesses.map((w) => w.recordId)).toEqual([
      scenario.pool.id,
      scenario.pool.id,
      scenario.pool.id,
      scenario.pool.id,
      scenario.excludedOfferId,
      scenario.selection.id,
      scenario.contribution.id,
      scenario.contribution.id,
      scenario.observation.id,
      scenario.baseline.id,
      scenario.savings.id,
      scenario.value.id,
      scenario.value.id,
      scenario.value.id,
      scenario.benefitPool!.id,
      scenario.allocation!.id,
      null,
    ]);

    // (c) The fulfillment state ladder read through the owning boundary
    // (contributionService.getContribution): null before the subject
    // exists (the W035 pre-subject convention), then the sanctioned
    // /workflows ladder DRAFT(→READY)→ASSIGNED→IN_PROGRESS→(SUBMITTED)→
    // MEASURING→(…walk…)→VERIFIED with strictly increasing versions
    // (v2 ASSIGNED, v3 IN_PROGRESS, v5 MEASURING, v10 VERIFIED).
    expect(witnesses.map((w) => w.fulfillmentState)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      "ASSIGNED",
      "IN_PROGRESS",
      "MEASURING",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
    ]);
    expect(witnesses.map((w) => w.fulfillmentVersion)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      2,
      3,
      5,
      10,
      10,
      10,
      10,
      10,
      10,
      10,
      10,
    ]);
    // The versions never decrease, and each DISTINCT lifecycle state is
    // witnessed at a strictly increasing version (the ladder
    // ASSIGNED v2 → IN_PROGRESS v3 → MEASURING v5 → VERIFIED v10 — every
    // mutation through /workflows, never a local state machine; the
    // post-terminal witnesses hold v10 because NOTHING moves a VERIFIED
    // contribution).
    let previousVersion = Number.NEGATIVE_INFINITY;
    let previousState: string | null = null;
    let previousStateVersion = Number.NEGATIVE_INFINITY;
    for (const w of witnesses) {
      if (w.fulfillmentVersion !== null) {
        expect(w.fulfillmentVersion).toBeGreaterThanOrEqual(previousVersion);
        previousVersion = w.fulfillmentVersion;
        if (w.fulfillmentState !== previousState) {
          expect(w.fulfillmentVersion).toBeGreaterThan(previousStateVersion);
          previousState = w.fulfillmentState;
          previousStateVersion = w.fulfillmentVersion;
        }
      }
    }
  }, 120_000);

  test("the ordered audit-marker lineage is proven (durable, ordered, reproducible)", async () => {
    // (a) The exact ordered canonical marker list (the [eventType,
    // resourceId] pairs the services actually emit, over the scenario's
    // OWN durable identifiers): 44 markers, positions strictly ascending
    // in the global append-only log.
    expect(scenario.auditMarkers.map(([eventType]) => eventType)).toEqual([
      "procurement_pool.created",
      "procurement_commitment.recorded",
      "procurement_commitment.recorded",
      "procurement_commitment.recorded",
      "procurement_offer.recorded",
      "procurement_offer.recorded",
      "procurement_offer.recorded",
      "procurement_offer.recorded",
      "procurement_selection.recorded",
      "opportunity.created",
      "contribution.created",
      "contribution.transition.draft_to_ready",
      "contribution.transition.ready_to_assigned",
      "contribution.transition.assigned_to_in_progress",
      "contribution.transition.in_progress_to_submitted",
      "contribution.transition.submitted_to_measuring",
      "outcome_observation.created",
      "measured_outcome.created",
      "outcome_measurement.transition.draft_to_measuring",
      "measured_outcome.rollup_recorded",
      "outcome_measurement.transition.measuring_to_verified",
      "contribution.transition.measuring_to_evaluating",
      "contribution.transition.settled_to_verified",
      "evidence.created",
      "outcome_observation.created",
      "procurement_baseline.created",
      "procurement_savings.recorded",
      "evidence.created",
      "evidence.created",
      "proof_of_value.created",
      "attestation.created",
      "proof_of_value.aggregated",
      "proof_of_value.transition.evaluating_to_verified",
      "economic_value.recorded",
      "risk_control.activated",
      "risk_control.resolved",
      "dispute.opened",
      "dispute.resolved",
      "economic_value.matured",
      "reward_policy.version_created",
      "benefits_policy.version_created",
      "benefits_pool.created",
      "reward_allocation.recorded",
      "benefits_pool.allocation_recorded",
    ]);

    // (b) The positions re-derived from the durable log: strictly
    // ascending (the commit order corroborates the witness order).
    const log = await harness.runtime.auditWriter.query({
      limit: 1_000_000,
    });
    const positions = scenario.auditMarkers.map(([eventType, resourceId]) => {
      const index = log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
      expect(
        index,
        `missing audit event ${eventType} for ${resourceId}`,
      ).toBeGreaterThanOrEqual(0);
      return index;
    });
    expect([...positions]).toEqual([...scenario.auditPositions]);
    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i]! > positions[i - 1]!,
        `canonical audit order violated at marker ${String(i)} (${scenario.auditMarkers[i]![0]} for ${scenario.auditMarkers[i]![1]})`,
      ).toBe(true);
    }

    // The measurement point PRECEDES the observation; the completed
    // VERIFIED walk + the gate resolutions PRECEDE the maturation + the
    // benefit draw (the ordering the witnesses claim, proven by the
    // durable commit order).
    const measuringIdx = scenario.auditMarkers.findIndex(
      ([t, id]) =>
        t === "contribution.transition.submitted_to_measuring" &&
        id === scenario.contribution.id,
    )!;
    const observationIdx = scenario.auditMarkers.findIndex(
      ([t, id]) =>
        t === "outcome_observation.created" && id === scenario.observation.id,
    )!;
    expect(positions[observationIdx]!).toBeGreaterThan(positions[measuringIdx]!);
    const verifiedIdx = scenario.auditMarkers.findIndex(
      ([t, id]) =>
        t === "contribution.transition.settled_to_verified" &&
        id === scenario.contribution.id,
    )!;
    const recognitionIdx = scenario.auditMarkers.findIndex(
      ([t, id]) =>
        t === "economic_value.recorded" && id === scenario.value.id,
    )!;
    expect(positions[recognitionIdx]!).toBeGreaterThan(positions[verifiedIdx]!);
    const disputeResolvedIdx = scenario.auditMarkers.findIndex(
      ([t, id]) => t === "dispute.resolved" && id === scenario.disputeId,
    )!;
    const maturedIdx = scenario.auditMarkers.findIndex(
      ([t, id]) => t === "economic_value.matured" && id === scenario.value.id,
    )!;
    expect(positions[maturedIdx]!).toBeGreaterThan(
      positions[disputeResolvedIdx]!,
    );

    // (c) The policy/version/digest reproducibility witnesses:
    //  - the pool policy version + the cross-derivation link (the
    //    selection's poolDigest === the qualified-demand digest);
    //  - the selection policy version + the digest reproducibility
    //    (evaluate twice → identical digest);
    //  - the savings derivation policy version;
    //  - the benefit policy version + the allocation digest (the derived
    //    plan preview digest === the recorded allocation digest).
    expect(scenario.pool.policy.version).toBe(1);
    expect(scenario.selectionView.selectionPolicy.version).toBe(1);
    expect(scenario.selectionView.digest).toBe(
      scenario.selectionViewReplay.digest,
    );
    expect(scenario.selection.poolDigest).toBe(scenario.qualifiedView.digest);
    expect(scenario.savingsView.derivationPolicy.version).toBe(1);
    expect(scenario.savings.derivationPolicy.version).toBe(1);
    expect(scenario.savings.digest).toBe(scenario.savingsView.digest);
    expect(scenario.allocationPlan!.policyVersion).toBe(1);
    expect(scenario.allocation!.policyVersion).toBe(1);
    expect(scenario.allocationPlan!.digest).toBe(scenario.allocation!.digest);
  }, 120_000);
});

/** Narrow the consumedBy union for a concise assertion. */
function consumedByKind(
  consumedBy: { readonly kind: string; readonly id: string } | null,
): string {
  expect(consumedBy).not.toBeNull();
  return consumedBy!.kind;
}
