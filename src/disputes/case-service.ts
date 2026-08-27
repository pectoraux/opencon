/**
 * RiskCaseService — domain service for the evidence-backed review
 * cases with append-only decision history (NET-W009 §3.6).
 *
 * Architecture ref: spec/architecture.md §12 (challenge mechanisms are
 * part of the fraud posture — the full challenge lifecycle is
 * NET-W010; this service provides the review-case foundation),
 * §18/§19; spec/architecture-lock.md §3 (PostgreSQL authoritative),
 * §12 (execution lineage).
 *
 * THE DETERMINISTIC STATE MACHINE (validated here; state is DERIVED
 * from the append-only decision history — decisions are never
 * rewritten, only appended):
 *
 * ```text
 * OPEN ──start_review──→ UNDER_REVIEW ──resolve_clear/resolve_uphold──→ RESOLVED
 *  └────────────────── resolve_clear / resolve_uphold (direct) ───────────↑
 *  └── escalate: legal from OPEN and UNDER_REVIEW (stays in state, records escalation)
 * ```
 *
 *  - reviewer identity comes from the EXECUTION ACTOR (server-side;
 *    never caller-asserted — AUD-005 administrative action logging);
 *  - material decisions (escalate / resolve_clear / resolve_uphold)
 *    require ≥1 supporting reference resolved through the neutral
 *    lookups (invariant 3);
 *  - `resolve_clear` sets resolution=CLEARED, `resolve_uphold` sets
 *    resolution=UPHELD (explicit resolution semantics; downstream
 *    control resolution is a separate explicit command);
 *  - illegal transitions fail deterministically with a stable
 *    RISK_CASE_VALIDATION error (e.g. a decision on a RESOLVED case).
 *
 * Atomicity: case + decision + idempotency record + audit event
 * (`risk_case.opened` / `risk_case.decision_recorded`) commit in ONE
 * authoritative transaction (IdempotencyStore.applyIdempotent;
 * NET-W004-AC-07; AUD-005).
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
import type {
  OpenRiskCaseInput,
  RecordRiskCaseDecisionInput,
  RiskCase,
  RiskCaseDecision,
  RiskCaseDecisionKind,
  RiskCaseRepository,
  RiskCaseResolution,
  RiskCaseService,
  RiskCaseState,
  RiskLookups,
  RiskSignalSourceRef,
} from "./port.ts";
import { parseSubjectRef, resolveSources } from "./source-validation.ts";

const CASE_OPENED = "risk_case.opened" as const;
const CASE_DECISION_RECORDED = "risk_case.decision_recorded" as const;

export interface RiskCaseServiceDeps {
  readonly repository: RiskCaseRepository;
  readonly lookups: RiskLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

const VALID_DECISIONS = new Set<string>([
  "start_review",
  "escalate",
  "resolve_clear",
  "resolve_uphold",
]);

/** Decisions that require ≥1 supporting reference (invariant 3). */
const MATERIAL_DECISIONS = new Set<string>([
  "escalate",
  "resolve_clear",
  "resolve_uphold",
]);

/**
 * The deterministic transition check. Returns the derived next state
 * or throws a stable validation error.
 */
function nextCaseState(
  current: RiskCaseState,
  decision: RiskCaseDecisionKind,
): { state: RiskCaseState; resolution: RiskCaseResolution | null } {
  if (current === "RESOLVED") {
    throw new OpenConError({
      code: "RISK_CASE_VALIDATION",
      classification: "validation",
      message: `risk case is RESOLVED; no further decisions are legal (got ${decision})`,
      context: { caseState: current, decision },
    });
  }
  switch (decision) {
    case "start_review":
      if (current !== "OPEN") {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: `start_review is legal only from OPEN (got ${current})`,
          context: { caseState: current, decision },
        });
      }
      return { state: "UNDER_REVIEW", resolution: null };
    case "escalate":
      // Escalation records severity; the case stays in its state
      // (deterministic: no state change).
      return { state: current, resolution: null };
    case "resolve_clear":
      return { state: "RESOLVED", resolution: "CLEARED" };
    case "resolve_uphold":
      return { state: "RESOLVED", resolution: "UPHELD" };
    default:
      throw new OpenConError({
        code: "RISK_CASE_VALIDATION",
        classification: "validation",
        message: `unknown risk case decision: ${String(decision)}`,
        context: { decision },
      });
  }
}

export function createRiskCaseService(
  deps: RiskCaseServiceDeps,
): RiskCaseService {
  const { repository, lookups, idempotency, auditWriter, logger } = deps;

  const service: RiskCaseService = {
    async openCase(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.title?.trim()) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: "title is required",
          context: { field: "title" },
        });
      }
      if (
        !Array.isArray(input.reasonCodes) ||
        input.reasonCodes.length === 0 ||
        input.reasonCodes.some((c) => typeof c !== "string" || !c.trim())
      ) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: "reasonCodes is required (at least one non-empty code)",
          context: { reasonCodes: input.reasonCodes },
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      if (input.subjectPersonId !== undefined && input.subjectPersonId !== null) {
        if (!input.subjectPersonId.trim()) {
          throw new OpenConError({
            code: "RISK_CASE_VALIDATION",
            classification: "validation",
            message: "subjectPersonId must be non-empty when provided",
            context: { field: "subjectPersonId" },
          });
        }
        if (!(await lookups.subject.exists(input.subjectPersonId))) {
          throw new OpenConError({
            code: "RISK_CASE_VALIDATION",
            classification: "validation",
            message: `risk case subject person does not exist: ${input.subjectPersonId}`,
            context: { subjectPersonId: input.subjectPersonId },
          });
        }
      }
      const subjectRef = parseSubjectRef(input.subjectRef);
      // ≥1 supporting reference to OPEN a case (invariant 3).
      const sources = await resolveSources(
        lookups,
        input.organizationScopeId,
        input.sourceRefs,
      );

      const reviewer = execution.actor?.id ?? "unknown";
      const key = `risk_case_open:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const now = new Date().toISOString();
          const decision: RiskCaseDecision = Object.freeze({
            id: randomUUID(),
            decision: "open",
            reviewerPersonId: reviewer,
            reasonCodes: input.reasonCodes.map((c) => c.trim()),
            note: input.description?.trim() || null,
            sourceRefs: sources,
            recordedAt: now,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
          });
          const riskCase: RiskCase = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            subjectPersonId: input.subjectPersonId ?? null,
            subjectRef,
            title: input.title.trim(),
            description: input.description?.trim() || null,
            state: "OPEN",
            reasonCodes: decision.reasonCodes,
            decisions: Object.freeze([decision]),
            openedBy: reviewer,
            openedAt: now,
            resolvedAt: null,
            resolution: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await repository.createWithinTx(riskCase, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CASE_OPENED,
            context: execution,
            actor: reviewer,
            subject: riskCase.id,
            resourceType: "risk_case",
            resourceId: riskCase.id,
            metadata: {
              organizationScopeId: riskCase.organizationScopeId,
              subjectPersonId: riskCase.subjectPersonId,
              title: riskCase.title,
              reasonCodes: riskCase.reasonCodes,
              sourceRefs: sources.map((s: RiskSignalSourceRef) => `${s.kind}:${s.id}`),
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return riskCase;
        },
        execution,
      );
      logger.info("risk_case.opened", {
        caseId: applied.result.id,
        created: applied.executed,
      });
      return { riskCase: applied.result, created: applied.executed };
    },

    async recordDecision(execution, input: RecordRiskCaseDecisionInput) {
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      if (!VALID_DECISIONS.has(input.decision)) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: `decision must be one of start_review, escalate, resolve_clear, resolve_uphold (got ${String(input.decision)})`,
          context: { decision: input.decision },
        });
      }
      if (
        !Array.isArray(input.reasonCodes) ||
        input.reasonCodes.length === 0 ||
        input.reasonCodes.some((c) => typeof c !== "string" || !c.trim())
      ) {
        throw new OpenConError({
          code: "RISK_CASE_VALIDATION",
          classification: "validation",
          message: "reasonCodes is required (at least one non-empty code)",
          context: { reasonCodes: input.reasonCodes },
        });
      }
      const decision = input.decision as RiskCaseDecisionKind;
      const found = await repository.findById(input.caseId);
      if (!found) {
        throw new NotFoundError(`risk case not found: ${input.caseId}`, {
          caseId: input.caseId,
        });
      }
      // Validate the transition BEFORE resolving sources so illegal
      // transitions fail fast and deterministically.
      const next = nextCaseState(found.state, decision);
      // Material decisions require ≥1 supporting reference (invariant 3).
      const sources = await resolveSources(
        lookups,
        found.organizationScopeId,
        input.sourceRefs,
        { emptyAllowed: !MATERIAL_DECISIONS.has(decision) },
      );
      const reviewer = execution.actor?.id ?? "unknown";

      const key = `risk_case_decision:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx re-read: concurrent decisions on the same case
          // serialize to exactly one committed history.
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`risk case not found: ${found.id}`, {
              caseId: found.id,
            });
          }
          const currentNext = nextCaseState(current.state, decision);
          const now = new Date().toISOString();
          const newDecision: RiskCaseDecision = Object.freeze({
            id: randomUUID(),
            decision,
            reviewerPersonId: reviewer,
            reasonCodes: input.reasonCodes.map((c) => c.trim()),
            note: input.note?.trim() || null,
            sourceRefs: sources,
            recordedAt: now,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
          });
          const updated: RiskCase = Object.freeze({
            ...current,
            state: currentNext.state,
            decisions: Object.freeze([...current.decisions, newDecision]),
            resolvedAt: currentNext.state === "RESOLVED" ? now : current.resolvedAt,
            resolution: currentNext.resolution ?? current.resolution,
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: CASE_DECISION_RECORDED,
            context: execution,
            actor: reviewer,
            subject: updated.id,
            resourceType: "risk_case",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              caseId: updated.id,
              decision,
              derivedState: updated.state,
              resolution: updated.resolution,
              reviewerPersonId: reviewer,
              reasonCodes: newDecision.reasonCodes,
              sourceRefs: sources.map((s: RiskSignalSourceRef) => `${s.kind}:${s.id}`),
              decisionRecordId: newDecision.id,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
        },
        execution,
      );
      logger.info("risk_case.decision_recorded", {
        caseId: applied.result.id,
        decision,
        state: applied.result.state,
      });
      return applied.result;
    },

    async getCase(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`risk case not found: ${id}`, { caseId: id });
      }
      return found;
    },

    async listCases(_execution, organizationScopeId, states) {
      return repository.listByOrganization(organizationScopeId, states);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type { ExecutionContext };
