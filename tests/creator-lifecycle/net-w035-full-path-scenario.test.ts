/**
 * NET-W035 — The deterministic FULL-PATH creator scenario (work order
 * §5: "a deterministic full-path traversal test" + §6).
 *
 * ONE canonical creator execution traverses the ENTIRE frozen
 * authoritative chain — creator discovery/matching (W015 + the W016
 * hard-gated match) → campaign contract/terms (the ACTIVE campaign,
 * pinned policy v1, the creator terms set + the escrowed budget) →
 * the W017 acceptance composite (grant + transition) → the sanctioned
 * contribution lifecycle entry (the W012 composite → SUBMITTED) →
 * UGC production + rights (the production bound to the contribution +
 * the durable deliverable + the authoritative rights view) → the
 * engagement completion (SUBMITTED → VERIFIED) → disclosure/compliance
 * (the W018 relationship + publication + declarations + the sanctioned
 * verification gate) → MEASURING → the measurement (the REAL W022
 * provider-selection path) → the outcomes → the evidence/PoV → the
 * PoH evaluation → the completed VERIFIED walk → the risk/dispute
 * gates (fail closed, resolved) → settlement pending/mature → the
 * W030 external payment — through the OWNING boundary at every step,
 * and the end state is globally conserved. The AC suites pin each
 * authority's composition contract in depth, and the third test
 * proves the CANONICAL TRAVERSAL ORDER itself (stage witnesses + the
 * audit commit order) — not just the eventual end-state lineage (the
 * W033 PR #68 architect-remediation discipline carried forward).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";

let harness: NetW035Harness;

beforeAll(async () => {
  harness = await createNetW035Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035 full-path scenario (creator discovery → settlement + payment)", () => {
  test("ONE creator execution traverses the complete authoritative chain end-to-end", async () => {
    const scenario = await runCreatorScenario(harness);
    const runtime = harness.runtime;
    const ctx = harness.creatorCtx("w035-full-path");

    // Stage 1 — the creator: the ACTIVE W015 profile, resolved through
    // the owning boundary; the match: the eligible creator ranked at
    // 1, the restricted candidate hard-excluded before ranking.
    const profile = await runtime.creatorService.getProfileByPerson(
      ctx,
      harness.organizationScopeId,
      harness.creatorPersonId,
    );
    expect(profile!.status).toBe("ACTIVE");
    const run = await runtime.creatorMatchingService.getMatchRun(
      ctx,
      harness.organizationScopeId,
      scenario.matchRunId,
    );
    expect(run.results[0]!.profileId).toBe(scenario.creatorProfileId);
    expect(run.results[0]!.rank).toBe(1);
    expect(
      run.excluded.some(
        (e) => e.profileId === scenario.excludedProfileId,
      ),
    ).toBe(true);

    // Stage 2 — the campaign: ACTIVE, pinned policy v1, the declared
    // compensation/clearing rule with the escrowed budget.
    const campaign = await runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.currentPolicyVersion).toBe(1);

    // Stage 3/4 — the engagement + UGC: the engagement VERIFIED v5
    // with the pinned policy version + the match/opportunity lineage;
    // the production bound to the contribution; the grant ACTIVE.
    const engagement = await runtime.creatorEngagementService.getEngagement(
      ctx,
      harness.organizationScopeId,
      scenario.engagement.id,
    );
    expect(engagement.state).toBe("VERIFIED");
    expect(engagement.version).toBe(5);
    expect(engagement.campaignPolicyVersion).toBe(1);
    expect(engagement.matchRunId).toBe(scenario.matchRunId);
    expect(engagement.opportunityId).toBe(scenario.opportunityId);
    const production = await runtime.creatorEngagementService.getProduction(
      ctx,
      harness.organizationScopeId,
      scenario.production.id,
    );
    expect(production.contributionId).toBe(scenario.contribution.id);
    const rightsView = await runtime.creatorEngagementService.getUsageRights(
      ctx,
      harness.organizationScopeId,
      scenario.usageRightsGrantId,
      null,
    );
    expect(rightsView.effectiveStatus).toBe("ACTIVE");
    expect(rightsView.grant.engagementId).toBe(scenario.engagement.id);
    expect(rightsView.grant.contentOwnership).toBe("creator_retained");

    // Stage 5 — the disclosure/compliance: the relationship, the
    // VERIFIED publication, the declarations for every required kind.
    const relationship =
      await runtime.creatorSponsorshipService.getCommercialRelationship(
        ctx,
        harness.organizationScopeId,
        scenario.relationship.id,
      );
    expect(relationship.engagementId).toBe(scenario.engagement.id);
    const publication = await runtime.creatorSponsorshipService.getPublication(
      ctx,
      harness.organizationScopeId,
      scenario.publication.id,
    );
    expect(publication.state).toBe("VERIFIED");
    const status =
      await runtime.creatorSponsorshipService.getPublicationDisclosureStatus(
        ctx,
        harness.organizationScopeId,
        scenario.publication.id,
      );
    expect(status.satisfied).toBe(true);
    expect(scenario.declarationIds).toHaveLength(2);

    // Stage 6-10 — the execution subject: VERIFIED v10.
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

    // Stage 12 — the settlement + payment: the value MATURE with the
    // server-derived creator lineage; the W030 payment fact linked to
    // the recognition transaction with the derived MATCHED
    // reconciliation (provider integration only — never economic
    // authority).
    const value = await runtime.economicValueService.getValue(
      ctx,
      scenario.matureValue.id,
    );
    expect(value.state).toBe("MATURE");
    expect(value.amount).toBe(100);
    expect(value.sources.map((s) => s.id)).toContain(contribution.id);
    expect(value.sources.map((s) => s.id)).toContain(measurement.id);
    expect(value.beneficiaryPersonId).toBe(harness.creatorPersonId);
    const fact =
      await runtime.externalSettlementService.getExternalSettlementFact(
        harness.operatorCtx("w035-fact-read"),
        harness.organizationScopeId,
        scenario.paymentFact!.id,
      );
    expect(fact!.internalTransactionId).toBe(
      value.recognitionTransactionId,
    );
    const reconciliation =
      await runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        harness.operatorCtx("w035-fact-reconcile"),
        {
          organizationScopeId: harness.organizationScopeId,
          factId: scenario.paymentFact!.id,
        },
      );
    expect(reconciliation.verdict).toBe("matched");
    expect(reconciliation.reason).toBe("amount_matched");

    // The global economic envelope is conserved end-to-end.
    await assertGlobalConservation(
      harness.w018.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  }, 120_000);

  test("the full-path audit lineage exists for EVERY material stage (durable, ordered)", async () => {
    const scenario: CreatorScenario = await runCreatorScenario(harness);
    const audit = harness.runtime.auditWriter;

    // The creator chain: the profile + the match run.
    const profileEvents = await audit.query({
      resourceType: "creator_profile",
      resourceId: scenario.creatorProfileId,
    });
    expect(profileEvents.map((e) => e.eventType)).toContain(
      "creator_profile.created",
    );
    expect(profileEvents.map((e) => e.eventType)).toContain(
      "creator_profile.version_defined",
    );
    const matchEvents = await audit.query({
      resourceType: "creator_match_run",
      resourceId: scenario.matchRunId,
    });
    expect(matchEvents.map((e) => e.eventType)).toContain(
      "creator_match.recorded",
    );

    // The engagement chain: the offer + the usage-rights grant + the
    // five transitions (DRAFT→READY→ASSIGNED→IN_PROGRESS→SUBMITTED→
    // VERIFIED).
    const engagementEvents = (
      await audit.query({
        resourceType: "engagement",
        resourceId: scenario.engagement.id,
      })
    ).filter((e) => e.eventType.startsWith("engagement."));
    expect(engagementEvents.map((e) => e.eventType)).toContain(
      "engagement.offer_recorded",
    );
    expect(
      engagementEvents.filter((e) => e.eventType.startsWith("engagement.transition.")),
    ).toHaveLength(5);
    const grantEvents = await audit.query({
      resourceType: "usage_rights_grant",
      resourceId: scenario.usageRightsGrantId,
    });
    expect(grantEvents.map((e) => e.eventType)).toContain(
      "usage_rights.granted",
    );

    // The contribution lifecycle (10 transitions).
    const contributionTransitions = (
      await audit.query({
        resourceType: "contribution",
        resourceId: scenario.contribution.id,
      })
    ).filter((e) => e.eventType.startsWith("contribution.transition."));
    expect(contributionTransitions).toHaveLength(10);

    // The UGC chain: the production + the deliverable + the
    // submission.
    const productionEvents = await audit.query({
      resourceType: "ugc_production",
      resourceId: scenario.production.id,
    });
    expect(productionEvents.map((e) => e.eventType)).toContain(
      "ugc_production.opened",
    );
    const deliverableEvents = await audit.query({
      resourceType: "ugc_deliverable",
      resourceId: scenario.deliverableId,
    });
    expect(deliverableEvents.map((e) => e.eventType)).toContain(
      "ugc_production.deliverable_recorded",
    );
    const submissionEvents = await audit.query({
      resourceType: "ugc_submission",
      resourceId: scenario.submissionId,
    });
    expect(submissionEvents.map((e) => e.eventType)).toContain(
      "ugc_production.submitted",
    );

    // The disclosure chain: the relationship, the publication record +
    // verification, the declarations.
    const relationshipEvents = await audit.query({
      resourceType: "commercial_relationship",
      resourceId: scenario.relationship.id,
    });
    expect(relationshipEvents.map((e) => e.eventType)).toContain(
      "commercial_relationship.recorded",
    );
    const publicationEvents = await audit.query({
      resourceType: "publication",
      resourceId: scenario.publication.id,
    });
    expect(publicationEvents.map((e) => e.eventType)).toContain(
      "publication.recorded",
    );
    expect(publicationEvents.map((e) => e.eventType)).toContain(
      "publication.verified",
    );
    for (const declarationId of scenario.declarationIds) {
      const declarationEvents = await audit.query({
        resourceType: "disclosure_declaration",
        resourceId: declarationId,
      });
      expect(declarationEvents.map((e) => e.eventType)).toContain(
        "disclosure_declaration.recorded",
      );
    }

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

    // The economic chain: pending → mature → the external payment fact.
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
    const paid = await audit.query({
      eventType: "external_settlement_fact.recorded",
      resourceId: scenario.paymentFact!.id,
    });
    expect(paid).toHaveLength(1);

    await assertGlobalConservation(
      harness.w018.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  }, 120_000);

  test("the CANONICAL TRAVERSAL ORDER is proven (stage witnesses + the audit commit order)", async () => {
    const scenario = await runCreatorScenario(harness);

    // (a) The scenario's ordered stage witnesses: the AUTHORITATIVE
    // engagement AND contribution state + version (each read through
    // its owning boundary) at EVERY stage boundary, PLUS the durable
    // authority record ids for the pre-subject creator stages. The
    // engagement version increments only on engagement lifecycle
    // mutations (v0 DRAFT → v5 VERIFIED) and the contribution version
    // only on contribution lifecycle mutations (v0 DRAFT → v4
    // SUBMITTED → v5 MEASURING → v10 VERIFIED), so this array is a
    // strictly deterministic executable-order proof over BOTH
    // authorities: the creator stages (profile/match) precede the
    // campaign/terms; the acceptance precedes the UGC; the rights
    // precede the disclosure/compliance; the disclosure/compliance
    // precedes the MEASURING point; the MEASURING point (v5) precedes
    // the measurement/outcomes/evidence stages (each witnessed IN
    // MEASURING at v5); the completed VERIFIED walk (v10) precedes the
    // economic stages; the risk/dispute gates precede the maturation.
    expect(
      scenario.traversal.map(
        (w) =>
          `${w.stage}|${w.authority}|${w.engagementState}|${w.engagementVersion}|${w.contributionState}|${w.contributionVersion}`,
      ),
    ).toEqual([
      "creator-resolved|/creators||-1||-1",
      "creator-authorized|/creators||-1||-1",
      "match-hard-gates-passed|/creators||-1||-1",
      "match-committed|/creators||-1||-1",
      "campaign-policy-resolved|/campaigns||-1||-1",
      "opportunity-materialized|/opportunities||-1||-1",
      "terms-pinned|/creators|DRAFT|0||-1",
      "creator-accepted|/creators|ASSIGNED|2||-1",
      "contribution-entered|/contributions|ASSIGNED|2|DRAFT|0",
      "contribution-submitted|/workflows|ASSIGNED|2|SUBMITTED|4",
      "ugc-recorded|/creators|IN_PROGRESS|3|SUBMITTED|4",
      "rights-authorized|/creators|IN_PROGRESS|3|SUBMITTED|4",
      "ugc-submitted|/creators|SUBMITTED|4|SUBMITTED|4",
      "engagement-verified|/workflows|VERIFIED|5|SUBMITTED|4",
      "relationship-recorded|/creators|VERIFIED|5|SUBMITTED|4",
      "publication-recorded|/creators|VERIFIED|5|SUBMITTED|4",
      "disclosure-compliance-satisfied|/creators|VERIFIED|5|SUBMITTED|4",
      "lifecycle-measuring|/workflows|VERIFIED|5|MEASURING|5",
      "measurement-normalized|/measurement→/outcomes|VERIFIED|5|MEASURING|5",
      "outcome-verified|/outcomes|VERIFIED|5|MEASURING|5",
      "evidence-pov-verified|/evidence|VERIFIED|5|MEASURING|5",
      "poh-evaluated|/workflows|VERIFIED|5|MEASURING|5",
      "lifecycle-completed|/workflows|VERIFIED|5|VERIFIED|10",
      "settlement-pending|/settlement|VERIFIED|5|VERIFIED|10",
      "risk-gate-refused|/disputes|VERIFIED|5|VERIFIED|10",
      "risk-gate-resolved|/disputes|VERIFIED|5|VERIFIED|10",
      "dispute-gate-refused|/disputes|VERIFIED|5|VERIFIED|10",
      "dispute-gate-resolved|/disputes|VERIFIED|5|VERIFIED|10",
      "settlement-matured|/settlement|VERIFIED|5|VERIFIED|10",
      "payment-committed|/payments+/adapters|VERIFIED|5|VERIFIED|10",
    ]);

    // (b) The durable audit commit order: the global append-only log
    // preserves insertion order (= committed-mutation order; every
    // material mutation publishes its audit strictly post-commit).
    // The canonical stage markers appear in EXACTLY the declared
    // order: the creator profile → the match run → the campaign → the
    // opportunity → the engagement offer + the acceptance grant → the
    // contribution publication → the UGC production + submission + the
    // engagement verification → the relationship + publication +
    // declarations + the sanctioned verification → the MEASURING
    // lifecycle point → the measurement observation → the outcomes →
    // the evidence/PoV → the walk resumption + completion → the
    // recognition → the risk/dispute gates (exercised + resolved) →
    // the maturation → the external payment fact.
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
      ["creator_profile.created", scenario.creatorProfileId],
      ["creator_match.recorded", scenario.matchRunId],
      ["campaign.created", scenario.campaignId],
      ["opportunity.created", scenario.opportunityId],
      ["engagement.offer_recorded", scenario.engagement.id],
      ["usage_rights.granted", scenario.usageRightsGrantId],
      ["contribution.transition.in_progress_to_submitted", scenario.contribution.id],
      ["ugc_production.opened", scenario.production.id],
      ["engagement.transition.assigned_to_in_progress", scenario.engagement.id],
      ["ugc_production.deliverable_recorded", scenario.deliverableId],
      ["ugc_production.submitted", scenario.submissionId],
      ["engagement.transition.submitted_to_verified", scenario.engagement.id],
      ["commercial_relationship.recorded", scenario.relationship.id],
      ["publication.recorded", scenario.publication.id],
      ["disclosure_declaration.recorded", scenario.declarationIds[0]!],
      ["disclosure_declaration.recorded", scenario.declarationIds[1]!],
      ["publication.verified", scenario.publication.id],
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
      ["external_settlement_fact.recorded", scenario.paymentFact!.id],
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

    // The witnesses 19–21 (the normalized measurement, the outcome,
    // the PoV) CANNOT occur before witness 18 (MEASURING) — and the
    // economic witnesses cannot occur before the workflow completion
    // + the gate resolutions: the audit positions prove it (the
    // measuring transition BEFORE the observation; the VERIFIED walk
    // + the gate resolutions BEFORE the maturation + the payment).
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
      harness.w018.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  }, 120_000);
});
