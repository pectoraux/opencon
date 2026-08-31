/**
 * NET-W020 shared test harness.
 *
 * Wraps the NET-W019 harness (runtime + inventory/placement factories
 * + campaign service access) and adds:
 *  - the NET-W020 guard actions (the reward-integration composite
 *    actions, the W014 harness precedent);
 *  - the VERIFIED-settled-contribution factory (the W014 canonical
 *    fixture: a qualified helpful contribution driven through the
 *    /workflows canonical path to the terminal VERIFIED state);
 *  - the recognition/maturation composite helpers (exactly as the
 *    runtime apiCommands execute them — the W014 helpers);
 *  - the cross-promotion campaign factory (an ACTIVE campaign whose
 *    policy declares BOTH eligibility rules for the placement AND a
 *    clearing rule wired to a REAL reward policy — the merge of the
 *    W019 eligibility-declaring factory and the W011 clearing
 *    factory);
 *  - the golden-path cross-promotion world (verified contribution →
 *    mature value → campaign → settlement-ready placement → the
 *    full clearing tuple);
 *  - the clearing composite helper (exactly as the apiCommand runs
 *    it).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW019Harness,
  registerInventoryItem,
  createPlacement,
  goldenPathPlacement as w019GoldenPathPlacement,
  creatorCtx as w019CreatorCtx,
  operatorCtx as w019OperatorCtx,
  personCtx as w019PersonCtx,
  key as w019Key,
  type NetW019Harness,
} from "../inventory/_net-w019-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
  type NetW012Harness,
} from "../contributions/_net-w012-harness.ts";
import { ensureCreditsFor, type NetW010Harness } from "../disputes/_net-w010-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type {
  CampaignRecord,
  CampaignPolicySections,
} from "../../src/campaigns/port.ts";
import type {
  EconomicValueRecord,
} from "../../src/settlement/port.ts";
import type {
  InventoryItem,
  PlacementRecord,
  PlacementSettlementReadiness,
} from "../../src/inventory/port.ts";

export interface NetW020Harness {
  /** The wrapped NET-W019 harness (all its factories work unchanged). */
  readonly w019: NetW019Harness;
  readonly w012: NetW012Harness;
  readonly w010: NetW010Harness;
  readonly runtime: NetW019Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The creator/contributor (also the default supply owner). */
  readonly creatorPersonId: string;
  /** The operator (the campaign owner — a different person). */
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "reward.recognize",
  "reward.clear",
  "reward.reputation",
];

export async function createNetW020Harness(): Promise<NetW020Harness> {
  const w019 = await createNetW019Harness();
  const runtime = w019.runtime;
  const bootstrapCtx = w019.bootstrapCtx;

  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w019,
    w012: w019.w017.w016.w015.w013.w012,
    w010: w019.w017.w016.w015.w013.w012.w011.w010,
    runtime,
    bootstrapCtx,
    creatorPersonId: w019.creatorPersonId,
    operatorPersonId: w019.operatorPersonId,
    organizationScopeId: w019.organizationScopeId,
    secondOrgId: w019.secondOrgId,
    secondOrgPersonId: w019.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person's execution context. */
export function personCtx(
  harness: NetW020Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The creator/contributor's execution context. */
export function creatorCtx(harness: NetW020Harness, correlationId: string) {
  return w019CreatorCtx(harness.w019, correlationId);
}

/** The operator's execution context (the campaign owner). */
export function operatorCtx(harness: NetW020Harness, correlationId: string) {
  return w019OperatorCtx(harness.w019, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return w019Key(prefix);
}

export { registerInventoryItem, createPlacement };
export type { InventoryItem, PlacementRecord };

// ---------------------------------------------------------------------------
// The VERIFIED-settled-contribution factory (the W014 canonical fixture)
// ---------------------------------------------------------------------------

export interface CreateVerifiedSettledContributionOptions {
  readonly withMeasuredOutcomeBasis?: boolean;
  readonly withProofOfValueBasis?: boolean;
}

/**
 * A QUALIFIED helpful contribution driven through the /workflows
 * canonical path to the terminal VERIFIED lifecycle state (the W014
 * recognition composite's gate 1) — the cross-promotion SOURCE
 * CONTRIBUTION.
 */
export async function createVerifiedSettledContribution(
  harness: NetW020Harness,
  opts: CreateVerifiedSettledContributionOptions = {},
): Promise<{
  contribution: Contribution;
  measuredOutcomeId: string | null;
  proofOfValueId: string | null;
}> {
  const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012);
  const { contribution } = await createHelpfulContribution(harness.w012, {
    helpfulnessPolicyId: helpfulnessPolicy.policyId,
  });
  await attachEvidenceBasis(harness.w012, contribution.id);
  const measuredOutcomeId = opts.withMeasuredOutcomeBasis
    ? (await attachMeasuredOutcomeBasis(harness, contribution.id))
        .measuredOutcomeId
    : null;
  const proofOfValueId = opts.withProofOfValueBasis
    ? (await attachProofOfValueBasis(harness, contribution.id))
        .proofOfValueId
    : null;
  await publishHelpfulContribution(harness.w012, contribution.id);
  const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
    creatorCtx(harness, "w020-poh-eval"),
    { contributionId: contribution.id, idempotencyKey: key("w020-poh") },
  );
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `W020 harness fixture failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  // Drive the lifecycle to the terminal VERIFIED state through the
  // /workflows authority (the W008 harness seeded the per-person
  // transition policies for the contributor — the W019 chain's
  // creator IS that contributor).
  const ctx = creatorCtx(harness, "w020-verify-walk");
  const { policyActionFor } = await import("../../src/core/workflow.ts");
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
    contribution.id,
  );
  let step = 0;
  while (current.state !== "VERIFIED") {
    const from = current.state;
    const to = path[path.indexOf(from as (typeof path)[number]) + 1]!;
    step += 1;
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: contribution.id,
        subjectKind: "contribution",
        targetState: to,
        expectedVersion: current.version,
        idempotencyKey: key(`w020-t${String(step)}`),
        actorPersonId: harness.creatorPersonId,
        policyAction: policyActionFor(
          "contribution",
          from as "MEASURING",
          to as "VERIFIED",
        ),
        metadata: { crossPromotionClearing: "net-w020" },
      },
      ctx,
    );
    current = await harness.runtime.contributionService.getContribution(
      ctx,
      contribution.id,
    );
  }
  return { contribution: current, measuredOutcomeId, proofOfValueId };
}

/** A VERIFIED measured outcome attached as a PoH basis (the W014 fixture). */
export async function attachMeasuredOutcomeBasis(
  harness: NetW020Harness,
  contributionId: string,
): Promise<{ measuredOutcomeId: string }> {
  const ctx = creatorCtx(harness, "w020-measured-outcome");
  const observation =
    await harness.runtime.outcomeObservationService.createOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.creatorPersonId,
        subjectReference: {
          subjectId: contributionId,
          subjectType: "contribution",
        },
        outcomeType: "helpfulness",
        observedValue: { value: 1, unit: "helpful-resolutions" },
        confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
        provenance: {
          sourceType: "platform",
          sourceId: "platform-counter-w020",
          method: "platform-counter",
          methodVersion: "1.0.0",
        },
      },
    );
  const measurement =
    await harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: {
        subjectId: contributionId,
        subjectType: "contribution",
      },
      outcomeType: "helpfulness",
      maturation: { strategy: "immediate" },
      observationIds: [observation.id],
    });
  await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: 0,
    idempotencyKey: key("w020-mo-begin"),
    actorPersonId: harness.creatorPersonId,
  });
  await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  const finalized = await harness.runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: key("w020-mo-finalize"),
    actorPersonId: harness.creatorPersonId,
  });
  await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId,
    kind: "measured_outcome",
    referenceId: finalized.measurement.id,
    idempotencyKey: key("w020-mo-basis"),
  });
  return { measuredOutcomeId: finalized.measurement.id };
}

/** A VERIFIED Proof-of-Value attached as a PoH basis (the W014 fixture). */
export async function attachProofOfValueBasis(
  harness: NetW020Harness,
  contributionId: string,
): Promise<{ proofOfValueId: string }> {
  const ctx = creatorCtx(harness, "w020-pov");
  const eMeasured = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId: contributionId, subjectType: "contribution" },
    provenance: { sourceType: "platform", sourceId: "platform-w020", method: "platform-counter" },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const eProvider = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.creatorPersonId,
    subjectReference: { subjectId: contributionId, subjectType: "contribution" },
    provenance: { sourceType: "provider", sourceId: "provider-w020", method: "provider-report" },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const proof = await harness.runtime.proofOfValueService.createProofOfValue(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.creatorPersonId,
      subjectReference: { subjectId: contributionId, subjectType: "contribution" },
      evidenceIds: [eMeasured.id, eProvider.id],
    },
  );
  await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
    proofId: proof.id,
    expectedVersion: 0,
    idempotencyKey: key("w020-pov-begin"),
    actorPersonId: harness.creatorPersonId,
  });
  const attestation = await harness.runtime.attestationService.createAttestation(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.operatorPersonId,
      statement: "Independently reviewed the attached evidence.",
      evidenceIds: [eMeasured.id, eProvider.id],
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
    idempotencyKey: key("w020-pov-evaluating"),
    actorPersonId: harness.creatorPersonId,
  });
  await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await harness.runtime.proofOfValueService.verify(ctx, {
    proofId: proof.id,
    expectedVersion: 2,
    idempotencyKey: key("w020-pov-verify"),
    actorPersonId: harness.creatorPersonId,
  });
  await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId,
    kind: "proof_of_value",
    referenceId: verified.proof.id,
    idempotencyKey: key("w020-pov-basis"),
  });
  return { proofOfValueId: verified.proof.id };
}

// ---------------------------------------------------------------------------
// Recognition + maturation composite helpers (as the apiCommands run)
// ---------------------------------------------------------------------------

export interface RecognizeValueOptions {
  readonly amount?: number;
  readonly maturation?: { readonly strategy: string; readonly windowEndAt?: string };
  readonly description?: string;
  readonly idempotencyKey?: string;
  readonly actorPersonId?: string;
}

/** The recognition composite (AC-01) exactly as the apiCommand runs it. */
export async function recognizeContributionValue(
  harness: NetW020Harness,
  contributionId: string,
  opts: RecognizeValueOptions = {},
): Promise<{
  value: EconomicValueRecord;
  created: boolean;
  proofOfHelpfulnessId: string;
}> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.operatorPersonId,
    "w020-recognize",
  );
  const result = await harness.runtime.apiCommands.recognizeContributionValue(
    ctx,
    opts.actorPersonId ?? harness.operatorPersonId,
    {
      contributionId,
      amount: opts.amount ?? 100,
      ...(opts.maturation !== undefined ? { maturation: opts.maturation } : {}),
      ...(opts.description !== undefined
        ? { description: opts.description }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w020-recognize"),
    },
  );
  return {
    value: result.value as unknown as EconomicValueRecord,
    created: result.created,
    proofOfHelpfulnessId: result.proofOfHelpfulnessId,
  };
}

/** The matureEconomicValue apiCommand (gates included). */
export async function matureValue(
  harness: NetW020Harness,
  valueRecordId: string,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<EconomicValueRecord> {
  const ctx = operatorCtx(harness, "w020-mature");
  return (await harness.runtime.apiCommands.matureEconomicValue(ctx, {
    valueRecordId,
    idempotencyKey: opts.idempotencyKey ?? key("w020-mature"),
  })) as unknown as EconomicValueRecord;
}

/**
 * The full pipeline: verified contribution → PENDING → MATURE.
 */
export async function createRecognizedMatureValue(
  harness: NetW020Harness,
  opts: CreateVerifiedSettledContributionOptions &
    Pick<RecognizeValueOptions, "amount"> = {},
): Promise<{
  contribution: Contribution;
  measuredOutcomeId: string | null;
  proofOfValueId: string | null;
  value: EconomicValueRecord;
}> {
  const { contribution, measuredOutcomeId, proofOfValueId } =
    await createVerifiedSettledContribution(harness, opts);
  const recognized = await recognizeContributionValue(
    harness,
    contribution.id,
    { amount: opts.amount },
  );
  const matured = await matureValue(harness, recognized.value.id);
  return { contribution, measuredOutcomeId, proofOfValueId, value: matured };
}

// ---------------------------------------------------------------------------
// The cross-promotion campaign factory (eligibility + clearing rules)
// ---------------------------------------------------------------------------

export interface CreateCrossPromotionCampaignOptions {
  readonly rules?: readonly {
    readonly attribute: string;
    readonly operator: string;
    readonly values: readonly string[];
  }[];
  readonly clearingDrawKind?: "reward_allocation" | "credit_issuance" | "cash_obligation";
  readonly clearingBasis?: "attributed_outcome" | "verified_evidence" | "measured_value";
  readonly clearingMaxDrawAmount?: number;
  readonly ownerPersonId?: string;
  readonly activate?: boolean;
}

/**
 * An ACTIVE campaign whose policy declares BOTH the eligibility
 * rules (the placement eligibility engine's input) AND a clearing
 * rule wired to a REAL same-scope reward policy lineage (the
 * cross-promotion clearing policy). Zero budget → no escrow needed.
 */
export async function createCrossPromotionCampaign(
  harness: NetW020Harness,
  opts: CreateCrossPromotionCampaignOptions = {},
): Promise<CampaignRecord> {
  const owner = opts.ownerPersonId ?? harness.operatorPersonId;
  const ctx = personCtx(harness, owner, "w020-campaign");
  // The REAL reward policy lineage the default clearing rule draws
  // through (the W011 createRewardPolicy pattern).
  const rewardPolicyId = key("w020-reward-policy");
  await harness.runtime.rewardPolicyService.createPolicyVersion(
    harness.bootstrapCtx,
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: rewardPolicyId,
      version: 1,
      description: "test cross-promotion clearing policy",
      allocations: [
        { beneficiaryPersonId: owner, weight: 1 },
      ],
    },
  );
  const drawKind = opts.clearingDrawKind ?? "reward_allocation";
  const maxDrawAmount = opts.clearingMaxDrawAmount ?? 1000;
  const clearingRules: CampaignPolicySections["clearingRules"] = [
    {
      id: "clear-1",
      objectiveId: "obj-1",
      basis: opts.clearingBasis ?? "attributed_outcome",
      drawKind,
      rewardPolicyId: drawKind === "reward_allocation" ? rewardPolicyId : null,
      maxDrawAmount,
    },
  ];
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      name: "W020 Cross-Promotion Campaign",
      description: "cross-promotion clearing fixture campaign",
      idempotencyKey: key("w020-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "cross_promotion",
          description: "cross-promotion objective",
          successCriteria: null,
        },
      ],
      eligibility: {
        rules: [
          ...(opts.rules ?? []).map((rule) => ({
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
      // The budget MUST cover the clearing cap (the CAMP-002
      // validation: Σ clearing caps ≤ the declared total).
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
          title: "Cross-promotion contribution opportunity",
          opportunityType: "campaign_contribution",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-cross-promotion"],
        },
      ],
    },
    idempotencyKey: key("w020-policy"),
  });
  if (opts.activate === false) {
    return campaign;
  }
  // The budget escrow (the W011 activateReadyCampaign pattern): the
  // owner's credits are staked for the campaign budget, then the
  // commitment is recorded on the campaign record.
  await ensureCreditsFor(harness.w010, owner, maxDrawAmount);
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerPersonId: owner,
    amount: maxDrawAmount,
    purpose: { kind: "campaign_budget", id: campaign.id },
    description: `campaign budget escrow for campaign ${campaign.id}`,
    idempotencyKey: key("w020-budget-stake"),
  });
  await harness.runtime.campaignService.recordBudgetCommitment(ctx, {
    campaignId: campaign.id,
    stakeId: staked.stake.id,
    idempotencyKey: key("w020-budget-record"),
  });
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w020-activate"),
    },
  );
  return activated;
}

// ---------------------------------------------------------------------------
// The golden-path cross-promotion world
// ---------------------------------------------------------------------------

export interface CrossPromotionWorld {
  readonly contribution: Contribution;
  readonly measuredOutcomeId: string | null;
  readonly proofOfValueId: string | null;
  readonly value: EconomicValueRecord;
  readonly campaign: CampaignRecord;
  readonly item: InventoryItem;
  readonly placement: PlacementRecord;
  readonly readiness: PlacementSettlementReadiness;
}

/**
 * The full golden path: VERIFIED contribution (with a measured-outcome
 * basis) → recognized + MATURE value → an ACTIVE cross-promotion
 * campaign (eligibility rules the supply satisfies + the default
 * clearing rule) → registered supply → placement bound to THAT
 * campaign → settlement readiness ELIGIBLE.
 */
export async function createCrossPromotionWorld(
  harness: NetW020Harness,
  opts: {
    readonly amount?: number;
    readonly rules?: readonly {
      readonly attribute: string;
      readonly operator: string;
      readonly values: readonly string[];
    }[];
    readonly clearingDrawKind?: CreateCrossPromotionCampaignOptions["clearingDrawKind"];
    readonly clearingBasis?: CreateCrossPromotionCampaignOptions["clearingBasis"];
    readonly clearingMaxDrawAmount?: number;
  } = {},
): Promise<CrossPromotionWorld> {
  const { contribution, measuredOutcomeId, proofOfValueId, value } =
    await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: opts.amount ?? 100,
    });
  const campaign = await createCrossPromotionCampaign(harness, {
    rules:
      opts.rules ??
      [
        { attribute: "region", operator: "in", values: ["US", "CA", "GH"] },
        { attribute: "language", operator: "equals", values: ["en"] },
      ],
    ...(opts.clearingDrawKind !== undefined
      ? { clearingDrawKind: opts.clearingDrawKind }
      : {}),
    ...(opts.clearingBasis !== undefined
      ? { clearingBasis: opts.clearingBasis }
      : {}),
    ...(opts.clearingMaxDrawAmount !== undefined
      ? { clearingMaxDrawAmount: opts.clearingMaxDrawAmount }
      : {}),
  });
  const item = await registerInventoryItem(harness.w019, {
    territories: ["US", "CA"],
    languages: ["en"],
  });
  const placement = await createPlacement(harness.w019, {
    inventoryItemId: item.id,
    campaignId: campaign.id,
    territories: ["US", "CA"],
    languages: ["en"],
  });
  const readiness =
    await harness.runtime.inventoryService.getPlacementSettlementReadiness(
      operatorCtx(harness, "w020-readiness"),
      harness.organizationScopeId,
      placement.id,
    );
  return {
    contribution,
    measuredOutcomeId,
    proofOfValueId,
    value,
    campaign,
    item,
    placement,
    readiness,
  };
}

// ---------------------------------------------------------------------------
// The clearing composite helper (as the apiCommand runs it)
// ---------------------------------------------------------------------------

export interface ClearingOptions {
  readonly clearingRuleId?: string;
  readonly creditsPerValueUnit?: number;
  readonly cashKind?: string;
  readonly counterpartyPersonId?: string;
  readonly cashAmount?: number;
  readonly description?: string;
  readonly idempotencyKey?: string;
  readonly actorPersonId?: string;
}

/** The clearing composite (AC-01..07) exactly as the apiCommand runs it. */
export async function executeCrossPromotionClearing(
  harness: NetW020Harness,
  world: Pick<CrossPromotionWorld, "contribution" | "placement" | "value">,
  opts: ClearingOptions = {},
): Promise<Record<string, unknown>> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.operatorPersonId,
    "w020-clear",
  );
  return harness.runtime.apiCommands.executeCrossPromotionClearing(
    ctx,
    opts.actorPersonId ?? harness.operatorPersonId,
    {
      sourceContributionId: world.contribution.id,
      targetPlacementId: world.placement.id,
      valueRecordId: world.value.id,
      ...(opts.clearingRuleId !== undefined
        ? { clearingRuleId: opts.clearingRuleId }
        : {}),
      ...(opts.creditsPerValueUnit !== undefined
        ? { creditsPerValueUnit: opts.creditsPerValueUnit }
        : {}),
      ...(opts.cashKind !== undefined ? { cashKind: opts.cashKind } : {}),
      ...(opts.counterpartyPersonId !== undefined
        ? { counterpartyPersonId: opts.counterpartyPersonId }
        : {}),
      ...(opts.cashAmount !== undefined
        ? { cashAmount: opts.cashAmount }
        : {}),
      ...(opts.description !== undefined
        ? { description: opts.description }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w020-clear"),
    },
  );
}

/** The derived eligibility view exactly as the apiCommand runs it. */
export interface ClearingEligibilityView {
  readonly eligible: boolean;
  readonly checks: readonly {
    readonly check: string;
    readonly satisfied: boolean;
    readonly reason: string;
    readonly detail: Record<string, unknown>;
  }[];
  readonly resolvedRule: {
    readonly id: string;
    readonly basis: string;
    readonly drawKind: string;
    readonly maxDrawAmount: number;
  } | null;
}

export async function evaluateClearingEligibility(
  harness: NetW020Harness,
  world: Pick<CrossPromotionWorld, "contribution" | "placement" | "value">,
  opts: { readonly clearingRuleId?: string; readonly organizationScopeId?: string } = {},
): Promise<ClearingEligibilityView> {
  return harness.runtime.apiCommands.evaluateCrossPromotionClearing(
    operatorCtx(harness, "w020-eligibility"),
    {
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      sourceContributionId: world.contribution.id,
      targetPlacementId: world.placement.id,
      valueRecordId: world.value.id,
      ...(opts.clearingRuleId !== undefined
        ? { clearingRuleId: opts.clearingRuleId }
        : {}),
    },
  ) as unknown as Promise<ClearingEligibilityView>;
}

export { w019GoldenPathPlacement as goldenPathPlacement };
export { w019PersonCtx as personContext };
