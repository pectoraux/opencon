/**
 * RiskControlService — domain service for the control decisions that
 * gate downstream workflow and economic operations (NET-W009 §3.7).
 *
 * Architecture ref: spec/architecture.md §17 (FRAUD_REVIEW is a
 * workflow state owned by /workflows — this boundary NEVER mutates
 * lifecycle state itself), §18 (module ownership), §19;
 * spec/architecture-lock.md §13 invariant 21 ("a disputed or
 * fraud-held claim cannot mature until the applicable resolution
 * policy permits it" — the ENFORCEMENT POINT is the composition-root
 * economic gate consulting THIS registry), §12 (execution lineage).
 *
 * THE CONTROL MODEL:
 *  - a control is an append-only state carrier: activation persists
 *    one record; resolution flips `state` to RESOLVED through this
 *    audited, idempotent command (activation history never rewritten);
 *  - a material control MUST cite its origin — `originAssessmentId`
 *    and/or `originCaseId` (invariant 3): the referenced record must
 *    exist, be NON-SUPERSEDED (an assessment still current) /
 *    non-RESOLVED-irrelevant (a case may be open or under review) and
 *    belong to the SAME organization scope;
 *  - controls NEVER mutate downstream authorities: /workflows and
 *    /settlement gates READ the active-control registry
 *    (`findGatingControl`) and refuse their OWN operations.
 *
 * Atomicity: control + idempotency record + audit event
 * (`risk_control.activated` / `risk_control.resolved`) commit in ONE
 * authoritative transaction (IdempotencyStore.applyIdempotent;
 * NET-W004-AC-07; AUD-005 administrative action logging).
 *
 * Tier compliance: disputes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import {
  ConflictError,
  NotFoundError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  isRiskControlAction,
  isRiskOperationClass,
  type RiskOperationClass,
} from "../core/risk.ts";
import type {
  ActivateRiskControlInput,
  ResolveRiskControlInput,
  RiskAssessmentRepository,
  RiskCaseRepository,
  RiskControlDecision,
  RiskControlRepository,
  RiskControlService,
} from "./port.ts";
import { parseSubjectRef } from "./source-validation.ts";

const CONTROL_ACTIVATED = "risk_control.activated" as const;
const CONTROL_RESOLVED = "risk_control.resolved" as const;

export interface RiskControlServiceDeps {
  readonly repository: RiskControlRepository;
  readonly assessmentRepository: RiskAssessmentRepository;
  readonly caseRepository: RiskCaseRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createRiskControlService(
  deps: RiskControlServiceDeps,
): RiskControlService {
  const {
    repository,
    assessmentRepository,
    caseRepository,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  const service: RiskControlService = {
    async activateControl(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!isRiskOperationClass(input.operationClass)) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: `operationClass must be one of the control operation classes (got ${String(input.operationClass)})`,
          context: { operationClass: input.operationClass },
        });
      }
      if (!isRiskControlAction(input.action)) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: `action must be one of REQUIRE_REVIEW, HOLD, BLOCK (got ${String(input.action)})`,
          context: { action: input.action },
        });
      }
      const operationClass: RiskOperationClass = input.operationClass;
      // Captured narrowed const (closure type-narrowing).
      const action = input.action;
      if (
        (input.subjectPersonId === undefined || input.subjectPersonId === null || !input.subjectPersonId.trim()) &&
        input.subjectRef === undefined
      ) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: "a control requires a subject: subjectPersonId and/or subjectRef",
          context: { subjectPersonId: input.subjectPersonId, subjectRef: input.subjectRef },
        });
      }
      if (
        !input.originAssessmentId?.trim() &&
        !input.originCaseId?.trim()
      ) {
        // Invariant 3: evidence-backed material decisions. A control
        // with no assessment/case origin is a hidden decision.
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: "a risk control requires an origin: originAssessmentId and/or originCaseId (evidence-backed material decisions)",
          context: { originAssessmentId: input.originAssessmentId, originCaseId: input.originCaseId },
        });
      }
      if (
        !Array.isArray(input.reasonCodes) ||
        input.reasonCodes.length === 0 ||
        input.reasonCodes.some((c) => typeof c !== "string" || !c.trim())
      ) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: "reasonCodes is required (at least one non-empty code)",
          context: { reasonCodes: input.reasonCodes },
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      const subjectRef = parseSubjectRef(input.subjectRef);

      // Origin validation (existence + org scope + currency).
      if (input.originAssessmentId?.trim()) {
        const assessment = await assessmentRepository.findById(
          input.originAssessmentId,
        );
        if (!assessment) {
          throw new NotFoundError(
            `risk assessment not found: ${input.originAssessmentId}`,
            { assessmentId: input.originAssessmentId },
          );
        }
        if (assessment.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "RISK_CONTROL_VALIDATION",
            classification: "validation",
            message: `origin assessment ${assessment.id} belongs to organization scope ${assessment.organizationScopeId}, not ${input.organizationScopeId}`,
            context: {
              assessmentScope: assessment.organizationScopeId,
              requestedScope: input.organizationScopeId,
            },
          });
        }
        if (assessment.supersededByAssessmentId !== null) {
          throw new ConflictError(
            `origin assessment ${assessment.id} is superseded by ${assessment.supersededByAssessmentId}; activate from the current assessment`,
            {
              assessmentId: assessment.id,
              supersededBy: assessment.supersededByAssessmentId,
            },
          );
        }
      }
      if (input.originCaseId?.trim()) {
        const riskCase = await caseRepository.findById(input.originCaseId);
        if (!riskCase) {
          throw new NotFoundError(`risk case not found: ${input.originCaseId}`, {
            caseId: input.originCaseId,
          });
        }
        if (riskCase.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "RISK_CONTROL_VALIDATION",
            classification: "validation",
            message: `origin case ${riskCase.id} belongs to organization scope ${riskCase.organizationScopeId}, not ${input.organizationScopeId}`,
            context: {
              caseScope: riskCase.organizationScopeId,
              requestedScope: input.organizationScopeId,
            },
          });
        }
        if (riskCase.state === "RESOLVED") {
          throw new ConflictError(
            `origin case ${riskCase.id} is already RESOLVED (${riskCase.resolution}); it cannot activate new controls`,
            { caseId: riskCase.id, resolution: riskCase.resolution },
          );
        }
      }

      const actor = execution.actor?.id ?? "unknown";
      const key = `risk_control_activate:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const control: RiskControlDecision = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            operationClass,
            action,
            subjectPersonId: input.subjectPersonId?.trim() || null,
            subjectRef,
            originAssessmentId: input.originAssessmentId?.trim() || null,
            originCaseId: input.originCaseId?.trim() || null,
            reasonCodes: input.reasonCodes.map((c) => c.trim()),
            description: input.description?.trim() || null,
            state: "ACTIVE",
            activatedBy: actor,
            activatedAt: new Date().toISOString(),
            resolvedBy: null,
            resolvedAt: null,
            resolvedViaCaseDecisionId: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await repository.createWithinTx(control, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CONTROL_ACTIVATED,
            context: execution,
            actor,
            subject: control.id,
            resourceType: "risk_control_decision",
            resourceId: control.id,
            metadata: {
              organizationScopeId: control.organizationScopeId,
              operationClass: control.operationClass,
              action: control.action,
              subjectPersonId: control.subjectPersonId,
              subjectRef: control.subjectRef
                ? `${control.subjectRef.subjectType}:${control.subjectRef.subjectId}`
                : null,
              originAssessmentId: control.originAssessmentId,
              originCaseId: control.originCaseId,
              reasonCodes: control.reasonCodes,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return control;
        },
        execution,
      );
      logger.info("risk_control.activated", {
        controlDecisionId: applied.result.id,
        operationClass: applied.result.operationClass,
        action: applied.result.action,
        created: applied.executed,
      });
      return { control: applied.result, created: applied.executed };
    },

    async resolveControl(execution, input: ResolveRiskControlInput) {
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_CONTROL_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      const control = await repository.findById(input.controlDecisionId);
      if (!control) {
        throw new NotFoundError(
          `risk control decision not found: ${input.controlDecisionId}`,
          { controlDecisionId: input.controlDecisionId },
        );
      }
      if (control.state === "RESOLVED") {
        throw new ConflictError(
          `risk control decision ${control.id} is already RESOLVED`,
          { controlDecisionId: control.id },
        );
      }
      // When resolving via a case decision, the decision must exist on
      // the control's origin case (resolution lineage linkage).
      if (input.caseDecisionId?.trim()) {
        if (!control.originCaseId) {
          throw new OpenConError({
            code: "RISK_CONTROL_VALIDATION",
            classification: "validation",
            message: "the control has no origin case; caseDecisionId cannot be linked",
            context: { controlDecisionId: control.id },
          });
        }
        const riskCase = await caseRepository.findById(control.originCaseId);
        const decision = riskCase?.decisions.find(
          (d) => d.id === input.caseDecisionId,
        );
        if (!decision) {
          throw new NotFoundError(
            `case decision ${input.caseDecisionId} not found on origin case ${control.originCaseId}`,
            { caseDecisionId: input.caseDecisionId, caseId: control.originCaseId },
          );
        }
        if (riskCase!.state !== "RESOLVED") {
          throw new ConflictError(
            `origin case ${control.originCaseId} is ${riskCase!.state}; controls linked to its decisions can only be resolved after the case resolves`,
            { caseId: control.originCaseId, caseState: riskCase!.state },
          );
        }
      }
      const actor = execution.actor?.id ?? "unknown";
      const key = `risk_control_resolve:${control.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(control.id, tx);
          if (!current) {
            throw new NotFoundError(
              `risk control decision not found: ${control.id}`,
              { controlDecisionId: control.id },
            );
          }
          if (current.state === "RESOLVED") {
            throw new ConflictError(
              `risk control decision ${current.id} is already RESOLVED`,
              { controlDecisionId: current.id },
            );
          }
          const resolved: RiskControlDecision = Object.freeze({
            ...current,
            state: "RESOLVED",
            resolvedBy: actor,
            resolvedAt: new Date().toISOString(),
            resolvedViaCaseDecisionId: input.caseDecisionId?.trim() || null,
          });
          await repository.saveWithinTx(resolved, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CONTROL_RESOLVED,
            context: execution,
            actor,
            subject: resolved.id,
            resourceType: "risk_control_decision",
            resourceId: resolved.id,
            metadata: {
              organizationScopeId: resolved.organizationScopeId,
              controlDecisionId: resolved.id,
              operationClass: resolved.operationClass,
              resolvedViaCaseDecisionId: resolved.resolvedViaCaseDecisionId,
              note: input.note?.trim() || null,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return resolved;
        },
        execution,
      );
      logger.info("risk_control.resolved", {
        controlDecisionId: applied.result.id,
        operationClass: applied.result.operationClass,
      });
      return applied.result;
    },

    async getControl(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`risk control decision not found: ${id}`, {
          controlDecisionId: id,
        });
      }
      return found;
    },

    async listControls(_execution, organizationScopeId, states) {
      return repository.listByOrganization(organizationScopeId, states);
    },

    async findGatingControl(
      _execution,
      organizationScopeId,
      operationClass,
      recordSubjectId,
      personSubjectId,
    ) {
      // Person-scoped match first (a person-wide hold gates everything
      // for that person), then record-scoped.
      const active = await repository.findActiveControls(
        organizationScopeId,
        operationClass,
      );
      const personMatch = personSubjectId
        ? active.find((c) => c.subjectPersonId === personSubjectId)
        : undefined;
      if (personMatch) return personMatch;
      const recordMatch = recordSubjectId
        ? active.find(
            (c) =>
              c.subjectRef !== null && c.subjectRef.subjectId === recordSubjectId,
          )
        : undefined;
      return recordMatch ?? null;
    },
  };

  return service;
}

export { NotFoundError, OpenConError, ConflictError };
export type { ExecutionContext };
