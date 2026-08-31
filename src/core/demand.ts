/**
 * Shared demand vocabulary (core contracts) — NET-W024.
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/demand`, `/benefits` own demand aggregation and benefit
 * allocation), §9 (Demand architecture — Demand Signals → Demand Pool
 * → Qualified Aggregate Demand → Supplier Competition; individual
 * commercial terms remain private), §7 (the frozen sixteen core
 * domains — `/demand` was FROZEN from NET-W001; NET-W024 implements
 * INSIDE it and adds NO 17th domain); spec/architecture-lock.md §2
 * (the frozen domain list), §5 (economic authority — untouched), §6
 * (privacy authority — aggregate evidence proves integrity without
 * publishing raw personal data), §1 invariants 6 + 10.
 *
 * Work order ref: spec/work-orders/NET-W024.md
 * Requirements: DEM-001 (consumer demand pools), DEM-002
 * (privacy-preserving aggregation), DEM-003 (competitive supplier
 * exposure — bounded to the qualified-aggregate surface; offers and
 * selection are NET-W025/W026).
 *
 * THE KEY RULES (work order §2 — authority separation):
 *  - `/demand` owns the demand POOL and COMMITMENT records, the
 *    versioned provider-neutral category/attribute vocabulary below,
 *    the aggregation/qualification derivation, and the supplier-facing
 *    aggregate contract;
 *  - `/settlement` stays the economic authority: demand pools create
 *    NO ledger entries, credits, cash obligations, stakes or rewards
 *    (there is no economic vocabulary here at all);
 *  - `/identity`, `/organizations`, `/participants` stay the
 *    membership/authorization authorities: membership resolves
 *    server-side through the neutral composition-root lookup;
 *  - `/workflows` stays the SOLE lifecycle authority and is UNTOUCHED
 *    (pool closure and commitment withdrawal are ONE-WAY field
 *    mutations, never status machines);
 *  - the PRIVACY DISCLOSURE FLOOR is a frozen constant: it cannot be
 *    lowered or bypassed by ANY pool policy or caller input
 *    (DEM-002 / PRIV-003).
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour.
 */

import { OpenConError } from "./errors.ts";

/**
 * The record-format lineage for the NET-W024 records (determinism:
 * the shape that governed a record's creation is reproducible).
 */
export const DEMAND_POOL_RECORD_FORMAT = "NET-W024:1" as const;
export const DEMAND_COMMITMENT_RECORD_FORMAT = "NET-W024:1" as const;

/**
 * The demand category keys (DEM-001): the closed, versioned,
 * provider-neutral vocabulary of consumer demand verticals a pool may
 * aggregate. Category names are generic consumer verticals —
 * provider/vendor/brand identities never appear (provider-specific
 * vocabulary stays behind /adapters; the categories are deliberately
 * coarse so aggregates remain non-identifying).
 */
export const DEMAND_CATEGORY_KEYS = [
  "utilities_energy",
  "telecom_connectivity",
  "insurance_home",
  "grocery_household",
  "software_tools",
  "transport_mobility",
  "health_wellness",
  "home_services",
] as const;

export type DemandCategoryKey = (typeof DEMAND_CATEGORY_KEYS)[number];

/** The category vocabulary version (bumped when the set changes). */
export const DEMAND_CATEGORY_VERSION = "1" as const;

export function isDemandCategoryKey(
  value: string,
): value is DemandCategoryKey {
  return (DEMAND_CATEGORY_KEYS as readonly string[]).includes(value);
}

/**
 * The commitment region codes: the closed, provider-neutral macro-region
 * vocabulary for the one REQUIRED commitment attribute. Coarse macro
 * regions (never city/postal granularity) keep aggregates
 * non-identifying (DEM-002).
 */
export const DEMAND_REGION_CODES = [
  "NA_EAST",
  "NA_CENTRAL",
  "NA_WEST",
  "EU_NORTH",
  "EU_SOUTH",
  "EU_EAST",
  "EU_WEST",
  "APAC_EAST",
  "APAC_SOUTH",
  "APAC_SOUTHEAST",
  "LATAM",
  "MEA",
] as const;

export type DemandRegionCode = (typeof DEMAND_REGION_CODES)[number];

export function isDemandRegionCode(value: string): value is DemandRegionCode {
  return (DEMAND_REGION_CODES as readonly string[]).includes(value);
}

/**
 * The commitment budget bands: the closed, currency-neutral monthly
 * spend-band vocabulary for the OPTIONAL commitment attribute. Bands
 * (never exact amounts) keep supplier-facing aggregates
 * non-identifying (DEM-002).
 */
export const DEMAND_BUDGET_BANDS = [
  "band_a_under_50",
  "band_b_50_199",
  "band_c_200_499",
  "band_d_500_999",
  "band_e_1000_plus",
] as const;

export type DemandBudgetBand = (typeof DEMAND_BUDGET_BANDS)[number];

export function isDemandBudgetBand(value: string): value is DemandBudgetBand {
  return (DEMAND_BUDGET_BANDS as readonly string[]).includes(value);
}

/**
 * The commitment quantity bounds: the monthly committed quantity is a
 * bounded integer (fail closed outside 1..10000). Quantities NEVER
 * cross to supplier-facing views as exact per-person values — only
 * the fixed-bucket distribution below does.
 */
export const DEMAND_MIN_QUANTITY = 1;
export const DEMAND_MAX_QUANTITY = 10000;

/**
 * The fixed quantity buckets for the aggregate distribution (the
 * privacy-preserving quantity disclosure: buckets, never exact
 * per-person quantities — DEM-002).
 */
export const DEMAND_QUANTITY_BUCKETS = [
  "q_1_9",
  "q_10_49",
  "q_50_99",
  "q_100_499",
  "q_500_plus",
] as const;

export type DemandQuantityBucket = (typeof DEMAND_QUANTITY_BUCKETS)[number];

/** Map a bounded commitment quantity to its fixed bucket. */
export function demandQuantityBucket(
  quantity: number,
): DemandQuantityBucket {
  if (quantity < 10) return "q_1_9";
  if (quantity < 50) return "q_10_49";
  if (quantity < 100) return "q_50_99";
  if (quantity < 500) return "q_100_499";
  return "q_500_plus";
}

/**
 * THE FROZEN PRIVACY DISCLOSURE FLOOR (DEM-002 / PRIV-003 — the
 * k-anonymity floor of this boundary): NO aggregate fact — including
 * the commitment count itself — is emitted in any supplier-facing
 * view unless the active commitment count is at least this many, and
 * NO distribution group (region / budget band / quantity bucket) is
 * NAMED unless the group itself holds at least this many
 * commitments. This is a CONSTANT: no pool policy, caller input or
 * configuration can lower it (the aggregate threshold cannot be
 * caller-asserted or bypassed — issue #48 invariant 4).
 */
export const DEMAND_PRIVACY_MINIMUM_COMMITMENTS = 3;

/**
 * The consent scope for demand commitments: exactly one closed value
 * in NET-W024 — the consumer consents (server-recorded, at
 * submission) to AGGREGATE-ONLY disclosure of this commitment. There
 * is no individual-disclosure consent in this vocabulary, so no
 * caller assertion can ever expose an individual commitment through
 * the aggregate surface (issue #48: "no caller assertion may
 * fabricate demand membership or qualification").
 */
export const DEMAND_CONSENT_SCOPE = "aggregate_disclosure" as const;

export type DemandConsentScope = typeof DEMAND_CONSENT_SCOPE;

/** The consent-grant record version (server-written on submission). */
export const DEMAND_CONSENT_VERSION = "NET-W024:1" as const;

/**
 * Qualification-policy bounds: the pool's qualification threshold
 * (`minimumCommitments`) is a bounded integer the pool creator sets
 * ONCE at creation (versioned policy on the record); qualification is
 * then only ever DERIVED (never caller-asserted).
 */
export const DEMAND_POLICY_VERSION = 1;
export const DEMAND_MIN_QUALIFICATION_COMMITMENTS = 1;
export const DEMAND_MAX_QUALIFICATION_COMMITMENTS = 10000;

/** Prose bounds (pool names, closure/withdrawal reasons). */
export const DEMAND_POOL_NAME_MAX_CHARS = 200;
export const DEMAND_MAX_PROSE_CHARS = 2000;

/**
 * Validation error for demand request violations (NET-W024):
 * malformed pool/commitment inputs, vocabulary or bounds violations.
 */
export class InvalidDemandError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "DEMAND_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Stable conflict on commitment state (DEM-001): ONE ACTIVE
 * (non-withdrawn) commitment per (pool, consumer) — a second active
 * commitment for the same pair conflicts deterministically
 * (machine-readable poolId context). A WITHDRAWN commitment never
 * blocks re-commitment (the consumer may re-enter under a new
 * record).
 */
export class DemandCommitmentConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "DEMAND_COMMITMENT_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * Validate the declared commitment attributes (DEM-002 — bounded,
 * provider-neutral, fail closed): a REQUIRED region from the closed
 * macro-region vocabulary, a REQUIRED bounded monthly quantity, and
 * an OPTIONAL budget band from the closed currency-neutral band
 * vocabulary.
 */
export function validateDemandAttributes(
  field: string,
  raw: {
    readonly region?: unknown;
    readonly quantity?: unknown;
    readonly budgetBand?: unknown;
  },
): {
  readonly region: DemandRegionCode;
  readonly quantity: number;
  readonly budgetBand: DemandBudgetBand | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new InvalidDemandError(`${field} is required`, { field });
  }
  const region = raw.region;
  if (
    typeof region !== "string" ||
    !isDemandRegionCode(region)
  ) {
    throw new InvalidDemandError(
      `${field}.region must be a closed-vocabulary demand region code (got ${String(region)}; vocabulary: ${DEMAND_REGION_CODES.join(", ")})`,
      { field: `${field}.region`, region: String(region) },
    );
  }
  const quantity = raw.quantity;
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < DEMAND_MIN_QUANTITY ||
    quantity > DEMAND_MAX_QUANTITY
  ) {
    throw new InvalidDemandError(
      `${field}.quantity must be an integer between ${String(DEMAND_MIN_QUANTITY)} and ${String(DEMAND_MAX_QUANTITY)} (got ${String(quantity)})`,
      { field: `${field}.quantity`, quantity: String(quantity) },
    );
  }
  let budgetBand: DemandBudgetBand | null = null;
  if (raw.budgetBand !== undefined && raw.budgetBand !== null) {
    const band = raw.budgetBand;
    if (typeof band !== "string" || !isDemandBudgetBand(band)) {
      throw new InvalidDemandError(
        `${field}.budgetBand must be a closed-vocabulary budget band (got ${String(band)}; vocabulary: ${DEMAND_BUDGET_BANDS.join(", ")})`,
        { field: `${field}.budgetBand`, budgetBand: String(band) },
      );
    }
    budgetBand = band;
  }
  return Object.freeze({ region, quantity, budgetBand });
}

/**
 * Validate a pool name: a non-empty bounded string (prose bound).
 */
export function validateDemandPoolName(
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidDemandError(`${field} must be a non-empty string`, {
      field,
    });
  }
  if (value.length > DEMAND_POOL_NAME_MAX_CHARS) {
    throw new InvalidDemandError(
      `${field} must be at most ${String(DEMAND_POOL_NAME_MAX_CHARS)} characters`,
      { field, length: value.length },
    );
  }
  return value;
}

/**
 * Validate the pool qualification policy at creation: the threshold
 * is a bounded integer (fail closed) and the version is pinned to the
 * current DEMAND_POLICY_VERSION. The policy is RECORDED on the pool
 * and only ever re-evaluated by the derivation — never
 * caller-asserted per evaluation.
 */
export function validateQualificationPolicy(
  field: string,
  raw: {
    readonly minimumCommitments?: unknown;
  },
): {
  readonly version: number;
  readonly minimumCommitments: number;
} {
  if (!raw || typeof raw !== "object") {
    throw new InvalidDemandError(`${field} is required`, { field });
  }
  const minimumCommitments = raw.minimumCommitments;
  if (
    typeof minimumCommitments !== "number" ||
    !Number.isInteger(minimumCommitments) ||
    minimumCommitments < DEMAND_MIN_QUALIFICATION_COMMITMENTS ||
    minimumCommitments > DEMAND_MAX_QUALIFICATION_COMMITMENTS
  ) {
    throw new InvalidDemandError(
      `${field}.minimumCommitments must be an integer between ${String(DEMAND_MIN_QUALIFICATION_COMMITMENTS)} and ${String(DEMAND_MAX_QUALIFICATION_COMMITMENTS)} (got ${String(minimumCommitments)})`,
      { field: `${field}.minimumCommitments`, minimumCommitments: String(minimumCommitments) },
    );
  }
  return Object.freeze({
    version: DEMAND_POLICY_VERSION,
    minimumCommitments,
  });
}
