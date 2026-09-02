/**
 * NET-W036 shared test harness — the complete demand/procurement/benefit
 * lifecycle (Phase-9 end-to-end composition proof, stage 1: the canonical
 * harness + the full-path scenario).
 *
 * Wraps the NET-W028 harness (the deepest demand-side chain: W008 → W024 →
 * W025 → W026 → W027 → W028 — runtime + the W008 person pair + the three
 * buyer organizations A/B/C with their dual-membership representatives +
 * the three supplier-side tenant members A/B/C + the demand/procurement/
 * offer/selection/baseline/savings/benefits guard actions; the file-backed
 * PostgresAuthorityShim so no real PostgreSQL is needed) and adds exactly
 * the composition wiring the canonical W036 path needs (all of it through
 * existing sanctioned surfaces — ZERO src/ changes):
 *
 *  - measurement provider threading: the REAL OpenRTB delivery-notice
 *    measurement adapter (W022) wired through `createRuntime` — the same
 *    provider-selection path production uses (TEST verification secret,
 *    never a real credential) — the W035/W018 option-forwarding precedent;
 *  - the guard policies the composed path requires beyond the wrapped
 *    chain: `measurementReport.submit` (the W022/W035 pattern), the
 *    /disputes risk + dispute guard actions (the W009/W010 pattern) and
 *    the per-transition workflow policies scoped to the SUPPLIER A
 *    fulfillment actor + the BUYER A demand owner (the W008 pattern —
 *    the wrapped chain seeds them only for the W008 harness person);
 *  - the canonical end-to-end scenario factory `runW036Scenario` — ONE
 *    deterministic tenant-scoped execution traversing the ENTIRE frozen
 *    authoritative chain IN the canonical executable order (the frozen
 *    ledger §3 seventeen-stage witness contract), with the ordering
 *    proof carried by the AUTHORITATIVE fulfillment-subject state +
 *    version witnesses read through the owning boundary
 *    (`contributionService.getContribution`) after every stage, and the
 *    durable audit log's commit order corroborating the declared stage
 *    order (the W033/W035 traversal-proof discipline).
 *
 * W036 adds NO production source file, domain, authority, state machine,
 * ledger or settlement primitive: this harness is pure test composition
 * over the existing contracts (the demand pool → gated aggregate
 * disclosure → qualified demand → supplier offers → hard eligibility →
 * deterministic competitive selection → sanctioned /workflows fulfillment
 * → REAL provider measurement → normalized outcome → W027 counterfactual
 * baseline + verified savings → /evidence PoV → /settlement recognition +
 * risk/dispute-gated maturation → W028 benefit funding + allocation →
 * ordered lineage reconstruction).
 *
 * DETERMINISM (the W035 PR #73 remediation discipline + the W035-R1
 * full-determinism architect standard — work order §3.1): every
 * idempotency key in the canonical path is a FIXED string, every
 * locally-fabricated timestamp that is shape-validated only (evidence
 * collectedAt, the delivery-notice provenance, the risk-control
 * evaluatedAt) is a FIXED anchor, the dispute challenge anchor is the
 * subject's OWN authoritative timestamp, record ids come from the
 * authoritative services, and the baseline comparison window is
 * DERIVED from the POOL's authoritative `createdAt` through PURE
 * ISO-string arithmetic (`w036IsoMinusDays`). There is NO wall-clock
 * read anywhere in this file — the code token `new Date(` appears
 * ZERO times (fixed anchors or authoritative subject timestamps
 * only, the W035-reviewed precedent).
 */

import {
  createNetW028Harness,
  type NetW028Harness,
} from "../benefits/_net-w028-harness.ts";
import type {
  NetW008Harness,
  NetW008HarnessOptions,
} from "../settlement/_net-w008-harness.ts";
import { createMatureValue } from "../settlement/_net-w008-harness.ts";
import { createSupplierMember } from "../demand/_net-w026-harness.ts";
import { OPENRTB_DELIVERY_TEST_SECRET } from "../adapters/_net-w023-harness.ts";
import { signRawReport } from "../measurement/_net-w022-harness.ts";
import { OpenRtbDeliveryNoticeAdapter, OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import {
  CONTRIBUTION_TRANSITION_TABLE,
  OPPORTUNITY_TRANSITION_TABLE,
  OUTCOME_MEASUREMENT_TRANSITION_TABLE,
  PROOF_OF_VALUE_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
import type {
  CompetitiveSelection,
  CompetitiveSelectionView,
  ProcurementBaseline,
  ProcurementCommitment,
  ProcurementPool,
  ProcurementSavings,
  ProcurementSavingsView,
  QualifiedProcurementAggregate,
  SupplierOffer,
} from "../../src/demand/port.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type {
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import type {
  BenefitPool,
  BenefitPoolAllocation,
  BenefitPoolAllocationView,
} from "../../src/benefits/port.ts";

// ---------------------------------------------------------------------------
// The deterministic fixture anchors (work order §3.1 — the W035 PR #73
// remediation discipline applied to the whole canonical path).
//
// Wall-clock coupling audit of the W036 canonical path (verified against
// the sources): the ONLY authority that wall-clock-gates a LOCALLY
// FABRICATED canonical timestamp is the W027 savings derivation — its
// evaluation anchor is SERVER-SET (savings-service `nowIso()`; there is
// no anchor input), the baseline comparison window must be HISTORICAL
// (endsAt ≤ the submission anchor) and within the frozen 365-day
// staleness bound of the evaluation anchor, and the baseline provenance
// collectedAt must not be in the future relative to the submission time.
// MECHANISM (zero wall-clock): that coupling is satisfied through
// AUTHORITATIVE-SUBJECT-derived anchors — the window is computed from
// the POOL's own server-set `createdAt` (read through the owning
// boundary) minus the fixed 31/1-day geometry via `w036IsoMinusDays`
// (pure ISO-string arithmetic). Because the pool record is created
// BEFORE the baseline submission (many stages earlier) and the savings
// evaluation happens seconds-to-minutes after the pool exists, the
// derived window is simultaneously historical AND fresh at the
// server-set evaluation anchor — deterministically, for any wall clock.
// Everything else is shape-validated only:
//  - /evidence collectedAt is stored verbatim (W035 precedent);
//  - the OpenRTB delivery-notice collectedAt/signedAt are verified for
//    INTEGRITY only (W022/W023 — never freshness);
//  - the risk-assessment evaluatedAt is explicitly "deterministic, no
//    wall-clock races";
//  - the dispute effectiveAt is the subject's OWN authoritative anchor.
// ---------------------------------------------------------------------------

/**
 * The FIXED platform evidence-capture anchor (the W035/W023 fixture
 * style): the pool-bound savings evidence + the PoV evidence provenance
 * collectedAt values. /evidence stores collectedAt verbatim
 * (shape-validated only — never freshness-gated), so this anchor is
 * deterministic for any wall clock.
 */
export const W036_EVIDENCE_CAPTURED_AT = "2026-09-02T10:00:00.000Z";

/**
 * The FIXED risk-assessment/evaluation anchor (the W035 `evaluatedAt`
 * precedent — the /disputes assessment service validates the shape only:
 * "explicit — deterministic, no wall-clock races").
 */
export const W036_RISK_CONTROL_EVALUATED_AT = "2026-09-01T12:00:00.000Z";

/** The FIXED delivery-notice provenance anchor (integrity-verified only). */
export const W036_NOTICE_COLLECTED_AT = "2026-08-30T10:00:00.000Z";

/**
 * A FIXED PROVABLY-STALE timestamp for the later AC suites' negative
 * fixtures (AC-06): more than the frozen 365-day
 * PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS before ANY plausible
 * evaluation anchor — the observation_evidence_fresh /
 * baseline_evidence_fresh checks fail closed on it deterministically.
 */
export const W036_STALE_COLLECTED_AT = "2020-01-01T00:00:00.000Z";

/**
 * A FIXED PROVABLY-STALE comparison-window end for the later AC suites'
 * negative fixtures (AC-06): historical (≤ any submission anchor) but
 * more than 365 days before any plausible evaluation anchor — the
 * baseline_evidence_fresh check fails closed on it deterministically.
 */
export const W036_STALE_BASELINE_WINDOW_ENDS_AT = "2020-01-01T00:00:00.000Z";

/**
 * The baseline comparison-window geometry (days): a 30-day window ending
 * 1 day before the POOL's authoritative creation instant — well inside
 * the historical + fresh envelope the savings authority enforces (see
 * the derivation site in `runW036Scenario` stage 10 for the exact
 * constraint proof).
 */
export const W036_BASELINE_WINDOW_DAYS = 30;
export const W036_BASELINE_WINDOW_ENDS_DAYS_AGO = 1;

/**
 * PURE ISO-string day arithmetic (the W035-R1 determinism standard):
 * subtracts WHOLE days from an ISO-8601 UTC timestamp and returns the
 * shifted timestamp in the authoritative `toISOString()` shape
 * (…THH:MM:SS.mmmZ). The ISO components are parsed and re-composed
 * with closed-form UTC calendar math (`Date.UTC` for the input epoch,
 * Howard Hinnant's civil_from_days for the shifted epoch) — NEVER
 * `new Date(`, so this file contains ZERO wall-clock reads (the
 * code-token pin `new Date(` === 0). Whole-day subtraction preserves
 * the time-of-day components verbatim, so only the civil date shifts.
 * Exported for the later AC suites' deterministic window fixtures.
 */
export function w036IsoMinusDays(iso: string, days: number): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
      iso,
    );
  if (match === null) {
    throw new Error(
      `W036 determinism helper: unparseable ISO-8601 UTC timestamp: ${iso}`,
    );
  }
  const epochMs =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    ) - days * 24 * 60 * 60 * 1000;
  const shiftedDays = Math.floor(epochMs / 86_400_000);
  const [year, month, day] = civilFromDaysUtc(shiftedDays);
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${match[4]}:${match[5]}:${match[6]}.${match[7] ?? "000"}Z`;
}

/**
 * days-since-epoch → UTC civil date (Howard Hinnant's civil_from_days,
 * the closed-form inverse of days_from_civil) — pure arithmetic, no
 * Date object.
 */
function civilFromDaysUtc(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) -
      Math.floor(doe / 146_096)) /
      365,
  ); // [0, 399]
  let year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const month = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  if (month <= 2) {
    year += 1;
  }
  return [year, month, day];
}

/**
 * The canonical W036 OpenRTB delivery notice — a FULLY FIXED, SIGNED raw
 * vendor payload (the W023 `rawDeliveryNotice` fixture style with W036
 * identities). The adapter verifies INTEGRITY only (HMAC over the
 * canonical payload; the provenance timestamps are shape-validated, never
 * freshness-gated — the W022 contract), so the whole notice is
 * deterministic. The sensitive vendor fields (device/user/vendor
 * extensions) stay in the RAW payload only — the adapter redacts them by
 * NAME at the boundary (the privacy proof lives in the AC-05 suite).
 */
export function w036DeliveryNotice(): Record<string, unknown> {
  const body: Record<string, unknown> = {
    noticeId: "w036-delivery-notice-001",
    requestRef: "w036-fulfillment-request-1",
    impressionRef: "1",
    subjectRefs: ["ext-w036-fulfillment-subject-1"],
    outcomeType: "view",
    observedValue: { value: 1, unit: "impressions" },
    confidence: { point: 0.99 },
    attributionMode: "deterministic",
    deterministicLink: "w036-fulfillment-request-1",
    method: "openrtb-delivery-notice",
    methodVersion: "1.0.0",
    collectedAt: W036_NOTICE_COLLECTED_AT,
    device: { ifa: "opaque-device-id-w036" },
    user: { id: "opaque-user-id-w036" },
    vendorExtensions: { experimentBucket: 7 },
  };
  return { ...body, integrity: signRawReport(body, OPENRTB_DELIVERY_TEST_SECRET) };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface NetW036Harness {
  /** The wrapped NET-W028 harness (all its factories work unchanged). */
  readonly w028: NetW028Harness;
  readonly runtime: Runtime;
  readonly bootstrapCtx: ExecutionContext;
  readonly organizationScopeId: string;
  /** Buyer A — the pool creator / demand owner / value beneficiary. */
  readonly poolCreatorPersonId: string;
  readonly buyerAPersonId: string;
  readonly buyerBPersonId: string;
  readonly buyerCPersonId: string;
  readonly buyerOrgAId: string;
  readonly buyerOrgBId: string;
  readonly buyerOrgCId: string;
  /** Supplier A — the SELECTED supplier / the fulfillment contributor. */
  readonly supplierAPersonId: string;
  /** Supplier B — the dispute challenger (an ACTIVE tenant member). */
  readonly supplierBPersonId: string;
  /** Supplier C — the third competing supplier. */
  readonly supplierCPersonId: string;
  /** The W008 harness (the challenger-credit factory chain). */
  readonly w008: NetW008Harness;
  poolCreatorCtx(correlationId: string): ExecutionContext;
  buyerBCtx(correlationId: string): ExecutionContext;
  buyerCCtx(correlationId: string): ExecutionContext;
  supplierACtx(correlationId: string): ExecutionContext;
  supplierBCtx(correlationId: string): ExecutionContext;
  supplierCCtx(correlationId: string): ExecutionContext;
  teardown(): Promise<void>;
}

/** The guard actions seeded beyond the wrapped W028 chain. */
const EXTRA_GUARD_ACTIONS = [
  // The W022/W035 pattern — the composed measurement report submission.
  "measurementReport.submit",
  // The W009 pattern — the risk-control gate exercise.
  "riskPolicy.create",
  "riskAssessment.create",
  "riskControl.activate",
  "riskControl.resolve",
  // The W010 pattern — the dispute gate exercise.
  "dispute.open",
  "dispute.bond",
  "dispute.review",
  "dispute.resolve",
];

export async function createNetW036Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW036Harness> {
  // The REAL W022 provider-selection path: the OpenRTB delivery-notice
  // adapter wired through createRuntime with a TEST verification secret
  // (a test-only literal — NEVER a real credential) — the W035 wiring
  // precedent, threaded through the whole W008→W028 option chain.
  const noticeAdapter = new OpenRtbDeliveryNoticeAdapter({
    verificationSecret: OPENRTB_DELIVERY_TEST_SECRET,
  });
  const w028 = await createNetW028Harness({
    ...opts,
    measurement: {
      ...(opts.measurement ?? {}),
      providers: [
        ...(opts.measurement?.providers ?? []),
        noticeAdapter,
      ],
    },
  });
  const runtime = w028.runtime;
  const bootstrapCtx = w028.bootstrapCtx;
  const w026 = w028.w027.w026;
  const w025 = w026.w025;

  // The guard actions the composed W036 path requires beyond the wrapped
  // chain (transport-level ALLOW policies — the domain-layer
  // membership/creator/consent gates remain the tests' subject).
  for (const action of EXTRA_GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  // The W008 pattern, extended to the W036 actors: the per-transition
  // workflow policies scoped to the SUPPLIER A fulfillment actor (the
  // contribution/PoV/measured-outcome transitions) and the BUYER A
  // demand owner, on the harness organization. The wrapped chain seeds
  // these only for the W008 harness person.
  const transitionActors = [w026.supplierAPersonId, w025.buyerAPersonId];
  for (const personId of transitionActors) {
    for (const rule of [
      ...OPPORTUNITY_TRANSITION_TABLE,
      ...CONTRIBUTION_TRANSITION_TABLE,
      ...PROOF_OF_VALUE_TRANSITION_TABLE,
      ...OUTCOME_MEASUREMENT_TRANSITION_TABLE,
    ]) {
      await runtime.policyService.createPolicy(bootstrapCtx, {
        subject: personId,
        action: rule.policyAction,
        resource: w028.organizationScopeId,
        effect: "allow",
        createdBy: "bootstrap",
      });
    }
  }

  const w008 = w025.w024.w008;
  return {
    w028,
    runtime,
    bootstrapCtx,
    organizationScopeId: w028.organizationScopeId,
    poolCreatorPersonId: w028.poolCreatorPersonId,
    buyerAPersonId: w028.poolCreatorPersonId,
    buyerBPersonId: w028.memberBPersonId,
    buyerCPersonId: w028.memberCPersonId,
    buyerOrgAId: w025.buyerOrgAId,
    buyerOrgBId: w025.buyerOrgBId,
    buyerOrgCId: w025.buyerOrgCId,
    supplierAPersonId: w026.supplierAPersonId,
    supplierBPersonId: w026.supplierBPersonId,
    supplierCPersonId: w026.supplierCPersonId,
    w008,
    poolCreatorCtx(correlationId: string) {
      return w028.poolCreatorCtx(correlationId);
    },
    buyerBCtx(correlationId: string) {
      return w028.memberBCtx(correlationId);
    },
    buyerCCtx(correlationId: string) {
      return w028.memberCCtx(correlationId);
    },
    supplierACtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w026.supplierAPersonId, kind: "person" },
      });
    },
    supplierBCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w026.supplierBPersonId, kind: "person" },
      });
    },
    supplierCCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w026.supplierCPersonId, kind: "person" },
      });
    },
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person context for an arbitrary person id (cross-tenant proofs). */
export function personCtx(
  harness: NetW036Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

// ---------------------------------------------------------------------------
// The canonical scenario — ONE deterministic execution through the FULL
// frozen authoritative chain, with the 17-stage witness contract (the
// frozen ledger §3) and every durable identifier returned.
// ---------------------------------------------------------------------------

/**
 * One canonical-traversal stage witness: the AUTHORITATIVE
 * fulfillment-subject (contribution) state + version, read through the
 * owning boundary (`contributionService.getContribution`) at the moment
 * the named scenario stage completed. The contribution version
 * increments on every /workflows lifecycle mutation (v0 DRAFT → v2
 * ASSIGNED → v3 IN_PROGRESS → v5 MEASURING → v10 VERIFIED) and nothing
 * else moves it, so the witness array is a strictly deterministic
 * executable-order proof. `null` state/version before the fulfillment
 * subject exists (stages 1–6 — the W035 pre-subject null convention).
 */
export interface W036Witness {
  /** The scenario stage that just completed (the frozen ledger §3 name). */
  readonly stage: string;
  /** The owning authority the stage executed through. */
  readonly authority: string;
  /** The stage's durable authoritative record id (null for stage 17). */
  readonly recordId: string | null;
  /** The fulfillment subject's authoritative state (null pre-entry). */
  readonly fulfillmentState: string | null;
  /** The fulfillment subject's authoritative version (null pre-entry). */
  readonly fulfillmentVersion: number | null;
}

export interface RunW036ScenarioOptions {
  /**
   * Stop after the settlement maturation (before the benefit funding +
   * allocation) — the benefit stages use dedicated fixtures in their own
   * suites.
   */
  readonly skipBenefitAllocation?: boolean;
  /** The recognized amount override (default: the verified savings value). */
  readonly amount?: number;
}

export interface W036Scenario {
  // Stage 1 — the demand pool + the three buyer commitments.
  readonly pool: ProcurementPool;
  readonly commitments: readonly ProcurementCommitment[];
  // Stage 2 — the gated aggregate disclosure (the separate dimensions).
  readonly gatedView: QualifiedProcurementAggregate;
  // Stage 3 — the resolved qualified demand (the reproducible digest view).
  readonly qualifiedView: QualifiedProcurementAggregate;
  // Stage 4 — the four supplier offers (A/B/C/D in creation order).
  readonly offers: readonly SupplierOffer[];
  /** Supplier D's offer — the hard-ineligible excluded candidate. */
  readonly excludedOfferId: string;
  readonly excludedSupplierMembershipId: string;
  // Stages 5/6 — the eligibility evaluation + the committed selection.
  readonly selectionView: CompetitiveSelectionView;
  /** The re-derivation (digest reproducibility proof). */
  readonly selectionViewReplay: CompetitiveSelectionView;
  readonly selection: CompetitiveSelection;
  // Stages 7–9 — the fulfillment subject + the REAL provider measurement.
  readonly opportunityId: string;
  readonly contribution: Contribution;
  readonly observation: OutcomeObservation;
  readonly measuredOutcome: MeasuredOutcome;
  readonly measurementProviderId: string;
  // Stage 10 — the counterfactual baseline + the pool-bound facts.
  readonly poolEvidenceId: string;
  readonly savingsObservation: OutcomeObservation;
  readonly baseline: ProcurementBaseline;
  // Stage 11 — the verified savings + the VERIFIED Proof-of-Value.
  readonly savingsView: ProcurementSavingsView;
  readonly savings: ProcurementSavings;
  readonly povPlatformEvidenceId: string;
  readonly povProviderEvidenceId: string;
  readonly attestationId: string;
  readonly proofOfValueId: string;
  // Stages 12–14 — settlement recognition, gates, maturation.
  readonly value: EconomicValueRecord;
  readonly riskControlId: string;
  readonly disputeId: string;
  readonly maturedValue: EconomicValueRecord;
  // Stages 15–16 — the benefit funding + allocation (null when the
  // scenario stopped after the maturation — skipBenefitAllocation).
  readonly rewardPolicyId: string | null;
  readonly rewardPolicyRecordId: string | null;
  readonly benefitPolicyId: string | null;
  readonly benefitPool: BenefitPool | null;
  readonly allocationPlan: BenefitPoolAllocationView | null;
  readonly allocation: BenefitPoolAllocation | null;
  // Stage 17 — the ordered lineage reconstruction.
  readonly auditMarkers: readonly (readonly [string, string])[];
  readonly auditPositions: readonly number[];
  /** The ordered 17-witness traversal proof (the ledger §3 contract). */
  readonly witnesses: readonly W036Witness[];
}

/**
 * The canonical deterministic W036 scenario: ONE tenant-scoped
 * demand/procurement/benefit execution traversing every authority in the
 * frozen order — the procurement pool with three buyer-organization
 * commitments (the privacy floors 3/3 passed as SEPARATE dimensions),
 * the gated aggregate disclosure, the qualified demand, four supplier
 * offers with supplier D hard-excluded BEFORE ranking (its tenant
 * membership revoked — see the doc comment at the revocation site: offer
 * creation rejects past validity horizons, so the deterministic
 * hard-ineligible mechanism is the supplier_authorized gate), the
 * deterministic competitive selection (no economic mutation), the
 * fulfillment as a CONTRIBUTION subject through the SANCTIONED
 * /workflows path, the REAL W022 provider measurement, the VERIFIED
 * measured outcome, the completed VERIFIED lifecycle walk, the W027
 * counterfactual baseline + supported savings, the VERIFIED PoV over the
 * fulfillment subject, the /settlement recognition + risk/dispute gates
 * + maturation, the W028 benefit funding + allocation (the REAL economic
 * draw through the reward policy), and the ordered lineage
 * reconstruction. Every step runs through the OWNING boundary (service
 * or composition-root composite) — never a direct repository write.
 */
export async function runW036Scenario(
  harness: NetW036Harness,
  opts: RunW036ScenarioOptions = {},
): Promise<W036Scenario> {
  const runtime = harness.runtime;
  const scope = harness.organizationScopeId;
  const buyerA = harness.poolCreatorCtx("w036-canonical");

  // The ordered 17-witness traversal array. Pre-subject stages are
  // witnessed by their durable authority record ids; from the
  // fulfillment entry onward, by the AUTHORITATIVE contribution state +
  // version read through the owning boundary after every stage.
  const witnesses: W036Witness[] = [];
  let fulfillmentId: string | null = null;
  const witness = async (
    stage: string,
    authority: string,
    recordId: string | null,
  ): Promise<void> => {
    const fulfillment =
      fulfillmentId === null
        ? null
        : await runtime.contributionService.getContribution(buyerA, fulfillmentId);
    witnesses.push({
      stage,
      authority,
      recordId,
      fulfillmentState: fulfillment?.state ?? null,
      fulfillmentVersion: fulfillment?.version ?? null,
    });
  };

  // -- Stage 1: "demand-pool-resolved" — the procurement pool (buyer A
  //    BECOMES the pool creator — the acting person, server-resolved)
  //    + one commitment from each of the three buyer organizations
  //    (all NA_EAST so the region group is NAMED above the floor; the
  //    frozen server-side privacy floors 3/3 are passed with exactly
  //    three commitments from three DISTINCT buyer organizations).
  const pool = (
    await runtime.procurementService.createProcurementPool(buyerA, {
      organizationScopeId: scope,
      name: "W036 Canonical Procurement Pool",
      categoryKey: "cloud_infrastructure",
      qualificationPolicy: {
        minimumCommitments: 2,
        minimumOrganizations: 2,
      },
      idempotencyKey: "w036-pool-create",
    })
  ).pool;
  const commitments: ProcurementCommitment[] = [];
  const commitmentSeeds: readonly {
    readonly ctx: ExecutionContext;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-commitment-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: "w036-commitment-a",
    },
    {
      ctx: harness.buyerBCtx("w036-commitment-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: "w036-commitment-b",
    },
    {
      ctx: harness.buyerCCtx("w036-commitment-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: "w036-commitment-c",
    },
  ];
  for (const seed of commitmentSeeds) {
    commitments.push(
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
  await witness("demand-pool-resolved", "/demand", pool.id);

  // -- Stage 2: "aggregate-disclosure-gated" — the DERIVED qualified
  //    aggregate: the commitment count AND the distinct buyer-organization
  //    count remain SEPARATE disclosure dimensions, gated independently
  //    by the frozen floors (both 3/3 satisfied) + the requestor's active
  //    membership. The minimized facts exist only above both floors.
  const gatedView = await runtime.procurementService
    .evaluateQualifiedProcurementDemand(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
    });
  const gatedFacts = gatedView.aggregate;
  if (gatedView.qualified !== true || gatedFacts === null) {
    throw new Error(
      `W036 canonical scenario failed: the gated aggregate was not qualified (checks: ${JSON.stringify(
        gatedView.checks.map((c) => [c.check, c.satisfied]),
      )})`,
    );
  }
  if (gatedFacts.commitmentCount !== 3 || gatedFacts.organizationCount !== 3) {
    throw new Error(
      `W036 canonical scenario failed: the separate disclosure dimensions were ${String(
        gatedFacts.commitmentCount,
      )} commitments / ${String(gatedFacts.organizationCount)} organizations (expected 3/3)`,
    );
  }
  await witness("aggregate-disclosure-gated", "/demand", pool.id);

  // -- Stage 3: "qualified-demand-resolved" — the resolved supplier-facing
  //    qualified demand view (the reproducible digest — the anchor is
  //    excluded from the digest, so identical commitment state yields the
  //    identical digest across evaluations).
  const qualifiedView = await runtime.procurementService
    .evaluateQualifiedProcurementDemand(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
    });
  if (qualifiedView.qualified !== true || qualifiedView.digest !== gatedView.digest) {
    throw new Error(
      "W036 canonical scenario failed: the qualified demand re-derivation was not reproducible",
    );
  }
  await witness("qualified-demand-resolved", "/demand", pool.id);

  // -- Stage 4: "supplier-offers-recorded" — FOUR supplier offers through
  //    /demand. Supplier D is created as an ACTIVE tenant member FIRST
  //    (the authorized-supplier gate at offer creation), submits the
  //    fourth offer, and is revoked BEFORE the eligibility evaluation
  //    (stage 5). Supplier A is the cheapest band (the deterministic
  //    rank-1 winner); B and C the middle/most expensive bands.
  //    DEVIATION OF RECORD (from the task brief's "supplier D
  //    hard-ineligible via expired validity"): createSupplierOffer
  //    REJECTS a validUntil that is not STRICTLY AFTER the server-set
  //    submission instant (src/core/procurement-offer.ts
  //    validateSupplierOfferValidity), and the selection anchor is
  //    server-set milliseconds later — a deterministically expired
  //    validity window cannot be constructed without a wall-clock race.
  //    The deterministic hard-ineligible mechanism is therefore the
  //    REVOKED supplier membership (the `supplier_authorized` hard gate,
  //    reason "supplier_membership_not_active") — the brief's sanctioned
  //    fallback ("or use revoked membership for D instead — whichever is
  //    deterministic"). The canonical A/B/C offers stay OPEN-ended
  //    (validUntil null — deterministic, never expires).
  const supplierD = await createSupplierMember(
    runtime,
    harness.bootstrapCtx,
    scope,
    {
      displayName: "W036 Supplier D",
      subjectId: "w036-supplier-d@example.com",
    },
  );
  const offerSeeds: readonly {
    readonly ctx: ExecutionContext;
    readonly unitPriceBand: string;
    readonly key: string;
  }[] = [
    {
      ctx: harness.supplierACtx("w036-offer-a"),
      unitPriceBand: "price_a_under_10",
      key: "w036-offer-a",
    },
    {
      ctx: harness.supplierBCtx("w036-offer-b"),
      unitPriceBand: "price_b_10_49",
      key: "w036-offer-b",
    },
    {
      ctx: harness.supplierCCtx("w036-offer-c"),
      unitPriceBand: "price_c_50_99",
      key: "w036-offer-c",
    },
    {
      ctx: createExecutionContext({
        correlationId: "w036-offer-d",
        actor: { id: supplierD.personId, kind: "person" },
      }),
      unitPriceBand: "price_d_100_499",
      key: "w036-offer-d",
    },
  ];
  const offers: SupplierOffer[] = [];
  for (const seed of offerSeeds) {
    offers.push(
      (
        await runtime.supplierOfferService.createSupplierOffer(seed.ctx, {
          organizationScopeId: scope,
          poolId: pool.id,
          attributes: {
            region: "NA_EAST",
            unitPriceBand: seed.unitPriceBand,
            timingWindow: "window_short_1_3mo",
            quantityBucket: "q_100_999",
          },
          validUntil: null,
          consent: { scope: "competitive_selection" },
          idempotencyKey: seed.key,
        })
      ).offer,
    );
  }
  await witness("supplier-offers-recorded", "/demand", pool.id);

  // -- Stage 5: "supplier-eligibility-evaluated" — the hard eligibility
  //    executes BEFORE the deterministic ranking: supplier D's tenant
  //    membership is REVOKED (the sanctioned /organizations membership
  //    authority), so the re-derived `supplier_authorized` hard gate
  //    excludes D's offer from the ranking entirely (the region +
  //    validity gates still pass — the exclusion is attributable to the
  //    authorization gate alone).
  await runtime.membershipService.revokeMembership(
    harness.bootstrapCtx,
    supplierD.tenantMembershipId,
    "bootstrap",
  );
  const selectionView = await runtime.supplierOfferService
    .evaluateCompetitiveSelection(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
    });
  const excludedEvaluation = selectionView.offerEvaluations.find(
    (evaluation) => evaluation.offerId === offers[3]!.id,
  );
  if (!excludedEvaluation || excludedEvaluation.eligible !== false) {
    throw new Error(
      "W036 canonical scenario failed: the revoked-membership supplier was not hard-excluded",
    );
  }
  const authorizationCheck = excludedEvaluation.checks.find(
    (check) => check.check === "supplier_authorized",
  );
  if (authorizationCheck?.satisfied !== false) {
    throw new Error(
      "W036 canonical scenario failed: the excluded offer's supplier_authorized gate did not fail",
    );
  }
  await witness("supplier-eligibility-evaluated", "/demand", offers[3]!.id);

  // -- Stage 6: "competitive-selection-committed" — the deterministic
  //    competitive selection (the pool creator records the lineage; the
  //    selection is re-derived INSIDE the authoritative transaction — a
  //    procurement DECISION, no economic mutation). The re-derivation
  //    BEFORE the record proves the digest reproducibility (the anchor
  //    is excluded from the digest).
  const selectionViewReplay = await runtime.supplierOfferService
    .evaluateCompetitiveSelection(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
    });
  if (selectionViewReplay.digest !== selectionView.digest) {
    throw new Error(
      "W036 canonical scenario failed: the competitive-selection digest was not reproducible",
    );
  }
  if (selectionView.selectedOfferId !== offers[0]!.id) {
    throw new Error(
      `W036 canonical scenario failed: the deterministic winner was not supplier A (selected: ${String(
        selectionView.selectedOfferId,
      )})`,
    );
  }
  const selection = (
    await runtime.supplierOfferService.recordCompetitiveSelection(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      idempotencyKey: "w036-selection",
    })
  ).selection;
  if (selection.selectedOfferId !== offers[0]!.id) {
    throw new Error(
      "W036 canonical scenario failed: the recorded selection did not select supplier A",
    );
  }
  await witness("competitive-selection-committed", "/demand", selection.id);

  // -- Stage 7: "fulfillment-entered-sanctioned" — the fulfillment is a
  //    CONTRIBUTION subject: buyer A (the demand owner) materializes the
  //    opportunity, the SELECTED supplier (supplier A) contributes, and
  //    the lifecycle enters through the SANCTIONED /workflows transition
  //    path (DRAFT → READY → ASSIGNED; the /workflows authority is the
  //    sole lifecycle mutator — no local procurement state machine).
  const opportunity = await runtime.opportunityService.createOpportunity(
    harness.poolCreatorCtx("w036-opportunity"),
    {
      organizationScopeId: scope,
      ownerId: harness.poolCreatorPersonId,
      opportunityType: "procurement-fulfillment",
      title: "W036 Canonical Fulfillment Opportunity",
      brief: {
        kind: "procurement_fulfillment",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  const supplierA = harness.supplierACtx("w036-contribution");
  const contribution = await runtime.contributionService.createContribution(
    supplierA,
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
  fulfillmentId = contribution.id;
  await requestContributionTransition(
    harness,
    contribution.id,
    "READY",
    "w036-t-ready",
  );
  await requestContributionTransition(
    harness,
    contribution.id,
    "ASSIGNED",
    "w036-t-assigned",
  );
  await witness(
    "fulfillment-entered-sanctioned",
    "/workflows",
    contribution.id,
  );

  // -- Stage 8: "execution-state-observed" — the execution state + version
  //    re-read through the OWNING boundary after the ASSIGNED →
  //    IN_PROGRESS transition (the authoritative execution observation).
  await requestContributionTransition(
    harness,
    contribution.id,
    "IN_PROGRESS",
    "w036-t-in-progress",
  );
  const executing = await runtime.contributionService.getContribution(
    buyerA,
    contribution.id,
  );
  if (executing.state !== "IN_PROGRESS" || executing.version !== 3) {
    throw new Error(
      `W036 canonical scenario failed: the execution state was ${executing.state} v${String(
        executing.version,
      )} (expected IN_PROGRESS v3)`,
    );
  }
  await witness("execution-state-observed", "/workflows", contribution.id);

  // -- Stage 9: "realized-outcome-normalized" — the lifecycle reaches the
  //    MEASUREMENT point (IN_PROGRESS → SUBMITTED → MEASURING), the
  //    measurement flows through the REAL provider boundary (the W022
  //    composed command + the OpenRTB delivery-notice adapter: integrity
  //    verification, privacy redaction, provider attribution), the
  //    normalized observation lands in /outcomes (provenance + uncertainty
  //    preserved), and the MeasuredOutcome matures to VERIFIED
  //    (create → beginMaturation → recordMeasurementRollup → finalize).
  await requestContributionTransition(
    harness,
    contribution.id,
    "SUBMITTED",
    "w036-t-submitted",
  );
  await requestContributionTransition(
    harness,
    contribution.id,
    "MEASURING",
    "w036-t-measuring",
  );
  const measurement = await submitFulfillmentMeasurement(
    harness,
    contribution.id,
  );
  const measuredOutcome = await createVerifiedMeasuredOutcomeForSubject(
    harness,
    contribution.id,
    measurement.observation.id,
  );
  await witness("realized-outcome-normalized", "/outcomes", measurement.observation.id);

  // -- The lifecycle walk completes through /workflows (MEASURING →
  //    EVALUATING → CHALLENGE_WINDOW → SETTLING → SETTLED → VERIFIED) —
  //    the canonical order (the task brief + the frozen ledger): the
  //    completed VERIFIED fulfillment subject precedes the W027 baseline
  //    and every downstream economic stage (the /settlement input gate
  //    requires the VERIFIED contribution).
  const verifiedContribution = await walkToVerified(
    harness,
    contribution.id,
  );

  // -- Stage 10: "baseline-counterfactual-resolved" — the W027-supported
  //    counterfactual baseline: pool-bound /evidence (platform source,
  //    FIXED collectedAt anchor), the pool-bound savings observation
  //    (the /outcomes authority stamps its OWN collectedAt — always
  //    fresh at the derivation anchor), and the explicit counterfactual
  //    baseline (1000 usd, quantified interval [0.8, 0.95]) over a
  //    30-day historical comparison window ending 1 day before the
  //    POOL's authoritative creation instant (the W035-R1 standard —
  //    authoritative subject timestamps, never wall-clock: derived via
  //    `w036IsoMinusDays` from `pool.createdAt`).
  //
  //    Constraint proof (src/core/procurement-savings.ts +
  //    src/demand/savings-engine.ts — the SOURCE is truth):
  //    - window length 30 days ∈ [1, 365]
  //      (PROCUREMENT_BASELINE_COMPARISON_WINDOW_{MIN,MAX}_DAYS);
  //    - endsAt = pool.createdAt − 1d < pool.createdAt ≤ the baseline
  //      submission instant → HISTORICAL
  //      (validateProcurementBaselineAttributes: endsAt ≤ submission);
  //    - provenance collectedAt = endsAt → likewise ≤ submission
  //      (the service's not-in-the-future gate);
  //    - endsAt is 1 day before a record created seconds-to-minutes
  //      before the savings evaluation → inside the frozen 365-day
  //      bound of the server-set evaluation anchor → FRESH
  //      (baselineWindowFreshAtAnchor) — for ANY wall clock.
  const poolEvidence = await runtime.evidenceService.createEvidence(buyerA, {
    organizationScopeId: scope,
    ownerId: harness.poolCreatorPersonId,
    subjectReference: { subjectId: pool.id, subjectType: "procurement_pool" },
    provenance: {
      sourceType: "platform",
      sourceId: "w036-spend-ledger",
      method: "historical-spend-report",
      collectedAt: W036_EVIDENCE_CAPTURED_AT,
      collectorId: harness.poolCreatorPersonId,
    },
    confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
    sensitivity: "standard",
    payload: { kind: "spend_report", note: "W036 canonical baseline evidence" },
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
        sourceId: "w036-fulfillment-ledger",
        method: "procurement-fulfillment-ledger",
        methodVersion: "1",
        // NOTE: collectedAt is deliberately OMITTED — the /outcomes
        // authority stamps its own collection instant, which is fresh at
        // the savings derivation anchor by construction (no local
        // fabrication, no wall-clock read in this harness).
      },
    });
  // The DERIVED window anchors: the pool's OWN server-set createdAt,
  // re-read through the owning boundary (getProcurementPool), minus the
  // fixed window geometry — see the stage-10 constraint proof above.
  const authoritativePool = await runtime.procurementService
    .getProcurementPool(buyerA, scope, pool.id);
  const baselineWindowEndsAt = w036IsoMinusDays(
    authoritativePool.createdAt,
    W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  );
  const baseline = (
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
        "Historical spend for the pool category over the comparison window (the W036 canonical counterfactual)",
      baselineValue: { value: 1000, unit: "usd" },
      confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      provenance: {
        sourceType: "platform",
        sourceId: "w036-spend-ledger",
        collectedAt: baselineWindowEndsAt,
        collectorId: harness.poolCreatorPersonId,
      },
      evidenceIds: [poolEvidence.id],
      idempotencyKey: "w036-baseline",
    })
  ).baseline;
  await witness("baseline-counterfactual-resolved", "/demand", baseline.id);

  // -- Stage 11: "savings-verified-pov-qualified" — the supported savings
  //    derivation (evaluate → record; server-owned arithmetic: 1000 − 880
  //    = 120 usd, uncertainty preserved) + the VERIFIED Proof-of-Value
  //    over the fulfillment subject (platform + provider evidence, the
  //    independent buyer-A attestation, aggregation → VERIFIED through
  //    /evidence — the PoV authority for downstream economics).
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
      `W036 canonical scenario failed: the savings derivation was not supported (checks: ${JSON.stringify(
        savingsView.checks.map((c) => [c.check, c.satisfied]),
      )})`,
    );
  }
  const savings = (
    await runtime.procurementSavingsService.recordProcurementSavings(buyerA, {
      organizationScopeId: scope,
      poolId: pool.id,
      baselineId: baseline.id,
      outcomeObservationIds: [savingsObservation.id],
      selectionId: selection.id,
      idempotencyKey: "w036-savings",
    })
  ).savings;
  const pov = await attachVerifiedProofOfValueForSubject(
    harness,
    contribution.id,
  );
  await witness("savings-verified-pov-qualified", "/demand+evidence", savings.id);

  // -- Stage 12: "settlement-value-recognized-pending" — the verified
  //    savings/value enters /settlement through the EXISTING economic
  //    primitive (the input gate re-resolves every source: the VERIFIED
  //    contribution + the VERIFIED PoV + the VERIFIED measured outcome,
  //    all same-scope; the balanced recognition postings commit as ONE
  //    authoritative unit). The beneficiary is the pool-creator buyer A;
  //    the amount is the verified savings value (120) — mirroring the
  //    W035 recognition shape (immediate maturation, no maturation input).
  const recognizedAmount = opts.amount ?? savings.savings?.value;
  if (recognizedAmount === undefined) {
    throw new Error(
      "W036 canonical scenario failed: the supported savings carried no derived value",
    );
  }
  const value = (
    await runtime.economicValueService.recordPendingValue(buyerA, {
      organizationScopeId: scope,
      beneficiaryPersonId: harness.poolCreatorPersonId,
      amount: recognizedAmount,
      sources: [
        { kind: "contribution", id: contribution.id },
        { kind: "proof_of_value", id: pov.proofOfValueId },
        { kind: "measured_outcome", id: measuredOutcome.id },
      ],
      idempotencyKey: "w036-value-record",
    })
  ).value;
  await witness(
    "settlement-value-recognized-pending",
    "/settlement",
    value.id,
  );

  // -- Stage 13: "risk-dispute-controls-exercised" — BEFORE the economic
  //    maturation, the EXISTING /disputes controls exercise fail-closed
  //    (a HOLD risk control + an ACTIVE bonded dispute on the
  //    fulfillment subject — an upstream source of the recognized
  //    value), then BOTH resolve and the authoritative path re-opens
  //    (the W034/W035-precedented recognition-before-gates order:
  //    recognition is not risk-gated; MATURATION is).
  const riskControlId = await holdMaturationOn(
    harness,
    "contribution",
    contribution.id,
  );
  let maturedFirst: EconomicValueRecord | null = null;
  try {
    maturedFirst = await matureValueRecord(harness, value.id);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "RISK_CONTROL") {
      throw error;
    }
  }
  if (maturedFirst !== null) {
    throw new Error(
      "W036 canonical scenario failed: the HOLD risk control did not refuse the maturation",
    );
  }
  await resolveHold(harness, riskControlId);

  const disputeId = await openBondedDisputeOn(
    harness,
    "contribution",
    contribution.id,
  );
  let maturedSecond: EconomicValueRecord | null = null;
  try {
    maturedSecond = await matureValueRecord(harness, value.id);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "DISPUTE_CHALLENGE") {
      throw error;
    }
  }
  if (maturedSecond !== null) {
    throw new Error(
      "W036 canonical scenario failed: the ACTIVE dispute did not refuse the maturation",
    );
  }
  await resolveDispute(harness, disputeId, contribution.id);
  await witness("risk-dispute-controls-exercised", "/settlement", value.id);

  // -- Stage 14: "value-matured" — the maturation composite (all gates
  //    now green) commits the MATURE state through /settlement.
  const maturedValue = await matureValueRecord(harness, value.id);
  if (maturedValue.state !== "MATURE") {
    throw new Error(
      `W036 canonical scenario failed: the matured value state was ${maturedValue.state}`,
    );
  }
  await witness("value-matured", "/settlement", value.id);

  if (opts.skipBenefitAllocation === true) {
    const reconstruction = await reconstructLineage(harness, {
      pool,
      commitments,
      offers,
      selection,
      opportunityId: opportunity.id,
      contributionId: contribution.id,
      observationId: measurement.observation.id,
      measuredOutcomeId: measuredOutcome.id,
      poolEvidenceId: poolEvidence.id,
      savingsObservationId: savingsObservation.id,
      baselineId: baseline.id,
      savingsId: savings.id,
      povPlatformEvidenceId: pov.platformEvidenceId,
      povProviderEvidenceId: pov.providerEvidenceId,
      proofOfValueId: pov.proofOfValueId,
      attestationId: pov.attestationId,
      valueId: value.id,
      riskControlId,
      disputeId,
    });
    await witness("lineage-reconstruction-completed", "audit", null);
    return {
      pool,
      commitments,
      gatedView,
      qualifiedView,
      offers,
      excludedOfferId: offers[3]!.id,
      excludedSupplierMembershipId: supplierD.tenantMembershipId,
      selectionView,
      selectionViewReplay,
      selection,
      opportunityId: opportunity.id,
      contribution: verifiedContribution,
      observation: measurement.observation,
      measuredOutcome,
      measurementProviderId: measurement.providerId,
      poolEvidenceId: poolEvidence.id,
      savingsObservation,
      baseline,
      savingsView,
      savings,
      povPlatformEvidenceId: pov.platformEvidenceId,
      povProviderEvidenceId: pov.providerEvidenceId,
      attestationId: pov.attestationId,
      proofOfValueId: pov.proofOfValueId,
      value,
      riskControlId,
      disputeId,
      maturedValue,
      rewardPolicyId: null,
      rewardPolicyRecordId: null,
      benefitPolicyId: null,
      benefitPool: null,
      allocationPlan: null,
      allocation: null,
      auditMarkers: reconstruction.markers,
      auditPositions: reconstruction.positions,
      witnesses,
    };
  }

  // -- Stage 15: "benefit-funding-reference-resolved" — the W028 benefit
  //    composition: the /settlement reward policy mirroring the three
  //    buyers at weights 3/2/1, the /benefits allocation policy (credits,
  //    active_membership eligibility, last_member_absorbs, the mirrored
  //    reward policy), and the pool funded BY REFERENCE to the MATURE
  //    value record (funding refs only — never amounts).
  const rewardPolicy = await runtime.rewardPolicyService.createPolicyVersion(
    harness.poolCreatorCtx("w036-reward-policy"),
    {
      organizationScopeId: scope,
      policyId: "w036-reward-policy",
      version: 1,
      description: "NET-W036 canonical reward policy (mirrors the benefits policy)",
      allocations: [
        { beneficiaryPersonId: harness.buyerAPersonId, weight: 3 },
        { beneficiaryPersonId: harness.buyerBPersonId, weight: 2 },
        { beneficiaryPersonId: harness.buyerCPersonId, weight: 1 },
      ],
    },
  );
  const benefitPolicy = (
    await runtime.benefitPoolService.createPolicyVersion(
      harness.poolCreatorCtx("w036-benefit-policy"),
      {
        organizationScopeId: scope,
        policyId: "w036-benefit-policy",
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.buyerAPersonId, weight: 3 },
          { personId: harness.buyerBPersonId, weight: 2 },
          { personId: harness.buyerCPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        rewardPolicyId: "w036-reward-policy",
        idempotencyKey: "w036-benefit-policy",
      },
    )
  ).policy;
  const benefitPool = (
    await runtime.benefitPoolService.createBenefitPool(
      harness.poolCreatorCtx("w036-benefit-pool"),
      {
        organizationScopeId: scope,
        policyId: "w036-benefit-policy",
        fundingRefs: [{ kind: "economic_value", id: maturedValue.id }],
        idempotencyKey: "w036-benefit-pool",
      },
    )
  ).pool;
  await witness("benefit-funding-reference-resolved", "/benefits", benefitPool.id);

  // -- Stage 16: "benefit-allocation-committed" — the derived plan preview
  //    (evaluate) + the atomic allocation (allocate): the deterministic
  //    member eligibility + the scaled-floor proportional plan + the REAL
  //    economic draw through the /settlement reward policy (the value
  //    record is consumed exactly-once; conservation holds; /benefits
  //    never becomes a second ledger).
  const allocationPlan = await runtime.benefitPoolService
    .evaluatePoolAllocation(buyerA, {
      organizationScopeId: scope,
      poolId: benefitPool.id,
    });
  if (allocationPlan.eligible !== true || allocationPlan.plan === null) {
    throw new Error(
      `W036 canonical scenario failed: the benefit allocation plan was not eligible (checks: ${JSON.stringify(
        allocationPlan.checks.map((c) => [c.check, c.satisfied]),
      )})`,
    );
  }
  const allocation = (
    await runtime.benefitPoolService.allocatePoolBenefits(buyerA, {
      organizationScopeId: scope,
      poolId: benefitPool.id,
      idempotencyKey: "w036-allocation",
    })
  ).allocation;
  await witness("benefit-allocation-committed", "/benefits", allocation.id);

  // -- Stage 17: "lineage-reconstruction-completed" — the complete chain
  //    reconstructed from durable identifiers + the ordered audit
  //    markers (positions strictly ascending in the global append-only
  //    log — the final ordered-marker proof; local array order alone is
  //    never evidence).
  const reconstruction = await reconstructLineage(harness, {
    pool,
    commitments,
    offers,
    selection,
    opportunityId: opportunity.id,
    contributionId: contribution.id,
    observationId: measurement.observation.id,
    measuredOutcomeId: measuredOutcome.id,
    poolEvidenceId: poolEvidence.id,
    savingsObservationId: savingsObservation.id,
    baselineId: baseline.id,
    savingsId: savings.id,
    povPlatformEvidenceId: pov.platformEvidenceId,
    povProviderEvidenceId: pov.providerEvidenceId,
    proofOfValueId: pov.proofOfValueId,
    attestationId: pov.attestationId,
    valueId: value.id,
    riskControlId,
    disputeId,
    rewardPolicyRecordId: rewardPolicy.id,
    benefitPolicyId: benefitPolicy.id,
    benefitPoolId: benefitPool.id,
    drawResultId: allocation.draw?.resultId ?? "",
    allocationId: allocation.id,
  });
  await witness("lineage-reconstruction-completed", "audit", null);

  return {
    pool,
    commitments,
    gatedView,
    qualifiedView,
    offers,
    excludedOfferId: offers[3]!.id,
    excludedSupplierMembershipId: supplierD.tenantMembershipId,
    selectionView,
    selectionViewReplay,
    selection,
    opportunityId: opportunity.id,
    contribution: verifiedContribution,
    observation: measurement.observation,
    measuredOutcome,
    measurementProviderId: measurement.providerId,
    poolEvidenceId: poolEvidence.id,
    savingsObservation,
    baseline,
    savingsView,
    savings,
    povPlatformEvidenceId: pov.platformEvidenceId,
    povProviderEvidenceId: pov.providerEvidenceId,
    attestationId: pov.attestationId,
    proofOfValueId: pov.proofOfValueId,
    value,
    riskControlId,
    disputeId,
    maturedValue,
    rewardPolicyId: "w036-reward-policy",
    rewardPolicyRecordId: rewardPolicy.id,
    benefitPolicyId: benefitPolicy.id,
    benefitPool,
    allocationPlan,
    allocation,
    auditMarkers: reconstruction.markers,
    auditPositions: reconstruction.positions,
    witnesses,
  };
}

// ---------------------------------------------------------------------------
// Scenario building blocks (the W036 composition specifics)
// ---------------------------------------------------------------------------

/**
 * Request ONE sanctioned /workflows lifecycle transition for the
 * fulfillment contribution (the supplier-A actor — the contributor; the
 * per-transition policies the harness seeded cover the actor). Re-reads
 * the subject for fresh versions. Exported for the AC-04 fulfillment
 * lifecycle suite.
 */
export async function requestContributionTransition(
  harness: NetW036Harness,
  contributionId: string,
  targetState:
    | "READY"
    | "ASSIGNED"
    | "IN_PROGRESS"
    | "SUBMITTED"
    | "MEASURING"
    | "EVALUATING"
    | "CHALLENGE_WINDOW"
    | "SETTLING"
    | "SETTLED",
  idempotencyKey: string,
): Promise<void> {
  const ctx = harness.supplierACtx("w036-transition");
  const current = await harness.runtime.contributionService.getContribution(
    ctx,
    contributionId,
  );
  await harness.runtime.workflowService.requestTransition(
    {
      subjectId: contributionId,
      subjectKind: "contribution",
      targetState,
      expectedVersion: current.version,
      idempotencyKey,
      actorPersonId: harness.supplierAPersonId,
      policyAction: policyActionFor(
        "contribution",
        current.state as "DRAFT",
        targetState,
      ),
      metadata: { demandProcurementLifecycle: "net-w036" },
    },
    ctx,
  );
}

/**
 * Submit ONE deterministic OpenRTB delivery notice through the COMPOSED
 * W022 measurement command (the REAL provider-selection path: the
 * delivery-notice adapter normalizes + integrity-verifies the fixed raw
 * vendor payload, the composed command persists the neutral observation
 * in /outcomes exactly-once). The observer is the acting supplier A.
 */
export async function submitFulfillmentMeasurement(
  harness: NetW036Harness,
  subjectId: string,
): Promise<{
  readonly observation: OutcomeObservation;
  readonly providerId: string;
}> {
  const ctx = harness.supplierACtx("w036-measure");
  const result = await harness.runtime.apiCommands.submitMeasurementReport(
    ctx,
    harness.supplierAPersonId,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectReference: { subjectId, subjectType: "contribution" },
      idempotencyKey: "w036-observation",
      providerId: OPENRTB_DELIVERY_PROVIDER_ID,
      report: w036DeliveryNotice(),
    },
  );
  const observation =
    await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      (result as { observation: { id: string } }).observation.id,
    );
  return { observation, providerId: OPENRTB_DELIVERY_PROVIDER_ID };
}

/**
 * A VERIFIED normalized measured outcome for the given subject over the
 * provider observation: immediate maturation, the recorded deterministic
 * rollup, finalization → VERIFIED (the W033/W035 sequence, fixed keys).
 */
export async function createVerifiedMeasuredOutcomeForSubject(
  harness: NetW036Harness,
  subjectId: string,
  observationId: string,
): Promise<MeasuredOutcome> {
  const runtime = harness.runtime;
  const ctx = harness.supplierACtx("w036-measured-outcome");
  const measurement = await runtime.measuredOutcomeService.createMeasuredOutcome(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.supplierAPersonId,
      subjectReference: { subjectId, subjectType: "contribution" },
      outcomeType: "view",
      maturation: { strategy: "immediate" },
      observationIds: [observationId],
    },
  );
  await runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: measurement.version,
    idempotencyKey: "w036-mo-begin",
    actorPersonId: harness.supplierAPersonId,
  });
  await runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  const finalized = await runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: "w036-mo-finalize",
    actorPersonId: harness.supplierAPersonId,
  });
  if (finalized.measurement.state !== "VERIFIED") {
    throw new Error(
      `W036 canonical scenario failed: measured outcome state ${finalized.measurement.state}`,
    );
  }
  return finalized.measurement;
}

/**
 * A VERIFIED Proof-of-Value for the given fulfillment subject — platform
 * evidence + provider evidence whose provenance cites the MEASUREMENT
 * PROVIDER that produced the observation (the evidence-to-measurement
 * lineage), an independent buyer-A attestation (the demand owner — never
 * the PoV owner), aggregation, verification → VERIFIED. Every durable id
 * returned (the W035 fixture shape; the server-side HMAC attestation is
 * the cryptographic attestation — there is no signing-key input on the
 * attestation command).
 */
export async function attachVerifiedProofOfValueForSubject(
  harness: NetW036Harness,
  subjectId: string,
): Promise<{
  readonly proofOfValueId: string;
  readonly platformEvidenceId: string;
  readonly providerEvidenceId: string;
  readonly attestationId: string;
}> {
  const runtime = harness.runtime;
  const ctx = harness.supplierACtx("w036-pov");
  const ePlatform = await runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.supplierAPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "platform",
      sourceId: "platform-w036",
      method: "platform-counter",
      collectedAt: W036_EVIDENCE_CAPTURED_AT,
    },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const eProvider = await runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.supplierAPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "provider",
      sourceId: OPENRTB_DELIVERY_PROVIDER_ID,
      method: "openrtb-delivery-notice",
      collectedAt: W036_EVIDENCE_CAPTURED_AT,
    },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const proof = await runtime.proofOfValueService.createProofOfValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.supplierAPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    evidenceIds: [ePlatform.id, eProvider.id],
  });
  await runtime.proofOfValueService.beginMeasuring(ctx, {
    proofId: proof.id,
    expectedVersion: proof.version,
    idempotencyKey: "w036-pov-begin",
    actorPersonId: harness.supplierAPersonId,
  });
  const attestation = await runtime.attestationService.createAttestation(
    harness.poolCreatorCtx("w036-pov-attestation"),
    {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.poolCreatorPersonId,
      statement:
        "Independently reviewed the procurement fulfillment delivery evidence.",
      evidenceIds: [ePlatform.id, eProvider.id],
    },
  );
  await runtime.proofOfValueService.attachAttestation(
    ctx,
    proof.id,
    attestation.id,
  );
  await runtime.proofOfValueService.completeEvidenceGathering(ctx, {
    proofId: proof.id,
    expectedVersion: 1,
    idempotencyKey: "w036-pov-evaluating",
    actorPersonId: harness.supplierAPersonId,
  });
  await runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await runtime.proofOfValueService.verify(ctx, {
    proofId: proof.id,
    expectedVersion: 2,
    idempotencyKey: "w036-pov-verify",
    actorPersonId: harness.supplierAPersonId,
  });
  if (verified.proof.state !== "VERIFIED") {
    throw new Error(
      `W036 canonical scenario failed: PoV state ${verified.proof.state}`,
    );
  }
  return {
    proofOfValueId: verified.proof.id,
    platformEvidenceId: ePlatform.id,
    providerEvidenceId: eProvider.id,
    attestationId: attestation.id,
  };
}

/**
 * Walk a MEASURING contribution to the terminal VERIFIED state through
 * the /workflows authority (MEASURING → EVALUATING → CHALLENGE_WINDOW →
 * SETTLING → SETTLED → VERIFIED — fixed idempotency keys; the W033/W035
 * sequence tail).
 */
export async function walkToVerified(
  harness: NetW036Harness,
  contributionId: string,
): Promise<Contribution> {
  const ctx = harness.supplierACtx("w036-verify-walk");
  const path = [
    "MEASURING",
    "EVALUATING",
    "CHALLENGE_WINDOW",
    "SETTLING",
    "SETTLED",
    "VERIFIED",
  ] as const;
  let current = await harness.runtime.contributionService.getContribution(
    ctx,
    contributionId,
  );
  let step = 0;
  while (current.state !== "VERIFIED") {
    const from = current.state;
    const to = path[path.indexOf(from as (typeof path)[number]) + 1]!;
    step += 1;
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: contributionId,
        subjectKind: "contribution",
        targetState: to,
        expectedVersion: current.version,
        idempotencyKey: `w036-t${String(step)}`,
        actorPersonId: harness.supplierAPersonId,
        policyAction: policyActionFor(
          "contribution",
          from as "MEASURING",
          to as "VERIFIED",
        ),
        metadata: { demandProcurementLifecycle: "net-w036" },
      },
      ctx,
    );
    current = await harness.runtime.contributionService.getContribution(
      ctx,
      contributionId,
    );
  }
  return current;
}

// ---------------------------------------------------------------------------
// The risk/dispute gate fixtures (the /disputes authority — the W035
// helpers replicated minimally with FIXED anchors and keys)
// ---------------------------------------------------------------------------

/**
 * Activate a HOLD risk control for the given subject (the risk-policy →
 * assessment → control chain — the /disputes authority). The operation
 * class defaults to value_maturation (the maturation gate). The
 * assessment's evaluatedAt is the FIXED W036 anchor (the authority
 * validates the shape only — "deterministic, no wall-clock races").
 */
export async function holdMaturationOn(
  harness: NetW036Harness,
  subjectType: "contribution" | "economic_value",
  subjectId: string,
  operationClass: "value_maturation" | "reward_allocation" = "value_maturation",
): Promise<string> {
  const runtime = harness.runtime;
  const ctx = harness.poolCreatorCtx("w036-risk-policy");
  const policy = await runtime.riskPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId: "w036-risk-policy",
    version: 1,
    description: "NET-W036 canonical risk policy (the W009 default shape)",
    rules: [
      {
        category: "identity",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
      {
        category: "velocity",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
      {
        category: "duplicate_pattern",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
      {
        category: "model_advisory",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
    ],
    thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
    criticalFloorState: "HOLD",
    advisoryOnlyCapState: "REVIEW",
    requiredCategories: ["identity"],
    missingDataState: "HOLD",
  });
  const assessment = await runtime.riskAssessmentService.recordAssessment(
    harness.poolCreatorCtx("w036-risk-assessment"),
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.supplierAPersonId,
      policyId: policy.policyId,
      evaluatedAt: W036_RISK_CONTROL_EVALUATED_AT,
      idempotencyKey: "w036-risk-assessment",
    },
  );
  const { control } = await runtime.riskControlService.activateControl(
    harness.poolCreatorCtx("w036-risk-control"),
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass,
      action: "HOLD",
      subjectRef: { subjectType, subjectId },
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["collusion_pattern"],
      idempotencyKey: "w036-risk-control",
    },
  );
  return control.id;
}

/** Resolve a HOLD risk control (the sanctioned /disputes resolution). */
export async function resolveHold(
  harness: NetW036Harness,
  controlDecisionId: string,
): Promise<void> {
  await harness.runtime.riskControlService.resolveControl(
    harness.poolCreatorCtx("w036-risk-resolve"),
    {
      controlDecisionId,
      note: "cleared after demand/procurement lifecycle review",
      idempotencyKey: "w036-risk-resolve",
    },
  );
}

/**
 * Open + bond a dispute over the subject (supplier B — the challenger —
 * holds credits through the real verified chain). Returns the dispute id.
 *
 * DETERMINISTIC FIXTURE (the W034/W035 discipline): the challenge anchor
 * is the subject's OWN authoritative timestamp — `contribution.createdAt`,
 * the EXACT field the dispute authority's subject lookup binds — read
 * through the owning boundary. The challenge-window check [anchorAt,
 * anchorAt + window] accepts the anchor itself by construction, so the
 * fixture carries no wall-clock dependency.
 */
export async function openBondedDisputeOn(
  harness: NetW036Harness,
  subjectType: "contribution" | "economic_value",
  subjectId: string,
): Promise<string> {
  const runtime = harness.runtime;
  await ensureChallengerCredits(harness);
  const ctx = harness.supplierBCtx("w036-dispute");
  const subjectAnchorAt =
    subjectType === "contribution"
      ? (
          await runtime.contributionService.getContribution(
            harness.poolCreatorCtx("w036-dispute-anchor"),
            subjectId,
          )
        ).createdAt
      : (
          await runtime.economicValueService.getValue(
            harness.poolCreatorCtx("w036-dispute-anchor"),
            subjectId,
          )
        ).recordedAt;
  const opened = await runtime.disputeService.openDispute(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectRef: { subjectType, subjectId },
    statement: "the challenged fulfillment misstates verified savings",
    reasonCodes: ["contested_verification"],
    supportingRefs: [{ kind: subjectType, id: subjectId }],
    effectiveAt: subjectAnchorAt,
    idempotencyKey: "w036-dispute",
  });
  const dispute = opened.dispute;
  const staked = await runtime.stakeService.commitStake(ctx, {
    organizationScopeId: dispute.organizationScopeId,
    ownerPersonId: dispute.challengerPersonId,
    amount: dispute.stake.requirement.amount,
    purpose: { kind: "dispute_challenge", id: dispute.id },
    description: `challenge stake for dispute ${dispute.id}`,
    idempotencyKey: "w036-dispute-stake",
  });
  const bonded = await runtime.disputeService.bondStake(ctx, {
    disputeId: dispute.id,
    stakeId: staked.stake.id,
    idempotencyKey: "w036-dispute-bond",
  });
  return bonded.id;
}

/**
 * Resolve the dispute through due process (buyer B — the reviewer, never
 * the challenger — reviews first, then a DISMISSED resolution releasing
 * the control).
 */
export async function resolveDispute(
  harness: NetW036Harness,
  disputeId: string,
  subjectId: string,
): Promise<void> {
  await harness.runtime.disputeService.startReview(
    harness.buyerBCtx("w036-dispute-review"),
    {
      disputeId,
      idempotencyKey: "w036-dispute-review",
    },
  );
  await harness.runtime.disputeService.resolveDispute(
    harness.buyerBCtx("w036-dispute-resolve"),
    {
      disputeId,
      outcome: "DISMISSED",
      controlDisposition: "RELEASE_CONTROL",
      reasonCodes: ["no_merit"],
      sourceRefs: [{ kind: "contribution", id: subjectId }],
      note: "no merit — the fulfillment savings evidence verified",
      idempotencyKey: "w036-dispute-resolve",
    },
  );
}

/**
 * Ensure the challenger (supplier B) holds Participation Credits: fresh
 * verified value for them through the REAL W008 chain (the wrapped
 * harness's factory), then credits at rate 1 (the W010
 * ensureCreditsFor pattern).
 */
export async function ensureChallengerCredits(
  harness: NetW036Harness,
): Promise<void> {
  const mature = await createMatureValue(harness.w008, {
    amount: 100,
    beneficiaryPersonId: harness.supplierBPersonId,
  });
  await harness.runtime.creditService.issueCredits(
    harness.supplierBCtx("w036-challenger-credits"),
    {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.supplierBPersonId,
      sourceValueRecordId: mature.id,
      creditsPerValueUnit: 1,
      idempotencyKey: "w036-challenger-credits",
    },
  );
}

// ---------------------------------------------------------------------------
// The settlement composite (the /settlement authority — the gated
// maturation exactly as the apiCommand runs it)
// ---------------------------------------------------------------------------

/**
 * The maturation composite (risk/dispute-gated) as the apiCommand runs
 * it: the composition root consults the risk-control registry + the
 * dispute registry over the record AND every upstream source BEFORE the
 * settlement mutation.
 */
export async function matureValueRecord(
  harness: NetW036Harness,
  valueRecordId: string,
  idempotencyKey = "w036-value-mature",
): Promise<EconomicValueRecord> {
  return (await harness.runtime.apiCommands.matureEconomicValue(
    harness.poolCreatorCtx("w036-mature"),
    {
      valueRecordId,
      idempotencyKey,
    },
  )) as unknown as EconomicValueRecord;
}

// ---------------------------------------------------------------------------
// The lineage reconstruction (stage 17 — the ordered-marker proof)
// ---------------------------------------------------------------------------

interface LineageIds {
  readonly pool: ProcurementPool;
  readonly commitments: readonly ProcurementCommitment[];
  readonly offers: readonly SupplierOffer[];
  readonly selection: CompetitiveSelection;
  readonly opportunityId: string;
  readonly contributionId: string;
  readonly observationId: string;
  readonly measuredOutcomeId: string;
  readonly poolEvidenceId: string;
  readonly savingsObservationId: string;
  readonly baselineId: string;
  readonly savingsId: string;
  readonly povPlatformEvidenceId: string;
  readonly povProviderEvidenceId: string;
  readonly proofOfValueId: string;
  readonly attestationId: string;
  readonly valueId: string;
  readonly riskControlId: string;
  readonly disputeId: string;
  readonly rewardPolicyRecordId?: string;
  readonly benefitPolicyId?: string;
  readonly benefitPoolId?: string;
  readonly drawResultId?: string;
  readonly allocationId?: string;
}

/**
 * The complete lineage reconstruction: the canonical audit markers —
 * [eventType, resourceId] pairs over the scenario's OWN durable
 * identifiers — located in the GLOBAL append-only audit log (a high
 * limit query; insertion order = committed-mutation order). Fails
 * closed when a marker is missing or the positions are not strictly
 * ascending (the final ordered-marker proof: local array order alone is
 * never evidence).
 */
async function reconstructLineage(
  harness: NetW036Harness,
  ids: LineageIds,
): Promise<{
  readonly markers: readonly (readonly [string, string])[];
  readonly positions: readonly number[];
}> {
  const markers: (readonly [string, string])[] = [
    ["procurement_pool.created", ids.pool.id],
    ["procurement_commitment.recorded", ids.commitments[0]!.id],
    ["procurement_commitment.recorded", ids.commitments[1]!.id],
    ["procurement_commitment.recorded", ids.commitments[2]!.id],
    ["procurement_offer.recorded", ids.offers[0]!.id],
    ["procurement_offer.recorded", ids.offers[1]!.id],
    ["procurement_offer.recorded", ids.offers[2]!.id],
    ["procurement_offer.recorded", ids.offers[3]!.id],
    ["procurement_selection.recorded", ids.selection.id],
    ["opportunity.created", ids.opportunityId],
    ["contribution.created", ids.contributionId],
    ["contribution.transition.draft_to_ready", ids.contributionId],
    ["contribution.transition.ready_to_assigned", ids.contributionId],
    ["contribution.transition.assigned_to_in_progress", ids.contributionId],
    ["contribution.transition.in_progress_to_submitted", ids.contributionId],
    ["contribution.transition.submitted_to_measuring", ids.contributionId],
    ["outcome_observation.created", ids.observationId],
    ["measured_outcome.created", ids.measuredOutcomeId],
    ["outcome_measurement.transition.draft_to_measuring", ids.measuredOutcomeId],
    ["measured_outcome.rollup_recorded", ids.measuredOutcomeId],
    ["outcome_measurement.transition.measuring_to_verified", ids.measuredOutcomeId],
    ["contribution.transition.measuring_to_evaluating", ids.contributionId],
    ["contribution.transition.settled_to_verified", ids.contributionId],
    ["evidence.created", ids.poolEvidenceId],
    ["outcome_observation.created", ids.savingsObservationId],
    ["procurement_baseline.created", ids.baselineId],
    ["procurement_savings.recorded", ids.savingsId],
    ["evidence.created", ids.povPlatformEvidenceId],
    ["evidence.created", ids.povProviderEvidenceId],
    ["proof_of_value.created", ids.proofOfValueId],
    ["attestation.created", ids.attestationId],
    ["proof_of_value.aggregated", ids.proofOfValueId],
    ["proof_of_value.transition.evaluating_to_verified", ids.proofOfValueId],
    ["economic_value.recorded", ids.valueId],
    ["risk_control.activated", ids.riskControlId],
    ["risk_control.resolved", ids.riskControlId],
    ["dispute.opened", ids.disputeId],
    ["dispute.resolved", ids.disputeId],
    ["economic_value.matured", ids.valueId],
  ];
  if (ids.rewardPolicyRecordId !== undefined) {
    markers.push(["reward_policy.version_created", ids.rewardPolicyRecordId]);
  }
  if (ids.benefitPolicyId !== undefined) {
    markers.push(["benefits_policy.version_created", ids.benefitPolicyId]);
  }
  if (ids.benefitPoolId !== undefined) {
    markers.push(["benefits_pool.created", ids.benefitPoolId]);
  }
  if (ids.drawResultId !== undefined && ids.drawResultId !== "") {
    markers.push(["reward_allocation.recorded", ids.drawResultId]);
  }
  if (ids.allocationId !== undefined) {
    markers.push(["benefits_pool.allocation_recorded", ids.allocationId]);
  }

  const log = await harness.runtime.auditWriter.query({ limit: 1_000_000 });
  const positions = markers.map(([eventType, resourceId]) => {
    const index = log.findIndex(
      (event) => event.eventType === eventType && event.resourceId === resourceId,
    );
    if (index < 0) {
      throw new Error(
        `W036 lineage reconstruction failed: missing audit event ${eventType} for ${resourceId}`,
      );
    }
    return index;
  });
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i]! <= positions[i - 1]!) {
      throw new Error(
        `W036 lineage reconstruction failed: canonical audit order violated at marker ${String(
          i,
        )} (${markers[i]![0]} for ${markers[i]![1]})`,
      );
    }
  }
  return { markers, positions };
}
