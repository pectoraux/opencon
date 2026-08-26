/**
 * Concrete OrganizationRepository + MembershipRepository — in-memory.
 *
 * Work order ref: spec/work-orders/NET-W002.md §4.7. In-memory
 * implementation for executable tests; production PostgreSQL is NET-W003
 * behind the same interface.
 *
 * Tier compliance: domain tier (organizations boundary). Imports only its
 * own port (self, same dir — allowed) and core (ConflictError — allowed).
 */

import type {
  Membership,
  MembershipRepository,
  Organization,
  OrganizationRepository,
} from "./port.ts";
import { ConflictError } from "../core/errors.ts";

export function createInMemoryOrganizationRepository(
  opts: { readonly logger?: { warn(m: string, f?: Record<string, unknown>): void } } = {},
): OrganizationRepository & {
  _all(): readonly Organization[];
} {
  const byId = new Map<string, Organization>();
  const repo: OrganizationRepository = {
    async save(org) {
      const existing = byId.get(org.id);
      if (existing) {
        throw new ConflictError(
          `organization already exists: ${org.id}`,
          { organizationId: org.id },
        );
      }
      byId.set(org.id, org);
    },
    async findById(id) {
      const found = byId.get(id);
      return found ? { ...found } : null;
    },
    async exists(id) {
      return byId.has(id);
    },
  };
  return Object.assign(repo, {
    _all: () => Object.freeze([...byId.values()].map((o) => ({ ...o }))) as readonly Organization[],
  });
}

/**
 * In-memory MembershipRepository. Enforces idempotent grants:
 * re-granting an active membership returns the existing record (no
 * duplicate). Revoking an already-revoked membership is idempotent.
 */
export function createInMemoryMembershipRepository(
  opts: { readonly logger?: { warn(m: string, f?: Record<string, unknown>): void } } = {},
): MembershipRepository & {
  _all(): readonly Membership[];
} {
  const byId = new Map<string, Membership>();
  const byPair = new Map<string, string>(); // `${personId}:${organizationId}` -> membershipId (latest)

  function pairKey(personId: string, organizationId: string): string {
    return `${personId}:${organizationId}`;
  }

  const repo: MembershipRepository = {
    async save(membership) {
      const existing = byId.get(membership.id);
      if (existing && existing.status !== membership.status) {
        // Update of an existing membership (e.g. active → revoked).
        byId.set(membership.id, membership);
        byPair.set(pairKey(membership.personId, membership.organizationId), membership.id);
        return;
      }
      if (existing && existing.status === membership.status) {
        // Idempotent re-save of the same state — no-op (no conflict).
        return;
      }
      byId.set(membership.id, membership);
      byPair.set(pairKey(membership.personId, membership.organizationId), membership.id);
    },

    async findById(id) {
      const found = byId.get(id);
      return found ? { ...found } : null;
    },

    async findByPersonAndOrganization(personId, organizationId) {
      const id = byPair.get(pairKey(personId, organizationId));
      if (!id) return null;
      const found = byId.get(id);
      return found ? { ...found } : null;
    },

    async findByOrganization(organizationId) {
      const out: Membership[] = [];
      for (const m of byId.values()) {
        if (m.organizationId === organizationId) out.push({ ...m });
      }
      return Object.freeze(out) as readonly Membership[];
    },

    async findByPerson(personId) {
      const out: Membership[] = [];
      for (const m of byId.values()) {
        if (m.personId === personId) out.push({ ...m });
      }
      return Object.freeze(out) as readonly Membership[];
    },
  };

  return Object.assign(repo, {
    _all: () => Object.freeze([...byId.values()].map((m) => ({ ...m }))) as readonly Membership[],
  });
}

export { ConflictError };
