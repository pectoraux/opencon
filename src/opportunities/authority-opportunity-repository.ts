/**
 * Authority-backed OpportunityRepository — persists opportunities through
 * the PostgreSQL authority boundary established by NET-W003.
 *
 * Work order ref: NET-W004 §4.6 (Material lifecycle mutations persist
 * through PostgreSQL-backed authority boundaries established by NET-W003).
 *
 * Tier compliance: this file is in the `opportunities` domain boundary.
 * It imports ONLY:
 *   - its own port (self, same dir — allowed),
 *   - core contracts (PostgresAuthority, AuthorityTransaction,
 *     ExecutionContext — all from `../core/*`, allowed).
 * It does NOT import infrastructure or any other domain. The
 * PostgresAuthority contract is provider-neutral; the concrete driver
 * (real PostgreSQL or the file-backed shim) is injected by the bootstrap
 * composition root.
 *
 * Storage model: opportunities live in the `opportunities` collection
 * of the authoritative store. The opportunity entity (including all
 * lifecycle + domain fields) is stored as the record's `value`. The
 * record's `executionId`/`correlationId`/`actorId` carry forward the
 * lineage of the most recent mutation (work order §4.7). The record's
 * `revision` is the storage-layer monotonic counter; the entity's
 * `version` is the domain-layer optimistic-concurrency counter — they
 * are intentionally distinct so storage revisions and domain versions
 * can evolve independently.
 *
 * Lifecycle repository methods (`getByIdWithinTx`, `saveWithinTx`)
 * operate within an authoritative transaction passed in by the
 * WorkflowService. They see uncommitted writes in the same tx so
 * read-modify-write is atomic.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  AuthorityRecord,
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { Opportunity, OpportunityRepository } from "./port.ts";

const COLLECTION = "opportunities";

/**
 * The persisted shape. The record's `value` field carries the full
 * Opportunity entity; the record's lineage fields are duplicated on
 * the entity for domain-level access (the two stay in sync because
 * every save re-derives the entity's lineage from the execution context).
 */
interface PersistedOpportunityRecord {
  readonly collection: typeof COLLECTION;
  readonly key: string;
  readonly value: Opportunity;
  readonly executionId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly writtenAt: string;
  readonly revision: number;
}

export interface AuthorityOpportunityRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthorityOpportunityRepository(
  opts: AuthorityOpportunityRepositoryOptions,
): OpportunityRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  function toOpportunity(rec: AuthorityRecord<Opportunity>): Opportunity {
    // The entity's own lineage fields are the source of truth — the
    // record's lineage fields are the storage-level provenance. We
    // return the entity as stored.
    return rec.value;
  }

  return {
    async save(opportunity, execution) {
      // Outside a workflow tx — write within a fresh authority tx so
      // the save is atomic. The repository's `save` is the entry point
      // used by OpportunityService.createOpportunity/updateBrief.
      return authority.run(execution, async (tx) => {
        const existing = await tx.get<Opportunity>(COLLECTION, opportunity.id);
        const revision = existing ? existing.revision + 1 : 1;
        const record: PersistedOpportunityRecord = {
          collection: COLLECTION,
          key: opportunity.id,
          value: {
            ...opportunity,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            updatedAt: new Date().toISOString(),
          },
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          actorId: execution.actor?.id ?? null,
          writtenAt: new Date().toISOString(),
          revision,
        };
        await tx.put(COLLECTION, opportunity.id, record.value);
        logger?.debug("opportunity.saved", {
          opportunityId: opportunity.id,
          revision,
          executionId: execution.executionId,
        });
        return record.value;
      });
    },

    async findById(id) {
      const rec = await authority.get<Opportunity>(COLLECTION, id);
      return rec ? toOpportunity(rec) : null;
    },

    async listByOrganization(organizationScopeId) {
      const all = await authority.scan<Opportunity>(COLLECTION);
      return all
        .map(toOpportunity)
        .filter((o) => o.organizationScopeId === organizationScopeId);
    },

    async exists(id) {
      const rec = await authority.get<Opportunity>(COLLECTION, id);
      return rec !== null;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<Opportunity>(COLLECTION, id);
      return rec ? toOpportunity(rec) : null;
    },

    async saveWithinTx(subject, expectedVersion, execution, tx) {
      // Re-read the current subject within the tx (sees uncommitted
      // writes in this tx). The WorkflowService has already read it
      // and checked expectedVersion; we re-check here defensively
      // (defense in depth: even if a future caller bypassed the
      // workflow service's check, the repository would still reject
      // a stale writer).
      const current = await tx.get<Opportunity>(COLLECTION, subject.id);
      if (!current) {
        throw new NotFoundError(
          `opportunity ${subject.id} not found within tx`,
          { opportunityId: subject.id },
        );
      }
      const currentEntity = current.value;
      if (currentEntity.version !== expectedVersion) {
        // The workflow service already raised ConcurrentTransitionError;
        // this is defense-in-depth. Surface as a NotFoundError-shape
        // error to avoid leaking the workflow internals — but mark with
        // a stable code so the caller can route deterministically.
        const err = new Error(
          `stale writer: expected version ${expectedVersion}, authoritative ${currentEntity.version}`,
        );
        err.name = "ConcurrentTransitionError";
        throw err;
      }
      // Preserve non-lifecycle fields by merging the updated subject
      // onto the current entity. The workflow service has already
      // computed the new state/version/lineage; we just persist it.
      const merged: Opportunity = {
        ...currentEntity,
        ...subject,
        // Preserve domain fields that the workflow service does not touch:
        opportunityType: currentEntity.opportunityType,
        title: subject.title ?? currentEntity.title,
        brief: subject.brief ?? currentEntity.brief,
        eligibilityPolicyReference:
          subject.eligibilityPolicyReference ?? currentEntity.eligibilityPolicyReference,
        contributionRequirements:
          subject.contributionRequirements ?? currentEntity.contributionRequirements,
        evidenceReferencePlaceholders:
          subject.evidenceReferencePlaceholders ?? currentEntity.evidenceReferencePlaceholders,
      };
      await tx.put(COLLECTION, subject.id, merged);
      logger?.debug("opportunity.saved_within_tx", {
        opportunityId: subject.id,
        fromVersion: currentEntity.version,
        toVersion: merged.version,
        transactionId: tx.transactionId,
      });
      return merged;
    },
  };
}

/**
 * Allocate a fresh opportunity id (used by OpportunityService when
 * creating a new opportunity).
 */
export function allocateOpportunityId(): string {
  return randomUUID();
}

export { COLLECTION as OPPORTUNITIES_COLLECTION };
export type { PersistedOpportunityRecord, AuthorityTransaction };
