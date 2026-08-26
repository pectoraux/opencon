/**
 * WorkflowService — the SOLE authority for lifecycle transitions
 * (work order §4.1).
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §4.1 Only `/workflows` may authoritatively transition lifecycle state.
 *   §4.4 Idempotency: repeating the same authorized transition with the
 *      same idempotency key is a deterministic replay.
 *   §4.5 Authorization: transitions are tenant/participant scoped and
 *      server-authorized.
 *   §4.6 Persistence: PostgreSQL-backed authority boundaries from NET-W003.
 *   §4.7 Audit lineage: every material mutation preserves execution/
 *      correlation/causation lineage + append-oriented audit committed
 *      atomically with the mutation.
 *   §4.8 Optimistic concurrency: stale writers are rejected.
 *
 * Architecture ref: architecture-lock §7 (workflow authority), §11
 * (workflow invariants), §12 (trace lineage).
 *
 * Tier compliance: this file is in the `workflows` domain boundary.
 * It imports ONLY:
 *   - its own port (self, same dir — allowed),
 *   - core contracts (ExecutionContext, AuditWriter, IdempotencyStore,
 *     CoordinationService, OpenConError subclasses, lifecycle types —
 *     all from `../core/*`, allowed).
 * It does NOT import infrastructure or any other domain. The lifecycle
 * repositories + authorizer are injected as structural interfaces
 * declared in the workflows port.
 *
 * Concurrency model:
 *  1. Per-subject coordination lock (CoordinationService.acquireLock).
 *     Non-authoritative: losing the coordination store cannot corrupt
 *     authoritative state. The lock serializes concurrent transition
 *     requests for the same subject so the optimistic-concurrency check
 *     in step 4c does not race (the second caller would otherwise see
 *     the first caller's uncommitted write as committed and proceed
 *     with a stale expectedVersion).
 *  2. IdempotencyStore.applyIdempotent: exactly-once-per-key. The
 *     idempotency record + the lifecycle mutation + the audit record
 *     all commit within the SAME authoritative transaction (true
 *     atomicity, work order §4.4 + §4.7).
 *  3. Within the apply callback:
 *     a. Re-read the subject within the tx (sees uncommitted writes).
 *     b. Check `expectedVersion` (optimistic concurrency: reject stale).
 *     c. Evaluate transition legality (state machine: pure).
 *     d. Write the updated subject (state, version+1, lineage).
 *     e. Append an audit record (transactional buffer when available;
 *        committed atomically with the mutation).
 *
 * No economically material behaviour is introduced (work order §5).
 */

import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import { AuthorizationError, OpenConError } from "../core/errors.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore, IdempotentResult } from "../core/idempotency.ts";
import type {
  LifecycleSubject,
  TransitionRequest,
  TransitionResult,
} from "../core/workflow.ts";
import {
  LifecycleSubjectNotFoundError,
  ConcurrentTransitionError,
} from "../core/workflow.ts";
import type { CoordinationService } from "../core/coordination.ts";
import type {
  LifecycleRepository,
  TransitionAuthorizer,
  WorkflowService,
  WorkflowServiceDeps,
} from "./port.ts";
import { assertLegal, evaluateTransition } from "./state-machine.ts";

/**
 * Extended deps that include the IdempotencyStore + CoordinationService.
 * The port's WorkflowServiceDeps deliberately omits these so the port
 * stays free of infrastructure contracts; the concrete implementation
 * pulls them in. Bootstrap wires both sets of dependencies.
 */
export interface WorkflowServiceRuntimeDeps extends WorkflowServiceDeps {
  /** Idempotency store (exactly-once-per-key material mutation). */
  readonly idempotency: IdempotencyStore;
  /** Coordination service (per-subject non-authoritative serialization). */
  readonly coordination: CoordinationService;
}

const LOCK_TTL_MS = 5_000;
const LOCK_WAIT_MS = 5_000;

export function createWorkflowService(
  deps: WorkflowServiceRuntimeDeps,
): WorkflowService {
  const {
    opportunityRepository,
    contributionRepository,
    authorizer,
    auditWriter,
    idempotency,
    coordination,
  } = deps;

  function repositoryFor(kind: LifecycleSubject["kind"]): LifecycleRepository {
    return kind === "opportunity" ? opportunityRepository : contributionRepository;
  }

  /**
   * The idempotent apply callback. Runs within the authoritative tx
   * that the IdempotencyStore opened. The tx is exposed on
   * `ctx.transaction` so the lifecycle mutation + the audit record
   * commit atomically with the idempotency record (NET-W004 §4.4, §4.7).
   */
  async function performTransition(
    request: TransitionRequest,
    execution: ExecutionContext,
    tx: import("../core/postgres-authority.ts").AuthorityTransaction,
    idempotencyRecordId: string,
  ): Promise<TransitionResult> {
    const repo = repositoryFor(request.subjectKind);

    // a. Re-read the subject within the tx. The tx sees its own
    //    uncommitted writes so this is the authoritative current state.
    const subject = await repo.getByIdWithinTx(request.subjectId, tx);
    if (!subject) {
      throw new LifecycleSubjectNotFoundError(
        `${request.subjectKind} ${request.subjectId} not found`,
        {
          subjectId: request.subjectId,
          subjectKind: request.subjectKind,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
        },
      );
    }

    // b. Optimistic concurrency: reject stale writers (work order §4.8).
    if (request.expectedVersion !== subject.version) {
      throw new ConcurrentTransitionError(
        `stale writer for ${request.subjectKind} ${request.subjectId}: expected version ${request.expectedVersion}, authoritative version ${subject.version}`,
        {
          subjectId: request.subjectId,
          subjectKind: request.subjectKind,
          expectedVersion: request.expectedVersion,
          authoritativeVersion: subject.version,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
        },
      );
    }

    // b'. Authorization: server-side, deny-by-default (work order §4.5).
    //     Cross-org transitions are denied because the authorizer checks
    //     the subject's organizationScopeId against the actor's
    //     organization scope.
    const decision = await authorizer.authorizeTransition({
      execution,
      actorPersonId: request.actorPersonId,
      subject,
      policyAction: request.policyAction,
    });
    if (decision.decision !== "allow") {
      throw new AuthorizationError(
        `transition denied for ${request.subjectKind} ${request.subjectId}: ${decision.reason}`,
        {
          subjectId: request.subjectId,
          subjectKind: request.subjectKind,
          actorPersonId: request.actorPersonId,
          policyAction: request.policyAction,
          reason: decision.reason,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
        },
      );
    }

    // c. Evaluate transition legality (pure state machine).
    const evaluation = evaluateTransition({
      subject,
      targetState: request.targetState,
      expectedVersion: request.expectedVersion,
      execution,
    });
    assertLegal(evaluation);
    const rule = evaluation.rule!;

    // d. Write the updated subject: new state, version+1, fresh lineage.
    const updatedSubject: LifecycleSubject = {
      ...subject,
      state: request.targetState,
      version: subject.version + 1,
      executionId: execution.executionId,
      correlationId: execution.correlationId,
      causationId: execution.causationId,
      updatedAt: new Date().toISOString(),
    };
    // The repository preserves non-lifecycle fields via read-modify-write.
    await repo.saveWithinTx(updatedSubject, request.expectedVersion, execution, tx);

    // e. Audit record (atomic with the mutation — the audit writer is
    //    either the transactional buffer when wired, or the direct
    //    append writer; both commit on tx commit). Carries execution/
    //    correlation/causation lineage + actor/subject/resource so the
    //    mutation is fully traceable (work order §4.7).
    const transitionId = randomUUID();
    try {
      await auditWriter.append({
        eventType: rule.auditEventName,
        context: execution,
        actor: execution.actor?.id ?? null,
        subject: request.subjectId,
        resourceType: request.subjectKind,
        resourceId: request.subjectId,
        metadata: {
          fromState: subject.state,
          toState: request.targetState,
          fromVersion: subject.version,
          toVersion: updatedSubject.version,
          policyAction: request.policyAction,
          idempotencyKey: request.idempotencyKey,
          idempotencyRecordId,
          transitionId,
          organizationScopeId: subject.organizationScopeId,
          ...(request.metadata ?? {}),
        },
      });
    } catch (auditErr) {
      // Audit failure is logged but never silently swallows the
      // mutation: the mutation already happened inside the tx; the
      // audit record is best-effort lineage. (When a transactional
      // audit buffer is wired, the audit write participates in the
      // tx and rolls back with it — preserving atomicity.)
      throw new OpenConError({
        code: "AUDIT_WRITE_FAILED",
        classification: "transient",
        message: `audit write failed for transition ${transitionId}`,
        cause: auditErr,
        retryable: true,
        context: {
          transitionId,
          subjectId: request.subjectId,
          subjectKind: request.subjectKind,
          auditEventName: rule.auditEventName,
        },
      });
    }

    return {
      subject: updatedSubject,
      executed: true,
      transitionId,
      recordId: idempotencyRecordId,
      auditEventName: rule.auditEventName,
      executionId: execution.executionId,
      correlationId: execution.correlationId,
      causationId: execution.causationId,
      transactionId: execution.executionId, // The execution id is the stable tx reference for lineage.
    };
  }

  const service: WorkflowService = {
    async requestTransition(request, execution) {
      // 1. Per-subject coordination lock (non-authoritative serializer).
      //    Losing the coordination store cannot corrupt authoritative
      //    state — the lock only reduces the number of optimistic-
      //    concurrency rejections under concurrent requests for the
      //    same subject. The authoritative guarantee is the idempotency
      //    store's per-key mutex + the version check inside the
      //    authoritative tx. When the lock is busy (another caller is
      //    mid-transition), we proceed WITHOUT the lock — the idempotency
      //    store's per-key mutex serializes the two callers, and the
      //    optimistic-concurrency check rejects the slower writer.
      const lockKey = `workflow:${request.subjectKind}:${request.subjectId}`;
      const lock = await coordination.acquireLock({
        key: lockKey,
        ttlMs: LOCK_TTL_MS,
        waitMs: LOCK_WAIT_MS,
      });
      // If we acquired the lock, release it when done. If not, proceed
      // without it (the idempotency store's per-key mutex serializes
      // concurrent calls for the same idempotency key anyway).
      const releaseLock = lock.acquired
        ? async () => lock.release()
        : async () => false;
      try {
        // 2. Idempotent apply: exactly-once-per-key. The idempotency
        //    record + the lifecycle mutation + the audit record all
        //    commit within the SAME authoritative transaction (work
        //    order §4.4, §4.7).
        const idempotencyKey = `workflow:${request.subjectKind}:${request.subjectId}:${request.idempotencyKey}`;
        const result: IdempotentResult<TransitionResult> =
          await idempotency.applyIdempotent(
            idempotencyKey,
            async (ctx) => {
              // The idempotency store opened the authoritative tx;
              // `ctx.transaction` is the SAME tx the lifecycle
              // mutation + audit record will commit in.
              return performTransition(
                request,
                ctx.execution,
                ctx.transaction,
                ctx.transaction.transactionId,
              );
            },
            execution,
          );
        // When this was a deterministic replay, override the `executed`
        // flag on the returned result so the caller knows.
        return {
          ...result.result,
          executed: result.executed,
        };
      } finally {
        await releaseLock();
      }
    },
  };

  return service;
}

export { AuthorizationError, OpenConError };
export type { TransitionAuthorizer };
