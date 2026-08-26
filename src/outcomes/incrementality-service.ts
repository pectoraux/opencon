/**
 * IncrementalityService — domain service for explicit incrementality
 * observations (NET-W006 §3.3; OUT-003).
 *
 * Architecture ref: spec/architecture.md §13 (experimental
 * incrementality); spec/architecture-lock.md §3 (PostgreSQL
 * authoritative).
 *
 * The CAUSAL STATUS IS DERIVED, never caller-asserted (work order
 * §3.3 / invariant 4):
 *
 *  - `experimentId` present → the referenced experiment MUST exist in
 *    the same organization scope and be COMPLETED (a PLANNED, RUNNING
 *    or INVALIDATED experiment cannot back a causality claim — fail
 *    closed with a stable error code); `causalStatus` is
 *    `experiment_backed`.
 *  - `experimentId` absent → `causalStatus` is `observational`:
 *    measured lift WITHOUT claiming causality (no valid experiment
 *    exists).
 *
 * A lift estimate is a statistical estimate: a quantified confidence
 * INTERVAL is REQUIRED (architecture §13 — uncertainty is retained,
 * never collapsed).
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
import { validateMeasurementProvenance } from "../core/measurement.ts";
import type {
  CreateIncrementalityObservationInput,
  IncrementalityObservation,
  IncrementalityObservationRepository,
  IncrementalityService,
  MeasurementExperimentRepository,
} from "./port.ts";

const INCREMENTALITY_CREATED = "incrementality_observation.created" as const;

export interface IncrementalityServiceDeps {
  readonly repository: IncrementalityObservationRepository;
  /** For validating the optional experiment reference. */
  readonly experimentRepository: MeasurementExperimentRepository;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/** Validate a value+unit pair (finite non-negative value, non-empty unit). */
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

export function createIncrementalityService(
  deps: IncrementalityServiceDeps,
): IncrementalityService {
  const {
    repository,
    experimentRepository,
    authority,
    auditWriter,
    logger,
  } = deps;

  const service: IncrementalityService = {
    async createIncrementalityObservation(execution, input) {
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
      validateValueUnit(input.lift?.value, input.lift?.unit, "lift");
      validateValueUnit(
        input.baselineValue?.value,
        input.baselineValue?.unit,
        "baselineValue",
      );
      // A lift estimate is statistical: the interval is REQUIRED.
      const confidence = validateConfidenceEstimate(input.confidence);
      if (
        confidence.lower === undefined ||
        confidence.upper === undefined
      ) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message:
            "an incrementality observation requires a quantified confidence interval [lower, upper] — an exact lift claim without uncertainty is manufactured and rejected",
          context: { confidencePoint: confidence.point },
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

      // ---- Derive the causal status (fail closed; work order §3.3) ----
      let experimentId: string | null = null;
      let causalStatus: "experiment_backed" | "observational" =
        "observational";
      if (input.experimentId !== undefined) {
        const experiment = await experimentRepository.findById(
          input.experimentId,
        );
        if (!experiment) {
          throw new NotFoundError(
            `measurement experiment not found: ${input.experimentId}`,
            { experimentId: input.experimentId },
          );
        }
        if (experiment.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message: `measurement experiment ${input.experimentId} belongs to organization scope ${experiment.organizationScopeId}, not ${input.organizationScopeId}`,
            context: { experimentId: input.experimentId },
          });
        }
        if (experiment.status !== "COMPLETED") {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message: `measurement experiment ${input.experimentId} is ${experiment.status} — only a COMPLETED experiment can back an experiment_backed incrementality observation (record the lift as observational by omitting the experiment reference)`,
            context: {
              experimentId: input.experimentId,
              experimentStatus: experiment.status,
            },
          });
        }
        experimentId = experiment.id;
        causalStatus = "experiment_backed";
      }

      const observation: IncrementalityObservation = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType,
        lift: Object.freeze({ ...input.lift }),
        baselineValue: Object.freeze({ ...input.baselineValue }),
        confidence,
        provenance,
        experimentId,
        causalStatus,
        evidenceIds: input.evidenceIds ?? [],
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });

      // ---- Atomic mutation + audit --------------------------------------
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(observation, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: INCREMENTALITY_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: observation.id,
          resourceType: "incrementality_observation",
          resourceId: observation.id,
          metadata: {
            outcomeType: observation.outcomeType,
            liftValue: observation.lift.value,
            liftUnit: observation.lift.unit,
            baselineValue: observation.baselineValue.value,
            confidencePoint: observation.confidence.point,
            confidenceInterval: [observation.confidence.lower, observation.confidence.upper],
            causalStatus: observation.causalStatus,
            experimentId: observation.experimentId,
            method: observation.provenance.method,
            methodVersion: observation.provenance.methodVersion,
            organizationScopeId: observation.organizationScopeId,
          },
        });
      });
      logger.info("incrementality_observation.created", {
        observationId: observation.id,
        causalStatus: observation.causalStatus,
      });
      return observation;
    },

    async getIncrementalityObservation(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(
          `incrementality observation not found: ${id}`,
          { observationId: id },
        );
      }
      return found;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
