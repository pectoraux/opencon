/**
 * Measurement vocabulary — shared contracts for the outcomes and
 * measurement layer (NET-W006).
 *
 * Work order ref: spec/work-orders/NET-W006.md
 *   §3.1 Outcome observations (provenance with method/version).
 *   §3.2 Attribution representation (OUT-002: deterministic,
 *        probabilistic, experimental).
 *   §3.3 Experiments/holdouts and incrementality (OUT-003).
 *   §3.4 Counterfactual/baseline measurements (OUT-004).
 *   §3.5 Measured outcome + maturation (OUT-005).
 *
 * Architecture ref: spec/architecture.md §13 (measurement
 * architecture: deterministic attribution, probabilistic attribution,
 * experimental incrementality, counterfactual savings measurement —
 * all economically material values retain confidence/uncertainty),
 * §18 (`/outcomes` owns measurement semantics; `/measurement` owns
 * provider integrations); spec/architecture-lock.md §4 (agent/model
 * output is input evidence, never authoritative), §14.25 (measurement
 * adapters provide facts; `/outcomes` retains semantic authority).
 *
 * This file lives in `src/core/` so it can be imported by EVERY tier
 * that consumes measurement vocabulary (the `/outcomes` domain in
 * NET-W006; the neutral `/measurement` port; `/reputation`,
 * `/settlement` and concrete providers in later work items) without
 * violating the tier allow matrix. The BEHAVIOUR (services,
 * validation rules, rollup) lives in the `/outcomes` domain; this
 * file declares only the shared vocabulary + errors.
 *
 * No economically material behaviour (credit issuance, settlement,
 * reputation mutation, ad pricing) is introduced by this file. The
 * vocabulary is pure data: attribution modes, measurement provenance,
 * maturation strategies, rollup strategies, experiment statuses.
 */

import { OpenConError } from "./errors.ts";
import type { EvidenceSourceType } from "./evidence.ts";
import { isEvidenceSourceType } from "./evidence.ts";

/**
 * The attribution modes (OUT-002; architecture §13):
 *
 *  - `deterministic`: an unambiguous causal/mechanical link exists
 *    (e.g. a click id or referral code). The attribution record MUST
 *    carry a deterministicLink.
 *  - `probabilistic`: deterministic identity linkage is unavailable;
 *    the attribution is a model/method estimate. Method + version and
 *    a QUANTIFIED confidence interval are REQUIRED — uncertainty is
 *    preserved, never collapsed.
 *  - `experimental`: attribution derived from a controlled experiment
 *    or holdout. The record MUST reference a non-invalidated
 *    experiment and carry a quantified confidence interval.
 */
export const ATTRIBUTION_MODES = [
  "deterministic",
  "probabilistic",
  "experimental",
] as const;

export type AttributionMode = (typeof ATTRIBUTION_MODES)[number];

export function isAttributionMode(value: string): value is AttributionMode {
  return (ATTRIBUTION_MODES as readonly string[]).includes(value);
}

/**
 * Measurement provenance — HOW a measurement was produced (work
 * order §3.1). Mirrors the evidence ProvenanceRecord (EVID-002) with
 * one NET-W006 addition: `methodVersion` is REQUIRED. Model and
 * method identity (name + version) is part of the durable measurement
 * record so later evaluation can never mistake "MMM v1" for
 * "MMM v3".
 */
export interface MeasurementProvenance {
  /** Where the measurement came from (see EVIDENCE_SOURCE_TYPES). */
  readonly sourceType: EvidenceSourceType;
  /**
   * Stable identifier of the source (provider id, verifier id, model
   * id, participant id...). Optional: platform instrumentation may be
   * its own source.
   */
  readonly sourceId?: string;
  /** Provider-neutral method identifier (e.g. "deterministic-link", "geo-holdout", "mmm"). */
  readonly method: string;
  /** REQUIRED version of the method/model — never collapsed. */
  readonly methodVersion: string;
  /** When the underlying material was collected (ISO-8601). */
  readonly collectedAt: string;
  /** Who collected/recorded it (participant or service id), if known. */
  readonly collectorId?: string;
}

/**
 * Validate measurement provenance (work order §3.1): sourceType must
 * be a known evidence source type; method + methodVersion must be
 * non-empty; collectedAt must be present. Returns a normalized copy
 * or throws {@link InvalidMeasurementProvenanceError}.
 */
export function validateMeasurementProvenance(
  provenance: MeasurementProvenance,
): MeasurementProvenance {
  if (!provenance || typeof provenance !== "object") {
    throw new InvalidMeasurementProvenanceError(
      "measurement provenance is required",
    );
  }
  if (
    typeof provenance.sourceType !== "string" ||
    !isEvidenceSourceType(provenance.sourceType)
  ) {
    throw new InvalidMeasurementProvenanceError(
      `measurement provenance sourceType must be a known evidence source type (got ${String(provenance.sourceType)})`,
      { field: "sourceType", sourceType: provenance.sourceType },
    );
  }
  if (typeof provenance.method !== "string" || !provenance.method.trim()) {
    throw new InvalidMeasurementProvenanceError(
      "measurement provenance method is required",
      { field: "method" },
    );
  }
  if (
    typeof provenance.methodVersion !== "string" ||
    !provenance.methodVersion.trim()
  ) {
    throw new InvalidMeasurementProvenanceError(
      "measurement provenance methodVersion is required (model/method identity must never be collapsed)",
      { field: "methodVersion" },
    );
  }
  if (
    typeof provenance.collectedAt !== "string" ||
    !provenance.collectedAt.trim()
  ) {
    throw new InvalidMeasurementProvenanceError(
      "measurement provenance collectedAt is required",
      { field: "collectedAt" },
    );
  }
  return Object.freeze({
    sourceType: provenance.sourceType,
    ...(provenance.sourceId !== undefined
      ? { sourceId: provenance.sourceId }
      : {}),
    method: provenance.method,
    methodVersion: provenance.methodVersion,
    collectedAt: provenance.collectedAt,
    ...(provenance.collectorId !== undefined
      ? { collectorId: provenance.collectorId }
      : {}),
  });
}

/**
 * Maturation strategies for delayed outcomes (OUT-005; work order
 * §3.5):
 *
 *  - `immediate`: no maturation gate — finalizable once a rollup is
 *    recorded.
 *  - `fixed_window`: finalization before `windowEndAt` is rejected.
 *  - `event_driven`: finalization requires an explicit, auditable
 *    `maturationEvent` reference.
 */
export const MATURATION_STRATEGIES = [
  "immediate",
  "fixed_window",
  "event_driven",
] as const;

export type MaturationStrategy = (typeof MATURATION_STRATEGIES)[number];

export function isMaturationStrategy(value: string): value is MaturationStrategy {
  return (MATURATION_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Rollup strategies for deriving the finalized measured value from
 * observations (work order §3.6):
 *
 *  - `sum`: the finalized value is the sum of chain-head observation
 *    values (event/count-like outcomes).
 *  - `latest`: the finalized value is the value of the most-recently
 *    collected chain head (state-like outcomes such as retention).
 */
export const ROLLUP_STRATEGIES = ["sum", "latest"] as const;

export type RollupStrategy = (typeof ROLLUP_STRATEGIES)[number];

export function isRollupStrategy(value: string): value is RollupStrategy {
  return (ROLLUP_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Measurement experiment statuses (work order §3.3). PLANNED →
 * RUNNING → COMPLETED with INVALIDATED reachable from PLANNED or
 * RUNNING. COMPLETED and INVALIDATED are terminal for the
 * experiment's measurement validity: only a COMPLETED experiment can
 * back an `experiment_backed` incrementality observation; an
 * INVALIDATED experiment can no longer back experimental attribution.
 */
export const MEASUREMENT_EXPERIMENT_STATUSES = [
  "PLANNED",
  "RUNNING",
  "COMPLETED",
  "INVALIDATED",
] as const;

export type MeasurementExperimentStatus =
  (typeof MEASUREMENT_EXPERIMENT_STATUSES)[number];

export function isMeasurementExperimentStatus(
  value: string,
): value is MeasurementExperimentStatus {
  return (MEASUREMENT_EXPERIMENT_STATUSES as readonly string[]).includes(
    value,
  );
}

/**
 * Baseline kinds (OUT-004; work order §3.4):
 *
 *  - `counterfactual`: the estimated no-treatment outcome ("what
 *    would have happened without the contribution"). A quantified
 *    confidence interval is REQUIRED — an exact counterfactual claim
 *    without quantified uncertainty is manufactured and rejected.
 *  - `baseline`: a reference level for comparison (interval optional).
 */
export const BASELINE_KINDS = ["counterfactual", "baseline"] as const;

export type BaselineKind = (typeof BASELINE_KINDS)[number];

export function isBaselineKind(value: string): value is BaselineKind {
  return (BASELINE_KINDS as readonly string[]).includes(value);
}

/**
 * The causal status of an incrementality observation (work order
 * §3.3):
 *
 *  - `experiment_backed`: the lift estimate is backed by a COMPLETED
 *    controlled experiment (experimentId references it).
 *  - `observational`: measured lift WITHOUT a causal claim — no valid
 *    experiment exists.
 */
export const CAUSAL_STATUSES = [
  "experiment_backed",
  "observational",
] as const;

export type CausalStatus = (typeof CAUSAL_STATUSES)[number];

/** Raised when measurement provenance violates the work-order invariants. */
export class InvalidMeasurementProvenanceError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVALID_MEASUREMENT_PROVENANCE",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised when an attribution record violates its mode-specific rules
 * (work order §3.2): deterministic without a mechanical link;
 * probabilistic with a mechanical link; probabilistic/experimental
 * without a quantified interval; experimental without a valid
 * experiment reference.
 */
export class InvalidAttributionError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVALID_ATTRIBUTION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised when a measurement-layer operation violates a NET-W006
 * validation rule (stable code MEASUREMENT_VALIDATION) — e.g.
 * finalizing before the maturation window elapsed, recording a rollup
 * without a supporting observation, or attaching to a finalized
 * measurement.
 */
export class MeasurementValidationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}
