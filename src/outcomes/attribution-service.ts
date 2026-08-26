/**
 * AttributionService — domain service for provider-neutral attribution
 * records (NET-W006 §3.2; OUT-002).
 *
 * Architecture ref: spec/architecture.md §13 (deterministic
 * attribution, probabilistic attribution, experimental
 * incrementality — uncertainty is retained), §18;
 * spec/architecture-lock.md §3 (PostgreSQL authoritative).
 *
 * The three attribution modes are represented DISTINCTLY with
 * mode-specific validation rules (fail closed, stable error codes —
 * work order §3.2 / invariant 3):
 *
 *  - `deterministic`: a mechanical/causal link (linkType +
 *    linkIdentifier) is REQUIRED. Confidence is required; an interval
 *    is OPTIONAL (a mechanical link carries no sampling uncertainty).
 *  - `probabilistic`: a mechanical link is FORBIDDEN (the modes are
 *    distinct — an identity link makes the attribution deterministic
 *    by definition); method + methodVersion are REQUIRED
 *    (model identity preserved); a quantified confidence INTERVAL is
 *    REQUIRED (a probabilistic attribution without an interval is a
 *    manufactured exact claim — architecture §13).
 *  - `experimental`: an experimentId referencing an existing
 *    experiment in the same organization scope whose status is RUNNING
 *    or COMPLETED is REQUIRED (an INVALIDATED experiment cannot back
 *    attribution — fail closed); a quantified confidence interval is
 *    REQUIRED (experimental estimates are statistical).
 *
 * Tier compliance: outcomes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { validateConfidenceEstimate } from "../core/evidence.ts";
import {
  isAttributionMode,
  validateMeasurementProvenance,
  type AttributionMode,
} from "../core/measurement.ts";
import type {
  AttributionRecord,
  AttributionRepository,
  AttributionService,
  CreateAttributionInput,
  EvidenceRecordLookup,
  MeasurementExperimentRepository,
  OutcomeObservationRepository,
} from "./port.ts";

const ATTRIBUTION_CREATED = "attribution.created" as const;

export interface AttributionServiceDeps {
  readonly repository: AttributionRepository;
  /** For resolving the attributed observation. */
  readonly observationRepository: OutcomeObservationRepository;
  /** For validating the experimental reference. */
  readonly experimentRepository: MeasurementExperimentRepository;
  /** For validating optional supporting evidence links. */
  readonly evidenceLookup: EvidenceRecordLookup;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createAttributionService(
  deps: AttributionServiceDeps,
): AttributionService {
  const {
    repository,
    observationRepository,
    experimentRepository,
    evidenceLookup,
    authority,
    auditWriter,
    logger,
  } = deps;

  /** Require a quantified confidence interval. */
  function requireInterval(
    mode: AttributionMode,
    confidence: ReturnType<typeof validateConfidenceEstimate>,
  ): void {
    if (confidence.lower === undefined || confidence.upper === undefined) {
      throw new OpenConError({
        code: "INVALID_ATTRIBUTION",
        classification: "validation",
        message: `${mode} attribution requires a quantified confidence interval [lower, upper] — an exact estimate without uncertainty is manufactured and rejected (architecture §13)`,
        context: { mode, confidencePoint: confidence.point },
      });
    }
  }

  const service: AttributionService = {
    async createAttribution(execution, input) {
      // ---- Common validation -------------------------------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.observationId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "observationId is required",
          context: { field: "observationId" },
        });
      }
      if (
        !input.attributedSubject?.subjectId?.trim() ||
        !input.attributedSubject?.subjectType?.trim()
      ) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message:
            "attributedSubject.subjectId and attributedSubject.subjectType are required",
          context: { field: "attributedSubject" },
        });
      }
      const mode = input.mode;
      if (!isAttributionMode(mode)) {
        throw new OpenConError({
          code: "INVALID_ATTRIBUTION",
          classification: "validation",
          message: `attribution mode must be one of ${["deterministic", "probabilistic", "experimental"].join(", ")} (got ${String(mode)})`,
          context: { mode: input.mode },
        });
      }
      if (
        typeof input.attributionValue?.value !== "number" ||
        !Number.isFinite(input.attributionValue.value) ||
        input.attributionValue.value < 0
      ) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "attributionValue.value must be a finite non-negative number",
          context: { field: "attributionValue.value" },
        });
      }
      if (!input.attributionValue?.unit?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "attributionValue.unit is required",
          context: { field: "attributionValue.unit" },
        });
      }
      const confidence = validateConfidenceEstimate(input.confidence);
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

      // The attributed observation must exist in the same org scope.
      const observation = await observationRepository.findById(
        input.observationId,
      );
      if (!observation) {
        throw new NotFoundError(
          `outcome observation not found: ${input.observationId}`,
          { observationId: input.observationId },
        );
      }
      if (observation.organizationScopeId !== input.organizationScopeId) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `outcome observation ${input.observationId} belongs to organization scope ${observation.organizationScopeId}, not ${input.organizationScopeId}`,
          context: { observationId: input.observationId },
        });
      }

      // Optional supporting evidence links.
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

      // ---- Mode-specific validation (distinct representations) ---------
      let deterministicLink: AttributionRecord["deterministicLink"] = null;
      let experimentId: AttributionRecord["experimentId"] = null;
      if (mode === "deterministic") {
        if (
          !input.deterministicLink ||
          !input.deterministicLink.linkType?.trim() ||
          !input.deterministicLink.linkIdentifier?.trim()
        ) {
          throw new OpenConError({
            code: "INVALID_ATTRIBUTION",
            classification: "validation",
            message:
              "deterministic attribution requires a deterministicLink with linkType and linkIdentifier (the unambiguous causal/mechanical link)",
            context: { mode },
          });
        }
        deterministicLink = Object.freeze({ ...input.deterministicLink });
      } else {
        // The modes are DISTINCT: a mechanical link on a non-deterministic
        // record is rejected (an identity link makes the attribution
        // deterministic by definition).
        if (input.deterministicLink !== undefined) {
          throw new OpenConError({
            code: "INVALID_ATTRIBUTION",
            classification: "validation",
            message: `${mode} attribution must NOT carry a deterministicLink — deterministic and ${mode} attribution are represented distinctly`,
            context: { mode },
          });
        }
        if (mode === "probabilistic") {
          // Model/method identity + quantified uncertainty are REQUIRED
          // (uncertainty is preserved, never collapsed).
          requireInterval(mode, confidence);
        }
        if (mode === "experimental") {
          if (!input.experimentId?.trim()) {
            throw new OpenConError({
              code: "INVALID_ATTRIBUTION",
              classification: "validation",
              message:
                "experimental attribution requires an experimentId referencing a controlled experiment",
              context: { mode },
            });
          }
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
          if (experiment.status === "INVALIDATED") {
            throw new OpenConError({
              code: "INVALID_ATTRIBUTION",
              classification: "validation",
              message: `measurement experiment ${input.experimentId} is INVALIDATED — an invalidated experiment cannot back experimental attribution`,
              context: {
                experimentId: input.experimentId,
                experimentStatus: experiment.status,
              },
            });
          }
          experimentId = experiment.id;
          requireInterval(mode, confidence);
        }
      }

      const attribution: AttributionRecord = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        observationId: observation.id,
        attributedSubject: input.attributedSubject,
        mode,
        attributionValue: Object.freeze({ ...input.attributionValue }),
        confidence,
        provenance,
        deterministicLink,
        experimentId,
        evidenceIds,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });

      // ---- Atomic mutation + audit --------------------------------------
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(attribution, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: ATTRIBUTION_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: attribution.id,
          resourceType: "attribution",
          resourceId: attribution.id,
          metadata: {
            observationId: attribution.observationId,
            attributedSubjectId: attribution.attributedSubject.subjectId,
            attributedSubjectType: attribution.attributedSubject.subjectType,
            mode: attribution.mode,
            attributionValue: attribution.attributionValue.value,
            attributionUnit: attribution.attributionValue.unit,
            confidencePoint: attribution.confidence.point,
            ...(attribution.confidence.lower !== undefined &&
            attribution.confidence.upper !== undefined
              ? {
                  confidenceInterval: [
                    attribution.confidence.lower,
                    attribution.confidence.upper,
                  ],
                }
              : {}),
            deterministicLinkType: attribution.deterministicLink?.linkType ?? null,
            experimentId: attribution.experimentId,
            method: attribution.provenance.method,
            methodVersion: attribution.provenance.methodVersion,
            sourceType: attribution.provenance.sourceType,
            organizationScopeId: attribution.organizationScopeId,
          },
        });
      });
      logger.info("attribution.created", {
        attributionId: attribution.id,
        mode: attribution.mode,
      });
      return attribution;
    },

    async getAttribution(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`attribution not found: ${id}`, {
          attributionId: id,
        });
      }
      return found;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
