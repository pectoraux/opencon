/**
 * RiskAssessmentService — domain service for the multi-signal,
 * provenance-preserving risk assessments (NET-W009 §3.5).
 *
 * Architecture ref: spec/architecture.md §12 (multi-signal fraud
 * analysis), §19; spec/architecture-lock.md §4/§5 (model output is
 * input, never authoritative), §12 (execution lineage), §13 invariant
 * 21 (fraud-held claims cannot mature — assessments feed the control
 * decisions that gate maturation).
 *
 * THE ENGINE BOUNDARY: this service NEVER reimplements evaluation —
 * preview AND record both run the PURE `evaluateRisk` engine
 * (src/disputes/risk-engine.ts) over the transaction-consistent
 * signal set. Determinism (work order §4 invariant 4): identical
 * committed signals + policy/version + evaluatedAt ⇒ identical
 * contributions/score/state/digest, bit for bit.
 *
 * Append-only supersession: re-evaluation creates a NEW assessment
 * referencing the previous latest (`supersedesAssessmentId`); the
 * previous latest's back-pointer flips in the SAME transaction (a
 * state flip, never a content rewrite — history stays byte-identical;
 * the work item's "corrections create new assessments referencing
 * superseded records").
 *
 * Atomicity: assessment + idempotency record + audit event
 * (`risk_assessment.recorded`) commit in ONE authoritative transaction
 * (IdempotencyStore.applyIdempotent; NET-W004-AC-07; AUD-005).
 *
 * Tier compliance: disputes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import {
  NotFoundError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { evaluateRisk } from "./risk-engine.ts";
import type {
  RecordRiskAssessmentInput,
  RecordRiskAssessmentResult,
  RiskAssessment,
  RiskAssessmentRepository,
  RiskAssessmentService,
  RiskPolicyRepository,
  RiskSignalRepository,
  RiskSubjectRef,
} from "./port.ts";

const ASSESSMENT_RECORDED = "risk_assessment.recorded" as const;

export interface RiskAssessmentServiceDeps {
  readonly assessmentRepository: RiskAssessmentRepository;
  readonly signalRepository: RiskSignalRepository;
  readonly policyRepository: RiskPolicyRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createRiskAssessmentService(
  deps: RiskAssessmentServiceDeps,
): RiskAssessmentService {
  const {
    assessmentRepository,
    signalRepository,
    policyRepository,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  function validateCommon(
    input: { organizationScopeId: string; subjectPersonId: string; evaluatedAt: string; policyId: string },
  ): void {
    if (!input.organizationScopeId?.trim()) {
      throw new OpenConError({
        code: "RISK_ASSESSMENT_VALIDATION",
        classification: "validation",
        message: "organizationScopeId is required",
        context: { field: "organizationScopeId" },
      });
    }
    if (!input.subjectPersonId?.trim()) {
      throw new OpenConError({
        code: "RISK_ASSESSMENT_VALIDATION",
        classification: "validation",
        message: "subjectPersonId is required",
        context: { field: "subjectPersonId" },
      });
    }
    if (!input.policyId?.trim()) {
      throw new OpenConError({
        code: "RISK_ASSESSMENT_VALIDATION",
        classification: "validation",
        message: "policyId is required (the exact policy lineage)",
        context: { field: "policyId" },
      });
    }
    if (!input.evaluatedAt || Number.isNaN(Date.parse(input.evaluatedAt))) {
      throw new OpenConError({
        code: "RISK_ASSESSMENT_VALIDATION",
        classification: "validation",
        message: "evaluatedAt must be an ISO-8601 timestamp (explicit — deterministic, no wall-clock races)",
        context: { evaluatedAt: input.evaluatedAt },
      });
    }
  }

  const service: RiskAssessmentService = {
    async previewAssessment(execution, input) {
      validateCommon(input);
      // Exact policy version (explicit or the lineage's latest).
      const policy = input.version !== undefined
        ? await policyRepository.findVersion(input.policyId, input.version)
        : await policyRepository.findLatestVersion(input.policyId);
      if (!policy) {
        throw new NotFoundError(
          `risk policy version not found: ${input.policyId}${input.version !== undefined ? ` v${String(input.version)}` : " (latest)"}`,
          { policyId: input.policyId, version: input.version },
        );
      }
      if (policy.organizationScopeId !== input.organizationScopeId) {
        throw new OpenConError({
          code: "RISK_ASSESSMENT_VALIDATION",
          classification: "validation",
          message: `risk policy lineage ${input.policyId} belongs to organization scope ${policy.organizationScopeId}, not ${input.organizationScopeId}`,
          context: {
            policyId: input.policyId,
            policyScope: policy.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        });
      }
      const signals = await signalRepository.listBySubject(
        input.organizationScopeId,
        input.subjectPersonId,
      );
      const result = evaluateRisk(
        policy,
        input.subjectPersonId,
        signals,
        input.evaluatedAt,
      );
      return {
        organizationScopeId: input.organizationScopeId,
        subjectPersonId: input.subjectPersonId,
        subjectRef: input.subjectRef ?? null,
        policyId: result.policyId,
        policyVersion: result.policyVersion,
        evaluatedAt: result.evaluatedAt,
        signalIds: result.signalIds,
        contributions: result.contributions,
        score: result.score,
        state: result.state,
        missingCategories: result.missingCategories,
        digest: result.digest,
      };
    },

    async recordAssessment(
      execution,
      input: RecordRiskAssessmentInput,
    ): Promise<RecordRiskAssessmentResult> {
      validateCommon(input);
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_ASSESSMENT_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      const key = `risk_assessment:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // Resolve the exact policy version IN-TX (transaction
          // consistency) and enforce the org-scope match.
          const policy = input.version !== undefined
            ? await policyRepository.findVersionWithinTx(input.policyId, input.version, tx)
            : await policyRepository.findLatestVersionWithinTx(input.policyId, undefined, tx);
          if (!policy) {
            throw new NotFoundError(
              `risk policy version not found: ${input.policyId}${input.version !== undefined ? ` v${String(input.version)}` : " (latest)"}`,
              { policyId: input.policyId, version: input.version },
            );
          }
          if (policy.organizationScopeId !== input.organizationScopeId) {
            throw new OpenConError({
              code: "RISK_ASSESSMENT_VALIDATION",
              classification: "validation",
              message: `risk policy lineage ${input.policyId} belongs to organization scope ${policy.organizationScopeId}, not ${input.organizationScopeId}`,
              context: {
                policyId: input.policyId,
                policyScope: policy.organizationScopeId,
                requestedScope: input.organizationScopeId,
              },
            });
          }
          // Transaction-consistent signal set (same org + subject).
          const signals = await signalRepository.listBySubjectWithinTx(
            input.organizationScopeId,
            input.subjectPersonId,
            tx,
          );
          // THE deterministic engine (pure).
          const result = evaluateRisk(
            policy,
            input.subjectPersonId,
            signals,
            input.evaluatedAt,
          );
          // Append-only supersession of the previous latest.
          const history = await assessmentRepository.listBySubjectWithinTx(
            input.organizationScopeId,
            input.subjectPersonId,
            tx,
          );
          const previous =
            history.length > 0
              ? (history.find((a) => a.supersededByAssessmentId === null) ??
                history[history.length - 1]!)
              : null;
          const assessment: RiskAssessment = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            subjectPersonId: input.subjectPersonId,
            subjectRef: input.subjectRef ?? null,
            policyId: result.policyId,
            policyVersion: result.policyVersion,
            evaluatedAt: result.evaluatedAt,
            recordedAt: new Date().toISOString(),
            signalIds: result.signalIds,
            contributions: result.contributions,
            score: result.score,
            state: result.state,
            missingCategories: result.missingCategories,
            digest: result.digest,
            supersedesAssessmentId: previous ? previous.id : null,
            supersededByAssessmentId: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          if (previous) {
            const flipped: RiskAssessment = Object.freeze({
              ...previous,
              supersededByAssessmentId: assessment.id,
            });
            await assessmentRepository.putSupersessionWithinTx(
              flipped,
              assessment,
              tx,
            );
          } else {
            await assessmentRepository.createWithinTx(assessment, tx);
          }
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: ASSESSMENT_RECORDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: assessment.id,
            resourceType: "risk_assessment",
            resourceId: assessment.id,
            metadata: {
              organizationScopeId: assessment.organizationScopeId,
              subjectPersonId: assessment.subjectPersonId,
              policyId: assessment.policyId,
              policyVersion: assessment.policyVersion,
              evaluatedAt: assessment.evaluatedAt,
              state: assessment.state,
              score: assessment.score,
              digest: assessment.digest,
              signalCount: assessment.signalIds.length,
              supersedesAssessmentId: assessment.supersedesAssessmentId,
              missingCategories: assessment.missingCategories,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return assessment;
        },
        execution,
      );
      logger.info("risk_assessment.recorded", {
        assessmentId: applied.result.id,
        state: applied.result.state,
        score: applied.result.score,
        created: applied.executed,
      });
      return { assessment: applied.result, created: applied.executed };
    },

    async getAssessment(_execution, id) {
      const found = await assessmentRepository.findById(id);
      if (!found) {
        throw new NotFoundError(`risk assessment not found: ${id}`, {
          assessmentId: id,
        });
      }
      return found;
    },

    async getAssessmentHistory(_execution, organizationScopeId, subjectPersonId) {
      return assessmentRepository.listBySubject(
        organizationScopeId,
        subjectPersonId,
      );
    },

    async getLatestAssessment(_execution, organizationScopeId, subjectPersonId) {
      return assessmentRepository.findLatestBySubject(
        organizationScopeId,
        subjectPersonId,
      );
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type { RiskSubjectRef };
