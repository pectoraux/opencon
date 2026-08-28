/**
 * Inventory boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/inventory` owns inventory domain rules), §7 (the sixteen frozen
 * core domains); spec/architecture-lock.md §2 (the frozen domain
 * list — `/inventory` was FROZEN from NET-W001; NET-W019 implements
 * INSIDE it and adds NO 17th domain).
 *
 * Work order ref: spec/work-orders/NET-W019.md
 * Requirements: INV-001..004, CAMP-003..004.
 *
 * AUTHORITY MODEL (work order §2 — the decision of record):
 *  - `/inventory` owns supply REGISTRATION + placement CONTEXT: the
 *    InventoryItem and PlacementRecord below are this boundary's own
 *    append-only records (material mutations flow exclusively through
 *    the IdempotencyStore's authoritative transactions);
 *  - `/campaigns` stays the campaign policy authority: the placement
 *    references a campaign + PINNED policy version and the
 *    eligibility RULES arrive READ-ONLY through the neutral
 *    {@link InventoryCampaignLookup} (the dependency-inversion
 *    precedent — the inventory domain imports core contracts only);
 *  - `/workflows` stays the SOLE lifecycle authority and is UNTOUCHED:
 *    inventory items and placements carry NO lifecycle subject kind,
 *    NO transition table, NO state machine. Supply withdrawal and
 *    placement retirement are ONE-WAY field mutations (the NET-W018
 *    commercial-relationship termination precedent);
 *  - `/evidence` stays the truth authority: the OPTIONAL supply
 *    verification signal is a canonical evidence reference
 *    subject-bound to the inventory item (INV-003), validated through
 *    the neutral {@link InventoryEvidenceLookup} — never fabricated
 *    here;
 *  - `/settlement` stays the economic authority: there is NO economic
 *    mutation surface in this boundary (no balances, no postings, no
 *    reward/credit/cash commands). The settlement gate is the DERIVED
 *    {@link PlacementSettlementReadiness} view (INV-004): the only
 *    settlement-relevant surface is the validated source context,
 *    re-derived from durable records on every read — a caller cannot
 *    assert, waive or store settlement eligibility;
 *  - NO AI path exists anywhere in this surface (work order §2).
 */

import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { Logger } from "../core/logger.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  InventoryFormat,
  InventorySurfaceKind,
} from "../core/inventory.ts";

// ---------------------------------------------------------------------------
// NET-W019 records
// ---------------------------------------------------------------------------

/**
 * A provider-neutral external reference (CAMP-003 — interoperate with
 * the existing advertising ecosystem): identifies the supply surface
 * on an external platform WITHOUT importing platform semantics.
 * Provider-specific execution (bid protocols, platform APIs,
 * credentials) stays behind `/adapters` + `/secrets` (AC-05).
 */
export interface InventoryExternalReference {
  /** Neutral provider identifier (e.g. "example-ad-network"). */
  readonly provider: string;
  /** The supply surface's id on the external provider. */
  readonly externalId: string;
  readonly url: string | null;
}

/** The declared neutral supply attributes (INV-002). */
export interface InventorySupplyAttributes {
  /** ISO 3166-1 alpha-2 style territory codes (non-empty, unique). */
  readonly territories: readonly string[];
  /** Language tags like "en", "pt-BR" (non-empty, unique). */
  readonly languages: readonly string[];
}

/**
 * An InventoryItem — the first-class, durable, tenant-scoped record of
 * registered supply (INV-001; invariant 1): a publisher/app/creator
 * surface offering a format, with EXPLICIT registered ownership (the
 * acting person at registration — there is no ownerPersonId INPUT on
 * any command, so a caller cannot fabricate supply ownership), a
 * provider-neutral external reference, declared supply attributes,
 * and an OPTIONAL canonical supply-verification evidence reference
 * (INV-003 — the ecosystem provenance signal, subject-bound to THIS
 * item).
 *
 * The record is STATIC after registration except the one-way
 * withdrawal (`retiredAt`) and the one-time supply-verification
 * attachment — both owner-only, both audited. A retired item's
 * placements are never settlement-ready (derived, never stored).
 */
export interface InventoryItem {
  readonly id: string;
  readonly organizationScopeId: string;
  /** The registered owner — the acting person at registration. */
  readonly ownerPersonId: string;
  readonly surfaceKind: InventorySurfaceKind;
  readonly format: InventoryFormat;
  readonly externalReference: InventoryExternalReference | null;
  readonly attributes: InventorySupplyAttributes;
  readonly description: string | null;
  /**
   * The canonical evidence reference proving the supply verification
   * (INV-003): set once, owner-only, subject-bound to THIS item
   * (subjectType "inventory_item", subjectId == itemId).
   */
  readonly verificationEvidenceReference: string | null;
  /** One-way supply withdrawal (null while the supply is available). */
  readonly retiredAt: string | null;
  readonly retirementReason: string | null;
  readonly formatVersion: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * The placement's provenance snapshot — the SOURCE CONTEXT (INV-002
 * source identity; invariant 2: durable, provenance-aware): the
 * durable supply identity (registered owner, surface, format, neutral
 * external reference) frozen at placement creation, plus the
 * policy-scope pin (campaign + policy version). Written ONLY by the
 * service from durable records — there is NO caller input for any
 * source-context field (a caller cannot fabricate provenance).
 */
export interface PlacementSourceContext {
  readonly inventoryItemId: string;
  readonly ownerPersonId: string;
  readonly surfaceKind: InventorySurfaceKind;
  readonly format: InventoryFormat;
  readonly externalReference: InventoryExternalReference | null;
  readonly campaignId: string;
  readonly campaignPolicyVersion: number;
}

/** One evaluated campaign eligibility rule (machine-readable result). */
export interface PlacementEligibilityRuleResult {
  readonly attribute: string;
  readonly operator: string;
  readonly values: readonly string[];
  readonly satisfied: boolean;
  /** Deterministic machine-readable reason (never prose-only). */
  readonly reason:
    | "satisfied"
    | "attribute_not_carried_by_supply"
    | "operator_not_applicable"
    | "offered_value_outside_rule"
    | "empty_context";
}

/**
 * The DERIVED placement eligibility evaluation (INV-002 — "record
 * eligibility"): a pure function over (the pinned campaign policy
 * version's eligibility rules, the placement's declared context
 * attributes) — snapshotted at creation (deterministic: the inputs are
 * immutable after creation) and RE-DERIVED live by the settlement
 * readiness view (never trusted from storage). A caller input for
 * eligibility does not exist.
 */
export interface PlacementEligibilityEvaluation {
  /** True iff every rule is satisfied (an empty rule set qualifies). */
  readonly eligible: boolean;
  readonly ruleResults: readonly PlacementEligibilityRuleResult[];
  readonly evaluatedAt: string;
}

/**
 * A PlacementRecord — the explicit, durable, policy-scoped placement
 * context (INV-001/002; invariant 2): binds a registered inventory
 * item to a campaign at a PINNED policy version, with the placement's
 * declared context attributes (a narrowing of the item's supply), the
 * provenance source-context snapshot and the derived eligibility
 * evaluation. ONE ACTIVE (non-retired) placement per (item, campaign)
 * — a stable conflict otherwise; a retired placement never blocks
 * re-placement.
 *
 * The record is STATIC after creation except the one-way retirement
 * (`retiredAt`) — owner-only, audited.
 */
export interface PlacementRecord {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly inventoryItemId: string;
  readonly campaignId: string;
  /** The resolved (pinned-or-latest-at-creation) policy version. */
  readonly campaignPolicyVersion: number;
  /** The placement's declared context (a narrowing of the supply). */
  readonly context: InventorySupplyAttributes;
  readonly sourceContext: PlacementSourceContext;
  readonly eligibility: PlacementEligibilityEvaluation;
  readonly retiredAt: string | null;
  readonly retirementReason: string | null;
  readonly formatVersion: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// NET-W019 inputs / results
// ---------------------------------------------------------------------------

export interface RegisterInventoryItemInput {
  readonly organizationScopeId: string;
  readonly surfaceKind: string;
  readonly format: string;
  readonly externalReference?: {
    readonly provider: string;
    readonly externalId: string;
    readonly url?: string | null;
  } | null;
  readonly attributes: {
    readonly territories: readonly string[];
    readonly languages: readonly string[];
  };
  readonly description?: string | null;
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO ownerPersonId input — the
  // registered owner is the acting person, server-resolved (a caller
  // cannot fabricate supply ownership; invariant 3).
}

export interface RegisterInventoryItemResult {
  readonly item: InventoryItem;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface RetireInventoryItemInput {
  readonly organizationScopeId: string;
  readonly itemId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

export interface AttachSupplyVerificationInput {
  readonly organizationScopeId: string;
  readonly itemId: string;
  /** Canonical evidence id, subject-bound to THIS item (≥1 required). */
  readonly evidenceReference: string;
  readonly idempotencyKey: string;
}

export interface CreatePlacementInput {
  readonly organizationScopeId: string;
  readonly inventoryItemId: string;
  readonly campaignId: string;
  /**
   * Optional explicit policy-version pin; when omitted the LATEST
   * version at creation applies (the pinned-or-latest precedent). The
   * resolved version is recorded in the source context.
   */
  readonly campaignPolicyVersion?: number;
  readonly context: {
    readonly territories: readonly string[];
    readonly languages: readonly string[];
  };
  readonly idempotencyKey: string;
  // NOTE: there is deliberately NO eligibility/owner input — the
  // owner is server-checked against the durable item, and the
  // eligibility evaluation is DERIVED from the pinned policy version
  // (invariant 3: caller claims cannot fabricate either).
}

export interface CreatePlacementResult {
  readonly placement: PlacementRecord;
  /** false when the idempotency key replayed the committed record. */
  readonly created: boolean;
}

export interface RetirePlacementInput {
  readonly organizationScopeId: string;
  readonly placementId: string;
  readonly reason?: string | null;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// The DERIVED settlement readiness (INV-004 — never stored, never
// caller-asserted)
// ---------------------------------------------------------------------------

/**
 * One settlement-readiness check (machine-readable; invariant 4).
 * Every check re-derives from CURRENT durable records on every read.
 */
export interface PlacementSettlementCheck {
  readonly check:
    | "registered_owner"
    | "supply_available"
    | "placement_active"
    | "policy_scope"
    | "eligibility_satisfied";
  readonly satisfied: boolean;
  /** Deterministic machine-readable detail for failed checks. */
  readonly detail: Record<string, unknown>;
}

/**
 * The DERIVED placement settlement readiness (INV-004 / AC-04): the
 * validated source context a settlement-affecting consumer must
 * require before inventory may settle. A PURE derivation over durable
 * records — the registered owner resolves in scope, the supply is not
 * withdrawn, the pinned campaign policy version resolves with the
 * campaign in a publishable status, and the placement eligibility
 * re-derivation is satisfied. There is NO command that asserts,
 * stores or waives readiness: `eligible` is true iff every check
 * passes, and `/settlement` remains the economic authority (this
 * boundary carries no economic surface at all).
 */
export interface PlacementSettlementReadiness {
  readonly placementId: string;
  readonly organizationScopeId: string;
  readonly eligible: boolean;
  readonly checks: readonly PlacementSettlementCheck[];
  /** The validated source context (the consumer contract). */
  readonly sourceContext: PlacementSourceContext;
  /**
   * The INV-003 ecosystem provenance signal: the canonical
   * supply-verification evidence reference when attached (null when
   * unavailable — "where available").
   */
  readonly verificationEvidenceReference: string | null;
  readonly evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// NET-W019 neutral cross-domain lookups (composition-root wired)
// ---------------------------------------------------------------------------

/**
 * The campaign policy scope, resolved READ-ONLY over the campaigns
 * boundary (the NET-W018 CampaignDisclosurePolicyLookup precedent):
 * the campaign's existence + tenant scope + administrative status,
 * plus the pinned-or-latest policy version's ELIGIBILITY RULES (the
 * campaign policy authority's own section — evaluated here, never
 * re-declared). /campaigns stays the authority; a nonexistent or
 * cross-scope campaign resolves to null (no existence oracle).
 */
export interface ResolvedCampaignPolicyScope {
  readonly campaignId: string;
  readonly organizationScopeId: string;
  readonly campaignStatus: string;
  readonly policyVersion: number;
  readonly eligibilityRules: readonly {
    readonly attribute: string;
    readonly operator: string;
    readonly values: readonly string[];
  }[];
}

export interface InventoryCampaignLookup {
  /**
   * Resolve a campaign's policy scope. `policyVersion` pins the
   * version; when omitted the LATEST version applies. A campaign with
   * NO policy versions resolves to null (nothing to scope to).
   */
  resolvePolicy(
    campaignId: string,
    policyVersion?: number,
  ): Promise<ResolvedCampaignPolicyScope | null>;
}

/**
 * The canonical /evidence authority read for the supply-verification
 * signal (INV-003): existence + tenant scope + subject binding. The
 * inventory boundary only VALIDATES references through this view — it
 * never fabricates supply proof.
 */
export interface InventoryEvidenceLookup {
  resolve(evidenceId: string): Promise<{
    readonly id: string;
    readonly organizationScopeId: string;
    readonly subjectType: string;
    readonly subjectId: string;
  } | null>;
}

export interface InventoryLookups {
  readonly campaign: InventoryCampaignLookup;
  readonly evidence: InventoryEvidenceLookup;
}

// ---------------------------------------------------------------------------
// NET-W019 repositories
// ---------------------------------------------------------------------------

export interface InventoryItemRepository {
  save(
    item: InventoryItem,
    execution: ExecutionContext,
  ): Promise<InventoryItem>;
  findById(id: string): Promise<InventoryItem | null>;
  createWithinTx(
    item: InventoryItem,
    tx: AuthorityTransaction,
  ): Promise<InventoryItem>;
  /** In-tx fresh read (the composites' TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<InventoryItem | null>;
  /**
   * One-way supply withdrawal (in-tx with the withdrawal audit
   * event): an already-retired item is returned unchanged.
   */
  retireWithinTx(
    itemId: string,
    retiredAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<InventoryItem>;
  /**
   * One-time supply-verification attachment (in-tx with the audit
   * event): an item that already carries a reference is returned
   * unchanged (stable provenance — no replacement).
   */
  attachVerificationWithinTx(
    itemId: string,
    evidenceReference: string,
    attachedAt: string,
    tx: AuthorityTransaction,
  ): Promise<InventoryItem>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly surfaceKind?: string;
      readonly format?: string;
      readonly ownerPersonId?: string;
      readonly retired?: boolean;
    },
  ): Promise<readonly InventoryItem[]>;
}

export interface PlacementRepository {
  save(
    placement: PlacementRecord,
    execution: ExecutionContext,
  ): Promise<PlacementRecord>;
  findById(id: string): Promise<PlacementRecord | null>;
  createWithinTx(
    placement: PlacementRecord,
    tx: AuthorityTransaction,
  ): Promise<PlacementRecord>;
  /** In-tx fresh read (the readiness derivation's TOCTOU closure). */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<PlacementRecord | null>;
  /**
   * In-tx active-placement lookup for the create-once constraint
   * (one NON-RETIRED placement per (item, campaign) — a retired
   * placement never blocks re-placement).
   */
  findActiveByItemAndCampaignWithinTx(
    organizationScopeId: string,
    inventoryItemId: string,
    campaignId: string,
    tx: AuthorityTransaction,
  ): Promise<PlacementRecord | null>;
  /**
   * One-way placement retirement (in-tx with the retirement audit
   * event): an already-retired placement is returned unchanged.
   */
  retireWithinTx(
    placementId: string,
    retiredAt: string,
    reason: string | null,
    tx: AuthorityTransaction,
  ): Promise<PlacementRecord>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly inventoryItemId?: string;
      readonly campaignId?: string;
      readonly ownerPersonId?: string;
      readonly retired?: boolean;
    },
  ): Promise<readonly PlacementRecord[]>;
}

// ---------------------------------------------------------------------------
// The NET-W019 inventory domain service
// ---------------------------------------------------------------------------

export interface InventoryService {
  /**
   * Register supply (INV-001): the acting person BECOMES the
   * registered owner (there is no ownerPersonId input — ownership
   * cannot be fabricated). Validates the closed surface/format
   * vocabularies, the provider-neutral external reference, the
   * declared supply attributes and the prose bounds. Commits
   * atomically with the `inventory_item.registered` audit event.
   */
  registerInventoryItem(
    execution: ExecutionContext,
    input: RegisterInventoryItemInput,
  ): Promise<RegisterInventoryItemResult>;
  /**
   * Withdraw supply (one-way, owner-only; the conservative direction):
   * a retired item's placements are never settlement-ready (derived).
   * Commits atomically with the `inventory_item.retired` audit event.
   */
  retireInventoryItem(
    execution: ExecutionContext,
    input: RetireInventoryItemInput,
  ): Promise<InventoryItem>;
  /**
   * Attach the supply-verification evidence reference (INV-003 —
   * provenance using existing ecosystem signals): owner-only, ONE-TIME
   * (stable provenance). The reference must resolve to a canonical
   * /evidence record subject-bound to THIS item (subjectType
   * "inventory_item", subjectId == itemId, same tenant scope) —
   * supply proof cannot be fabricated here. Commits atomically with
   * the `inventory_item.supply_verification_attached` audit event.
   */
  attachSupplyVerification(
    execution: ExecutionContext,
    input: AttachSupplyVerificationInput,
  ): Promise<InventoryItem>;
  /**
   * Record the placement context (INV-002): the acting person MUST be
   * the item's registered owner (server-enforced against the DURABLE
   * record — a caller cannot fabricate supply ownership); the campaign
   * policy scope resolves through the NEUTRAL lookup (existence +
   * tenant scope + pinned-or-latest version — a caller cannot
   * fabricate campaign scope); the placement context may only NARROW
   * the item's declared supply; and the eligibility evaluation is
   * DERIVED from the pinned policy version's rules against the
   * placement's declared context (machine-readable per-rule results —
   * a caller cannot fabricate placement eligibility; the evaluation is
   * RECORDED as the deterministic snapshot, INV-002). ONE active
   * placement per (item, campaign) — a stable conflict otherwise.
   * Commits atomically with the `placement.recorded` audit event.
   */
  createPlacement(
    execution: ExecutionContext,
    input: CreatePlacementInput,
  ): Promise<CreatePlacementResult>;
  /**
   * Retire the placement (one-way, owner-only): the conservative
   * withdrawal of supply from a campaign. Commits atomically with the
   * `placement.retired` audit event.
   */
  retirePlacement(
    execution: ExecutionContext,
    input: RetirePlacementInput,
  ): Promise<PlacementRecord>;
  /** Tenant-scoped reads (cross-scope = NotFoundError). */
  getInventoryItem(
    execution: ExecutionContext,
    organizationScopeId: string,
    itemId: string,
  ): Promise<InventoryItem>;
  listInventoryItems(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly surfaceKind?: string;
      readonly format?: string;
      readonly ownerPersonId?: string;
      readonly retired?: boolean;
    },
  ): Promise<readonly InventoryItem[]>;
  getPlacement(
    execution: ExecutionContext,
    organizationScopeId: string,
    placementId: string,
  ): Promise<PlacementRecord>;
  listPlacements(
    execution: ExecutionContext,
    organizationScopeId: string,
    filters?: {
      readonly inventoryItemId?: string;
      readonly campaignId?: string;
      readonly ownerPersonId?: string;
      readonly retired?: boolean;
    },
  ): Promise<readonly PlacementRecord[]>;
  /**
   * THE SETTLEMENT GATE (INV-004 / AC-04): the DERIVED settlement
   * readiness of a placement — the validated source context a
   * settlement-affecting consumer must require (registered owner +
   * available supply + resolved publishable policy scope + satisfied
   * eligibility), re-derived from CURRENT durable records on every
   * read. There is NO command that asserts, stores or waives
   * readiness, and this boundary carries NO economic surface
   * (/settlement stays the economic authority).
   */
  getPlacementSettlementReadiness(
    execution: ExecutionContext,
    organizationScopeId: string,
    placementId: string,
  ): Promise<PlacementSettlementReadiness>;
}

export interface InventoryServiceDeps {
  readonly itemRepository: InventoryItemRepository;
  readonly placementRepository: PlacementRepository;
  readonly lookups: InventoryLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// The boundary port
// ---------------------------------------------------------------------------

/**
 * The InventoryPort describes the boundary's readiness. After
 * NET-W019 it is `"ready"` (the boundary carries the inventory
 * domain: supply registration with explicit ownership, placement
 * context with policy scoping + provenance, server-enforced supply
 * authorization, and the derived settlement-readiness source-context
 * gate).
 */
export interface InventoryPort {
  readonly boundary: "inventory";
  readonly readiness: "ready";
  /** Audit event types emitted by material inventory mutations (AC-06). */
  readonly auditEventTypes: {
    readonly itemRegistered: "inventory_item.registered";
    readonly itemRetired: "inventory_item.retired";
    readonly supplyVerificationAttached: "inventory_item.supply_verification_attached";
    readonly placementRecorded: "placement.recorded";
    readonly placementRetired: "placement.retired";
  };
}

export type {
  ExecutionContext,
  AuthorityTransaction,
  TransactionalAuditWriter,
  IdempotencyStore,
  InventoryFormat,
  InventorySurfaceKind,
};
