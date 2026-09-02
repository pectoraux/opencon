/**
 * NET-W035-AC-08 — Settlement and payment (issue #71 §5 AC-08; work
 * order §4.8).
 *
 * Verified creator value enters /settlement only after the required
 * workflow/evidence/risk/dispute gates, moves through pending/mature
 * semantics, and reaches the declared payment/settlement path (the
 * W030 external payment — linked to settlement, subordinate to
 * internal settlement state). Provider failures do not fabricate
 * settled value; same-key replays are exactly-once.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  createCreatorCampaign,
  recognizeCreatorValue,
  matureCreatorValue,
  recordCreatorPayment,
  key,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  publishHelpfulContribution,
} from "../contributions/_net-w012-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  // The FULL scenario (settlement + the W030 payment included).
  scenario = await runCreatorScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-08 settlement and payment", () => {
  test("verified creator value enters /settlement PENDING and only matures through the gated composite", async () => {
    // PENDING ≠ MATURE: the scenario's recognized value matured only
    // after the gates resolved.
    expect(scenario.value.state).toBe("PENDING");
    expect(scenario.matureValue.state).toBe("MATURE");
    // The value lineage is SERVER-DERIVED: the contribution + the PoH
    // bases (the PoV + the measured outcome + the evidence record).
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac08-value"),
      scenario.matureValue.id,
    );
    expect(value.beneficiaryPersonId).toBe(harness.creatorPersonId);
    expect(value.amount).toBe(100);
    expect(value.sources.map((s) => s.id)).toContain(scenario.contribution.id);
    expect(value.sources.map((s) => s.id)).toContain(scenario.proofOfValueId);
    expect(value.sources.map((s) => s.id)).toContain(scenario.measuredOutcome.id);
    expect(value.sources.map((s) => s.kind)).not.toContain("spend");
    expect(value.sources.map((s) => s.kind)).not.toContain("wealth");
  });

  test("a NON-verified contribution cannot enter settlement (the gate chain)", async () => {
    // A contribution still SUBMITTED (a fresh one) fails the
    // recognition closed.
    const { campaign } = await createCreatorCampaign(harness);
    const operatorForCampaign = harness.operatorCtx("w035-ac08-opportunity");
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
      policyId: key("w035-ac08-poh-policy"),
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
      idempotencyKey: key("w035-ac08-contribution"),
    });
    await publishHelpfulContribution(harness.w012, contribution.id);
    // The contribution is SUBMITTED (not VERIFIED): recognition fails
    // CLOSED on the LIFECYCLE gate specifically (the error context
    // names the non-VERIFIED state — distinguishing this gate from
    // every other ECONOMIC_VALIDATION precondition).
    const current = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w035-ac08-read"),
      contribution.id,
    );
    expect(current.state).toBe("SUBMITTED");
    await expect(
      recognizeCreatorValue(harness, contribution.id, {
        amount: 40,
        idempotencyKey: key("w035-ac08-recognize"),
      }),
    ).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({
        contributionState: "SUBMITTED",
      }),
    });
  });

  test("the W030 payment links to the settlement recognition transaction; the reconciliation is DERIVED and MATCHED; the fact posts NO ledger entries", async () => {
    // The fact is linked to the value's recognition transaction.
    const fact =
      await harness.runtime.externalSettlementService.getExternalSettlementFact(
        harness.operatorCtx("w035-ac08-fact"),
        harness.organizationScopeId,
        scenario.paymentFact!.id,
      );
    expect(fact!.internalTransactionId).toBe(
      scenario.matureValue.recognitionTransactionId,
    );
    // The reconciliation verdict is DERIVED (never stored/asserted).
    const view =
      await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        harness.operatorCtx("w035-ac08-reconcile"),
        {
          organizationScopeId: harness.organizationScopeId,
          factId: scenario.paymentFact!.id,
        },
      );
    expect(view.verdict).toBe("matched");
    expect(view.reason).toBe("amount_matched");
    expect(view.internalTransaction!.id).toBe(
      scenario.matureValue.recognitionTransactionId,
    );
    // The fact is provider integration ONLY: the ledger is unchanged
    // by the payment (count the entries before/after a fresh fact).
    const before =
      await harness.runtime.postgresAuthority.scan("economic_ledger_entries");
    const matured = await matureCreatorValue(harness, scenario.value.id, {
      idempotencyKey: key("w035-ac08-remature"),
    }).catch(() => null); // already mature → replay returns it
    void matured;
    await recordCreatorPayment(harness, {
      valueRecordId: scenario.matureValue.id,
      internalTransactionId: scenario.matureValue.recognitionTransactionId,
      reportedAmount: scenario.matureValue.amount,
    });
    const after =
      await harness.runtime.postgresAuthority.scan("economic_ledger_entries");
    expect(after.length).toBe(before.length);
  });

  test("PROVIDER FAILURES cannot fabricate settled value (wrong key / tampered / unsigned / stale all fail closed)", async () => {
    for (const failure of [
      { wrongKey: true },
      { tampered: true },
      { unsigned: true },
      { stale: true },
    ] as const) {
      const factsBefore =
        await harness.runtime.postgresAuthority.count(
          "external_settlement_facts",
        );
      await expect(
        recordCreatorPayment(harness, {
          valueRecordId: scenario.matureValue.id,
          internalTransactionId: scenario.matureValue.recognitionTransactionId,
          reportedAmount: scenario.matureValue.amount,
          ...failure,
        }),
      ).rejects.toMatchObject({ code: "EXTERNAL_SETTLEMENT_INGESTION_REJECTED" });
      const factsAfter =
        await harness.runtime.postgresAuthority.count(
          "external_settlement_facts",
        );
      expect(factsAfter).toBe(factsBefore);
    }
    // No value state changed through the failures.
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac08-failures"),
      scenario.matureValue.id,
    );
    expect(value.state).toBe("MATURE");
  });

  test("same-key payment replays are EXACTLY-ONCE; the same identity under a different key is fail-closed (immutable facts)", async () => {
    const externalId = key("w035-ac08-ext");
    const idem = key("w035-ac08-payment");
    const first = await recordCreatorPayment(harness, {
      valueRecordId: scenario.matureValue.id,
      internalTransactionId: scenario.matureValue.recognitionTransactionId,
      reportedAmount: scenario.matureValue.amount,
      externalId,
      idempotencyKey: idem,
    });
    // The same key + identity → the committed fact verbatim.
    const replay = await recordCreatorPayment(harness, {
      valueRecordId: scenario.matureValue.id,
      internalTransactionId: scenario.matureValue.recognitionTransactionId,
      reportedAmount: scenario.matureValue.amount,
      externalId,
      idempotencyKey: idem,
    });
    expect(replay.id).toBe(first.id);
    // The same identity under a DIFFERENT key with a DIFFERENT
    // substance (a fresh observation timestamp) fails closed — the
    // identity is exactly-once and facts are immutable (no duplicate
    // payment can ever be recorded).
    await expect(
      recordCreatorPayment(harness, {
        valueRecordId: scenario.matureValue.id,
        internalTransactionId: scenario.matureValue.recognitionTransactionId,
        reportedAmount: scenario.matureValue.amount,
        externalId,
        idempotencyKey: key("w035-ac08-payment-second"),
      }),
    ).rejects.toMatchObject({
      code: "EXTERNAL_SETTLEMENT_INGESTION_REJECTED",
      context: expect.objectContaining({ reason: "conflicting_fact" }),
    });
    // Exactly ONE audit event for the fact.
    const events = await harness.runtime.auditWriter.query({
      eventType: "external_settlement_fact.recorded",
      resourceId: first.id,
    });
    expect(events).toHaveLength(1);
  });

  test("a reported-amount MISMATCH is recorded as a derived mismatched verdict (never auto-corrected, never fabricated)", async () => {
    const fact = await recordCreatorPayment(harness, {
      valueRecordId: scenario.matureValue.id,
      internalTransactionId: scenario.matureValue.recognitionTransactionId,
      reportedAmount: scenario.matureValue.amount + 25,
    });
    const view =
      await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        harness.operatorCtx("w035-ac08-mismatch"),
        {
          organizationScopeId: harness.organizationScopeId,
          factId: fact.id,
        },
      );
    expect(view.verdict).toBe("mismatched");
    expect(view.reason).toBe("amount_mismatched");
    // The value is UNCHANGED (the provider report never mutates
    // internal settlement truth).
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac08-mismatch-value"),
      scenario.matureValue.id,
    );
    expect(value.amount).toBe(100);
    expect(value.state).toBe("MATURE");
  });

  test("the ledger is conserved end-to-end (the payment adds no economic mutation)", async () => {
    await assertGlobalConservation(
      harness.w018.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });
});
