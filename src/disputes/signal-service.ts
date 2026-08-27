/**
 * RiskSignalService — domain service for the first-class, append-only
 * risk signals (NET-W009 §3.2).
 *
 * Architecture ref: spec/architecture.md §12 (multi-signal fraud
 * detection — no single signal authoritative), §19 (model output is
 * never sufficient by itself);
 * spec/architecture-lock.md §4/§5 (model output is input, never
 * authoritative), §12 (execution lineage).
 *
 * THE GATES (work order §4 invariant 3 + 5):
 *  - ≥1 authoritative source ref on EVERY signal, resolved through the
 *    injected neutral lookups with organization-scope enforcement
 *    (tenant isolation, invariant 6) — a bare assertion cannot enter;
 *  - `advisory` is DERIVED from the provenance kind (`model_output` ⇒
 *    ALWAYS advisory — never caller-asserted; invariant 5);
 *  - corrections are append-only supersessions: the correction is a
 *    NEW record referencing the original; the original's back-pointer
 *    flips in the SAME transaction (no destructive history rewrite).
 *
 * Atomicity: every mutation runs through
 * `IdempotencyStore.applyIdempotent` — signal + idempotency record +
 * audit event (`risk_signal.recorded` / `risk_signal.superseded`)
 * commit in ONE authoritative transaction (NET-W004-AC-07 semantics;
 * AUD-005 administrative action logging).
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
  isAdvisoryProvenanceKind,
  isRiskSignalCategory,
  isRiskSignalProvenanceKind,
  isRiskSignalSeverity,
  validateRiskConfidence,
  type RiskSignalProvenanceKind,
} from "../core/risk.ts";
import type {
  CreateRiskSignalInput,
  CreateRiskSignalResult,
  RiskLookups,
  RiskSignal,
  RiskSignalRepository,
  RiskSignalService,
  SupersedeRiskSignalInput,
  SupersedeRiskSignalResult,
} from "./port.ts";
import { parseSubjectRef, resolveSources } from "./source-validation.ts";

const SIGNAL_RECORDED = "risk_signal.recorded" as const;
const SIGNAL_SUPERSEDED = "risk_signal.superseded" as const;

export interface RiskSignalServiceDeps {
  readonly repository: RiskSignalRepository;
  readonly lookups: RiskLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function parseProvenanceKind(kind: string): RiskSignalProvenanceKind {
  if (!isRiskSignalProvenanceKind(kind)) {
    throw new OpenConError({
      code: "RISK_SIGNAL_VALIDATION",
      classification: "validation",
      message: `risk signal provenance kind must be one of authoritative_record, rule_detection, model_output, manual_review (got ${String(kind)})`,
      context: { kind },
    });
  }
  return kind;
}

export function createRiskSignalService(
  deps: RiskSignalServiceDeps,
): RiskSignalService {
  const { repository, lookups, idempotency, auditWriter, logger } = deps;

  async function assertSubject(
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<void> {
    if (!(await lookups.subject.exists(subjectPersonId))) {
      throw new OpenConError({
        code: "RISK_SIGNAL_VALIDATION",
        classification: "validation",
        message: `risk signal subject person does not exist: ${subjectPersonId}`,
        context: { subjectPersonId },
      });
    }
    void organizationScopeId;
  }

  const service: RiskSignalService = {
    async createSignal(execution, input): Promise<CreateRiskSignalResult> {
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.subjectPersonId?.trim()) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "subjectPersonId is required",
          context: { field: "subjectPersonId" },
        });
      }
      await assertSubject(input.organizationScopeId, input.subjectPersonId);
      if (!isRiskSignalCategory(input.category)) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: `risk signal category must be one of the standard risk signal categories (got ${String(input.category)})`,
          context: { category: input.category },
        });
      }
      if (!isRiskSignalSeverity(input.severity)) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: `risk signal severity must be one of LOW, MEDIUM, HIGH, CRITICAL (got ${String(input.severity)})`,
          context: { severity: input.severity },
        });
      }
      const confidence = validateRiskConfidence(input.confidence);
      const provenanceKind = parseProvenanceKind(input.provenance?.kind);
      if (
        !input.provenance?.detectionMethod?.trim() ||
        !input.provenance?.detectionVersion?.trim()
      ) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "risk signal provenance requires detectionMethod and detectionVersion",
          context: { provenance: input.provenance },
        });
      }
      if (!input.detectedAt || Number.isNaN(Date.parse(input.detectedAt))) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "detectedAt must be an ISO-8601 timestamp",
          context: { detectedAt: input.detectedAt },
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      const subjectRef = parseSubjectRef(input.subjectRef);
      const sources = await resolveSources(
        lookups,
        input.organizationScopeId,
        input.provenance.sources,
      );
      // Captured narrowed consts (closure type-narrowing).
      const category = input.category;
      const severity = input.severity;

      const key = `risk_signal:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const signal: RiskSignal = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            subjectPersonId: input.subjectPersonId,
            subjectRef,
            category,
            severity,
            confidence,
            provenance: {
              kind: provenanceKind,
              detectionMethod: input.provenance.detectionMethod.trim(),
              detectionVersion: input.provenance.detectionVersion.trim(),
              sources,
            },
            // DERIVED (invariant 5): model_output is structurally
            // advisory — never caller-asserted.
            advisory: isAdvisoryProvenanceKind(provenanceKind),
            description: input.description?.trim() || null,
            detectedAt: input.detectedAt,
            recordedAt: new Date().toISOString(),
            supersedesSignalId: null,
            supersededBySignalId: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await repository.createWithinTx(signal, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: SIGNAL_RECORDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: signal.id,
            resourceType: "risk_signal",
            resourceId: signal.id,
            metadata: {
              organizationScopeId: signal.organizationScopeId,
              subjectPersonId: signal.subjectPersonId,
              category: signal.category,
              severity: signal.severity,
              advisory: signal.advisory,
              provenanceKind: signal.provenance.kind,
              detectionMethod: signal.provenance.detectionMethod,
              sourceRefs: sources.map((s) => `${s.kind}:${s.id}`),
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return signal;
        },
        execution,
      );
      logger.info("risk_signal.recorded", {
        signalId: applied.result.id,
        category: applied.result.category,
        advisory: applied.result.advisory,
        created: applied.executed,
      });
      return { signal: applied.result, created: applied.executed };
    },

    async supersedeSignal(
      execution,
      input: SupersedeRiskSignalInput,
    ): Promise<SupersedeRiskSignalResult> {
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      const original = await repository.findById(input.signalId);
      if (!original) {
        throw new NotFoundError(`risk signal not found: ${input.signalId}`, {
          signalId: input.signalId,
        });
      }
      if (original.supersededBySignalId !== null) {
        throw new ConflictError(
          `risk signal ${original.id} is already superseded by ${original.supersededBySignalId}`,
          { signalId: original.id, supersededBy: original.supersededBySignalId },
        );
      }
      if (!isRiskSignalCategory(input.category)) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: `risk signal category must be one of the standard risk signal categories (got ${String(input.category)})`,
          context: { category: input.category },
        });
      }
      if (!isRiskSignalSeverity(input.severity)) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: `risk signal severity must be one of LOW, MEDIUM, HIGH, CRITICAL (got ${String(input.severity)})`,
          context: { severity: input.severity },
        });
      }
      const confidence = validateRiskConfidence(input.confidence);
      const provenanceKind = parseProvenanceKind(input.provenance?.kind);
      if (
        !input.provenance?.detectionMethod?.trim() ||
        !input.provenance?.detectionVersion?.trim()
      ) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "risk signal provenance requires detectionMethod and detectionVersion",
          context: { provenance: input.provenance },
        });
      }
      if (!input.detectedAt || Number.isNaN(Date.parse(input.detectedAt))) {
        throw new OpenConError({
          code: "RISK_SIGNAL_VALIDATION",
          classification: "validation",
          message: "detectedAt must be an ISO-8601 timestamp",
          context: { detectedAt: input.detectedAt },
        });
      }
      const sources = await resolveSources(
        lookups,
        original.organizationScopeId,
        input.provenance.sources,
      );
      // Captured narrowed consts (closure type-narrowing).
      const category = input.category;
      const severity = input.severity;

      const key = `risk_signal_supersede:${original.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx re-read: the original must still be unsuperseded
          // (concurrent corrections resolve to exactly one).
          const current = await repository.findByIdWithinTx(original.id, tx);
          if (!current) {
            throw new NotFoundError(`risk signal not found: ${original.id}`, {
              signalId: original.id,
            });
          }
          if (current.supersededBySignalId !== null) {
            throw new ConflictError(
              `risk signal ${current.id} is already superseded by ${current.supersededBySignalId}`,
              { signalId: current.id, supersededBy: current.supersededBySignalId },
            );
          }
          const correction: RiskSignal = Object.freeze({
            id: randomUUID(),
            organizationScopeId: current.organizationScopeId,
            subjectPersonId: current.subjectPersonId,
            subjectRef: current.subjectRef,
            category,
            severity,
            confidence,
            provenance: {
              kind: provenanceKind,
              detectionMethod: input.provenance.detectionMethod.trim(),
              detectionVersion: input.provenance.detectionVersion.trim(),
              sources,
            },
            advisory: isAdvisoryProvenanceKind(provenanceKind),
            description: input.description?.trim() || null,
            detectedAt: input.detectedAt,
            recordedAt: new Date().toISOString(),
            // The correction references the record it replaces.
            supersedesSignalId: current.id,
            supersededBySignalId: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          // The original keeps its content; ONLY the back-pointer flips.
          const flipped: RiskSignal = Object.freeze({
            ...current,
            supersededBySignalId: correction.id,
          });
          await repository.putSupersessionWithinTx(flipped, correction, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: SIGNAL_SUPERSEDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: correction.id,
            resourceType: "risk_signal",
            resourceId: correction.id,
            metadata: {
              organizationScopeId: current.organizationScopeId,
              supersededSignalId: current.id,
              correctionSignalId: correction.id,
              category: correction.category,
              severity: correction.severity,
              advisory: correction.advisory,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return { original: flipped, correction };
        },
        execution,
      );
      logger.info("risk_signal.superseded", {
        originalId: applied.result.original.id,
        correctionId: applied.result.correction.id,
        created: applied.executed,
      });
      return { ...applied.result, created: applied.executed };
    },

    async getSignal(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`risk signal not found: ${id}`, { signalId: id });
      }
      return found;
    },

    async listSignals(_execution, organizationScopeId, subjectPersonId) {
      if (subjectPersonId) {
        return repository.listBySubject(organizationScopeId, subjectPersonId);
      }
      return repository.listByOrganization(organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError, ConflictError };
