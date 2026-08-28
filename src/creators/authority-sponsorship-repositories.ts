/**
 * Authority-backed NET-W018 repositories — persist the commercial-
 * relationship / disclosure-declaration / publication records through
 * the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: spec/work-orders/NET-W018.md §3.
 *
 * Storage model: every collection is append-only key-value state
 * under the PostgreSQL authority:
 *  - `commercial_relationships` — the explicit commercial
 *    relationship records (DISC-001; one per engagement; static
 *    except the one-way termination fields);
 *  - `disclosure_declarations` — the immutable, evidence-bound
 *    disclosure declaration records (CRE-006);
 *  - `publications` — the lifecycle subject records (lifecycle
 *    fields are mutated ONLY through the canonical WorkflowService's
 *    LifecycleRepository surface below — the same contract every
 *    lifecycle subject repository exposes; the one-time verification
 *    bookkeeping is written by the sponsorship service's composite).
 *
 * Sponsorship and disclosure logic introduces NO second workflow
 * engine, ledger, reputation engine, risk authority, evidence
 * authority or platform ownership layer: the only lifecycle mutation
 * surface here is the sanctioned LifecycleRepository structural
 * contract consumed by /workflows.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  CommercialRelationship,
  CommercialRelationshipRepository,
  DisclosureDeclaration,
  DisclosureDeclarationRepository,
  PublicationRecord,
  PublicationRepository,
} from "./port.ts";

export const COMMERCIAL_RELATIONSHIPS_COLLECTION =
  "commercial_relationships";
export const DISCLOSURE_DECLARATIONS_COLLECTION =
  "disclosure_declarations";
export const PUBLICATIONS_COLLECTION = "publications";

export interface AuthoritySponsorshipRepositoriesOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function byCreatedAt(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Commercial-relationship repository
// ---------------------------------------------------------------------------

export function createAuthorityCommercialRelationshipRepository(
  opts: AuthoritySponsorshipRepositoriesOptions,
): CommercialRelationshipRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(relationship, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(
          COMMERCIAL_RELATIONSHIPS_COLLECTION,
          relationship.id,
          relationship,
        );
        logger?.debug("commercial_relationship.saved", {
          relationshipId: relationship.id,
          executionId: execution.executionId,
        });
        return relationship;
      });
    },

    async findById(id) {
      const rec = await authority.get<CommercialRelationship>(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findByEngagement(organizationScopeId, engagementId) {
      const records = await authority.scan<CommercialRelationship>(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
      );
      for (const rec of records) {
        const relationship = rec.value;
        if (
          relationship.organizationScopeId === organizationScopeId &&
          relationship.engagementId === engagementId
        ) {
          return relationship;
        }
      }
      return null;
    },

    async findByEngagementWithinTx(organizationScopeId, engagementId, tx) {
      const records = await tx.scan<CommercialRelationship>(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
      );
      for (const rec of records) {
        const relationship = rec.value;
        if (
          relationship.organizationScopeId === organizationScopeId &&
          relationship.engagementId === engagementId
        ) {
          return relationship;
        }
      }
      return null;
    },

    async createWithinTx(relationship, tx) {
      const existing = await tx.get<CommercialRelationship>(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
        relationship.id,
      );
      if (existing) {
        throw new Error(
          `commercial relationship already persisted: ${relationship.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
        relationship.id,
        relationship,
      );
      logger?.debug("commercial_relationship.created", {
        relationshipId: relationship.id,
        organizationScopeId: relationship.organizationScopeId,
      });
      return relationship;
    },

    async terminateWithinTx(relationshipId, terminatedAt, reason, tx) {
      const current = await tx.get<CommercialRelationship>(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
        relationshipId,
      );
      if (!current) {
        throw new NotFoundError(
          `commercial relationship ${relationshipId} not found within tx`,
          { relationshipId },
        );
      }
      // One-way: an already-terminated record is returned unchanged
      // (the idempotent-apply replay path).
      if (current.value.terminatedAt !== null) {
        return current.value;
      }
      const terminated: CommercialRelationship = {
        ...current.value,
        terminatedAt,
        terminationReason: reason,
      };
      await tx.put(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
        relationshipId,
        terminated,
      );
      logger?.debug("commercial_relationship.terminated", {
        relationshipId,
        transactionId: tx.transactionId,
      });
      return terminated;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<CommercialRelationship>(
        COMMERCIAL_RELATIONSHIPS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (relationship) =>
            relationship.organizationScopeId === organizationScopeId &&
            (!filters?.campaignId ||
              relationship.campaignId === filters.campaignId) &&
            (!filters?.engagementId ||
              relationship.engagementId === filters.engagementId) &&
            (!filters?.creatorPersonId ||
              relationship.creatorPersonId === filters.creatorPersonId),
        )
        .sort(byCreatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Disclosure-declaration repository
// ---------------------------------------------------------------------------

export function createAuthorityDisclosureDeclarationRepository(
  opts: AuthoritySponsorshipRepositoriesOptions,
): DisclosureDeclarationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(declaration, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(
          DISCLOSURE_DECLARATIONS_COLLECTION,
          declaration.id,
          declaration,
        );
        logger?.debug("disclosure_declaration.saved", {
          declarationId: declaration.id,
          executionId: execution.executionId,
        });
        return declaration;
      });
    },

    async findById(id) {
      const rec = await authority.get<DisclosureDeclaration>(
        DISCLOSURE_DECLARATIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(declaration, tx) {
      const existing = await tx.get<DisclosureDeclaration>(
        DISCLOSURE_DECLARATIONS_COLLECTION,
        declaration.id,
      );
      if (existing) {
        throw new Error(
          `disclosure declaration already persisted: ${declaration.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(
        DISCLOSURE_DECLARATIONS_COLLECTION,
        declaration.id,
        declaration,
      );
      logger?.debug("disclosure_declaration.created", {
        declarationId: declaration.id,
        publicationId: declaration.publicationId,
      });
      return declaration;
    },

    async listByPublication(organizationScopeId, publicationId) {
      const records = await authority.scan<DisclosureDeclaration>(
        DISCLOSURE_DECLARATIONS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (declaration) =>
            declaration.organizationScopeId === organizationScopeId &&
            declaration.publicationId === publicationId,
        )
        .sort(byCreatedAt);
    },

    async listByPublicationWithinTx(organizationScopeId, publicationId, tx) {
      const records = await tx.scan<DisclosureDeclaration>(
        DISCLOSURE_DECLARATIONS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (declaration) =>
            declaration.organizationScopeId === organizationScopeId &&
            declaration.publicationId === publicationId,
        )
        .sort(byCreatedAt);
    },

    async countByPublicationWithinTx(publicationId, tx) {
      const records = await tx.scan<DisclosureDeclaration>(
        DISCLOSURE_DECLARATIONS_COLLECTION,
      );
      let count = 0;
      for (const rec of records) {
        if (rec.value.publicationId === publicationId) count += 1;
      }
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// Publication repository (+ the LifecycleRepository surface)
// ---------------------------------------------------------------------------

export function createAuthorityPublicationRepository(
  opts: AuthoritySponsorshipRepositoriesOptions,
): PublicationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(publication, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(PUBLICATIONS_COLLECTION, publication.id, publication);
        logger?.debug("publication.saved", {
          publicationId: publication.id,
          executionId: execution.executionId,
        });
        return publication;
      });
    },

    async findById(id) {
      const rec = await authority.get<PublicationRecord>(
        PUBLICATIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(publication, tx) {
      const existing = await tx.get<PublicationRecord>(
        PUBLICATIONS_COLLECTION,
        publication.id,
      );
      if (existing) {
        throw new Error(
          `publication already persisted: ${publication.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(PUBLICATIONS_COLLECTION, publication.id, publication);
      logger?.debug("publication.created", {
        publicationId: publication.id,
        organizationScopeId: publication.organizationScopeId,
      });
      return publication;
    },

    async applyVerificationWithinTx(
      publicationId,
      evidenceReferences,
      verifiedAt,
      tx,
    ) {
      const current = await tx.get<PublicationRecord>(
        PUBLICATIONS_COLLECTION,
        publicationId,
      );
      if (!current) {
        throw new NotFoundError(
          `publication ${publicationId} not found within tx`,
          { publicationId },
        );
      }
      // One-way bookkeeping: an already-verified publication is
      // returned unchanged (the idempotent-apply replay path — the
      // composite's transition carries the authoritative gate).
      if (current.value.verifiedAt !== null) {
        return current.value;
      }
      const recorded: PublicationRecord = {
        ...current.value,
        publicationEvidenceReferences: Object.freeze([...evidenceReferences]),
        verifiedAt,
      };
      await tx.put(PUBLICATIONS_COLLECTION, publicationId, recorded);
      logger?.debug("publication.verification_recorded", {
        publicationId,
        verifiedAt,
        transactionId: tx.transactionId,
      });
      return recorded;
    },

    async listByOrganization(organizationScopeId, filters) {
      const records = await authority.scan<PublicationRecord>(
        PUBLICATIONS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (publication) =>
            publication.organizationScopeId === organizationScopeId &&
            (!filters?.engagementId ||
              publication.engagementId === filters.engagementId) &&
            (!filters?.campaignId ||
              publication.campaignId === filters.campaignId) &&
            (!filters?.creatorPersonId ||
              publication.creatorPersonId === filters.creatorPersonId) &&
            (!filters?.states ||
              (filters.states as readonly string[]).includes(
                publication.state,
              )),
        )
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id < b.id
              ? -1
              : 1
            : a.createdAt < b.createdAt
              ? -1
              : 1,
        );
    },

    // -- LifecycleRepository structural surface (consumed by the
    //    canonical WorkflowService — the SOLE lifecycle authority).

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<PublicationRecord>(PUBLICATIONS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async saveWithinTx(subject, expectedVersion, execution, tx) {
      // Re-read the current subject within the tx (sees uncommitted
      // writes in this tx). Defense in depth: the WorkflowService has
      // already checked expectedVersion; we re-check here so even a
      // caller bypassing the workflow service cannot write stale.
      const current = await tx.get<PublicationRecord>(
        PUBLICATIONS_COLLECTION,
        subject.id,
      );
      if (!current) {
        throw new NotFoundError(
          `publication ${subject.id} not found within tx`,
          { publicationId: subject.id },
        );
      }
      if (current.value.version !== expectedVersion) {
        const err = new Error(
          `stale writer: expected version ${expectedVersion}, authoritative ${current.value.version}`,
        );
        err.name = "ConcurrentTransitionError";
        throw err;
      }
      // Merge the workflow service's lifecycle mutation onto the
      // current entity, preserving ALL domain fields (the record is
      // static after creation except the lifecycle fields + the
      // one-time verification bookkeeping).
      const merged: PublicationRecord = {
        ...current.value,
        ...subject,
        engagementId: current.value.engagementId,
        productionId: current.value.productionId,
        creatorPersonId: current.value.creatorPersonId,
        campaignId: current.value.campaignId,
        channel: current.value.channel,
        publicationEvidenceReferences:
          current.value.publicationEvidenceReferences,
        verifiedAt: current.value.verifiedAt,
        formatVersion: current.value.formatVersion,
      };
      await tx.put(PUBLICATIONS_COLLECTION, subject.id, merged);
      logger?.debug("publication.saved_within_tx", {
        publicationId: subject.id,
        fromVersion: current.value.version,
        toVersion: merged.version,
        transactionId: tx.transactionId,
      });
      return merged;
    },
  };
}
