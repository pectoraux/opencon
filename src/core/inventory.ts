/**
 * Shared inventory vocabulary (core contracts) — NET-W019.
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/inventory` owns inventory domain rules — supply registration,
 * placement context, supply authorization and source provenance),
 * §7 (the frozen sixteen core domains — `/inventory` is the Phase-5
 * Inventory boundary that NET-W001 established as an explicit module
 * and NET-W019 now carries to readiness); spec/architecture-lock.md
 * §2 (the sixteen frozen core domains — UNCHANGED by this work order:
 * inventory semantics live in the ALREADY-FROZEN `/inventory`
 * boundary, NOT a 17th domain).
 *
 * Work order ref: spec/work-orders/NET-W019.md
 * Requirements: INV-001 (first-class inventory + placements),
 * INV-002 (format, placement context, eligibility, policy, source
 * identity), INV-003 (authorization/provenance using existing
 * ecosystem signals), INV-004 (no settlement eligibility without a
 * registered owner/source and policy context), CAMP-003 (ad-ecosystem
 * interop — provider-neutral external references only), CAMP-004
 * (non-reciprocal cross-promotion — inventory/placement
 * REPRESENTATION only; the exchange/clearing execution is NET-W020).
 *
 * THE KEY RULES (work order §2 — authority separation):
 *  - `/inventory` owns supply REGISTRATION and placement CONTEXT:
 *    the durable inventory-item record (explicit registered owner +
 *    provider-neutral external reference + declared supply
 *    attributes) and the durable placement record (policy-scoped
 *    campaign binding + provenance snapshot + the DERIVED placement
 *    eligibility evaluation);
 *  - `/campaigns` stays the campaign policy authority: the placement
 *    references a campaign + PINNED policy version, resolved
 *    READ-ONLY through the neutral composition-root lookup
 *    (the NET-W018 CampaignDisclosurePolicyLookup precedent); the
 *    eligibility RULES are the campaign policy's own section — this
 *    boundary only EVALUATES them against declared supply attributes
 *    (it never re-declares or duplicates policy);
 *  - `/workflows` stays the SOLE lifecycle authority and is
 *    UNTOUCHED by NET-W019: inventory items and placements carry NO
 *    lifecycle state (no LifecycleSubjectKind is added, no transition
 *    table is touched). Supply withdrawal and placement retirement
 *    are ONE-WAY field mutations (the NET-W018 commercial-
 *    relationship termination precedent), never status machines;
 *  - `/evidence` stays the truth authority: the OPTIONAL supply
 *    verification signal is a canonical evidence reference
 *    subject-bound to the inventory item (INV-003 — provenance using
 *    existing ecosystem signals), validated through the neutral
 *    evidence lookup — never fabricated here;
 *  - `/settlement` stays the economic authority: NET-W019 creates NO
 *    economic units, commitments or ledger entries. The settlement
 *    gate is DERIVED (the placement settlement-readiness view): a
 *    settlement-affecting consumer requires the valid source context
 *    (registered owner + available supply + resolved publishable
 *    policy scope + satisfied eligibility); there is no command that
 *    asserts settlement eligibility (INV-004);
 *  - provider-specific semantics stay OUTSIDE the inventory domain
 *    (AC-05): the external reference descriptor is provider-neutral
 *    (provider id + external id + url); credentials never appear.
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour.
 */

import { OpenConError } from "./errors.ts";

/**
 * The inventory surface kinds (INV-001): the closed, provider-neutral
 * vocabulary of supply surfaces an inventory item may declare. The
 * kinds describe WHO operates the surface, never a specific platform
 * (platform identity is the provider-neutral external reference —
 * CAMP-003).
 *
 *  - `publisher`: a publisher-operated property (site, network of
 *    properties) offering placements.
 *  - `app`: an application-operated surface (mobile/desktop app
 *    inventory).
 *  - `creator`: a creator-operated channel surface (the creator
 *    audience channel — the /creators lineage references it, never
 *    the other way around).
 */
export const INVENTORY_SURFACE_KINDS = [
  "publisher",
  "app",
  "creator",
] as const;

export type InventorySurfaceKind = (typeof INVENTORY_SURFACE_KINDS)[number];

export function isInventorySurfaceKind(
  value: string,
): value is InventorySurfaceKind {
  return (INVENTORY_SURFACE_KINDS as readonly string[]).includes(value);
}

/**
 * The inventory formats (INV-002 — "record inventory format"): the
 * closed, provider-neutral vocabulary of the creative format an
 * inventory item offers. Format names are generic industry formats —
 * provider-specific creative specifications stay behind /adapters.
 */
export const INVENTORY_FORMATS = [
  "display",
  "video",
  "audio",
  "native",
  "sponsored_content",
] as const;

export type InventoryFormat = (typeof INVENTORY_FORMATS)[number];

export function isInventoryFormat(value: string): value is InventoryFormat {
  return (INVENTORY_FORMATS as readonly string[]).includes(value);
}

/**
 * The maximum number of declared supply territories / languages on an
 * inventory item or placement context (bounded, deterministic sets —
 * the usage-rights bounds precedent).
 */
export const INVENTORY_MAX_TERRITORIES = 40;
export const INVENTORY_MAX_LANGUAGES = 20;

/** Provider-neutral external-reference descriptor bounds (AC-05). */
export const INVENTORY_EXTERNAL_PROVIDER_MAX_CHARS = 64;
export const INVENTORY_EXTERNAL_ID_MAX_CHARS = 200;
export const INVENTORY_EXTERNAL_URL_MAX_CHARS = 1000;

/** Prose bounds (descriptions, retirement reasons). */
export const INVENTORY_MAX_PROSE_CHARS = 2000;

/**
 * The recorded format lineage for the NET-W019 records (determinism:
 * the shape that governed a record's creation is reproducible).
 */
export const INVENTORY_ITEM_FORMAT = "NET-W019:1" as const;
export const PLACEMENT_RECORD_FORMAT = "NET-W019:1" as const;

const TERRITORY_RE = /^[A-Z]{2}$/;
const LANGUAGE_TAG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Validation error for inventory/placement request violations
 * (NET-W019): malformed registration/placement inputs, vocabulary or
 * bounds violations, and invalid source contexts.
 */
export class InvalidInventoryError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVENTORY_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Stable conflict on placement state (INV-002): ONE ACTIVE (non-
 * retired) placement per (inventory item, campaign) — a second
 * non-retired placement for the same pair conflicts deterministically
 * (machine-readable existingPlacementId context). A RETIRED placement
 * never blocks re-placement (supply may re-enter a campaign under a
 * later policy version).
 */
export class PlacementConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "PLACEMENT_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * Validate a declared supply attribute set: a NON-EMPTY, bounded list
 * of unique ISO 3166-1 alpha-2 style territory codes (uppercase).
 * Deterministic: duplicates are rejected so the declared sets are
 * canonical (the usage-rights territories precedent).
 */
export function validateInventoryTerritories(
  field: string,
  territories: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(territories) ||
    territories.length === 0 ||
    territories.length > INVENTORY_MAX_TERRITORIES
  ) {
    throw new InvalidInventoryError(
      `${field} must be a non-empty list of at most ${String(INVENTORY_MAX_TERRITORIES)} territory codes`,
      { field, count: territories?.length },
    );
  }
  const seen = new Set<string>();
  for (const code of territories) {
    if (typeof code !== "string" || !TERRITORY_RE.test(code)) {
      throw new InvalidInventoryError(
        `${field} territory code must be an ISO 3166-1 alpha-2 style code like "GH" (got ${String(code)})`,
        { field, code },
      );
    }
    if (seen.has(code)) {
      throw new InvalidInventoryError(
        `${field} contains duplicate territory code: ${code}`,
        { field, code },
      );
    }
    seen.add(code);
  }
  return Object.freeze([...territories]);
}

/**
 * Validate a declared supply language set: a NON-EMPTY, bounded list
 * of unique language tags like "en" or "pt-BR" (the creator-profile
 * language-tag precedent, with inventory-scoped error context).
 */
export function validateInventoryLanguages(
  field: string,
  languages: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(languages) ||
    languages.length === 0 ||
    languages.length > INVENTORY_MAX_LANGUAGES
  ) {
    throw new InvalidInventoryError(
      `${field} must be a non-empty list of at most ${String(INVENTORY_MAX_LANGUAGES)} language tags`,
      { field, count: languages?.length },
    );
  }
  const seen = new Set<string>();
  for (const tag of languages) {
    if (typeof tag !== "string" || !LANGUAGE_TAG_RE.test(tag)) {
      throw new InvalidInventoryError(
        `${field} language tag must look like "en" or "pt-BR" (got ${String(tag)})`,
        { field, tag },
      );
    }
    if (seen.has(tag)) {
      throw new InvalidInventoryError(
        `${field} contains duplicate language tag: ${tag}`,
        { field, tag },
      );
    }
    seen.add(tag);
  }
  return Object.freeze([...languages]);
}

/**
 * Validate that a placement-context attribute set is a SUBSET of the
 * inventory item's declared supply attributes (a placement may only
 * offer what the registered supply declares — INV-002: the placement
 * context cannot widen the item's declared reach).
 */
export function assertPlacementContextWithinSupply(
  field: string,
  contextValues: readonly string[],
  supplyValues: readonly string[],
): void {
  const supply = new Set(supplyValues);
  for (const value of contextValues) {
    if (!supply.has(value)) {
      throw new InvalidInventoryError(
        `${field} declares "${String(value)}" which the inventory item's supply does not (a placement context may only narrow the item's declared attributes)`,
        { field, value },
      );
    }
  }
}
