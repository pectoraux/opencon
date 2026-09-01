/**
 * Shared supplier-offer / competitive-selection vocabulary (core
 * contracts) — NET-W026.
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/demand`, `/benefits` own demand aggregation and benefit
 * allocation), §9 (Demand architecture — Demand Signals → Demand Pool
 * → Qualified Aggregate Demand → Supplier Competition → Offer /
 * Contract; individual commercial terms remain private), §7 (the
 * frozen sixteen core domains — `/demand` was FROZEN from NET-W001;
 * NET-W024 implemented the consumer demand-pool domain INSIDE it,
 * NET-W025 extended the SAME boundary with business procurement
 * pools, and NET-W026 extends it AGAIN with supplier offers and
 * competitive selection — NO 17th domain), §14 (AI outputs remain
 * recommendations, never unilateral authority); spec/architecture-
 * lock.md §2 (the frozen domain list), §5 (economic authority —
 * untouched), §6 (privacy authority — aggregate evidence, never raw
 * personal data), §1 invariants 6 + 10.
 *
 * Work order ref: spec/work-orders/NET-W026.md
 * Requirements: DEM-003 (competitive supplier offers), PROC-001
 * (bounded to the offer/selection surface — verified savings are
 * NET-W027), PROC-003 (prevent unlawful exchange of commercially
 * sensitive competitor information).
 *
 * THE KEY RULES (work order §3 — authority separation):
 *  - `/demand` owns the supplier OFFER records, the competitive
 *    SELECTION lineage records, the versioned provider-neutral offer
 *    attribute vocabulary below, the server-derived hard-eligibility
 *    checks and the deterministic ranking/selection policy;
 *  - `/settlement` stays the economic authority: offers and
 *    selections create NO ledger entries, credits, cash obligations,
 *    stakes or rewards — a selection is a PROCUREMENT DECISION, never
 *    an economic mutation (there is no economic vocabulary here at
 *    all);
 *  - `/identity`, `/organizations`, `/participants` stay the
 *    membership/authorization authorities: the acting supplier's
 *    tenant membership resolves server-side through the neutral
 *    composition-root lookup (an "authorized supplier actor" is an
 *    ACTIVE tenant member — server-resolved, never a client claim);
 *  - `/workflows` stays the SOLE lifecycle authority and is UNTOUCHED
 *    (offer withdrawal is a ONE-WAY field mutation, never a status
 *    machine; offer expiry is DERIVED from the recorded validity
 *    window at the evaluation anchor — there is no expiry mutation);
 *  - hard eligibility is SERVER-DERIVED at ONE explicit evaluation
 *    anchor (the pool qualification re-derivation, the offer validity
 *    window, the named-demand region gate and the supplier
 *    authorization re-check); no caller assertion can ever make an
 *    offer eligible, rank it or select it;
 *  - the ranking policy is EXPLICIT, bounded, versioned and
 *    server-owned (the ordinal tables + the ranking-criteria list
 *    below); identical authoritative state + anchor produce the
 *    identical ranking/selection output.
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour.
 */

import {
  PROCUREMENT_QUANTITY_BUCKETS,
  PROCUREMENT_TIMING_WINDOWS,
  PROCUREMENT_UNIT_PRICE_BANDS,
  isProcurementRegionCode,
  isProcurementTimingWindow,
  isProcurementUnitPriceBand,
} from "./procurement.ts";
import type {
  ProcurementQuantityBucket,
  ProcurementRegionCode,
  ProcurementTimingWindow,
  ProcurementUnitPriceBand,
} from "./procurement.ts";
import { OpenConError } from "./errors.ts";

/** The quantity-bucket type predicate (fail-closed vocabulary check). */
function isProcurementQuantityBucketValue(
  value: string,
): value is ProcurementQuantityBucket {
  return (PROCUREMENT_QUANTITY_BUCKETS as readonly string[]).includes(value);
}

/**
 * The record-format lineage for the NET-W026 records (determinism:
 * the shape that governed a record's creation is reproducible).
 */
export const SUPPLIER_OFFER_RECORD_FORMAT = "NET-W026:1" as const;
export const COMPETITIVE_SELECTION_RECORD_FORMAT = "NET-W026:1" as const;

/**
 * The consent scope for supplier offers: exactly one closed value in
 * NET-W026 — the supplier consents (server-recorded, at submission)
 * to their offer's bounded attributes being COMPARED and RANKED in
 * the competitive selection of the named pool (and disclosed in the
 * pool-creator-scoped selection results). There is no other consent
 * scope in this vocabulary, so no caller assertion can ever expose a
 * supplier offer through any surface beyond the selection contract.
 */
export const SUPPLIER_OFFER_CONSENT_SCOPE = "competitive_selection" as const;

export type SupplierOfferConsentScope = typeof SUPPLIER_OFFER_CONSENT_SCOPE;

/** The offer consent-grant record version (server-written on submission). */
export const SUPPLIER_OFFER_CONSENT_VERSION = "NET-W026:1" as const;

/**
 * The offer validity horizon: an offer's caller-declared validity
 * window (`validUntil`, OPTIONAL — null means open until withdrawn)
 * may extend at most this many days past submission. Bounded so
 * selection lineage never depends on an unbounded future input.
 */
export const SUPPLIER_OFFER_MAX_VALIDITY_DAYS = 365;

/**
 * The versioned, server-owned competitive-selection policy: the
 * explicit ranking-criteria list (in evaluation order) recorded on
 * every selection view/record so the ordering that governed a
 * selection is always reproducible from the record itself.
 */
export const SUPPLIER_OFFER_SELECTION_POLICY_VERSION = 1;

export const SUPPLIER_OFFER_RANKING_CRITERIA = [
  "unit_price_band_ascending",
  "timing_window_ascending",
  "quantity_capacity_descending",
  "offer_id_ascending",
] as const;

/**
 * The unit-price ranking table: LOWER ordinal ranks FIRST (a cheaper
 * price band outranks a more expensive one). The table reuses the
 * closed NET-W025 unit-price band vocabulary — an exact price is
 * unrepresentable, so ranking operates on the SAME minimized bands
 * the qualified demand contract discloses (PROC-003: supplier terms
 * cross only as bands; buyer terms never cross at all).
 */
export const SUPPLIER_OFFER_UNIT_PRICE_RANK: readonly ProcurementUnitPriceBand[] =
  [...PROCUREMENT_UNIT_PRICE_BANDS];

/**
 * The delivery-timing ranking table: LOWER ordinal ranks FIRST (a
 * shorter delivery window outranks a longer one), reusing the closed
 * NET-W025 timing-window vocabulary.
 */
export const SUPPLIER_OFFER_TIMING_RANK: readonly ProcurementTimingWindow[] =
  [...PROCUREMENT_TIMING_WINDOWS];

/**
 * The capacity ranking table: LOWER ordinal ranks FIRST — the table
 * is the REVERSED NET-W025 quantity-bucket vocabulary, so a LARGER
 * capacity bucket outranks a smaller one. Ranking operates on the
 * same fixed buckets (an exact offered quantity is unrepresentable).
 */
export const SUPPLIER_OFFER_CAPACITY_RANK: readonly ProcurementQuantityBucket[] =
  [...PROCUREMENT_QUANTITY_BUCKETS].reverse();

/**
 * The ordinal triple of one offer's ranking attributes (lower is
 * better on every axis; the final tie-break is the stable offer id,
 * applied by the selection engine — the W021 deterministic
 * orderCandidates precedent).
 */
export function supplierOfferRankOrdinals(attributes: {
  readonly unitPriceBand: ProcurementUnitPriceBand;
  readonly timingWindow: ProcurementTimingWindow;
  readonly quantityBucket: ProcurementQuantityBucket;
}): {
  readonly priceOrdinal: number;
  readonly timingOrdinal: number;
  readonly capacityOrdinal: number;
} {
  return Object.freeze({
    priceOrdinal: SUPPLIER_OFFER_UNIT_PRICE_RANK.indexOf(
      attributes.unitPriceBand,
    ),
    timingOrdinal: SUPPLIER_OFFER_TIMING_RANK.indexOf(
      attributes.timingWindow,
    ),
    capacityOrdinal: SUPPLIER_OFFER_CAPACITY_RANK.indexOf(
      attributes.quantityBucket,
    ),
  });
}

/**
 * Validation error for supplier-offer request violations (NET-W026):
 * malformed offer inputs, vocabulary or bounds violations, and the
 * qualified-demand/validity gate failures.
 */
export class InvalidSupplierOfferError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "SUPPLIER_OFFER_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Stable conflict on offer state (DEM-003): ONE ACTIVE (non-withdrawn)
 * offer per (pool, supplier) — one competitive voice per supplier per
 * pool; a second active offer by the same supplier conflicts
 * deterministically (machine-readable poolId context). A WITHDRAWN
 * offer never blocks re-offering (the supplier may re-enter under a
 * new record).
 */
export class SupplierOfferConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "SUPPLIER_OFFER_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * Validate the declared offer attributes (work order §4.1 — bounded,
 * provider-neutral, fail closed, matching the qualified demand
 * contract): a REQUIRED region, unit-price band, delivery-timing
 * window and capacity bucket, each from the CLOSED NET-W025
 * vocabularies. Exact prices, exact quantities and exact timing are
 * unrepresentable — only bands/buckets/windows exist (PROC-003).
 */
export function validateSupplierOfferAttributes(
  field: string,
  raw: {
    readonly region?: unknown;
    readonly unitPriceBand?: unknown;
    readonly timingWindow?: unknown;
    readonly quantityBucket?: unknown;
  },
): {
  readonly region: ProcurementRegionCode;
  readonly unitPriceBand: ProcurementUnitPriceBand;
  readonly timingWindow: ProcurementTimingWindow;
  readonly quantityBucket: ProcurementQuantityBucket;
} {
  if (!raw || typeof raw !== "object") {
    throw new InvalidSupplierOfferError(`${field} is required`, { field });
  }
  const region = raw.region;
  if (typeof region !== "string" || !isProcurementRegionCode(region)) {
    throw new InvalidSupplierOfferError(
      `${field}.region must be a closed-vocabulary demand region code (got ${String(region)}; vocabulary: the 12 DEMAND_REGION_CODES shared with NET-W024/W025)`,
      { field: `${field}.region`, region: String(region) },
    );
  }
  const unitPriceBand = raw.unitPriceBand;
  if (
    typeof unitPriceBand !== "string" ||
    !isProcurementUnitPriceBand(unitPriceBand)
  ) {
    throw new InvalidSupplierOfferError(
      `${field}.unitPriceBand must be a closed-vocabulary unit-price band (got ${String(unitPriceBand)}; vocabulary: ${PROCUREMENT_UNIT_PRICE_BANDS.join(", ")})`,
      {
        field: `${field}.unitPriceBand`,
        unitPriceBand: String(unitPriceBand),
      },
    );
  }
  const timingWindow = raw.timingWindow;
  if (
    typeof timingWindow !== "string" ||
    !isProcurementTimingWindow(timingWindow)
  ) {
    throw new InvalidSupplierOfferError(
      `${field}.timingWindow must be a closed-vocabulary delivery-timing window (got ${String(timingWindow)}; vocabulary: ${PROCUREMENT_TIMING_WINDOWS.join(", ")})`,
      {
        field: `${field}.timingWindow`,
        timingWindow: String(timingWindow),
      },
    );
  }
  const quantityBucket = raw.quantityBucket;
  if (
    typeof quantityBucket !== "string" ||
    !isProcurementQuantityBucketValue(quantityBucket)
  ) {
    throw new InvalidSupplierOfferError(
      `${field}.quantityBucket must be a closed-vocabulary quantity bucket (got ${String(quantityBucket)}; vocabulary: ${PROCUREMENT_QUANTITY_BUCKETS.join(", ")})`,
      {
        field: `${field}.quantityBucket`,
        quantityBucket: String(quantityBucket),
      },
    );
  }
  return Object.freeze({
    region,
    unitPriceBand,
    timingWindow,
    quantityBucket,
  });
}

/**
 * Validate the declared validity window (work order §4.1 — explicit
 * validity/effective windows): `validUntil` is OPTIONAL (null = open
 * until withdrawn); when present it must be a parseable ISO
 * timestamp STRICTLY after `now` (the submission anchor, supplied by
 * the caller — no wall clock inside the pure helper) and within
 * SUPPLIER_OFFER_MAX_VALIDITY_DAYS of it. `validFrom` is ALWAYS
 * server-set to the submission instant (there is no validFrom
 * input). Expiry is later DERIVED at each evaluation anchor from the
 * recorded window — it is never a mutation.
 */
export function validateSupplierOfferValidity(
  field: string,
  raw: unknown,
  now: string,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InvalidSupplierOfferError(
      `${field}.validUntil must be an ISO timestamp string or null`,
      { field: `${field}.validUntil` },
    );
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new InvalidSupplierOfferError(
      `${field}.validUntil must be a parseable ISO timestamp (got ${raw})`,
      { field: `${field}.validUntil`, validUntil: raw },
    );
  }
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new InvalidSupplierOfferError(
      `${field}: the submission anchor is not a parseable ISO timestamp`,
      { field, now },
    );
  }
  if (parsed <= nowMs) {
    throw new InvalidSupplierOfferError(
      `${field}.validUntil must be strictly after the submission time (got ${raw})`,
      { field: `${field}.validUntil`, validUntil: raw },
    );
  }
  const maxValidUntilMs =
    nowMs + SUPPLIER_OFFER_MAX_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
  if (parsed > maxValidUntilMs) {
    throw new InvalidSupplierOfferError(
      `${field}.validUntil may extend at most ${String(SUPPLIER_OFFER_MAX_VALIDITY_DAYS)} days past submission (got ${raw})`,
      { field: `${field}.validUntil`, validUntil: raw },
    );
  }
  return raw;
}
