/**
 * ModerationService — the NET-W013 moderation authority implementation.
 *
 * Work order ref: spec/work-orders/NET-W013.md §3.2.
 *
 * THE BINDING INVARIANTS (work order §4), enforced STRUCTURALLY:
 *
 *  1. MODERATION HISTORY IS APPEND-ONLY. Decisions are immutable
 *     records; this service exposes NO update/delete path for them.
 *     The current moderation status is DERIVED from the latest
 *     decision — never stored, never rewritten.
 *
 *  2. DECISIONS ARE MODERATOR-CONTROLLED. Only an authenticated
 *     PERSON actor may record a decision (service/system actors
 *     cannot moderate).
 *
 *  3. NO SECOND FRAUD AUTHORITY. This service records decisions and
 *     NOTHING else: it never creates risk signals, never activates
 *     controls, never mutates lifecycle/economic/reputation state.
 *     The spam/abuse risk-signal EMISSION into /disputes happens at
 *     the composition root ONLY (the recordModerationDecision
 *     apiCommand composite).
 *
 *  4. Every mutation runs through the NET-W004 IdempotencyStore with
 *     per-contribution mutexes, in-tx re-checks, replay tolerance and
 *     transactional audit lineage.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { Logger } from "../core/logger.ts";
import {
  isModerationDecision,
  isModerationReasonKind,
  moderationStatusForDecision,
} from "../core/moderation.ts";
import type { ModerationReasonKind } from "../core/moderation.ts";
import type {
  ContributionRepository,
  ModerationDecisionRecord,
  ModerationDecisionRepository,
  ModerationService,
  ModerationSummary,
  QualityEvaluationRepository,
  RecordModerationDecisionInput,
} from "./port.ts";

const MODERATION_DECISION_RECORDED = "moderation_decision.recorded" as const;

function moderationError(
  code: string,
  classification: "validation" | "authorization",
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({ code, classification, message, context });
}

function validationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return moderationError(
    "MODERATION_VALIDATION",
    "validation",
    message,
    context,
  );
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw validationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/** The acting person's id (moderation is moderator-controlled). */
function actingPersonId(execution: ExecutionContext, what: string): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw moderationError(
      "MODERATION_FORBIDDEN",
      "authorization",
      `an authenticated person actor is required to ${what} (service/system actors cannot moderate)`,
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** The per-contribution moderation mutex key. */
function contributionModerationLockKey(contributionId: string): string {
  return `contribution_moderation:${contributionId}`;
}

export interface CreateModerationServiceOptions {
  readonly contributionRepository: ContributionRepository;
  readonly decisionRepository: ModerationDecisionRepository;
  readonly evaluationRepository: QualityEvaluationRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger?: Logger;
}

export function createModerationService(
  opts: CreateModerationServiceOptions,
): ModerationService {
  const contributionRepository = opts.contributionRepository;
  const decisionRepository = opts.decisionRepository;
  const evaluationRepository = opts.evaluationRepository;
  const idempotency = opts.idempotency;
  const auditWriter = opts.auditWriter;
  const logger = opts.logger;

  async function loadContribution(contributionId: string) {
    const contribution = await contributionRepository.findById(contributionId);
    if (!contribution) {
      throw new NotFoundError(`contribution not found: ${contributionId}`, {
        contributionId,
      });
    }
    return contribution;
  }

  const service: ModerationService = {
    async recordModerationDecision(
      execution,
      input: RecordModerationDecisionInput,
    ): Promise<ModerationDecisionRecord> {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!isModerationDecision(input.decision ?? "")) {
        throw validationError(
          `decision must be one of APPROVE, REJECT, FLAG_FOR_REVIEW — got ${String(input.decision)}`,
          { field: "decision", decision: input.decision },
        );
      }
      if (
        !Array.isArray(input.reasonKinds) ||
        input.reasonKinds.length === 0 ||
        input.reasonKinds.some((r) => !isModerationReasonKind(r))
      ) {
        throw validationError(
          "reasonKinds must be a non-empty array of moderation reason kinds (spam, abuse, policy_violation, off_topic, low_evidence_quality, no_violation, other)",
          { field: "reasonKinds", reasonKinds: input.reasonKinds },
        );
      }
      const actor = actingPersonId(execution, "record moderation decisions");
      const reasonKinds: readonly ModerationReasonKind[] = [
        ...new Set(input.reasonKinds),
      ];

      // PRE-FLIGHT (fail fast): the contribution must exist in the
      // same org, and every cited quality evaluation must belong to
      // the SAME contribution in the SAME org.
      const contribution = await loadContribution(input.contributionId);
      if (contribution.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `contribution ${input.contributionId} belongs to organization scope ${contribution.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            contributionId: input.contributionId,
            contributionScope: contribution.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }
      const citedIds = [...new Set(input.qualityEvaluationIds ?? [])];
      for (const evaluationId of citedIds) {
        const evaluation = await evaluationRepository.findById(evaluationId);
        if (!evaluation) {
          throw new NotFoundError(
            `quality evaluation not found: ${evaluationId}`,
            { evaluationId },
          );
        }
        if (
          evaluation.organizationScopeId !== input.organizationScopeId ||
          evaluation.contributionId !== input.contributionId
        ) {
          throw validationError(
            `quality evaluation ${evaluationId} does not belong to contribution ${input.contributionId} in organization scope ${input.organizationScopeId}`,
            {
              evaluationId,
              evaluationScope: evaluation.organizationScopeId,
              evaluationContributionId: evaluation.contributionId,
            },
          );
        }
      }

      const key = `moderation_decision:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        contributionModerationLockKey(input.contributionId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            // AUTHORITATIVE in-tx re-check — the contribution must
            // still exist in the same org at the commit boundary.
            const inTx = await contributionRepository.getByIdWithinTx(
              input.contributionId,
              tx,
            );
            if (!inTx) {
              throw new NotFoundError(
                `contribution not found at the moderation transaction boundary: ${input.contributionId}`,
                { contributionId: input.contributionId },
              );
            }
            if (inTx.organizationScopeId !== input.organizationScopeId) {
              throw validationError(
                `contribution ${input.contributionId} belongs to organization scope ${inTx.organizationScopeId}, not ${input.organizationScopeId} (rejected at the moderation transaction boundary)`,
                {
                  contributionId: input.contributionId,
                  contributionScope: inTx.organizationScopeId,
                  requestedScope: input.organizationScopeId,
                },
              );
            }
            const now = new Date().toISOString();
            const record: ModerationDecisionRecord = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              contributionId: input.contributionId,
              decision: input.decision,
              reasonKinds: Object.freeze([...reasonKinds]),
              notes: input.notes ?? null,
              qualityEvaluationIds: Object.freeze([...citedIds]),
              decidedBy: actor,
              decidedAt: now,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await decisionRepository.createWithinTx(record, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: MODERATION_DECISION_RECORDED,
              context: execution,
              actor,
              subject: record.id,
              resourceType: "moderation_decision",
              resourceId: record.id,
              metadata: {
                contributionId: record.contributionId,
                decision: record.decision,
                reasonKinds: [...record.reasonKinds],
                citedQualityEvaluationCount: record.qualityEvaluationIds.length,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return record;
          }, execution),
      );
      logger?.info("moderation_decision.recorded", {
        moderationDecisionId: applied.result.id,
        contributionId: applied.result.contributionId,
        decision: applied.result.decision,
      });
      return applied.result;
    },

    async listModerationDecisions(_execution, contributionId) {
      return decisionRepository.listByContribution(contributionId);
    },

    async getModerationSummary(
      _execution,
      contributionId,
    ): Promise<ModerationSummary> {
      const decisions = await decisionRepository.listByContribution(
        contributionId,
      );
      const latest =
        decisions.length > 0 ? decisions[decisions.length - 1]! : null;
      return {
        contributionId,
        organizationScopeId: latest
          ? latest.organizationScopeId
          : (await loadContribution(contributionId)).organizationScopeId,
        status: latest ? moderationStatusForDecision(latest.decision) : "UNMODERATED",
        latestDecision: latest,
        decisionCount: decisions.length,
      };
    },
  };

  return service;
}

export { MODERATION_DECISION_RECORDED };
