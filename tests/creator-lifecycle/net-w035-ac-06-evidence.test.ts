/**
 * NET-W035-AC-06 — Evidence / Proof-of-Value (issue #71 §5 AC-06;
 * work order §4.6).
 *
 * The engagement becomes settlement-eligible only through
 * authoritative /evidence verification/PoV semantics. Evidence must
 * link the creator engagement to the required UGC/rights/disclosure/
 * measurement records. Caller-provided grade, confidence or value
 * cannot bypass evidence authority.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  recognizeCreatorValue,
  advanceToMeasuring,
  walkToVerified,
  key,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  publishHelpfulContribution,
} from "../contributions/_net-w012-harness.ts";
import { createCreatorCampaign } from "./_net-w035-harness.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-06 evidence / Proof-of-Value", () => {
  test("the PoV is VERIFIED over real platform + provider evidence + an independent attestation; the campaign evidence policy is satisfied", async () => {
    const ctx = harness.creatorCtx("w035-ac06-pov");
    const proof = await harness.runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    expect(proof.subjectReference.subjectId).toBe(scenario.contribution.id);
    // The evidence bases: platform (the policy's qualifying source
    // type) + provider (the measurement lineage).
    expect(proof.evidenceIds).toContain(scenario.povPlatformEvidenceId);
    expect(proof.evidenceIds).toContain(scenario.povProviderEvidenceId);
    // The independent attestation (the verifier ≠ the evidence owner).
    expect(proof.attestationIds).toContain(scenario.attestationId);
    const attestation = await harness.runtime.attestationService.getAttestation(
      ctx,
      scenario.attestationId,
    );
    expect(attestation.verifierId).toBe(harness.operatorPersonId);
    // The campaign evidence policy (a PoV, ATTESTED minimum, platform
    // sources) is satisfied by the derived grade over the platform
    // evidence.
    const platformEvidence = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povPlatformEvidenceId,
    );
    expect(platformEvidence.provenance.sourceType).toBe("platform");
  });

  test("the evidence-to-measurement lineage: the provider evidence cites the measurement provider", async () => {
    const ctx = harness.creatorCtx("w035-ac06-lineage");
    const providerEvidence = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povProviderEvidenceId,
    );
    expect(providerEvidence.provenance.sourceType).toBe("provider");
    expect(providerEvidence.provenance.sourceId).toBe(
      scenario.measurementProviderId,
    );
    // The observation's provenance cites the SAME provider — the
    // evidence↔measurement join is the durable lineage.
    expect(scenario.observation.provenance.sourceId).toBe(
      providerEvidence.provenance.sourceId,
    );
  });

  test("the PoH bases carry the full required lineage (PoV + measured outcome + evidence record — all subject-bound)", async () => {
    const ctx = harness.creatorCtx("w035-ac06-poh");
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      ctx,
      scenario.contribution.id,
    );
    expect(poh.state).toBe("QUALIFIED");
    const basisKinds = poh.bases.map((b) => b.kind).sort();
    expect(basisKinds).toContain("proof_of_value");
    expect(basisKinds).toContain("measured_outcome");
    expect(basisKinds).toContain("evidence_record");
    // Every basis reference is one of the scenario's durable records.
    const referenceIds = poh.bases.map((b) => b.referenceId);
    expect(referenceIds).toContain(scenario.proofOfValueId);
    expect(referenceIds).toContain(scenario.measuredOutcome.id);
    expect(referenceIds).toContain(scenario.basisEvidenceId);
  });

  test("the PoV lifecycle requires the SANCTIONED sequence (verification without aggregation fails closed)", async () => {
    const ctx = harness.creatorCtx("w035-ac06-sequence");
    // A fresh PoV over the scenario's platform evidence — driven to
    // EVALUATING but NEVER aggregated: the verification refuses (the
    // sanctioned sequence: aggregation + attestations BEFORE
    // verification).
    const proof = await harness.runtime.proofOfValueService.createProofOfValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        evidenceIds: [scenario.povPlatformEvidenceId],
      },
    );
    await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
      proofId: proof.id,
      expectedVersion: proof.version,
      idempotencyKey: key("w035-ac06-seq-begin"),
      actorPersonId: harness.creatorPersonId,
    });
    await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, {
      proofId: proof.id,
      expectedVersion: 1,
      idempotencyKey: key("w035-ac06-seq-evaluating"),
      actorPersonId: harness.creatorPersonId,
    });
    await expect(
      harness.runtime.proofOfValueService.verify(ctx, {
        proofId: proof.id,
        expectedVersion: 2,
        idempotencyKey: key("w035-ac06-seq-verify"),
        actorPersonId: harness.creatorPersonId,
      }),
    ).rejects.toMatchObject({ code: "PROOF_OF_VALUE_VALIDATION" });
  });

  test("a lifecycle-completed contribution with NO verified evidence cannot enter settlement (the evidence authority is non-bypassable)", async () => {
    // A FRESH execution subject: the full sanctioned lifecycle walk
    // (the W012 composite → SUBMITTED → MEASURING → … → VERIFIED)
    // WITHOUT any measurement/outcome/PoV evidence or PoH evaluation.
    // The recognition composite must refuse: lifecycle completion
    // alone never authorizes economic value.
    const { campaign } = await createCreatorCampaign(harness);
    const operatorForCampaign = harness.operatorCtx("w035-ac06-opportunity");
    const draft = await harness.runtime.campaignService.resolveOpportunityDraft(
      operatorForCampaign,
      campaign.id,
      "spec-1",
    );
    const opportunity =
      await harness.runtime.opportunityService.createOpportunity(
        operatorForCampaign,
        {
          organizationScopeId: draft.organizationScopeId,
          ownerId: campaign.ownerPersonId,
          opportunityType: draft.opportunityType,
          title: draft.title,
          brief: draft.brief,
          eligibilityPolicyReference: draft.eligibilityPolicyReference,
          contributionRequirements: draft.contributionRequirements,
          evidenceReferencePlaceholders: draft.evidenceReferencePlaceholders,
        },
      );
    const policy = await createHelpfulnessPolicy(harness.w012, {
      policyId: key("w035-ac06-poh-policy"),
      qualifyingOutcomeTypes: ["view"],
    });
    const { contribution } = await createHelpfulContribution(harness.w012, {
      opportunityId: opportunity.id,
      helpfulnessPolicyId: policy.policyId,
      claimantAttributes: {
        participant_class: ["contributor"],
        region: ["GH"],
        language: ["en"],
      },
      idempotencyKey: key("w035-ac06-contribution"),
    });
    await publishHelpfulContribution(harness.w012, contribution.id);
    await advanceToMeasuring(harness, contribution.id);
    const verified = await walkToVerified(harness, contribution.id);
    expect(verified.state).toBe("VERIFIED");
    // The recognition FAILS CLOSED: the PoH is not QUALIFIED (no
    // verified evidence bases — caller assertions cannot substitute).
    await expect(
      recognizeCreatorValue(harness, contribution.id, {
        amount: 50,
        idempotencyKey: key("w035-ac06-recognize"),
      }),
    ).rejects.toMatchObject({ code: "ECONOMIC_VALIDATION" });
  });

  test("the PoH basis attachment requires a REAL referenced record (a fabricated reference fails closed)", async () => {
    await expect(
      harness.runtime.helpfulnessService.attachBasis(
        harness.creatorCtx("w035-ac06-fabricated"),
        {
          contributionId: scenario.contribution.id,
          kind: "proof_of_value",
          referenceId: "no-such-proof-of-value",
          idempotencyKey: key("w035-ac06-fabricated"),
        },
      ),
    ).rejects.toMatchObject({ code: "HELPFUL_CONTRIBUTION_VALIDATION" });
  });
});
