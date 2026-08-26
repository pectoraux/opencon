/**
 * LifecycleRepository adapter factory — wraps a domain repository
 * (Opportunity, Contribution) so the WorkflowService can mutate
 * lifecycle state uniformly without coupling to domain-specific fields.
 *
 * Work order ref: NET-W004 §4.6 (PostgreSQL-backed authority), §4.8
 * (versioned + optimistic concurrency), §4.7 (audit lineage atomicity).
 *
 * The workflow service operates on the {@link LifecycleSubject} core
 * vocabulary (state, version, lineage) — it does NOT know about domain
 * fields (opportunityType, brief, submission, etc.). The repository
 * adapter does read-modify-write: it reads the current domain entity
 * within the authoritative tx, merges the workflow service's lifecycle
 * mutation onto it (preserving all domain-specific fields), and writes
 * the merged result back to the tx.
 *
 * The adapter is parameterized over the concrete domain type T so each
 * domain (opportunities, contributions) can carry its own fields.
 * TypeScript structural typing makes the adapter assignable to
 * `LifecycleRepository` (the default T is `LifecycleSubject`).
 */

import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { LifecycleSubject } from "../core/workflow.ts";
import type { LifecycleRepository } from "./port.ts";

/**
 * The minimal surface the adapter needs from a domain repository. The
 * domain repository declares `getByIdWithinTx(id, tx): Promise<T | null>`
 * and `saveWithinTx(subject, expectedVersion, execution, tx): Promise<T>`.
 * These methods already take the tx explicitly; the adapter delegates
 * to them with read-modify-write.
 */
export interface DomainLifecycleRepositoryLike<T extends LifecycleSubject> {
  getByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<T | null>;
  saveWithinTx(
    subject: T,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<T>;
}

/**
 * Wrap a domain repository so the WorkflowService (which operates on
 * plain {@link LifecycleSubject}) can mutate lifecycle state uniformly.
 *
 * The adapter:
 *  - `getByIdWithinTx(id, tx)` — delegates directly to the domain
 *    repository (returns the domain entity, which is assignable to
 *    LifecycleSubject).
 *  - `saveWithinTx(subject, expectedVersion, execution, tx)` — reads
 *    the current domain entity within the tx, merges the workflow
 *    service's lifecycle mutation onto it (preserving domain-specific
 *    fields), then writes the merged result.
 *
 * The merge preserves all fields that are NOT lifecycle fields. The
 * lifecycle fields are: state, version, executionId, correlationId,
 * causationId, updatedAt. The id, kind, organizationScopeId, ownerId,
 * createdAt fields are also lifecycle vocabulary but they are NOT
 * mutated by the workflow service (they are immutable after creation).
 * The merge therefore overwrites ONLY the lifecycle fields the workflow
 * service is allowed to mutate.
 */
export function createLifecycleRepository<T extends LifecycleSubject>(
  repository: DomainLifecycleRepositoryLike<T>,
): LifecycleRepository {
  return {
    async getByIdWithinTx(id: string, tx: AuthorityTransaction): Promise<LifecycleSubject | null> {
      const entity = await repository.getByIdWithinTx(id, tx);
      return entity;
    },
    async saveWithinTx(
      subject: LifecycleSubject,
      expectedVersion: number,
      execution: ExecutionContext,
      tx: AuthorityTransaction,
    ): Promise<LifecycleSubject> {
      // Read the current domain entity within the tx (so we have the
      // latest domain-specific fields to preserve).
      const current = await repository.getByIdWithinTx(subject.id, tx);
      if (!current) {
        throw new Error(`${subject.kind} ${subject.id} not found within tx`);
      }
      // Merge the workflow service's lifecycle mutation onto the
      // current entity. The spread preserves all domain-specific
      // fields from `current`, then the explicit lifecycle field
      // assignments from `subject` overwrite them.
      const merged: T = {
        ...current,
        state: subject.state,
        version: subject.version,
        executionId: subject.executionId,
        correlationId: subject.correlationId,
        causationId: subject.causationId,
        updatedAt: subject.updatedAt,
      } as T;
      return await repository.saveWithinTx(merged, expectedVersion, execution, tx);
    },
  };
}
