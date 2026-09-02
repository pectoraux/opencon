/**
 * NET-W034 shared test harness — the complete advertising lifecycle
 * (Phase-9 end-to-end composition proof).
 *
 * Wraps the NET-W019 harness (runtime + persons + organizations + the
 * inventory/placement/supply-verification factories + the ENTIRE
 * creators→contribution chain W017→W016→W015→W013→W012→W011→W010→W008,
 * so the campaigns/opportunities/contributions/workflows/evidence/
 * outcomes/disputes/settlement machinery all run on ONE runtime) and
 * adds exactly the composition wiring the canonical ADVERTISING path
 * needs (all of it through existing sanctioned surfaces):
 *
 *  - measurement provider threading: the REAL OpenRTB delivery-notice
 *    measurement adapter (W022) wired through `createRuntime` — the
 *    same provider-selection path production uses (TEST verification
 *    secret, never a real credential). This is the one minimal
 *    harness adjustment W034 needs: `measurement.providers` threaded
 *    through the NET-W008 harness options (a TEST harness file);
 *  - the seller-authorization trust channel key for the OpenRTB
 *    ingress (the W023 supply-chain verification envelope — TEST
 *    literal);
 *  - the guard policies the composed advertising commands require
 *    (campaigns.matching.run + the measured-outcome guard actions +
 *    the per-transition policies for the operator — the W021 pattern;
 *    reward.recognize/clear/reputation — the W020 pattern;
 *    measurementReport.submit — the W022/W023 pattern;
 *    adRequest.evaluate — the W023 pattern);
 *  - the canonical end-to-end scenario factory
 *    `runAdvertisingScenario` — ONE deterministic advertising
 *    execution traversing the ENTIRE frozen authoritative chain IN
 *    the canonical executable order (the W033 traversal-proof
 *    discipline — the PR #68 architect-remediation lesson — carried
 *    forward: every stage boundary is witnessed by the AUTHORITATIVE
 *    contribution state + version read through the owning boundary,
 *    and the durable audit log's commit order corroborates the
 *    declared stage order):
 *
 *      campaign/policy (ACTIVE, pinned policy v1, clearing rule)
 *      → supply/provenance (W019 registration + verification +
 *        the W023 OpenRTB supply-chain evaluation, exact-one)
 *      → W021 campaign matching (hard gates BEFORE ranking)
 *      → placement (the W019 authority, pinned policy version)
 *      → campaign opportunity materialization (the W011 path)
 *      → contribution entry + publication (… → SUBMITTED)
 *      → /workflows SUBMITTED → MEASURING (the measurement point)
 *      → measurement (the W022 delivery-notice adapter → /outcomes)
 *      → outcomes (the VERIFIED measured outcome, while MEASURING)
 *      → evidence / Proof-of-Value (VERIFIED, while MEASURING)
 *      → PoH evaluation (QUALIFIED, while MEASURING)
 *      → /workflows walk completion (MEASURING → … → VERIFIED)
 *      → risk/dispute gates (fail closed, then resolved)
 *      → settlement (PENDING → MATURE → the campaign clearing rule)
 *
 *    with fixed evaluation anchors (never a wall clock where the
 *    authorities accept one), every durable identifier returned, and
 *    the ordered `traversal` witness array proving the canonical
 *    traversal order — not just the eventual end state.
 *
 * W034 adds NO production source file, domain, authority or state
 * machine: this harness is pure test composition over the existing
 * contracts (the single production-adjacent change is the
 * `measurement.providers` option threading in the NET-W008 TEST
 * harness — declared in the changed-file policy of the ledger).
 */

import {
  createNetW019Harness,
  registerInventoryItem,
  createSupplyEvidence,
  personCtx as w019PersonCtx,
  creatorCtx as w019CreatorCtx,
  operatorCtx as w019OperatorCtx,
  key as w019Key,
  type NetW019Harness,
} from "../inventory/_net-w019-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  publishHelpfulContribution,
  type NetW012Harness,
} from "../contributions/_net-w012-harness.ts";
import { createDefaultRiskPolicy } from "../disputes/_net-w009-harness.ts";
import { ensureCreditsFor, type NetW010Harness } from "../disputes/_net-w010-harness.ts";
import {
  rawBidRequest,
  verifyingAuthorizations,
  signSellerAuthorization,
  publisherAdsTxtContent,
  firstExchangeSellersJson,
  rawDeliveryNotice,
  PUBLISHER_DOMAIN,
  SUPPLY_PROVIDER_ID,
  SELLER_AUTH_TRUST_TEST_SECRET,
  OPENRTB_DELIVERY_TEST_SECRET,
  EVALUATED_AT,
  OBSERVED_AT,
  FIRST_EXCHANGE,
} from "../adapters/_net-w023-harness.ts";
import { OpenRtbDeliveryNoticeAdapter, OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";
import type {
  InventoryItem,
  PlacementRecord,
  PlacementSettlementReadiness,
} from "../../src/inventory/port.ts";
import type {
  CampaignMatchRunRecord,
  RunCampaignMatchInput,
} from "../../src/campaigns/port.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type { OutcomeObservation, MeasuredOutcome } from "../../src/outcomes/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import type { ApiExternalAdRequestEvaluationView } from "../../src/api/port.ts";

export { EVALUATED_AT, PUBLISHER_DOMAIN };

export interface NetW034Harness {
  /** The wrapped NET-W019 harness (all its factories work unchanged). */
  readonly w019: NetW019Harness;
  readonly runtime: NetW019Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The creator/contributor (also the supply owner — the seller side). */
  readonly creatorPersonId: string;
  /** The operator (the advertiser/campaign owner + match + clearing actor). */
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

export async function createNetW034Harness(): Promise<NetW034Harness> {
  // The REAL W022 provider-selection path: the OpenRTB delivery-notice
  // adapter wired through createRuntime with a TEST verification
  // secret (a test-only literal — NEVER a real credential).
  const noticeAdapter = new OpenRtbDeliveryNoticeAdapter({
    verificationSecret: OPENRTB_DELIVERY_TEST_SECRET,
  });
  // One runtime with the ENTIRE chain: the creators→contribution
  // machinery (W008→…→W019) + the seller-authorization trust channel
  // (W023) + the measurement provider registry (W022).
  const w019 = await createNetW019Harness({
    adapters: { sellerAuthorizationTrustKey: SELLER_AUTH_TRUST_TEST_SECRET },
    measurement: { providers: [noticeAdapter] },
  });
  const runtime = w019.runtime;
  const bootstrapCtx = w019.bootstrapCtx;

  // -- The W021 pattern: the campaign matching guard + the measured
  //    outcome guard actions + the per-transition policies scoped to
  //    the operator on the harness organization.
  await runtime.policyService.createPolicy(bootstrapCtx, {
    subject: "*",
    action: "campaigns.matching.run",
    resource: "*",
    effect: "allow",
    createdBy: "bootstrap",
  });
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
      subject: w019.operatorPersonId,
      action: rule.policyAction,
      resource: w019.organizationScopeId,
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

  // -- The W022/W023 pattern: the measurement report submission guard
  //    (the composed api command's transport guard).
  await runtime.policyService.createPolicy(bootstrapCtx, {
    subject: "*",
    action: "measurementReport.submit",
    resource: "*",
    effect: "allow",
    createdBy: "bootstrap",
  });

  // -- The W023 pattern: the external ad-request evaluation guard.
  await runtime.policyService.createPolicy(bootstrapCtx, {
    subject: "*",
    action: "adRequest.evaluate",
    resource: "*",
    effect: "allow",
    createdBy: "bootstrap",
  });

  const w012 = w019.w017.w016.w015.w013.w012;
  const w010 = w019.w017.w016.w015.w013.w012.w011.w010;

  return {
    w019,
    runtime,
    bootstrapCtx,
    creatorPersonId: w019.creatorPersonId,
    operatorPersonId: w019.operatorPersonId,
    challengerPersonId: w010.challengerPersonId,
    reviewerPersonId: w010.reviewerPersonId,
    organizationScopeId: w019.organizationScopeId,
    secondOrgId: w019.secondOrgId,
    secondOrgPersonId: w019.secondOrgPersonId,
    w012,
    w010,
    creatorCtx(correlationId: string) {
      return w019CreatorCtx(w019, correlationId);
    },
    operatorCtx(correlationId: string) {
      return w019OperatorCtx(w019, correlationId);
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
  return w019Key(prefix);
}

/** A person context for an arbitrary person id (cross-tenant proofs). */
export function personCtx(
  harness: NetW034Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return w019PersonCtx(harness.w019, personId, correlationId);
}

// ---------------------------------------------------------------------------
// Stage 1 — the advertising campaign factory (campaign/policy authority)
// ---------------------------------------------------------------------------

export interface CreateAdvertisingCampaignOptions {
  /**
   * The campaign eligibility rules the supply must satisfy (the
   * default matches the canonical scenario supply: US/CA + en).
   */
  readonly rules?: readonly {
    readonly attribute: string;
    readonly operator: string;
    readonly values: readonly string[];
  }[];
  /** Leave the campaign DRAFT (the not-ACTIVE fail-closed fixture). */
  readonly skipActivation?: boolean;
  /** An explicit different owner (defaults to the operator). */
  readonly ownerPersonId?: string;
}

/**
 * The ADVERTISING campaign: an ACTIVE campaign whose pinned policy
 * version 1 declares the objective, the outcome policy (one
 * deterministic `view` requirement — the exact requirement the
 * canonical delivery-notice measurement satisfies), the evidence
 * policy (a Proof-of-Value, ATTESTED minimum, platform sources), the
 * eligibility rules AND the clearing rule wired to a REAL same-scope
 * reward policy (the W020 cross-promotion factory pattern — the merge
 * of the W019 eligibility-declaring factory and the W011 clearing
 * factory). The budget escrow covers the clearing cap (the CAMP-002
 * validation).
 */
export async function createAdvertisingCampaign(
  harness: NetW034Harness,
  opts: CreateAdvertisingCampaignOptions = {},
): Promise<{ campaign: CampaignRecord; rewardPolicyId: string }> {
  const owner = opts.ownerPersonId ?? harness.operatorPersonId;
  const ctx = personCtx(harness, owner, "w034-campaign");
  // The REAL reward policy lineage the clearing rule draws through.
  const rewardPolicyId = key("w034-reward-policy");
  await harness.runtime.rewardPolicyService.createPolicyVersion(
    harness.bootstrapCtx,
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: rewardPolicyId,
      version: 1,
      description: "NET-W034 advertising clearing policy",
      allocations: [
        { beneficiaryPersonId: owner, weight: 1 },
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
      name: "W034 Advertising Campaign",
      description: "the canonical advertising lifecycle fixture campaign",
      idempotencyKey: key("w034-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "awareness",
          description: "canonical advertising delivery objective",
          successCriteria: null,
        },
      ],
      eligibility: {
        rules: [
          ...(opts.rules ?? [
            { attribute: "region", operator: "in", values: ["US", "CA", "GH"] },
            { attribute: "language", operator: "equals", values: ["en"] },
          ]).map((rule) => ({
            attribute: rule.attribute,
            operator: rule.operator,
            values: [...rule.values],
          })),
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
          title: "Advertising execution contribution",
          // The sanctioned contribution vehicle: the W012 helpfulness
          // composite accepts ONLY helpful_* opportunities — the
          // advertising execution contribution enters the lifecycle
          // through THIS campaign-materialized opportunity.
          opportunityType: "helpful_recommendation",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-advertising-outcome"],
        },
      ],
    },
    idempotencyKey: key("w034-policy"),
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
    idempotencyKey: key("w034-budget-stake"),
  });
  await harness.runtime.campaignService.recordBudgetCommitment(ctx, {
    campaignId: campaign.id,
    stakeId: staked.stake.id,
    idempotencyKey: key("w034-budget-record"),
  });
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w034-activate"),
    },
  );
  return { campaign: activated, rewardPolicyId };
}

// ---------------------------------------------------------------------------
// Stage 2 — supply/provenance (inventory registration + verification +
// the W023 OpenRTB supply-chain evaluation)
// ---------------------------------------------------------------------------

export interface RegisterSupplyOptions {
  /** Attach canonical supply-verification evidence (default TRUE). */
  readonly verified?: boolean;
  /** A different external id (the ambiguous/registration fixtures). */
  readonly externalId?: string;
  readonly actorPersonId?: string;
  readonly territories?: readonly string[];
  readonly languages?: readonly string[];
  readonly surfaceKind?: string;
  readonly format?: string;
  readonly idempotencyKey?: string;
}

/**
 * Register the scenario supply: a publisher-surface inventory item
 * bound to the OpenRTB provider identity (the W023
 * registerExternalSupply pattern) + the canonical supply-verification
 * evidence (the W019 INV-003 signal, attached through the inventory
 * authority).
 */
export async function registerScenarioSupply(
  harness: NetW034Harness,
  opts: RegisterSupplyOptions = {},
): Promise<InventoryItem> {
  const externalId = opts.externalId ?? PUBLISHER_DOMAIN;
  const item = await registerInventoryItem(harness.w019, {
    surfaceKind: opts.surfaceKind ?? "publisher",
    format: opts.format ?? "display",
    externalReference: {
      provider: SUPPLY_PROVIDER_ID,
      externalId,
      url: `https://${externalId}`,
    },
    ...(opts.actorPersonId !== undefined ? { actorPersonId: opts.actorPersonId } : {}),
    territories: opts.territories ?? ["US", "CA"],
    languages: opts.languages ?? ["en"],
    description: "W034 canonical scenario supply",
    idempotencyKey: opts.idempotencyKey ?? key("w034-item"),
  });
  if (opts.verified !== false) {
    const { evidenceId } = await createSupplyEvidence(harness.w019, item.id);
    await harness.runtime.inventoryService.attachSupplyVerification(
      personCtx(
        harness,
        opts.actorPersonId ?? harness.creatorPersonId,
        "w034-supply-verify",
      ),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        evidenceReference: evidenceId,
        idempotencyKey: key("w034-supply-verify"),
      },
    );
  }
  return item;
}

/**
 * Evaluate the canonical external ad request through the COMPOSED W023
 * api command: the raw OpenRTB bid request (with a COMPLETE two-hop
 * supply chain + sensitive vendor fields the redaction must drop) +
 * the SIGNED seller-authorization bundle → the normalized evaluation
 * with the supply-chain verification + the exact-one inventory
 * resolution (deterministic `evaluatedAt` anchor — never a wall
 * clock).
 */
export async function evaluateSupplyProvenance(
  harness: NetW034Harness,
  opts: {
    readonly request?: unknown;
    readonly sellerAuthorizations?: readonly unknown[];
    readonly evaluatedAt?: string;
    readonly organizationScopeId?: string;
    readonly actorPersonId?: string;
  } = {},
): Promise<ApiExternalAdRequestEvaluationView> {
  const ctx =
    opts.actorPersonId !== undefined
      ? personCtx(harness, opts.actorPersonId, "w034-evaluate")
      : harness.operatorCtx("w034-evaluate");
  return harness.runtime.apiCommands.evaluateExternalAdRequest(
    ctx,
    opts.actorPersonId ?? harness.operatorPersonId,
    {
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      providerId: SUPPLY_PROVIDER_ID,
      request: opts.request ?? rawBidRequest(),
      ...(opts.sellerAuthorizations !== undefined
        ? { sellerAuthorizations: opts.sellerAuthorizations as never }
        : { sellerAuthorizations: verifyingAuthorizations() as never }),
      ...(opts.evaluatedAt !== undefined
        ? { evaluatedAt: opts.evaluatedAt }
        : { evaluatedAt: EVALUATED_AT }),
    },
  );
}

// ---------------------------------------------------------------------------
// Stage 3 — the W021 campaign match (selection, never authority)
// ---------------------------------------------------------------------------

/** Run a campaign match through the wired service (the operator acts). */
export async function runScenarioMatch(
  harness: NetW034Harness,
  input: Partial<RunCampaignMatchInput> & {
    readonly campaignId: string;
    readonly idempotencyKey: string;
  },
): Promise<{ run: CampaignMatchRunRecord; created: boolean }> {
  const ctx = harness.operatorCtx("w034-run-match");
  return harness.runtime.campaignMatchingService.runCampaignMatch(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ...input,
  } as RunCampaignMatchInput);
}

// ---------------------------------------------------------------------------
// The canonical scenario — ONE advertising execution through the FULL
// frozen authoritative chain, with every durable identifier returned.
// ---------------------------------------------------------------------------

/**
 * One canonical-traversal stage witness. For stages from the
 * contribution entry onward: the AUTHORITATIVE contribution state +
 * version read through the owning boundary
 * (`contributionService.getContribution`) at the moment the named
 * scenario stage completed. The contribution version increments only
 * on /workflows lifecycle mutations (v0 DRAFT → v4 SUBMITTED → v5
 * MEASURING → v10 VERIFIED), so the witness array is a strictly
 * deterministic ordering proof: a stage witnessed at version N ran
 * after every lifecycle mutation below N and before every mutation
 * above it. Pre-contribution stages (campaign, supply, matching,
 * placement, opportunity) are witnessed by their own DURABLE
 * authority record ids (the stage's authoritative record).
 */
export interface AdvertisingTraversalWitness {
  /** The scenario stage that just completed. */
  readonly stage: string;
  /** The owning authority boundary the stage ran through. */
  readonly authority: string;
  /** The durable authoritative record id the stage produced/committed. */
  readonly recordId: string;
  /** The contribution's authoritative lifecycle state ("" pre-entry). */
  readonly contributionState: string;
  /** The contribution's authoritative version (-1 pre-entry). */
  readonly contributionVersion: number;
}

export interface AdvertisingScenario {
  // Stage 1 — campaign/policy
  readonly campaignId: string;
  readonly campaignRewardPolicyId: string;
  readonly campaignPolicyVersion: number;
  // Stage 2 — supply/provenance
  readonly inventoryItemId: string;
  readonly supplyVerificationEvidenceId: string | null;
  readonly provenanceEvaluation: ApiExternalAdRequestEvaluationView;
  // Stage 3 — W021 selection
  readonly matchRunId: string;
  readonly selectedItemId: string;
  readonly excludedItemId: string;
  // Stage 4 — placement
  readonly placementId: string;
  readonly readiness: PlacementSettlementReadiness;
  // Stage 5 — opportunity/contribution lifecycle entry
  readonly opportunityId: string;
  readonly contribution: Contribution;
  // Stage 7 — measurement (the W022 adapter path)
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
  // Stage 12 — settlement
  readonly value: EconomicValueRecord;
  readonly matureValue: EconomicValueRecord;
  readonly clearing: Record<string, unknown>;
  readonly allocationId: string;
  readonly clearingId: string;
  /** The idempotency key the scenario's clearing committed under. */
  readonly clearingIdempotencyKey: string;
  /**
   * The ordered canonical traversal witnesses — one per stage
   * boundary, in executable order (the W033 PR #68 remediation
   * discipline carried forward: the MEASURING lifecycle point is
   * witnessed BEFORE the measurement/outcomes/evidence stages — each
   * witnessed IN MEASURING at v5 — and the completed VERIFIED walk
   * BEFORE the economic stages; the pre-contribution advertising
   * stages carry their own durable authority record ids).
   */
  readonly traversal: readonly AdvertisingTraversalWitness[];
}

export interface RunAdvertisingScenarioOptions {
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
 * The canonical deterministic advertising scenario: ONE advertising
 * execution traversing every authority in the frozen order — the
 * campaign/policy first, supply/provenance second, the W021 hard-gated
 * selection third, the placement fourth, the opportunity/contribution
 * lifecycle entry fifth, the MEASURING point sixth, and ONLY THEN the
 * measurement (W022 adapter path), the outcomes, the evidence/PoV,
 * the PoH evaluation, the completed VERIFIED walk, the risk/dispute
 * gates (fail closed, then resolved) and the settlement (pending →
 * mature → the campaign's clearing rule). Every step runs through the
 * OWNING boundary (service or composition-root composite) — never a
 * direct repository write. Returns every durable identifier in the
 * lineage plus the ordered traversal witnesses (the executable-order
 * proof).
 */
export async function runAdvertisingScenario(
  harness: NetW034Harness,
  opts: RunAdvertisingScenarioOptions = {},
): Promise<AdvertisingScenario> {
  const runtime = harness.runtime;
  const ctx = harness.creatorCtx("w034-canonical");

  // -- Stage 1: the ADVERTISING campaign (ACTIVE, pinned policy v1,
  //    the objective + outcome/evidence policy + the clearing rule).
  const { campaign, rewardPolicyId } = await createAdvertisingCampaign(harness);

  // The canonical traversal witness array. Pre-contribution stages
  // are witnessed by their durable authority record ids; from the
  // contribution entry onward, by the AUTHORITATIVE contribution
  // state + version read through the owning boundary.
  const traversal: AdvertisingTraversalWitness[] = [];
  const witness = async (
    stage: string,
    authority: string,
    recordId: string,
    contributionId: string | null,
  ): Promise<void> => {
    if (contributionId === null) {
      traversal.push({
        stage,
        authority,
        recordId,
        contributionState: "",
        contributionVersion: -1,
      });
      return;
    }
    const current = await runtime.contributionService.getContribution(
      ctx,
      contributionId,
    );
    traversal.push({
      stage,
      authority,
      recordId,
      contributionState: current.state,
      contributionVersion: current.version,
    });
  };
  await witness(
    "campaign-policy-resolved",
    "/campaigns",
    campaign.id,
    null,
  ); // the ACTIVE campaign + pinned policy v1.

  // -- Stage 2: the supply — registration + canonical verification
  //    evidence (the W019 authority) + the W023 OpenRTB supply-chain
  //    evaluation (the normalized provenance fact resolving EXACTLY
  //    ONE inventory item; the external fact authorizes nothing —
  //    the REGISTERED record is the truth). The scenario uses a
  //    UNIQUE publisher domain (the scenario is re-runnable on one
  //    harness — a shared domain would resolve ambiguously on the
  //    second run).
  const domain = `${key("adv")}.example`;
  const item = await registerScenarioSupply(harness, {
    externalId: domain,
  });
  const scenarioRequest = rawBidRequest({
    set: {
      site: {
        domain,
        name: "W034 Scenario Publisher",
        publisher: { domain, name: "W034 Scenario Publisher" },
      },
    },
  });
  const scenarioAuthorizations = [
    signSellerAuthorization({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "ads.txt",
      content: publisherAdsTxtContent(),
      sourceIdentity: domain,
      observedAt: OBSERVED_AT,
    }),
    signSellerAuthorization({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "sellers.json",
      content: firstExchangeSellersJson(),
      sourceIdentity: FIRST_EXCHANGE,
      observedAt: OBSERVED_AT,
    }),
  ];
  const provenanceEvaluation = await evaluateSupplyProvenance(harness, {
    request: scenarioRequest,
    sellerAuthorizations: scenarioAuthorizations,
    evaluatedAt: EVALUATED_AT,
  });
  if (provenanceEvaluation.resolvedSupply?.itemId !== item.id) {
    throw new Error(
      `W034 canonical scenario failed: the supply-chain evaluation resolved ${String(
        provenanceEvaluation.resolvedSupply?.itemId,
      )}, expected the registered item ${item.id}`,
    );
  }
  // The attached verification evidence reference (read through the
  // inventory authority's tenant-scoped read — the authoritative
  // record, never the caller's assertion).
  const itemRead = await runtime.inventoryService.getInventoryItem(
    harness.operatorCtx("w034-item-read"),
    harness.organizationScopeId,
    item.id,
  );
  const supplyVerificationEvidenceId = itemRead.verificationEvidenceReference;
  await witness(
    "supply-provenance-resolved",
    "/inventory+/adapters",
    item.id,
    null,
  );

  // -- Stage 3: the W021 campaign match — the hard policy/supply/risk
  //    gates BEFORE ranking; the eligible candidate is selected and
  //    an UNVERIFIED candidate is hard-excluded.
  const excludedItem = await registerScenarioSupply(harness, {
    verified: false,
    externalId: `unverified-${key("ext")}`,
    idempotencyKey: key("w034-item-excluded"),
  });
  const match = await runScenarioMatch(harness, {
    campaignId: campaign.id,
    candidateInventoryItemIds: [item.id, excludedItem.id],
    idempotencyKey: key("w034-match"),
  });
  const selected = match.run.results.find(
    (r) => r.inventoryItemId === item.id,
  );
  if (!selected || selected.rank !== 1) {
    throw new Error(
      `W034 canonical scenario failed: the eligible supply was not selected (results: ${JSON.stringify(
        match.run.results.map((r) => [r.inventoryItemId, r.rank]),
      )})`,
    );
  }
  const excludedEntry = match.run.excluded.find(
    (e) => e.inventoryItemId === excludedItem.id,
  );
  if (!excludedEntry) {
    throw new Error(
      "W034 canonical scenario failed: the unverified candidate was not excluded",
    );
  }
  await witness(
    "matching-run-committed",
    "/campaigns",
    match.run.id,
    null,
  );
  await witness(
    "supply-selected-eligible",
    "/campaigns",
    selected.inventoryItemId,
    null,
  );

  // -- Stage 4: the placement — created through the W019 inventory
  //    authority for the selected supply/campaign pair with the
  //    PINNED policy version; the settlement readiness is ELIGIBLE.
  const placementCtx = harness.creatorCtx("w034-placement");
  const placementResult = await runtime.inventoryService.createPlacement(
    placementCtx,
    {
      organizationScopeId: harness.organizationScopeId,
      inventoryItemId: item.id,
      campaignId: campaign.id,
      campaignPolicyVersion: campaign.currentPolicyVersion ?? 1,
      context: {
        territories: ["US", "CA"],
        languages: ["en"],
      },
      idempotencyKey: key("w034-placement"),
    },
  );
  const readiness =
    await runtime.inventoryService.getPlacementSettlementReadiness(
      harness.operatorCtx("w034-readiness"),
      harness.organizationScopeId,
      placementResult.placement.id,
    );
  if (readiness.eligible !== true) {
    throw new Error(
      `W034 canonical scenario failed: placement readiness not eligible (${JSON.stringify(
        readiness.checks.filter((c) => !c.satisfied),
      )})`,
    );
  }
  await witness(
    "placement-committed",
    "/inventory",
    placementResult.placement.id,
    null,
  );

  // -- Stage 5: the campaign opportunity materialized through the
  //    W011 composition path (resolveOpportunityDraft →
  //    opportunityService.createOpportunity →
  //    recordOpportunityPublication), then the canonical contribution
  //    (the advertising execution subject) created + submitted
  //    through the SANCTIONED W012 helpfulness composite — the same
  //    path the apiCommand takes. CANONICAL ORDER: the publication
  //    walk runs BEFORE every downstream measurement/evidence stage.
  const operatorForCampaign = personCtx(
    harness,
    campaign.ownerPersonId,
    "w034-opportunity",
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
      idempotencyKey: key("w034-opportunity-record"),
    },
  );
  await witness(
    "opportunity-materialized",
    "/opportunities",
    opportunity.id,
    null,
  );

  const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012, {
    policyId: key("w034-helpfulness-policy"),
    // The advertising execution's measured outcome is a VIEW (the
    // campaign outcome policy's declared requirement — the delivery
    // notice reports views) — the PoH policy qualifies views.
    qualifyingOutcomeTypes: ["view"],
  });
  const { contribution } = await createHelpfulContribution(harness.w012, {
    opportunityId: opportunity.id,
    helpfulnessPolicyId: helpfulnessPolicy.policyId,
    // The claimant attributes satisfy the CAMPAIGN's eligibility
    // rules (region/language — the same rules the supply satisfies;
    // the first consumer of the W011 eligibility-policy reference).
    claimantAttributes: {
      participant_class: ["contributor"],
      region: ["US"],
      language: ["en"],
    },
    idempotencyKey: key("w034-contribution"),
  });
  await witness(
    "contribution-created",
    "/contributions",
    contribution.id,
    contribution.id,
  ); // DRAFT v0.

  await publishHelpfulContribution(harness.w012, contribution.id);
  await witness(
    "lifecycle-submitted",
    "/workflows",
    contribution.id,
    contribution.id,
  ); // SUBMITTED v4.

  // -- Stage 6: the lifecycle reaches the MEASUREMENT point through
  //    /workflows (SUBMITTED → MEASURING) — the intended lifecycle
  //    point at which the downstream measurement/outcomes/evidence
  //    stages execute (work order §3.6: MEASURING before
  //    measurement/evidence, proven with authoritative state/version
  //    witnesses — never merely local array order).
  await advanceToMeasuring(harness, contribution.id);
  await witness(
    "lifecycle-measuring",
    "/workflows",
    contribution.id,
    contribution.id,
  ); // MEASURING v5.

  // -- Stage 7: the measurement — ONE deterministic OpenRTB delivery
  //    notice routed through the REAL W022 provider-selection path
  //    (the delivery-notice adapter normalizes + integrity-verifies
  //    the raw vendor payload; the composed command persists the
  //    NEUTRAL observation in /outcomes). The raw payload stays
  //    opaque — only the neutral contract + redacted field NAMES
  //    cross the boundary. Executed while the contribution is IN
  //    MEASURING.
  const measurement = await submitAdvertisingMeasurement(
    harness,
    contribution.id,
  );
  await witness(
    "measurement-normalized",
    "/measurement→/outcomes",
    measurement.observation.id,
    contribution.id,
  ); // still MEASURING v5.

  // -- Stage 8: the outcomes — the VERIFIED normalized measured
  //    outcome over the provider observation (maturation window,
  //    rollup, finalize), attached as the PoH measured_outcome basis
  //    (the settlement attributed_outcome lineage). Executed while
  //    MEASURING.
  const measuredOutcome = await createVerifiedMeasuredOutcomeForSubject(
    harness,
    contribution.id,
    measurement.observation.id,
  );
  await witness(
    "outcome-verified",
    "/outcomes",
    measuredOutcome.id,
    contribution.id,
  ); // still MEASURING v5.

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
  await witness(
    "evidence-pov-verified",
    "/evidence",
    pov.proofOfValueId,
    contribution.id,
  ); // still MEASURING v5.

  // -- Stage 10: the PoH evaluation — the deterministic helpfulness
  //    gate re-resolves EVERY basis through its truth authority while
  //    the contribution is IN MEASURING.
  const poh = await runtime.helpfulnessService.evaluateHelpfulness(ctx, {
    contributionId: contribution.id,
    idempotencyKey: key("w034-poh-eval"),
  });
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `W034 canonical scenario failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  await witness(
    "poh-evaluated",
    "/workflows",
    contribution.id,
    contribution.id,
  ); // still MEASURING v5.

  // -- Stage 10b: the lifecycle walk COMPLETES through /workflows —
  //    the remaining forward transitions MEASURING → EVALUATING →
  //    CHALLENGE_WINDOW → SETTLING → SETTLED → VERIFIED, entered
  //    only after every measurement/outcome/evidence basis exists
  //    and the PoH is QUALIFIED (the MEASURING → EVALUATING edge
  //    requires the evidence reference).
  const verifiedContribution = await walkToVerified(
    harness,
    contribution.id,
  );
  await witness(
    "lifecycle-completed",
    "/workflows",
    contribution.id,
    contribution.id,
  ); // VERIFIED v10.

  // -- Stage 11: the risk/dispute gates — BEFORE economic
  //    maturation/consumption, exercise the EXISTING /disputes
  //    controls fail-closed (a HOLD risk control + an ACTIVE bonded
  //    dispute on the contribution — the upstream source), then
  //    resolve BOTH and prove the authoritative path re-opens.
  const recognized = await recognizeAdvertisingValue(
    harness,
    contribution.id,
    { amount: opts.amount ?? 100 },
  );
  await witness(
    "settlement-pending",
    "/settlement",
    recognized.value.id,
    contribution.id,
  ); // VERIFIED v10 (recognition).

  const riskControlId = await holdMaturationOn(harness, "contribution", contribution.id);
  let maturedFirst: EconomicValueRecord | null = null;
  try {
    maturedFirst = await matureAdvertisingValue(harness, recognized.value.id);
  } catch (error) {
    // The EXPECTED fail-closed refusal (RISK_CONTROL).
    const code = (error as { code?: string }).code;
    if (code !== "RISK_CONTROL") {
      throw error;
    }
  }
  if (maturedFirst !== null) {
    throw new Error(
      "W034 canonical scenario failed: the HOLD risk control did not refuse the maturation",
    );
  }
  await witness(
    "risk-gate-refused",
    "/disputes",
    riskControlId,
    contribution.id,
  ); // VERIFIED v10 — the value stays PENDING.

  await resolveHold(harness, riskControlId);
  await witness(
    "risk-gate-resolved",
    "/disputes",
    riskControlId,
    contribution.id,
  ); // VERIFIED v10.

  const disputeId = await openBondedDisputeOn(
    harness,
    "contribution",
    contribution.id,
  );
  let maturedSecond: EconomicValueRecord | null = null;
  try {
    maturedSecond = await matureAdvertisingValue(harness, recognized.value.id);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "DISPUTE_CHALLENGE") {
      throw error;
    }
  }
  if (maturedSecond !== null) {
    throw new Error(
      "W034 canonical scenario failed: the ACTIVE dispute did not refuse the maturation",
    );
  }
  await witness(
    "dispute-gate-refused",
    "/disputes",
    disputeId,
    contribution.id,
  ); // VERIFIED v10 — the value stays PENDING.

  await resolveDispute(harness, disputeId, contribution.id);
  await witness(
    "dispute-gate-resolved",
    "/disputes",
    disputeId,
    contribution.id,
  ); // VERIFIED v10.

  if (opts.skipSettlement === true) {
    return {
      campaignId: campaign.id,
      campaignRewardPolicyId: rewardPolicyId,
      campaignPolicyVersion: campaign.currentPolicyVersion ?? 1,
      inventoryItemId: item.id,
      supplyVerificationEvidenceId,
      provenanceEvaluation,
      matchRunId: match.run.id,
      selectedItemId: selected.inventoryItemId,
      excludedItemId: excludedItem.id,
      placementId: placementResult.placement.id,
      readiness,
      opportunityId: opportunity.id,
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
      clearing: {},
      allocationId: "",
      clearingId: "",
      clearingIdempotencyKey: "",
      traversal,
    };
  }

  // -- Stage 12: the settlement — the maturation composite (all gates
  //    now green) then the campaign's DECLARED clearing rule executed
  //    through the existing settlement composition (the
  //    reward_allocation draw through the REAL reward policy; the
  //    economic ledger, value records and postings remain
  //    settlement-owned).
  const matured = await matureAdvertisingValue(harness, recognized.value.id);
  await witness(
    "settlement-matured",
    "/settlement",
    matured.id,
    contribution.id,
  ); // VERIFIED v10 (maturation).

  const clearingIdempotencyKey = key("w034-clear");
  const clearing = await executeScenarioClearing(harness, {
    sourceContributionId: contribution.id,
    targetPlacementId: placementResult.placement.id,
    valueRecordId: matured.id,
    idempotencyKey: clearingIdempotencyKey,
  });
  const allocationId = String(
    (clearing as { allocation?: { id?: string } }).allocation?.id ?? "",
  );
  const clearingId = String(
    (clearing as { clearing?: { id?: string } }).clearing?.id ?? "",
  );
  await witness(
    "clearing-committed",
    "/settlement",
    clearingId,
    contribution.id,
  ); // VERIFIED v10 (the clearing draw).

  return {
    campaignId: campaign.id,
    campaignRewardPolicyId: rewardPolicyId,
    campaignPolicyVersion: campaign.currentPolicyVersion ?? 1,
    inventoryItemId: item.id,
    supplyVerificationEvidenceId,
    provenanceEvaluation,
    matchRunId: match.run.id,
    selectedItemId: selected.inventoryItemId,
    excludedItemId: excludedItem.id,
    placementId: placementResult.placement.id,
    readiness,
    opportunityId: opportunity.id,
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
    clearing,
    allocationId,
    clearingId,
    clearingIdempotencyKey,
    traversal,
  };
}

// ---------------------------------------------------------------------------
// Scenario building blocks (the W034 composition specifics)
// ---------------------------------------------------------------------------

/**
 * Submit ONE deterministic OpenRTB delivery notice through the
 * COMPOSED W022 measurement command (the REAL provider-selection
 * path: the delivery-notice adapter normalizes + verifies the raw
 * vendor payload, the composed command persists the neutral
 * observation in /outcomes). The observer is the acting operator.
 */
export async function submitAdvertisingMeasurement(
  harness: NetW034Harness,
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
      ? personCtx(harness, opts.actorPersonId, "w034-measure")
      : harness.operatorCtx("w034-measure");
  const result = await harness.runtime.apiCommands.submitMeasurementReport(
    ctx,
    opts.actorPersonId ?? harness.operatorPersonId,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectReference: {
        subjectId,
        subjectType: "contribution",
      },
      idempotencyKey: opts.idempotencyKey ?? key("w034-measure"),
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
 * factory does (the attributed_outcome clearing lineage).
 */
export async function createVerifiedMeasuredOutcomeForSubject(
  harness: NetW034Harness,
  subjectId: string,
  observationId: string,
): Promise<MeasuredOutcome> {
  const runtime = harness.runtime;
  const ctx = harness.creatorCtx("w034-measured-outcome");
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
    idempotencyKey: key("w034-mo-begin"),
    actorPersonId: harness.creatorPersonId,
  });
  await runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  const finalized = await runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: key("w034-mo-finalize"),
    actorPersonId: harness.creatorPersonId,
  });
  if (finalized.measurement.state !== "VERIFIED") {
    throw new Error(
      `W034 canonical scenario failed: measured outcome state ${finalized.measurement.state}`,
    );
  }
  await runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "measured_outcome",
    referenceId: finalized.measurement.id,
    idempotencyKey: key("w034-mo-basis"),
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
  harness: NetW034Harness,
  subjectId: string,
  measurementProviderId: string,
): Promise<{
  readonly proofOfValueId: string;
  readonly platformEvidenceId: string;
  readonly providerEvidenceId: string;
  readonly attestationId: string;
}> {
  const runtime = harness.runtime;
  const ctx = harness.creatorCtx("w034-pov");
  const ePlatform = await runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "platform",
      sourceId: "platform-w034",
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
    idempotencyKey: key("w034-pov-begin"),
    actorPersonId: harness.creatorPersonId,
  });
  const attestation = await runtime.attestationService.createAttestation(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.operatorPersonId,
      statement: "Independently reviewed the advertising delivery evidence.",
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
    idempotencyKey: key("w034-pov-evaluating"),
    actorPersonId: harness.creatorPersonId,
  });
  await runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await runtime.proofOfValueService.verify(ctx, {
    proofId: proof.id,
    expectedVersion: 2,
    idempotencyKey: key("w034-pov-verify"),
    actorPersonId: harness.creatorPersonId,
  });
  await runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "proof_of_value",
    referenceId: verified.proof.id,
    idempotencyKey: key("w034-pov-basis"),
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
  harness: NetW034Harness,
  subjectId: string,
): Promise<{ readonly evidenceId: string }> {
  const ctx = harness.creatorCtx("w034-evidence-basis");
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: "attested",
      sourceId: "src-w034",
      method: "community-attestation",
    },
    confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
    sensitivity: "standard",
    payload: { helpful: true, signals: ["advertising-delivery"] },
  });
  await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "evidence_record",
    referenceId: evidence.id,
    idempotencyKey: key("w034-basis"),
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
  harness: NetW034Harness,
  contributionId: string,
): Promise<Contribution> {
  const ctx = harness.creatorCtx("w034-advance-measuring");
  const current = await harness.runtime.contributionService.getContribution(
    ctx,
    contributionId,
  );
  if (current.state !== "SUBMITTED") {
    throw new Error(
      `W034 canonical scenario failed: expected SUBMITTED at the measurement-point advance, got ${current.state}`,
    );
  }
  await harness.runtime.workflowService.requestTransition(
    {
      subjectId: contributionId,
      subjectKind: "contribution",
      targetState: "MEASURING",
      expectedVersion: current.version,
      idempotencyKey: key("w034-t-measuring"),
      actorPersonId: harness.creatorPersonId,
      policyAction: policyActionFor("contribution", "SUBMITTED", "MEASURING"),
      metadata: { advertisingLifecycle: "net-w034" },
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
  harness: NetW034Harness,
  contributionId: string,
): Promise<Contribution> {
  const ctx = harness.creatorCtx("w034-verify-walk");
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
        idempotencyKey: key(`w034-t${String(step)}`),
        actorPersonId: harness.creatorPersonId,
        policyAction: policyActionFor(
          "contribution",
          from as "MEASURING",
          to as "VERIFIED",
        ),
        metadata: { advertisingLifecycle: "net-w034" },
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
 * maturation gate); pass "reward_allocation" for the clearing gate.
 */
export async function holdMaturationOn(
  harness: NetW034Harness,
  subjectType: "contribution" | "economic_value",
  subjectId: string,
  operationClass: "value_maturation" | "reward_allocation" = "value_maturation",
): Promise<string> {
  const w009 = harness.w019.w017.w016.w015.w013.w012.w011.w010.w009;
  const policy = await createDefaultRiskPolicy(w009, key("w034-risk-policy"));
  const ctx = harness.operatorCtx("w034-assessment");
  const assessment = await harness.runtime.riskAssessmentService.recordAssessment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.creatorPersonId,
      policyId: policy.policyId,
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: key("w034-assessment"),
    },
  );
  const { control } = await harness.runtime.riskControlService.activateControl(
    harness.operatorCtx("w034-control"),
    {
      organizationScopeId: harness.organizationScopeId,
      operationClass,
      action: "HOLD",
      subjectRef: { subjectType, subjectId },
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["collusion_pattern"],
      idempotencyKey: key("w034-control"),
    },
  );
  return control.id;
}

/** Resolve a HOLD risk control (the sanctioned /disputes resolution). */
export async function resolveHold(
  harness: NetW034Harness,
  controlDecisionId: string,
): Promise<void> {
  await harness.runtime.riskControlService.resolveControl(
    harness.operatorCtx("w034-resolve-control"),
    {
      controlDecisionId,
      note: "cleared after advertising-lifecycle review",
      idempotencyKey: key("w034-resolve-control"),
    },
  );
}

/**
 * Open + bond a dispute over the subject (the challenger holds
 * credits — the W010 pattern). Returns the dispute id.
 *
 * DETERMINISTIC FIXTURE (the PR #70 remediation — architect comment
 * #5511352937): the challenge anchor is the subject's OWN
 * authoritative anchor — `contribution.createdAt` /
 * `economic_value.recordedAt`, the EXACT fields the dispute
 * authority's subject lookup binds — read through the owning
 * boundary. The challenge-window check [anchorAt, anchorAt +
 * DISPUTE_CHALLENGE_WINDOW_MS] accepts the anchor itself by
 * construction, so the fixture carries NO wall-clock call
 * (the W034 deterministic-fixture contract: verification never
 * depends on `Date.now()`).
 */
export async function openBondedDisputeOn(
  harness: NetW034Harness,
  subjectType: "contribution" | "economic_value",
  subjectId: string,
): Promise<string> {
  await ensureCreditsFor(harness.w010, harness.challengerPersonId, 50);
  const ctx = harness.challengerCtx("w034-dispute");
  const subjectAnchorAt =
    subjectType === "contribution"
      ? (
          await harness.runtime.contributionService.getContribution(
            harness.operatorCtx("w034-dispute-anchor"),
            subjectId,
          )
        ).createdAt
      : (
          await harness.runtime.economicValueService.getValue(
            harness.operatorCtx("w034-dispute-anchor"),
            subjectId,
          )
        ).recordedAt;
  const opened = await harness.runtime.disputeService.openDispute(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectRef: { subjectType, subjectId },
    statement: "the challenged advertising delivery misstates verified value",
    reasonCodes: ["contested_verification"],
    supportingRefs: [{ kind: subjectType, id: subjectId }],
    effectiveAt: subjectAnchorAt,
    idempotencyKey: key("w034-dispute"),
  });
  const dispute = opened.dispute;
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: dispute.organizationScopeId,
    ownerPersonId: dispute.challengerPersonId,
    amount: dispute.stake.requirement.amount,
    purpose: { kind: "dispute_challenge", id: dispute.id },
    description: `challenge stake for dispute ${dispute.id}`,
    idempotencyKey: key("w034-dispute-stake"),
  });
  const bonded = await harness.runtime.disputeService.bondStake(ctx, {
    disputeId: dispute.id,
    stakeId: staked.stake.id,
    idempotencyKey: key("w034-dispute-bond"),
  });
  return bonded.id;
}

/**
 * Resolve the dispute through due process (review first — the
 * reviewer is NEVER the challenger — then a DISMISSED resolution
 * releasing the control).
 */
export async function resolveDispute(
  harness: NetW034Harness,
  disputeId: string,
  subjectId: string,
): Promise<void> {
  await harness.runtime.disputeService.startReview(
    harness.reviewerCtx("w034-review"),
    {
      disputeId,
      idempotencyKey: key("w034-review"),
    },
  );
  await harness.runtime.disputeService.resolveDispute(
    harness.reviewerCtx("w034-resolve-dispute"),
    {
      disputeId,
      outcome: "DISMISSED",
      controlDisposition: "RELEASE_CONTROL",
      reasonCodes: ["no_merit"],
      sourceRefs: [{ kind: "contribution", id: subjectId }],
      note: "no merit — the advertising delivery evidence verified",
      idempotencyKey: key("w034-resolve-dispute"),
    },
  );
}

// ---------------------------------------------------------------------------
// The settlement composites (the /settlement authority)
// ---------------------------------------------------------------------------

/** The recognition composite exactly as the apiCommand runs it. */
export async function recognizeAdvertisingValue(
  harness: NetW034Harness,
  contributionId: string,
  opts: { readonly amount?: number; readonly idempotencyKey?: string } = {},
): Promise<{ value: EconomicValueRecord; created: boolean }> {
  const ctx = harness.operatorCtx("w034-recognize");
  const result = await harness.runtime.apiCommands.recognizeContributionValue(
    ctx,
    harness.operatorPersonId,
    {
      contributionId,
      amount: opts.amount ?? 100,
      idempotencyKey: opts.idempotencyKey ?? key("w034-recognize"),
    },
  );
  return {
    value: result.value as unknown as EconomicValueRecord,
    created: result.created,
  };
}

/** The maturation composite (risk/dispute-gated) as the apiCommand runs it. */
export async function matureAdvertisingValue(
  harness: NetW034Harness,
  valueRecordId: string,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<EconomicValueRecord> {
  const ctx = harness.operatorCtx("w034-mature");
  return (await harness.runtime.apiCommands.matureEconomicValue(ctx, {
    valueRecordId,
    idempotencyKey: opts.idempotencyKey ?? key("w034-mature"),
  })) as unknown as EconomicValueRecord;
}

/** The derived clearing eligibility view exactly as the apiCommand runs it. */
export async function evaluateScenarioClearing(
  harness: NetW034Harness,
  input: {
    readonly sourceContributionId: string;
    readonly targetPlacementId: string;
    readonly valueRecordId: string;
  },
): Promise<{
  readonly eligible: boolean;
  readonly checks: readonly {
    readonly check: string;
    readonly satisfied: boolean;
    readonly reason: string;
    readonly detail: Record<string, unknown>;
  }[];
  readonly resolvedRule: {
    readonly id: string;
    readonly objectiveId: string;
    readonly basis: string;
    readonly drawKind: string;
    readonly rewardPolicyId: string | null;
    readonly maxDrawAmount: number;
  } | null;
}> {
  const view = await harness.runtime.apiCommands.evaluateCrossPromotionClearing(
    harness.operatorCtx("w034-eligibility"),
    {
      organizationScopeId: harness.organizationScopeId,
      ...input,
    },
  );
  return view as unknown as {
    readonly eligible: boolean;
    readonly checks: readonly {
      readonly check: string;
      readonly satisfied: boolean;
      readonly reason: string;
      readonly detail: Record<string, unknown>;
    }[];
    readonly resolvedRule: {
      readonly id: string;
      readonly objectiveId: string;
      readonly basis: string;
      readonly drawKind: string;
      readonly rewardPolicyId: string | null;
      readonly maxDrawAmount: number;
    } | null;
  };
}

/** The clearing composite exactly as the apiCommand runs it. */
export async function executeScenarioClearing(
  harness: NetW034Harness,
  input: {
    readonly sourceContributionId: string;
    readonly targetPlacementId: string;
    readonly valueRecordId: string;
    readonly idempotencyKey?: string;
  },
): Promise<Record<string, unknown>> {
  const ctx = harness.operatorCtx("w034-clear");
  return harness.runtime.apiCommands.executeCrossPromotionClearing(
    ctx,
    harness.operatorPersonId,
    {
      sourceContributionId: input.sourceContributionId,
      targetPlacementId: input.targetPlacementId,
      valueRecordId: input.valueRecordId,
      idempotencyKey: input.idempotencyKey ?? key("w034-clear"),
    },
  );
}

/** The placement record type (re-exported for the AC fixtures). */
export type { PlacementRecord };
