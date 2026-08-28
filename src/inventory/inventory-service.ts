/**
 * The NET-W019 inventory domain service — supply registration,
 * placement context, supply authorization and the derived settlement
 * readiness.
 *
 * Work order ref: spec/work-orders/NET-W019.md.
 *
 * AUTHORITY MODEL (work order §2 — the decision of record):
 *  - /campaigns is the campaign policy authority: the placement's
 *    policy scope (campaign existence + tenant scope + administrative
 *    status + the pinned-or-latest version's ELIGIBILITY RULES)
 *    arrives READ-ONLY through the neutral
 *    {@link InventoryCampaignLookup} (the dependency-inversion
 *    precedent). This service EVALUATES the rules against declared
 *    supply attributes (the pure engine) — it never re-declares
 *    policy and never duplicates the campaign authority.
 *  - /workflows is the SOLE lifecycle authority and is UNTOUCHED:
 *    inventory items and placements carry NO lifecycle subject kind
 *    and NO transition machinery. Supply withdrawal and placement
 *    retirement are ONE-WAY field mutations (the NET-W018 commercial-
 *    relationship termination precedent).
 *  - /evidence is the truth authority: the supply-verification
 *    reference is validated through the neutral evidence lookup
 *    (existence + tenant scope + EXACT subject binding to this item).
 *    This boundary never fabricates supply proof.
 *  - /settlement is the economic authority: this service has NO
 *    economic surface (no balances, no postings, no reward/credit/
 *    cash commands). The settlement gate is the DERIVED
 *    {@link InventoryService.getPlacementSettlementReadiness} view —
 *    the validated source context a settlement-affecting consumer
 *    must require (INV-004); there is NO command that asserts, stores
 *    or waives readiness.
 *  - NO AI path exists anywhere in this service (work order §2).
 *
 * SUPPLY AUTHORIZATION (invariant 3 — server-enforced): the
 * registered owner IS the acting person at registration (there is no
 * ownerPersonId input on any command); placement creation, supply
 * withdrawal, verification attachment and placement retirement are
 * OWNER-ONLY, checked against the DURABLE item record — caller claims
 * cannot fabricate supply ownership, placement eligibility or
 * campaign scope.
 *
 * Every material mutation flows through
 * IdempotencyStore.applyIdempotent (exactly-once-per-key; the
 * mutation + the idempotency record + the transactional audit event
 * commit in ONE authoritative transaction).
 *
 * TENANT ISOLATION: every ID-based read resolves records WITHIN an
 * organization scope — a cross-scope id is indistinguishable from a
 * nonexistent one (NotFoundError, no existence oracle).
 *
 * Tier compliance: inventory domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { AuthorizationError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import {
  INVENTORY_EXTERNAL_ID_MAX_CHARS,
  INVENTORY_EXTERNAL_PROVIDER_MAX_CHARS,
  INVENTORY_EXTERNAL_URL_MAX_CHARS,
  INVENTORY_ITEM_FORMAT,
  INVENTORY_MAX_PROSE_CHARS,
  INVENTORY_FORMATS,
  INVENTORY_SURFACE_KINDS,
  InvalidInventoryError,
  PLACEMENT_RECORD_FORMAT,
  PlacementConflictError,
  assertPlacementContextWithinSupply,
  isInventoryFormat,
  isInventorySurfaceKind,
  validateInventoryLanguages,
  validateInventoryTerritories,
} from "../core/inventory.ts";
import type {
  AttachSupplyVerificationInput,
  CreatePlacementInput,
  CreatePlacementResult,
  InventoryExternalReference,
  InventoryItem,
  InventoryItemRepository,
  InventoryLookups,
  InventoryService,
  InventoryServiceDeps,
  PlacementEligibilityEvaluation,
  PlacementRecord,
  PlacementRepository,
  PlacementSettlementCheck,
  PlacementSettlementReadiness,
  PlacementSourceContext,
  RegisterInventoryItemInput,
  RegisterInventoryItemResult,
  ResolvedCampaignPolicyScope,
  RetireInventoryItemInput,
  RetirePlacementInput,
} from "./port.ts";
import { evaluatePlacementEligibility } from "./eligibility-engine.ts";

const INVENTORY_ITEM_REGISTERED = "inventory_item.registered" as const;
const INVENTORY_ITEM_RETIRED = "inventory_item.retired" as const;
const SUPPLY_VERIFICATION_ATTACHED =
  "inventory_item.supply_verification_attached" as const;
const PLACEMENT_RECORDED = "placement.recorded" as const;
const PLACEMENT_RETIRED = "placement.retired" as const;

/** The canonical subject type evidence records bind supply proof to. */
export const INVENTORY_ITEM_SUBJECT_TYPE = "inventory_item" as const;

/** The campaign administrative statuses that allow settlement scope. */
const CAMPAIGN_PUBLISHABLE_STATUSES: readonly string[] = ["ACTIVE"];

function inventoryError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new InvalidInventoryError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw inventoryError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

function assertOrganizationScopeId(organizationScopeId: string): string {
  if (typeof organizationScopeId !== "string" || !organizationScopeId.trim()) {
    throw inventoryError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

/** The acting person's id (recorded as createdBy on every record). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "inventory commands require an authenticated person actor",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Validate + normalize the provider-neutral external reference (AC-05). */
function buildExternalReference(raw: {
  readonly provider?: string | null;
  readonly externalId?: string | null;
  readonly url?: string | null;
} | null | undefined): InventoryExternalReference | null {
  if (raw === null || raw === undefined) return null;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const externalId =
    typeof raw.externalId === "string" ? raw.externalId.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() || null : null;
  if (!provider || provider.length > INVENTORY_EXTERNAL_PROVIDER_MAX_CHARS) {
    throw inventoryError(
      `externalReference.provider must be a non-empty string of at most ${String(INVENTORY_EXTERNAL_PROVIDER_MAX_CHARS)} characters`,
      { field: "externalReference.provider" },
    );
  }
  if (!externalId || externalId.length > INVENTORY_EXTERNAL_ID_MAX_CHARS) {
    throw inventoryError(
      `externalReference.externalId must be a non-empty string of at most ${String(INVENTORY_EXTERNAL_ID_MAX_CHARS)} characters`,
      { field: "externalReference.externalId" },
    );
  }
  if (url !== null && url.length > INVENTORY_EXTERNAL_URL_MAX_CHARS) {
    throw inventoryError(
      `externalReference.url must be at most ${String(INVENTORY_EXTERNAL_URL_MAX_CHARS)} characters`,
      { field: "externalReference.url" },
    );
  }
  return Object.freeze({ provider, externalId, url });
}

/** Validate the declared supply attributes (non-empty canonical sets). */
function validateSupplyAttributes(field: string, raw: {
  readonly territories?: readonly string[];
  readonly languages?: readonly string[];
}): {
  readonly territories: readonly string[];
  readonly languages: readonly string[];
} {
  if (!raw || typeof raw !== "object") {
    throw inventoryError(`${field} is required`, { field });
  }
  const territories = validateInventoryTerritories(
    `${field}.territories`,
    raw.territories ?? [],
  );
  const languages = validateInventoryLanguages(
    `${field}.languages`,
    raw.languages ?? [],
  );
  return Object.freeze({ territories, languages });
}

function validateOptionalProse(
  field: string,
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  const prose = String(value);
  if (prose.length > INVENTORY_MAX_PROSE_CHARS) {
    throw inventoryError(
      `${field} must be at most ${String(INVENTORY_MAX_PROSE_CHARS)} characters`,
      { field },
    );
  }
  return prose;
}

/** The publishable-scope check (the live campaign status). */
function isPublishableCampaignStatus(status: string): boolean {
  return CAMPAIGN_PUBLISHABLE_STATUSES.includes(status);
}

export function createInventoryService(
  deps: InventoryServiceDeps,
): InventoryService {
  const {
    itemRepository,
    placementRepository,
    lookups,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function requireItem(
    organizationScopeId: string,
    id: string,
  ): Promise<InventoryItem> {
    const item = await itemRepository.findById(id);
    if (!item || item.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`inventory item not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return item;
  }

  async function requireItemWithinTx(
    organizationScopeId: string,
    id: string,
    tx: AuthorityTransaction,
  ): Promise<InventoryItem> {
    const item = await itemRepository.getByIdWithinTx(id, tx);
    if (!item || item.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`inventory item not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return item;
  }

  async function requirePlacement(
    organizationScopeId: string,
    id: string,
  ): Promise<PlacementRecord> {
    const placement = await placementRepository.findById(id);
    if (!placement || placement.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`placement not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return placement;
  }

  async function appendAudit(
    tx: AuthorityTransaction,
    event: {
      eventType: string;
      context: ExecutionContext;
      actor: string;
      subject: string;
      resourceType: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const buffer = auditWriter.forTransaction(tx);
    await buffer.append({
      eventType: event.eventType,
      context: event.context,
      actor: event.actor,
      subject: event.subject,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: event.metadata,
    });
  }

  /**
   * Owner-only authorization against the DURABLE item record (the
   * server-side supply-ownership check — invariant 3). The acting
   * person must be the item's registered owner.
   */
  function requireOwner(actor: string, item: InventoryItem): void {
    if (actor !== item.ownerPersonId) {
      throw new AuthorizationError(
        "only the inventory item's registered owner may perform this action",
        {
          actorPersonId: actor,
          ownerPersonId: item.ownerPersonId,
          inventoryItemId: item.id,
        },
      );
    }
  }

  /**
   * Resolve the campaign policy scope (existence + tenant scope +
   * pinned-or-latest version + the version's eligibility rules)
   * through the NEUTRAL lookup — the campaign-policy authority
   * dependency inversion. A campaign that resolves cross-scope or not
   * at all is indistinguishable from a nonexistent one (no existence
   * oracle; a caller cannot fabricate campaign scope).
   */
  async function resolvePolicyScope(
    organizationScopeId: string,
    campaignId: string,
    policyVersion: number | undefined,
  ): Promise<ResolvedCampaignPolicyScope> {
    const resolved = await lookups.campaign.resolvePolicy(
      campaignId,
      policyVersion,
    );
    if (!resolved || resolved.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(
        `campaign policy scope not found for campaign ${campaignId}`,
        { campaignId, organizationScopeId },
      );
    }
    return resolved;
  }

  /**
   * Validate the supply-verification evidence reference against the
   * canonical /evidence authority: existence + tenant scope + EXACT
   * subject binding to THIS item (subjectType "inventory_item",
   * subjectId == itemId) — the INV-003 ecosystem provenance signal;
   * supply proof cannot be fabricated in this boundary.
   */
  async function validateVerificationEvidence(
    organizationScopeId: string,
    itemId: string,
    evidenceReference: string,
  ): Promise<string> {
    if (typeof evidenceReference !== "string" || !evidenceReference.trim()) {
      throw inventoryError("evidenceReference must be a non-empty string", {
        field: "evidenceReference",
      });
    }
    const view = await lookups.evidence.resolve(evidenceReference);
    if (!view || view.organizationScopeId !== organizationScopeId) {
      throw inventoryError(
        `evidence reference not found in organization scope: ${evidenceReference}`,
        { evidenceReference, organizationScopeId },
      );
    }
    if (
      view.subjectType !== INVENTORY_ITEM_SUBJECT_TYPE ||
      view.subjectId !== itemId
    ) {
      throw inventoryError(
        `evidence reference ${evidenceReference} is not bound to this inventory item (subject: ${view.subjectType}:${view.subjectId})`,
        { evidenceReference, subjectType: view.subjectType, subjectId: view.subjectId },
      );
    }
    return evidenceReference;
  }

  /**
   * THE SETTLEMENT-READINESS DERIVATION (INV-004): re-derive every
   * check from CURRENT durable records — the registered owner, the
   * supply availability, the live campaign policy scope, and the
   * RE-DERIVED placement eligibility (never trusted from storage).
   */
  async function deriveSettlementReadiness(
    organizationScopeId: string,
    placement: PlacementRecord,
  ): Promise<PlacementSettlementReadiness> {
    const checks: PlacementSettlementCheck[] = [];

    // 1) The registered owner resolves in scope (the durable item).
    const item = await itemRepository.findById(placement.inventoryItemId);
    const registeredOwner =
      item !== null && item.organizationScopeId === organizationScopeId;
    checks.push({
      check: "registered_owner",
      satisfied: registeredOwner,
      detail: registeredOwner
        ? { inventoryItemId: item.id, ownerPersonId: item.ownerPersonId }
        : {
            inventoryItemId: placement.inventoryItemId,
            reason: "inventory_item_not_found_in_scope",
          },
    });

    // 2) The supply is available (not withdrawn).
    const supplyAvailable = registeredOwner && item.retiredAt === null;
    checks.push({
      check: "supply_available",
      satisfied: supplyAvailable,
      detail: supplyAvailable
        ? { inventoryItemId: item.id }
        : {
            inventoryItemId: placement.inventoryItemId,
            reason: registeredOwner
              ? "supply_withdrawn"
              : "inventory_item_not_found_in_scope",
            ...(registeredOwner ? { retiredAt: item.retiredAt } : {}),
          },
    });

    // 3) The placement itself is active (not retired — the supply's
    //    withdrawal from THIS campaign blocks settlement).
    checks.push({
      check: "placement_active",
      satisfied: placement.retiredAt === null,
      detail: {
        placementId: placement.id,
        ...(placement.retiredAt !== null
          ? {
              reason: "placement_retired",
              retiredAt: placement.retiredAt,
            }
          : {}),
      },
    });

    // 4) The policy scope resolves with a publishable campaign status
    //    (the live administrative state — a paused/completed/cancelled
    //    or unresolvable campaign scope blocks settlement).
    const resolved = await lookups.campaign.resolvePolicy(
      placement.campaignId,
      placement.campaignPolicyVersion,
    );
    const policyScope =
      resolved !== null &&
      resolved.organizationScopeId === organizationScopeId &&
      isPublishableCampaignStatus(resolved.campaignStatus);
    checks.push({
      check: "policy_scope",
      satisfied: policyScope,
      detail: {
        campaignId: placement.campaignId,
        campaignPolicyVersion: placement.campaignPolicyVersion,
        ...(resolved !== null
          ? {
              campaignStatus: resolved.campaignStatus,
              organizationScopeMatches:
                resolved.organizationScopeId === organizationScopeId,
            }
          : { reason: "campaign_policy_scope_unresolved" }),
      },
    });

    // 5) The placement eligibility RE-DERIVATION is satisfied (the
    //    pure engine over the resolved version's rules + the
    //    placement's declared context — never the stored snapshot).
    let eligibilitySatisfied = false;
    let eligibilityDetail: Record<string, unknown>;
    if (resolved === null) {
      eligibilityDetail = {
        reason: "campaign_policy_scope_unresolved",
      };
    } else if (resolved.organizationScopeId !== organizationScopeId) {
      eligibilityDetail = {
        reason: "campaign_policy_scope_out_of_tenant",
      };
    } else {
      const evaluation = evaluatePlacementEligibility(
        resolved.eligibilityRules,
        {
          territories: placement.context.territories,
          languages: placement.context.languages,
        },
        nowIso(),
      );
      eligibilitySatisfied = evaluation.eligible;
      eligibilityDetail = {
        ruleResults: evaluation.ruleResults.map((result) => ({
          attribute: result.attribute,
          operator: result.operator,
          satisfied: result.satisfied,
          reason: result.reason,
        })),
      };
    }
    checks.push({
      check: "eligibility_satisfied",
      satisfied: eligibilitySatisfied,
      detail: eligibilityDetail,
    });

    const sourceContext: PlacementSourceContext = placement.sourceContext;
    return Object.freeze({
      placementId: placement.id,
      organizationScopeId,
      eligible: checks.every((check) => check.satisfied),
      checks: Object.freeze(checks),
      sourceContext,
      verificationEvidenceReference:
        registeredOwner ? item.verificationEvidenceReference : null,
      evaluatedAt: nowIso(),
    });
  }

  const service: InventoryService = {
    async registerInventoryItem(
      execution,
      input: RegisterInventoryItemInput,
    ): Promise<RegisterInventoryItemResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const surfaceKind = input.surfaceKind;
      if (typeof surfaceKind !== "string" || !isInventorySurfaceKind(surfaceKind)) {
        throw inventoryError(
          `surfaceKind must be a closed-vocabulary surface kind (got ${String(input.surfaceKind)}; vocabulary: ${INVENTORY_SURFACE_KINDS.join(", ")})`,
          { field: "surfaceKind", surfaceKind: input.surfaceKind },
        );
      }
      const format = input.format;
      if (typeof format !== "string" || !isInventoryFormat(format)) {
        throw inventoryError(
          `format must be a closed-vocabulary inventory format (got ${String(input.format)}; vocabulary: ${INVENTORY_FORMATS.join(", ")})`,
          { field: "format", format: input.format },
        );
      }
      const externalReference = buildExternalReference(input.externalReference);
      const attributes = validateSupplyAttributes("attributes", input.attributes);
      const description = validateOptionalProse("description", input.description);

      const key = `inventory_item:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const item: InventoryItem = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            // The registered owner IS the acting person — there is no
            // ownerPersonId input (invariant 3: supply ownership
            // cannot be fabricated by client claims).
            ownerPersonId: actor,
            surfaceKind,
            format,
            externalReference,
            attributes: Object.freeze({
              territories: attributes.territories,
              languages: attributes.languages,
            }),
            description,
            verificationEvidenceReference: null,
            retiredAt: null,
            retirementReason: null,
            formatVersion: INVENTORY_ITEM_FORMAT,
            createdBy: actor,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await itemRepository.createWithinTx(item, tx);
          await appendAudit(tx, {
            eventType: INVENTORY_ITEM_REGISTERED,
            context: execution,
            actor,
            subject: item.id,
            resourceType: "inventory_item",
            resourceId: item.id,
            metadata: {
              organizationScopeId: item.organizationScopeId,
              ownerPersonId: item.ownerPersonId,
              surfaceKind: item.surfaceKind,
              format: item.format,
              externalReference: item.externalReference,
              attributes: {
                territories: [...item.attributes.territories],
                languages: [...item.attributes.languages],
              },
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return item;
        },
        execution,
      );
      return { item: applied.result, created: applied.executed };
    },

    async retireInventoryItem(
      execution,
      input: RetireInventoryItemInput,
    ): Promise<InventoryItem> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const item = await requireItem(input.organizationScopeId, input.itemId);
      requireOwner(actor, item);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `inventory_item_retire:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh owner + existence check (TOCTOU closure).
          const fresh = await requireItemWithinTx(
            input.organizationScopeId,
            item.id,
            tx,
          );
          requireOwner(actor, fresh);
          const retired = await itemRepository.retireWithinTx(
            fresh.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: INVENTORY_ITEM_RETIRED,
            context: execution,
            actor,
            subject: retired.id,
            resourceType: "inventory_item",
            resourceId: retired.id,
            metadata: {
              organizationScopeId: retired.organizationScopeId,
              ownerPersonId: retired.ownerPersonId,
              retiredAt: retired.retiredAt,
              retirementReason: retired.retirementReason,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return retired;
        },
        execution,
      );
      return applied.result;
    },

    async attachSupplyVerification(
      execution,
      input: AttachSupplyVerificationInput,
    ): Promise<InventoryItem> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const item = await requireItem(input.organizationScopeId, input.itemId);
      requireOwner(actor, item);
      // The evidence reference must resolve through the canonical
      // /evidence authority, subject-bound to THIS item (INV-003).
      const evidenceReference = await validateVerificationEvidence(
        input.organizationScopeId,
        item.id,
        input.evidenceReference,
      );
      const key = `inventory_item_attach_verification:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const fresh = await requireItemWithinTx(
            input.organizationScopeId,
            item.id,
            tx,
          );
          requireOwner(actor, fresh);
          // One-time attachment: stable provenance — an item that
          // already carries a reference is returned unchanged (the
          // idempotent-apply replay path).
          const attachedAt = nowIso();
          const updated = await itemRepository.attachVerificationWithinTx(
            fresh.id,
            evidenceReference,
            attachedAt,
            tx,
          );
          await appendAudit(tx, {
            eventType: SUPPLY_VERIFICATION_ATTACHED,
            context: execution,
            actor,
            subject: updated.id,
            resourceType: "inventory_item",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              ownerPersonId: updated.ownerPersonId,
              evidenceReference: updated.verificationEvidenceReference,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        },
        execution,
      );
      return applied.result;
    },

    async createPlacement(
      execution,
      input: CreatePlacementInput,
    ): Promise<CreatePlacementResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      if (!input.inventoryItemId?.trim()) {
        throw inventoryError("inventoryItemId is required", {
          field: "inventoryItemId",
        });
      }
      if (!input.campaignId?.trim()) {
        throw inventoryError("campaignId is required", {
          field: "campaignId",
        });
      }
      const context = validateSupplyAttributes("context", input.context);

      // Outer reads: the item must exist, be AVAILABLE, and be OWNED
      // by the acting person (server-enforced supply ownership); the
      // campaign policy scope must resolve in the tenant scope. Both
      // are re-proven in-tx below (TOCTOU closure).
      const item = await requireItem(
        input.organizationScopeId,
        input.inventoryItemId,
      );
      requireOwner(actor, item);
      if (item.retiredAt !== null) {
        throw inventoryError(
          `inventory item ${item.id} is retired (withdrawn supply cannot be placed)`,
          { inventoryItemId: item.id, retiredAt: item.retiredAt },
        );
      }
      // The placement context may only NARROW the item's declared
      // supply attributes.
      assertPlacementContextWithinSupply(
        "context.territories",
        context.territories,
        item.attributes.territories,
      );
      assertPlacementContextWithinSupply(
        "context.languages",
        context.languages,
        item.attributes.languages,
      );
      const policyScope = await resolvePolicyScope(
        input.organizationScopeId,
        input.campaignId,
        input.campaignPolicyVersion,
      );

      // ONE composite idempotency record covers the WHOLE semantic
      // action (precondition re-checks + conflict check + the
      // material placement record). The per-key mutex + the in-tx
      // conflict check are the authoritative serializers; the
      // (item, campaign) pair lock below additionally serializes
      // concurrent placements racing on the SAME pair (the W018
      // workflow-subject lock precedent — without it, two
      // different-key applies could both observe no active placement
      // under snapshot isolation).
      const key = `placement:${input.organizationScopeId}:${input.idempotencyKey}`;
      const pairLock = `inventory_placement:${input.organizationScopeId}:${item.id}:${input.campaignId}`;
      const applied = await idempotency.withLock(
        pairLock,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh precondition: the item is STILL available and
          // owned by the acting person (a concurrent withdrawal loses
          // here — TOCTOU closure).
          const fresh = await requireItemWithinTx(
            input.organizationScopeId,
            item.id,
            tx,
          );
          requireOwner(actor, fresh);
          if (fresh.retiredAt !== null) {
            throw inventoryError(
              `inventory item ${fresh.id} is retired (withdrawn supply cannot be placed)`,
              { inventoryItemId: fresh.id, retiredAt: fresh.retiredAt },
            );
          }
          assertPlacementContextWithinSupply(
            "context.territories",
            context.territories,
            fresh.attributes.territories,
          );
          assertPlacementContextWithinSupply(
            "context.languages",
            context.languages,
            fresh.attributes.languages,
          );
          // In-tx re-resolution of the policy scope (the campaign is
          // still in the tenant scope with the pinned-or-latest
          // version — a caller cannot fabricate campaign scope).
          const scope = await resolvePolicyScope(
            input.organizationScopeId,
            input.campaignId,
            input.campaignPolicyVersion,
          );
          // Create-once: ONE active (non-retired) placement per
          // (item, campaign) — a stable conflict otherwise.
          const existing =
            await placementRepository.findActiveByItemAndCampaignWithinTx(
              input.organizationScopeId,
              fresh.id,
              scope.campaignId,
              tx,
            );
          if (existing) {
            throw new PlacementConflictError(
              `an active placement already exists for inventory item ${fresh.id} and campaign ${scope.campaignId} (one active placement per item and campaign; existing: ${existing.id})`,
              {
                inventoryItemId: fresh.id,
                campaignId: scope.campaignId,
                existingPlacementId: existing.id,
              },
            );
          }
          // THE DERIVED ELIGIBILITY (INV-002 — recorded as the
          // deterministic snapshot; the pure engine over the pinned
          // version's rules + the declared context — a caller cannot
          // fabricate placement eligibility).
          const eligibility: PlacementEligibilityEvaluation =
            evaluatePlacementEligibility(
              scope.eligibilityRules,
              {
                territories: context.territories,
                languages: context.languages,
              },
              nowIso(),
            );
          // THE SOURCE CONTEXT (provenance snapshot — written by the
          // service from durable records; there is NO caller input
          // for any source-context field).
          const sourceContext: PlacementSourceContext = Object.freeze({
            inventoryItemId: fresh.id,
            ownerPersonId: fresh.ownerPersonId,
            surfaceKind: fresh.surfaceKind,
            format: fresh.format,
            externalReference: fresh.externalReference,
            campaignId: scope.campaignId,
            campaignPolicyVersion: scope.policyVersion,
          });
          const placement: PlacementRecord = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            inventoryItemId: fresh.id,
            campaignId: scope.campaignId,
            campaignPolicyVersion: scope.policyVersion,
            context: Object.freeze({
              territories: context.territories,
              languages: context.languages,
            }),
            sourceContext,
            eligibility,
            retiredAt: null,
            retirementReason: null,
            formatVersion: PLACEMENT_RECORD_FORMAT,
            createdBy: actor,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await placementRepository.createWithinTx(placement, tx);
          await appendAudit(tx, {
            eventType: PLACEMENT_RECORDED,
            context: execution,
            actor,
            subject: placement.id,
            resourceType: "placement",
            resourceId: placement.id,
            metadata: {
              organizationScopeId: placement.organizationScopeId,
              inventoryItemId: placement.inventoryItemId,
              campaignId: placement.campaignId,
              campaignPolicyVersion: placement.campaignPolicyVersion,
              ownerPersonId: fresh.ownerPersonId,
              surfaceKind: fresh.surfaceKind,
              format: fresh.format,
              externalReference: fresh.externalReference,
              context: {
                territories: [...placement.context.territories],
                languages: [...placement.context.languages],
              },
              eligibility: {
                eligible: placement.eligibility.eligible,
                ruleResults: placement.eligibility.ruleResults.map((r) => ({
                  attribute: r.attribute,
                  operator: r.operator,
                  satisfied: r.satisfied,
                  reason: r.reason,
                })),
              },
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return placement;
        }, execution),
      );
      return { placement: applied.result, created: applied.executed };
    },

    async retirePlacement(
      execution,
      input: RetirePlacementInput,
    ): Promise<PlacementRecord> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const placement = await requirePlacement(
        input.organizationScopeId,
        input.placementId,
      );
      const item = await requireItem(
        input.organizationScopeId,
        placement.inventoryItemId,
      );
      requireOwner(actor, item);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `placement_retire:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const freshItem = await requireItemWithinTx(
            input.organizationScopeId,
            placement.inventoryItemId,
            tx,
          );
          requireOwner(actor, freshItem);
          const retired = await placementRepository.retireWithinTx(
            placement.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: PLACEMENT_RETIRED,
            context: execution,
            actor,
            subject: retired.id,
            resourceType: "placement",
            resourceId: retired.id,
            metadata: {
              organizationScopeId: retired.organizationScopeId,
              inventoryItemId: retired.inventoryItemId,
              campaignId: retired.campaignId,
              campaignPolicyVersion: retired.campaignPolicyVersion,
              retiredAt: retired.retiredAt,
              retirementReason: retired.retirementReason,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return retired;
        },
        execution,
      );
      return applied.result;
    },

    async getInventoryItem(execution, organizationScopeId, itemId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return requireItem(organizationScopeId, itemId);
    },

    async listInventoryItems(execution, organizationScopeId, filters) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return itemRepository.listByOrganization(organizationScopeId, filters);
    },

    async getPlacement(execution, organizationScopeId, placementId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return requirePlacement(organizationScopeId, placementId);
    },

    async listPlacements(execution, organizationScopeId, filters) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return placementRepository.listByOrganization(
        organizationScopeId,
        filters,
      );
    },

    async getPlacementSettlementReadiness(
      execution,
      organizationScopeId,
      placementId,
    ) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const placement = await requirePlacement(
        organizationScopeId,
        placementId,
      );
      return deriveSettlementReadiness(organizationScopeId, placement);
    },
  };

  logger.debug("inventory.inventory_service.created", {
    boundary: "inventory",
    service: "inventory",
  });

  return service;
}
