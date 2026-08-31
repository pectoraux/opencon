/**
 * NET-W022 — shared validation/normalization rules for the provider
 * attribution reference adapters (ADAPTER-003 browser/platform +
 * ADAPTER-004 iOS).
 *
 * Every rule here FAILS CLOSED with a closed
 * {@link MeasurementReportRejectionReason} (issue #44 scope 5):
 *  - subject mapping resolves to exactly ONE provider-side reference;
 *  - provider-reported attribution modes are restricted to
 *    deterministic/probabilistic (experimental attribution is
 *    protocol-owned via /outcomes experiments — a provider can never
 *    claim it);
 *  - deterministic attribution REQUIRES a mechanical link;
 *    probabilistic FORBIDS one and REQUIRES a quantified interval
 *    (mirrors the /outcomes attribution-mode rules, evaluated on the
 *    RAW report BEFORE normalization — provider-side consistency);
 *  - method/methodVersion/collectedAt provenance is REQUIRED;
 *  - observed value + confidence must satisfy the neutral contract.
 *
 * Adapter tier: imports core contracts + the neutral port only.
 */

import { ATTRIBUTION_MODES, isAttributionMode } from "../../core/measurement.ts";
import {
  isStandardOutcomeType,
  validateConfidenceEstimate,
} from "../../core/evidence.ts";
import type { AttributionMode } from "../../core/measurement.ts";
import { MeasurementReportRejectedError } from "../port.ts";
import type { MeasurementReportRejectionReason } from "../port.ts";
import type { ProviderObservationReport } from "../port.ts";

/**
 * The attribution modes a PROVIDER report may claim (OUT-002):
 * deterministic or probabilistic provenance facts only. Experimental
 * attribution requires a protocol experiment (/outcomes §3.2) and can
 * never be provider-reported.
 */
export const PROVIDER_REPORTABLE_ATTRIBUTION_MODES: readonly AttributionMode[] = [
  "deterministic",
  "probabilistic",
];

/** Max vendor field names reported in redactedFieldNames (bounded reflection). */
export const MAX_REDACTED_FIELD_NAMES = 24;

/**
 * Build the fail-closed rejection error for a provider report (the
 * shared message shape + provider-id context; never payload values).
 */
export function rejectReport(
  reason: MeasurementReportRejectionReason,
  providerId: string,
  message: string,
  field?: string,
): MeasurementReportRejectedError {
  return new MeasurementReportRejectedError(
    reason,
    `provider ${providerId} report rejected: ${message}`,
    { providerId, ...(field !== undefined ? { field } : {}) },
  );
}

function reject(
  reason: MeasurementReportRejectionReason,
  providerId: string,
  message: string,
  field?: string,
): MeasurementReportRejectedError {
  return rejectReport(reason, providerId, message, field);
}

/** Require a non-empty string field (malformed_report otherwise). */
export function requireStringField(
  raw: Record<string, unknown>,
  field: string,
  providerId: string,
): string {
  const value = raw[field];
  if (typeof value !== "string" || !value.trim()) {
    throw reject("malformed_report", providerId, `${field} must be a non-empty string`, field);
  }
  return value;
}

/**
 * Resolve the provider-side subject mapping (ambiguous_subject_mapping
 * on zero or multiple candidates — issue #44 scope 5). The raw report
 * carries `subjectRefs`: exactly ONE non-empty string entry maps to
 * the neutral `externalSubjectRef` (recorded on the observation for
 * provenance/traceability).
 */
export function resolveExternalSubjectRef(
  raw: Record<string, unknown>,
  providerId: string,
): string {
  const refs = raw["subjectRefs"];
  if (refs === null || typeof refs !== "object" || !Array.isArray(refs)) {
    throw reject(
      "ambiguous_subject_mapping",
      providerId,
      "subjectRefs must be an array of provider-side subject references",
      "subjectRefs",
    );
  }
  const nonEmpty = refs.filter(
    (r): r is string => typeof r === "string" && r.trim().length > 0,
  );
  if (nonEmpty.length !== 1 || refs.length !== 1) {
    throw reject(
      "ambiguous_subject_mapping",
      providerId,
      `the provider-side subject mapping is ambiguous (expected exactly one subject reference, got ${nonEmpty.length} of ${refs.length})`,
      "subjectRefs",
    );
  }
  return nonEmpty[0]!;
}

/**
 * Validate the provider-reported attribution mode + mode-specific
 * consistency (mirrors the /outcomes attribution rules against the RAW
 * report — fail closed before normalization). Returns the mode, or
 * undefined when the report claims none (attribution is optional
 * provenance on observations).
 */
export function validateProviderAttributionMode(options: {
  readonly raw: Record<string, unknown>;
  readonly providerId: string;
}): AttributionMode | undefined {
  const { raw, providerId } = options;
  const claimed = raw["attributionMode"];
  if (claimed === undefined || claimed === null) {
    return undefined;
  }
  if (typeof claimed !== "string" || !isAttributionMode(claimed)) {
    throw reject(
      "unsupported_attribution_mode",
      providerId,
      `the claimed attribution mode ${JSON.stringify(String(claimed))} is not part of the attribution-mode vocabulary`,
      "attributionMode",
    );
  }
  if (!PROVIDER_REPORTABLE_ATTRIBUTION_MODES.includes(claimed)) {
    // Only reachable for "experimental": protocol-owned attribution.
    throw reject(
      "unsupported_attribution_mode",
      providerId,
      "provider reports may claim deterministic or probabilistic attribution only — experimental attribution requires a protocol experiment (/outcomes)",
      "attributionMode",
    );
  }
  const mode = claimed;
  const hasLink =
    raw["deterministicLink"] !== undefined &&
    raw["deterministicLink"] !== null &&
    typeof raw["deterministicLink"] === "string" &&
    (raw["deterministicLink"] as string).trim().length > 0;
  if (mode === "deterministic" && !hasLink) {
    throw reject(
      "invalid_attribution_mode",
      providerId,
      "deterministic attribution requires a mechanical link (deterministicLink)",
      "deterministicLink",
    );
  }
  if (mode === "probabilistic") {
    if (hasLink) {
      throw reject(
        "invalid_attribution_mode",
        providerId,
        "probabilistic attribution must not carry a mechanical link (deterministicLink)",
        "deterministicLink",
      );
    }
    const confidence = raw["confidence"];
    const interval =
      confidence !== null &&
      typeof confidence === "object" &&
      !Array.isArray(confidence) &&
      typeof (confidence as Record<string, unknown>)["lower"] === "number" &&
      typeof (confidence as Record<string, unknown>)["upper"] === "number";
    if (!interval) {
      throw reject(
        "invalid_attribution_mode",
        providerId,
        "probabilistic attribution requires a quantified confidence interval (lower + upper)",
        "confidence",
      );
    }
  }
  return mode;
}

/** Validate the observed value (finite non-negative + unit). */
export function validateRawObservedValue(
  raw: Record<string, unknown>,
  providerId: string,
): { readonly value: number; readonly unit: string } {
  const observed = raw["observedValue"];
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    throw reject("malformed_report", providerId, "observedValue must be an object", "observedValue");
  }
  const { value, unit } = observed as Record<string, unknown>;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw reject(
      "malformed_report",
      providerId,
      "observedValue.value must be a finite non-negative number",
      "observedValue.value",
    );
  }
  if (typeof unit !== "string" || !unit.trim()) {
    throw reject("malformed_report", providerId, "observedValue.unit is required", "observedValue.unit");
  }
  return Object.freeze({ value, unit });
}

/** Validate the raw confidence (neutral-contract rules via core). */
export function validateRawConfidence(
  raw: Record<string, unknown>,
  providerId: string,
): ReturnType<typeof validateConfidenceEstimate> {
  const confidence = raw["confidence"];
  if (confidence === null || typeof confidence !== "object" || Array.isArray(confidence)) {
    throw reject("malformed_report", providerId, "confidence is required", "confidence");
  }
  try {
    return validateConfidenceEstimate(
      confidence as Parameters<typeof validateConfidenceEstimate>[0],
    );
  } catch {
    throw reject("malformed_report", providerId, "confidence violates the confidence-estimate invariants", "confidence");
  }
}

/**
 * Collect the NAMES of fields dropped by redaction (privacy
 * minimization: only names, never values; bounded). The redaction
 * summary = every INPUT field that is NOT part of the normalized
 * neutral report — consumed-for-validation fields (ids, subject
 * mappings, integrity blocks, mechanical links) and unknown vendor
 * extras alike. Nothing beyond the neutral contract crosses.
 */
export function collectRedactedFieldNames(
  raw: Record<string, unknown>,
  neutralOutputKeys: readonly string[],
): readonly string[] {
  const output = new Set<string>(neutralOutputKeys);
  const names: string[] = [];
  for (const key of Object.keys(raw)) {
    if (output.has(key)) continue;
    if (raw[key] === undefined) continue;
    if (names.length >= MAX_REDACTED_FIELD_NAMES) break;
    names.push(key);
  }
  return names;
}

/**
 * Build the neutral ProviderObservationReport (the ONLY fields that
 * cross the adapter boundary — privacy minimization). Provenance is
 * provider-supplied and REQUIRED: method + methodVersion +
 * collectedAt (missing_provenance otherwise).
 */
export function buildNeutralReport(options: {
  readonly providerId: string;
  readonly externalSubjectRef: string;
  readonly outcomeType: string;
  readonly observedValue: { readonly value: number; readonly unit: string };
  readonly confidence: ReturnType<typeof validateConfidenceEstimate>;
  readonly attributionMode: AttributionMode | undefined;
  readonly raw: Record<string, unknown>;
}): ProviderObservationReport {
  const { providerId, raw } = options;
  const method = raw["method"];
  if (typeof method !== "string" || !method.trim()) {
    throw reject("missing_provenance", providerId, "method is required (provider methods are never anonymous)", "method");
  }
  const methodVersion = raw["methodVersion"];
  if (typeof methodVersion !== "string" || !methodVersion.trim()) {
    throw reject(
      "missing_provenance",
      providerId,
      "methodVersion is required (model/method identity must never be collapsed)",
      "methodVersion",
    );
  }
  const collectedAt = raw["collectedAt"];
  if (typeof collectedAt !== "string" || !collectedAt.trim()) {
    throw reject("missing_provenance", providerId, "collectedAt is required", "collectedAt");
  }
  if (typeof options.outcomeType !== "string" || !isStandardOutcomeType(options.outcomeType)) {
    throw reject(
      "malformed_report",
      providerId,
      `outcomeType must be one of the standard OUT-001 outcome types (got ${String(options.outcomeType)})`,
      "outcomeType",
    );
  }
  return Object.freeze({
    providerId,
    externalSubjectRef: options.externalSubjectRef,
    outcomeType: options.outcomeType,
    observedValue: options.observedValue,
    confidence: options.confidence,
    method,
    methodVersion,
    collectedAt,
    ...(options.attributionMode !== undefined
      ? { attributionMode: options.attributionMode }
      : {}),
  });
}

/** Exposed for documentation/pinning: the closed mode vocabulary. */
export const SHARED_ATTRIBUTION_MODES: readonly string[] = ATTRIBUTION_MODES;
