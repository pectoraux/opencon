/**
 * NET-W021 shared test harness.
 *
 * Wraps the NET-W019 harness (runtime + persons + campaign factory
 * with eligibility rules + the inventory-item / supply-verification /
 * placement factories + the risk-control HOLD factory) and adds:
 *  - the campaign matching guard action (`campaigns.matching.run`);
 *  - the measured-outcome guard actions + the per-transition
 *    policies (OUTCOME_MEASUREMENT_TRANSITION_TABLE scoped to the
 *    harness operator + org) so item-subject measured outcomes can
 *    be driven DRAFT → MEASURING → rollup → VERIFIED;
 *  - a MATCH CAMPAIGN factory (ACTIVE, zero budget, configurable
 *    eligibility rules + outcome requirements);
 *  - a SUPPLY factory (registered inventory items with optional
 *    verification evidence, arbitrary owners/surfaces/formats);
 *  - an owner reputation-snapshot factory (per dimension);
 *  - a VERIFIED item-subject measured-outcome factory (the
 *    performance evidence);
 *  - the runCampaignMatch wrapper.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW019Harness,
  key as w019Key,
  personCtx as w019PersonCtx,
  createSupplyEvidence,
  type NetW019Harness,
} from "../inventory/_net-w019-harness.ts";
import { createQualifiedContribution } from "../contributions/_net-w013-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";
import type {
  InventoryItem,
  PlacementRecord,
} from "../../src/inventory/port.ts";
import type {
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";
import type { ReputationSnapshot } from "../../src/reputation/port.ts";
import type {
  CampaignMatchRunRecord,
  RunCampaignMatchInput,
} from "../../src/campaigns/port.ts";

export interface NetW021Harness {
  /** The wrapped NET-W019 harness (all its factories work unchanged). */
  readonly w019: NetW019Harness;
  readonly runtime: NetW019Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The harness creator person (the W013 contributor — can carry qualified-input reputation). */
  readonly creatorPersonId: string;
  /** The match operator person (drives matches + measured outcomes). */
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = ["campaigns.matching.run"];

const OUTCOME_GUARD_ACTIONS = [
  "outcomeObservation.create",
  "measuredOutcome.create",
  "measuredOutcome.attachObservation",
  "measuredOutcome.recordRollup",
];

export async function createNetW021Harness(): Promise<NetW021Harness> {
  const w019 = await createNetW019Harness();
  const runtime = w019.runtime;
  const bootstrapCtx = w019.bootstrapCtx;

  // The API guard action for the campaign match command.
  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }
  // The measured-outcome guard actions (subject "*") + the
  // per-transition policies scoped to the operator person on the
  // harness organization (the W006 harness pattern — every legal
  // measured-outcome transition's policyAction matches a policy).
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

  return {
    w019,
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
  harness: NetW021Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The match operator's execution context. */
export function operatorCtx(
  harness: NetW021Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.operatorPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { w019Key };

// ---------------------------------------------------------------------------
// The match-campaign factory (ACTIVE, zero budget, configurable rules)
// ---------------------------------------------------------------------------

export interface MatchCampaignOptions {
  /** Eligibility rules (region/language are supply-carried). */
  readonly rules?: readonly {
    readonly attribute: "participant_class" | "region" | "language" | "contribution_type" | "evidence_grade" | "measurement_kind";
    readonly operator: "equals" | "not_equals" | "in" | "not_in" | "gte" | "lte";
    readonly values: readonly string[];
  }[];
  /** The outcome requirements (performance evidence keys on these). */
  readonly outcomeRequirements?: readonly {
    readonly objectiveId: string;
    readonly outcomeType: string;
    readonly attributionMode: string;
    readonly windowDays: number;
    readonly requiresExperiment: boolean;
  }[];
  readonly ownerPersonId?: string;
  readonly organizationScopeId?: string;
  /** Leave the campaign DRAFT (the CAMP-002 fail-closed test). */
  readonly skipActivation?: boolean;
}

/**
 * An ACTIVE campaign (zero budget — no escrow needed) whose policy
 * version 1 carries the given eligibility rules + outcome
 * requirements. The default outcome requirement is one deterministic
 * `view` objective (the performance-evidence type).
 */
export async function createMatchCampaign(
  harness: NetW021Harness,
  opts: MatchCampaignOptions = {},
): Promise<CampaignRecord> {
  const ctx = personCtx(
    harness,
    opts.ownerPersonId ?? harness.operatorPersonId,
    "w021-campaign",
  );
  const organizationScopeId =
    opts.organizationScopeId ?? harness.organizationScopeId;
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId,
      name: "W021 Match Campaign",
      description: "campaign matching fixture",
      idempotencyKey: key("w021-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "awareness",
          description: "match fixture objective",
          successCriteria: null,
        },
      ],
      eligibility: {
        rules: (opts.rules ?? []).map((rule) => ({
          attribute: rule.attribute,
          operator: rule.operator,
          values: [...rule.values],
        })) as never,
      },
      outcomePolicy: {
        requirements: (
          opts.outcomeRequirements ?? [
            {
              objectiveId: "obj-1",
              outcomeType: "view",
              attributionMode: "deterministic",
              windowDays: 30,
              requiresExperiment: false,
            },
          ]
        ).map((r) => ({
          objectiveId: r.objectiveId,
          outcomeType: r.outcomeType,
          attributionMode: r.attributionMode,
          windowDays: r.windowDays,
          requiresExperiment: r.requiresExperiment,
        })) as never,
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
      budget: { unit: "credits", totalAmount: 0, perObjective: [] },
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
      clearingRules: [],
      opportunitySpecs: [
        {
          id: "spec-1",
          title: "Match fixture opportunity",
          opportunityType: "campaign_contribution",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-ugc-production"],
        },
      ],
    },
    idempotencyKey: key("w021-policy"),
  });
  if (opts.skipActivation) {
    return campaign;
  }
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w021-activate"),
    },
  );
  return activated;
}

// ---------------------------------------------------------------------------
// The supply factory (registered inventory items)
// ---------------------------------------------------------------------------

export interface SupplyItemOptions {
  /** The item's owner (the acting person becomes the registered owner). */
  readonly actorPersonId?: string;
  readonly surfaceKind?: string;
  readonly format?: string;
  readonly territories?: readonly string[];
  readonly languages?: readonly string[];
  /** Attach canonical supply-verification evidence (default TRUE). */
  readonly verified?: boolean;
}

/**
 * Register supply (the acting person becomes the registered owner)
 * and attach the supply-verification evidence by default (the W019
 * INV-003 signal — the settlement-readiness supply_available
 * component).
 */
export async function registerSupplyItem(
  harness: NetW021Harness,
  opts: SupplyItemOptions = {},
): Promise<InventoryItem> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.creatorPersonId,
    "w021-supply",
  );
  const result = await harness.runtime.inventoryService.registerInventoryItem(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      surfaceKind: opts.surfaceKind ?? "publisher",
      format: opts.format ?? "display",
      externalReference: {
        provider: "example-ad-network",
        externalId: `supply-${key("ext")}`,
        url: null,
      },
      attributes: {
        territories: [...(opts.territories ?? ["US", "CA"])],
        languages: [...(opts.languages ?? ["en"])],
      },
      description: "W021 fixture supply",
      idempotencyKey: key("w021-item"),
    },
  );
  const item = result.item;
  if (opts.verified !== false) {
    const { evidenceId } = await createSupplyEvidence(harness.w019, item.id);
    await harness.runtime.inventoryService.attachSupplyVerification(
      personCtx(harness, opts.actorPersonId ?? harness.creatorPersonId, "w021-verify"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        evidenceReference: evidenceId,
        idempotencyKey: key("w021-attach"),
      },
    );
  }
  return item;
}

// ---------------------------------------------------------------------------
// The owner reputation-snapshot factory
// ---------------------------------------------------------------------------

const W021_SCORING_RULES = [
  "helpfulness",
  "content_quality",
  "creator_performance",
  "inventory_quality",
  "measurement_reliability",
  "commerce_reliability",
  "fraud_resistance",
  "fulfillment_reliability",
].map((dimension) => ({
  dimension,
  inputWeight: 1,
  decayHalfLifeDays: 90,
  maxScore: 100,
  indicatedWeightFactor: 0.25,
  indicatedOnlyCap: 10,
}));

/**
 * Record a canonical /reputation snapshot for an owner person in the
 * given dimension. With `qualifiedInput: true` the input is sourced
 * from a QUALIFIED helpful contribution by the HARNESS CREATOR
 * person (the only person the qualified-contribution factory can
 * attribute) — for any other subject the snapshot carries an empty
 * input set (a canonical, digest-carrying record with a
 * deterministic zero score).
 */
export async function createOwnerReputationSnapshot(
  harness: NetW021Harness,
  opts: {
    readonly subjectPersonId: string;
    readonly dimension: string;
    readonly qualifiedInput?: boolean;
  },
): Promise<ReputationSnapshot> {
  const ctx = personCtx(
    harness,
    harness.operatorPersonId,
    "w021-reputation",
  );
  const policyId = `policy-w021-${key("rep")}`;
  await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId,
    version: 1,
    rules: W021_SCORING_RULES,
  });
  if (opts.qualifiedInput === true) {
    // The qualified contribution (the W013 harness factory — the
    // creator person's verified helpful contribution).
    const { contribution } = await createQualifiedContributionForReputation(
      harness,
    );
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: opts.subjectPersonId,
      dimension: opts.dimension,
      sources: [{ kind: "contribution", id: contribution.id }],
      description: "W021 qualified fixture input",
      occurredAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: key("w021-rep-input"),
    });
  }
  const result = await harness.runtime.reputationSnapshotService.recordSnapshot(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: opts.subjectPersonId,
      policyId,
      referenceAt: "2026-01-02T00:00:00.000Z",
      idempotencyKey: key("w021-rep-snapshot"),
    },
  );
  return result.snapshot;
}

/**
 * The qualified-contribution source (the W013 factory through the
 * wrapped W019 → W017 → W016 → W015 chain).
 */
function createQualifiedContributionForReputation(
  harness: NetW021Harness,
): Promise<{ readonly contribution: { readonly id: string } }> {
  const w013 = harness.w019.w017.w016.w015.w013;
  return createQualifiedContribution(w013);
}

// ---------------------------------------------------------------------------
// The verified item-subject measured-outcome factory
// ---------------------------------------------------------------------------

export interface ItemOutcomeOptions {
  readonly outcomeType?: string;
  readonly value?: number;
  readonly unit?: string;
  readonly point?: number;
  /** Leave the measurement MEASURING (not yet evidence). */
  readonly leaveMeasuring?: boolean;
  /** Create the observation but NOT the measurement (raw evidence). */
  readonly observationOnly?: boolean;
}

/**
 * The performance-evidence factory: an item-subject measured outcome
 * driven DRAFT → MEASURING → (deterministic rollup) → VERIFIED (the
 * canonical /outcomes lifecycle). Returns the observation and (when
 * driven) the VERIFIED measurement.
 */
export async function createVerifiedItemOutcome(
  harness: NetW021Harness,
  itemId: string,
  opts: ItemOutcomeOptions = {},
): Promise<{
  readonly observation: OutcomeObservation;
  readonly measurement: MeasuredOutcome | null;
}> {
  const ctx = operatorCtx(harness, "w021-outcome");
  const observation =
    await harness.runtime.outcomeObservationService.createOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.operatorPersonId,
        subjectReference: { subjectId: itemId, subjectType: "inventory_item" },
        outcomeType: (opts.outcomeType ?? "view") as "view",
        observedValue: {
          value: opts.value ?? 10_000,
          unit: opts.unit ?? "views",
        },
        confidence: { point: opts.point ?? 0.95 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "1.0.0",
        },
      },
    );
  if (opts.observationOnly) {
    return { observation, measurement: null };
  }
  const measurement = await harness.runtime.measuredOutcomeService
    .createMeasuredOutcome(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.operatorPersonId,
      subjectReference: { subjectId: itemId, subjectType: "inventory_item" },
      outcomeType: (opts.outcomeType ?? "view") as "view",
      maturation: { strategy: "immediate" },
      observationIds: [observation.id],
    });
  await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: measurement.version,
    idempotencyKey: key("w021-begin"),
    actorPersonId: harness.operatorPersonId,
  });
  await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  if (opts.leaveMeasuring) {
    return { observation, measurement };
  }
  const finalized = await harness.runtime.measuredOutcomeService.finalize(
    ctx,
    {
      measurementId: measurement.id,
      expectedVersion: 1,
      idempotencyKey: key("w021-finalize"),
      actorPersonId: harness.operatorPersonId,
    },
  );
  return { observation, measurement: finalized.measurement };
}

// ---------------------------------------------------------------------------
// The placement factory (for the alreadyPlaced flag)
// ---------------------------------------------------------------------------

/** Place supply on a campaign (the item's owner acts). */
export async function placeSupplyOnCampaign(
  harness: NetW021Harness,
  itemId: string,
  campaignId: string,
  opts: { readonly ownerPersonId?: string } = {},
): Promise<PlacementRecord> {
  const ctx = personCtx(
    harness,
    opts.ownerPersonId ?? harness.creatorPersonId,
    "w021-placement",
  );
  const result = await harness.runtime.inventoryService.createPlacement(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      inventoryItemId: itemId,
      campaignId,
      context: {
        territories: ["US", "CA"],
        languages: ["en"],
      },
      idempotencyKey: key("w021-placement"),
    },
  );
  return result.placement;
}

// ---------------------------------------------------------------------------
// The runCampaignMatch wrapper
// ---------------------------------------------------------------------------

/** Run a campaign match through the wired service (the operator acts). */
export async function runCampaignMatch(
  harness: NetW021Harness,
  input: Partial<RunCampaignMatchInput> & { readonly idempotencyKey: string },
): Promise<{ run: CampaignMatchRunRecord; created: boolean }> {
  const ctx =
    (input as { readonly _ctx?: ExecutionContext })._ctx ??
    operatorCtx(harness, "w021-run-match");
  return harness.runtime.campaignMatchingService.runCampaignMatch(ctx, {
    organizationScopeId: harness.organizationScopeId,
    campaignId: input.campaignId!,
    ...input,
  } as RunCampaignMatchInput);
}

/** The permissive baseline targeting (no hard constraints). */
export function baselineTargeting(): RunCampaignMatchInput["targeting"] {
  return {
    requiredFormats: [],
    requiredSurfaceKinds: [],
    targetTerritories: [],
    requiredLanguages: [],
  };
}
