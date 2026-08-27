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
 *   - core contracts (ExecutionContext, TransactionalAuditWriter,
 *     IdempotencyStore, CoordinationService, OpenConError subclasses,
 *     lifecycle types — all from `../core/*`, allowed).
 * It does NOT import infrastructure or any other domain. The lifecycle
 * repositories + authorizer are injected as structural interfaces
 * declared in the workflows port.
 *
 * Concurrency model:
 *  1. Per-subject coordination lock (CoordinationService.acquireLock).
 *     Non-authoritative: losing the coordination store cannot corrupt
 *     authoritative state. The lock serializes concurrent transition
 *     requests for the same subject so the optimistic-concurrency check
 *     in step 4c does not race.
 *  2. IdempotencyStore.applyIdempotent: exactly-once-per-key. The
 *     idempotency record + the lifecycle mutation commit within the
 *     SAME authoritative transaction (work order §4.4).
 *  3. Within the apply callback:
 *     a. Re-read the subject within the tx (sees uncommitted writes).
 *     b. Check `expectedVersion` (optimistic concurrency: reject stale).
 *     c. Evaluate transition legality (state machine: pure).
 *     d. Write the updated subject (state, version+1, lineage).
 *     e. Append the audit record to the transactional audit buffer
 *        bound to the SAME AuthorityTransaction. The append is BUFFERED
 *        — invisible — and is published ONLY by the transaction's
 *        afterCommit hook, strictly after the durable commit succeeds
 *        (NET-W004-AC-07 remediation: the audit buffer must NEVER
 *        publish from inside performTransition; publication happens
 *        after `tx.commit()`, discard on rollback/failed commit).
 *
 * NET-W004-AC-07 atomicity + ordering invariants (architect decision
 * on PR #8, remediation v2):
 *
 * ```text
 * tx.commit() succeeds → afterCommit → audit published (visible)
 * tx.commit() fails    → afterRollback → audit discarded (invisible)
 * tx.rollback()        → afterRollback → audit discarded (invisible)
 * publication failure  → retry → retain pending → explicit
 *                        retryPendingPublications() recovery (the
 *                        durable commit is never undone; retained
 *                        events belong to a COMMITTED tx, so recovery
 *                        can never create "audit exists, mutation
 *                        doesn't")
 * ```
 *
 * Audit lineage: the published audit record carries
 * `metadata.transactionId = tx.transactionId` — the AUTHORITATIVE
 * transaction id from the AuthorityTransaction, NOT the execution id.
 * The returned TransitionResult.transactionId is the same value so
 * callers can correlate the mutation, its audit record, and its durable
 * transaction.
 *
 * No economically material behaviour is introduced (work order §5).
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import { AuthorizationError } from "../core/errors.ts";
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
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
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
    proofOfValueRepository,
    outcomeMeasurementRepository,
    engagementRepository,
    authorizer,
    auditWriter,
    idempotency,
    coordination,
  } = deps;

  function repositoryFor(kind: LifecycleSubject["kind"]): LifecycleRepository {
    if (kind === "opportunity") return opportunityRepository;
    if (kind === "contribution") return contributionRepository;
    if (kind === "proof_of_value") return proofOfValueRepository;
    if (kind === "outcome_measurement") return outcomeMeasurementRepository;
    return engagementRepository;
  }

  /**
   * The idempotent apply callback. Runs within the authoritative tx
   * that the IdempotencyStore opened. The tx is exposed on
   * `ctx.transaction` so the lifecycle mutation + the idempotency
   * record commit atomically (NET-W004 §4.4, §4.7).
   *
   * The audit record is written through the TRANSACTIONAL audit buffer
   * bound to the SAME AuthorityTransaction (`auditWriter.forTransaction(tx)`).
   * NET-W004-AC-07 remediation (transaction-ordering): the buffer is
   * bound to the transaction's LIFECYCLE — its publication is
   * registered on `tx.afterCommit` and its discard on
   * `tx.afterRollback`. performTransition ONLY APPENDS to the buffer;
   * it never publishes. Consequences (all proven by
   * tests/workflows/net-w004-ac-07-audit-lineage.test.ts):
   *  - the audit record stays INVISIBLE (buffered) while the tx is open;
   *  - the authoritative `tx.commit()` (executed by the idempotency
   *    store AFTER this callback returns and the completed idempotency
   *    record is written) publishes the buffer strictly AFTER the
   *    durable commit succeeds;
   *  - a failed `tx.commit()` or an explicit rollback discards the
   *    buffer — no audit record can survive for a mutation that never
   *    committed (no "audit exists, mutation doesn't");
   *  - an audit publication failure after a successful commit is
   *    recovered explicitly (retry + retained pending publications via
   *    the transactional audit writer) and never undoes the durable
   *    commit.
   */
  async function performTransition(
    request: TransitionRequest,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
    idempotencyRecordId: string,
  ): Promise<TransitionResult> {
    const repo = repositoryFor(request.subjectKind);
    // The transactional audit buffer bound to the SAME authoritative
    // transaction as the lifecycle mutation + the idempotency record.
    // Binding registers the buffer's publication on tx.afterCommit and
    // its discard on tx.afterRollback — the buffer itself exposes NO
    // publish/flush method, so publication can structurally never
    // happen before the authoritative commit (the remediated failure
    // mode: audit flushed while the tx is still open, then the
    // authoritative commit fails and a phantom audit record remains).
    const auditBuffer = auditWriter.forTransaction(tx);

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

    // e. Audit record — BUFFERED in the transactional audit buffer
    //    bound to the SAME AuthorityTransaction as the lifecycle
    //    mutation + the idempotency record. Carries execution/
    //    correlation/causation lineage + actor/subject/resource so the
    //    mutation is fully traceable (work order §4.7). The buffer
    //    stamps the AUTHORITATIVE transaction id (tx.transactionId)
    //    into the record's metadata for durable-tx lineage.
    //
    //    REMEDIATION v2 (transaction-ordering): do NOT publish here.
    //    The buffer publishes via tx.afterCommit — strictly AFTER the
    //    idempotency store's `tx.commit()` makes the lifecycle mutation
    //    + the idempotency record + this audit record durable together.
    //    If the commit fails, tx.afterRollback discards this buffer, so
    //    no audit record survives for a mutation that never committed.
    //
    //    A failure in THIS function (illegal transition, denied
    //    authorization, stale writer, repository write failure, audit
    //    buffer append failure) makes the idempotency store roll the
    //    tx back — the buffer is discarded with everything else.
    const transitionId = randomUUID();
    await auditBuffer.append({
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

    return {
      subject: updatedSubject,
      executed: true,
      transitionId,
      recordId: idempotencyRecordId,
      auditEventName: rule.auditEventName,
      executionId: execution.executionId,
      correlationId: execution.correlationId,
      causationId: execution.causationId,
      // Correct transactionId lineage: the AUTHORITATIVE transaction
      // id of the AuthorityTransaction that committed the mutation +
      // the idempotency record + the audit record (NOT the execution
      // id — the execution id identifies the request, not the tx).
      transactionId: tx.transactionId,
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
        //    record + the lifecycle mutation commit within the SAME
        //    authoritative transaction (work order §4.4, §4.7); the
        //    buffered audit record is published by that transaction's
        //    afterCommit hook, strictly after the durable commit
        //    succeeds (NET-W004-AC-07 remediation: transaction
        //    lifecycle ordering).
        const idempotencyKey = `workflow:${request.subjectKind}:${request.subjectId}:${request.idempotencyKey}`;
        const result: IdempotentResult<TransitionResult> =
          await idempotency.applyIdempotent(
            idempotencyKey,
            async (ctx) => {
              // The idempotency store opened the authoritative tx;
              // `ctx.transaction` is the SAME tx the lifecycle
              // mutation + audit record will commit in. `ctx.recordId`
              // is the idempotency record's stable id for audit lineage.
              return performTransition(
                request,
                ctx.execution,
                ctx.transaction,
                ctx.recordId,
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

export { AuthorizationError };
export type { TransitionAuthorizer };
