/**
 * MeasurementExperimentService — domain service for controlled
 * experiments / holdouts (NET-W006 §3.3; OUT-003).
 *
 * Architecture ref: spec/architecture.md §13 (experimental
 * incrementality); spec/architecture-lock.md §3 (PostgreSQL
 * authoritative).
 *
 * The experiment STATUS lifecycle is measurement-INPUT state:
 *
 * ```text
 * PLANNED → RUNNING → COMPLETED
 * PLANNED|RUNNING → INVALIDATED
 * ```
 *
 * COMPLETED and INVALIDATED are terminal for measurement validity.
 * Every status change is a deterministic, version-checked (optimistic
 * concurrency), audited, atomic mutation (transactional audit buffer
 * bound to the same authoritative tx). Experiment status does NOT
 * route through /workflows — that machinery is for protocol lifecycle
 * subjects (architecture §17); experiment status feeds measurement
 * validity (which experiments can back attribution/incrementality).
 *
 * Tier compliance: outcomes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  ExperimentStatusChangeInput,
  MeasurementExperiment,
  MeasurementExperimentRepository,
  MeasurementExperimentService,
} from "./port.ts";

const EXPERIMENT_CREATED = "measurement_experiment.created" as const;
const EXPERIMENT_STARTED = "measurement_experiment.started" as const;
const EXPERIMENT_COMPLETED = "measurement_experiment.completed" as const;
const EXPERIMENT_INVALIDATED = "measurement_experiment.invalidated" as const;

export interface MeasurementExperimentServiceDeps {
  readonly repository: MeasurementExperimentRepository;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createMeasurementExperimentService(
  deps: MeasurementExperimentServiceDeps,
): MeasurementExperimentService {
  const { repository, authority, auditWriter, logger } = deps;

  /** Apply a status change with optimistic concurrency + atomic audit. */
  async function applyStatusChange(
    execution: ExecutionContext,
    input: ExperimentStatusChangeInput,
    targetStatus: MeasurementExperiment["status"],
    eventType:
      | typeof EXPERIMENT_STARTED
      | typeof EXPERIMENT_COMPLETED
      | typeof EXPERIMENT_INVALIDATED,
    extraMetadata: Readonly<Record<string, unknown>>,
  ): Promise<MeasurementExperiment> {
    const now = new Date().toISOString();
    return authority.run(execution, async (tx) => {
      const current = await repository.findByIdWithinTx(input.experimentId, tx);
      if (!current) {
        throw new NotFoundError(
          `measurement experiment not found: ${input.experimentId}`,
          { experimentId: input.experimentId },
        );
      }
      if (input.expectedVersion !== current.version) {
        throw new ConflictError(
          `stale writer for measurement experiment ${input.experimentId}: expected version ${input.expectedVersion}, authoritative version ${current.version}`,
          {
            experimentId: input.experimentId,
            expectedVersion: input.expectedVersion,
            authoritativeVersion: current.version,
          },
        );
      }
      // Deterministic status machine (work order §3.3).
      const legal: Record<string, readonly string[]> = {
        RUNNING: ["PLANNED"],
        COMPLETED: ["RUNNING"],
        INVALIDATED: ["PLANNED", "RUNNING"],
      };
      if (!legal[targetStatus]!.includes(current.status)) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: `measurement experiment ${input.experimentId} cannot move ${current.status} → ${targetStatus} (legal sources: ${legal[targetStatus]!.join(", ")})`,
          context: {
            experimentId: input.experimentId,
            fromStatus: current.status,
            toStatus: targetStatus,
          },
        });
      }
      const updated: MeasurementExperiment = Object.freeze({
        ...current,
        status: targetStatus,
        startedAt:
          targetStatus === "RUNNING" ? now : current.startedAt,
        completedAt:
          targetStatus === "COMPLETED" ? now : current.completedAt,
        invalidatedAt:
          targetStatus === "INVALIDATED" ? now : current.invalidatedAt,
        invalidationReason:
          targetStatus === "INVALIDATED"
            ? String(extraMetadata["reason"] ?? "not specified")
            : current.invalidationReason,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        updatedAt: now,
        version: current.version + 1,
      });
      await repository.saveWithinTx(updated, tx);
      const buffer = auditWriter.forTransaction(tx);
      await buffer.append({
        eventType,
        context: execution,
        actor: execution.actor?.id ?? null,
        subject: updated.id,
        resourceType: "measurement_experiment",
        resourceId: updated.id,
        metadata: {
          fromStatus: current.status,
          toStatus: targetStatus,
          fromVersion: current.version,
          toVersion: updated.version,
          ...extraMetadata,
        },
      });
      return updated;
    });
  }

  const service: MeasurementExperimentService = {
    async createMeasurementExperiment(execution, input) {
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
      if (!input.experimentType?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "experimentType is required (provider-neutral design label, e.g. \"holdout\")",
          context: { field: "experimentType" },
        });
      }
      const now = new Date().toISOString();
      const experiment: MeasurementExperiment = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        experimentType: input.experimentType,
        hypothesis: input.hypothesis ?? null,
        status: "PLANNED",
        startedAt: null,
        completedAt: null,
        invalidatedAt: null,
        invalidationReason: null,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
        updatedAt: now,
        version: 0,
      });
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(experiment, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: EXPERIMENT_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: experiment.id,
          resourceType: "measurement_experiment",
          resourceId: experiment.id,
          metadata: {
            experimentType: experiment.experimentType,
            hypothesis: experiment.hypothesis,
            organizationScopeId: experiment.organizationScopeId,
          },
        });
      });
      logger.info("measurement_experiment.created", {
        experimentId: experiment.id,
        experimentType: experiment.experimentType,
      });
      return experiment;
    },

    async getMeasurementExperiment(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`measurement experiment not found: ${id}`, {
          experimentId: id,
        });
      }
      return found;
    },

    async startExperiment(execution, input) {
      const updated = await applyStatusChange(
        execution,
        input,
        "RUNNING",
        EXPERIMENT_STARTED,
        {},
      );
      logger.info("measurement_experiment.started", {
        experimentId: updated.id,
      });
      return updated;
    },

    async completeExperiment(execution, input) {
      const updated = await applyStatusChange(
        execution,
        input,
        "COMPLETED",
        EXPERIMENT_COMPLETED,
        {},
      );
      logger.info("measurement_experiment.completed", {
        experimentId: updated.id,
      });
      return updated;
    },

    async invalidateExperiment(execution, input) {
      if (!input.reason?.trim()) {
        throw new OpenConError({
          code: "MEASUREMENT_VALIDATION",
          classification: "validation",
          message: "a reason is required to invalidate a measurement experiment",
          context: { field: "reason" },
        });
      }
      const updated = await applyStatusChange(
        execution,
        input,
        "INVALIDATED",
        EXPERIMENT_INVALIDATED,
        { reason: input.reason },
      );
      logger.info("measurement_experiment.invalidated", {
        experimentId: updated.id,
        reason: input.reason,
      });
      return updated;
    },
  };

  return service;
}

export { ConflictError, NotFoundError, OpenConError };
