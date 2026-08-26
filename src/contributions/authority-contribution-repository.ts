/**
 * Authority-backed ContributionRepository — persists contributions through
 * the PostgreSQL authority boundary established by NET-W003.
 *
 * Work order ref: NET-W004 §3.2 (Contribution first-class model),
 * §4.6 (PostgreSQL-backed authority boundaries).
 *
 * Mirrors the {@link createAuthorityOpportunityRepository} pattern: the
 * contribution entity (including all lifecycle + domain fields) is
 * stored as the record's `value`. Lifecycle repository methods operate
 * within an authoritative transaction passed in by the WorkflowService.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  AuthorityRecord,
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { Contribution, ContributionRepository } from "./port.ts";

const COLLECTION = "contributions";

interface PersistedContributionRecord {
  readonly collection: typeof COLLECTION;
  readonly key: string;
  readonly value: Contribution;
  readonly executionId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly writtenAt: string;
  readonly revision: number;
}

export interface AuthorityContributionRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthorityContributionRepository(
  opts: AuthorityContributionRepositoryOptions,
): ContributionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  function toContribution(rec: AuthorityRecord<Contribution>): Contribution {
    return rec.value;
  }

  return {
    async save(contribution, execution) {
      return authority.run(execution, async (tx) => {
        const existing = await tx.get<Contribution>(COLLECTION, contribution.id);
        const revision = existing ? existing.revision + 1 : 1;
        const record: PersistedContributionRecord = {
          collection: COLLECTION,
          key: contribution.id,
          value: {
            ...contribution,
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
        await tx.put(COLLECTION, contribution.id, record.value);
        logger?.debug("contribution.saved", {
          contributionId: contribution.id,
          revision,
          executionId: execution.executionId,
        });
        return record.value;
      });
    },

    async findById(id) {
      const rec = await authority.get<Contribution>(COLLECTION, id);
      return rec ? toContribution(rec) : null;
    },

    async listByOpportunity(opportunityId) {
      const all = await authority.scan<Contribution>(COLLECTION);
      return all
        .map(toContribution)
        .filter((c) => c.opportunityId === opportunityId);
    },

    async listByContributor(contributorId) {
      const all = await authority.scan<Contribution>(COLLECTION);
      return all
        .map(toContribution)
        .filter((c) => c.contributorId === contributorId);
    },

    async exists(id) {
      const rec = await authority.get<Contribution>(COLLECTION, id);
      return rec !== null;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<Contribution>(COLLECTION, id);
      return rec ? toContribution(rec) : null;
    },

    async saveWithinTx(subject, expectedVersion, execution, tx) {
      const current = await tx.get<Contribution>(COLLECTION, subject.id);
      if (!current) {
        throw new NotFoundError(
          `contribution ${subject.id} not found within tx`,
          { contributionId: subject.id },
        );
      }
      const currentEntity = current.value;
      if (currentEntity.version !== expectedVersion) {
        const err = new Error(
          `stale writer: expected version ${expectedVersion}, authoritative ${currentEntity.version}`,
        );
        err.name = "ConcurrentTransitionError";
        throw err;
      }
      const merged: Contribution = {
        ...currentEntity,
        ...subject,
        // Preserve domain fields the workflow service does not touch:
        opportunityId: currentEntity.opportunityId,
        contributorId: currentEntity.contributorId,
        contributionType: currentEntity.contributionType,
        submission: currentEntity.submission,
        evidenceReferencePlaceholders:
          subject.evidenceReferencePlaceholders ?? currentEntity.evidenceReferencePlaceholders,
      };
      await tx.put(COLLECTION, subject.id, merged);
      logger?.debug("contribution.saved_within_tx", {
        contributionId: subject.id,
        fromVersion: currentEntity.version,
        toVersion: merged.version,
        transactionId: tx.transactionId,
      });
      return merged;
    },
  };
}

export function allocateContributionId(): string {
  return randomUUID();
}

export { COLLECTION as CONTRIBUTIONS_COLLECTION };
export type { AuthorityTransaction, PersistedContributionRecord };
