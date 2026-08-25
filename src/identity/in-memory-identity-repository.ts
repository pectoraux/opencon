/**
 * Concrete IdentityRepository — in-memory implementation.
 *
 * Work order ref: spec/work-orders/NET-W002.md §4.7 (Persistence): "NET-W002
 * MAY use the existing in-memory/test persistence boundary for executable
 * tests provided production persistence remains behind the same interface."
 *
 * This implementation lives inside the identity boundary (tier `domain`).
 * It imports only its own port (self, same dir — allowed) and the core
 * error taxonomy (ConflictError — core, allowed). It does NOT import any
 * infrastructure module (config/audit/persistence/queues) — that would
 * violate the tier allow matrix enforced by scripts/check-architecture.ts
 * (NET-W001-AC-02).
 *
 * The authoritative PostgreSQL backend is NET-W003. When NET-W003 ships a
 * real {@link IdentityRepository} implementation, this in-memory
 * implementation remains available for tests/dev and the interface is
 * unchanged.
 */

import type {
  IdentityRepository,
  PersonIdentity,
  SubjectReference,
} from "./port.ts";
import { ConflictError } from "../core/errors.ts";

/**
 * Key an auth subject reference deterministically for lookup.
 * Provider-neutral: subjectId + providerKind.
 */
function subjectKey(s: SubjectReference): string {
  return `${s.providerKind}:${s.subjectId}`;
}

export function createInMemoryIdentityRepository(
  opts: { readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void } } = {},
): IdentityRepository & {
  /** Test-only accessor: snapshot of stored identities (defensive copies). */
  _all(): readonly PersonIdentity[];
} {
  const byId = new Map<string, PersonIdentity>();
  const bySubject = new Map<string, string>(); // subjectKey -> personId

  const repo: IdentityRepository = {
    async save(identity) {
      const existing = byId.get(identity.id);
      if (existing) {
        throw new ConflictError(
          `identity already exists: ${identity.id}`,
          { identityId: identity.id },
        );
      }
      // Index subject references. Conflict if any is already linked to
      // a different identity (one subject -> one canonical identity).
      for (const ref of identity.subjectReferences) {
        const key = subjectKey(ref);
        const linkedId = bySubject.get(key);
        if (linkedId && linkedId !== identity.id) {
          throw new ConflictError(
            `subject reference already linked to a different identity: ${key}`,
            { subject: key, existingIdentity: linkedId, requestedIdentity: identity.id },
          );
        }
      }
      // Commit.
      byId.set(identity.id, identity);
      for (const ref of identity.subjectReferences) {
        bySubject.set(subjectKey(ref), identity.id);
      }
    },

    async findById(id) {
      const found = byId.get(id);
      return found ? { ...found, subjectReferences: [...found.subjectReferences], reputationAnchors: [...found.reputationAnchors] } : null;
    },

    async findBySubjectReference(subject) {
      const id = bySubject.get(subjectKey(subject));
      if (!id) return null;
      const found = byId.get(id);
      if (!found) return null;
      return { ...found, subjectReferences: [...found.subjectReferences], reputationAnchors: [...found.reputationAnchors] };
    },

    async exists(id) {
      return byId.has(id);
    },
  };

  return Object.assign(repo, {
    _all: () =>
      Object.freeze(
        [...byId.values()].map((i) => ({
          ...i,
          subjectReferences: [...i.subjectReferences],
          reputationAnchors: [...i.reputationAnchors],
        })),
      ) as readonly PersonIdentity[],
  });
}
