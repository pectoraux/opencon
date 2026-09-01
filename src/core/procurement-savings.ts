/**
 * Shared procurement-savings / counterfactual-baseline vocabulary
 * (core contracts) — NET-W027.
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/demand`, `/benefits` own demand aggregation and benefit
 * allocation), §9 (Demand architecture — Demand Signals → Demand
 * Pool → Qualified Aggregate Demand → Supplier Competition →
 * Offer / Contract; individual commercial terms remain private),
 * §13 (measurement architecture — counterfactual savings
 * measurement; ALL economically material values retain
 * confidence/uncertainty), §7 (the frozen sixteen core domains —
 * `/demand` was FROZEN from NET-W001; NET-W024/W025/W026 already
 * extended the SAME boundary; NET-W027 extends it AGAIN with
 * verified savings and counterfactuals — NO 17th domain), §14 (AI
 * outputs remain recommendations, never unilateral authority);
 * spec/architecture-lock.md §2 (the frozen domain list), §4 (model
 * output is input evidence, never authoritative), §5 (economic
 * authority — untouched), §6 (privacy authority).
 *
 * Work order ref: spec/work-orders/NET-W027.md
 * Requirements: PROC-002 (savings require evidence-supported
 * counterfactual/baseline), with OUT-004/EVID-005 vocabulary
 * alignment (counterfactual value measurement; preserved
 * uncertainty) — the measurement vocabulary itself is REUSED from
 * the NET-W005/NET-W006 core contracts (BaselineKind,
 * ConfidenceEstimate, the evidence source types) and NEVER
 * redefined here (/outcomes stays the measurement authority,
 * /evidence stays the provenance/truth authority).
 *
 * THE KEY RULES (work order §3 — authority separation):
 *  - `/demand` owns the BASELINE records (explicit kind + method +
 *    version + comparison window + population + value + confidence
 *    + provenance + evidence references), the counterfactual
 *    REPRESENTATION (the `counterfactual` BaselineKind with its
 *    mandatory quantified interval — the NET-W006
 *    CounterfactualBaseline rule), the versioned savings-derivation
 *    policy and the immutable savings lineage records;
 *  - `/outcomes` stays the normalized measurement authority: the
 *    realized-outcome facts a savings derivation consumes are
 *    OutcomeObservation records (outcomeType "savings" — the
 *    OUT-001 vocabulary value) resolved read-only through a NEUTRAL
 *    composition-root lookup; this file fabricates no measurement
 *    semantics and redefines none;
 *  - `/evidence` stays the provenance/truth authority: a baseline
 *    REQUIRES ≥1 traceable evidence references (subject-bound to
 *    the procurement pool, resolved through a neutral lookup); the
 *    qualifying source-type set below mirrors the frozen
 *    architecture-lock §4 rule (model/self output alone is input
 *    evidence, never authoritative — the separate-constant
 *    precedent of QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES);
 *  - `/settlement` stays the economic authority: a verified savings
 *    claim is a MEASUREMENT DECISION, never an economic mutation
 *    (there is no economic vocabulary here at all — W028 Benefit
 *    Pool semantics are explicitly excluded);
 *  - savings are claims about REALIZED OUTCOMES, never offers: no
 *    offer price, spend, reputation, raw activity or caller
 *    arithmetic is part of this vocabulary (the W026 offer/selection
 *    context enters savings lineage as neutral references only);
 *  - uncertainty is FIRST-CLASS: a `counterfactual` baseline
 *    REQUIRES a quantified confidence interval [lower, upper] — an
 *    exact counterfactual claim without quantified uncertainty is
 *    manufactured and rejected (the NET-W006 baseline-service rule,
 *    architecture §13);
 *  - `/workflows` stays the SOLE lifecycle authority and is
 *    UNTOUCHED (baseline invalidation is a ONE-WAY field mutation,
 *    never a status machine; evidence staleness and observation
 *    supersession are DERIVED at the evaluation anchor — there is
 *    no staleness mutation).
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour.
 */

import { OpenConError } from "./errors.ts";
import type { BaselineKind } from "./measurement.ts";
import { isBaselineKind } from "./measurement.ts";
import type { ConfidenceEstimate } from "./evidence.ts";
import { validateConfidenceEstimate } from "./evidence.ts";
import { PROCUREMENT_MAX_PROSE_CHARS } from "./procurement.ts";

/**
 * The record-format lineage for the NET-W027 records (determinism:
 * the shape that governed a record's creation is reproducible).
 */
export const PROCUREMENT_BASELINE_RECORD_FORMAT = "NET-W027:1" as const;
export const PROCUREMENT_SAVINGS_RECORD_FORMAT = "NET-W027:1" as const;

/**
 * The closed baseline-method vocabulary (work order §4.1 — explicit
 * methods): HOW the baseline/counterfactual reference value was
 * established. Exactly these four provider-neutral methods exist in
 * NET-W027 — an unknown method fails closed, and the method identity
 * is always paired with an explicit per-record methodVersion (method
 * identity is never collapsed).
 */
export const PROCUREMENT_BASELINE_METHODS = [
  "prior_period",
  "matched_control",
  "market_index",
  "contracted_reference",
] as const;

export type ProcurementBaselineMethod =
  (typeof PROCUREMENT_BASELINE_METHODS)[number];

export function isProcurementBaselineMethod(
  value: string,
): value is ProcurementBaselineMethod {
  return (PROCUREMENT_BASELINE_METHODS as readonly string[]).includes(value);
}

/**
 * The closed one-way invalidation-reason vocabulary (work order
 * §4.1/§4.2 — explicit invalidation semantics): an invalidated
 * baseline can never again support a savings derivation (fail-closed
 * re-derivation, never a status transition).
 */
export const PROCUREMENT_BASELINE_INVALIDATION_REASONS = [
  "population_changed",
  "method_superseded",
  "evidence_withdrawn",
  "quality_review",
] as const;

export type ProcurementBaselineInvalidationReason =
  (typeof PROCUREMENT_BASELINE_INVALIDATION_REASONS)[number];

export function isProcurementBaselineInvalidationReason(
  value: string,
): value is ProcurementBaselineInvalidationReason {
  return (
    PROCUREMENT_BASELINE_INVALIDATION_REASONS as readonly string[]
  ).includes(value);
}

/**
 * The comparison-window bounds (work order §4.1 — explicit windows):
 * the baseline's population/comparison window is HISTORICAL (it ends
 * no later than the submission anchor — the baseline population was
 * measured in the past) and bounded to 1..365 days so savings lineage
 * never depends on an unbounded window.
 */
export const PROCUREMENT_BASELINE_COMPARISON_WINDOW_MIN_DAYS = 1;
export const PROCUREMENT_BASELINE_COMPARISON_WINDOW_MAX_DAYS = 365;

/** The maximum number of evidence references on one baseline. */
export const PROCUREMENT_BASELINE_MAX_EVIDENCE_REFS = 8;

/** The maximum number of outcome observations in one savings derivation. */
export const PROCUREMENT_SAVINGS_MAX_OBSERVATIONS = 8;

/**
 * The frozen evidence-staleness bound (work order §4.5 — explicit
 * fail-closed staleness): the baseline's comparison-window end AND
 * every contributing observation's provenance collectedAt must be
 * within this many days of the ONE explicit evaluation anchor, or
 * the evidence is STALE and the derivation fails closed for
 * authoritative use. Staleness is DERIVED at the anchor — it is
 * never a mutation.
 */
export const PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS = 365;

/** The bounded value domain of baseline/observed amounts. */
export const PROCUREMENT_SAVINGS_MIN_VALUE = 0;
export const PROCUREMENT_SAVINGS_MAX_VALUE = 1_000_000_000;

/** The bounded unit label length (units are compared for consistency). */
export const PROCUREMENT_SAVINGS_UNIT_MAX_CHARS = 32;

/** The bounded method-version label length. */
export const PROCUREMENT_SAVINGS_METHOD_VERSION_MAX_CHARS = 64;

/**
 * The subject-type binding of every W027 evidence reference and
 * savings outcome observation: the procurement POOL (the subject the
 * baseline/observation facts are about). Neutral, provider-neutral,
 * and shared with the NET-W005/NET-W006 free-form subject
 * vocabularies.
 */
export const PROCUREMENT_SAVINGS_SUBJECT_TYPE = "procurement_pool";

/**
 * The evidence source types that qualify to support a savings
 * derivation (the architecture-lock §4 rule, frozen independently —
 * the QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES separate-constant
 * precedent): `model` and `self` output alone is INPUT evidence,
 * never authoritative for a verified savings claim.
 */
export const PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES = [
  "platform",
  "attested",
  "provider",
] as const;

export type ProcurementSavingsQualifyingSourceType =
  (typeof PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES)[number];

export function isProcurementSavingsQualifyingSourceType(
  value: string,
): value is ProcurementSavingsQualifyingSourceType {
  return (
    PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES as readonly string[]
  ).includes(value);
}

/**
 * The versioned, server-owned savings-derivation policy: the
 * explicit method label + criteria list recorded on every derived
 * view/record so the derivation that governed a savings claim is
 * always reproducible from the record itself (the W026
 * selection-policy precedent).
 */
export const PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION = 1;

/** The derivation method label (versioned; deterministic arithmetic). */
export const PROCUREMENT_SAVINGS_DERIVATION_METHOD =
  "baseline-minus-observed-conservative" as const;

export const PROCUREMENT_SAVINGS_DERIVATION_CRITERIA = [
  "baseline_present_and_valid",
  "baseline_kind_interval",
  "baseline_evidence_supported",
  "baseline_evidence_fresh",
  "observation_present",
  "observation_supported",
  "observation_chain_head",
  "observation_subject_bound",
  "observation_outcome_type_savings",
  "observation_evidence_fresh",
  "unit_consistent",
  "uncertainty_preserved",
] as const;

/**
 * Validation error for procurement-savings/baseline request
 * violations (NET-W027): malformed inputs, vocabulary or bounds
 * violations, provenance/confidence violations, and evidence
 * reference/sufficiency gate failures.
 */
export class InvalidProcurementSavingsError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "PROCUREMENT_SAVINGS_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Stable conflict on savings/baseline state (PROC-002): a one-way
 * invalidation of an ALREADY-invalidated baseline conflicts
 * deterministically (machine-readable baselineId context).
 */
export class ProcurementSavingsConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "PROCUREMENT_SAVINGS_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

/**
 * Validate the declared baseline attributes (work order §4.1 —
 * explicit, bounded, fail closed): the REQUIRED closed-vocabulary
 * baseline kind (the NET-W006 BaselineKind, reused verbatim) +
 * method, the REQUIRED methodVersion, the bounded HISTORICAL
 * comparison window, the bounded population description, and the
 * bounded baseline value + unit. `now` is the submission anchor,
 * supplied by the caller — no wall clock inside the pure helper.
 */
export function validateProcurementBaselineAttributes(
  field: string,
  raw: {
    readonly baselineKind?: unknown;
    readonly method?: unknown;
    readonly methodVersion?: unknown;
    readonly comparisonWindow?: {
      readonly startsAt?: unknown;
      readonly endsAt?: unknown;
    };
    readonly population?: unknown;
    readonly baselineValue?: {
      readonly value?: unknown;
      readonly unit?: unknown;
    };
  },
  now: string,
): {
  readonly baselineKind: BaselineKind;
  readonly method: ProcurementBaselineMethod;
  readonly methodVersion: string;
  readonly comparisonWindow: {
    readonly startsAt: string;
    readonly endsAt: string;
  };
  readonly population: string;
  readonly baselineValue: {
    readonly value: number;
    readonly unit: string;
  };
} {
  if (!raw || typeof raw !== "object") {
    throw new InvalidProcurementSavingsError(`${field} is required`, {
      field,
    });
  }
  const baselineKind = raw.baselineKind;
  if (
    typeof baselineKind !== "string" ||
    !isBaselineKind(baselineKind)
  ) {
    throw new InvalidProcurementSavingsError(
      `${field}.baselineKind must be a closed-vocabulary baseline kind (got ${String(baselineKind)}; vocabulary: the NET-W006 BaselineKind values "baseline" | "counterfactual")`,
      { field: `${field}.baselineKind`, baselineKind: String(baselineKind) },
    );
  }
  const method = raw.method;
  if (typeof method !== "string" || !isProcurementBaselineMethod(method)) {
    throw new InvalidProcurementSavingsError(
      `${field}.method must be a closed-vocabulary baseline method (got ${String(method)}; vocabulary: ${PROCUREMENT_BASELINE_METHODS.join(", ")})`,
      { field: `${field}.method`, method: String(method) },
    );
  }
  const methodVersion = raw.methodVersion;
  if (
    typeof methodVersion !== "string" ||
    !methodVersion.trim() ||
    methodVersion.length > PROCUREMENT_SAVINGS_METHOD_VERSION_MAX_CHARS
  ) {
    throw new InvalidProcurementSavingsError(
      `${field}.methodVersion is required and must be at most ${String(PROCUREMENT_SAVINGS_METHOD_VERSION_MAX_CHARS)} characters (method identity is never collapsed)`,
      { field: `${field}.methodVersion` },
    );
  }
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new InvalidProcurementSavingsError(
      `${field}: the submission anchor is not a parseable ISO timestamp`,
      { field, now },
    );
  }
  const window = raw.comparisonWindow;
  if (!window || typeof window !== "object") {
    throw new InvalidProcurementSavingsError(
      `${field}.comparisonWindow is required`,
      { field: `${field}.comparisonWindow` },
    );
  }
  const startsAt = window.startsAt;
  const endsAt = window.endsAt;
  if (typeof startsAt !== "string" || Number.isNaN(Date.parse(startsAt))) {
    throw new InvalidProcurementSavingsError(
      `${field}.comparisonWindow.startsAt must be a parseable ISO timestamp (got ${String(startsAt)})`,
      { field: `${field}.comparisonWindow.startsAt` },
    );
  }
  if (typeof endsAt !== "string" || Number.isNaN(Date.parse(endsAt))) {
    throw new InvalidProcurementSavingsError(
      `${field}.comparisonWindow.endsAt must be a parseable ISO timestamp (got ${String(endsAt)})`,
      { field: `${field}.comparisonWindow.endsAt` },
    );
  }
  const startsAtMs = Date.parse(startsAt);
  const endsAtMs = Date.parse(endsAt);
  const durationDays = (endsAtMs - startsAtMs) / (24 * 60 * 60 * 1000);
  if (durationDays < PROCUREMENT_BASELINE_COMPARISON_WINDOW_MIN_DAYS) {
    throw new InvalidProcurementSavingsError(
      `${field}.comparisonWindow must span at least ${String(PROCUREMENT_BASELINE_COMPARISON_WINDOW_MIN_DAYS)} day(s) (got ${String(durationDays)})`,
      { field: `${field}.comparisonWindow`, startsAt, endsAt },
    );
  }
  if (durationDays > PROCUREMENT_BASELINE_COMPARISON_WINDOW_MAX_DAYS) {
    throw new InvalidProcurementSavingsError(
      `${field}.comparisonWindow may span at most ${String(PROCUREMENT_BASELINE_COMPARISON_WINDOW_MAX_DAYS)} days (got ${String(durationDays)})`,
      { field: `${field}.comparisonWindow`, startsAt, endsAt },
    );
  }
  if (endsAtMs > nowMs) {
    throw new InvalidProcurementSavingsError(
      `${field}.comparisonWindow must be HISTORICAL: endsAt may not be after the submission time (got ${endsAt})`,
      { field: `${field}.comparisonWindow.endsAt`, endsAt },
    );
  }
  const population = raw.population;
  if (
    typeof population !== "string" ||
    !population.trim() ||
    population.length > PROCUREMENT_MAX_PROSE_CHARS
  ) {
    throw new InvalidProcurementSavingsError(
      `${field}.population is required and must be at most ${String(PROCUREMENT_MAX_PROSE_CHARS)} characters`,
      { field: `${field}.population` },
    );
  }
  const value = raw.baselineValue;
  if (!value || typeof value !== "object") {
    throw new InvalidProcurementSavingsError(
      `${field}.baselineValue is required`,
      { field: `${field}.baselineValue` },
    );
  }
  const amount = value.value;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < PROCUREMENT_SAVINGS_MIN_VALUE ||
    amount > PROCUREMENT_SAVINGS_MAX_VALUE
  ) {
    throw new InvalidProcurementSavingsError(
      `${field}.baselineValue.value must be a finite number in [${String(PROCUREMENT_SAVINGS_MIN_VALUE)}, ${String(PROCUREMENT_SAVINGS_MAX_VALUE)}] (got ${String(amount)})`,
      { field: `${field}.baselineValue.value` },
    );
  }
  const unit = value.unit;
  if (
    typeof unit !== "string" ||
    !unit.trim() ||
    unit.length > PROCUREMENT_SAVINGS_UNIT_MAX_CHARS
  ) {
    throw new InvalidProcurementSavingsError(
      `${field}.baselineValue.unit is required and must be at most ${String(PROCUREMENT_SAVINGS_UNIT_MAX_CHARS)} characters`,
      { field: `${field}.baselineValue.unit` },
    );
  }
  return Object.freeze({
    baselineKind,
    method,
    methodVersion,
    comparisonWindow: Object.freeze({ startsAt, endsAt }),
    population,
    baselineValue: Object.freeze({ value: amount, unit }),
  });
}

/**
 * Validate the declared baseline confidence (work order §4.1/§4.2 —
 * uncertainty is first-class): a validated ConfidenceEstimate, PLUS
 * the NET-W006 counterfactual rule — a `counterfactual` baseline
 * REQUIRES a quantified confidence interval [lower, upper]; an exact
 * counterfactual claim without quantified uncertainty is manufactured
 * and rejected (architecture §13).
 */
export function validateProcurementBaselineConfidence(
  field: string,
  raw: unknown,
  baselineKind: BaselineKind,
): ConfidenceEstimate {
  const confidence = validateConfidenceEstimate(
    raw as ConfidenceEstimate,
  );
  if (
    baselineKind === "counterfactual" &&
    (confidence.lower === undefined || confidence.upper === undefined)
  ) {
    throw new InvalidProcurementSavingsError(
      `a counterfactual baseline requires a quantified confidence interval [lower, upper] — an exact counterfactual claim without quantified uncertainty is manufactured and rejected (architecture §13)`,
      { field, baselineKind },
    );
  }
  return confidence;
}

/**
 * Validate the baseline's evidence references (work order §4.1 —
 * provenance-backed): 1..8 non-empty unique ids, each later resolved
 * through the NEUTRAL /evidence lookup (scope + subject binding are
 * enforced by the service, fail closed).
 */
export function validateProcurementBaselineEvidenceRefs(
  field: string,
  raw: unknown,
): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new InvalidProcurementSavingsError(
      `${field} must be an array of evidence ids`,
      { field },
    );
  }
  if (raw.length < 1) {
    throw new InvalidProcurementSavingsError(
      `${field} requires at least one traceable evidence reference (a baseline claim without provenance is manufactured)`,
      { field },
    );
  }
  if (raw.length > PROCUREMENT_BASELINE_MAX_EVIDENCE_REFS) {
    throw new InvalidProcurementSavingsError(
      `${field} may reference at most ${String(PROCUREMENT_BASELINE_MAX_EVIDENCE_REFS)} evidence records (got ${String(raw.length)})`,
      { field },
    );
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new InvalidProcurementSavingsError(
        `${field} entries must be non-empty evidence id strings`,
        { field },
      );
    }
    if (!ids.includes(entry)) ids.push(entry);
  }
  return Object.freeze(ids);
}

/**
 * Validate the savings-derivation observation references (work order
 * §4.3): 0..8 non-empty unique ids — an EMPTY set is a legitimate
 * derived DECISION input (the derivation's observation_present check
 * fails closed for the authoritative record; the derived view still
 * returns the failing check as a 200 decision). Each id is later
 * resolved through the NEUTRAL /outcomes lookup.
 */
export function validateProcurementSavingsObservationRefs(
  field: string,
  raw: unknown,
): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new InvalidProcurementSavingsError(
      `${field} must be an array of outcome-observation ids`,
      { field },
    );
  }
  if (raw.length > PROCUREMENT_SAVINGS_MAX_OBSERVATIONS) {
    throw new InvalidProcurementSavingsError(
      `${field} may reference at most ${String(PROCUREMENT_SAVINGS_MAX_OBSERVATIONS)} outcome observations (got ${String(raw.length)})`,
      { field },
    );
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new InvalidProcurementSavingsError(
        `${field} entries must be non-empty observation id strings`,
        { field },
      );
    }
    if (!ids.includes(entry)) ids.push(entry);
  }
  return Object.freeze(ids);
}

/**
 * Validate the one-way invalidation reason (work order §4.1/§4.2):
 * the closed vocabulary above — an unknown reason fails closed.
 */
export function validateProcurementBaselineInvalidationReason(
  field: string,
  raw: unknown,
): ProcurementBaselineInvalidationReason {
  if (
    typeof raw !== "string" ||
    !isProcurementBaselineInvalidationReason(raw)
  ) {
    throw new InvalidProcurementSavingsError(
      `${field} must be a closed-vocabulary invalidation reason (got ${String(raw)}; vocabulary: ${PROCUREMENT_BASELINE_INVALIDATION_REASONS.join(", ")})`,
      { field, reason: String(raw) },
    );
  }
  return raw;
}
