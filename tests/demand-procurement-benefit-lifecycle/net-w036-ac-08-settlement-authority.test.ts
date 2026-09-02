/**
 * NET-W036 AC-08 — Settlement authority (work order §5 AC-08 + the
 * frozen ledger §4 + §4 invariants 8/9): verified value enters
 * `/settlement` through the EXISTING economic primitives ONLY; the
 * pending/mature distinction holds; the applicable risk/dispute
 * controls gate the maturation; and NO procurement ledger exists
 * (economic state + postings are settlement-owned exclusively).
 *
 * The suite seeds the canonical chain through the OWNING boundaries
 * (a qualified three-buyer pool → the supplier-A offer → the recorded
 * competitive selection → the sanctioned /workflows fulfillment
 * contribution walked to VERIFIED → the REAL W022 provider measurement
 * → the VERIFIED measured outcome → the W027 counterfactual baseline +
 * the recorded 120-usd savings → the VERIFIED Proof-of-Value) and then
 * exercises the settlement authority over the canonical VERIFIED
 * source triple (contribution + proof_of_value + measured_outcome —
 * the exact harness stage-12 recognition shape, amount = the recorded
 * savings value).
 *
 * Mutation targets covered (ledger §4):
 *  - recognize unverified value → the per-source VERIFIED input gate
 *    fails closed with ECONOMIC_VALIDATION (state named; nothing
 *    staged: no record, no postings, no audit);
 *  - mature while gated → the composition-root risk/dispute gates
 *    (RISK_CONTROL / DISPUTE_CHALLENGE) refuse the maturation before
 *    the settlement mutation, and nothing transitions;
 *  - write outside the settlement primitive → structurally pinned
 *    (zero repository-write code tokens across the whole W036 suite)
 *    + behaviorally proven by the input-gate refusal;
 *  - create a second (procurement) ledger → the containment scan:
 *    global conservation over the ONE settlement ledger, every
 *    economic entry in the settlement-owned account vocabulary, and
 *    no demand/procurement record or audit event carries economic
 *    state.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac08-…`),
 * fixed anchors imported from the harness (W036_EVIDENCE_CAPTURED_AT
 * for the pool-bound evidence, the baseline window DERIVED from the
 * pool's authoritative createdAt through w036IsoMinusDays), the
 * dispute effectiveAt = the subject's own authoritative createdAt (the
 * harness helper) — NO wall-clock read, NO random id in this file (the
 * code-token self-pins at the end prove it). ONE harness per file.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW036Harness,
  requestContributionTransition,
  submitFulfillmentMeasurement,
  createVerifiedMeasuredOutcomeForSubject,
  attachVerifiedProofOfValueForSubject,
  walkToVerified,
  holdMaturationOn,
  resolveHold,
  openBondedDisputeOn,
  resolveDispute,
  matureValueRecord,
  w036IsoMinusDays,
  W036_EVIDENCE_CAPTURED_AT,
  W036_BASELINE_WINDOW_DAYS,
  W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  personCtx,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import { ECONOMIC_ACCOUNT_KINDS, toEconomicMinorUnits } from "../../src/core/economics.ts";
import { economicAccountId } from "../../src/settlement/ledger.ts";
import type {
  EconomicLedgerEntry,
  EconomicLedgerTransaction,
  EconomicValueRecord,
} from "../../src/settlement/port.ts";
import type { OpenConError } from "../../src/core/errors.ts";
import type {
  CompetitiveSelection,
  ProcurementBaseline,
  ProcurementCommitment,
  ProcurementPool,
  ProcurementSavings,
  SupplierOffer,
} from "../../src/demand/port.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type { MeasuredOutcome } from "../../src/outcomes/port.ts";

let harness: NetW036Harness;

// The canonical AC-08 chain (built in beforeAll — every stage through
// the owning boundary, mirroring the canonical scenario stages 1–12).
let pool: ProcurementPool;
let commitments: readonly ProcurementCommitment[];
let offer: SupplierOffer;
let selection: CompetitiveSelection;
let baseline: ProcurementBaseline;
let savings: ProcurementSavings;
/** The canonical VERIFIED fulfillment subject (the recognition source). */
let contribution: Contribution;
/** The canonical VERIFIED measured outcome (the recognition source). */
let measuredOutcome: MeasuredOutcome;
/** The canonical VERIFIED Proof-of-Value id (the recognition source). */
let proofOfValueId: string;
/** A SECOND contribution left in DRAFT (the unverified-source fixture). */
let draftContribution: Contribution;

beforeAll(async () => {
  harness = await createNetW036Harness();
  await seedCanonicalSettlementChain();
}, 240_000);

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// The deterministic seed (fixed keys; the suite's OWN pool — the
// AC-01..07 suite discipline; every step through the owning service)
// ---------------------------------------------------------------------------

/**
 * The canonical AC-08 chain: the qualified pool + the supplier-A offer
 * + the recorded selection → the sanctioned fulfillment contribution
 * (walked to the MEASUREMENT POINT, measured through the REAL W022
 * provider path, the measured outcome VERIFIED, the lifecycle walked
 * to VERIFIED) → the W027 counterfactual baseline + the recorded
 * savings (1000 − 880 = 120 usd; the window derived from the POOL's
 * authoritative createdAt) → the VERIFIED PoV over the fulfillment
 * subject. A second contribution is left in DRAFT for the
 * unverified-source negative.
 */
async function seedCanonicalSettlementChain(): Promise<void> {
  const runtime = harness.runtime;
  const scope = harness.organizationScopeId;
  const buyerA = harness.poolCreatorCtx("w036-ac08-seed");

  // Stage 1 — the qualified pool + the three buyer commitments (the
  // same shape the canonical scenario seeds: three DISTINCT buyer
  // organizations, all NA_EAST, aggregate-disclosure consent).
  pool = (
    await runtime.procurementService.createProcurementPool(buyerA, {
      organizationScopeId: scope,
      name: "W036 AC-08 Settlement Authority Pool",
      categoryKey: "cloud_infrastructure",
      qualificationPolicy: {
        minimumCommitments: 2,
        minimumOrganizations: 2,
      },
      idempotencyKey: "w036-ac08-pool",
    })
  ).pool;
  const commitmentSeeds: readonly {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-ac08-commit-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: "w036-ac08-commit-a",
    },
    {
      ctx: harness.buyerBCtx("w036-ac08-commit-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: "w036-ac08-commit-b",
    },
    {
      ctx: harness.buyerCCtx("w036-ac08-commit-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: "w036-ac08-commit-c",
    },
  ];
  const createdCommitments: ProcurementCommitment[] = [];
  for (const seed of commitmentSeeds) {
    createdCommitments.push(
      (
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
        )
      ).commitment,
    );
  }
  commitments = createdCommitments;

  // Stage 4/6 — the supplier-A offer (the deterministic cheapest band)
  // + the recorded competitive selection (a procurement DECISION — no
  // economic mutation; the conservation proof at the end).
  offer = (
    await runtime.supplierOfferService.createSupplierOffer(
      harness.supplierACtx("w036-ac08-offer-a"),
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
        idempotencyKey: "w036-ac08-offer-a",
      },
    )
  ).offer;
  selection = (
    await runtime.supplierOfferService.recordCompetitiveSelection(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      idempotencyKey: "w036-ac08-selection",
    })
  ).selection;

  // Stages 7–9 — the sanctioned fulfillment: the opportunity over the
  // pool + selection, the supplier-A contribution walked through the
  // /workflows ladder to the MEASUREMENT POINT, the REAL provider
  // measurement (the OpenRTB delivery-notice adapter), the VERIFIED
  // measured outcome, and the completed VERIFIED lifecycle walk.
  const opportunity = await runtime.opportunityService.createOpportunity(
    harness.poolCreatorCtx("w036-ac08-opportunity"),
    {
      organizationScopeId: scope,
      ownerId: harness.poolCreatorPersonId,
      opportunityType: "procurement-fulfillment",
      title: "W036 AC-08 Fulfillment Opportunity",
      brief: {
        kind: "procurement_fulfillment",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  const created = await runtime.contributionService.createContribution(
    harness.supplierACtx("w036-ac08-contribution"),
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
      `w036-ac08-t${String(index + 1)}`,
    );
  }
  const measurement = await submitFulfillmentMeasurement(
    harness,
    created.id,
  );
  measuredOutcome = await createVerifiedMeasuredOutcomeForSubject(
    harness,
    created.id,
    measurement.observation.id,
  );
  contribution = await walkToVerified(harness, created.id);

  // A SECOND contribution over the SAME opportunity, left in DRAFT —
  // the unverified-source fixture for the input-gate negative.
  draftContribution =
    await runtime.contributionService.createContribution(
      harness.supplierACtx("w036-ac08-draft-contribution"),
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

  // Stage 10 — the W027 counterfactual baseline: pool-bound platform
  // evidence (the FIXED collectedAt anchor — /evidence stores it
  // verbatim), the pool-bound savings observation (the /outcomes
  // authority stamps its own collectedAt), and the explicit 1000-usd
  // counterfactual over the 30-day window ending 1 day before the
  // POOL's authoritative createdAt (w036IsoMinusDays — pure ISO
  // arithmetic, never a wall-clock read).
  const poolEvidence = await runtime.evidenceService.createEvidence(buyerA, {
    organizationScopeId: scope,
    ownerId: harness.poolCreatorPersonId,
    subjectReference: { subjectId: pool.id, subjectType: "procurement_pool" },
    provenance: {
      sourceType: "platform",
      sourceId: "w036-ac08-spend-ledger",
      method: "historical-spend-report",
      collectedAt: W036_EVIDENCE_CAPTURED_AT,
      collectorId: harness.poolCreatorPersonId,
    },
    confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
    sensitivity: "standard",
    payload: { kind: "spend_report", note: "W036 AC-08 baseline evidence" },
  });
  const savingsObservation =
    await runtime.outcomeObservationService.createOutcomeObservation(buyerA, {
      organizationScopeId: scope,
      observerId: harness.poolCreatorPersonId,
      subjectReference: { subjectId: pool.id, subjectType: "procurement_pool" },
      outcomeType: "savings",
      observedValue: { value: 880, unit: "usd" },
      confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
      provenance: {
        sourceType: "platform",
        sourceId: "w036-ac08-fulfillment-ledger",
        method: "procurement-fulfillment-ledger",
        methodVersion: "1",
        // collectedAt deliberately omitted — the /outcomes authority
        // stamps its own (fresh at the derivation anchor by
        // construction; no local fabrication).
      },
    });
  const authoritativePool = await runtime.procurementService
    .getProcurementPool(buyerA, scope, pool.id);
  const baselineWindowEndsAt = w036IsoMinusDays(
    authoritativePool.createdAt,
    W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  );
  baseline = (
    await runtime.procurementSavingsService.createProcurementBaseline(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      baselineKind: "counterfactual",
      method: "prior_period",
      methodVersion: "1",
      comparisonWindow: {
        startsAt: w036IsoMinusDays(
          authoritativePool.createdAt,
          W036_BASELINE_WINDOW_ENDS_DAYS_AGO + W036_BASELINE_WINDOW_DAYS,
        ),
        endsAt: baselineWindowEndsAt,
      },
      population:
        "Historical spend for the pool category over the comparison window (the W036 AC-08 counterfactual)",
      baselineValue: { value: 1000, unit: "usd" },
      confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      provenance: {
        sourceType: "platform",
        sourceId: "w036-ac08-spend-ledger",
        collectedAt: baselineWindowEndsAt,
        collectorId: harness.poolCreatorPersonId,
      },
      evidenceIds: [poolEvidence.id],
      idempotencyKey: "w036-ac08-baseline",
    })
  ).baseline;

  // Stage 11 — the supported savings (server-owned arithmetic:
  // 1000 − 880 = 120 usd, uncertainty preserved) + the VERIFIED PoV
  // over the fulfillment subject.
  const savingsView = await runtime.procurementSavingsService
    .evaluateProcurementSavings(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [savingsObservation.id],
      selectionId: selection.id,
    });
  if (savingsView.supported !== true) {
    throw new Error(
      `W036 AC-08 seed failed: the savings derivation was not supported (checks: ${JSON.stringify(
        savingsView.checks.map((c) => [c.check, c.satisfied]),
      )})`,
    );
  }
  savings = (
    await runtime.procurementSavingsService.recordProcurementSavings(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [savingsObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-ac08-savings",
    })
  ).savings;
  const pov = await attachVerifiedProofOfValueForSubject(
    harness,
    contribution.id,
  );
  proofOfValueId = pov.proofOfValueId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Σ amount (scaled minor units) over one direction of an entry set. */
function sumMinor(
  entries: readonly EconomicLedgerEntry[],
  direction: "debit" | "credit",
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.direction === direction) {
      total += toEconomicMinorUnits(entry.amount);
    }
  }
  return total;
}

/** Catch an expected service error and return it (null when none). */
async function expectRejection(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

/** The canonical recognition source triple (the stage-12 shape). */
function canonicalSources(): readonly { kind: string; id: string }[] {
  return [
    { kind: "contribution", id: contribution.id },
    { kind: "proof_of_value", id: proofOfValueId },
    { kind: "measured_outcome", id: measuredOutcome.id },
  ];
}

// ---------------------------------------------------------------------------
// The AC-08 proofs
// ---------------------------------------------------------------------------

describe("NET-W036-AC-08 settlement authority", () => {
  test("RECOGNITION: the canonical VERIFIED chain enters /settlement through the existing primitive — PENDING record, BALANCED recognition postings, ONE audit event with transaction/idempotency lineage, and the same-key replay is identical", async () => {
    const runtime = harness.runtime;
    const ctx = harness.poolCreatorCtx("w036-ac08-recognition");

    // (a) The recognition over the canonical VERIFIED sources — the
    //     exact stage-12 shape, the amount = the recorded savings
    //     value (120 — the server-owned W027 arithmetic).
    const recognized = await runtime.economicValueService.recordPendingValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.poolCreatorPersonId,
        amount: savings.savings!.value,
        sources: canonicalSources(),
        idempotencyKey: "w036-ac08-recognition",
      },
    );
    expect(recognized.created).toBe(true);
    const value = recognized.value;
    expect(value.state).toBe("PENDING");
    expect(value.version).toBe(0);
    expect(value.amount).toBe(120);
    expect(value.amount).toBe(savings.savings!.value);
    expect(value.beneficiaryPersonId).toBe(harness.poolCreatorPersonId);
    expect(value.organizationScopeId).toBe(harness.organizationScopeId);
    // The sources lineage: EXACTLY the canonical VERIFIED triple, in
    // the declaration order.
    expect(value.sources.map((s) => `${s.kind}:${s.id}`)).toEqual([
      `contribution:${contribution.id}`,
      `proof_of_value:${proofOfValueId}`,
      `measured_outcome:${measuredOutcome.id}`,
    ]);
    // The maturation policy: the immediate default (no maturation
    // input — the explicit gate is a LATER command, never implicit).
    expect(value.maturation).toEqual({ strategy: "immediate" });
    expect(value.maturedAt).toBeNull();
    expect(value.consumedBy).toBeNull();
    expect(value.reversal).toBeNull();
    expect(value.maturationTransactionId).toBeNull();
    expect(value.recognitionTransactionId).not.toBe("");
    expect(value.idempotencyKey).toBe("w036-ac08-recognition");

    // (b) THE BALANCED RECOGNITION POSTINGS — read through the
    //     settlement ledger projection: ONE transaction of exactly two
    //     entries (debit protocol_recognition(value) / credit
    //     pending_value(beneficiary)), Σdebit === Σcredit per unit.
    const transaction: EconomicLedgerTransaction =
      await runtime.economicLedgerService.getTransaction(
        ctx,
        value.recognitionTransactionId,
      );
    expect(transaction.id).toBe(value.recognitionTransactionId);
    expect(transaction.kind).toBe("value_recognition");
    expect(transaction.organizationScopeId).toBe(harness.organizationScopeId);
    expect(transaction.subject).toEqual({
      kind: "economic_value",
      id: value.id,
    });
    expect(transaction.idempotencyKey).toBe("w036-ac08-recognition");
    expect(transaction.entries).toHaveLength(2);
    const debit = transaction.entries.find((e) => e.direction === "debit")!;
    const credit = transaction.entries.find((e) => e.direction === "credit")!;
    expect(debit.accountKind).toBe("protocol_recognition");
    expect(debit.accountId).toBe(
      economicAccountId(
        harness.organizationScopeId,
        null,
        "protocol_recognition",
        "value",
      ),
    );
    expect(debit.ownerPersonId).toBeNull();
    expect(debit.amount).toBe(120);
    expect(debit.unit).toBe("value");
    expect(credit.accountKind).toBe("pending_value");
    expect(credit.accountId).toBe(
      economicAccountId(
        harness.organizationScopeId,
        harness.poolCreatorPersonId,
        "pending_value",
        "value",
      ),
    );
    expect(credit.ownerPersonId).toBe(harness.poolCreatorPersonId);
    expect(credit.amount).toBe(120);
    expect(credit.unit).toBe("value");
    expect(sumMinor(transaction.entries, "debit")).toBe(120_000_000);
    expect(sumMinor(transaction.entries, "credit")).toBe(120_000_000);
    expect(sumMinor(transaction.entries, "debit")).toBe(
      sumMinor(transaction.entries, "credit"),
    );
    for (const entry of transaction.entries) {
      expect(entry.organizationScopeId).toBe(harness.organizationScopeId);
    }

    // (c) EXACTLY ONE economic_value.recorded audit event, with the
    //     transaction/idempotency lineage metadata.
    const valueEvents = await runtime.auditWriter.query({
      eventType: "economic_value.recorded",
      resourceId: value.id,
    });
    expect(valueEvents).toHaveLength(1);
    const metadata = valueEvents[0]!.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "amount",
      "beneficiaryPersonId",
      "idempotencyKey",
      "idempotencyRecordId",
      "ledgerTransactionId",
      "maturationStrategy",
      "organizationScopeId",
      "sources",
      "state",
      "transactionId",
      "unit",
    ]);
    expect(metadata["state"]).toBe("PENDING");
    expect(metadata["amount"]).toBe(120);
    expect(metadata["sources"]).toEqual([
      `contribution:${contribution.id}`,
      `proof_of_value:${proofOfValueId}`,
      `measured_outcome:${measuredOutcome.id}`,
    ]);
    expect(metadata["ledgerTransactionId"]).toBe(
      value.recognitionTransactionId,
    );
    expect(metadata["idempotencyKey"]).toBe("w036-ac08-recognition");
    expect(metadata["idempotencyRecordId"]).not.toBe("");
    expect(metadata["transactionId"]).not.toBe("");

    // (d) The same-key replay: created:false, the IDENTICAL record,
    //     and STILL exactly one audit event (idempotency mints
    //     nothing on replay).
    const replay = await runtime.economicValueService.recordPendingValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.poolCreatorPersonId,
        amount: savings.savings!.value,
        sources: canonicalSources(),
        idempotencyKey: "w036-ac08-recognition",
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.value).toEqual(value);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.recorded",
          resourceId: value.id,
        })
      ).length,
    ).toBe(1);
    // And the ledger still holds exactly the ONE recognition
    // transaction for this record.
    expect(
      (
        await runtime.economicLedgerService.listTransactionsBySubject(ctx, {
          kind: "economic_value",
          id: value.id,
        })
      ).length,
    ).toBe(1);
  }, 120_000);

  test("INPUT GATE: recognition over an UNVERIFIED source fails closed with ECONOMIC_VALIDATION (state named) — no record, no postings, no audit (nothing staged)", async () => {
    const runtime = harness.runtime;

    const valueRecordsBefore = (
      await runtime.postgresAuthority.scan("economic_value_records")
    ).length;
    const ledgerEntriesBefore = (
      await runtime.postgresAuthority.scan("economic_ledger_entries")
    ).length;
    const recordedAuditBefore = (
      await runtime.auditWriter.query({
        eventType: "economic_value.recorded",
      })
    ).length;
    const maturedAuditBefore = (
      await runtime.auditWriter.query({
        eventType: "economic_value.matured",
      })
    ).length;

    // (a) A DRAFT contribution as the source: the per-source VERIFIED
    //     gate names the state and fails closed.
    const draftError = await expectRejection(() =>
      runtime.economicValueService.recordPendingValue(
        harness.poolCreatorCtx("w036-ac08-value-draft"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 120,
          sources: [{ kind: "contribution", id: draftContribution.id }],
          idempotencyKey: "w036-ac08-value-draft",
        },
      ),
    );
    expect(draftError).toBeTruthy();
    const draft = draftError as OpenConError;
    expect(draft.code).toBe("ECONOMIC_VALIDATION");
    expect(draft.message).toMatch(/is in state DRAFT, not VERIFIED/);
    expect(draft.message).toMatch(/unverified value cannot create economic/);
    expect(draft.context).toMatchObject({
      kind: "contribution",
      id: draftContribution.id,
      state: "DRAFT",
    });

    // (b) One unverified source fails the WHOLE recognition even with
    //     the canonical VERIFIED siblings alongside — the gate is
    //     per-source, never a majority vote.
    const mixedError = await expectRejection(() =>
      runtime.economicValueService.recordPendingValue(
        harness.poolCreatorCtx("w036-ac08-value-mixed"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: 120,
          sources: [
            ...canonicalSources(),
            { kind: "contribution", id: draftContribution.id },
          ],
          idempotencyKey: "w036-ac08-value-mixed",
        },
      ),
    );
    expect(mixedError).toBeTruthy();
    expect((mixedError as OpenConError).code).toBe("ECONOMIC_VALIDATION");
    expect((mixedError as OpenConError).message).toMatch(
      /is in state DRAFT, not VERIFIED/,
    );

    // (c) NOTHING was staged: the value-record collection, the ledger
    //     entries and the economic audit events are all unchanged.
    expect(
      (await runtime.postgresAuthority.scan("economic_value_records")).length,
    ).toBe(valueRecordsBefore);
    expect(
      (await runtime.postgresAuthority.scan("economic_ledger_entries"))
        .length,
    ).toBe(ledgerEntriesBefore);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.recorded",
        })
      ).length,
    ).toBe(recordedAuditBefore);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.matured",
        })
      ).length,
    ).toBe(maturedAuditBefore);
  }, 120_000);

  test("PENDING→MATURE: the explicit maturation gate — audited, idempotent replay, amount/sources IMMUTABLE across the transition, already-MATURE fails closed, a REVERSED record can never mature", async () => {
    const runtime = harness.runtime;
    const ctx = harness.poolCreatorCtx("w036-ac08-maturation");

    // (a) A fresh PENDING record over the canonical VERIFIED triple.
    const pending = (
      await runtime.economicValueService.recordPendingValue(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.poolCreatorPersonId,
        amount: 120,
        sources: canonicalSources(),
        idempotencyKey: "w036-ac08-value-mature-a",
      })
    ).value;
    expect(pending.state).toBe("PENDING");

    // (b) The maturation through the composition-root composite (the
    //     apiCommand exactly as the canonical path runs it) → MATURE.
    const matured = await matureValueRecord(
      harness,
      pending.id,
      "w036-ac08-mature-a",
    );
    expect(matured.state).toBe("MATURE");
    expect(matured.version).toBe(pending.version + 1);
    expect(matured.maturedAt).not.toBeNull();
    expect(matured.maturationTransactionId).not.toBeNull();
    // The amount/sources are IMMUTABLE across the transition (only the
    // state machine moves — architecture-lock invariant 19).
    expect(matured.amount).toBe(pending.amount);
    expect(matured.sources).toEqual(pending.sources);
    expect(matured.maturation).toEqual(pending.maturation);
    expect(matured.recordedAt).toBe(pending.recordedAt);
    expect(matured.beneficiaryPersonId).toBe(pending.beneficiaryPersonId);
    expect(matured.recognitionTransactionId).toBe(
      pending.recognitionTransactionId,
    );
    expect(matured.consumedBy).toBeNull();
    expect(matured.reversal).toBeNull();

    // (c) The maturation postings: debit pending_value(beneficiary) /
    //     credit mature_value(beneficiary) — balanced per unit.
    const maturationTx = await runtime.economicLedgerService.getTransaction(
      ctx,
      matured.maturationTransactionId!,
    );
    expect(maturationTx.kind).toBe("maturation");
    expect(maturationTx.subject).toEqual({
      kind: "economic_value",
      id: pending.id,
    });
    expect(maturationTx.entries).toHaveLength(2);
    const mDebit = maturationTx.entries.find((e) => e.direction === "debit")!;
    const mCredit = maturationTx.entries.find(
      (e) => e.direction === "credit",
    )!;
    expect(mDebit.accountKind).toBe("pending_value");
    expect(mDebit.ownerPersonId).toBe(harness.poolCreatorPersonId);
    expect(mCredit.accountKind).toBe("mature_value");
    expect(mCredit.ownerPersonId).toBe(harness.poolCreatorPersonId);
    expect(sumMinor(maturationTx.entries, "debit")).toBe(
      sumMinor(maturationTx.entries, "credit"),
    );
    expect(sumMinor(maturationTx.entries, "debit")).toBe(120_000_000);

    // (d) Exactly ONE economic_value.matured audit event (the
    //     state-machine witness with the from/to lineage).
    const maturedEvents = await runtime.auditWriter.query({
      eventType: "economic_value.matured",
      resourceId: pending.id,
    });
    expect(maturedEvents).toHaveLength(1);
    const mMetadata = maturedEvents[0]!.metadata as Record<string, unknown>;
    expect(mMetadata["fromState"]).toBe("PENDING");
    expect(mMetadata["toState"]).toBe("MATURE");
    expect(mMetadata["fromVersion"]).toBe(0);
    expect(mMetadata["toVersion"]).toBe(1);
    expect(mMetadata["ledgerTransactionId"]).toBe(
      matured.maturationTransactionId,
    );

    // (e) The maturation replay under the SAME key: the identical
    //     record, no re-application, still ONE audit event.
    const replay = await matureValueRecord(
      harness,
      pending.id,
      "w036-ac08-mature-a",
    );
    expect(replay).toEqual(matured);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.matured",
          resourceId: pending.id,
        })
      ).length,
    ).toBe(1);

    // (f) Maturing an ALREADY-MATURE record under a NEW key fails
    //     closed with the exact state-machine error — each state
    //     change applies once, pending is not equivalent to mature.
    const alreadyMatureError = await expectRejection(() =>
      matureValueRecord(harness, pending.id, "w036-ac08-mature-again"),
    );
    expect(alreadyMatureError).toBeTruthy();
    const ame = alreadyMatureError as OpenConError;
    expect(ame.code).toBe("ECONOMIC_VALIDATION");
    expect(ame.message).toMatch(/is MATURE, not PENDING/);
    expect(ame.message).toMatch(/each state change applies once/);
    expect(ame.message).toMatch(
      /pending value is not equivalent to mature value/,
    );
    const unchanged = await runtime.economicValueService.getValue(
      ctx,
      pending.id,
    );
    expect(unchanged.state).toBe("MATURE");
    expect(unchanged.version).toBe(1);
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.matured",
          resourceId: pending.id,
        })
      ).length,
    ).toBe(1);

    // (g) A REVERSED record can never mature: the append-only reversal
    //     (the REAL service API) negates the authorized postings, then
    //     the maturation refuses the terminal state.
    const reversedSource = (
      await runtime.economicValueService.recordPendingValue(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.poolCreatorPersonId,
        amount: 120,
        sources: canonicalSources(),
        idempotencyKey: "w036-ac08-value-reversed",
      })
    ).value;
    const reversed = await runtime.economicValueService.reverseValue(ctx, {
      valueRecordId: reversedSource.id,
      reason: "W036 AC-08: the recognition failed post-hoc review",
      idempotencyKey: "w036-ac08-reverse",
    });
    expect(reversed.state).toBe("REVERSED");
    expect(reversed.version).toBe(1);
    expect(reversed.reversal).not.toBeNull();
    expect(reversed.reversal!.reason).toBe(
      "W036 AC-08: the recognition failed post-hoc review",
    );
    // The reversal postings NEGATE the recognition exactly (balanced).
    const reversalTx = await runtime.economicLedgerService.getTransaction(
      ctx,
      reversed.reversal!.transactionId,
    );
    expect(reversalTx.kind).toBe("reversal");
    expect(reversalTx.entries).toHaveLength(2);
    expect(sumMinor(reversalTx.entries, "debit")).toBe(
      sumMinor(reversalTx.entries, "credit"),
    );
    const reversedMatureError = await expectRejection(() =>
      matureValueRecord(harness, reversedSource.id, "w036-ac08-mature-rev"),
    );
    expect(reversedMatureError).toBeTruthy();
    const rme = reversedMatureError as OpenConError;
    expect(rme.code).toBe("ECONOMIC_VALIDATION");
    expect(rme.message).toMatch(/is REVERSED, not PENDING/);
  }, 120_000);

  test("RISK/DISPUTE GATES: an active HOLD risk control refuses the maturation (RISK_CONTROL), an active bonded dispute refuses it (DISPUTE_CHALLENGE) — nothing transitions, no maturation audit; the sanctioned resolutions re-open the authoritative path → MATURE", async () => {
    const runtime = harness.runtime;
    const ctx = harness.poolCreatorCtx("w036-ac08-gates");

    // The gated subject: a fresh PENDING record over the canonical
    // VERIFIED triple.
    const gated = (
      await runtime.economicValueService.recordPendingValue(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.poolCreatorPersonId,
        amount: 120,
        sources: canonicalSources(),
        idempotencyKey: "w036-ac08-value-gates",
      })
    ).value;
    expect(gated.state).toBe("PENDING");

    // (a) The risk HOLD on the fulfillment subject (an UPSTREAM SOURCE
    //     of the recognized value — the harness stage-13 mechanics
    //     with the FIXED W036_RISK_CONTROL_EVALUATED_AT anchor): the
    //     composition root refuses the maturation BEFORE the
    //     settlement mutation.
    const controlDecisionId = await holdMaturationOn(
      harness,
      "contribution",
      contribution.id,
    );
    const riskError = await expectRejection(() =>
      matureValueRecord(harness, gated.id, "w036-ac08-gate-mature-1"),
    );
    expect(riskError).toBeTruthy();
    const re = riskError as OpenConError;
    expect(re.code).toBe("RISK_CONTROL");
    expect(re.message).toMatch(/operation value_maturation is refused/);
    expect(re.message).toMatch(/active risk control/);
    expect(re.message).toMatch(/\(HOLD\)/);
    expect(re.context).toMatchObject({
      controlDecisionId,
      action: "HOLD",
      operationClass: "value_maturation",
    });
    // Nothing transitioned; no maturation was audited.
    expect(
      (await runtime.economicValueService.getValue(ctx, gated.id)).state,
    ).toBe("PENDING");
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.matured",
          resourceId: gated.id,
        })
      ).length,
    ).toBe(0);

    // (b) The sanctioned resolution re-opens the path; then an ACTIVE
    //     bonded dispute on the same upstream subject (supplier B —
    //     the challenger; the dispute effectiveAt = the subject's OWN
    //     authoritative createdAt anchor) refuses it again.
    await resolveHold(harness, controlDecisionId);
    const disputeId = await openBondedDisputeOn(
      harness,
      "contribution",
      contribution.id,
    );
    const disputeError = await expectRejection(() =>
      matureValueRecord(harness, gated.id, "w036-ac08-gate-mature-2"),
    );
    expect(disputeError).toBeTruthy();
    const de = disputeError as OpenConError;
    expect(de.code).toBe("DISPUTE_CHALLENGE");
    expect(de.message).toMatch(/operation is refused: active dispute/);
    expect(de.context).toMatchObject({ disputeId });
    expect(
      (await runtime.economicValueService.getValue(ctx, gated.id)).state,
    ).toBe("PENDING");
    expect(
      (
        await runtime.auditWriter.query({
          eventType: "economic_value.matured",
          resourceId: gated.id,
        })
      ).length,
    ).toBe(0);

    // (c) The durable control/dispute trail (activated → resolved,
    //     opened → resolved — the gates exercised AND resolved through
    //     the /disputes authority).
    const controlEvents = await runtime.auditWriter.query({
      resourceType: "risk_control_decision",
      resourceId: controlDecisionId,
    });
    expect(controlEvents.map((e) => e.eventType)).toContain(
      "risk_control.activated",
    );
    expect(controlEvents.map((e) => e.eventType)).toContain(
      "risk_control.resolved",
    );
    const disputeEventsBefore = await runtime.auditWriter.query({
      resourceType: "dispute",
      resourceId: disputeId,
    });
    expect(disputeEventsBefore.map((e) => e.eventType)).toContain(
      "dispute.opened",
    );
    expect(disputeEventsBefore.map((e) => e.eventType)).toContain(
      "dispute.stake_bonded",
    );
    // The dispute is STILL open here (review/resolution come below) —
    // the gate refusal above was against an ACTIVE bonded dispute.
    expect(
      disputeEventsBefore.map((e) => e.eventType),
    ).not.toContain("dispute.resolved");

    // (d) The due-process resolution (DISMISSED + RELEASE_CONTROL) —
    //     the maturation now succeeds through the authoritative path.
    await resolveDispute(harness, disputeId, contribution.id);
    const disputeEventsAfter = await runtime.auditWriter.query({
      resourceType: "dispute",
      resourceId: disputeId,
    });
    expect(disputeEventsAfter.map((e) => e.eventType)).toContain(
      "dispute.resolved",
    );
    const matured = await matureValueRecord(
      harness,
      gated.id,
      "w036-ac08-gate-mature-3",
    );
    expect(matured.state).toBe("MATURE");
    expect(matured.version).toBe(1);
    const gateEvents = await runtime.auditWriter.query({
      eventType: "economic_value.matured",
      resourceId: gated.id,
    });
    expect(gateEvents).toHaveLength(1);
    expect((gateEvents[0]!.metadata as Record<string, unknown>)["toState"]).toBe(
      "MATURE",
    );
  }, 180_000);

  test("NO PROCUREMENT LEDGER: global conservation holds over the ONE settlement ledger; every economic entry is settlement-owned; NO demand record or audit event carries economic/ledger state", async () => {
    const runtime = harness.runtime;
    const ctx = harness.poolCreatorCtx("w036-ac08-containment");

    // (a) GLOBAL CONSERVATION over the whole ledger: Σdebit === Σcredit
    //     per unit across ALL committed entries + every account
    //     balance ≥ 0 (the W008 harness proof, imported).
    await assertGlobalConservation(harness.w008);

    // (b) Every committed ledger entry belongs to the SETTLEMENT-OWNED
    //     account vocabulary (the frozen ECONOMIC_ACCOUNT_KINDS — the
    //     value/credits/rewards/cash/stake accounts; there is no
    //     procurement/demand account kind at all).
    const entries = await runtime.postgresAuthority.scan<{
      accountKind: string;
    }>("economic_ledger_entries");
    expect(entries.length).toBeGreaterThan(0);
    const vocabulary = new Set<string>(ECONOMIC_ACCOUNT_KINDS);
    for (const record of entries) {
      expect(
        vocabulary.has(record.value.accountKind),
        `ledger entry account kind ${record.value.accountKind} must be settlement-owned`,
      ).toBe(true);
    }
    for (const forbiddenKind of [
      "procurement",
      "demand",
      "pool",
      "offer",
      "selection",
      "savings",
    ]) {
      expect(
        entries.some((r) => r.value.accountKind === forbiddenKind),
      ).toBe(false);
    }

    // (c) NO economic audit event references a demand resourceType —
    //     and conversely, every audit event over a demand resourceType
    //     is a procurement-domain event (the demand records carry no
    //     economic semantics at all).
    const demandResourceTypes = new Set([
      "procurement_pool",
      "procurement_commitment",
      "procurement_offer",
      "procurement_selection",
      "procurement_baseline",
      "procurement_savings",
    ]);
    const economicEventPrefixes = [
      "economic_value.",
      "economic_maturation",
      "reward_",
      "credit_",
      "cash_",
      "stake.",
      "ledger.",
      "conversion.",
    ];
    const log = await runtime.auditWriter.query({ limit: 1_000_000 });
    const economicEvents = log.filter((event) =>
      economicEventPrefixes.some((prefix) =>
        (event.eventType as string).startsWith(prefix),
      ),
    );
    expect(economicEvents.length).toBeGreaterThan(0);
    for (const event of economicEvents) {
      expect(
        demandResourceTypes.has(event.resourceType as string),
        `economic event ${String(event.eventType)} must never reference a demand resource (${String(event.resourceType)})`,
      ).toBe(false);
    }
    const demandEvents = log.filter((event) =>
      demandResourceTypes.has(event.resourceType as string),
    );
    expect(demandEvents.length).toBeGreaterThan(0);
    for (const event of demandEvents) {
      expect((event.eventType as string).startsWith("procurement_")).toBe(
        true,
      );
    }

    // (d) The demand-side records themselves carry NO economic
    //     postings or ledger references: the pool, the commitments,
    //     the offer, the selection, the baseline and the savings
    //     record have no ledger/transaction/posting/economic fields.
    const savingsRecords =
      await runtime.procurementSavingsService.listPoolSavings(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      });
    expect(savingsRecords.map((s) => s.id)).toContain(savings.id);
    const demandRecords: readonly [string, unknown][] = [
      ["pool", pool],
      ["commitments", commitments],
      ["offer", offer],
      ["selection", selection],
      ["baseline", baseline],
      ["savings", savingsRecords],
    ];
    for (const [label, record] of demandRecords) {
      const json = JSON.stringify(record).toLowerCase();
      for (const forbidden of [
        '"ledger',
        '"posting',
        '"transactionid"',
        '"credit',
        '"reward',
        '"stake',
        '"balance',
        '"amount"',
        "economic_value",
        "consumedby",
      ]) {
        expect(json, `${label} must not carry ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }

    // (e) The ONLY economic collections the canonical chain touched
    //     are the settlement-owned ones: the economic entries all
    //     carry settlement accounts (b), the economic mutations are
    //     audited only as economic resource types (c), and the
    //     settlement ledger is the single source of economic truth
    //     (conservation (a)) — a second (procurement) ledger would
    //     require demand-side economic state, which does not exist.
  }, 120_000);

  test("NO-BYPASS (structural): the whole W036 suite contains ZERO ledger/repository write code tokens — economic state is writable only through the settlement primitive (comments stripped)", async () => {
    // Strip comments so the pin scans CODE only (the doc comments
    // legitimately NAME the forbidden tokens while explaining why
    // they are absent — the W035/AC-04 regression discipline). The
    // token literals are ASSEMBLED from pieces so this file's own
    // assertion code never contains the forbidden token itself
    // (self-covering pin).
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .replace(/[ \t]\/\/.*$/gm, "");

    const suiteDir = import.meta.dir;
    const files = (await readdir(suiteDir)).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThanOrEqual(11);
    // The ledger-collection/repository write tokens: a procurement
    // ledger or any out-of-settlement economic write would need one
    // of these through the authority shim.
    const writeTokens = [
      "." + "put" + "(",
      "saveWith" + "inTx",
      "deleteWith" + "inTx",
    ];
    for (const name of files) {
      const code = stripComments(
        await readFile(join(suiteDir, name), "utf8"),
      );
      for (const token of writeTokens) {
        expect(
          code.split(token).length - 1,
          `${name}: ${token}`,
        ).toBe(0);
      }
    }
    // The behavioral no-bypass proof is the INPUT GATE test above
    // (the unverified-source ECONOMIC_VALIDATION refusal with zero
    // staged state) — together with the settlement-owned containment
    // scan, the mutation "write outside the settlement primitive /
    // create a second ledger" has no remaining path.

    // Determinism self-pins for THIS file (assembled literals — the
    // whole token never appears in code).
    const ownCode = stripComments(
      await readFile(
        join(suiteDir, "net-w036-ac-08-settlement-authority.test.ts"),
        "utf8",
      ),
    );
    for (const token of [
      "new " + "Date" + "(",
      "Date." + "now" + "(",
      "random" + "UUID",
    ]) {
      expect(ownCode.split(token).length - 1).toBe(0);
    }
    // Fixed-key discipline: every idempotency key in this file is a
    // fixed w036-ac08 literal (no fabricated identities).
    expect(ownCode.split('"w036-ac08-').length - 1).toBeGreaterThanOrEqual(
      20,
    );
  }, 120_000);
});
