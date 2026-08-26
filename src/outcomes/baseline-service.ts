/**
 * BaselineService — domain service for explicit counterfactual and
 * baseline measurements (NET-W006 §3.4; OUT-004).
 *
 * Architecture ref: spec/architecture.md §13 (counterfactual savings
 * measurement — uncertainty retained); spec/architecture-lock.md §3
 * (PostgreSQL authoritative).
 *
 * A `counterfactual` estimate (the no-treatment outcome — "what would
 * have happened without the contribution") REQUIRES a quantified
 * confidence interval: an exact counterfactual claim without
 * quantified uncertainty is manufactured and rejected
 * (architecture §13). A plain `baseline` (reference level) records an
 * interval when one is meaningful (EVID-005 invariants always apply).
 *
 * Tier compliance: outcomes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  isStandardOutcomeType,
  validateConfidenceEstimate,
} from "../core/evidence.ts";
import { isBaselineKind, validateMeasurementProvenance } from "../core/measurement.ts";
import type {
  BaselineService,
  CounterfactualBaseline,
  CounterfactualBaselineRepository,
  CreateCounterfactualBaselineInput,
  EvidenceRecordLookup,
} from "./port.ts";

const BASELINE_CREATED = "counterfactual_baseline.created" as const;

export interface BaselineServiceDeps {
  readonly repository: CounterfactualBaselineRepository;
  /** For validating optional supporting evidence links. */
  readonly evidenceLookup: EvidenceRecordLookup;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function validateValueUnit(
  value: number,
  unit: string,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OpenConError({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message: `${field}.value must be a finite non-negative number`,
      context: { field: `${field}.value`, value },
    });
  }
  if (typeof unit !== "string" || !unit.trim()) {
    throw new OpenConError({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message: `${field}.unit is required`,
      context: { field: `${field}.unit` },
    });
  }
}

export function createBaselineService(
  deps: BaselineServiceDeps,
): BaselineService {
  const { repository, evidenceLookup, authority, auditWriter, logger } = deps;

  const service: BaselineService = {
    async createCounterfactualBaseline(execution, input) {
      // ---- Validation --------------------------------------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.ownerId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "ownerId is required",
          context: { field: "ownerId" },
        });
      }
      if (
        !input.subjectReference?.subjectId?.trim() ||
        !input.subjectReference?.subjectType?.trim()
      ) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message:
            "subjectReference.subjectId and subjectReference.subjectType are required",
          context: { field: "subjectReference" },
        });
      }
      if (!isStandardOutcomeType(input.outcomeType)) {
        throw new OpenConError({
          code: "UNSUPPORTED_OUTCOME_TYPE",
          classification: "validation",
          message: `outcomeType must be one of the standard outcome types (got ${String(input.outcomeType)})`,
          context: { outcomeType: input.outcomeType },
        });
      }
      if (!isBaselineKind(input.baselineKind)) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `baselineKind must be "counterfactual" or "baseline" (got ${String(input.baselineKind)})`,
          context: { baselineKind: input.baselineKind },
        });
      }
      validateValueUnit(input.baselineValue?.value, input.baselineValue?.unit, "baselineValue");
      if (input.comparisonValue !== undefined) {
        validateValueUnit(
          input.comparisonValue?.value,
          input.comparisonValue?.unit,
          "comparisonValue",
        );
      }
      const confidence = validateConfidenceEstimate(input.confidence);
      if (
        input.baselineKind === "counterfactual" &&
        (confidence.lower === undefined || confidence.upper === undefined)
      ) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message:
            "a counterfactual estimate requires a quantified confidence interval [lower, upper] — an exact counterfactual claim without quantified uncertainty is manufactured and rejected (architecture §13)",
          context: { baselineKind: input.baselineKind, confidencePoint: confidence.point },
        });
      }
      const now = new Date().toISOString();
      const provenance = validateMeasurementProvenance({
        sourceType: input.provenance.sourceType,
        ...(input.provenance.sourceId !== undefined
          ? { sourceId: input.provenance.sourceId }
          : {}),
        method: input.provenance.method,
        methodVersion: input.provenance.methodVersion,
        collectedAt: input.provenance.collectedAt ?? now,
        ...(input.provenance.collectorId !== undefined
          ? { collectorId: input.provenance.collectorId }
          : {}),
      });
      const evidenceIds = input.evidenceIds ?? [];
      for (const evidenceId of evidenceIds) {
        if (!(await evidenceLookup.exists(evidenceId))) {
          throw new NotFoundError(`evidence not found: ${evidenceId}`, {
            evidenceId,
          });
        }
        const scope = await evidenceLookup.getOrganizationScope(evidenceId);
        if (scope !== input.organizationScopeId) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message: `evidence ${evidenceId} belongs to organization scope ${String(scope)}, not ${input.organizationScopeId}`,
            context: { evidenceId },
          });
        }
      }

      const baseline: CounterfactualBaseline = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType,
        baselineKind: input.baselineKind,
        baselineValue: Object.freeze({ ...input.baselineValue }),
        comparisonValue:
          input.comparisonValue !== undefined
            ? Object.freeze({ ...input.comparisonValue })
            : null,
        confidence,
        provenance,
        evidenceIds,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });

      // ---- Atomic mutation + audit --------------------------------------
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(baseline, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: BASELINE_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: baseline.id,
          resourceType: "counterfactual_baseline",
          resourceId: baseline.id,
          metadata: {
            baselineKind: baseline.baselineKind,
            outcomeType: baseline.outcomeType,
            baselineValue: baseline.baselineValue.value,
            baselineUnit: baseline.baselineValue.unit,
            comparisonValue: baseline.comparisonValue?.value ?? null,
            comparisonUnit: baseline.comparisonValue?.unit ?? null,
            confidencePoint: baseline.confidence.point,
            ...(baseline.confidence.lower !== undefined &&
            baseline.confidence.upper !== undefined
              ? {
                  confidenceInterval: [
                    baseline.confidence.lower,
                    baseline.confidence.upper,
                  ],
                }
              : {}),
            method: baseline.provenance.method,
            methodVersion: baseline.provenance.methodVersion,
            sourceType: baseline.provenance.sourceType,
            organizationScopeId: baseline.organizationScopeId,
          },
        });
      });
      logger.info("counterfactual_baseline.created", {
        baselineId: baseline.id,
        baselineKind: baseline.baselineKind,
      });
      return baseline;
    },

    async getCounterfactualBaseline(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`counterfactual baseline not found: ${id}`, {
          baselineId: id,
        });
      }
      return found;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
