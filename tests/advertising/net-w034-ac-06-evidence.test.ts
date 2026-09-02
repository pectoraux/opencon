/**
 * NET-W034-AC-06 — Evidence / Proof-of-Value authority (issue #69 §5
 * AC-06).
 *
 * The measurement result becomes settlement-eligible only through
 * authoritative `/evidence` Proof-of-Value/evidence verification
 * semantics. Caller-supplied grade, confidence or economic value
 * cannot bypass the evidence authority. The declared evidence
 * requirements of the campaign policy are satisfied before the
 * lifecycle's evidence-gated transition.
 *  - the VERIFIED PoV over /evidence-created records (derived grades,
 *    the recorded aggregation, the cryptographic attestation);
 *  - the campaign evidence policy satisfaction (a PoV, ATTESTED
 *    minimum, platform sources — the derived platform-evidence grade
 *    satisfies the declared minimum);
 *  - the evidence-to-measurement lineage (the PoV's provider evidence
 *    cites the SAME measurement provider that produced the
 *    observation; the PoH bases chain the contribution);
 *  - caller-assertion rejection: verification WITHOUT aggregation
 *    fails closed; WITHOUT an attestation fails closed;
    * self-reported-only evidence fails closed;
 *  - the structural no-grade/no-value input pin (the evidence
 *    creation input carries NO grade, NO economic value — the grade
 *    is DERIVED from provenance);
 *  - the evidence-gated lifecycle transition ordering (the PoV exists
 *    BEFORE the MEASURING → EVALUATING transition committed).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  key,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import {
  EVIDENCE_GRADE_RANK,
  EVIDENCE_GRADES,
} from "../../src/core/evidence.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-06 evidence / Proof-of-Value authority", () => {
  test("the PoV is VERIFIED over /evidence-created records with the derived grades + the cryptographic attestation", async () => {
    const ctx = harness.creatorCtx("w034-ac06-pov");
    const proof = await harness.runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    expect(proof.evidenceIds).toContain(scenario.povPlatformEvidenceId);
    expect(proof.evidenceIds).toContain(scenario.povProviderEvidenceId);
    expect(proof.attestationIds).toContain(scenario.attestationId);
    // The recorded aggregation (the evaluation actually ran).
    expect(proof.aggregation).not.toBeNull();
    expect(proof.aggregation!.evidenceCount).toBe(2);
    expect(proof.aggregation!.independentSources).toBeGreaterThanOrEqual(2);
    // The attestation verifies cryptographically (the verify gate
    // already proved it — the VERIFIED state is the witness).
    const attestation = await harness.runtime.attestationService.getAttestation(
      ctx,
      scenario.attestationId,
    );
    expect(attestation.verifierId).toBe(harness.operatorPersonId);
    expect(attestation.evidenceIds).toEqual([
      scenario.povPlatformEvidenceId,
      scenario.povProviderEvidenceId,
    ]);
  });

  test("the CAMPAIGN evidence policy is satisfied by the derived evidence (PoV + ATTESTED minimum + platform sources)", async () => {
    const ctx = harness.creatorCtx("w034-ac06-policy");
    // The campaign's declared evidence policy (read through
    // /campaigns): a proof_of_value requirement, ATTESTED minimum,
    // platform qualifying sources.
    const versions =
      await harness.runtime.campaignService.listPolicyVersions(
        ctx,
        scenario.campaignId,
      );
    const requirement = versions[0]!.evidencePolicy.requirements[0]!;
    expect(requirement.requirementKind).toBe("proof_of_value");
    expect(requirement.minimumGrade).toBe("ATTESTED");
    expect(requirement.qualifyingSourceTypes).toContain("platform");
    const minimumGrade = requirement.minimumGrade ?? "ATTESTED";
    // The PoV exists and is VERIFIED (the requirement kind).
    const proof = await harness.runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    // The platform evidence: a PLATFORM source whose DERIVED grade
    // (MEASURED — rank 1, better than ATTESTED) satisfies the ATTESTED
    // minimum (grades are derived from provenance — never
    // caller-supplied; rank 1 = best).
    const platformEvidence = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povPlatformEvidenceId,
    );
    expect(platformEvidence.provenance.sourceType).toBe("platform");
    expect(platformEvidence.grade).toBe("MEASURED");
    expect(
      EVIDENCE_GRADE_RANK[platformEvidence.grade] <=
        EVIDENCE_GRADE_RANK[minimumGrade as keyof typeof EVIDENCE_GRADE_RANK],
    ).toBe(true);
    expect(EVIDENCE_GRADES).toContain(platformEvidence.grade);
  });

  test("the evidence-to-measurement lineage: the PoV's provider evidence cites the measurement provider", async () => {
    const ctx = harness.creatorCtx("w034-ac06-lineage");
    // The provider evidence's provenance cites the SAME provider id
    // that produced the normalized observation (the
    // evidence-to-measurement reconstruction).
    const providerEvidence = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povProviderEvidenceId,
    );
    expect(providerEvidence.provenance.sourceType).toBe("provider");
    expect(providerEvidence.provenance.sourceId).toBe(
      OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(providerEvidence.provenance.method).toBe("openrtb-delivery-notice");
    // ... and the observation's provenance sourceId is the SAME
    // provider (the reconstruction closes).
    expect(scenario.observation.provenance.sourceId).toBe(
      providerEvidence.provenance.sourceId,
    );
    // Both evidence records are subject-bound to the ADVERTISING
    // EXECUTION contribution.
    expect(providerEvidence.subjectReference).toEqual({
      subjectId: scenario.contribution.id,
      subjectType: "contribution",
    });
    // The PoH bases chain the contribution to the PoV + the measured
    // outcome + the evidence record (the settlement source lineage).
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      ctx,
      scenario.contribution.id,
    );
    const basisKinds = poh.bases.map((b) => b.kind);
    expect(basisKinds).toContain("proof_of_value");
    expect(basisKinds).toContain("measured_outcome");
    expect(basisKinds).toContain("evidence_record");
    expect(poh.state).toBe("QUALIFIED");
  });

  test("caller-assertion rejection: verification WITHOUT aggregation fails closed", async () => {
    const ctx = harness.creatorCtx("w034-ac06-no-aggregation");
    // A fresh PoV over the same evidence, walked to EVALUATING but
    // NOT aggregated: verify fails closed.
    const e1 = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: {
        subjectId: scenario.contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "platform",
        sourceId: "platform-w034-ac06",
        method: "platform-counter",
      },
      confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
      sensitivity: "standard",
      payload: { verified: true },
    });
    const e2 = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: {
        subjectId: scenario.contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "provider",
        sourceId: OPENRTB_DELIVERY_PROVIDER_ID,
        method: "openrtb-delivery-notice",
      },
      confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
      sensitivity: "standard",
      payload: { verified: true },
    });
    const proof = await harness.runtime.proofOfValueService.createProofOfValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        evidenceIds: [e1.id, e2.id],
      },
    );
    await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
      proofId: proof.id,
      expectedVersion: proof.version,
      idempotencyKey: key("w034-ac06-begin"),
      actorPersonId: harness.creatorPersonId,
    });
    await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, {
      proofId: proof.id,
      expectedVersion: 1,
      idempotencyKey: key("w034-ac06-evaluating"),
      actorPersonId: harness.creatorPersonId,
    });
    // NO aggregation: verify fails closed (the evaluation must run).
    await expect(
      harness.runtime.proofOfValueService.verify(ctx, {
        proofId: proof.id,
        expectedVersion: 2,
        idempotencyKey: key("w034-ac06-verify-no-agg"),
        actorPersonId: harness.creatorPersonId,
      }),
    ).rejects.toMatchObject({ code: "PROOF_OF_VALUE_VALIDATION" });
  });

  test("caller-assertion rejection: verification WITHOUT an attestation fails closed", async () => {
    const ctx = harness.creatorCtx("w034-ac06-no-attestation");
    // A fresh PoV, aggregated but with NO attestation: verify fails
    // closed (an attestation RECORD's existence proves nothing —
    // the cryptographic verification is required).
    const e1 = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: {
        subjectId: scenario.contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "platform",
        sourceId: "platform-w034-ac06-att",
        method: "platform-counter",
      },
      confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
      sensitivity: "standard",
      payload: { verified: true },
    });
    const proof = await harness.runtime.proofOfValueService.createProofOfValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        evidenceIds: [e1.id],
      },
    );
    await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
      proofId: proof.id,
      expectedVersion: proof.version,
      idempotencyKey: key("w034-ac06-att-begin"),
      actorPersonId: harness.creatorPersonId,
    });
    await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, {
      proofId: proof.id,
      expectedVersion: 1,
      idempotencyKey: key("w034-ac06-att-evaluating"),
      actorPersonId: harness.creatorPersonId,
    });
    await harness.runtime.proofOfValueService.aggregateEvidence(
      ctx,
      proof.id,
    );
    // NO attestation attached: verify fails closed.
    await expect(
      harness.runtime.proofOfValueService.verify(ctx, {
        proofId: proof.id,
        expectedVersion: 2,
        idempotencyKey: key("w034-ac06-verify-no-att"),
        actorPersonId: harness.creatorPersonId,
      }),
    ).rejects.toMatchObject({ code: "PROOF_OF_VALUE_VALIDATION" });
  });

  test("caller-assertion rejection: SELF-REPORTED-only evidence cannot verify (architecture-lock §4)", async () => {
    const ctx = harness.creatorCtx("w034-ac06-self-reported");
    // A PoV over ONLY self-reported evidence: verify fails closed —
    // model-assessed or self-reported evidence alone can never mint
    // verification (and downstream, economic value).
    const selfReported =
      await harness.runtime.evidenceService.createEvidence(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        provenance: {
          sourceType: "self",
          sourceId: "author-w034",
          method: "author-claim",
        },
        confidence: { point: 0.99 },
        sensitivity: "standard",
        payload: { verified: true, callerGrade: "ATTESTED" },
      });
    // The grade is DERIVED from provenance — the caller's
    // "callerGrade" payload field is inert (the derived grade is
    // SELF_REPORTED, never the claimed one).
    expect(selfReported.grade).toBe("SELF_REPORTED");
    const proof = await harness.runtime.proofOfValueService.createProofOfValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        evidenceIds: [selfReported.id],
      },
    );
    await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
      proofId: proof.id,
      expectedVersion: proof.version,
      idempotencyKey: key("w034-ac06-sr-begin"),
      actorPersonId: harness.creatorPersonId,
    });
    const attestation = await harness.runtime.attestationService.createAttestation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.operatorPersonId,
        statement: "attested over self-reported evidence (the negative fixture)",
        evidenceIds: [selfReported.id],
      },
    );
    await harness.runtime.proofOfValueService.attachAttestation(
      ctx,
      proof.id,
      attestation.id,
    );
    await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, {
      proofId: proof.id,
      expectedVersion: 1,
      idempotencyKey: key("w034-ac06-sr-evaluating"),
      actorPersonId: harness.creatorPersonId,
    });
    await harness.runtime.proofOfValueService.aggregateEvidence(
      ctx,
      proof.id,
    );
    await expect(
      harness.runtime.proofOfValueService.verify(ctx, {
        proofId: proof.id,
        expectedVersion: 2,
        idempotencyKey: key("w034-ac06-sr-verify"),
        actorPersonId: harness.creatorPersonId,
      }),
    ).rejects.toMatchObject({ code: "PROOF_OF_VALUE_VALIDATION" });
  });

  test("the structural no-grade/no-value input pin: the evidence creation input carries NO grade and NO economic value", async () => {
    // The /evidence port's creation input is provenance/confidence/
    // payload/commitment only: the grade is DERIVED server-side and
    // economic value is unrepresentable at this boundary.
    const evidencePort = await harness.runtime.evidenceService.createEvidence(
      harness.creatorCtx("w034-ac06-structural"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        provenance: {
          sourceType: "platform",
          sourceId: "platform-w034-ac06-structural",
          method: "platform-counter",
        },
        confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
        sensitivity: "standard",
        // A payload field NAMED "grade" or "amount" is inert — it is
        // NOT a grade input, NOT an economic value input.
        payload: {
          note: "payload facts are non-sensitive inline facts only",
          grade: "ATTESTED",
          amount: 1000,
        },
      },
    );
    // The DERIVED grade (from the platform provenance — MEASURED,
    // the platform-counter derivation), never the payload's claimed
    // "grade".
    expect(evidencePort.grade).toBe("MEASURED");
    expect(evidencePort.payload).not.toBeNull();
    // The payload's claimed "grade" is INERT data (an inline fact) —
    // it never feeds the derived grade (MEASURED ≠ the claimed
    // ATTESTED) and it never mints economic surface: the record's
    // TOP-LEVEL fields carry no economic reference (the economic
    // value lives ONLY in /settlement — the value record references
    // the evidence as a source, never the reverse).
    const recordKeys = Object.keys(evidencePort).sort();
    expect(recordKeys).not.toContain("economicValueId");
    expect(recordKeys).not.toContain("valueRecordId");
    expect(recordKeys).not.toContain("amount");
    expect(recordKeys).toContain("grade");
  });

  test("the evidence-gated lifecycle transition ordering: the PoV/evidence existed BEFORE the MEASURING → EVALUATING transition", async () => {
    // The transition table DECLARES the MEASURING → EVALUATING edge
    // evidence-gated; the W034 scenario proves the declared order
    // through the durable audit commit order (the W033 lesson: never
    // local array order).
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    const povVerified = pos("evidence.created", scenario.povProviderEvidenceId);
    const basisEvidence = pos("evidence.created", scenario.basisEvidenceId);
    const measuredOutcome = pos(
      "measured_outcome.created",
      scenario.measuredOutcome.id,
    );
    const evaluatingTransition = pos(
      "contribution.transition.measuring_to_evaluating",
      scenario.contribution.id,
    );
    expect(evaluatingTransition).toBeGreaterThan(povVerified);
    expect(evaluatingTransition).toBeGreaterThan(basisEvidence);
    expect(evaluatingTransition).toBeGreaterThan(measuredOutcome);
    // The witness array corroborates: the evidence stage was witnessed
    // IN MEASURING at v5, before the walk completed at v10.
    const stages = scenario.traversal.map((w) => w.stage);
    expect(stages.indexOf("evidence-pov-verified")).toBeLessThan(
      stages.indexOf("lifecycle-completed"),
    );
    const evidenceWitness =
      scenario.traversal[stages.indexOf("evidence-pov-verified")]!;
    expect(evidenceWitness.contributionState).toBe("MEASURING");
    expect(evidenceWitness.contributionVersion).toBe(5);
  });
});
