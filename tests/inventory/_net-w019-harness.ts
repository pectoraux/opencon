/**
 * NET-W019 shared test harness.
 *
 * Wraps the NET-W017 harness (runtime + persons + campaign service
 * access) and adds:
 *  - the NET-W019 guard actions (inventory item registration /
 *    retirement / supply-verification attachment + placement creation
 *    / retirement commands), seeded as ALLOW policies for the harness
 *    organization (the W004/W017/W018 harness pattern);
 *  - a campaign factory whose policy version DECLARES eligibility
 *    rules (region/language rules the placement eligibility engine
 *    evaluates);
 *  - the inventory-item factory (registered supply);
 *  - the placement factory (policy-scoped placement contexts);
 *  - the supply-verification evidence factory (canonical evidence
 *    records subject-bound to an inventory item through the canonical
 *    evidence service — the INV-003 ecosystem signal);
 *  - the golden-path placement helper (supply → campaign → placement
 *    → settlement readiness).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW017Harness,
  key as w017Key,
  creatorCtx as w017CreatorCtx,
  operatorCtx as w017OperatorCtx,
  personCtx as w017PersonCtx,
  type NetW008HarnessOptions,
  type NetW017Harness,
} from "../creators/_net-w017-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";
import type {
  InventoryItem,
  PlacementRecord,
  PlacementSettlementReadiness,
} from "../../src/inventory/port.ts";

export interface NetW019Harness {
  readonly w017: NetW017Harness;
  readonly runtime: NetW017Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  readonly creatorPersonId: string;
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "inventory.items.register",
  "inventory.items.retire",
  "inventory.items.attachSupplyVerification",
  "inventory.placements.create",
  "inventory.placements.retire",
];

export async function createNetW019Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW019Harness> {
  const w017 = await createNetW017Harness(opts);
  const runtime = w017.runtime;
  const bootstrapCtx = w017.bootstrapCtx;

  // The API guard actions for the composed inventory commands.
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
    w017,
    runtime,
    bootstrapCtx,
    creatorPersonId: w017.creatorPersonId,
    operatorPersonId: w017.operatorPersonId,
    organizationScopeId: w017.organizationScopeId,
    secondOrgId: w017.secondOrgId,
    secondOrgPersonId: w017.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A person's execution context. */
export function personCtx(
  harness: NetW019Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The creator's execution context (the default supply owner). */
export function creatorCtx(harness: NetW019Harness, correlationId: string) {
  return w017CreatorCtx(harness.w017, correlationId);
}

/** The operator's execution context (the campaign owner). */
export function operatorCtx(harness: NetW019Harness, correlationId: string) {
  return w017OperatorCtx(harness.w017, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return w017Key(prefix);
}

// ---------------------------------------------------------------------------
// The eligibility-declaring campaign factory
// ---------------------------------------------------------------------------

/**
 * A campaign + policy version whose DECLARED eligibility rules are the
 * given region/language rules (NET-W019 — the placement eligibility
 * engine's input). ACTIVATED in the harness organization (unless
 * `activate` is false — then it stays DRAFT); zero budget → no escrow
 * needed.
 */
export async function createCampaignWithEligibility(
  harness: NetW019Harness,
  opts: {
    readonly rules?: readonly {
      readonly attribute: string;
      readonly operator: string;
      readonly values: readonly string[];
    }[];
    readonly ownerPersonId?: string;
    readonly activate?: boolean;
  } = {},
): Promise<CampaignRecord> {
  const owner = opts.ownerPersonId ?? harness.operatorPersonId;
  const ctx = personCtx(harness, owner, "w019-campaign");
  const { campaign } = await harness.runtime.campaignService.createCampaign(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      name: "W019 Inventory Campaign",
      description: "inventory/placement fixture campaign",
      idempotencyKey: key("w019-campaign"),
    },
  );
  await harness.runtime.campaignService.defineCampaignPolicy(ctx, {
    campaignId: campaign.id,
    policy: {
      objectives: [
        {
          id: "obj-1",
          kind: "creator_content",
          description: "placement-scoped objective",
          successCriteria: null,
        },
      ],
      // THE NET-W019 INPUT: the declared eligibility rules the
      // placement eligibility engine evaluates.
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
          title: "Placement-scoped contribution opportunity",
          opportunityType: "campaign_contribution",
          brief: { campaignObjective: "obj-1", neutral: true },
          contributionRequirements: { deliverables: 1 },
          evidenceReferencePlaceholders: ["evidence-ugc-production"],
        },
      ],
    },
    idempotencyKey: key("w019-policy"),
  });
  if (opts.activate === false) {
    return campaign;
  }
  const activated = await harness.runtime.campaignService.activateCampaign(
    ctx,
    {
      campaignId: campaign.id,
      idempotencyKey: key("w019-activate"),
    },
  );
  return activated;
}

// ---------------------------------------------------------------------------
// The inventory-item factory (registered supply)
// ---------------------------------------------------------------------------

export interface InventoryItemOverrides {
  readonly actorPersonId?: string;
  readonly surfaceKind?: string;
  readonly format?: string;
  readonly externalReference?: Record<string, unknown> | null;
  readonly territories?: readonly string[];
  readonly languages?: readonly string[];
  readonly description?: string | null;
  readonly idempotencyKey?: string;
}

/** Register supply (the acting person becomes the registered owner). */
export async function registerInventoryItem(
  harness: NetW019Harness,
  opts: InventoryItemOverrides = {},
): Promise<InventoryItem> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.creatorPersonId,
    "w019-item",
  );
  const result = await harness.runtime.inventoryService.registerInventoryItem(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      surfaceKind: opts.surfaceKind ?? "publisher",
      format: opts.format ?? "display",
      externalReference:
        opts.externalReference === undefined
          ? {
              provider: "example-ad-network",
              externalId: "supply-ext-1",
              url: "https://example.com/supply-ext-1",
            }
          : (opts.externalReference as never),
      attributes: {
        territories: [...(opts.territories ?? ["US", "CA"])],
        languages: [...(opts.languages ?? ["en"])],
      },
      description: opts.description ?? "fixture supply",
      idempotencyKey: opts.idempotencyKey ?? key("w019-item"),
    },
  );
  return result.item;
}

// ---------------------------------------------------------------------------
// The supply-verification evidence factory (canonical, subject-bound)
// ---------------------------------------------------------------------------

/** Create a canonical evidence record bound to an INVENTORY ITEM subject. */
export async function createSupplyEvidence(
  harness: NetW019Harness,
  itemId: string,
  opts: {
    readonly subjectType?: string;
    readonly subjectId?: string;
    readonly organizationScopeId?: string;
    readonly ownerId?: string;
  } = {},
): Promise<{ evidenceId: string }> {
  const ctx = creatorCtx(harness, "w019-supply-evidence");
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId:
      opts.organizationScopeId ?? harness.organizationScopeId,
    ownerId: opts.ownerId ?? harness.creatorPersonId,
    subjectReference: {
      subjectType: opts.subjectType ?? "inventory_item",
      subjectId: opts.subjectId ?? itemId,
    },
    provenance: {
      sourceType: "platform",
      sourceId: "example-ad-network",
      method: "w019 fixture supply verification capture",
      collectedAt: new Date().toISOString(),
      collectorId: harness.creatorPersonId,
    },
    confidence: {
      point: 0.9,
      lower: 0.8,
      upper: 0.95,
    },
    sensitivity: "standard",
    payload: { kind: "supply_verification", inventoryItemId: itemId },
  });
  return { evidenceId: evidence.id };
}

// ---------------------------------------------------------------------------
// The placement factory (policy-scoped placement context)
// ---------------------------------------------------------------------------

export interface PlacementOverrides {
  readonly inventoryItemId?: string;
  readonly campaignId?: string;
  readonly campaignPolicyVersion?: number;
  readonly territories?: readonly string[];
  readonly languages?: readonly string[];
  readonly actorPersonId?: string;
  readonly eligibilityRules?: readonly {
    readonly attribute: string;
    readonly operator: string;
    readonly values: readonly string[];
  }[];
  readonly idempotencyKey?: string;
}

/**
 * Record a placement (a fresh item + campaign unless both given). The
 * acting person defaults to the item's registered owner.
 */
export async function createPlacement(
  harness: NetW019Harness,
  opts: PlacementOverrides = {},
): Promise<PlacementRecord> {
  const item =
    opts.inventoryItemId !== undefined
      ? null
      : await registerInventoryItem(harness, {
          territories: opts.territories ?? ["US", "CA"],
          languages: opts.languages ?? ["en"],
        });
  const campaignId =
    opts.campaignId ??
    (
      await createCampaignWithEligibility(harness, {
        rules: opts.eligibilityRules,
      })
    ).id;
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.creatorPersonId,
    "w019-placement",
  );
  const result = await harness.runtime.inventoryService.createPlacement(ctx, {
    organizationScopeId: harness.organizationScopeId,
    inventoryItemId: opts.inventoryItemId ?? item!.id,
    campaignId,
    ...(opts.campaignPolicyVersion !== undefined
      ? { campaignPolicyVersion: opts.campaignPolicyVersion }
      : {}),
    context: {
      territories: [...(opts.territories ?? ["US", "CA"])],
      languages: [...(opts.languages ?? ["en"])],
    },
    idempotencyKey: opts.idempotencyKey ?? key("w019-placement"),
  });
  return result.placement;
}

// ---------------------------------------------------------------------------
// The golden-path placement flow
// ---------------------------------------------------------------------------

export interface GoldenPathPlacement {
  readonly item: InventoryItem;
  readonly campaign: CampaignRecord;
  readonly placement: PlacementRecord;
  readonly readiness: PlacementSettlementReadiness;
  readonly evidenceId: string;
}

/**
 * The full golden path: registered supply → supply-verification
 * evidence (attached) → ACTIVE campaign with region/language rules
 * the supply satisfies → placement → settlement readiness ELIGIBLE.
 */
export async function goldenPathPlacement(
  harness: NetW019Harness,
  opts: {
    readonly rules?: readonly {
      readonly attribute: string;
      readonly operator: string;
      readonly values: readonly string[];
    }[];
  } = {},
): Promise<GoldenPathPlacement> {
  const item = await registerInventoryItem(harness, {
    territories: ["US", "CA"],
    languages: ["en"],
  });
  const { evidenceId } = await createSupplyEvidence(harness, item.id);
  await harness.runtime.inventoryService.attachSupplyVerification(
    personCtx(harness, harness.creatorPersonId, "w019-attach"),
    {
      organizationScopeId: harness.organizationScopeId,
      itemId: item.id,
      evidenceReference: evidenceId,
      idempotencyKey: key("w019-attach"),
    },
  );
  const campaign = await createCampaignWithEligibility(harness, {
    rules:
      opts.rules ??
      [
        { attribute: "region", operator: "in", values: ["US", "CA", "GH"] },
        { attribute: "language", operator: "equals", values: ["en"] },
      ],
  });
  const placement = await createPlacement(harness, {
    inventoryItemId: item.id,
    campaignId: campaign.id,
    territories: ["US", "CA"],
    languages: ["en"],
  });
  const readiness =
    await harness.runtime.inventoryService.getPlacementSettlementReadiness(
      personCtx(harness, harness.operatorPersonId, "w019-readiness"),
      harness.organizationScopeId,
      placement.id,
    );
  return { item, campaign, placement, readiness, evidenceId };
}

export { w017PersonCtx as personContext };
