/**
 * Measurement ingestion service — the NET-W022 provider-neutral
 * routing + normalization boundary (issue #44 scope 1).
 *
 * Routes ONE raw provider report submission to the registered
 * adapter that owns its provider id and returns the normalized
 * neutral report. This boundary performs NO mutation (adapter tier —
 * it may not import domain modules): persistence, idempotency and
 * audit live in `/outcomes`, composed by the bootstrap root.
 *
 * Fail-closed guarantees (issue #44 scope 5 + architectural
 * constraints):
 *  - unknown provider ids → UnknownMeasurementProviderError;
 *  - adapters without push support → rejected
 *    (`unsupported_push_ingestion`);
 *  - adapter output that violates the neutral contract (provider
 *    identity mismatch, malformed fields) → rejected
 *    (`malformed_report`) — a mis-implemented adapter can never
 *    inject invalid facts;
 *  - deterministic: normalization is a pure function of the payload
 *    + adapter configuration.
 */

import type { Logger } from "../core/logger.ts";
import { isStandardOutcomeType } from "../core/evidence.ts";
import { isAttributionMode } from "../core/measurement.ts";
import {
  MeasurementReportRejectedError,
  UnknownMeasurementProviderError,
} from "./port.ts";
import type {
  MeasurementIngestionService,
  MeasurementProviderRegistry,
  MeasurementReportNormalizationResult,
  RawProviderReportSubmission,
} from "./port.ts";

export interface MeasurementIngestionServiceDeps {
  readonly registry: MeasurementProviderRegistry;
  readonly logger: Logger;
}

/** Validate that an adapter's output satisfies the NEUTRAL contract. */
function assertNeutralContract(
  providerId: string,
  report: unknown,
): void {
  const reject = (message: string, field: string): never => {
    throw new MeasurementReportRejectedError(
      "malformed_report",
      `provider ${providerId} report rejected: the adapter produced a neutral report violating the contract — ${message}`,
      { providerId, field },
    );
  };
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    reject("the normalized report must be an object", "report");
  }
  const r = report as Record<string, unknown>;
  if (r["providerId"] !== providerId) {
    reject(
      `the normalized report claims provider id ${String(r["providerId"])} but was routed as ${providerId}`,
      "providerId",
    );
  }
  if (typeof r["externalSubjectRef"] !== "string" || !r["externalSubjectRef"].trim()) {
    reject("externalSubjectRef must be a non-empty string", "externalSubjectRef");
  }
  if (typeof r["outcomeType"] !== "string" || !isStandardOutcomeType(r["outcomeType"])) {
    reject(
      `outcomeType must be one of the standard OUT-001 outcome types (got ${String(r["outcomeType"])})`,
      "outcomeType",
    );
  }
  const observed = r["observedValue"];
  if (
    observed === null ||
    typeof observed !== "object" ||
    Array.isArray(observed) ||
    typeof (observed as Record<string, unknown>)["value"] !== "number" ||
    !Number.isFinite((observed as Record<string, unknown>)["value"] as number) ||
    (observed as Record<string, unknown>)["value"] as number < 0 ||
    typeof (observed as Record<string, unknown>)["unit"] !== "string" ||
    !((observed as Record<string, unknown>)["unit"] as string).trim()
  ) {
    reject("observedValue must carry a finite non-negative value + unit", "observedValue");
  }
  const confidence = r["confidence"];
  if (confidence === null || typeof confidence !== "object" || Array.isArray(confidence)) {
    reject("confidence is required", "confidence");
  }
  if (r["attributionMode"] !== undefined && r["attributionMode"] !== null) {
    if (typeof r["attributionMode"] !== "string" || !isAttributionMode(r["attributionMode"])) {
      reject(
        `attributionMode must be a valid attribution mode (got ${String(r["attributionMode"])})`,
        "attributionMode",
      );
    }
  }
  for (const field of ["method", "methodVersion", "collectedAt"] as const) {
    if (typeof r[field] !== "string" || !(r[field] as string).trim()) {
      reject(`${field} is required (provenance must be complete)`, field);
    }
  }
}

export function createMeasurementIngestionService(
  deps: MeasurementIngestionServiceDeps,
): MeasurementIngestionService {
  const { registry, logger } = deps;
  return {
    async normalizeSubmission(
      submission: RawProviderReportSubmission,
    ): Promise<MeasurementReportNormalizationResult> {
      if (!submission || typeof submission !== "object") {
        throw new MeasurementReportRejectedError(
          "malformed_report",
          "a raw provider report submission must be an object",
        );
      }
      if (typeof submission.providerId !== "string" || !submission.providerId.trim()) {
        throw new UnknownMeasurementProviderError(
          "a raw provider report submission must carry a non-empty providerId",
        );
      }
      const adapter = registry.byProviderId(submission.providerId);
      if (!adapter) {
        throw new UnknownMeasurementProviderError(
          `no measurement provider adapter is registered for provider id ${submission.providerId}`,
          { providerId: submission.providerId },
        );
      }
      if (!adapter.normalizeReport) {
        throw new MeasurementReportRejectedError(
          "unsupported_push_ingestion",
          `provider ${submission.providerId} does not accept pushed reports (the adapter implements the pull surface only)`,
          { providerId: submission.providerId },
        );
      }
      const normalized = await adapter.normalizeReport({
        providerId: submission.providerId,
        payload: submission.payload,
      });
      // Contract enforcement at the boundary: a mis-implemented
      // adapter can never inject a neutral report that violates the
      // frozen contract or claims another provider's identity.
      assertNeutralContract(submission.providerId, normalized.report);
      const result: MeasurementReportNormalizationResult = {
        report: normalized.report,
        redactedFieldNames: normalized.redactedFieldNames,
        providerVersion: adapter.info.version,
      };
      logger.debug("measurement_report.normalized", {
        providerId: submission.providerId,
        providerVersion: adapter.info.version,
        redactedFieldCount: normalized.redactedFieldNames.length,
      });
      return result;
    },
    async checkHealth() {
      return registry.checkHealth();
    },
  };
}
