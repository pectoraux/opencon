/**
 * NET-W035 shared test harness — the complete creator lifecycle
 * (Phase-9 end-to-end composition proof).
 *
 * Wraps the NET-W018 harness (runtime + persons + organizations + the
 * ENTIRE creators→contribution chain W018→W017→W016→W015→W013→W012→
 * W011→W010→W009→W008, so the profiles/matching/engagements/UGC/
 * rights/sponsorship/disclosure + the opportunities/contributions/
 * workflows/evidence/outcomes/disputes/settlement machinery all run on
 * ONE runtime) and adds exactly the composition wiring the canonical
 * CREATOR path needs (all of it through existing sanctioned surfaces):
 *
 *  - measurement provider threading: the REAL OpenRTB delivery-notice
 *    measurement adapter (W022) wired through `createRuntime` — the
 *    same provider-selection path production uses (TEST verification
 *    secret, never a real credential). This uses the ONE minimal
 *    NET-W035 harness adjustment: the NET-W018 TEST harness now
 *    forwards the PRE-EXISTING `NetW008HarnessOptions` (the W015/
 *    W016/W017 chain already threaded them) — a tests/ file, never
 *    src/ (the same pattern as the NET-W034 measurement threading);
 *  - the external-settlement trust channel for the W030 payment leg
 *    (per-provider TEST trust key — the reference provider's channel);
 *  - the guard policies the composed creator commands require
 *    (the measured-outcome guard actions + the per-transition
 *    policies for the operator — the W021 pattern; the reward
 *    composite actions — the W020 pattern; measurementReport.submit —
 *    the W022 pattern; externalSettlementFact.record/read/reconcile —
 *    the W030 pattern);
 *  - the canonical end-to-end scenario factory
 *    `runCreatorScenario` — ONE deterministic creator execution
 *    traversing the ENTIRE frozen authoritative chain IN the canonical
 *    executable order (the W033 traversal-proof discipline — the PR
 *    #68 architect-remediation lesson — carried forward: every stage
 *    boundary is witnessed by the AUTHORITATIVE engagement AND
 *    contribution state + version read through the owning boundaries,
 *    and the durable audit log's commit order corroborates the
 *    declared stage order):
 *
 *      creator discovery/matching (W015 profile + the W016
 *        hard-gated match: an ineligible candidate excluded BEFORE
 *        ranking, the eligible creator ranked)
 *      → campaign contract/terms (the ACTIVE campaign, pinned policy
 *        v1, the creator_content objective + outcome/evidence/
 *        disclosure policy + the declared compensation/clearing rule
 *        with the escrowed budget + the opportunity spec)
 *      → creator acceptance (the W017 composite: the usage-rights
 *        grant + the READY → ASSIGNED transition in ONE transaction)
 *      → the execution subject enters the sanctioned contribution
 *        lifecycle (the W012 helpfulness composite → SUBMITTED)
 *      → UGC production + rights (the W017 production bound to the
 *        contribution + the durable deliverable; the authoritative
 *        usage-rights view)
 *      → the engagement SUBMITTED + VERIFIED through /workflows
 *      → disclosure/compliance (the W018 relationship + publication +
 *        evidence-bound declarations + the sanctioned verification
 *        gate)
 *      → /workflows SUBMITTED → MEASURING (the measurement point)
 *      → measurement (the W022 delivery-notice adapter → /outcomes)
 *      → outcomes (the VERIFIED measured outcome, while MEASURING)
 *      → evidence / Proof-of-Value (VERIFIED, while MEASURING)
 *      → PoH evaluation (QUALIFIED, while MEASURING)
 *      → /workflows walk completion (MEASURING → … → VERIFIED)
 *      → settlement (recognition PENDING)
 *      → risk/dispute gates (fail closed, then resolved)
 *      → settlement maturation (MATURE)
 *      → payment (the W030 external settlement fact + the derived
 *        matched reconciliation — provider integration only, never
 *        economic authority)
 *
 *    with fixed evaluation anchors where the authorities accept one,
 *    every durable identifier returned, and the ordered `traversal`
 *    witness array proving the canonical traversal order — not just
 *    the eventual end state.
 *
 * W035 adds NO production source file, domain, authority or state
 * machine: this harness is pure test composition over the existing
 * contracts (the single production-adjacent change is the option
 * forwarding in the NET-W018 TEST harness — declared in the
 * changed-file policy of the ledger).
 */

import {
  createNetW018Harness,
  personCtx as w018PersonCtx,
  key as w018Key,
  type NetW008HarnessOptions,
  type NetW018Harness,
} from "../creators/_net-w018-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  publishHelpfulContribution,
  type NetW012Harness,
} from "../contributions/_net-w012-harness.ts";
import { createDefaultRiskPolicy } from "../disputes/_net-w009-harness.ts";
import { ensureCreditsFor, type NetW010Harness } from "../disputes/_net-w010-harness.ts";
import {
  rawDeliveryNotice,
  OPENRTB_DELIVERY_TEST_SECRET,
} from "../adapters/_net-w023-harness.ts";
import { EXTERNAL_SETTLEMENT_TEST_TRUST_KEY } from "../settlement/_net-w030-harness.ts";
import { buildExternalSettlementIntegrity } from "../../src/bootstrap/external-settlement-authentication.ts";
import { OpenRtbDeliveryNoticeAdapter, OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";
import type {
  CreatorMatchRunRecord,
  RunCreatorMatchInput,
  CommercialRelationship,
  Engagement,
  PublicationRecord,
  UsageRightsGrant,
  UgcProduction,
} from "../../src/creators/port.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type { OutcomeObservation, MeasuredOutcome } from "../../src/outcomes/port.ts";
import type { EconomicValueRecord, ExternalSettlementFactRecord } from "../../src/settlement/port.ts";

export { EXTERNAL_SETTLEMENT_TEST_TRUST_KEY };

// ---------------------------------------------------------------------------
// The deterministic fixture anchors (work order §3.1 — the PR #73
// remediation, architect comment #5514394512 — the W034 PR #70
// remediation discipline applied to the WHOLE canonical creator
// path): every usage-rights window, evidence-capture timestamp and
// the external payment identity the canonical scenario fabricates
// is a FIXED anchor or an id DERIVED from the authoritative subject
// — never wall-clock/random entropy. The ONE sanctioned wall-clock
// read in the entire suite is the W030 provider freshness
// `observedAt` (the explicit exception inside
// freshProviderObservationTimestamp: the external-settlement
// authority itself wall-clock-gates the freshness window, so a
// fixed instant fails it by design).
// ---------------------------------------------------------------------------

/** The canonical usage-rights window opens (FIXED anchor). */
export const W035_RIGHTS_STARTS_AT = "2026-09-01T00:00:00.000Z";
/** The canonical REQUESTED window closes (+30 days — FIXED anchor). */
export const W035_RIGHTS_REQUESTED_ENDS_AT = "2026-10-01T00:00:00.000Z";
/**
 * The canonical GRANTED window closes (+29 days — FIXED anchor,
 * strictly within the requested envelope: the acceptance subset
 * check gStart >= rStart && gEnd <= rEnd holds by construction).
 */
export const W035_RIGHTS_GRANTED_ENDS_AT = "2026-09-30T00:00:00.000Z";
/**
 * A FIXED evaluation instant INSIDE the canonical granted window —
 * the deterministic `asOf` for every usage-rights view read (ACTIVE
 * by construction; the authority default `asOf ?? now` is never
 * exercised by the canonical path).
 */
export const W035_RIGHTS_EVALUATION_AS_OF = "2026-09-15T00:00:00.000Z";
/**
 * A FIXED evaluation instant AFTER every fixed rights window (the
 * derived EXPIRED/REVOKED evaluations — never `now + offset`).
 */
export const W035_RIGHTS_EXPIRED_AS_OF = "2040-01-01T00:00:00.000Z";
/** The FIXED platform evidence-capture anchor (the W023 fixture style). */
export const W035_EVIDENCE_CAPTURED_AT = "2026-09-02T10:00:00.000Z";
/**
 * The FIXED external-settlement signing anchor — `integrity.signedAt`
 * is shape-validated only (parseable instant), never freshness-gated,
 * so the canonical payment signature timestamp is deterministic.
 */
export const W035_PAYMENT_SIGNED_AT = "2026-09-02T10:05:00.000Z";

/**
 * The ONE sanctioned wall-clock read in the NET-W035 suite: the W030
 * provider freshness timestamp `observedAt` (the explicit architect
 * exception — the external-settlement authority wall-clock-enforces
 * the freshness window, so the canonical payment fixture MUST stay
 * fresh at ingestion). Every other timestamp in the suite is a
 * fixed/derived deterministic anchor (see the block above).
 */
function freshProviderObservationTimestamp(): string {
  return new Date().toISOString();
}

export interface NetW035Harness {
  /** The wrapped NET-W018 harness (all its factories work unchanged). */
  readonly w018: NetW018Harness;
  readonly runtime: NetW018Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The creator (the profile subject, engagement creator/grantor, contributor). */
  readonly creatorPersonId: string;
  /** The operator (the campaign owner/sponsor, match runner, payment actor). */
  readonly operatorPersonId: string;
  /** The W010 challenger (the dispute challenger — a different person). */
  readonly challengerPersonId: string;
  /** The W010 reviewer (the dispute reviewer/resolver — never the challenger). */
  readonly reviewerPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  /** The W012 harness (reached through the wrapped chain). */
  readonly w012: NetW012Harness;
  /** The W010 harness (reached through the wrapped chain). */
  readonly w010: NetW010Harness;
  creatorCtx(correlationId: string): ExecutionContext;
  operatorCtx(correlationId: string): ExecutionContext;
  challengerCtx(correlationId: string): ExecutionContext;
  reviewerCtx(correlationId: string): ExecutionContext;
  teardown(): Promise<void>;
}

/** The W021-seeded measured-outcome guard actions (subject "*"). */
const OUTCOME_GUARD_ACTIONS = [
  "outcomeObservation.create",
  "measuredOutcome.create",
  "measuredOutcome.attachObservation",
  "measuredOutcome.recordRollup",
];

/** The W020-seeded reward composite guard actions. */
const REWARD_GUARD_ACTIONS = ["reward.recognize", "reward.clear", "reward.reputation"];

/** The W030-seeded external-settlement guard actions. */
const EXTERNAL_SETTLEMENT_GUARD_ACTIONS = [
  "externalSettlementFact.record",
  "externalSettlementFact.read",
  "externalSettlementFact.reconcile",
];

export async function createNetW035Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW035Harness> {
  // The REAL W022 provider-selection path: the OpenRTB delivery-notice
  // adapter wired through createRuntime with a TEST verification
  // secret (a test-only literal — NEVER a real credential).
  const noticeAdapter = new OpenRtbDeliveryNoticeAdapter({
    verificationSecret: OPENRTB_DELIVERY_TEST_SECRET,
  });
  // One runtime with the ENTIRE chain: the creators→contribution
  // machinery (W008→…→W018) + the measurement provider registry
  // (W022) + the external-settlement trust channel (W030).
  const w018 = await createNetW018Harness({
    ...opts,
    measurement: {
      ...(opts.measurement ?? {}),
      providers: [
        ...(opts.measurement?.providers ?? []),
        noticeAdapter,
      ],
    },
    adapters: {
      ...opts.adapters,
      externalSettlementTrustKeys: {
        ...(opts.adapters?.externalSettlementTrustKeys ?? {}),
        reference: EXTERNAL_SETTLEMENT_TEST_TRUST_KEY,
      },
    },
  });
  const runtime = w018.runtime;
  const bootstrapCtx = w018.bootstrapCtx;

  // -- The W021 pattern: the measured-outcome guard actions + the
  //    per-transition policies scoped to the operator on the harness
  //    organization.
  for (const action of OUTCOME_GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }
  for (const rule of OUTCOME_MEASUREMENT_TRANSITION_TABLE) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: w018.operatorPersonId,
      action: rule.policyAction,
      resource: w018.organizationScopeId,
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  // -- The W020 pattern: the reward composite guard actions.
  for (const action of REWARD_GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  // -- The W022 pattern: the measurement report submission guard.
  await runtime.policyService.createPolicy(bootstrapCtx, {
    subject: "*",
    action: "measurementReport.submit",
    resource: "*",
    effect: "allow",
    createdBy: "bootstrap",
  });

  // -- The W030 pattern: the external settlement fact guard actions
  //    (the payment leg's transport guards).
  for (const action of EXTERNAL_SETTLEMENT_GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  const w012 = w018.w017.w016.w015.w013.w012;
  const w010 = w018.w017.w016.w015.w013.w012.w011.w010;

  return {
    w018,
    runtime,
    bootstrapCtx,
    creatorPersonId: w018.creatorPersonId,
    operatorPersonId: w018.operatorPersonId,
    challengerPersonId: w010.challengerPersonId,
    reviewerPersonId: w010.reviewerPersonId,
    organizationScopeId: w018.organizationScopeId,
    secondOrgId: w018.secondOrgId,
    secondOrgPersonId: w018.secondOrgPersonId,
    w012,
    w010,
    creatorCtx(correlationId: string) {
      return w018PersonCtx(w018, w018.creatorPersonId, correlationId);
    },
    operatorCtx(correlationId: string) {
      return w018PersonCtx(w018, w018.operatorPersonId, correlationId);
    },
    challengerCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w010.challengerPersonId, kind: "person" },
      });
    },
    reviewerCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w010.reviewerPersonId, kind: "person" },
      });
    },
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return w018Key(prefix);
}

/** A person context for an arbitrary person id (cross-tenant proofs). */
export function personCtx(
  harness: NetW035Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return w018PersonCtx(harness.w018, personId, correlationId);
}

// ---------------------------------------------------------------------------
// Stage 1 — the creator discovery fixtures (W015 profile + the W016 match)
// ---------------------------------------------------------------------------

/** The scenario match requirements (the operator's brief — the hard
 * constraints the campaign policy will declare: short-form video in
 * English across GH/NG with channel publication rights). */
export const SCENARIO_MATCH_REQUIREMENTS = {
  requiredFormats: ["short_video"],
  requiredLanguages: ["en"],
  targetTerritories: ["GH", "NG"],
  campaignTopics: [],
  requiredRightsKinds: ["channel_publication"],
  rateCeiling: null,
  minimumAudienceSizeBand: null,
  minimumReputation: { audienceInfluence: null, production: null },
  noticeWindowDays: null,
} as const;

/**
 * Run a creator match through the wired W016 service (the operator
 * acts) with the scenario requirements by default.
 */
export async function runCreatorMatch(
  harness: NetW035Harness,
  input: Partial<RunCreatorMatchInput> & {
    readonly idempotencyKey: string;
  },
): Promise<{ run: CreatorMatchRunRecord; created: boolean }> {
  const ctx = harness.operatorCtx("w035-run-match");
  return harness.runtime.creatorMatchingService.runMatch(ctx, {
    organizationScopeId: harness.organizationScopeId,
    requirements: { ...SCENARIO_MATCH_REQUIREMENTS },
    ...input,
  } as RunCreatorMatchInput);
}

// ---------------------------------------------------------------------------
// Stage 2 — the creator campaign factory (campaign/terms authority)
// ---------------------------------------------------------------------------

export interface CreateCreatorCampaignOptions {
  /** Leave the campaign DRAFT (the not-ACTIVE fail-closed fixture). */
  readonly skipActivation?: boolean;
  /** An explicit different owner (defaults to the operator). */
  readonly ownerPersonId?: string;
  /** Override the declared disclosure kinds (defaults to the scenario pair). */
  readonly requiredDisclosureKinds?: readonly string[];
}

/**
 * The CREATOR campaign: an ACTIVE campaign whose pinned policy
 * version 1 declares the complete creator terms set — the
 * creator_content objective, the outcome policy (one deterministic
 * `view` requirement — the exact requirement the canonical
 * delivery-notice measurement satisfies), the evidence policy (a
 * Proof-of-Value, ATTESTED minimum, platform sources), the eligibility
 * rules (region/language), the declared compensation/clearing rule
 * wired to a REAL same-scope reward policy whose beneficiary is the
 * CREATOR (the declared compensation target), the disclosure policy
 * (material_connection + genuine_experience), and the opportunity
 * spec (the sanctioned helpful_* contribution vehicle — the W034
 * decision of record: the W012 helpfulness composite accepts ONLY
 * helpful_* opportunities). The budget escrow covers the clearing cap
 * (the CAMP-002 validation).
 */
export async function createCreatorCampaign(
  harness: NetW035Harness,
  opts: CreateCreatorCampaignOptions = {},
): Promise<{ campaign: CampaignRecord; rewardPolicyId: string }> {
  const owner = opts.ownerPersonId ?? harness.operatorPersonId;
  const ctx = personCtx(harness, owner, "w035-campaign");
  // The REAL reward policy lineage the declared clearing rule cites —
  // the compensation target is the CREATOR.
  const rewardPolicyId = key("w035-reward-policy");
  await harness.runtime.rewardPolicyService.createPolicyVersion(
    harness.bootstrapCtx,
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: rewardPolicyId,
      version: 1,
      description: "NET-W035 creator compensation clearing policy",
      allocations: [
        { beneficiaryPersonId: harness.creatorPersonId, weight: 1 },
      ],
    },
  );
  const maxDrawAmount = 1000;
  const clearingRules = [
    {
      id: "clear-1",
      objectiveId: "obj-1",
      basis: "attributed_outcome",
      drawKind: "reward_allocation",
      rewardPolicyId,
      maxDrawAmount,
    },
  ] as const satisfies readonly unknown[];
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      name: "W035 Creator Campaign",
      description: "the canonical creator lifecycle fixture campaign",
      idempotencyKey: key("w035-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "creator_content",
          description: "canonical sponsored creator content objective",
          successCriteria: null,
        },
      ],
      eligibility: {
        rules: [
          { attribute: "region", operator: "in", values: ["GH", "NG"] },
          { attribute: "language", operator: "equals", values: ["en"] },
        ] as never,
      },
      outcomePolicy: {
        requirements: [
          {
            objectiveId: "obj-1",
            outcomeType: "view",
            attributionMode: "deterministic",
            windowDays: 30,
            requiresExperiment: false,
          },
        ],
      },
      evidencePolicy: {
        requirements: [
          {
            objectiveId: "obj-1",
            requirementKind: "proof_of_value",
            minimumGrade: "ATTESTED",
            qualifyingSourceTypes: ["platform"],
          },
        ],
      },
      // The budget MUST cover the clearing cap (CAMP-002).
      budget: { unit: "credits", totalAmount: maxDrawAmount, perObjective: [] },
      attributionRules: [
        {
          id: "attr-1",
          objectiveId: "obj-1",
          model: "deterministic",
          confidenceThreshold: 0.9,
          windowDays: 30,
          requiresExperiment: false,
        },
      ],
      clearingRules,
      opportunitySpecs: [
        {
          id: "spec-1",
          title: "Sponsored creator content execution",
          // The sanctioned contribution vehicle: the W012 helpfulness
          // composite accepts ONLY helpful_* opportunities — the
          // creator execution subject enters the lifecycle through
          // THIS campaign-materialized opportunity.
          opportunityType: "helpful_recommendation",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-creator-execution"],
        },
      ],
      // The NET-W018 section: the declared disclosure policy.
      disclosurePolicy: {
        requiredKinds: [
          ...(opts.requiredDisclosureKinds ?? [
            "material_connection",
            "genuine_experience",
          ]),
        ] as never,
      },
    },
    idempotencyKey: key("w035-policy"),
  });
  if (opts.skipActivation === true) {
    return { campaign, rewardPolicyId };
  }
  // The budget escrow (the W011 activateReadyCampaign pattern).
  await ensureCreditsFor(harness.w010, owner, maxDrawAmount);
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerPersonId: owner,
    amount: maxDrawAmount,
    purpose: { kind: "campaign_budget", id: campaign.id },
    description: `campaign budget escrow for campaign ${campaign.id}`,
    idempotencyKey: key("w035-budget-stake"),
  });
  await harness.runtime.campaignService.recordBudgetCommitment(ctx, {
    campaignId: campaign.id,
    stakeId: staked.stake.id,
    idempotencyKey: key("w035-budget-record"),
  });
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w035-activate"),
    },
  );
  return { campaign: activated, rewardPolicyId };
}

// ---------------------------------------------------------------------------
// The canonical scenario — ONE creator execution through the FULL
// frozen authoritative chain, with every durable identifier returned.
// ---------------------------------------------------------------------------

/**
 * One canonical-traversal stage witness. The W035 proof carries BOTH
 * authoritative lifecycle subjects: from the engagement creation
 * onward, the AUTHORITATIVE engagement state + version (read through
 * the owning boundary `creatorEngagementService.getEngagement`); from
 * the contribution entry onward, the AUTHORITATIVE contribution state
 * + version (read through `contributionService.getContribution`).
 * The version counters increment only on /workflows lifecycle
 * mutations (engagement v0 DRAFT → v5 VERIFIED; contribution v0 DRAFT
 * → v4 SUBMITTED → v5 MEASURING → v10 VERIFIED), so the witness array
 * is a strictly deterministic ordering proof over BOTH authorities: a
 * stage witnessed at version N ran after every lifecycle mutation
 * below N and before every mutation above it. Pre-subject stages
 * (profile, match, campaign, opportunity) are witnessed by their own
 * DURABLE authority record ids.
 */
export interface CreatorTraversalWitness {
  /** The scenario stage that just completed. */
  readonly stage: string;
  /** The owning authority boundary the stage ran through. */
  readonly authority: string;
  /** The durable authoritative record id the stage produced/committed. */
  readonly recordId: string;
  /** The engagement's authoritative lifecycle state ("" pre-offer). */
  readonly engagementState: string;
  /** The engagement's authoritative version (-1 pre-offer). */
  readonly engagementVersion: number;
  /** The contribution's authoritative lifecycle state ("" pre-entry). */
  readonly contributionState: string;
  /** The contribution's authoritative version (-1 pre-entry). */
  readonly contributionVersion: number;
}

export interface CreatorScenario {
  // Stage 1 — creator discovery
  readonly creatorProfileId: string;
  readonly creatorProfileVersion: number;
  /** The restriction-excluded candidate (the hard-gate witness). */
  readonly excludedProfileId: string;
  readonly matchRunId: string;
  // Stage 2 — campaign/terms
  readonly campaignId: string;
  readonly campaignRewardPolicyId: string;
  readonly campaignPolicyVersion: number;
  readonly opportunityId: string;
  // Stage 3 — acceptance
  readonly engagement: Engagement;
  readonly usageRightsGrantId: string;
  // Stage 4 — UGC + rights
  readonly production: UgcProduction;
  readonly deliverableId: string;
  readonly deliverableKey: string;
  readonly productionEvidenceId: string;
  readonly submissionId: string;
  // Stage 5 — disclosure/compliance
  readonly declarationIds: readonly string[];
  readonly relationship: CommercialRelationship;
  readonly publication: PublicationRecord;
  readonly verifiedPublication: PublicationRecord;
  // Stage 6-7 — the execution subject + measurement
  readonly contribution: Contribution;
  readonly observation: OutcomeObservation;
  readonly measurementProviderId: string;
  readonly measurementRedactedFieldNames: readonly string[];
  // Stage 8 — outcomes
  readonly measuredOutcome: MeasuredOutcome;
  // Stage 9 — evidence / Proof-of-Value
  readonly povPlatformEvidenceId: string;
  readonly povProviderEvidenceId: string;
  readonly attestationId: string;
  readonly proofOfValueId: string;
  readonly basisEvidenceId: string;
  // Stage 11 — risk/dispute gates
  readonly riskControlId: string;
  readonly disputeId: string;
  // Stage 12 — settlement/payment
  readonly value: EconomicValueRecord;
  readonly matureValue: EconomicValueRecord;
  readonly paymentFact: ExternalSettlementFactRecord | null;
  /** The idempotency key the scenario's recognition committed under. */
  readonly recognitionIdempotencyKey: string;
  /**
   * The ordered canonical traversal witnesses — one per stage
   * boundary, in executable order (the W033 PR #68 remediation
   * discipline carried forward: the MEASURING lifecycle point is
   * witnessed BEFORE the measurement/outcomes/evidence stages — each
   * witnessed IN MEASURING at v5 — and the completed VERIFIED walk
   * BEFORE the economic stages; the pre-subject creator stages carry
   * their own durable authority record ids).
   */
  readonly traversal: readonly CreatorTraversalWitness[];
}

export interface RunCreatorScenarioOptions {
  /**
   * Stop after the risk/dispute gates are resolved (before the
   * settlement maturation) — the settlement stages use dedicated
   * fixtures in their own suites.
   */
  readonly skipSettlement?: boolean;
  /** The recognized amount (default 100). */
  readonly amount?: number;
}

/**
 * The canonical deterministic creator scenario: ONE creator execution
 * traversing every authority in the frozen order — the W015 profile
 * first, the W016 hard-gated match second, the campaign/terms third,
 * the W017 acceptance composite fourth, the sanctioned contribution
 * lifecycle entry fifth, the UGC production + authoritative rights
 * sixth, the engagement completion seventh, the W018
 * disclosure/compliance gate eighth, the MEASURING point ninth, and
 * ONLY THEN the measurement (the W022 adapter path), the outcomes, the
 * evidence/PoV, the PoH evaluation, the completed VERIFIED walk, the
 * risk/dispute gates (fail closed, then resolved), the settlement
 * (pending → mature) and the W030 external payment. Every step runs
 * through the OWNING boundary (service or composition-root composite)
 * — never a direct repository write. Returns every durable identifier
 * in the lineage plus the ordered traversal witnesses (the
 * executable-order proof).
 */
export async function runCreatorScenario(
  harness: NetW035Harness,
  opts: RunCreatorScenarioOptions = {},
): Promise<CreatorScenario> {
  const runtime = harness.runtime;
  const ctx = harness.creatorCtx("w035-canonical");

  // -- Stage 1a: the creator — the W015 ACTIVE profile (created +
  //    versioned + activated by the wrapped harness) resolved through
  //    the owning boundary.
  const profile = await runtime.creatorService.getProfileByPerson(
    ctx,
    harness.organizationScopeId,
    harness.creatorPersonId,
  );
  if (profile === null || profile.status !== "ACTIVE") {
    throw new Error(
      "W035 canonical scenario failed: the scenario creator profile is not ACTIVE",
    );
  }
  const profileVersions = await runtime.creatorService.listProfileVersions(
    ctx,
    harness.organizationScopeId,
    profile.id,
  );
  const creatorProfileVersion = profileVersions[profileVersions.length - 1]!.version;

  // The canonical traversal witness array. Pre-subject stages are
  // witnessed by their durable authority record ids; from the
  // engagement creation onward, by the AUTHORITATIVE engagement
  // state + version; from the contribution entry onward, by BOTH the
  // engagement AND contribution authoritative state + version.
  const traversal: CreatorTraversalWitness[] = [];
  let engagementId: string | null = null;
  let contributionId: string | null = null;
  const witness = async (
    stage: string,
    authority: string,
    recordId: string,
  ): Promise<void> => {
    const engagement =
      engagementId === null
        ? null
        : await runtime.creatorEngagementService.getEngagement(
            ctx,
            harness.organizationScopeId,
            engagementId,
          );
    const contribution =
      contributionId === null
        ? null
        : await runtime.contributionService.getContribution(
            ctx,
            contributionId,
          );
    traversal.push({
      stage,
      authority,
      recordId,
      engagementState: engagement?.state ?? "",
      engagementVersion: engagement?.version ?? -1,
      contributionState: contribution?.state ?? "",
      contributionVersion: contribution?.version ?? -1,
    });
  };
  await witness("creator-resolved", "/creators", profile.id);

  // -- Stage 1b: the authorized anchor — the profile resolved BY
  //    PERSON through the creator's OWN execution context (the
  //    actor↔person↔tenant binding; the tenancy negatives live in the
  //    AC-01 suite).
  const byOwnContext = await runtime.creatorService.getProfileByPerson(
    harness.creatorCtx("w035-authorized"),
    harness.organizationScopeId,
    harness.creatorPersonId,
  );
  if (byOwnContext?.id !== profile.id) {
    throw new Error(
      "W035 canonical scenario failed: the creator's own context did not resolve the profile",
    );
  }
  await witness("creator-authorized", "/creators", profile.id);

  // -- Stage 1c: the W016 match — the hard creator restrictions and
  //    eligibility rules execute BEFORE deterministic ranking: the
  //    scenario creator is ranked and a RESTRICTED candidate (a fresh
  //    person whose declared restrictions block a target territory)
  //    is hard-excluded from the run.
  const { createMatchCandidate } = await import(
    "../creators/_net-w016-harness.ts"
  );
  const excludedCandidate = await createMatchCandidate(
    harness.w018.w017.w016,
    { restrictedTerritories: ["GH"] },
  );
  const match = await runCreatorMatch(harness, {
    candidateProfileIds: [profile.id, excludedCandidate.profile.id],
    idempotencyKey: key("w035-match"),
  });
  const selected = match.run.results.find(
    (r) => r.profileId === profile.id,
  );
  if (!selected || selected.rank !== 1) {
    throw new Error(
      `W035 canonical scenario failed: the eligible creator was not selected (results: ${JSON.stringify(
        match.run.results.map((r) => [r.profileId, r.rank]),
      )})`,
    );
  }
  const excludedEntry = match.run.excluded.find(
    (e) => e.profileId === excludedCandidate.profile.id,
  );
  if (!excludedEntry) {
    throw new Error(
      "W035 canonical scenario failed: the restricted candidate was not excluded",
    );
  }
  await witness(
    "match-hard-gates-passed",
    "/creators",
    excludedCandidate.profile.id,
  );
  await witness("match-committed", "/creators", match.run.id);

  // -- Stage 2: the campaign contract/terms — the ACTIVE campaign
  //    with pinned policy v1 (the complete creator terms set) + the
  //    materialized opportunity (the W011 path).
  const { campaign, rewardPolicyId } = await createCreatorCampaign(harness);
  const operatorForCampaign = personCtx(
    harness,
    campaign.ownerPersonId,
    "w035-opportunity",
  );
  const draft = await runtime.campaignService.resolveOpportunityDraft(
    operatorForCampaign,
    campaign.id,
    "spec-1",
  );
  const opportunity = await runtime.opportunityService.createOpportunity(
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
  await runtime.campaignService.recordOpportunityPublication(
    operatorForCampaign,
    {
      campaignId: campaign.id,
      specId: draft.specId,
      policyVersion: draft.policyVersion,
      opportunityId: opportunity.id,
      idempotencyKey: key("w035-opportunity-record"),
    },
  );
  await witness("campaign-policy-resolved", "/campaigns", campaign.id);
  await witness("opportunity-materialized", "/opportunities", opportunity.id);

  // -- Stage 2b: the terms pinned — the W017 engagement offer (DRAFT
  //    v0) on the matched creator, citing the match run + the
  //    campaign opportunity, carrying the requested usage-rights
  //    envelope + the declared compensation terms (reference data)
  //    and pinning the campaign policy version server-side.
  const offer = await runtime.creatorEngagementService.createEngagement(
    harness.operatorCtx("w035-offer"),
    {
      organizationScopeId: harness.organizationScopeId,
      creatorPersonId: harness.creatorPersonId,
      campaignId: campaign.id,
      matchRunId: match.run.id,
      opportunityId: opportunity.id,
      requestedRights: {
        uses: [
          { kind: "channel_publication", terms: "organic creator-channel publication" },
          { kind: "paid_amplification", terms: null },
        ],
        channels: ["creator_owned_channel"],
        territories: ["GH", "NG"],
        formats: ["short_video"],
        // FIXED deterministic anchors (the §3.1 contract — never
        // Date.now()): the canonical requested window.
        startsAt: W035_RIGHTS_STARTS_AT,
        endsAt: W035_RIGHTS_REQUESTED_ENDS_AT,
        exclusions: ["political advertising"],
      },
      compensation: {
        format: "short_video",
        unit: "per_deliverable",
        amount: 750,
        currency: "USD",
        rewardPolicyReference: rewardPolicyId,
      },
      brief: { note: "W035 canonical creator engagement offer" },
      idempotencyKey: key("w035-engagement"),
    } as never,
  );
  engagementId = offer.engagement.id;
  if (offer.engagement.campaignPolicyVersion !== 1) {
    throw new Error(
      "W035 canonical scenario failed: the engagement did not pin campaign policy version 1",
    );
  }
  await witness("terms-pinned", "/creators", offer.engagement.id);

  // -- Stage 3: the creator acceptance — the W017 composite: the
  //    usage-rights grant + the READY → ASSIGNED transition commit as
  //    ONE authoritative unit (the creator acts as grantor).
  await runtime.apiCommands.requestTransition(
    harness.operatorCtx("w035-tender"),
    harness.operatorPersonId,
    {
      subjectId: offer.engagement.id,
      subjectKind: "engagement",
      targetState: "READY",
      expectedVersion: offer.engagement.version,
      idempotencyKey: key("w035-tender"),
      policyAction: policyActionFor("engagement", "DRAFT", "READY"),
    },
  );
  const accepted = await runtime.creatorEngagementService.acceptEngagement(
    harness.creatorCtx("w035-accept"),
    {
      organizationScopeId: harness.organizationScopeId,
      engagementId: offer.engagement.id,
      expectedVersion: 1,
      grantedRights: {
        uses: [
          { kind: "channel_publication", terms: "organic creator-channel publication" },
        ],
        channels: ["creator_owned_channel"],
        territories: ["GH"],
        formats: ["short_video"],
        // FIXED deterministic anchors (the §3.1 contract — never
        // Date.now()): the canonical granted window, strictly within
        // the requested envelope above.
        startsAt: W035_RIGHTS_STARTS_AT,
        endsAt: W035_RIGHTS_GRANTED_ENDS_AT,
        exclusions: ["political advertising", "gambling"],
      },
      idempotencyKey: key("w035-accept"),
    } as never,
  );
  const grant: UsageRightsGrant = accepted.grant;
  await witness("creator-accepted", "/creators", grant.id);

  // -- Stage 3b: the execution subject enters the sanctioned
  //    opportunity/contribution lifecycle (the W012 helpfulness
  //    composite on the campaign's materialized helpful_*
  //    opportunity — the ONLY contribution vehicle; no parallel
  //    creator state machine). CANONICAL ORDER: the publication walk
  //    runs BEFORE the UGC production (the production binds the
  //    contribution id).
  const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012, {
    policyId: key("w035-helpfulness-policy"),
    // The creator execution's measured outcome is a VIEW (the
    // campaign outcome policy's declared requirement — the delivery
    // notice reports views) — the PoH policy qualifies views.
    qualifyingOutcomeTypes: ["view"],
  });
  const { contribution } = await createHelpfulContribution(harness.w012, {
    opportunityId: opportunity.id,
    helpfulnessPolicyId: helpfulnessPolicy.policyId,
    // The claimant attributes satisfy the CAMPAIGN's eligibility
    // rules (region/language — the first consumer of the W011
    // eligibility-policy reference).
    claimantAttributes: {
      participant_class: ["contributor"],
      region: ["GH"],
      language: ["en"],
    },
    idempotencyKey: key("w035-contribution"),
  });
  contributionId = contribution.id;
  await witness("contribution-entered", "/contributions", contribution.id);

  await publishHelpfulContribution(harness.w012, contribution.id);
  await witness("contribution-submitted", "/workflows", contribution.id);

  // -- Stage 4: the UGC production + rights — the production opened
  //    on the accepted engagement AND BOUND to the contribution (the
  //    engagement → production → contribution lineage), the durable
  //    deliverable recorded, and the AUTHORITATIVE usage-rights view
  //    read (ACTIVE, scoped, creator_retained) — rights are
  //    authoritative BEFORE any publication/compliance stage that
  //    depends on them.
  const opened = await runtime.creatorEngagementService.openProduction(
    harness.creatorCtx("w035-production"),
    {
      organizationScopeId: harness.organizationScopeId,
      engagementId: accepted.engagement.id,
      expectedVersion: accepted.engagement.version,
      contributionId: contribution.id,
      idempotencyKey: key("w035-production"),
    } as never,
  );
  const deliverable = await runtime.creatorEngagementService.recordDeliverable(
    harness.creatorCtx("w035-deliverable"),
    {
      organizationScopeId: harness.organizationScopeId,
      productionId: opened.production.id,
      deliverableKey: "hero-short-video",
      format: "short_video",
      title: "Hero short video",
      contentReference: `object-store://w035/${key("artifact")}/hero-v1`,
      externalPlatform: {
        provider: "example-platform",
        externalId: key("w035-ext"),
        url: "https://example.com/w035-hero",
      } as never,
      notes: "first cut",
      idempotencyKey: key("w035-deliverable"),
    } as never,
  );
  await witness("ugc-recorded", "/creators", opened.production.id);

  const rightsView = await runtime.creatorEngagementService.getUsageRights(
    harness.operatorCtx("w035-rights"),
    harness.organizationScopeId,
    grant.id,
    // FIXED evaluation anchor INSIDE the granted window (§3.1 — the
    // authoritative `asOf ?? now` default is never exercised by the
    // canonical path; ACTIVE holds by construction).
    W035_RIGHTS_EVALUATION_AS_OF,
  );
  if (rightsView.effectiveStatus !== "ACTIVE") {
    throw new Error(
      `W035 canonical scenario failed: usage rights not ACTIVE (${rightsView.effectiveStatus})`,
    );
  }
  await witness("rights-authorized", "/creators", grant.id);

  // -- Stage 4b: the UGC submission — the canonical evidence bound to
  //    the production (subjectType ugc_production) + the submission
  //    (the engagement IN_PROGRESS → SUBMITTED transition), then the
  //    engagement SUBMITTED → VERIFIED through /workflows (the
  //    publication precondition).
  const productionEvidence = await runtime.evidenceService.createEvidence(
    harness.creatorCtx("w035-production-evidence"),
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: {
        subjectType: "ugc_production",
        subjectId: opened.production.id,
      },
      provenance: {
        sourceType: "platform",
        sourceId: "example-platform",
        method: "w035 fixture production capture",
        // FIXED deterministic anchor (§3.1 — never wall-clock).
        collectedAt: W035_EVIDENCE_CAPTURED_AT,
        collectorId: harness.creatorPersonId,
      },
      confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      sensitivity: "standard",
      payload: { kind: "ugc_production_capture", productionId: opened.production.id },
    },
  );
  const submitted = await runtime.creatorEngagementService.submitProduction(
    harness.creatorCtx("w035-submit-production"),
    {
      organizationScopeId: harness.organizationScopeId,
      productionId: opened.production.id,
      expectedVersion: opened.transition.subject.version,
      evidenceReferences: [productionEvidence.id],
      idempotencyKey: key("w035-submit-production"),
    } as never,
  );
  await witness("ugc-submitted", "/creators", submitted.submission.id);

  await runtime.apiCommands.requestTransition(
    harness.operatorCtx("w035-verify-engagement"),
    harness.operatorPersonId,
    {
      subjectId: accepted.engagement.id,
      subjectKind: "engagement",
      targetState: "VERIFIED",
      expectedVersion: submitted.transition.subject.version,
      idempotencyKey: key("w035-verify-engagement"),
      policyAction: policyActionFor("engagement", "SUBMITTED", "VERIFIED"),
    },
  );
  await witness("engagement-verified", "/workflows", accepted.engagement.id);

  // -- Stage 5: the disclosure/compliance gate — the W018 commercial
  //    relationship (the commercial truth + obligations), the
  //    sanctioned publication on the VERIFIED engagement's production
  //    (the creator-owned channel), the evidence-bound declarations
  //    for EVERY required kind (campaign policy ∪ relationship
  //    obligations), and the sanctioned verification gate (the
  //    DRAFT → VERIFIED edge ONLY verifyPublication can reach).
  const relationship =
    await runtime.creatorSponsorshipService.createCommercialRelationship(
      harness.operatorCtx("w035-relationship"),
      {
        organizationScopeId: harness.organizationScopeId,
        engagementId: accepted.engagement.id,
        campaignId: campaign.id,
        sponsorPersonId: harness.operatorPersonId,
        kind: "sponsorship",
        disclosureObligations: ["genuine_experience"],
        compensation: {
          format: "short_video",
          unit: "per_deliverable",
          amount: 750,
          currency: "USD",
          rewardPolicyReference: rewardPolicyId,
        },
        idempotencyKey: key("w035-relationship"),
      } as never,
    );
  await witness(
    "relationship-recorded",
    "/creators",
    relationship.relationship.id,
  );

  const publication = await runtime.creatorSponsorshipService.createPublication(
    harness.creatorCtx("w035-publication"),
    {
      organizationScopeId: harness.organizationScopeId,
      engagementId: accepted.engagement.id,
      productionId: opened.production.id,
      channel: {
        kind: "creator_owned_channel",
        externalPlatform: {
          provider: "example-platform",
          externalId: key("w035-pub-ext"),
          url: "https://example.com/w035-publication",
        },
      },
      idempotencyKey: key("w035-publication"),
    } as never,
  );
  await witness("publication-recorded", "/creators", publication.publication.id);

  const declarationIds: string[] = [];
  for (const kind of new Set(["material_connection", "genuine_experience"])) {
    const declarationEvidence = await runtime.evidenceService.createEvidence(
      harness.creatorCtx("w035-declaration-evidence"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectType: "publication",
          subjectId: publication.publication.id,
        },
        provenance: {
          sourceType: "platform",
          sourceId: "example-platform",
          method: "w035 fixture publication capture",
          // FIXED deterministic anchor (§3.1 — never wall-clock).
          collectedAt: W035_EVIDENCE_CAPTURED_AT,
          collectorId: harness.creatorPersonId,
        },
        confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
        sensitivity: "standard",
        payload: {
          kind: "publication_capture",
          publicationId: publication.publication.id,
        },
      },
    );
    const declaration =
      await runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        harness.creatorCtx("w035-declaration"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.publication.id,
          kind,
          statement: `#${kind.replace("_", "-")} fixture statement`,
          evidenceReferences: [declarationEvidence.id],
          idempotencyKey: key("w035-declaration"),
        } as never,
      );
    declarationIds.push(declaration.declaration.id);
  }
  const publicationEvidence = await runtime.evidenceService.createEvidence(
    harness.creatorCtx("w035-publication-evidence"),
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: {
        subjectType: "publication",
        subjectId: publication.publication.id,
      },
      provenance: {
        sourceType: "platform",
        sourceId: "example-platform",
        method: "w035 fixture publication capture",
        // FIXED deterministic anchor (§3.1 — never wall-clock).
        collectedAt: W035_EVIDENCE_CAPTURED_AT,
        collectorId: harness.creatorPersonId,
      },
      confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      sensitivity: "standard",
      payload: {
        kind: "publication_capture",
        publicationId: publication.publication.id,
      },
    },
  );
  const verifiedPublication =
    await runtime.creatorSponsorshipService.verifyPublication(
      harness.operatorCtx("w035-verify-publication"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.publication.id,
        expectedVersion: publication.publication.version,
        evidenceReferences: [publicationEvidence.id],
        idempotencyKey: key("w035-verify-publication"),
      } as never,
  );
  if (verifiedPublication.publication.state !== "VERIFIED") {
    throw new Error(
      "W035 canonical scenario failed: the publication did not verify",
    );
  }
  await witness(
    "disclosure-compliance-satisfied",
    "/creators",
    publication.publication.id,
  );

  // -- Stage 6: the lifecycle reaches the MEASUREMENT point through
  //    /workflows (SUBMITTED → MEASURING) — the intended lifecycle
  //    point at which the downstream measurement/outcomes/evidence
  //    stages execute (work order §3.6: MEASURING before
  //    measurement/evidence, proven with authoritative state/version
  //    witnesses — never merely local array order).
  await advanceToMeasuring(harness, contribution.id);
  await witness("lifecycle-measuring", "/workflows", contribution.id);

  // -- Stage 7: the measurement — ONE deterministic OpenRTB delivery
  //    notice routed through the REAL W022 provider-selection path
  //    (the delivery-notice adapter normalizes + integrity-verifies
  //    the raw vendor payload; the composed command persists the
  //    NEUTRAL observation in /outcomes). The raw payload stays
  //    opaque — only the neutral contract + redacted field NAMES
  //    cross the boundary. Executed while the contribution is IN
  //    MEASURING.
  const measurement = await submitCreatorMeasurement(
    harness,
    contribution.id,
  );
  await witness(
    "measurement-normalized",
    "/measurement→/outcomes",
    measurement.observation.id,
  );

  // -- Stage 8: the outcomes — the VERIFIED normalized measured
  //    outcome over the provider observation (maturation window,
  //    rollup, finalize), attached as the PoH measured_outcome basis
  //    (the attributed_outcome settlement lineage). Executed while
  //    MEASURING.
  const measuredOutcome = await createVerifiedMeasuredOutcomeForSubject(
    harness,
    contribution.id,
    measurement.observation.id,
  );
  await witness("outcome-verified", "/outcomes", measuredOutcome.id);

  // -- Stage 9: the evidence / Proof-of-Value — platform + provider
  //    evidence (the provider evidence cites the SAME measurement
  //    provider that produced the observation), an independent
  //    attestation, aggregation → VERIFIED. The declared evidence
  //    requirements of the campaign policy (a PoV, ATTESTED minimum,
  //    platform sources) are satisfied BEFORE the lifecycle's
  //    evidence-gated transition. Executed while MEASURING.
  const pov = await attachVerifiedProofOfValueForSubject(
    harness,
    contribution.id,
    measurement.providerId,
  );
  const basisEvidence = await attachEvidenceBasisForSubject(
    harness,
    contribution.id,
  );
  await witness("evidence-pov-verified", "/evidence", pov.proofOfValueId);

  // -- Stage 9b: the PoH evaluation — the deterministic helpfulness
  //    gate re-resolves EVERY basis through its truth authority while
  //    the contribution is IN MEASURING.
  const poh = await runtime.helpfulnessService.evaluateHelpfulness(ctx, {
    contributionId: contribution.id,
    idempotencyKey: key("w035-poh-eval"),
  });
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `W035 canonical scenario failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  await witness("poh-evaluated", "/workflows", contribution.id);

  // -- Stage 10: the lifecycle walk COMPLETES through /workflows —
  //    the remaining forward transitions MEASURING → EVALUATING →
  //    CHALLENGE_WINDOW → SETTLING → SETTLED → VERIFIED, entered
  //    only after every measurement/outcome/evidence basis exists
  //    and the PoH is QUALIFIED (the MEASURING → EVALUATING edge
  //    requires the evidence reference).
  const verifiedContribution = await walkToVerified(
    harness,
    contribution.id,
  );
  await witness("lifecycle-completed", "/workflows", contribution.id);

  // -- Stage 11a: the settlement entry — the recognition composite
  //    (the creator-to-settlement join): the VERIFIED contribution +
  //    the QUALIFIED PoH resolve through the neutral gates and the
  //    pending value record + the balanced recognition postings
  //    commit as ONE authoritative unit.
  const recognitionIdempotencyKey = key("w035-recognize");
  const recognized = await recognizeCreatorValue(harness, contribution.id, {
    amount: opts.amount ?? 100,
    idempotencyKey: recognitionIdempotencyKey,
  });
  await witness("settlement-pending", "/settlement", recognized.value.id);

  // -- Stage 11b: the risk/dispute gates — BEFORE economic
  //    maturation/consumption, exercise the EXISTING /disputes
  //    controls fail-closed (a HOLD risk control + an ACTIVE bonded
  //    dispute on the contribution — the upstream source), then
  //    resolve BOTH and prove the authoritative path re-opens.
  const riskControlId = await holdMaturationOn(harness, "contribution", contribution.id);
  let maturedFirst: EconomicValueRecord | null = null;
  try {
    maturedFirst = await matureCreatorValue(harness, recognized.value.id);
  } catch (error) {
    // The EXPECTED fail-closed refusal (RISK_CONTROL).
    const code = (error as { code?: string }).code;
    if (code !== "RISK_CONTROL") {
      throw error;
    }
  }
  if (maturedFirst !== null) {
    throw new Error(
      "W035 canonical scenario failed: the HOLD risk control did not refuse the maturation",
    );
  }
  await witness("risk-gate-refused", "/disputes", riskControlId);

  await resolveHold(harness, riskControlId);
  await witness("risk-gate-resolved", "/disputes", riskControlId);

  const disputeId = await openBondedDisputeOn(
    harness,
    "contribution",
    contribution.id,
  );
  let maturedSecond: EconomicValueRecord | null = null;
  try {
    maturedSecond = await matureCreatorValue(harness, recognized.value.id);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "DISPUTE_CHALLENGE") {
      throw error;
    }
  }
  if (maturedSecond !== null) {
    throw new Error(
      "W035 canonical scenario failed: the ACTIVE dispute did not refuse the maturation",
    );
  }
  await witness("dispute-gate-refused", "/disputes", disputeId);

  await resolveDispute(harness, disputeId, contribution.id);
  await witness("dispute-gate-resolved", "/disputes", disputeId);

  if (opts.skipSettlement === true) {
    return {
      creatorProfileId: profile.id,
      creatorProfileVersion,
      excludedProfileId: excludedCandidate.profile.id,
      matchRunId: match.run.id,
      campaignId: campaign.id,
      campaignRewardPolicyId: rewardPolicyId,
      campaignPolicyVersion: campaign.currentPolicyVersion ?? 1,
      opportunityId: opportunity.id,
      engagement: await runtime.creatorEngagementService.getEngagement(
        ctx,
        harness.organizationScopeId,
        accepted.engagement.id,
      ),
      usageRightsGrantId: grant.id,
      production: opened.production,
      deliverableId: (deliverable as { deliverable?: { id?: string } }).deliverable?.id ?? "",
      deliverableKey: String(
        (deliverable as { deliverable?: { deliverableKey?: string } })
          .deliverable?.deliverableKey ?? "hero-short-video",
      ),
      productionEvidenceId: productionEvidence.id,
      submissionId: submitted.submission.id,
      declarationIds,
      relationship: relationship.relationship,
      publication: publication.publication,
      verifiedPublication: verifiedPublication.publication,
      contribution: verifiedContribution,
      observation: measurement.observation,
      measurementProviderId: measurement.providerId,
      measurementRedactedFieldNames: measurement.redactedFieldNames,
      measuredOutcome,
      povPlatformEvidenceId: pov.platformEvidenceId,
      povProviderEvidenceId: pov.providerEvidenceId,
      attestationId: pov.attestationId,
      proofOfValueId: pov.proofOfValueId,
      basisEvidenceId: basisEvidence.evidenceId,
      riskControlId,
      disputeId,
      value: recognized.value,
      matureValue: recognized.value,
      paymentFact: null,
      recognitionIdempotencyKey,
      traversal,
    };
  }

  // -- Stage 12: the settlement maturation + the declared payment
  //    path. The maturation composite (all gates now green) commits
  //    the MATURE state; then the W030 external payment leg: the
  //    trusted provider notification (signed with the TEST trust
  //    key) reporting the payout over the value's recognition
  //    transaction is recorded through the external-settlement
  //    authority (provider integration ONLY — the fact posts NO
  //    ledger entries and mints nothing), and the derived
  //    reconciliation matches the authoritative internal lineage.
  const matured = await matureCreatorValue(harness, recognized.value.id);
  await witness("settlement-matured", "/settlement", matured.id);

  const payment = await recordCreatorPayment(harness, {
    valueRecordId: matured.id,
    internalTransactionId: matured.recognitionTransactionId,
    reportedAmount: matured.amount,
  });
  const reconciliation =
    await runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      harness.operatorCtx("w035-reconcile"),
      {
        organizationScopeId: harness.organizationScopeId,
        factId: payment.id,
      },
    );
  if (reconciliation.verdict !== "matched") {
    throw new Error(
      `W035 canonical scenario failed: the payment reconciliation verdict was ${reconciliation.verdict} (${reconciliation.reason})`,
    );
  }
  await witness("payment-committed", "/payments+/adapters", payment.id);

  return {
    creatorProfileId: profile.id,
    creatorProfileVersion,
    excludedProfileId: excludedCandidate.profile.id,
    matchRunId: match.run.id,
    campaignId: campaign.id,
    campaignRewardPolicyId: rewardPolicyId,
    campaignPolicyVersion: campaign.currentPolicyVersion ?? 1,
    opportunityId: opportunity.id,
    engagement: await runtime.creatorEngagementService.getEngagement(
      ctx,
      harness.organizationScopeId,
      accepted.engagement.id,
    ),
    usageRightsGrantId: grant.id,
    production: opened.production,
    deliverableId: (deliverable as { deliverable?: { id?: string } }).deliverable?.id ?? "",
    deliverableKey: String(
      (deliverable as { deliverable?: { deliverableKey?: string } })
        .deliverable?.deliverableKey ?? "hero-short-video",
    ),
    productionEvidenceId: productionEvidence.id,
    submissionId: submitted.submission.id,
    declarationIds,
    relationship: relationship.relationship,
    publication: publication.publication,
    verifiedPublication: verifiedPublication.publication,
    contribution: verifiedContribution,
    observation: measurement.observation,
    measurementProviderId: measurement.providerId,
    measurementRedactedFieldNames: measurement.redactedFieldNames,
    measuredOutcome,
    povPlatformEvidenceId: pov.platformEvidenceId,
    povProviderEvidenceId: pov.providerEvidenceId,
    attestationId: pov.attestationId,
    proofOfValueId: pov.proofOfValueId,
    basisEvidenceId: basisEvidence.evidenceId,
    riskControlId,
    disputeId,
    value: recognized.value,
    matureValue: matured,
    paymentFact: payment,
    recognitionIdempotencyKey,
    traversal,
  };
}

// ---------------------------------------------------------------------------
// Scenario building blocks (the W035 composition specifics)
// ---------------------------------------------------------------------------

/**
 * Submit ONE deterministic OpenRTB delivery notice through the
 * COMPOSED W022 measurement command (the REAL provider-selection
 * path: the delivery-notice adapter normalizes + verifies the raw
 * vendor payload, the composed command persists the neutral
 * observation in /outcomes). The observer is the acting operator.
 */
export async function submitCreatorMeasurement(
  harness: NetW035Harness,
  subjectId: string,
  opts: {
    readonly idempotencyKey?: string;
    readonly notice?: Record<string, unknown>;
    readonly actorPersonId?: string;
  } = {},
): Promise<{
  readonly observation: OutcomeObservation;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly redactedFieldNames: readonly string[];
  readonly created: boolean;
}> {
  const ctx =
    opts.actorPersonId !== undefined
      ? personCtx(harness, opts.actorPersonId, "w035-measure")
      : harness.operatorCtx("w035-measure");
  const result = await harness.runtime.apiCommands.submitMeasurementReport(
    ctx,
    opts.actorPersonId ?? harness.operatorPersonId,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectReference: {
        subjectId,
        subjectType: "contribution",
      },
      idempotencyKey: opts.idempotencyKey ?? key("w035-measure"),
      providerId: OPENRTB_DELIVERY_PROVIDER_ID,
      report: opts.notice ?? rawDeliveryNotice(),
    },
  );
  const observation =
    await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      (result as { observation: { id: string } }).observation.id,
    );
  return {
    observation,
    providerId: OPENRTB_DELIVERY_PROVIDER_ID,
    providerVersion: String(
      (result as { providerVersion: unknown }).providerVersion,
    ),
    redactedFieldNames: (
      result as { redactedFieldNames: readonly string[] }
    ).redactedFieldNames,
    created: (result as { created: boolean }).created,
  };
}

/**
 * A VERIFIED normalized measured outcome for the given subject over
 * the provider observation (the measurement → outcomes stage):
 * maturation window opened, rollup recorded, finalize → VERIFIED,
 * attached as the PoH measured_outcome basis exactly as the W014
 * factory does (the attributed_outcome settlement lineage).
 */
export async function createVerifiedMeasuredOutcomeForSubject(
  harness: NetW035Harness,
  subjectId: string,
  observationId: string,
): Promise<MeasuredOutcome> {
  const runtime = harness.runtime;
  const ctx = harness.creatorCtx("w035-measured-outcome");
  const measurement = await runtime.measuredOutcomeService.createMeasuredOutcome(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: { subjectId, subjectType: "contribution" },
      outcomeType: "view",
      maturation: { strategy: "immediate" },
      observationIds: [observationId],
    },
  );
  await runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: measurement.version,
    idempotencyKey: key("w035-mo-begin"),
    actorPersonId: harness.creatorPersonId,
  });
  await runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  const finalized = await runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: key("w035-mo-finalize"),
    actorPersonId: harness.creatorPersonId,
  });
  if (finalized.measurement.state !== "VERIFIED") {
    throw new Error(
      `W035 canonical scenario failed: measured outcome state ${finalized.measurement.state}`,
    );
  }
  await runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "measured_outcome",
    referenceId: finalized.measurement.id,
    idempotencyKey: key("w035-mo-basis"),
  });
  return finalized.measurement;
}

/**
 * A VERIFIED Proof-of-Value for the given subject — platform evidence
 * + provider evidence whose provenance cites the MEASUREMENT PROVIDER
 * that produced the observation (the evidence-to-measurement
 * lineage), an independent attestation, aggregation, verification —
 * attached as the PoH proof_of_value basis. Every durable id
 * returned.
 */
export async function attachVerifiedProofOfValueForSubject(
  harness: NetW035Harness,
  subjectId: string,
  measurementProviderId: string,
): Promise<{
  readonly proofOfValueId: string;
  readonly platformEvidenceId: string;
  readonly providerEvidenceId: string;
  readonly attestationId: string;
}> {
  const runtime = harness.runtime;
  const ctx = harness.creatorCtx("w035-pov");
  const ePlatform = await runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "platform",
      sourceId: "platform-w035",
      method: "platform-counter",
    },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const eProvider = await runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "provider",
      sourceId: measurementProviderId,
      method: "openrtb-delivery-notice",
    },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const proof = await runtime.proofOfValueService.createProofOfValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    evidenceIds: [ePlatform.id, eProvider.id],
  });
  await runtime.proofOfValueService.beginMeasuring(ctx, {
    proofId: proof.id,
    expectedVersion: proof.version,
    idempotencyKey: key("w035-pov-begin"),
    actorPersonId: harness.creatorPersonId,
  });
  const attestation = await runtime.attestationService.createAttestation(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.operatorPersonId,
      statement: "Independently reviewed the sponsored creator content delivery evidence.",
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
    idempotencyKey: key("w035-pov-evaluating"),
    actorPersonId: harness.creatorPersonId,
  });
  await runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await runtime.proofOfValueService.verify(ctx, {
    proofId: proof.id,
    expectedVersion: 2,
    idempotencyKey: key("w035-pov-verify"),
    actorPersonId: harness.creatorPersonId,
  });
  await runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "proof_of_value",
    referenceId: verified.proof.id,
    idempotencyKey: key("w035-pov-basis"),
  });
  return {
    proofOfValueId: verified.proof.id,
    platformEvidenceId: ePlatform.id,
    providerEvidenceId: eProvider.id,
    attestationId: attestation.id,
  };
}

/** An ATTESTED evidence-record basis attached to the PoH (the W012 pattern). */
export async function attachEvidenceBasisForSubject(
  harness: NetW035Harness,
  subjectId: string,
): Promise<{ readonly evidenceId: string }> {
  const ctx = harness.creatorCtx("w035-evidence-basis");
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "attested",
      sourceId: "src-w035",
      method: "community-attestation",
    },
    confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
    sensitivity: "standard",
    payload: { helpful: true, signals: ["creator-content-delivery"] },
  });
  await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "evidence_record",
    referenceId: evidence.id,
    idempotencyKey: key("w035-basis"),
  });
  return { evidenceId: evidence.id };
}

/**
 * Advance a SUBMITTED contribution to the MEASURING lifecycle point
 * through the /workflows authority (the single SUBMITTED → MEASURING
 * transition) — the canonical point at which the downstream
 * measurement/outcomes/evidence stages execute.
 */
export async function advanceToMeasuring(
  harness: NetW035Harness,
  contributionId: string,
): Promise<Contribution> {
  const ctx = harness.creatorCtx("w035-advance-measuring");
  const current = await harness.runtime.contributionService.getContribution(
    ctx,
    contributionId,
  );
  if (current.state !== "SUBMITTED") {
    throw new Error(
      `W035 canonical scenario failed: expected SUBMITTED at the measurement-point advance, got ${current.state}`,
    );
  }
  await harness.runtime.workflowService.requestTransition(
    {
      subjectId: contributionId,
      subjectKind: "contribution",
      targetState: "MEASURING",
      expectedVersion: current.version,
      idempotencyKey: key("w035-t-measuring"),
      actorPersonId: harness.creatorPersonId,
      policyAction: policyActionFor("contribution", "SUBMITTED", "MEASURING"),
      metadata: { creatorLifecycleStage: "net-w035" },
    },
    ctx,
  );
  return harness.runtime.contributionService.getContribution(
    ctx,
    contributionId,
  );
}

/**
 * Walk a MEASURING contribution to the terminal VERIFIED state
 * through the /workflows authority (the remaining forward transitions
 * MEASURING → EVALUATING → CHALLENGE_WINDOW → SETTLING → SETTLED →
 * VERIFIED — exactly the W014/W033 sequence tail, with fresh
 * idempotency keys).
 */
export async function walkToVerified(
  harness: NetW035Harness,
  contributionId: string,
): Promise<Contribution> {
  const ctx = harness.creatorCtx("w035-verify-walk");
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
        idempotencyKey: key(`w035-t${String(step)}`),
        actorPersonId: harness.creatorPersonId,
        policyAction: policyActionFor(
          "contribution",
          from as "MEASURING",
          to as "VERIFIED",
        ),
        metadata: { creatorLifecycleStage: "net-w035" },
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
// The risk/dispute gate fixtures (the /disputes authority)
// ---------------------------------------------------------------------------

/**
 * Activate a HOLD risk control for the given subject (the W009
 * risk-policy + assessment + control chain — the /disputes
 * authority). The operation class defaults to value_maturation (the
 * maturation gate).
 */
export async function holdMaturationOn(
  harness: NetW035Harness,
  subjectType: "contribution" | "economic_value",
  subjectId: string,
  operationClass: "value_maturation" | "reward_allocation" = "value_maturation",
): Promise<string> {
  const w009 = harness.w018.w017.w016.w015.w013.w012.w011.w010.w009;
  const policy = await createDefaultRiskPolicy(w009, key("w035-risk-policy"));
  const ctx = harness.operatorCtx("w035-assessment");
  const assessment = await harness.runtime.riskAssessmentService.recordAssessment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.creatorPersonId,
      policyId: policy.policyId,
      evaluatedAt: "2026-09-01T12:00:00.000Z",
      idempotencyKey: key("w035-assessment"),
    },
  );
  const { control } = await harness.runtime.riskControlService.activateControl(
    harness.operatorCtx("w035-control"),
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass,
      action: "HOLD",
      subjectRef: { subjectType, subjectId },
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["collusion_pattern"],
      idempotencyKey: key("w035-control"),
    },
  );
  return control.id;
}

/** Resolve a HOLD risk control (the sanctioned /disputes resolution). */
export async function resolveHold(
  harness: NetW035Harness,
  controlDecisionId: string,
): Promise<void> {
  await harness.runtime.riskControlService.resolveControl(
    harness.operatorCtx("w035-resolve-control"),
    {
      controlDecisionId,
      note: "cleared after creator-lifecycle review",
      idempotencyKey: key("w035-resolve-control"),
    },
  );
}

/**
 * Open + bond a dispute over the subject (the challenger holds
 * credits — the W010 pattern). Returns the dispute id.
 *
 * DETERMINISTIC FIXTURE (the W034 PR #70 remediation discipline): the
 * challenge anchor is the subject's OWN authoritative anchor —
 * `contribution.createdAt` / `economic_value.recordedAt`, the EXACT
 * fields the dispute authority's subject lookup binds — read through
 * the owning boundary. The challenge-window check [anchorAt, anchorAt
 * + DISPUTE_CHALLENGE_WINDOW_MS] accepts the anchor itself by
 * construction, so the fixture carries NO wall-clock call (the W035
 * deterministic-fixture contract: verification never depends on
 * `Date.now()`).
 */
export async function openBondedDisputeOn(
  harness: NetW035Harness,
  subjectType: "contribution" | "economic_value",
  subjectId: string,
): Promise<string> {
  await ensureCreditsFor(harness.w010, harness.challengerPersonId, 50);
  const ctx = harness.challengerCtx("w035-dispute");
  const subjectAnchorAt =
    subjectType === "contribution"
      ? (
          await harness.runtime.contributionService.getContribution(
            harness.operatorCtx("w035-dispute-anchor"),
            subjectId,
          )
        ).createdAt
      : (
          await harness.runtime.economicValueService.getValue(
            harness.operatorCtx("w035-dispute-anchor"),
            subjectId,
          )
        ).recordedAt;
  const opened = await harness.runtime.disputeService.openDispute(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectRef: { subjectType, subjectId },
    statement: "the challenged creator delivery misstates verified value",
    reasonCodes: ["contested_verification"],
    supportingRefs: [{ kind: subjectType, id: subjectId }],
    effectiveAt: subjectAnchorAt,
    idempotencyKey: key("w035-dispute"),
  });
  const dispute = opened.dispute;
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: dispute.organizationScopeId,
    ownerPersonId: dispute.challengerPersonId,
    amount: dispute.stake.requirement.amount,
    purpose: { kind: "dispute_challenge", id: dispute.id },
    description: `challenge stake for dispute ${dispute.id}`,
    idempotencyKey: key("w035-dispute-stake"),
  });
  const bonded = await harness.runtime.disputeService.bondStake(ctx, {
    disputeId: dispute.id,
    stakeId: staked.stake.id,
    idempotencyKey: key("w035-dispute-bond"),
  });
  return bonded.id;
}

/**
 * Resolve the dispute through due process (review first — the
 * reviewer is NEVER the challenger — then a DISMISSED resolution
 * releasing the control).
 */
export async function resolveDispute(
  harness: NetW035Harness,
  disputeId: string,
  subjectId: string,
): Promise<void> {
  await harness.runtime.disputeService.startReview(
    harness.reviewerCtx("w035-review"),
    {
      disputeId,
      idempotencyKey: key("w035-review"),
    },
  );
  await harness.runtime.disputeService.resolveDispute(
    harness.reviewerCtx("w035-resolve-dispute"),
    {
      disputeId,
      outcome: "DISMISSED",
      controlDisposition: "RELEASE_CONTROL",
      reasonCodes: ["no_merit"],
      sourceRefs: [{ kind: "contribution", id: subjectId }],
      note: "no merit — the creator delivery evidence verified",
      idempotencyKey: key("w035-resolve-dispute"),
    },
  );
}

// ---------------------------------------------------------------------------
// The settlement + payment composites (the /settlement + W030 authorities)
// ---------------------------------------------------------------------------

/** The recognition composite exactly as the apiCommand runs it. */
export async function recognizeCreatorValue(
  harness: NetW035Harness,
  contributionId: string,
  opts: { readonly amount?: number; readonly idempotencyKey?: string } = {},
): Promise<{ value: EconomicValueRecord; created: boolean }> {
  const ctx = harness.operatorCtx("w035-recognize");
  const result = await harness.runtime.apiCommands.recognizeContributionValue(
    ctx,
    harness.operatorPersonId,
    {
      contributionId,
      amount: opts.amount ?? 100,
      idempotencyKey: opts.idempotencyKey ?? key("w035-recognize"),
    },
  );
  return {
    value: result.value as unknown as EconomicValueRecord,
    created: result.created,
  };
}

/** The maturation composite (risk/dispute-gated) as the apiCommand runs it. */
export async function matureCreatorValue(
  harness: NetW035Harness,
  valueRecordId: string,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<EconomicValueRecord> {
  const ctx = harness.operatorCtx("w035-mature");
  return (await harness.runtime.apiCommands.matureEconomicValue(ctx, {
    valueRecordId,
    idempotencyKey: opts.idempotencyKey ?? key("w035-mature"),
  })) as unknown as EconomicValueRecord;
}

/**
 * The W030 external payment leg — record ONE external settlement
 * fact through the external-settlement authority: a SIGNED reference
 * -provider notification (the TEST trust key — the trusted provider
 * channel) reporting the payout over the matured value's recognition
 * transaction. The fact is provider integration ONLY: it posts NO
 * ledger entries, touches NO account, mints/consumes/reverses
 * NOTHING (the reconciliation is DERIVED over the authoritative
 * internal lineage).
 *
 * DETERMINISTIC FIXTURE (the PR #73 remediation — architect comment
 * #5514394512, Blocker 2): the canonical external payment identity
 * is DERIVED from the authoritative subject it reports on —
 * `ext-pay-w035-{valueRecordId}` over the matured value record —
 * never randomUUID entropy, so the same canonical execution over
 * the same authoritative state reproduces the same durable external
 * lineage. The signing timestamp is the FIXED W035_PAYMENT_SIGNED_AT
 * anchor (integrity.signedAt is shape-validated only — never
 * freshness-gated). The ONE sanctioned wall-clock read is the
 * provider freshness `observedAt` (the explicit architect exception:
 * the external-settlement authority wall-clock-enforces the
 * freshness window — a fixed instant would fail closed by design;
 * the determinism anchors never depend on it).
 */
export async function recordCreatorPayment(
  harness: NetW035Harness,
  opts: {
    readonly valueRecordId: string;
    readonly internalTransactionId: string;
    readonly reportedAmount: number;
    readonly externalId?: string;
    readonly idempotencyKey?: string;
    /** Exercise the fail-closed channels (tests only). */
    readonly wrongKey?: boolean;
    readonly unsigned?: boolean;
    readonly tampered?: boolean;
    readonly stale?: boolean;
    readonly organizationScopeId?: string;
  },
): Promise<ExternalSettlementFactRecord> {
  const externalId =
    opts.externalId ?? `ext-pay-w035-${opts.valueRecordId}`;
  // The explicit freshness exception — see the doc comment above.
  const observedAt = opts.stale
    ? "2020-01-01T00:00:00.000Z"
    : freshProviderObservationTimestamp();
  const facts = {
    externalId,
    internalTransactionId: opts.internalTransactionId,
    reportedAmount: opts.reportedAmount,
    reportedUnit: "value",
    observedAt,
    correctionOf: null,
  };
  let integrity: Record<string, unknown> | undefined;
  if (!opts.unsigned) {
    const envelope = buildExternalSettlementIntegrity(
      { provider: "reference", ...facts },
      opts.wrongKey === true
        ? "wrong-external-settlement-trust-key"
        : EXTERNAL_SETTLEMENT_TEST_TRUST_KEY,
      W035_PAYMENT_SIGNED_AT,
    );
    let signature = envelope.signature;
    if (opts.tampered === true) {
      // Flip one hex nibble (a minimal, deterministic tamper).
      const nibble = signature[0] === "0" ? "1" : "0";
      signature = nibble + signature.slice(1);
    }
    integrity = {
      algorithm: envelope.algorithm,
      signature,
      signedAt: envelope.signedAt,
    };
  }
  const ctx = harness.operatorCtx("w035-payment");
  const result =
    await harness.runtime.externalSettlementService.recordExternalSettlementFact(
      ctx,
      {
        organizationScopeId:
          opts.organizationScopeId ?? harness.organizationScopeId,
        provider: "reference",
        payload: {
          ...facts,
          ...(integrity !== undefined ? { integrity } : {}),
        },
        idempotencyKey: opts.idempotencyKey ?? key("w035-payment"),
      },
    );
  return result.fact;
}
