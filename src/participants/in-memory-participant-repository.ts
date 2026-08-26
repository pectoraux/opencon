/**
 * Concrete ParticipantRepository + PolicyRepository — in-memory.
 *
 * Work order ref: spec/work-orders/NET-W002.md §4.7 (Persistence).
 * In-memory implementations for executable tests; production PostgreSQL is
 * NET-W003 behind the same interface.
 *
 * Tier compliance: domain tier (participants boundary). Imports only its
 * own port (self, same dir — allowed) and core (ConflictError — allowed).
 */

import type {
  Participant,
  ParticipantRepository,
  ParticipantRole,
  Policy,
  PolicyRepository,
} from "./port.ts";
import { ConflictError } from "../core/errors.ts";

export function createInMemoryParticipantRepository(
  opts: { readonly logger?: { warn(m: string, f?: Record<string, unknown>): void } } = {},
): ParticipantRepository & {
  _all(): readonly Participant[];
} {
  const byId = new Map<string, Participant>();
  const byReference = new Map<string, string>(); // referenceId -> participantId

  const repo: ParticipantRepository = {
    async save(p) {
      const existing = byId.get(p.id);
      if (existing) {
        // Update in place (e.g. role add/remove).
        byId.set(p.id, p);
        return;
      }
      // New participant. Conflict if the same referenceId is already linked
      // to a different participant (one reference -> one participant, though
      // a person can hold multiple ROLES within a single participant).
      const linkedId = byReference.get(p.referenceId);
      if (linkedId && linkedId !== p.id) {
        throw new ConflictError(
          `reference already linked to a different participant: ${p.referenceId}`,
          { referenceId: p.referenceId, existingParticipant: linkedId, requestedParticipant: p.id },
        );
      }
      byId.set(p.id, p);
      byReference.set(p.referenceId, p.id);
    },

    async findById(id) {
      const found = byId.get(id);
      return found ? { ...found, roles: [...found.roles] } : null;
    },

    async findByReference(referenceId) {
      const id = byReference.get(referenceId);
      if (!id) return null;
      const found = byId.get(id);
      return found ? { ...found, roles: [...found.roles] } : null;
    },

    async exists(id) {
      return byId.has(id);
    },

    async findByRole(role) {
      const out: Participant[] = [];
      for (const p of byId.values()) {
        if (p.roles.includes(role)) {
          out.push({ ...p, roles: [...p.roles] });
        }
      }
      return Object.freeze(out) as readonly Participant[];
    },
  };

  return Object.assign(repo, {
    _all: () =>
      Object.freeze(
        [...byId.values()].map((p) => ({ ...p, roles: [...p.roles] })),
      ) as readonly Participant[],
  });
}

export function createInMemoryPolicyRepository(
  opts: { readonly logger?: { warn(m: string, f?: Record<string, unknown>): void } } = {},
): PolicyRepository & {
  _all(): readonly Policy[];
} {
  const byId = new Map<string, Policy>();

  const repo: PolicyRepository = {
    async save(policy) {
      const existing = byId.get(policy.id);
      if (existing && existing.subject === policy.subject && existing.action === policy.action && existing.resource === policy.resource && existing.effect === policy.effect) {
        // Idempotent re-save of the same policy — no-op (no conflict).
        return;
      }
      byId.set(policy.id, policy);
    },

    async findById(id) {
      const found = byId.get(id);
      return found ? { ...found } : null;
    },

    async findBySubject(subject) {
      const out: Policy[] = [];
      for (const p of byId.values()) {
        if (p.subject === subject || p.subject === "*") {
          out.push({ ...p });
        }
      }
      return Object.freeze(out) as readonly Policy[];
    },

    async findByAction(action) {
      const out: Policy[] = [];
      for (const p of byId.values()) {
        if (p.action === action) {
          out.push({ ...p });
        }
      }
      return Object.freeze(out) as readonly Policy[];
    },

    async all() {
      return Object.freeze([...byId.values()].map((p) => ({ ...p }))) as readonly Policy[];
    },
  };

  return Object.assign(repo, {
    _all: () => Object.freeze([...byId.values()].map((p) => ({ ...p }))) as readonly Policy[],
  });
}

export { ConflictError };
export type { ParticipantRole };
