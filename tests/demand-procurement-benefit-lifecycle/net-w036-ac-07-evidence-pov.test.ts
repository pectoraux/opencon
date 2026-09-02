/**
 * NET-W036 AC-07 — Evidence / Proof-of-Value (work order §5 AC-07 + the
 * frozen ledger §4 + §3.3): the VERIFIED evidence/PoV authority that
 * authorizes downstream value ONLY through `/evidence` — the canonical
 * PoV over the fulfillment contribution (MEASURED-grade platform
 * evidence + provider evidence whose provenance cites the measurement
 * provider that produced the normalized outcome), the independent
 * buyer-A cryptographic attestation, the deterministic aggregation,
 * and the EVALUATING → VERIFIED transition through the owning
 * boundary. Caller/provider/model GRADE, confidence or savings
 * assertions never mint value: a model/self-only PoV can aggregate
 * but can NEVER verify; verification bypass attempts (DRAFT/MEASURING,
 * no attestation, zero evidence) fail closed; an unverified PoV
 * blocks /settlement recognition with ECONOMIC_VALIDATION while
 * nothing is recorded, posted or audited; a tampered attestation
 * signature (or an attestation covering evidence the PoV does not
 * carry) fails closed — nothing mints.
 *
 * Mutation targets covered (ledger §4): trust caller grade/value;
 * bypass verification; sever outcome-to-evidence lineage.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac07-…`),
 * the harness's FIXED anchors (W036_EVIDENCE_CAPTURED_AT for every
 * locally-fabricated evidence provenance collectedAt) — NO `Date.now(`,
 * NO `randomUUID`, NO `new Date(` code tokens in this file (the only
 * wall-clock reads are the authorities' own server-set timestamps).
 * ONE harness per file (the W025..W027/W036 AC-suite precedent).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW036Harness,
  requestContributionTransition,
  submitFulfillmentMeasurement,
  createVerifiedMeasuredOutcomeForSubject,
  walkToVerified,
  W036_EVIDENCE_CAPTURED_AT,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import {
  aggregateEvidence as aggregateEvidenceRecords,
} from "../../src/evidence/aggregation.ts";
import type { OpenConError } from "../../src/core/errors.ts";
import type { Evidence, ProofOfValue, Attestation } from "../../src/evidence/port.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type {
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";

let harness: NetW036Harness;

// The canonical AC-07 fulfillment chain (built in beforeAll — the
// real provider measurement + the VERIFIED lifecycle walk, mirroring
// the canonical scenario's stages 7–9).
let contribution: Contribution;
let observation: OutcomeObservation;
let measuredOutcome: MeasuredOutcome;

// The canonical VERIFIED PoV (built in test 1, consumed by the
// lineage/recognition proofs in test 6).
let canonicalPov: ProofOfValue;
let platformEvidence: Evidence;
let providerEvidence: Evidence;
let canonicalAttestation: Attestation;

// The unverified PoVs the economics negative consumes.
let modelPovId = "";
let draftPovId = "";

beforeAll(async () => {
  harness = await createNetW036Harness();
  contribution = await seedVerifiedFulfillmentSubject();
  const measurement = await submitFulfillmentMeasurement(
    harness,
    contribution.id,
  );
  observation = measurement.observation;
  measuredOutcome = await createVerifiedMeasuredOutcomeForSubject(
    harness,
    contribution.id,
    observation.id,
  );
  contribution = await walkToVerified(harness, contribution.id);
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Deterministic fixtures (fixed keys; the seed its OWN pool — the
// AC-01..06 suite discipline)
// ---------------------------------------------------------------------------

/**
 * The canonical AC-07 fulfillment subject: a qualified three-buyer
 * pool → the supplier-A offer → the recorded competitive selection →
 * the opportunity → the contribution, walked through the sanctioned
 * /workflows ladder to the MEASUREMENT POINT (MEASURING) — the same
 * construction the canonical scenario uses for stages 1–7.
 */
async function seedVerifiedFulfillmentSubject(): Promise<Contribution> {
  const runtime = harness.runtime;
  const scope = harness.organizationScopeId;
  const buyerA = harness.poolCreatorCtx("w036-ac07-seed");
  const pool = (
    await runtime.procurementService.createProcurementPool(buyerA, {
      organizationScopeId: scope,
      name: "W036 AC-07 Evidence PoV Pool",
      categoryKey: "cloud_infrastructure",
      qualificationPolicy: {
        minimumCommitments: 2,
        minimumOrganizations: 2,
      },
      idempotencyKey: "w036-ac07-pool",
    })
  ).pool;
  const commitmentSeeds: readonly {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-ac07-commit-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: "w036-ac07-commit-a",
    },
    {
      ctx: harness.buyerBCtx("w036-ac07-commit-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: "w036-ac07-commit-b",
    },
    {
      ctx: harness.buyerCCtx("w036-ac07-commit-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: "w036-ac07-commit-c",
    },
  ];
  for (const seed of commitmentSeeds) {
    await runtime.procurementService.createProcurementCommitment(
      seed.ctx,
      {
        organizationScopeId: scope,
        poolId: pool.id,
        buyerOrganizationId: seed.buyerOrganizationId,
        attributes: {
          region: "NA_EAST",
          quantity: seed.quantity,
          budgetBand: "band_b_1k_9k",
          unitPriceBand: "price_b_10_49",
          timingWindow: "window_short_1_3mo",
        },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: seed.key,
      },
    );
  }
  await runtime.supplierOfferService.createSupplierOffer(
    harness.supplierACtx("w036-ac07-offer-a"),
    {
      organizationScopeId: scope,
      poolId: pool.id,
      attributes: {
        region: "NA_EAST",
        unitPriceBand: "price_a_under_10",
        timingWindow: "window_short_1_3mo",
        quantityBucket: "q_100_999",
      },
      validUntil: null,
      consent: { scope: "competitive_selection" },
      idempotencyKey: "w036-ac07-offer-a",
    },
  );
  const selection = (
    await runtime.supplierOfferService.recordCompetitiveSelection(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      idempotencyKey: "w036-ac07-selection",
    })
  ).selection;
  const opportunity = await runtime.opportunityService.createOpportunity(
    harness.poolCreatorCtx("w036-ac07-opportunity"),
    {
      organizationScopeId: scope,
      ownerId: harness.poolCreatorPersonId,
      opportunityType: "procurement-fulfillment",
      title: "W036 AC-07 Fulfillment Opportunity",
      brief: {
        kind: "procurement_fulfillment",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  const created = await runtime.contributionService.createContribution(
    harness.supplierACtx("w036-ac07-contribution"),
    {
      opportunityId: opportunity.id,
      contributorId: harness.supplierAPersonId,
      organizationScopeId: scope,
      contributionType: "procurement-fulfillment",
      submission: {
        kind: "fulfillment_execution",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  const ladder: readonly (
    | "READY"
    | "ASSIGNED"
    | "IN_PROGRESS"
    | "SUBMITTED"
    | "MEASURING"
  )[] = ["READY", "ASSIGNED", "IN_PROGRESS", "SUBMITTED", "MEASURING"];
  for (const [index, state] of ladder.entries()) {
    await requestContributionTransition(
      harness,
      created.id,
      state,
      `w036-ac07-t${String(index + 1)}`,
    );
  }
  return created;
}

/**
 * Create one /evidence record over the fulfillment contribution with
 * the FIXED collectedAt anchor (stored verbatim — /evidence never
 * freshness-gates collectedAt).
 */
async function createFulfillmentEvidence(
  sourceType: "platform" | "provider" | "model" | "self",
  sourceId: string,
  method: string,
): Promise<Evidence> {
  return harness.runtime.evidenceService.createEvidence(
    harness.supplierACtx("w036-ac07-evidence"),
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.supplierAPersonId,
      subjectReference: {
        subjectId: contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType,
        sourceId,
        method,
        collectedAt: W036_EVIDENCE_CAPTURED_AT,
      },
      confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
      sensitivity: "standard",
      payload: { verified: true },
    },
  );
}

/** Create a DRAFT PoV over the fulfillment contribution. */
async function createDraftPoV(
  evidenceIds: readonly string[],
): Promise<ProofOfValue> {
  return harness.runtime.proofOfValueService.createProofOfValue(
    harness.supplierACtx("w036-ac07-pov"),
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.supplierAPersonId,
      subjectReference: {
        subjectId: contribution.id,
        subjectType: "contribution",
      },
      evidenceIds,
    },
  );
}

/** Drive one PoV DRAFT → MEASURING (fixed key suffix). */
async function beginMeasuring(
  proofId: string,
  keySuffix: string,
): Promise<void> {
  await harness.runtime.proofOfValueService.beginMeasuring(
    harness.supplierACtx("w036-ac07-pov-begin"),
    {
      proofId,
      expectedVersion: 0,
      idempotencyKey: `w036-ac07-pov-begin-${keySuffix}`,
      actorPersonId: harness.supplierAPersonId,
    },
  );
}

/** Drive one PoV MEASURING → EVALUATING (fixed key suffix). */
async function completeGathering(
  proofId: string,
  keySuffix: string,
): Promise<void> {
  await harness.runtime.proofOfValueService.completeEvidenceGathering(
    harness.supplierACtx("w036-ac07-pov-evaluating"),
    {
      proofId,
      expectedVersion: 1,
      idempotencyKey: `w036-ac07-pov-evaluating-${keySuffix}`,
      actorPersonId: harness.supplierAPersonId,
    },
  );
}

/**
 * The independent buyer-A attestation over the given evidence (the
 * demand owner — NEVER the PoV owner — mirrors the harness's
 * canonical construction).
 */
async function createBuyerAttestation(
  evidenceIds: readonly string[],
  statement: string,
): Promise<Attestation> {
  return harness.runtime.attestationService.createAttestation(
    harness.poolCreatorCtx("w036-ac07-attestation"),
    {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.poolCreatorPersonId,
      statement,
      evidenceIds,
    },
  );
}

/** Attempt PoV verify and return the thrown error (fails if it succeeds). */
async function expectVerifyFails(
  proofId: string,
  expectedVersion: number,
  keySuffix: string,
): Promise<OpenConError> {
  let caught: unknown = null;
  try {
    await harness.runtime.proofOfValueService.verify(
      harness.supplierACtx("w036-ac07-pov-verify"),
      {
        proofId,
        expectedVersion,
        idempotencyKey: `w036-ac07-pov-verify-${keySuffix}`,
        actorPersonId: harness.supplierAPersonId,
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeTruthy();
  return caught as OpenConError;
}

describe("NET-W036-AC-07 evidence / Proof-of-Value (the /evidence authority)", () => {
  test("POSITIVE: the canonical PoV over the fulfillment contribution verifies through /evidence — MEASURED-grade evidence attached, deterministic aggregation recorded, the independent cryptographic attestation verified against the stored commitments, state VERIFIED read through the owning boundary", async () => {
    const runtime = harness.runtime;
    const ctx = harness.supplierACtx("w036-ac07-positive");

    // (a) The two canonical evidence records: the platform evidence
    //     (grade MEASURED — the deterministic rule table derives the
    //     grade from the provenance source type ALONE) + the provider
    //     evidence whose provenance cites the MEASUREMENT PROVIDER
    //     that produced the normalized outcome (the
    //     outcome→evidence lineage). Provenance + confidence are
    //     recorded verbatim.
    platformEvidence = await createFulfillmentEvidence(
      "platform",
      "platform-w036-ac07",
      "platform-counter",
    );
    providerEvidence = await createFulfillmentEvidence(
      "provider",
      OPENRTB_DELIVERY_PROVIDER_ID,
      "openrtb-delivery-notice",
    );
    expect(platformEvidence.grade).toBe("MEASURED");
    expect(providerEvidence.grade).toBe("PROVIDER_REPORTED");
    for (const evidence of [platformEvidence, providerEvidence]) {
      expect(evidence.subjectReference).toEqual({
        subjectId: contribution.id,
        subjectType: "contribution",
      });
      expect(evidence.provenance.collectedAt).toBe(W036_EVIDENCE_CAPTURED_AT);
      expect(evidence.confidence).toEqual({
        point: 0.9,
        lower: 0.85,
        upper: 0.95,
      });
    }
    expect(providerEvidence.provenance.sourceId).toBe(
      observation.provenance.sourceId,
    );

    // (b) The PoV: DRAFT over the fulfillment subject with BOTH
    //     evidence records attached, then the sanctioned ladder.
    canonicalPov = await createDraftPoV([
      platformEvidence.id,
      providerEvidence.id,
    ]);
    expect(canonicalPov.state).toBe("DRAFT");
    expect(canonicalPov.version).toBe(0);
    expect(canonicalPov.ownerId).toBe(harness.supplierAPersonId);
    expect(canonicalPov.subjectReference).toEqual({
      subjectId: contribution.id,
      subjectType: "contribution",
    });

    await beginMeasuring(canonicalPov.id, "canonical");
    let current = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      canonicalPov.id,
    );
    expect(current.state).toBe("MEASURING");
    expect(current.version).toBe(1);

    // (c) The independent buyer-A attestation (verifier = the demand
    //     owner, never the PoV owner): the signature covers the
    //     canonical digest input built from the STORED commitment
    //     digests — verifyAttestation proves it verifies
    //     cryptographically WITHOUT any plaintext disclosure.
    canonicalAttestation = await createBuyerAttestation(
      [platformEvidence.id, providerEvidence.id],
      "Independently reviewed the procurement fulfillment delivery evidence (AC-07 canonical).",
    );
    expect(canonicalAttestation.verifierId).toBe(harness.poolCreatorPersonId);
    expect(canonicalAttestation.algorithm).toBe("hmac-sha256");
    const attestationDecision =
      await runtime.attestationService.verifyAttestation(
        harness.poolCreatorCtx("w036-ac07-attestation-verify"),
        canonicalAttestation.id,
      );
    expect(attestationDecision.valid).toBe(true);

    await runtime.proofOfValueService.attachAttestation(
      ctx,
      canonicalPov.id,
      canonicalAttestation.id,
    );
    await completeGathering(canonicalPov.id, "canonical");
    current = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      canonicalPov.id,
    );
    expect(current.state).toBe("EVALUATING");
    expect(current.version).toBe(2);
    expect(current.attestationIds).toEqual([canonicalAttestation.id]);

    // (d) The deterministic aggregation: grade-weighted point,
    //     conservative interval envelope, dominant grade, evidence
    //     count, independent sources — recorded on the PoV.
    const aggregated = await runtime.proofOfValueService.aggregateEvidence(
      ctx,
      canonicalPov.id,
    );
    expect(aggregated.aggregation).not.toBeNull();
    expect(aggregated.aggregation!.evidenceCount).toBe(2);
    expect(aggregated.aggregation!.independentSources).toBe(2);
    expect(aggregated.aggregation!.aggregatePoint).toBeCloseTo(0.9, 12);
    expect(aggregated.aggregation!.aggregateInterval).toEqual({
      lower: 0.85,
      upper: 0.95,
    });
    expect(aggregated.aggregation!.dominantGrade).toBe("MEASURED");
    expect(aggregated.aggregation!.gradesPresent).toEqual([
      "MEASURED",
      "PROVIDER_REPORTED",
    ]);
    expect(aggregated.aggregation!.totalWeight).toBeCloseTo(1.6, 12);

    // (e) verify → VERIFIED (read through the owning boundary).
    const verified = await runtime.proofOfValueService.verify(
      ctx,
      {
        proofId: canonicalPov.id,
        expectedVersion: 2,
        idempotencyKey: "w036-ac07-pov-verify-canonical",
        actorPersonId: harness.supplierAPersonId,
      },
    );
    expect(verified.proof.state).toBe("VERIFIED");
    const stored = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      canonicalPov.id,
    );
    expect(stored.state).toBe("VERIFIED");
    expect(stored.version).toBe(3);
    expect(stored.evidenceIds).toEqual([
      platformEvidence.id,
      providerEvidence.id,
    ]);
    expect(stored.attestationIds).toEqual([canonicalAttestation.id]);
    expect(stored.aggregation).not.toBeNull();
  }, 120_000);

  test("CALLER/MODEL-ASSERTION NEGATIVE: a model/self-only PoV may aggregate (dominantGrade MODEL_ASSESSED) but verify FAILS on the high-support evidence gate — the PoV stays un-VERIFIED no matter what the caller asserts", async () => {
    const runtime = harness.runtime;
    const ctx = harness.supplierACtx("w036-ac07-model");

    // Model + self evidence over the same fulfillment subject: the
    // deterministic grade rule table derives MODEL_ASSESSED /
    // SELF_REPORTED (admissible INPUT evidence — never authoritative).
    const eModel = await createFulfillmentEvidence(
      "model",
      "model-w036-ac07-advisor",
      "model-assessed-fulfillment",
    );
    const eSelf = await createFulfillmentEvidence(
      "self",
      "self-w036-ac07-supplier",
      "supplier-self-report",
    );
    expect(eModel.grade).toBe("MODEL_ASSESSED");
    expect(eSelf.grade).toBe("SELF_REPORTED");

    const modelPov = await createDraftPoV([eModel.id, eSelf.id]);
    modelPovId = modelPov.id;
    await beginMeasuring(modelPov.id, "model");
    // A GENUINE independent attestation over the model/self evidence
    // (the cryptographic precondition holds) — the caller asserts
    // everything the positive path carries EXCEPT high-grade
    // evidence.
    const attestation = await createBuyerAttestation(
      [eModel.id, eSelf.id],
      "The supplier's model-assessed savings claim (never authoritative).",
    );
    await runtime.proofOfValueService.attachAttestation(
      ctx,
      modelPov.id,
      attestation.id,
    );
    await completeGathering(modelPov.id, "model");

    // The aggregation SUCCEEDS over the low-grade evidence — the
    // deterministic combination never inspects payloads.
    const aggregated = await runtime.proofOfValueService.aggregateEvidence(
      ctx,
      modelPov.id,
    );
    expect(aggregated.aggregation!.evidenceCount).toBe(2);
    expect(aggregated.aggregation!.dominantGrade).toBe("MODEL_ASSESSED");
    expect(aggregated.aggregation!.gradesPresent).toEqual([
      "MODEL_ASSESSED",
      "SELF_REPORTED",
    ]);
    expect(aggregated.aggregation!.aggregatePoint).toBeCloseTo(0.9, 12);
    expect(aggregated.aggregation!.totalWeight).toBeCloseTo(0.5, 12);

    // The verify FAILS: the hasHighSupportEvidence gate (≥1 MEASURED
    // or ATTESTED — architecture-lock §4).
    const error = await expectVerifyFails(modelPov.id, 2, "model");
    expect(error.code).toBe("PROOF_OF_VALUE_VALIDATION");
    expect(error.message).toMatch(
      /model-assessed or self-reported evidence alone/,
    );

    // The PoV stays un-VERIFIED (the caller's grade/confidence
    // assertions never became verification authority).
    const stored = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      modelPov.id,
    );
    expect(stored.state).toBe("EVALUATING");
    expect(stored.version).toBe(2);
    expect(stored.aggregation!.dominantGrade).toBe("MODEL_ASSESSED");
  }, 120_000);

  test("BYPASS NEGATIVES: verify from DRAFT or MEASURING is refused by the /workflows transition table; verify from EVALUATING without an attestation fails closed; aggregation with zero evidence fails closed (the state gate, the completion gate and the exact AGGREGATION_REQUIRES_EVIDENCE engine rule)", async () => {
    const runtime = harness.runtime;
    const ctx = harness.supplierACtx("w036-ac07-bypass");

    // Transport-level ALLOW policies for the two NON-EXISTENT
    // transition actions (the harness seeds policies only for the
    // REAL table rules, so the deny-by-default guard would otherwise
    // refuse first): seeding them isolates the /workflows TRANSITION
    // TABLE authority — the sole lifecycle mutator refuses the bypass
    // edge itself (the "no second state machine" proof).
    for (const action of [
      policyActionFor("proof_of_value", "DRAFT", "VERIFIED"),
      policyActionFor("proof_of_value", "MEASURING", "VERIFIED"),
    ]) {
      await runtime.policyService.createPolicy(harness.bootstrapCtx, {
        subject: "*",
        action,
        resource: "*",
        effect: "allow",
        createdBy: "bootstrap",
      });
    }

    // (a) verify from DRAFT: the domain preconditions are EVALUATING-
    //     scoped, so the request goes straight to the /workflows
    //     authority — DRAFT → VERIFIED is not in the transition
    //     table; the PoV stays DRAFT.
    const draftPov = await createDraftPoV([]);
    draftPovId = draftPov.id;
    const draftError = await expectVerifyFails(draftPov.id, 0, "draft");
    expect(draftError.code).toBe("ILLEGAL_TRANSITION");
    expect(draftError.message).toMatch(/DRAFT → VERIFIED/);
    expect(
      (await runtime.proofOfValueService.getProofOfValue(ctx, draftPov.id))
        .state,
    ).toBe("DRAFT");

    // (b) verify from MEASURING (before aggregation, WITH evidence
    //     attached): MEASURING → VERIFIED is equally illegal.
    const ePlatform = await createFulfillmentEvidence(
      "platform",
      "platform-w036-ac07-bypass",
      "platform-counter",
    );
    const measuringPov = await createDraftPoV([ePlatform.id]);
    await beginMeasuring(measuringPov.id, "bypass");
    const measuringError = await expectVerifyFails(
      measuringPov.id,
      1,
      "measuring",
    );
    expect(measuringError.code).toBe("ILLEGAL_TRANSITION");
    expect(measuringError.message).toMatch(/MEASURING → VERIFIED/);
    expect(
      (await runtime.proofOfValueService.getProofOfValue(ctx, measuringPov.id))
        .state,
    ).toBe("MEASURING");

    // (c) aggregate from MEASURING with ZERO attached evidence: the
    //     aggregation is legal only in EVALUATING (the state gate).
    const zeroPov = await createDraftPoV([]);
    await beginMeasuring(zeroPov.id, "zero");
    let aggregateError: unknown = null;
    try {
      await runtime.proofOfValueService.aggregateEvidence(ctx, zeroPov.id);
    } catch (error) {
      aggregateError = error;
    }
    expect(aggregateError).toBeTruthy();
    expect((aggregateError as OpenConError).code).toBe(
      "PROOF_OF_VALUE_VALIDATION",
    );
    expect((aggregateError as OpenConError).message).toMatch(
      /only in state EVALUATING/,
    );

    // (d) The zero-evidence completion gate: MEASURING → EVALUATING
    //     requires ≥1 attached evidence — the only sanctioned path
    //     into EVALUATING, so a zero-evidence EVALUATING PoV is
    //     UNCONSTRUCTIBLE through the service (the service's own
    //     zero-evidence aggregation branch is defense-in-depth).
    let completeError: unknown = null;
    try {
      await completeGathering(zeroPov.id, "zero");
    } catch (error) {
      completeError = error;
    }
    expect(completeError).toBeTruthy();
    expect((completeError as OpenConError).code).toBe(
      "PROOF_OF_VALUE_VALIDATION",
    );
    expect((completeError as OpenConError).message).toMatch(
      /cannot complete without at least one attached evidence record/,
    );
    // The exact engine rule the service's zero-evidence branch
    // enforces (the PURE deterministic function over evidence
    // records): AGGREGATION_REQUIRES_EVIDENCE.
    let engineError: unknown = null;
    try {
      aggregateEvidenceRecords([]);
    } catch (error) {
      engineError = error;
    }
    expect(engineError).toBeTruthy();
    expect((engineError as OpenConError).code).toBe(
      "AGGREGATION_REQUIRES_EVIDENCE",
    );
    expect((engineError as OpenConError).message).toMatch(
      /requires at least one evidence record/,
    );

    // (e) verify from EVALUATING WITH aggregation but NO attached
    //     attestation: fails closed before the workflow request.
    const noAttestationPov = await createDraftPoV([ePlatform.id]);
    await beginMeasuring(noAttestationPov.id, "no-attestation");
    await completeGathering(noAttestationPov.id, "no-attestation");
    await runtime.proofOfValueService.aggregateEvidence(
      ctx,
      noAttestationPov.id,
    );
    const noAttestationError = await expectVerifyFails(
      noAttestationPov.id,
      2,
      "no-attestation",
    );
    expect(noAttestationError.code).toBe("PROOF_OF_VALUE_VALIDATION");
    expect(noAttestationError.message).toMatch(
      /without at least one attached attestation/,
    );
    expect(
      (
        await runtime.proofOfValueService.getProofOfValue(
          ctx,
          noAttestationPov.id,
        )
      ).state,
    ).toBe("EVALUATING");
  }, 120_000);

  test("NO ECONOMICS FROM AN UNVERIFIED PoV: recordPendingValue over an unverified PoV source fails closed with ECONOMIC_VALIDATION (state named) — nothing recorded, no postings, no audit; caller/provider/model assertions cannot authorize economics", async () => {
    const runtime = harness.runtime;

    const valueRecordsBefore = (
      await runtime.postgresAuthority.scan("economic_value_records")
    ).length;
    const ledgerEntriesBefore = (
      await runtime.postgresAuthority.scan("economic_ledger_entries")
    ).length;
    const valueAuditBefore = (
      await runtime.auditWriter.query({
        eventType: "economic_value.recorded",
      })
    ).length;

    // (a) The model/self PoV (stuck in EVALUATING after the refused
    //     verify) as a source: even with a VERIFIED contribution
    //     alongside, the per-source VERIFIED gate fails closed.
    let caught: unknown = null;
    try {
      await runtime.economicValueService.recordPendingValue(
        harness.poolCreatorCtx("w036-ac07-value-model"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 120,
          sources: [
            { kind: "contribution", id: contribution.id },
            { kind: "proof_of_value", id: modelPovId },
          ],
          idempotencyKey: "w036-ac07-value-model",
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    const modelError = caught as OpenConError;
    expect(modelError.code).toBe("ECONOMIC_VALIDATION");
    expect(modelError.message).toMatch(
      /is in state EVALUATING, not VERIFIED/,
    );
    expect(modelError.context).toMatchObject({
      kind: "proof_of_value",
      id: modelPovId,
      state: "EVALUATING",
    });

    // (b) The DRAFT PoV (never even measured) as a source.
    let draftCaught: unknown = null;
    try {
      await runtime.economicValueService.recordPendingValue(
        harness.poolCreatorCtx("w036-ac07-value-draft"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 120,
          sources: [{ kind: "proof_of_value", id: draftPovId }],
          idempotencyKey: "w036-ac07-value-draft",
        },
      );
    } catch (error) {
      draftCaught = error;
    }
    expect(draftCaught).toBeTruthy();
    const draftError = draftCaught as OpenConError;
    expect(draftError.code).toBe("ECONOMIC_VALIDATION");
    expect(draftError.message).toMatch(/is in state DRAFT, not VERIFIED/);

    // (c) NOTHING was recorded, posted or audited: the value-record
    //     collection, the ledger entries and the audit events are all
    //     unchanged (the caller's amount/grade/confidence assertions
    //     minted nothing).
    expect(
      (await runtime.postgresAuthority.scan("economic_value_records")).length,
    ).toBe(valueRecordsBefore);
    expect(
      (await runtime.postgresAuthority.scan("economic_ledger_entries")).length,
    ).toBe(ledgerEntriesBefore);
    expect(
      (await runtime.auditWriter.query({
        eventType: "economic_value.recorded",
      })).length,
    ).toBe(valueAuditBefore);
  }, 120_000);

  test("INTEGRITY: the commitment/attestation bindings verify ONLY against the stored commitments (wrong presented material fails closed; a commitment-less record fails closed); an attestation covering evidence the PoV does not carry cannot attach — nothing mints", async () => {
    const runtime = harness.runtime;
    const ctx = harness.supplierACtx("w036-ac07-integrity");

    // (a) A SENSITIVE evidence record over the fulfillment subject:
    //     the service computes + stores the cryptographic commitment
    //     and DISCARDS the plaintext (the raw material never enters
    //     the authoritative record — payload null).
    const sensitive = await runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.supplierAPersonId,
      subjectReference: {
        subjectId: contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "platform",
        sourceId: "platform-w036-ac07-sensitive",
        method: "platform-counter",
        collectedAt: W036_EVIDENCE_CAPTURED_AT,
      },
      confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
      sensitivity: "sensitive",
      sensitivePayload: "PRIVATE: W036 AC-07 integrity material",
    });
    expect(sensitive.payload).toBeNull();
    expect(sensitive.commitment).not.toBeNull();
    expect(sensitive.commitment!.algorithm).toBe("sha256");
    expect(sensitive.commitment!.digest).toMatch(/^[0-9a-f]{64}$/);
    // The committed material itself never crossed into the record.
    expect(JSON.stringify(sensitive)).not.toContain("PRIVATE: W036");

    // (b) The commitment-integrity gate through the REAL service API:
    //     the CORRECT presented material verifies against the stored
    //     commitment; TAMPERED material fails closed; a
    //     commitment-less (standard) record fails closed outright.
    const honest = await runtime.evidenceService.verifyEvidenceCommitment(
      ctx,
      sensitive.id,
      "PRIVATE: W036 AC-07 integrity material",
    );
    expect(honest.valid).toBe(true);
    expect(honest.reason).toMatch(/matches the stored commitment/);
    const tampered = await runtime.evidenceService.verifyEvidenceCommitment(
      ctx,
      sensitive.id,
      "PRIVATE: tampered material (not what was committed)",
    );
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toMatch(/does NOT match/);
    const commitmentless = await runtime.evidenceService
      .verifyEvidenceCommitment(
        ctx,
        platformEvidence.id,
        "PRIVATE: W036 AC-07 integrity material",
      );
    expect(commitmentless.valid).toBe(false);
    expect(commitmentless.reason).toMatch(/carries no commitment/);

    // (c) The attestation binding: the genuine buyer-A attestation
    //     over the SENSITIVE evidence verifies CRYPTOGRAPHICALLY
    //     against the CURRENT STORED commitment digests — no
    //     plaintext disclosure anywhere on the verification path.
    //     (NOTE: a signature-mismatching attestation is
    //     UNCONSTRUCTIBLE through the service APIs — attestations
    //     minted by the authority always verify against the
    //     immutable stored commitments, which is exactly the
    //     design; the repository-tamper mutation probe is proven by
    //     the W005 remediation suite
    //     tests/evidence/net-w005-remediation-attestation-verification.test.ts,
    //     outside this suite's no-repository-write structural pin.)
    const attestation = await createBuyerAttestation(
      [sensitive.id],
      "Independently reviewed the committed fulfillment material (AC-07).",
    );
    const decision = await runtime.attestationService.verifyAttestation(
      harness.poolCreatorCtx("w036-ac07-integrity-verify"),
      attestation.id,
    );
    expect(decision.valid).toBe(true);
    expect(decision.attestationId).toBe(attestation.id);

    // (d) The severed-lineage mutation probe: an attestation COVERING
    //     WRONG EVIDENCE (an evidence record the PoV does not carry)
    //     cannot even be attached — the coverage precondition fails
    //     closed with the uncovered ids in the error context.
    const ePlatform = await createFulfillmentEvidence(
      "platform",
      "platform-w036-ac07-integrity",
      "platform-counter",
    );
    const eUnattached = await createFulfillmentEvidence(
      "platform",
      "platform-w036-ac07-unattached",
      "platform-counter",
    );
    const coveragePov = await createDraftPoV([ePlatform.id]);
    await beginMeasuring(coveragePov.id, "coverage");
    const wrongCoverage = await createBuyerAttestation(
      [ePlatform.id, eUnattached.id],
      "An attestation partially covering evidence outside the PoV.",
    );
    let attachError: unknown = null;
    try {
      await runtime.proofOfValueService.attachAttestation(
        ctx,
        coveragePov.id,
        wrongCoverage.id,
      );
    } catch (attachCatch) {
      attachError = attachCatch;
    }
    expect(attachError).toBeTruthy();
    expect((attachError as OpenConError).code).toBe(
      "PROOF_OF_VALUE_VALIDATION",
    );
    expect((attachError as OpenConError).message).toMatch(
      /covers evidence not attached to this proof of value/,
    );
    expect(
      (attachError as OpenConError).context as Record<string, unknown>,
    ).toMatchObject({ uncovered: [eUnattached.id] });
    // The PoV's attestation set is unchanged and the PoV stays
    // un-VERIFIED (MEASURING — nothing was attached).
    const stored = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      coveragePov.id,
    );
    expect(stored.state).toBe("MEASURING");
    expect(stored.attestationIds).toEqual([]);

    // (e) Nothing mints: the lineage-severed (un-VERIFIED) PoV cannot
    //     authorize economics.
    let minted: unknown = null;
    try {
      await runtime.economicValueService.recordPendingValue(
        harness.poolCreatorCtx("w036-ac07-value-severed"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 120,
          sources: [{ kind: "proof_of_value", id: coveragePov.id }],
          idempotencyKey: "w036-ac07-value-severed",
        },
      );
    } catch (mintError) {
      minted = mintError;
    }
    expect(minted).toBeTruthy();
    expect((minted as OpenConError).code).toBe("ECONOMIC_VALIDATION");
    expect((minted as OpenConError).message).toMatch(
      /is in state MEASURING, not VERIFIED/,
    );
  }, 120_000);

  test("LINEAGE: the VERIFIED PoV record carries the fulfillment subject, the exact outcome-linked evidence ids and the attestation; the VERIFIED chain (contribution + PoV + measured outcome) is what the settlement recognition consumes", async () => {
    const runtime = harness.runtime;
    const ctx = harness.supplierACtx("w036-ac07-lineage");

    // (a) The VERIFIED PoV record read through the owning boundary:
    //     the subject is the fulfillment contribution; the evidence
    //     ids are EXACTLY the canonical chain's two records; the
    //     attestation is the buyer-A one.
    const stored = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      canonicalPov.id,
    );
    expect(stored.state).toBe("VERIFIED");
    expect(stored.version).toBe(3);
    expect(stored.subjectReference).toEqual({
      subjectId: contribution.id,
      subjectType: "contribution",
    });
    expect(stored.evidenceIds).toEqual([
      platformEvidence.id,
      providerEvidence.id,
    ]);
    expect(stored.attestationIds).toEqual([canonicalAttestation.id]);

    // (b) The outcome→evidence→PoV lineage: the normalized outcome
    //     observation came from the REAL provider path; its provider
    //     identity is EXACTLY the provider evidence's provenance
    //     source; both the observation and the PoV are bound to the
    //     SAME fulfillment subject; the measured outcome is VERIFIED
    //     over the observation.
    const observationRecord =
      await runtime.outcomeObservationService.getOutcomeObservation(
        ctx,
        observation.id,
      );
    expect(observationRecord.provenance.sourceType).toBe("provider");
    expect(observationRecord.provenance.sourceId).toBe(
      OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(observationRecord.subjectReference.subjectId).toBe(
      contribution.id,
    );
    expect(providerEvidence.provenance.sourceId).toBe(
      observationRecord.provenance.sourceId,
    );
    expect(providerEvidence.subjectReference.subjectId).toBe(
      contribution.id,
    );
    const measurement = await runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      measuredOutcome.id,
    );
    expect(measurement.state).toBe("VERIFIED");
    expect(measurement.observationIds).toEqual([observation.id]);
    expect(measurement.subjectReference.subjectId).toBe(contribution.id);
    // The fulfillment contribution itself is VERIFIED (the terminal
    // /workflows state the recognition input gate requires).
    const verifiedContribution = await runtime.contributionService
      .getContribution(ctx, contribution.id);
    expect(verifiedContribution.state).toBe("VERIFIED");

    // (c) The settlement recognition consumes the VERIFIED chain —
    //     ONLY the VERIFIED PoV (and its VERIFIED siblings) authorize
    //     economics: the exact ids, in the canonical order, with the
    //     balanced recognition postings.
    const value: EconomicValueRecord = (
      await runtime.economicValueService.recordPendingValue(
        harness.poolCreatorCtx("w036-ac07-value"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 120,
          sources: [
            { kind: "contribution", id: contribution.id },
            { kind: "proof_of_value", id: canonicalPov.id },
            { kind: "measured_outcome", id: measuredOutcome.id },
          ],
          idempotencyKey: "w036-ac07-value",
        },
      )
    ).value;
    expect(value.state).toBe("PENDING");
    expect(value.amount).toBe(120);
    expect(value.beneficiaryPersonId).toBe(harness.poolCreatorPersonId);
    expect(
      value.sources.map((source) => `${source.kind}:${source.id}`),
    ).toEqual([
      `contribution:${contribution.id}`,
      `proof_of_value:${canonicalPov.id}`,
      `measured_outcome:${measuredOutcome.id}`,
    ]);
    expect(value.recognitionTransactionId).not.toBe("");
    const valueEvents = await runtime.auditWriter.query({
      eventType: "economic_value.recorded",
      resourceId: value.id,
    });
    expect(valueEvents).toHaveLength(1);
  }, 120_000);
});
