/**
 * MeasuredOutcomeService — domain service orchestrating the measured
 * outcome maturation lifecycle (NET-W006 §3.5/§3.6).
 *
 * Architecture ref: spec/architecture.md §4 (Outcome), §13, §17
 * (authoritative workflow), §18; spec/architecture-lock.md §7
 * (workflow authority: ONLY /workflows mutates lifecycle state — this
 * service validates preconditions and REQUESTS transitions through
 * the WorkflowService), §4 (evidence, not participant/agent claims,
 * is authoritative — the finalized value is DERIVED by the
 * deterministic rollup, never caller-asserted).
 *
 * Division of responsibility (work order §4 invariant 7):
 *  - THIS service: domain preconditions (attachments legal only
 *    pre-finalization, rollup recorded, maturation strategy gate:
 *    fixed_window elapsed / event_driven maturationEvent) + domain
 *    mutations (attachments, rollup recording — audited atomically).
 *  - /workflows WorkflowService: EVERY lifecycle state change
 *    (authorization, transition legality, idempotency, optimistic
 *    concurrency, audit lineage with the authoritative transaction
 *    id).
 *
 * Version semantics: `version` is the LIFECYCLE version (workflow
 * transitions only). Domain mutations update `updatedAt` but not
 * `version`.
 *
 * THE KEY RULE (work order §2): measurement ≠ economic truth. The
 * measured outcome carries measured facts + uncertainty ONLY — no
 * credits, no settlement, no reputation, no pricing.
 *
 * Tier compliance: outcomes domain → self + core + the neutral
 * measurement port only (WorkflowService is consumed through the
 * structural interface declared HERE — the bootstrap composition root
 * injects it, the same pattern as the evidence domain's PoV service).
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { TransitionRequest, TransitionResult } from "../core/workflow.ts";
import { policyActionFor } from "../core/workflow.ts";
import { isStandardOutcomeType } from "../core/evidence.ts";
import { isMaturationStrategy, isRollupStrategy } from "../core/measurement.ts";
import type {
  AttributionRepository,
  CounterfactualBaselineRepository,
  CreateMeasuredOutcomeInput,
  IncrementalityObservationRepository,
  MeasurementSubjectLookup,
  MeasuredOutcome,
  MeasuredOutcomeRepository,
  MeasuredOutcomeService,
  MeasuredOutcomeTransitionInput,
  MeasuredOutcomeTransitionResult,
  OutcomeClaimLookup,
  OutcomeObservationRepository,
} from "./port.ts";
import { resolveHead } from "./observation-chains.ts";
import { rollupObservations } from "./measurement-rollup.ts";

const MEASUREMENT_CREATED = "measured_outcome.created" as const;
const MEASUREMENT_OBSERVATION_ATTACHED = "measured_outcome.observation_attached" as const;
const MEASUREMENT_ATTRIBUTION_ATTACHED = "measured_outcome.attribution_attached" as const;
const MEASUREMENT_BASELINE_ATTACHED = "measured_outcome.baseline_attached" as const;
const MEASUREMENT_INCREMENTALITY_ATTACHED = "measured_outcome.incrementality_attached" as const;
const MEASUREMENT_ROLLUP_RECORDED = "measured_outcome.rollup_recorded" as const;

/**
 * The workflow surface this service needs (structural interface — the
 * workflows port's WorkflowService satisfies it; declared HERE so the
 * outcomes domain does not import the workflows domain). The bootstrap
 * composition root injects the concrete workflow service.
 */
export interface MeasurementWorkflowAuthority {
  requestTransition(
    request: TransitionRequest,
    execution: ExecutionContext,
  ): Promise<TransitionResult>;
}

export interface MeasuredOutcomeServiceDeps {
  readonly repository: MeasuredOutcomeRepository;
  readonly observationRepository: OutcomeObservationRepository;
  readonly attributionRepository: AttributionRepository;
  readonly baselineRepository: CounterfactualBaselineRepository;
  readonly incrementalityRepository: IncrementalityObservationRepository;
  /** Validates the measured subject exists + resolves its org scope. */
  readonly subjectLookup: MeasurementSubjectLookup;
  /** Validates the optional OutcomeClaim link (evidence domain). */
  readonly outcomeClaimLookup: OutcomeClaimLookup;
  /** The /workflows authority (injected by the composition root). */
  readonly workflow: MeasurementWorkflowAuthority;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createMeasuredOutcomeService(
  deps: MeasuredOutcomeServiceDeps,
): MeasuredOutcomeService {
  const {
    repository,
    observationRepository,
    attributionRepository,
    baselineRepository,
    incrementalityRepository,
    subjectLookup,
    outcomeClaimLookup,
    workflow,
    authority,
    auditWriter,
    logger,
  } = deps;

  /** Load a measured outcome or throw NotFoundError. */
  async function requireMeasurement(id: string): Promise<MeasuredOutcome> {
    const measurement = await repository.findById(id);
    if (!measurement) {
      throw new NotFoundError(`measured outcome not found: ${id}`, {
        measurementId: id,
      });
    }
    return measurement;
  }

  /** Validate that an attachment source exists in the measurement's org scope. */
  function scopeErrorMessage(kind: string, id: string, scope: string | null): string {
    return `${kind} ${id} belongs to organization scope ${String(scope)}, not the measurement's scope`;
  }

  /**
   * Generic append-only attachment (idempotent no-op when already
   * attached; audited atomically with the mutation).
   */
  async function appendAttachment<K extends "observationIds" | "attributionIds" | "baselineIds" | "incrementalityIds">(
    execution: ExecutionContext,
    measurementId: string,
    attachId: string,
    field: K,
    resourceKind: string,
    eventType:
      | typeof MEASUREMENT_OBSERVATION_ATTACHED
      | typeof MEASUREMENT_ATTRIBUTION_ATTACHED
      | typeof MEASUREMENT_BASELINE_ATTACHED
      | typeof MEASUREMENT_INCREMENTALITY_ATTACHED,
  ): Promise<MeasuredOutcome> {
    const now = new Date().toISOString();
    const updated = await authority.run(execution, async (tx) => {
      const current = await repository.findByIdWithinTx(measurementId, tx);
      if (!current) {
        throw new NotFoundError(`measured outcome not found: ${measurementId}`, {
          measurementId,
        });
      }
      // Attachments are legal while the measurement is maturing
      // (DRAFT = pending, MEASURING = maturation window open — delayed
      // outcomes arrive during maturation); a FINALIZED (VERIFIED) or
      // CANCELLED measurement is frozen.
      if (current.state !== "DRAFT" && current.state !== "MEASURING") {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `${resourceKind} cannot be attached in state ${current.state} (allowed: DRAFT, MEASURING — a finalized measurement is frozen)`,
          context: { measurementId, state: current.state },
        });
      }
      // Resolve + scope-validate the attached record.
      let attachedScope: string | null = null;
      if (field === "observationIds") {
        const observation = await observationRepository.findById(attachId);
        if (!observation) {
          throw new NotFoundError(`outcome observation not found: ${attachId}`, {
            observationId: attachId,
          });
        }
        attachedScope = observation.organizationScopeId;
      } else if (field === "attributionIds") {
        const attribution = await attributionRepository.findById(attachId);
        if (!attribution) {
          throw new NotFoundError(`attribution not found: ${attachId}`, {
            attributionId: attachId,
          });
        }
        attachedScope = attribution.organizationScopeId;
      } else if (field === "baselineIds") {
        const baseline = await baselineRepository.findById(attachId);
        if (!baseline) {
          throw new NotFoundError(`counterfactual baseline not found: ${attachId}`, {
            baselineId: attachId,
          });
        }
        attachedScope = baseline.organizationScopeId;
      } else {
        const incrementality = await incrementalityRepository.findById(attachId);
        if (!incrementality) {
          throw new NotFoundError(
            `incrementality observation not found: ${attachId}`,
            { observationId: attachId },
          );
        }
        attachedScope = incrementality.organizationScopeId;
      }
      if (attachedScope !== current.organizationScopeId) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: scopeErrorMessage(resourceKind, attachId, attachedScope),
          context: { measurementId, [`${resourceKind}Id`]: attachId },
        });
      }
      const currentList = current[field] as readonly string[];
      if (currentList.includes(attachId)) {
        return current; // append-only idempotency
      }
      const appended: MeasuredOutcome = Object.freeze({
        ...current,
        [field]: [...currentList, attachId],
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        updatedAt: now,
      } as MeasuredOutcome);
      await repository.saveWithinTx(appended, current.version, execution, tx);
      const buffer = auditWriter.forTransaction(tx);
      await buffer.append({
        eventType,
        context: execution,
        actor: execution.actor?.id ?? null,
        subject: measurementId,
        resourceType: "measured_outcome",
        resourceId: measurementId,
        metadata: {
          attachedId: attachId,
          attachedKind: resourceKind,
          attachedCount: (appended[field] as readonly string[]).length,
          state: appended.state,
        },
      });
      return appended;
    });
    logger.info(eventType, { measurementId, attachedId: attachId });
    return updated;
  }

  /**
   * Request a lifecycle transition through the /workflows authority
   * (the SOLE lifecycle mutator) and wrap the result with the fresh
   * entity (mirrors the evidence domain's PoV transition helper).
   */
  async function requestLifecycleTransition(
    execution: ExecutionContext,
    input: MeasuredOutcomeTransitionInput,
    targetState: TransitionRequest["targetState"],
  ): Promise<MeasuredOutcomeTransitionResult> {
    const current = await requireMeasurement(input.measurementId);
    const request: TransitionRequest = {
      subjectId: input.measurementId,
      subjectKind: "outcome_measurement",
      targetState,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      actorPersonId: input.actorPersonId,
      policyAction: policyActionFor(
        "outcome_measurement",
        current.state,
        targetState,
      ),
      metadata: {
        ...(input.maturationEvent !== undefined
          ? { maturationEvent: input.maturationEvent }
          : {}),
        ...(input.metadata ?? {}),
      },
    };
    const result = await workflow.requestTransition(request, execution);
    const measurement = await repository.findById(input.measurementId);
    if (!measurement) {
      throw new NotFoundError(
        `measured outcome not found: ${input.measurementId}`,
        { measurementId: input.measurementId },
      );
    }
    return {
      measurement,
      executed: result.executed,
      transitionId: result.transitionId,
      recordId: result.recordId,
      auditEventName: result.auditEventName,
      executionId: result.executionId,
      correlationId: result.correlationId,
      causationId: result.causationId,
      transactionId: result.transactionId,
    };
  }

  const service: MeasuredOutcomeService = {
    async listVerifiedMeasuredOutcomesBySubject(
      execution,
      organizationScopeId,
      subjectId,
    ) {
      // NET-W021 (additive read): the canonical verified-performance
      // read. Only lifecycle-VERIFIED (finalized) measurements are
      // evidence — DRAFT/MEASURING are still maturing and CANCELLED
      // is void. The lifecycle semantics stay in THIS authority.
      void execution;
      const measurements = await repository.listBySubject(
        organizationScopeId,
        subjectId,
      );
      return measurements.filter((m) => m.state === "VERIFIED");
    },

    async createMeasuredOutcome(execution, input) {
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
      // The subject must exist and share the measurement's organization
      // scope (tenant scoping via the injected lookup — no
      // domain→domain import).
      const subjectExists = await subjectLookup.exists(
        input.subjectReference.subjectType,
        input.subjectReference.subjectId,
      );
      if (!subjectExists) {
        throw new NotFoundError(
          `${input.subjectReference.subjectType} ${input.subjectReference.subjectId} not found`,
          {
            subjectId: input.subjectReference.subjectId,
            subjectType: input.subjectReference.subjectType,
          },
        );
      }
      const subjectScope = await subjectLookup.getOrganizationScope(
        input.subjectReference.subjectType,
        input.subjectReference.subjectId,
      );
      if (subjectScope !== input.organizationScopeId) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `subject ${input.subjectReference.subjectId} belongs to organization scope ${String(subjectScope)}, not ${input.organizationScopeId}`,
          context: { subjectScope },
        });
      }
      // Optional OutcomeClaim link (NET-W005) — existence + scope.
      if (input.outcomeClaimId !== undefined) {
        if (!(await outcomeClaimLookup.exists(input.outcomeClaimId))) {
          throw new NotFoundError(
            `outcome claim not found: ${input.outcomeClaimId}`,
            { outcomeClaimId: input.outcomeClaimId },
          );
        }
        const claimScope = await outcomeClaimLookup.getOrganizationScope(
          input.outcomeClaimId,
        );
        if (claimScope !== input.organizationScopeId) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message: `outcome claim ${input.outcomeClaimId} belongs to organization scope ${String(claimScope)}, not ${input.organizationScopeId}`,
            context: { outcomeClaimId: input.outcomeClaimId },
          });
        }
      }
      // Maturation policy (work order §3.5).
      if (!isMaturationStrategy(input.maturation?.strategy)) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `maturation.strategy must be one of immediate, fixed_window, event_driven (got ${String(input.maturation?.strategy)})`,
          context: { field: "maturation.strategy" },
        });
      }
      const now = new Date().toISOString();
      const windowStartAt = input.maturation.windowStartAt ?? now;
      let windowEndAt: string | null = null;
      if (input.maturation.strategy === "fixed_window") {
        if (
          !input.maturation.windowEndAt ||
          !input.maturation.windowEndAt.trim()
        ) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message:
              "a fixed_window maturation policy requires windowEndAt (the delayed-outcome window)",
            context: { field: "maturation.windowEndAt" },
          });
        }
        if (input.maturation.windowEndAt <= windowStartAt) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message:
              "maturation.windowEndAt must be after windowStartAt (a non-positive maturation window is meaningless)",
            context: {
              windowStartAt,
              windowEndAt: input.maturation.windowEndAt,
            },
          });
        }
        windowEndAt = input.maturation.windowEndAt;
      }
      const rollupStrategy = input.rollupStrategy ?? "sum";
      if (!isRollupStrategy(rollupStrategy)) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `rollupStrategy must be "sum" or "latest" (got ${String(rollupStrategy)})`,
          context: { field: "rollupStrategy" },
        });
      }
      // Initial observation attachments (validated when present).
      const observationIds = input.observationIds ?? [];
      for (const observationId of observationIds) {
        const observation = await observationRepository.findById(observationId);
        if (!observation) {
          throw new NotFoundError(
            `outcome observation not found: ${observationId}`,
            { observationId },
          );
        }
        if (observation.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message: scopeErrorMessage(
              "outcome observation",
              observationId,
              observation.organizationScopeId,
            ),
            context: { observationId },
          });
        }
      }

      const draft: MeasuredOutcome = Object.freeze({
        id: randomUUID(),
        kind: "outcome_measurement",
        state: "DRAFT",
        version: 0,
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
        updatedAt: now,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType,
        outcomeClaimId: input.outcomeClaimId ?? null,
        observationIds,
        attributionIds: [],
        baselineIds: [],
        incrementalityIds: [],
        maturation: Object.freeze({
          strategy: input.maturation.strategy,
          windowStartAt,
          windowEndAt,
          maturationBasis: input.maturation.maturationBasis ?? null,
        }),
        rollup: null,
        rollupStrategy,
      });

      // ---- Atomic mutation + audit --------------------------------------
      await authority.run(execution, async (tx) => {
        await repository.createWithinTx(draft, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: MEASUREMENT_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: draft.id,
          resourceType: "measured_outcome",
          resourceId: draft.id,
          metadata: {
            subjectId: draft.subjectReference.subjectId,
            subjectType: draft.subjectReference.subjectType,
            outcomeType: draft.outcomeType,
            outcomeClaimId: draft.outcomeClaimId,
            maturationStrategy: draft.maturation.strategy,
            windowStartAt: draft.maturation.windowStartAt,
            windowEndAt: draft.maturation.windowEndAt,
            rollupStrategy: draft.rollupStrategy,
            initialObservationCount: draft.observationIds.length,
            organizationScopeId: draft.organizationScopeId,
          },
        });
      });
      logger.info("measured_outcome.created", { measurementId: draft.id });
      return draft;
    },

    async getMeasuredOutcome(_execution, id) {
      return requireMeasurement(id);
    },

    async attachObservation(execution, measurementId, observationId) {
      return appendAttachment(
        execution,
        measurementId,
        observationId,
        "observationIds",
        "outcome observation",
        MEASUREMENT_OBSERVATION_ATTACHED,
      );
    },

    async attachAttribution(execution, measurementId, attributionId) {
      return appendAttachment(
        execution,
        measurementId,
        attributionId,
        "attributionIds",
        "attribution",
        MEASUREMENT_ATTRIBUTION_ATTACHED,
      );
    },

    async attachBaseline(execution, measurementId, baselineId) {
      return appendAttachment(
        execution,
        measurementId,
        baselineId,
        "baselineIds",
        "counterfactual baseline",
        MEASUREMENT_BASELINE_ATTACHED,
      );
    },

    async attachIncrementality(execution, measurementId, incrementalityId) {
      return appendAttachment(
        execution,
        measurementId,
        incrementalityId,
        "incrementalityIds",
        "incrementality observation",
        MEASUREMENT_INCREMENTALITY_ATTACHED,
      );
    },

    async recordMeasurementRollup(execution, measurementId) {
      // ---- Deterministic rollup over chain-head observations ----------
      const now = new Date().toISOString();
      const updated = await authority.run(execution, async (tx) => {
        const current = await repository.findByIdWithinTx(measurementId, tx);
        if (!current) {
          throw new NotFoundError(
            `measured outcome not found: ${measurementId}`,
            { measurementId },
          );
        }
        // The rollup is recorded during MEASURING (the maturation
        // window — the observation set this value derives from is the
        // maturing set; mirrors the PoV aggregation-in-EVALUATING
        // placement).
        if (current.state !== "MEASURING") {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message: `the measurement rollup can be recorded only in state MEASURING (current: ${current.state})`,
            context: { measurementId, state: current.state },
          });
        }
        if (current.observationIds.length === 0) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message:
              "the measurement rollup requires at least one attached outcome observation",
            context: { measurementId },
          });
        }
        // Resolve each attached observation to its CHAIN HEAD (the
        // effective current measurement — corrections supersede) and
        // count the superseded corrections for auditability.
        const heads = [];
        let supersededCount = 0;
        for (const observationId of current.observationIds) {
          const head = await resolveHead(observationRepository, observationId);
          if (head.id !== observationId) supersededCount += 1;
          heads.push(head);
        }
        // PURE deterministic function (measurement-rollup.ts) — same
        // input, same output; enforces unit consistency + the
        // supporting-source gate (≥1 platform/attested/provider
        // observation — model/self alone can never finalize).
        const rollup = rollupObservations(
          heads,
          supersededCount,
          current.rollupStrategy,
          now,
        );
        const rolledUp: MeasuredOutcome = Object.freeze({
          ...current,
          rollup,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
          updatedAt: now,
        });
        await repository.saveWithinTx(rolledUp, current.version, execution, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: MEASUREMENT_ROLLUP_RECORDED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: measurementId,
          resourceType: "measured_outcome",
          resourceId: measurementId,
          metadata: {
            strategy: rollup.strategy,
            measuredValue: rollup.measuredValue.value,
            measuredUnit: rollup.measuredValue.unit,
            confidencePoint: rollup.confidence.point,
            confidenceInterval:
              rollup.confidence.lower !== undefined &&
              rollup.confidence.upper !== undefined
                ? [rollup.confidence.lower, rollup.confidence.upper]
                : null,
            observationCount: rollup.observationIds.length,
            supersededObservationCount: rollup.supersededObservationCount,
            derivedFrom: rollup.observationIds,
          },
        });
        return rolledUp;
      });
      logger.info("measured_outcome.rollup_recorded", { measurementId });
      return updated;
    },

    async beginMaturation(execution, input) {
      // DRAFT → MEASURING: open the maturation window. No observation
      // precondition (the window may run while observations arrive);
      // legality + authorization + idempotency are enforced by the
      // workflow.
      await requireMeasurement(input.measurementId);
      return requestLifecycleTransition(execution, input, "MEASURING");
    },

    async finalize(execution, input) {
      // MEASURING → VERIFIED (FINALIZE — explicit, authorized, audited;
      // work order §3.5 / invariant 6 — delayed outcomes cannot
      // silently become final):
      //   1. a recorded rollup (the finalized value is DERIVED, never
      //      caller-asserted — architecture-lock §4);
      //   2. fixed_window: the maturation window must have elapsed;
      //   3. event_driven: an explicit maturationEvent reference.
      const measurement = await requireMeasurement(input.measurementId);
      if (measurement.state === "MEASURING") {
        if (measurement.rollup === null) {
          throw new OpenConError({
            code: "MEASUREMENT_VALIDATION",
            classification: "validation",
            message:
              "the measurement cannot be finalized before its deterministic rollup is recorded",
            context: { measurementId: input.measurementId },
          });
        }
        const { strategy, windowEndAt } = measurement.maturation;
        if (strategy === "fixed_window") {
          const now = new Date();
          const end = new Date(windowEndAt!);
          if (Number.isNaN(end.getTime())) {
            throw new OpenConError({
              code: "MEASUREMENT_VALIDATION",
              classification: "validation",
              message: `the maturation windowEndAt is not a valid timestamp: ${String(windowEndAt)}`,
              context: { measurementId: input.measurementId, windowEndAt },
            });
          }
          if (now.getTime() < end.getTime()) {
            throw new OpenConError({
              code: "MEASUREMENT_VALIDATION",
              classification: "validation",
              message: `the measurement cannot be finalized before the maturation window elapses (windowEndAt ${windowEndAt})`,
              context: {
                measurementId: input.measurementId,
                windowEndAt,
                strategy,
              },
            });
          }
        }
        if (strategy === "event_driven") {
          if (!input.maturationEvent?.trim()) {
            throw new OpenConError({
              code: "MEASUREMENT_VALIDATION",
              classification: "validation",
              message:
                "an event_driven measurement requires an explicit maturationEvent reference to finalize (the auditable basis for why the outcome matured)",
              context: { measurementId: input.measurementId, strategy },
            });
          }
        }
      }
      return requestLifecycleTransition(execution, input, "VERIFIED");
    },

    async cancel(execution, input) {
      // DRAFT|MEASURING → CANCELLED.
      await requireMeasurement(input.measurementId);
      return requestLifecycleTransition(execution, input, "CANCELLED");
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
