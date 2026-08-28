/**
 * Workflows boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §17 (canonical lifecycle),
 * §18 (Module ownership): `/workflows` is the SOLE authoritative
 * lifecycle authority. §19 (Authority rules).
 * Architecture ref: spec/architecture-lock.md §7 (workflow authority),
 * §11 (workflow invariants: deterministic/idempotent transitions;
 * stable error codes for illegal transitions).
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.3 Workflow authority: the canonical contribution lifecycle.
 *   §4.1 Only `/workflows` may authoritatively transition lifecycle
 *      state; domain/application services may validate preconditions
 *      but MUST NOT bypass workflow authority.
 *   §4.4 Idempotency semantics: repeating the same authorized
 *      transition with the same idempotency key is a deterministic
 *      replay.
 *   §4.5 Authorization: transitions are tenant/participant scoped and
 *      server-authorized.
 *   §4.7 Audit lineage: every material mutation preserves execution/
 *      correlation/causation lineage and append-oriented audit.
 *
 * CROSS-BOUNDARY LOOKUP PATTERN: the WorkflowService needs to mutate
 * Opportunity/Contribution subjects, but the tier allow matrix prohibits
 * domain→domain imports. This port declares a minimal
 * {@link LifecycleRepository} structural interface that the bootstrap
 * composition root satisfies by wiring thin adapters over the concrete
 * OpportunityRepository and ContributionRepository (TypeScript
 * structural typing makes them assignable).
 *
 * The {@link TransitionAuthorizer} structural interface mirrors the
 * AuthorizationService from `/participants`. The bootstrap wires a thin
 * adapter so the workflow service delegates to the existing deny-by-
 * default authorization primitives (NET-W002 §4.5).
 *
 * Tier compliance: contracts ONLY. Concrete transition table + state
 * machine + workflow service live in this boundary (self-imports
 * allowed). Domain modules consume only the type vocabulary from
 * `src/core/workflow.ts`.
 *
 * No economically material behaviour is introduced here (work order §5).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  LifecycleSubject,
  LifecycleSubjectKind,
  TransitionRequest,
  TransitionResult,
} from "../core/workflow.ts";

/**
 * A repository of lifecycle subjects for a single subject kind. The
 * workflow service uses two of these (one for opportunities, one for
 * contributions). The repository reads + writes a subject within an
 * authoritative transaction so the mutation commits atomically with
 * the idempotency record and the audit record (work order §4.4, §4.7).
 *
 * The repository is parameterized over the concrete subject type (T)
 * so each domain (opportunities, contributions) can carry its own
 * domain-specific fields alongside the lifecycle vocabulary. The
 * workflow service only manipulates the lifecycle fields; the
 * repository preserves all non-lifecycle fields via read-modify-write.
 *
 * The transaction is passed EXPLICITLY to each method (the workflow
 * service receives it from the idempotency apply context's `transaction`
 * field). This keeps the lifecycle repository stateless — no module-
 * level "active tx" variable, no AsyncLocalStorage coupling.
 */
export interface LifecycleRepository<T extends LifecycleSubject = LifecycleSubject> {
  /**
   * Read the current authoritative subject within a transaction.
   * Sees uncommitted writes in the same tx (so the workflow service
   * can read-modify-write atomically).
   */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<T | null>;
  /**
   * Persist the updated subject within a transaction. The repository
   * preserves all non-lifecycle fields by reading the current subject
   * first and merging the lifecycle mutation onto it. The version is
   * incremented atomically (optimistic concurrency: the write MUST
   * carry `expectedVersion`; the repository rejects with
   * {@link ConcurrentTransitionError} when the authoritative version
   * differs — work order §4.8).
   */
  saveWithinTx(
    subject: T,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<T>;
}

/**
 * TransitionAuthorizer — structural surface the WorkflowService consumes
 * for server-side authorization. Mirrored from the `/participants`
 * AuthorizationService. The bootstrap composition root wires a thin
 * adapter that delegates to the real AuthorizationService.
 *
 * The authorizer carries the server-resolved principal (NOT client-
 * asserted claims). Returns an allow/deny decision the workflow service
 * treats as authoritative (deny-by-default, NET-W002 §4.5).
 */
export interface TransitionAuthorizer {
  /**
   * Authorize a transition. Returns `{ decision: "allow" }` when the
   * actor is permitted to perform `policyAction` on the subject's
   * organization scope. Returns `{ decision: "deny", reason }` otherwise.
   *
   * The subject's `organizationScopeId` is the resource the authorizer
   * checks against; cross-organization transitions are denied (work
   * order §4.5).
   */
  authorizeTransition(input: {
    readonly execution: ExecutionContext;
    readonly actorPersonId: string;
    readonly subject: LifecycleSubject;
    readonly policyAction: string;
  }): Promise<{ readonly decision: "allow" | "deny"; readonly reason: string }>;
}

/**
 * WorkflowServiceDeps — the dependencies injected into the workflow
 * service. The repositories + authorizer + audit writer + coordination
 * service + idempotency store are all provider-neutral contracts (core
 * or domain tier). The bootstrap composition root wires the concrete
 * implementations.
 *
 * NET-W005 adds the Proof-of-Value lifecycle repository: the PoV
 * lifecycle (DRAFT → MEASURING → EVALUATING → VERIFIED + REJECTED/
 * CANCELLED, spec/work-orders/NET-W005.md §3.8) transitions through the
 * SAME workflow machinery (authorization, idempotency, optimistic
 * concurrency, audit lineage) as opportunities and contributions.
 * NET-W006 adds the measured-outcome lifecycle repository: the
 * measured-outcome maturation lifecycle (DRAFT → MEASURING → VERIFIED
 * + CANCELLED, spec/work-orders/NET-W006.md §3.5) transitions through
 * the SAME machinery — finalization is explicit, authorized,
 * idempotent and auditable, and delayed outcomes can never silently
 * become final.
 * NET-W017 adds the ENGAGEMENT lifecycle repository: the creator
 * engagement production lifecycle (DRAFT → READY → ASSIGNED →
 * IN_PROGRESS → SUBMITTED → VERIFIED + REJECTED/CANCELLED,
 * spec/work-orders/NET-W017.md §3.1) transitions through the SAME
 * machinery — acceptance/production execute through the canonical
 * workflow authority, never a second lifecycle engine.
 * NET-W018 adds the PUBLICATION lifecycle repository: the creator
 * publication lifecycle (DRAFT → VERIFIED + CANCELLED,
 * spec/work-orders/NET-W018.md §3.4) transitions through the SAME
 * machinery — the DRAFT → VERIFIED transition is the disclosure
 * gate composite (creators domain) composed through the in-tx twin.
 */
export interface WorkflowServiceDeps {
  /** Opportunity lifecycle repository (used for opportunity transitions). */
  readonly opportunityRepository: LifecycleRepository;
  /** Contribution lifecycle repository (used for contribution transitions). */
  readonly contributionRepository: LifecycleRepository;
  /** Proof-of-Value lifecycle repository (used for proof_of_value transitions). */
  readonly proofOfValueRepository: LifecycleRepository;
  /** Measured-outcome lifecycle repository (used for outcome_measurement transitions). */
  readonly outcomeMeasurementRepository: LifecycleRepository;
  /** Engagement lifecycle repository (used for engagement transitions). */
  readonly engagementRepository: LifecycleRepository;
  /** Publication lifecycle repository (used for publication transitions). */
  readonly publicationRepository: LifecycleRepository;
  /** Server-side authorization (deny-by-default). */
  readonly authorizer: TransitionAuthorizer;
  /**
   * Transactional audit writer. The workflow service obtains a
   * transaction-scoped buffer via `forTransaction(tx)` so the audit
   * record commits atomically with the lifecycle mutation + the
   * idempotency record (NET-W004 §4.7 + NET-W003 §4.8). The bootstrap
   * composition root wires the concrete TransactionalAuditWriter
   * implementation from src/audit/transactional-audit-writer.ts.
   */
  readonly auditWriter: TransactionalAuditWriter;
}

/**
 * WorkflowService — the SOLE authority for lifecycle transitions
 * (work order §4.1).
 *
 * `requestTransition` is the only public entry point. It:
 *  1. Resolves the subject from the appropriate lifecycle repository.
 *  2. Authorizes the transition through the {@link TransitionAuthorizer}
 *     (deny-by-default; cross-org denied).
 *  3. Acquires a per-subject coordination lock (non-authoritative
 *     serialization — losing the coordination store cannot corrupt
 *     authoritative state).
 *  4. Applies the transition idempotently through the IdempotencyStore
 *     (exactly-once-per-key; deterministic replay on duplicate).
 *  5. Within the SAME authoritative {@link AuthorityTransaction} as the
 *     idempotency record:
 *     a. re-reads the subject (sees uncommitted writes in this tx);
 *     b. checks `expectedVersion` (optimistic concurrency — rejects
 *        stale writers);
 *     c. evaluates the transition legality (state machine);
 *     d. writes the updated subject (new state, version+1, lineage);
 *     e. appends an audit record to the transactional audit buffer
 *        bound to the SAME tx. The record is BUFFERED (invisible);
 *        it is published by the tx's `afterCommit` hook STRICTLY AFTER
 *        the authoritative `tx.commit()` succeeds, and discarded by
 *        `afterRollback` when the tx settles without committing —
 *        lifecycle mutation + idempotency record + audit record commit
 *        together or none does, and the audit can never become visible
 *        for a mutation that never committed (NET-W004-AC-07
 *        transaction-ordering remediation).
 *  6. Returns a stable {@link TransitionResult} with execution/
 *     correlation/causation lineage + the authoritative `transactionId`.
 *
 * Domain services (OpportunityService, ContributionService) MAY
 * validate business preconditions but MUST NOT mutate lifecycle state
 * directly — they route through `requestTransition`.
 */
export interface WorkflowService {
  /**
   * Request an authorized lifecycle transition. Idempotent: repeating
   * with the same `idempotencyKey` is a deterministic replay.
   *
   * Throws:
   *  - {@link LifecycleSubjectNotFoundError} when the subject does not exist.
   *  - {@link AuthorizationError} when the actor is denied (deny-by-default).
   *  - {@link IllegalTransitionError} when the (from, to) pair is not in the table.
   *  - {@link TerminalStateError} when the subject is in a terminal state.
   *  - {@link ConcurrentTransitionError} when `expectedVersion` is stale.
   */
  requestTransition(
    request: TransitionRequest,
    execution: ExecutionContext,
  ): Promise<TransitionResult>;

  /**
   * The in-tx composition twin of {@link requestTransition} — the
   * NET-W017 remediation decision of record (architect CHANGES
   * REQUESTED on PR #34: cross-authority commands must be atomic).
   *
   * Executes the EXACT SAME transition machinery — re-read within the
   * transaction, `expectedVersion` optimistic-concurrency check,
   * deny-by-default authorization, pure state-machine evaluation,
   * `saveWithinTx` write, buffered transactional audit — but inside a
   * CALLER-OPENED authoritative {@link AuthorityTransaction} instead of
   * one the workflow service opens itself.
   *
   * Contract (the composing service MUST hold all of these):
   *  1. The caller opened the transaction through an
   *     `IdempotencyStore.applyIdempotent` apply context (`ctx.transaction`)
   *     so the coupled material mutation AND this transition AND the
   *     single idempotency record commit as ONE authoritative unit —
   *     a failure at ANY point (including this transition) rolls back
   *     EVERYTHING. No partial commit can survive (no orphaned rights
   *     grant / production / submission for a lifecycle state that
   *     never occurred).
   *  2. The caller owns per-subject serialization for the duration of
   *     the composite (advisory; the authoritative guarantees remain
   *     the in-tx version check + the idempotency store's per-key
   *     mutex — the same stance `requestTransition` takes when its
   *     coordination lock is busy).
   *  3. The caller passes its composite idempotency record id
   *     (`ctx.recordId`) so the transition's audit lineage references
   *     the composite record — the transition itself carries NO
   *     separate idempotency record; exactly-once is the composite's.
   *
   * This twin performs NO lock acquisition and NO idempotency
   * bookkeeping of its own — those belong to the composite caller.
   * `/workflows` REMAINS the sole lifecycle authority: the transition
   * still executes exclusively through the shared `performTransition`
   * path below (one state machine, no divergent copy).
   *
   * Throws the same errors as `requestTransition` (the rollback of the
   * caller's transaction is the caller's — via the idempotency store).
   */
  requestTransitionWithinTx(
    request: TransitionRequest,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
    idempotencyRecordId: string,
  ): Promise<TransitionResult>;
}

/**
 * The WorkflowsPort describes the boundary's readiness. After NET-W004
 * it is `"ready"` (the boundary now carries the authoritative workflow
 * service + transition table). NET-W017 adds the engagement audit
 * namespace; NET-W018 adds the publication audit namespace (additive).
 */
export interface WorkflowsPort {
  readonly boundary: "workflows";
  readonly readiness: "ready";
  readonly auditEventNamespaces: {
    readonly opportunity: "opportunity.transition";
    readonly contribution: "contribution.transition";
    readonly proofOfValue: "proof_of_value.transition";
    readonly outcomeMeasurement: "outcome_measurement.transition";
    readonly engagement: "engagement.transition";
    readonly publication: "publication.transition";
  };
}

export type { ExecutionContext, AuthorityTransaction, LifecycleSubject, LifecycleSubjectKind, TransitionRequest, TransitionResult, TransactionalAuditWriter };
