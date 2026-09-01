/**
 * Shared procurement vocabulary (core contracts) — NET-W025.
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/demand`, `/benefits` own demand aggregation and benefit
 * allocation), §9 (Demand architecture — Demand Signals → Demand Pool
 * → Qualified Aggregate Demand → Supplier Competition; individual
 * commercial terms remain private), §7 (the frozen sixteen core
 * domains — `/demand` was FROZEN from NET-W001; NET-W024 implemented
 * the consumer demand-pool domain INSIDE it and NET-W025 extends the
 * SAME boundary with business procurement pools — NO 17th domain);
 * spec/architecture-lock.md §2 (the frozen domain list), §5 (economic
 * authority — untouched), §6 (privacy authority — aggregate evidence
 * proves integrity without publishing raw personal data), §1
 * invariants 6 + 10.
 *
 * Work order ref: spec/work-orders/NET-W025.md
 * Requirements: DEM-001 (consumer AND business Demand Pools), DEM-002
 * (privacy-preserving aggregation), PROC-003 (prevent unlawful
 * exchange of commercially sensitive competitor information);
 * PROC-001 is bounded to the demand → qualification →
 * supplier-discovery surface (offers/selection are NET-W026, savings
 * are NET-W027).
 *
 * THE KEY RULES (work order §2 — authority separation):
 *  - `/demand` owns the procurement POOL and business COMMITMENT
 *    records, the versioned provider-neutral procurement
 *    category/attribute vocabulary below, the privacy/competition
 *    aggregation and qualification derivation, and the
 *    supplier-facing minimized demand contract;
 *  - `/settlement` stays the economic authority: procurement pools
 *    create NO ledger entries, credits, cash obligations, stakes or
 *    rewards (there is no economic vocabulary here at all);
 *  - `/identity`, `/organizations`, `/participants` stay the
 *    membership/authorization authorities: the acting person's
 *    tenant AND buyer-organization memberships resolve server-side
 *    through the neutral composition-root lookup;
 *  - `/workflows` stays the SOLE lifecycle authority and is UNTOUCHED
 *    (pool closure and commitment withdrawal are ONE-WAY field
 *    mutations, never status machines);
 *  - the TWO FROZEN DISCLOSURE FLOORS — the commitment floor AND the
 *    distinct-organization (competition) floor — cannot be lowered or
 *    bypassed by ANY pool policy or caller input (DEM-002 / PRIV-003 /
 *    PROC-003).
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour.
 */

import { isDemandRegionCode, type DemandRegionCode } from "./demand.ts";
import { OpenConError } from "./errors.ts";

/**
 * The record-format lineage for the NET-W025 records (determinism:
 * the shape that governed a record's creation is reproducible).
 */
export const PROCUREMENT_POOL_RECORD_FORMAT = "NET-W025:1" as const;
export const PROCUREMENT_COMMITMENT_RECORD_FORMAT = "NET-W025:1" as const;

/**
 * The procurement category keys (DEM-001 / the business side of the
 * demand vocabulary): the closed, versioned, provider-neutral
 * vocabulary of business procurement verticals a pool may aggregate.
 * Category names are generic business verticals — provider/vendor/
 * brand identities never appear (provider-specific vocabulary stays
 * behind /adapters; the categories are deliberately coarse so
 * aggregates remain non-identifying).
 */
export const PROCUREMENT_CATEGORY_KEYS = [
  "cloud_infrastructure",
  "software_licensing",
  "professional_services",
  "logistics_freight",
  "manufacturing_materials",
  "facilities_maintenance",
  "energy_supply",
  "marketing_agency",
] as const;

export type ProcurementCategoryKey =
  (typeof PROCUREMENT_CATEGORY_KEYS)[number];

/** The procurement category vocabulary version (bumped when the set changes). */
export const PROCUREMENT_CATEGORY_VERSION = "1" as const;

export function isProcurementCategoryKey(
  value: string,
): value is ProcurementCategoryKey {
  return (PROCUREMENT_CATEGORY_KEYS as readonly string[]).includes(value);
}

/**
 * The commitment region codes: the closed, provider-neutral
 * macro-region vocabulary REUSED from the NET-W024 demand contracts
 * (`DEMAND_REGION_CODES` — the same 12 neutral macro-regions for both
 * the consumer and business demand surfaces; coarse macro-regions,
 * never city/postal granularity, keep aggregates non-identifying).
 * This re-export keeps the procurement vocabulary self-describing.
 */
export type ProcurementRegionCode = DemandRegionCode;

export function isProcurementRegionCode(
  value: string,
): value is ProcurementRegionCode {
  return isDemandRegionCode(value);
}

/**
 * The commitment quantity bounds: the committed quantity is a
 * bounded integer (fail closed outside 1..1000000 — business scale).
 * Quantities NEVER cross to supplier-facing views as exact
 * per-organization values — only the fixed-bucket distribution
 * below does (PROC-003).
 */
export const PROCUREMENT_MIN_QUANTITY = 1;
export const PROCUREMENT_MAX_QUANTITY = 1000000;

/**
 * The fixed quantity buckets for the aggregate distribution (the
 * privacy-preserving quantity disclosure: buckets, never exact
 * per-organization quantities — DEM-002 / PROC-003; business scale).
 */
export const PROCUREMENT_QUANTITY_BUCKETS = [
  "q_1_9",
  "q_10_99",
  "q_100_999",
  "q_1000_9999",
  "q_10000_plus",
] as const;

export type ProcurementQuantityBucket =
  (typeof PROCUREMENT_QUANTITY_BUCKETS)[number];

/** Map a bounded commitment quantity to its fixed bucket. */
export function procurementQuantityBucket(
  quantity: number,
): ProcurementQuantityBucket {
  if (quantity < 10) return "q_1_9";
  if (quantity < 100) return "q_10_99";
  if (quantity < 1000) return "q_100_999";
  if (quantity < 10000) return "q_1000_9999";
  return "q_10000_plus";
}

/**
 * The commitment budget bands: the closed, currency-neutral
 * spend-band vocabulary for the OPTIONAL commitment attribute
 * (business scale). Bands (never exact amounts) keep supplier-facing
 * aggregates non-identifying (DEM-002 / PROC-003).
 */
export const PROCUREMENT_BUDGET_BANDS = [
  "band_a_under_1k",
  "band_b_1k_9k",
  "band_c_10k_99k",
  "band_d_100k_999k",
  "band_e_1m_plus",
] as const;

export type ProcurementBudgetBand =
  (typeof PROCUREMENT_BUDGET_BANDS)[number];

export function isProcurementBudgetBand(
  value: string,
): value is ProcurementBudgetBand {
  return (PROCUREMENT_BUDGET_BANDS as readonly string[]).includes(value);
}

/**
 * The commitment unit-price bands: the closed, currency-neutral
 * per-unit price-band vocabulary for the OPTIONAL commitment
 * attribute. PRICES ARE THE MOST COMPETITIVELY SENSITIVE ATTRIBUTE
 * (PROC-003): they cross to supplier-facing views ONLY as these
 * fixed bands — an exact unit price is unrepresentable in any
 * aggregate output.
 */
export const PROCUREMENT_UNIT_PRICE_BANDS = [
  "price_a_under_10",
  "price_b_10_49",
  "price_c_50_99",
  "price_d_100_499",
  "price_e_500_plus",
] as const;

export type ProcurementUnitPriceBand =
  (typeof PROCUREMENT_UNIT_PRICE_BANDS)[number];

export function isProcurementUnitPriceBand(
  value: string,
): value is ProcurementUnitPriceBand {
  return (PROCUREMENT_UNIT_PRICE_BANDS as readonly string[]).includes(
    value,
  );
}

/**
 * The delivery-timing windows: the closed, coarse delivery-horizon
 * vocabulary for the OPTIONAL commitment attribute. TIMING IS
 * COMPETITIVELY SENSITIVE (PROC-003): it crosses to supplier-facing
 * views ONLY as these coarse windows — an exact delivery date or
 * deadline is unrepresentable in any aggregate output.
 */
export const PROCUREMENT_TIMING_WINDOWS = [
  "window_immediate",
  "window_short_1_3mo",
  "window_medium_3_6mo",
  "window_long_6_12mo",
  "window_extended_12mo_plus",
] as const;

export type ProcurementTimingWindow =
  (typeof PROCUREMENT_TIMING_WINDOWS)[number];

export function isProcurementTimingWindow(
  value: string,
): value is ProcurementTimingWindow {
  return (PROCUREMENT_TIMING_WINDOWS as readonly string[]).includes(
    value,
  );
}

/**
 * THE FROZEN COMMITMENT DISCLOSURE FLOOR (DEM-002 / PRIV-003 — the
 * k-anonymity floor of this surface): NO aggregate fact — including
 * the commitment count itself — is emitted in any supplier-facing
 * view unless the active commitment count is at least this many.
 * This is a CONSTANT: no pool policy, caller input or configuration
 * can lower it (issue #50: aggregate thresholds "are server-derived
 * and cannot be caller-asserted or lowered by pool input").
 */
export const PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS = 3;

/**
 * THE FROZEN DISTINCT-ORGANIZATION DISCLOSURE FLOOR (PROC-003 — the
 * competition floor, the NET-W025 addition to the W024 privacy
 * model): NO aggregate fact — including the commitment count and the
 * organization count — is emitted unless the commitments span at
 * least this many DISTINCT buyer organizations. Below this floor a
 * single buyer (or a two-buyer duopoly) could be identified and its
 * exact commercial terms reconstructed from "aggregate" output, so
 * the aggregate suppresses entirely. This is a CONSTANT: no pool
 * policy, caller input or configuration can lower it.
 */
export const PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS = 3;

/**
 * The consent scope for procurement commitments: exactly one closed
 * value in NET-W025 — the buyer consents (server-recorded, at
 * submission) to AGGREGATE-ONLY disclosure of this commitment's
 * banded attributes to supplier-facing views. There is no
 * individual-disclosure consent in this vocabulary, so no caller
 * assertion can ever expose an individual business commitment or
 * attribute a fact to a single organization through the aggregate
 * surface (issue #50: no caller assertion may fabricate membership
 * or qualification).
 */
export const PROCUREMENT_CONSENT_SCOPE = "aggregate_disclosure" as const;

export type ProcurementConsentScope = typeof PROCUREMENT_CONSENT_SCOPE;

/** The consent-grant record version (server-written on submission). */
export const PROCUREMENT_CONSENT_VERSION = "NET-W025:1" as const;

/**
 * Qualification/competition-policy bounds: the pool's thresholds
 * (`minimumCommitments` on active commitments AND
 * `minimumOrganizations` on distinct buyer organizations) are
 * bounded integers the pool creator sets ONCE at creation (versioned
 * policy on the record); qualification is then only ever DERIVED
 * (never caller-asserted). The distinct-organization threshold is
 * the competition-policy dimension of issue #50.
 */
export const PROCUREMENT_POLICY_VERSION = 1;
export const PROCUREMENT_MIN_QUALIFICATION_COMMITMENTS = 1;
export const PROCUREMENT_MAX_QUALIFICATION_COMMITMENTS = 10000;
export const PROCUREMENT_MIN_QUALIFICATION_ORGANIZATIONS = 1;
export const PROCUREMENT_MAX_QUALIFICATION_ORGANIZATIONS = 10000;

/** Prose bounds (pool names, closure/withdrawal reasons). */
export const PROCUREMENT_POOL_NAME_MAX_CHARS = 200;
export const PROCUREMENT_MAX_PROSE_CHARS = 2000;

/**
 * Validation error for procurement request violations (NET-W025):
 * malformed pool/commitment inputs, vocabulary or bounds violations.
 */
export class InvalidProcurementError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "PROCUREMENT_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Stable conflict on commitment state (DEM-001): ONE ACTIVE
 * (non-withdrawn) commitment per (pool, submitter) — the acting
 * person holds ONE demand voice per pool; a second active commitment
 * by the same person conflicts deterministically (machine-readable
 * poolId context). A buyer organization MAY hold multiple active
 * commitments submitted by DIFFERENT authorized members (the
 * distinct-organization floor then governs disclosure — the
 * commitment count and the organization count stay INDEPENDENT
 * dimensions). A WITHDRAWN commitment never blocks re-commitment
 * (the buyer may re-enter under a new record).
 */
export class ProcurementCommitmentConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "PROCUREMENT_COMMITMENT_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * Validate the declared commitment attributes (DEM-002 / PROC-003 —
 * bounded, provider-neutral, fail closed): a REQUIRED region from
 * the closed macro-region vocabulary (reused from the W024 demand
 * contracts), a REQUIRED bounded quantity, and OPTIONAL budget /
 * unit-price / delivery-timing values from their closed band/window
 * vocabularies. Exact amounts, exact unit prices and exact timing
 * are unrepresentable — only bands/buckets/windows exist.
 */
export function validateProcurementAttributes(
  field: string,
  raw: {
    readonly region?: unknown;
    readonly quantity?: unknown;
    readonly budgetBand?: unknown;
    readonly unitPriceBand?: unknown;
    readonly timingWindow?: unknown;
  },
): {
  readonly region: ProcurementRegionCode;
  readonly quantity: number;
  readonly budgetBand: ProcurementBudgetBand | null;
  readonly unitPriceBand: ProcurementUnitPriceBand | null;
  readonly timingWindow: ProcurementTimingWindow | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new InvalidProcurementError(`${field} is required`, { field });
  }
  const region = raw.region;
  if (typeof region !== "string" || !isProcurementRegionCode(region)) {
    throw new InvalidProcurementError(
      `${field}.region must be a closed-vocabulary demand region code (got ${String(region)}; vocabulary: the 12 DEMAND_REGION_CODES shared with NET-W024)`,
      { field: `${field}.region`, region: String(region) },
    );
  }
  const quantity = raw.quantity;
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < PROCUREMENT_MIN_QUANTITY ||
    quantity > PROCUREMENT_MAX_QUANTITY
  ) {
    throw new InvalidProcurementError(
      `${field}.quantity must be an integer between ${String(PROCUREMENT_MIN_QUANTITY)} and ${String(PROCUREMENT_MAX_QUANTITY)} (got ${String(quantity)})`,
      { field: `${field}.quantity`, quantity: String(quantity) },
    );
  }
  let budgetBand: ProcurementBudgetBand | null = null;
  if (raw.budgetBand !== undefined && raw.budgetBand !== null) {
    const band = raw.budgetBand;
    if (typeof band !== "string" || !isProcurementBudgetBand(band)) {
      throw new InvalidProcurementError(
        `${field}.budgetBand must be a closed-vocabulary procurement budget band (got ${String(band)}; vocabulary: ${PROCUREMENT_BUDGET_BANDS.join(", ")})`,
        { field: `${field}.budgetBand`, budgetBand: String(band) },
      );
    }
    budgetBand = band;
  }
  let unitPriceBand: ProcurementUnitPriceBand | null = null;
  if (raw.unitPriceBand !== undefined && raw.unitPriceBand !== null) {
    const band = raw.unitPriceBand;
    if (typeof band !== "string" || !isProcurementUnitPriceBand(band)) {
      throw new InvalidProcurementError(
        `${field}.unitPriceBand must be a closed-vocabulary unit-price band (got ${String(band)}; vocabulary: ${PROCUREMENT_UNIT_PRICE_BANDS.join(", ")})`,
        { field: `${field}.unitPriceBand`, unitPriceBand: String(band) },
      );
    }
    unitPriceBand = band;
  }
  let timingWindow: ProcurementTimingWindow | null = null;
  if (raw.timingWindow !== undefined && raw.timingWindow !== null) {
    const window = raw.timingWindow;
    if (typeof window !== "string" || !isProcurementTimingWindow(window)) {
      throw new InvalidProcurementError(
        `${field}.timingWindow must be a closed-vocabulary delivery-timing window (got ${String(window)}; vocabulary: ${PROCUREMENT_TIMING_WINDOWS.join(", ")})`,
        { field: `${field}.timingWindow`, timingWindow: String(window) },
      );
    }
    timingWindow = window;
  }
  return Object.freeze({
    region,
    quantity,
    budgetBand,
    unitPriceBand,
    timingWindow,
  });
}

/**
 * Validate a procurement pool name: a non-empty bounded string
 * (prose bound).
 */
export function validateProcurementPoolName(
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidProcurementError(
      `${field} must be a non-empty string`,
      { field },
    );
  }
  if (value.length > PROCUREMENT_POOL_NAME_MAX_CHARS) {
    throw new InvalidProcurementError(
      `${field} must be at most ${String(PROCUREMENT_POOL_NAME_MAX_CHARS)} characters`,
      { field, length: value.length },
    );
  }
  return value;
}

/**
 * Validate the pool qualification/competition policy at creation:
 * BOTH thresholds are bounded integers (fail closed) and the version
 * is pinned to the current PROCUREMENT_POLICY_VERSION. The policy is
 * RECORDED on the pool and only ever re-evaluated by the derivation
 * — never caller-asserted per evaluation. Neither threshold can
 * lower the frozen disclosure floors (the floors gate DISCLOSURE;
 * the policy governs qualification — both are always enforced).
 */
export function validateProcurementQualificationPolicy(
  field: string,
  raw: {
    readonly minimumCommitments?: unknown;
    readonly minimumOrganizations?: unknown;
  },
): {
  readonly version: number;
  readonly minimumCommitments: number;
  readonly minimumOrganizations: number;
} {
  if (!raw || typeof raw !== "object") {
    throw new InvalidProcurementError(`${field} is required`, { field });
  }
  const minimumCommitments = raw.minimumCommitments;
  if (
    typeof minimumCommitments !== "number" ||
    !Number.isInteger(minimumCommitments) ||
    minimumCommitments < PROCUREMENT_MIN_QUALIFICATION_COMMITMENTS ||
    minimumCommitments > PROCUREMENT_MAX_QUALIFICATION_COMMITMENTS
  ) {
    throw new InvalidProcurementError(
      `${field}.minimumCommitments must be an integer between ${String(PROCUREMENT_MIN_QUALIFICATION_COMMITMENTS)} and ${String(PROCUREMENT_MAX_QUALIFICATION_COMMITMENTS)} (got ${String(minimumCommitments)})`,
      {
        field: `${field}.minimumCommitments`,
        minimumCommitments: String(minimumCommitments),
      },
    );
  }
  const minimumOrganizations = raw.minimumOrganizations;
  if (
    typeof minimumOrganizations !== "number" ||
    !Number.isInteger(minimumOrganizations) ||
    minimumOrganizations < PROCUREMENT_MIN_QUALIFICATION_ORGANIZATIONS ||
    minimumOrganizations > PROCUREMENT_MAX_QUALIFICATION_ORGANIZATIONS
  ) {
    throw new InvalidProcurementError(
      `${field}.minimumOrganizations must be an integer between ${String(PROCUREMENT_MIN_QUALIFICATION_ORGANIZATIONS)} and ${String(PROCUREMENT_MAX_QUALIFICATION_ORGANIZATIONS)} (got ${String(minimumOrganizations)})`,
      {
        field: `${field}.minimumOrganizations`,
        minimumOrganizations: String(minimumOrganizations),
      },
    );
  }
  return Object.freeze({
    version: PROCUREMENT_POLICY_VERSION,
    minimumCommitments,
    minimumOrganizations,
  });
}
