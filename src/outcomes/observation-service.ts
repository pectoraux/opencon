/**
 * OutcomeObservationService — domain service for first-class,
 * immutable, append-corrected outcome observations (NET-W006 §3.1).
 *
 * Architecture ref: spec/architecture.md §4 (Outcome primitive),
 * §13 (measurement); spec/architecture-lock.md §4 (model output is
 * input, never authoritative), §3 (PostgreSQL authoritative).
 *
 * Immutability + append-correction (work order §3.1):
 *  - createOutcomeObservation persists a NEW immutable record;
 *  - correctOutcomeObservation persists a NEW record whose
 *    correctsObservationId references the CURRENT chain head; the
 *    corrected record must share the organization scope, the subject
 *    reference, and the outcome type; branching correction chains are
 *    rejected (the target must be the head — no other record may
 *    already correct it);
 *  - resolveObservationChain walks root → head and returns the full
 *    lineage (the original record is never rewritten).
 *
 * Provider ingestion (work order §3.7): ingestProviderObservations
 * pulls normalized reports from the injected provider-neutral
 * MeasurementProviderAdapter and persists them as provider-sourced
 * observations with full method/version/confidence provenance. The
 * provider id becomes the source id; the provider's attribution mode
 * (when reported) is recorded as a PROVENANCE fact, not a validated
 * protocol AttributionRecord. Provider output is a measurement INPUT
 * — never authoritative truth by virtue of its origin.
 *
 * Atomicity: every mutation (create, correct) commits together with
 * its audit record in ONE authoritative transaction (transactional
 * audit buffer bound to the same tx — AUD-002 lineage).
 *
 * Tier compliance: outcomes domain → self + core + the NEUTRAL
 * measurement port only.
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
import {
  isAttributionMode,
  validateMeasurementProvenance,
  type MeasurementProvenance,
} from "../core/measurement.ts";
import type {
  MeasurementProviderAdapter,
  ProviderObservationReport,
} from "../measurement/port.ts";
import type {
  CorrectOutcomeObservationInput,
  CreateOutcomeObservationInput,
  EvidenceRecordLookup,
  OutcomeClaimLookup,
  OutcomeObservation,
  OutcomeObservationRepository,
  OutcomeObservationService,
  ProviderIngestionResult,
} from "./port.ts";
import { resolveChain } from "./observation-chains.ts";

const OBSERVATION_CREATED = "outcome_observation.created" as const;
const OBSERVATION_CORRECTED = "outcome_observation.corrected" as const;

export interface OutcomeObservationServiceDeps {
  readonly repository: OutcomeObservationRepository;
  /** Validates optional OutcomeClaim links (no domain→domain import). */
  readonly outcomeClaimLookup: OutcomeClaimLookup;
  /** Validates optional Evidence links (no domain→domain import). */
  readonly evidenceLookup: EvidenceRecordLookup;
  /**
   * Provider-neutral measurement provider adapters (work order §3.7).
   * Concrete adapters are wired by the composition root; the domain
   * consumes only the neutral contract.
   */
  readonly providerAdapters: readonly MeasurementProviderAdapter[];
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/** Normalize + validate a provenance input object into the core shape. */
function toMeasurementProvenance(
  provenance: CreateOutcomeObservationInput["provenance"],
  fallbackCollectedAt: string,
): MeasurementProvenance {
  return validateMeasurementProvenance({
    sourceType: provenance.sourceType,
    ...(provenance.sourceId !== undefined
      ? { sourceId: provenance.sourceId }
      : {}),
    method: provenance.method,
    methodVersion: provenance.methodVersion,
    collectedAt: provenance.collectedAt ?? fallbackCollectedAt,
    ...(provenance.collectorId !== undefined
      ? { collectorId: provenance.collectorId }
      : {}),
  });
}

/** Validate an observed value (finite non-negative + non-empty unit). */
function validateObservedValue(value: number, unit: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OpenConError({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message: "observedValue.value must be a finite non-negative number",
      context: { field: "observedValue.value", value },
    });
  }
  if (typeof unit !== "string" || !unit.trim()) {
    throw new OpenConError({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message: "observedValue.unit is required",
      context: { field: "observedValue.unit" },
    });
  }
}

export function createOutcomeObservationService(
  deps: OutcomeObservationServiceDeps,
): OutcomeObservationService {
  const {
    repository,
    outcomeClaimLookup,
    evidenceLookup,
    providerAdapters,
    authority,
    auditWriter,
    logger,
  } = deps;

  /** Validate the optional OutcomeClaim + Evidence links. */
  async function validateLinks(
    organizationScopeId: string,
    outcomeClaimId: string | undefined,
    evidenceId: string | undefined,
  ): Promise<void> {
    if (outcomeClaimId !== undefined) {
      if (!(await outcomeClaimLookup.exists(outcomeClaimId))) {
        throw new NotFoundError(`outcome claim not found: ${outcomeClaimId}`, {
          outcomeClaimId,
        });
      }
      const scope = await outcomeClaimLookup.getOrganizationScope(
        outcomeClaimId,
      );
      if (scope !== organizationScopeId) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `outcome claim ${outcomeClaimId} belongs to organization scope ${String(scope)}, not ${organizationScopeId}`,
          context: { outcomeClaimId, claimScope: scope },
        });
      }
    }
    if (evidenceId !== undefined) {
      if (!(await evidenceLookup.exists(evidenceId))) {
        throw new NotFoundError(`evidence not found: ${evidenceId}`, {
          evidenceId,
        });
      }
      const scope = await evidenceLookup.getOrganizationScope(evidenceId);
      if (scope !== organizationScopeId) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `evidence ${evidenceId} belongs to organization scope ${String(scope)}, not ${organizationScopeId}`,
          context: { evidenceId, evidenceScope: scope },
        });
      }
    }
  }

  /** Common validation for create + correct. */
  async function validateInput(
    input: CreateOutcomeObservationInput,
    now: string,
  ): Promise<{
    outcomeType: OutcomeObservation["outcomeType"];
    confidence: OutcomeObservation["confidence"];
    provenance: MeasurementProvenance;
  }> {
    if (!input.organizationScopeId?.trim()) {
      throw new OpenConError({
        code: "MEASUREMENT_VALIDATION",
        classification: "validation",
        message: "organizationScopeId is required",
        context: { field: "organizationScopeId" },
      });
    }
    if (!input.observerId?.trim()) {
      throw new OpenConError({
        code: "MEASUREMENT_VALIDATION",
        classification: "validation",
        message: "observerId is required",
        context: { field: "observerId" },
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
    // OUT-001: observations name a type from the standard vocabulary.
    if (!isStandardOutcomeType(input.outcomeType)) {
      throw new OpenConError({
        code: "UNSUPPORTED_OUTCOME_TYPE",
        classification: "validation",
        message: `outcomeType must be one of the standard outcome types (got ${String(input.outcomeType)})`,
        context: { outcomeType: input.outcomeType },
      });
    }
    validateObservedValue(
      input.observedValue?.value,
      input.observedValue?.unit,
    );
    const confidence = validateConfidenceEstimate(input.confidence);
    const provenance = toMeasurementProvenance(input.provenance, now);
    await validateLinks(
      input.organizationScopeId,
      input.outcomeClaimId,
      input.evidenceId,
    );
    return { outcomeType: input.outcomeType, confidence, provenance };
  }

  /** Persist an observation + its audit record in ONE authoritative tx. */
  async function persistWithAudit(
    execution: ExecutionContext,
    observation: OutcomeObservation,
    eventType: typeof OBSERVATION_CREATED | typeof OBSERVATION_CORRECTED,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<OutcomeObservation> {
    await authority.run(execution, async (tx) => {
      await repository.saveWithinTx(observation, tx);
      const buffer = auditWriter.forTransaction(tx);
      await buffer.append({
        eventType,
        context: execution,
        actor: execution.actor?.id ?? null,
        subject: observation.id,
        resourceType: "outcome_observation",
        resourceId: observation.id,
        metadata: {
          ...metadata,
          organizationScopeId: observation.organizationScopeId,
          subjectId: observation.subjectReference.subjectId,
          subjectType: observation.subjectReference.subjectType,
          outcomeType: observation.outcomeType,
          observedValue: observation.observedValue.value,
          observedUnit: observation.observedValue.unit,
          confidencePoint: observation.confidence.point,
          sourceType: observation.provenance.sourceType,
          method: observation.provenance.method,
          methodVersion: observation.provenance.methodVersion,
        },
      });
    });
    return observation;
  }

  const service: OutcomeObservationService = {
    async createOutcomeObservation(execution, input) {
      const now = new Date().toISOString();
      const validated = await validateInput(input, now);
      const observation: OutcomeObservation = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        observerId: input.observerId,
        subjectReference: input.subjectReference,
        outcomeType: validated.outcomeType,
        outcomeClaimId: input.outcomeClaimId ?? null,
        evidenceId: input.evidenceId ?? null,
        observedValue: Object.freeze({ ...input.observedValue }),
        confidence: validated.confidence,
        provenance: validated.provenance,
        correctsObservationId: null,
        providerAttributionMode: null,
        externalSubjectRef: null,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });
      await persistWithAudit(
        execution,
        observation,
        OBSERVATION_CREATED,
        {},
      );
      logger.info("outcome_observation.created", {
        observationId: observation.id,
        outcomeType: observation.outcomeType,
      });
      return observation;
    },

    async getOutcomeObservation(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`outcome observation not found: ${id}`, {
          observationId: id,
        });
      }
      return found;
    },

    async listObservationsBySubject(_execution, subjectId) {
      return repository.listBySubject(subjectId);
    },

    async correctOutcomeObservation(execution, input) {
      // ---- Resolve + validate the correction target ---------------------
      const targetId = input.correctsObservationId;
      if (!targetId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "correctsObservationId is required for a correction",
          context: { field: "correctsObservationId" },
        });
      }
      const target = await repository.findById(targetId);
      if (!target) {
        throw new NotFoundError(`outcome observation not found: ${targetId}`, {
          observationId: targetId,
        });
      }
      if (target.organizationScopeId !== input.organizationScopeId) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `observation ${targetId} belongs to organization scope ${target.organizationScopeId}, not ${input.organizationScopeId}`,
          context: { observationId: targetId },
        });
      }
      // Branching chains are rejected: the target must be the CURRENT
      // chain head (no other record may already correct it).
      const existingCorrections = await repository.findByCorrectionOf(
        targetId,
      );
      if (existingCorrections.length > 0) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `observation ${targetId} is already corrected (chain head is ${existingCorrections[0]!.id}); corrections must target the chain head`,
          context: {
            observationId: targetId,
            existingCorrectionIds: existingCorrections.map((c) => c.id),
          },
        });
      }

      // ---- Validate the correction payload (same rules as create) -----
      // The correction INHERITS the target's subject reference + outcome
      // type: a different value/unit/type is a DIFFERENT observation,
      // not a correction (work order §3.1).
      const now = new Date().toISOString();
      const validated = await validateInput(
        {
          ...input,
          subjectReference: target.subjectReference,
          outcomeType: target.outcomeType,
        },
        now,
      );
      const correction: OutcomeObservation = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        observerId: input.observerId,
        subjectReference: target.subjectReference,
        outcomeType: target.outcomeType,
        // A correction inherits the corrected record's claim/evidence
        // links unless the caller explicitly overrides them.
        outcomeClaimId:
          input.outcomeClaimId !== undefined
            ? input.outcomeClaimId
            : target.outcomeClaimId,
        evidenceId:
          input.evidenceId !== undefined ? input.evidenceId : target.evidenceId,
        observedValue: Object.freeze({ ...input.observedValue }),
        confidence: validated.confidence,
        provenance: validated.provenance,
        correctsObservationId: targetId,
        providerAttributionMode: target.providerAttributionMode,
        externalSubjectRef: target.externalSubjectRef,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });
      await persistWithAudit(execution, correction, OBSERVATION_CORRECTED, {
        correctsObservationId: targetId,
        supersededValue: target.observedValue.value,
        supersededUnit: target.observedValue.unit,
      });
      logger.info("outcome_observation.corrected", {
        observationId: correction.id,
        correctsObservationId: targetId,
      });
      return correction;
    },

    async resolveObservationChain(_execution, id) {
      // Full correction lineage (root → head) via the shared chain
      // walkers (observation-chains.ts — the same single source of
      // truth the deterministic rollup uses).
      return resolveChain(repository, id);
    },

    async ingestProviderObservations(execution, input) {
      // ---- Provider-neutral ingestion (work order §3.7) -----------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.observerId?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "observerId is required",
          context: { field: "observerId" },
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
      const created: OutcomeObservation[] = [];
      for (const adapter of providerAdapters) {
        const fetch = await adapter.fetchObservations({
          subjectId: input.subjectReference.subjectId,
          subjectType: input.subjectReference.subjectType,
          ...(input.since !== undefined ? { since: input.since } : {}),
        });
        for (const report of fetch.observations) {
          // Normalize + validate the report (fail closed on invalid
          // reports — a provider cannot inject malformed facts).
          const observation = await normalizeProviderReport(
            execution,
            input,
            report,
            adapter.info.provider,
          );
          await persistWithAudit(
            execution,
            observation,
            OBSERVATION_CREATED,
            {
              ingestedFromProvider: adapter.info.provider,
              providerVersion: adapter.info.version,
              externalSubjectRef: report.externalSubjectRef,
            },
          );
          created.push(observation);
        }
      }
      logger.info("outcome_observation.provider_ingested", {
        providerCount: providerAdapters.length,
        createdCount: created.length,
      });
      const result: ProviderIngestionResult = {
        providerId:
          providerAdapters.length === 1
            ? providerAdapters[0]!.info.provider
            : "multi-provider",
        createdObservations: created,
      };
      return result;
    },
  };

  /** Normalize one provider report into a durable observation. */
  async function normalizeProviderReport(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly observerId: string;
      readonly subjectReference: OutcomeObservation["subjectReference"];
    },
    report: ProviderObservationReport,
    defaultProviderId: string,
  ): Promise<OutcomeObservation> {
    const providerId = report.providerId || defaultProviderId;
    if (!isStandardOutcomeType(report.outcomeType)) {
      throw new OpenConError({
        code: "UNSUPPORTED_OUTCOME_TYPE",
        classification: "validation",
        message: `provider ${providerId} reported a non-standard outcome type: ${String(report.outcomeType)}`,
        context: { providerId, outcomeType: report.outcomeType },
      });
    }
    validateObservedValue(
      report.observedValue?.value,
      report.observedValue?.unit,
    );
    const confidence = validateConfidenceEstimate(report.confidence);
    const provenance = validateMeasurementProvenance({
      // Provider-reported facts are provider-sourced (PROVIDER_REPORTED
      // grade when later elevated to evidence — NET-W005 rule table).
      sourceType: "provider",
      sourceId: providerId,
      method: report.method,
      methodVersion: report.methodVersion,
      collectedAt: report.collectedAt,
      collectorId: input.observerId,
    });
    const now = new Date().toISOString();
    return Object.freeze({
      id: randomUUID(),
      organizationScopeId: input.organizationScopeId,
      observerId: input.observerId,
      subjectReference: input.subjectReference,
      outcomeType: report.outcomeType,
      outcomeClaimId: null,
      evidenceId: null,
      observedValue: Object.freeze({ ...report.observedValue }),
      confidence,
      provenance,
      correctsObservationId: null,
      providerAttributionMode:
        report.attributionMode !== undefined &&
        isAttributionMode(report.attributionMode)
          ? report.attributionMode
          : null,
      externalSubjectRef: report.externalSubjectRef,
      executionId: execution.executionId,
      correlationId: execution.correlationId,
      causationId: execution.causationId,
      createdAt: now,
    });
  }

  return service;
}

export { NotFoundError, OpenConError };
