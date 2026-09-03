/**
 * NET-W036 AC-06 — Baseline/counterfactual and savings (work order §5
 * AC-06 + the frozen ledger §4 + §3.3): the W027-supported
 * baseline/counterfactual semantics establish verified savings — the
 * canonical counterfactual baseline (a quantified confidence interval
 * over a HISTORICAL comparison window DERIVED from the pool's own
 * authoritative createdAt through the harness's pure ISO arithmetic)
 * + pool-bound /evidence references + pool-bound /outcomes savings
 * observations, evaluated through the OWNING boundary
 * (`runtime.procurementSavingsService`) with ALL twelve machine-
 * readable sufficiency checks re-derived, SERVER-OWNED arithmetic
 * (savings = baseline − observed), uncertainty PRESERVED (MIN point +
 * the conservative interval envelope) and a digest that EXCLUDES the
 * evaluation anchor (reproducible across evaluations).
 *
 * Unsupported (insufficient evidence), STALE (the frozen 365-day
 * bound on the baseline window end AND the observation collection
 * time), INVALID (the one-way terminal baseline invalidation),
 * uncertainty-collapsed (mixed units; a manufactured point-only
 * counterfactual) and non-qualifying (model/self) observation sources
 * all fail CLOSED: the derived view reports the failing checks by
 * name, `recordProcurementSavings` throws PROCUREMENT_SAVINGS_
 * VALIDATION with the machine-readable `savings_derivation_not_
 * supported` reason + `failedChecks`, and NOTHING is persisted and
 * NO audit event is emitted. Re-invalidating an invalidated baseline
 * is the stable PROCUREMENT_SAVINGS_CONFLICT.
 *
 * Mutation targets covered (ledger §4): accept unsupported baseline;
 * accept stale baseline; invent deterministic savings from
 * insufficient evidence; drop uncertainty.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac06-…`),
 * the harness's FIXED anchors (W036_EVIDENCE_CAPTURED_AT, the
 * W036_STALE_* provably-stale fixtures) — NO `Date.now(`, NO
 * `randomUUID`, NO `new Date(` code tokens in this file. The only
 * wall-clock coupling is the SERVER-SET savings evaluation anchor
 * (savings-service `nowIso()`), which the pool-derived comparison
 * window is inside BY CONSTRUCTION (the harness stage-10 constraint
 * proof), and the /outcomes server-stamped observation collection
 * times. ONE harness per file (the W025/W026/W027 AC-suite
 * precedent).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW036Harness,
  w036IsoMinusDays,
  W036_BASELINE_WINDOW_DAYS,
  W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  W036_EVIDENCE_CAPTURED_AT,
  W036_STALE_COLLECTED_AT,
  W036_STALE_BASELINE_WINDOW_ENDS_AT,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import {
  InvalidProcurementSavingsError,
  ProcurementSavingsConflictError,
  PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES,
  PROCUREMENT_SAVINGS_DERIVATION_CRITERIA,
  PROCUREMENT_SAVINGS_DERIVATION_METHOD,
  PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
  PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
  PROCUREMENT_SAVINGS_RECORD_FORMAT,
} from "../../src/core/procurement-savings.ts";
import type { OpenConError } from "../../src/core/errors.ts";
import type {
  CompetitiveSelection,
  ProcurementBaseline,
  ProcurementPool,
  ProcurementSavings,
} from "../../src/demand/port.ts";
import type { OutcomeObservation } from "../../src/outcomes/port.ts";
import type { Evidence } from "../../src/evidence/port.ts";

let harness: NetW036Harness;

// The canonical AC-06 savings chain (built in test 1, reused by the
// later negative fixtures through the module-level ids).
let pool: ProcurementPool;
let selection: CompetitiveSelection;
let poolEvidence: Evidence;
let savingsObservation: OutcomeObservation;
let baseline: ProcurementBaseline;
/** The canonical positive view (test 1) — the digest lineage anchor. */
let canonicalDigest: string;

beforeAll(async () => {
  harness = await createNetW036Harness();
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Deterministic fixtures (fixed keys; the seed its OWN pool — the
// AC-01..05 suite discipline)
// ---------------------------------------------------------------------------

/**
 * The canonical AC-06 savings chain: a qualified three-buyer pool →
 * the supplier-A offer → the recorded competitive selection (the
 * neutral W026 lineage reference the derivation validates) → the
 * pool-bound platform /evidence (FIXED collectedAt anchor — stored
 * verbatim, never freshness-gated by /evidence) → the pool-bound
 * savings observation (the /outcomes authority stamps its OWN
 * collection instant — always fresh at the derivation anchor) → the
 * EXPLICIT counterfactual baseline (1000 usd, quantified interval
 * [0.8, 0.95]) over the 30-day historical comparison window ending
 * 1 day before the POOL's authoritative creation instant (mirroring
 * the harness's canonical stage-10 construction exactly).
 */
async function seedCanonicalSavingsChain(): Promise<void> {
  const runtime = harness.runtime;
  const scope = harness.organizationScopeId;
  const buyerA = harness.poolCreatorCtx("w036-ac06-seed");
  pool = (
    await runtime.procurementService.createProcurementPool(buyerA, {
      organizationScopeId: scope,
      name: "W036 AC-06 Baseline Savings Pool",
      categoryKey: "cloud_infrastructure",
      qualificationPolicy: {
        minimumCommitments: 2,
        minimumOrganizations: 2,
      },
      idempotencyKey: "w036-ac06-pool",
    })
  ).pool;
  const commitmentSeeds: readonly {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-ac06-commit-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: "w036-ac06-commit-a",
    },
    {
      ctx: harness.buyerBCtx("w036-ac06-commit-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: "w036-ac06-commit-b",
    },
    {
      ctx: harness.buyerCCtx("w036-ac06-commit-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: "w036-ac06-commit-c",
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
    harness.supplierACtx("w036-ac06-offer-a"),
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
      idempotencyKey: "w036-ac06-offer-a",
    },
  );
  selection = (
    await runtime.supplierOfferService.recordCompetitiveSelection(
      buyerA,
      {
        organizationScopeId: scope,
        poolId: pool.id,
        idempotencyKey: "w036-ac06-selection",
      },
    )
  ).selection;
  poolEvidence = await runtime.evidenceService.createEvidence(buyerA, {
    organizationScopeId: scope,
    ownerId: harness.poolCreatorPersonId,
    subjectReference: {
      subjectId: pool.id,
      subjectType: "procurement_pool",
    },
    provenance: {
      sourceType: "platform",
      sourceId: "w036-ac06-spend-ledger",
      method: "historical-spend-report",
      collectedAt: W036_EVIDENCE_CAPTURED_AT,
      collectorId: harness.poolCreatorPersonId,
    },
    confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
    sensitivity: "standard",
    payload: { kind: "spend_report", note: "W036 AC-06 baseline evidence" },
  });
  savingsObservation =
    await runtime.outcomeObservationService.createOutcomeObservation(buyerA, {
      organizationScopeId: scope,
      observerId: harness.poolCreatorPersonId,
      subjectReference: {
        subjectId: pool.id,
        subjectType: "procurement_pool",
      },
      outcomeType: "savings",
      observedValue: { value: 880, unit: "usd" },
      confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
      provenance: {
        sourceType: "platform",
        sourceId: "w036-ac06-fulfillment-ledger",
        method: "procurement-fulfillment-ledger",
        methodVersion: "1",
        // collectedAt deliberately OMITTED — the /outcomes authority
        // stamps its own collection instant (fresh at the derivation
        // anchor by construction; no local fabrication).
      },
    });
  // The DERIVED window anchors: the pool's OWN server-set createdAt,
  // re-read through the owning boundary, minus the fixed geometry.
  const authoritativePool = await runtime.procurementService
    .getProcurementPool(buyerA, scope, pool.id);
  const windowEndsAt = w036IsoMinusDays(
    authoritativePool.createdAt,
    W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  );
  const windowStartsAt = w036IsoMinusDays(
    authoritativePool.createdAt,
    W036_BASELINE_WINDOW_ENDS_DAYS_AGO + W036_BASELINE_WINDOW_DAYS,
  );
  baseline = (
    await runtime.procurementSavingsService.createProcurementBaseline(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      baselineKind: "counterfactual",
      method: "prior_period",
      methodVersion: "1",
      comparisonWindow: { startsAt: windowStartsAt, endsAt: windowEndsAt },
      population:
        "Historical spend for the pool category over the comparison window (the W036 AC-06 canonical counterfactual)",
      baselineValue: { value: 1000, unit: "usd" },
      confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      provenance: {
        sourceType: "platform",
        sourceId: "w036-ac06-spend-ledger",
        collectedAt: windowEndsAt,
        collectorId: harness.poolCreatorPersonId,
      },
      evidenceIds: [poolEvidence.id],
      idempotencyKey: "w036-ac06-baseline",
    })
  ).baseline;
}

/** The canonical evaluation input (the selection lineage included). */
function canonicalEvaluationInput(): {
  organizationScopeId: string;
  poolId: string;
  baselineId: string;
  outcomeObservationIds: string[];
  selectionId: string;
} {
  return {
    organizationScopeId: harness.organizationScopeId,
    poolId: pool.id,
    baselineId: baseline.id,
    outcomeObservationIds: [savingsObservation.id],
    selectionId: selection.id,
  };
}

/** The count of authoritative savings records for the canonical pool. */
async function canonicalSavingsCount(): Promise<number> {
  return (
    await harness.runtime.procurementSavingsService.listPoolSavings(
      harness.poolCreatorCtx("w036-ac06-list"),
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      },
    )
  ).length;
}

/** The count of `procurement_savings.recorded` audit events so far. */
async function savingsAuditCount(): Promise<number> {
  return (
    await harness.runtime.auditWriter.query({
      eventType: "procurement_savings.recorded",
    })
  ).length;
}

/**
 * Attempt `recordProcurementSavings` and return the thrown error
 * (fails the test when the command unexpectedly succeeds).
 */
async function expectRecordFailsClosed(
  input: {
    organizationScopeId: string;
    poolId: string;
    baselineId: string;
    outcomeObservationIds: string[];
    selectionId?: string;
    idempotencyKey: string;
  },
): Promise<OpenConError> {
  let caught: unknown = null;
  try {
    await harness.runtime.procurementSavingsService.recordProcurementSavings(
      harness.poolCreatorCtx("w036-ac06-record-negative"),
      input,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeTruthy();
  expect(caught).toBeInstanceOf(InvalidProcurementSavingsError);
  const openConError = caught as OpenConError;
  expect(openConError.code).toBe("PROCUREMENT_SAVINGS_VALIDATION");
  const context = openConError.context as Record<string, unknown>;
  expect(context["reason"]).toBe("savings_derivation_not_supported");
  return openConError;
}

/** The exact twelve machine-readable check names (the engine order). */
const TWELVE_CHECKS = [
  "baseline_valid",
  "baseline_kind_interval",
  "baseline_evidence_supported",
  "baseline_evidence_fresh",
  "observation_present",
  "observation_supported",
  "observation_chain_head",
  "observation_subject_bound",
  "observation_outcome_type_savings",
  "observation_evidence_fresh",
  "unit_consistent",
  "uncertainty_preserved",
] as const;

describe("NET-W036-AC-06 baseline/counterfactual + savings (W027 authority)", () => {
  test("SUPPORTED DERIVATION: the canonical counterfactual baseline + pool-bound evidence + savings observation evaluate SUPPORTED with ALL 12 checks green, server-owned arithmetic, PRESERVED uncertainty and a reproducible anchor-excluded digest — and the evaluation mutates/audits NOTHING", async () => {
    await seedCanonicalSavingsChain();
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-evaluate");

    // The baseline record: the counterfactual kind with the quantified
    // interval, the pool-derived historical window, the pool-bound
    // evidence reference (lineage to the pool + the evidence).
    expect(baseline.baselineKind).toBe("counterfactual");
    expect(baseline.confidence).toEqual({
      point: 0.9,
      lower: 0.8,
      upper: 0.95,
    });
    expect(baseline.baselineValue).toEqual({ value: 1000, unit: "usd" });
    expect(baseline.poolId).toBe(pool.id);
    expect(baseline.createdBy).toBe(harness.poolCreatorPersonId);
    expect(baseline.evidenceIds).toEqual([poolEvidence.id]);
    expect(baseline.invalidatedAt).toBeNull();
    expect(baseline.comparisonWindow.endsAt).toBe(
      w036IsoMinusDays(
        (await runtime.procurementService.getProcurementPool(
          buyerA,
          harness.organizationScopeId,
          pool.id,
        )).createdAt,
        W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
      ),
    );

    // The derived view BEFORE any recording: the mutates/audits-
    // nothing envelope is snapshotted now.
    const auditBefore = await runtime.auditWriter.query({
      limit: 1_000_000,
    });
    const savingsCountBefore = await canonicalSavingsCount();

    const view = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, canonicalEvaluationInput());

    // (a) SUPPORTED — the conjunction of every machine-readable check.
    expect(view.supported).toBe(true);
    expect(view.checks.map((check) => check.check)).toEqual([
      ...TWELVE_CHECKS,
    ]);
    expect(view.checks.every((check) => check.satisfied)).toBe(true);
    // The versioned, server-owned derivation policy snapshot.
    expect(view.derivationPolicy.version).toBe(
      PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
    );
    expect(view.derivationPolicy.method).toBe(
      PROCUREMENT_SAVINGS_DERIVATION_METHOD,
    );
    expect(view.derivationPolicy.criteria).toEqual([
      ...PROCUREMENT_SAVINGS_DERIVATION_CRITERIA,
    ]);
    expect(view.baselineId).toBe(baseline.id);
    expect(view.baselineKind).toBe("counterfactual");
    expect(view.poolId).toBe(pool.id);
    expect(view.observationIds).toEqual([savingsObservation.id]);

    // (b) SERVER-OWNED arithmetic: savings = baseline − observed
    //     (1000 − 880 = 120 usd) — never caller arithmetic.
    expect(view.baselineValue).toEqual({ value: 1000, unit: "usd" });
    expect(view.observedValue).toEqual({ value: 880, unit: "usd" });
    expect(view.savings).toEqual({ value: 120, unit: "usd" });

    // (c) UNCERTAINTY PRESERVED: the combined confidence is the MIN
    //     point (0.9 < 0.95) over the conservative interval envelope
    //     [min(0.8, 0.9), max(0.95, 0.98)] = [0.8, 0.98] — the exact
    //     interval, never collapsed to a point.
    expect(view.confidence).toEqual({
      point: 0.9,
      lower: 0.8,
      upper: 0.98,
      method: "conservative-savings-derivation",
    });
    expect(
      view.checks.find((check) => check.check === "uncertainty_preserved")
        ?.satisfied,
    ).toBe(true);
    expect(
      view.checks.find((check) => check.check === "uncertainty_preserved")
        ?.detail,
    ).toMatchObject({ needsInterval: true });

    // (d) The digest EXCLUDES the evaluation anchor: a second
    //     evaluation (a fresh server-set anchor) over identical
    //     authoritative state yields the IDENTICAL digest.
    const replayView = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, canonicalEvaluationInput());
    expect(replayView.supported).toBe(true);
    expect(replayView.digest).toBe(view.digest);
    expect(typeof view.digest).toBe("string");
    expect(view.digest.length).toBeGreaterThan(0);
    canonicalDigest = view.digest;

    // (e) The evaluation mutated and audited NOTHING: the audit log
    //     length is unchanged, no savings record exists, and the
    //     derived 200 decision is the product (supported or not).
    const auditAfter = await runtime.auditWriter.query({
      limit: 1_000_000,
    });
    expect(auditAfter.length).toBe(auditBefore.length);
    expect(await canonicalSavingsCount()).toBe(savingsCountBefore);
    expect(await savingsAuditCount()).toBe(0);
  }, 120_000);

  test("RECORD: the authoritative ProcurementSavings record (supported, derivation policy, pool+baseline+observations+selection lineage) commits once; the same-key replay returns the IDENTICAL record (created:false) with exactly ONE audit event", async () => {
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-record");

    const first = await runtime.procurementSavingsService
      .recordProcurementSavings(buyerA, {
        ...canonicalEvaluationInput(),
        idempotencyKey: "w036-ac06-savings",
      });
    expect(first.created).toBe(true);

    // The authoritative record: supported, the derivation policy
    // version/method/criteria, and the FULL lineage — pool + baseline
    // + observations + the canonical selection.
    const record: ProcurementSavings = first.savings;
    expect(record.supported).toBe(true);
    expect(record.organizationScopeId).toBe(harness.organizationScopeId);
    expect(record.poolId).toBe(pool.id);
    expect(record.baselineId).toBe(baseline.id);
    expect(record.selectionId).toBe(selection.id);
    expect(record.observationIds).toEqual([savingsObservation.id]);
    expect(record.recordedBy).toBe(harness.poolCreatorPersonId);
    expect(record.derivationPolicy.version).toBe(
      PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
    );
    expect(record.derivationPolicy.method).toBe(
      PROCUREMENT_SAVINGS_DERIVATION_METHOD,
    );
    expect(record.derivationPolicy.criteria).toEqual([
      ...PROCUREMENT_SAVINGS_DERIVATION_CRITERIA,
    ]);
    // The server-owned derived facts land on the record verbatim.
    expect(record.baselineValue).toEqual({ value: 1000, unit: "usd" });
    expect(record.observedValue).toEqual({ value: 880, unit: "usd" });
    expect(record.savings).toEqual({ value: 120, unit: "usd" });
    expect(record.confidence).toEqual({
      point: 0.9,
      lower: 0.8,
      upper: 0.98,
      method: "conservative-savings-derivation",
    });
    expect(record.checks.every((check) => check.satisfied)).toBe(true);
    expect(record.digest).toBe(canonicalDigest);
    expect(record.recordFormat).toBe(PROCUREMENT_SAVINGS_RECORD_FORMAT);
    expect(record.evaluationAnchor).toBeTruthy();

    // The same-key replay: created:false + the IDENTICAL record.
    const replay = await runtime.procurementSavingsService
      .recordProcurementSavings(buyerA, {
        ...canonicalEvaluationInput(),
        idempotencyKey: "w036-ac06-savings",
      });
    expect(replay.created).toBe(false);
    expect(replay.savings).toEqual(record);

    // Exactly ONE audit event for the record (the replay audited
    // nothing), and exactly one authoritative record for the pool.
    expect(await savingsAuditCount()).toBe(1);
    const events = await runtime.auditWriter.query({
      eventType: "procurement_savings.recorded",
      resourceId: record.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata?.supported).toBe(true);
    expect(events[0]!.metadata?.digest).toBe(canonicalDigest);
    expect(await canonicalSavingsCount()).toBe(1);
  }, 120_000);

  test("UNSUPPORTED (insufficient evidence): zero observations AND zero evidence references fail closed — PROCUREMENT_SAVINGS_VALIDATION with the failing check names; nothing persisted, no audit event, never a coerced amount", async () => {
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-unsupported");

    // (a) The zero-evidence-refs arm: a baseline REQUIRES ≥1 traceable
    //     evidence reference at creation (the W027 boundary rule — a
    //     baseline claim without provenance is manufactured).
    let refsError: unknown = null;
    try {
      await runtime.procurementSavingsService.createProcurementBaseline(
        buyerA,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          baselineKind: "counterfactual",
          method: "prior_period",
          methodVersion: "1",
          comparisonWindow: {
            startsAt: baseline.comparisonWindow.startsAt,
            endsAt: baseline.comparisonWindow.endsAt,
          },
          population: baseline.population,
          baselineValue: { value: 1000, unit: "usd" },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          provenance: {
            sourceType: "platform",
            sourceId: "w036-ac06-spend-ledger",
            collectedAt: baseline.comparisonWindow.endsAt,
            collectorId: harness.poolCreatorPersonId,
          },
          evidenceIds: [],
          idempotencyKey: "w036-ac06-baseline-no-evidence",
        },
      );
    } catch (error) {
      refsError = error;
    }
    expect(refsError).toBeInstanceOf(InvalidProcurementSavingsError);
    expect((refsError as OpenConError).code).toBe(
      "PROCUREMENT_SAVINGS_VALIDATION",
    );
    expect((refsError as OpenConError).message).toMatch(
      /at least one traceable evidence reference/,
    );

    // (b) The zero-observations arm: the DERIVED view is a legitimate
    //     failing decision (observation_present fails; and because a
    //     counterfactual claim NEEDS an interval while nothing is
    //     combinable, uncertainty_preserved fails too — the claim
    //     carries NO confidence at all, never a coerced amount).
    const view = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: baseline.id,
        outcomeObservationIds: [],
        selectionId: selection.id,
      });
    expect(view.supported).toBe(false);
    const failed = view.checks.filter((check) => !check.satisfied);
    // With NO observations: the presence gate fails, the ≥1
    // qualifying-observation gate fails (an empty set supports
    // nothing), and the claim carries NO confidence at all.
    expect(failed.map((check) => check.check)).toEqual([
      "observation_present",
      "observation_supported",
      "uncertainty_preserved",
    ]);
    expect(
      failed.find((check) => check.check === "observation_present")?.detail,
    ).toMatchObject({ reason: "no_observations" });
    expect(
      failed.find((check) => check.check === "uncertainty_preserved")?.detail,
    ).toMatchObject({ needsInterval: true, reason: "uncertainty_collapsed" });
    expect(view.observedValue).toBeNull();
    expect(view.savings).toBeNull();
    expect(view.confidence).toBeNull();

    // (c) The RECORD fails closed with the machine-readable reason +
    //     the failed check names; nothing is persisted and NO audit
    //     event is emitted.
    const savingsBefore = await canonicalSavingsCount();
    const auditBefore = await savingsAuditCount();
    const error = await expectRecordFailsClosed({
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [],
      selectionId: selection.id,
      idempotencyKey: "w036-ac06-savings-empty",
    });
    const failedChecks = (
      error.context as Record<string, unknown>
    )["failedChecks"] as { readonly check: string }[];
    expect(failedChecks.map((entry) => entry.check)).toEqual([
      "observation_present",
      "observation_supported",
      "uncertainty_preserved",
    ]);
    expect(await canonicalSavingsCount()).toBe(savingsBefore);
    expect(await savingsAuditCount()).toBe(auditBefore);
  }, 120_000);

  test("STALE: a comparison window ended beyond the frozen 365-day bound AND an observation collected beyond it both fail closed through the named freshness checks; the record fails closed with nothing persisted", async () => {
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-stale");

    // (a) A STALE BASELINE: the comparison window ends at the FIXED
    //     provably-stale anchor (more than
    //     PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS before ANY
    //     plausible evaluation anchor) — historical (creation-valid)
    //     but stale at the derivation anchor.
    const staleBaseline = (
      await runtime.procurementSavingsService.createProcurementBaseline(
        buyerA,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          baselineKind: "counterfactual",
          method: "prior_period",
          methodVersion: "1",
          comparisonWindow: {
            startsAt: w036IsoMinusDays(
              W036_STALE_BASELINE_WINDOW_ENDS_AT,
              W036_BASELINE_WINDOW_DAYS,
            ),
            endsAt: W036_STALE_BASELINE_WINDOW_ENDS_AT,
          },
          population:
            "Historical spend for the pool category (the W036 AC-06 provably-stale window)",
          baselineValue: { value: 1000, unit: "usd" },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          provenance: {
            sourceType: "platform",
            sourceId: "w036-ac06-spend-ledger",
            collectedAt: W036_STALE_COLLECTED_AT,
            collectorId: harness.poolCreatorPersonId,
          },
          evidenceIds: [poolEvidence.id],
          idempotencyKey: "w036-ac06-baseline-stale-window",
        },
      )
    ).baseline;
    // The stale window IS historical — the creation boundary accepted
    // it (staleness is DERIVED at the evaluation anchor, never
    // mutated: there is no staleness mutation anywhere).
    expect(staleBaseline.comparisonWindow.endsAt).toBe(
      W036_STALE_BASELINE_WINDOW_ENDS_AT,
    );

    // The derivation against the FRESH observation: ONLY the
    // baseline-evidence freshness check fails (attributable to the
    // stale window alone).
    const baselineView = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: staleBaseline.id,
        outcomeObservationIds: [savingsObservation.id],
        selectionId: selection.id,
      });
    expect(baselineView.supported).toBe(false);
    expect(
      baselineView.checks
        .filter((check) => !check.satisfied)
        .map((check) => check.check),
    ).toEqual(["baseline_evidence_fresh"]);
    expect(
      baselineView.checks.find(
        (check) => check.check === "baseline_evidence_fresh",
      )?.detail,
    ).toMatchObject({
      reason: "baseline_evidence_stale",
      windowEndsAt: W036_STALE_BASELINE_WINDOW_ENDS_AT,
    });

    const savingsBefore = await canonicalSavingsCount();
    const auditBefore = await savingsAuditCount();
    const error = await expectRecordFailsClosed({
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      baselineId: staleBaseline.id,
      outcomeObservationIds: [savingsObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-ac06-savings-stale-baseline",
    });
    expect(
      (
        (error.context as Record<string, unknown>)["failedChecks"] as {
          readonly check: string;
        }[]
      ).map((entry) => entry.check),
    ).toEqual(["baseline_evidence_fresh"]);

    // (b) A STALE OBSERVATION: the provenance collection time is the
    //     FIXED provably-stale anchor — the observation-evidence
    //     freshness check fails while the canonical (fresh) baseline
    //     passes.
    const staleObservation =
      await runtime.outcomeObservationService.createOutcomeObservation(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.poolCreatorPersonId,
        subjectReference: {
          subjectId: pool.id,
          subjectType: "procurement_pool",
        },
        outcomeType: "savings",
        observedValue: { value: 880, unit: "usd" },
        confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
        provenance: {
          sourceType: "platform",
          sourceId: "w036-ac06-fulfillment-ledger",
          method: "procurement-fulfillment-ledger",
          methodVersion: "1",
          collectedAt: W036_STALE_COLLECTED_AT,
        },
      });
    const observationView = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: baseline.id,
        outcomeObservationIds: [staleObservation.id],
        selectionId: selection.id,
      });
    expect(observationView.supported).toBe(false);
    expect(
      observationView.checks
        .filter((check) => !check.satisfied)
        .map((check) => check.check),
    ).toEqual(["observation_evidence_fresh"]);
    const freshDetail = observationView.checks.find(
      (check) => check.check === "observation_evidence_fresh",
    )?.detail as Record<string, unknown>;
    expect(freshDetail["reason"]).toBe("observation_evidence_stale");
    expect(freshDetail["maxAgeDays"]).toBe(
      PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
    );
    expect(freshDetail["staleObservationIds"]).toEqual([
      staleObservation.id,
    ]);

    await expectRecordFailsClosed({
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [staleObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-ac06-savings-stale-observation",
    });

    // Neither stale direction persisted anything nor audited.
    expect(await canonicalSavingsCount()).toBe(savingsBefore);
    expect(await savingsAuditCount()).toBe(auditBefore);
  }, 120_000);

  test("INVALID: invalidateProcurementBaseline is the ONE-WAY terminal invalidation — re-invalidation is PROCUREMENT_SAVINGS_CONFLICT and every subsequent derivation fails closed on baseline_valid", async () => {
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-invalid");

    // A fresh victim baseline over the same pool (multiple baselines
    // per pool are the legitimate lineage).
    const victim = (
      await runtime.procurementSavingsService.createProcurementBaseline(
        buyerA,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          baselineKind: "counterfactual",
          method: "prior_period",
          methodVersion: "1",
          comparisonWindow: {
            startsAt: baseline.comparisonWindow.startsAt,
            endsAt: baseline.comparisonWindow.endsAt,
          },
          population: baseline.population,
          baselineValue: { value: 1000, unit: "usd" },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          provenance: {
            sourceType: "platform",
            sourceId: "w036-ac06-spend-ledger",
            collectedAt: baseline.comparisonWindow.endsAt,
            collectorId: harness.poolCreatorPersonId,
          },
          evidenceIds: [poolEvidence.id],
          idempotencyKey: "w036-ac06-baseline-victim",
        },
      )
    ).baseline;
    // Sanity: the victim derives supported BEFORE the invalidation.
    const before = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: victim.id,
        outcomeObservationIds: [savingsObservation.id],
        selectionId: selection.id,
      });
    expect(before.supported).toBe(true);

    // The one-way terminal invalidation (a field mutation — never a
    // status machine; /workflows is untouched by W027).
    const invalidated = await runtime.procurementSavingsService
      .invalidateProcurementBaseline(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        baselineId: victim.id,
        reason: "quality_review",
        idempotencyKey: "w036-ac06-invalidate",
      });
    expect(invalidated.invalidatedAt).not.toBeNull();
    expect(invalidated.invalidationReason).toBe("quality_review");
    // Exactly ONE invalidation audit event (the same-key replay of
    // the invalidation is a no-op returning the same record).
    const replayedInvalidation =
      await runtime.procurementSavingsService.invalidateProcurementBaseline(
        buyerA,
        {
          organizationScopeId: harness.organizationScopeId,
          baselineId: victim.id,
          reason: "quality_review",
          idempotencyKey: "w036-ac06-invalidate",
        },
      );
    expect(replayedInvalidation.invalidatedAt).toBe(
      invalidated.invalidatedAt,
    );
    expect(
      await runtime.auditWriter.query({
        eventType: "procurement_baseline.invalidated",
        resourceId: victim.id,
      }),
    ).toHaveLength(1);

    // A FRESH-KEY re-invalidation of the already-invalidated baseline
    // is the stable conflict (one-way: never a second lifecycle
    // event).
    let conflict: unknown = null;
    try {
      await runtime.procurementSavingsService.invalidateProcurementBaseline(
        buyerA,
        {
          organizationScopeId: harness.organizationScopeId,
          baselineId: victim.id,
          reason: "method_superseded",
          idempotencyKey: "w036-ac06-invalidate-again",
        },
      );
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(ProcurementSavingsConflictError);
    expect((conflict as OpenConError).code).toBe(
      "PROCUREMENT_SAVINGS_CONFLICT",
    );
    expect(
      (conflict as OpenConError).context as Record<string, unknown>,
    ).toMatchObject({ baselineId: victim.id });

    // The subsequent derivation fails closed on baseline_valid ALONE
    // (the record carries the invalidation facts).
    const after = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: victim.id,
        outcomeObservationIds: [savingsObservation.id],
        selectionId: selection.id,
      });
    expect(after.supported).toBe(false);
    expect(
      after.checks.filter((check) => !check.satisfied).map((c) => c.check),
    ).toEqual(["baseline_valid"]);
    expect(
      after.checks.find((check) => check.check === "baseline_valid")?.detail,
    ).toMatchObject({
      reason: "baseline_invalidated",
      invalidatedAt: invalidated.invalidatedAt,
      invalidationReason: "quality_review",
    });

    // The record fails closed; nothing is persisted, no audit event.
    const savingsBefore = await canonicalSavingsCount();
    const auditBefore = await savingsAuditCount();
    const error = await expectRecordFailsClosed({
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      baselineId: victim.id,
      outcomeObservationIds: [savingsObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-ac06-savings-invalidated",
    });
    expect(
      (
        (error.context as Record<string, unknown>)["failedChecks"] as {
          readonly check: string;
        }[]
      ).map((entry) => entry.check),
    ).toEqual(["baseline_valid"]);
    expect(await canonicalSavingsCount()).toBe(savingsBefore);
    expect(await savingsAuditCount()).toBe(auditBefore);
  }, 120_000);

  test("UNCERTAINTY PRESERVATION negatives: a point-only counterfactual confidence is REJECTED at the boundary (manufactured), and mixed units leave the claim UNCOMBINABLE (no savings, no confidence — never a coerced deterministic amount)", async () => {
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-uncertainty");

    // (a) A counterfactual baseline WITHOUT a quantified interval
    //     (point-only confidence): the creation boundary rejects the
    //     manufactured exact claim BEFORE any record exists — the
    //     enforced NET-W006 rule ("an exact counterfactual claim
    //     without quantified uncertainty is manufactured and
    //     rejected", architecture §13). The engine's
    //     baseline_kind_interval/uncertainty_preserved checks are the
    //     in-depth re-derivation of the SAME rule; a point-only
    //     counterfactual baseline record is UNCONSTRUCTIBLE through
    //     the real API, so the boundary rejection IS the real rule.
    const baselineIdsBefore = (
      await runtime.procurementSavingsService.listPoolBaselines(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      })
    ).map((entry) => entry.id);
    let manufactured: unknown = null;
    try {
      await runtime.procurementSavingsService.createProcurementBaseline(
        buyerA,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          baselineKind: "counterfactual",
          method: "prior_period",
          methodVersion: "1",
          comparisonWindow: {
            startsAt: baseline.comparisonWindow.startsAt,
            endsAt: baseline.comparisonWindow.endsAt,
          },
          population: baseline.population,
          baselineValue: { value: 1000, unit: "usd" },
          confidence: { point: 0.9 },
          provenance: {
            sourceType: "platform",
            sourceId: "w036-ac06-spend-ledger",
            collectedAt: baseline.comparisonWindow.endsAt,
            collectorId: harness.poolCreatorPersonId,
          },
          evidenceIds: [poolEvidence.id],
          idempotencyKey: "w036-ac06-baseline-point-only",
        },
      );
    } catch (error) {
      manufactured = error;
    }
    expect(manufactured).toBeInstanceOf(InvalidProcurementSavingsError);
    expect((manufactured as OpenConError).code).toBe(
      "PROCUREMENT_SAVINGS_VALIDATION",
    );
    expect((manufactured as OpenConError).message).toMatch(
      /manufactured and rejected/,
    );
    // Nothing was persisted: the pool carries EXACTLY the baselines
    // that existed before the rejected creation (the manufactured
    // point-only counterfactual never became a record).
    const baselineIdsAfter = (
      await runtime.procurementSavingsService.listPoolBaselines(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
      })
    ).map((entry) => entry.id);
    expect(baselineIdsAfter).toEqual(baselineIdsBefore);
    expect(baselineIdsAfter).toContain(baseline.id);

    // (b) Mixed units (the engine's REAL uncombinable-claim rule): a
    //     well-formed eur observation against the usd baseline fails
    //     unit_consistent; observedValue/savings/confidence are ALL
    //     null (the engine fabricates NO point claim from
    //     uncombinable evidence), and because the counterfactual
    //     claim needs an interval while nothing is combinable,
    //     uncertainty_preserved fails too.
    const eurObservation =
      await runtime.outcomeObservationService.createOutcomeObservation(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.poolCreatorPersonId,
        subjectReference: {
          subjectId: pool.id,
          subjectType: "procurement_pool",
        },
        outcomeType: "savings",
        observedValue: { value: 700, unit: "eur" },
        confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
        provenance: {
          sourceType: "platform",
          sourceId: "w036-ac06-fulfillment-ledger",
          method: "procurement-fulfillment-ledger",
          methodVersion: "1",
        },
      });
    const view = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: baseline.id,
        outcomeObservationIds: [eurObservation.id],
        selectionId: selection.id,
      });
    expect(view.supported).toBe(false);
    expect(
      view.checks.filter((check) => !check.satisfied).map((c) => c.check),
    ).toEqual(["unit_consistent", "uncertainty_preserved"]);
    expect(
      view.checks.find((check) => check.check === "unit_consistent")?.detail,
    ).toMatchObject({ reason: "mixed_units", offendingUnits: ["eur"] });
    expect(view.observedValue).toBeNull();
    expect(view.savings).toBeNull();
    expect(view.confidence).toBeNull();

    // The record fails closed (never a coerced deterministic amount).
    const savingsBefore = await canonicalSavingsCount();
    const auditBefore = await savingsAuditCount();
    await expectRecordFailsClosed({
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [eurObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-ac06-savings-mixed-units",
    });
    expect(await canonicalSavingsCount()).toBe(savingsBefore);
    expect(await savingsAuditCount()).toBe(auditBefore);
  }, 120_000);

  test("SOURCE-TYPE gate: a model/self-provenance observation fails observation_supported (the frozen qualifying vocabulary is platform/attested/provider only) and the record fails closed", async () => {
    const runtime = harness.runtime;
    const buyerA = harness.poolCreatorCtx("w036-ac06-source");

    // The exact qualifying vocabulary (the architecture-lock §4 rule,
    // frozen independently): model/self output alone is input
    // evidence, never authoritative for a savings claim.
    expect([...PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES]).toEqual([
      "platform",
      "attested",
      "provider",
    ]);

    // A model-provenance observation through the REAL
    // createOutcomeObservation API (fresh server-stamped
    // collection time — ONLY the source gate fails).
    const modelObservation =
      await runtime.outcomeObservationService.createOutcomeObservation(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.poolCreatorPersonId,
        subjectReference: {
          subjectId: pool.id,
          subjectType: "procurement_pool",
        },
        outcomeType: "savings",
        observedValue: { value: 880, unit: "usd" },
        confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
        provenance: {
          sourceType: "model",
          sourceId: "w036-ac06-model-advisor",
          method: "model-estimated-savings",
          methodVersion: "1",
        },
      });
    expect(modelObservation.provenance.sourceType).toBe("model");

    const view = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: baseline.id,
        outcomeObservationIds: [modelObservation.id],
        selectionId: selection.id,
      });
    expect(view.supported).toBe(false);
    expect(
      view.checks.filter((check) => !check.satisfied).map((c) => c.check),
    ).toEqual(["observation_supported"]);
    expect(
      view.checks.find((check) => check.check === "observation_supported")
        ?.detail,
    ).toMatchObject({
      reason: "no_qualifying_observation_source",
      sourceTypes: ["model"],
    });

    // A self-provenance observation fails identically (the weaker
    // non-qualifying source).
    const selfObservation =
      await runtime.outcomeObservationService.createOutcomeObservation(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.poolCreatorPersonId,
        subjectReference: {
          subjectId: pool.id,
          subjectType: "procurement_pool",
        },
        outcomeType: "savings",
        observedValue: { value: 880, unit: "usd" },
        confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
        provenance: {
          sourceType: "self",
          sourceId: "w036-ac06-buyer-self-report",
          method: "buyer-self-report",
          methodVersion: "1",
        },
      });
    const selfView = await runtime.procurementSavingsService
      .evaluateProcurementSavings(buyerA, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        baselineId: baseline.id,
        outcomeObservationIds: [selfObservation.id],
        selectionId: selection.id,
      });
    expect(selfView.supported).toBe(false);
    expect(
      selfView.checks
        .filter((check) => !check.satisfied)
        .map((c) => c.check),
    ).toEqual(["observation_supported"]);

    // The record fails closed with the source gate named; nothing is
    // persisted and no audit event is emitted.
    const savingsBefore = await canonicalSavingsCount();
    const auditBefore = await savingsAuditCount();
    const error = await expectRecordFailsClosed({
      organizationScopeId: harness.organizationScopeId,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [modelObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-ac06-savings-model-source",
    });
    expect(
      (
        (error.context as Record<string, unknown>)["failedChecks"] as {
          readonly check: string;
        }[]
      ).map((entry) => entry.check),
    ).toEqual(["observation_supported"]);
    expect(await canonicalSavingsCount()).toBe(savingsBefore);
    expect(await savingsAuditCount()).toBe(auditBefore);
  }, 120_000);
});
