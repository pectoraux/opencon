/**
 * ParticipantService — domain service for network-level participants.
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.3 Participant roles: support the v1.0 roles; a participant MAY have
 *      multiple roles; role assignment MUST be explicit, auditable and
 *      authorization-aware (NET-W002-AC-02, AC-05).
 *   §4.9 Audit: participant.role_added / participant.role_removed are
 *      auditable (NET-W002-AC-08).
 *
 * Role assignment lifecycle invariants (NET-W002-AC-05):
 *   - addRole is idempotent: re-adding an existing role is a no-op (no
 *     duplicate audit spam);
 *   - removeRole is idempotent: removing a non-held role is a no-op;
 *   - every material mutation emits an audit record with actor/subject/
 *     resource/execution+correlation IDs.
 *
 * Tier compliance: domain tier (participants boundary). Imports only its
 * own port (self, same dir — allowed) and core (allowed). The AuditWriter
 * is the CORE contract; the concrete writer is injected by bootstrap.
 */

import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import {
  ConflictError,
  NotFoundError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  AddParticipantRoleInput,
  CreateParticipantInput,
  Participant,
  ParticipantRepository,
  ParticipantRole,
  RemoveParticipantRoleInput,
} from "./port.ts";
import { PARTICIPANT_ROLES } from "./port.ts";

const ROLE_ADDED = "participant.role_added" as const;
const ROLE_REMOVED = "participant.role_removed" as const;

export interface ParticipantServiceDeps {
  readonly participants: ParticipantRepository;
  readonly auditWriter: AuditWriter;
  readonly logger: Logger;
}

export interface ParticipantService {
  createParticipant(
    context: ExecutionContext,
    input: CreateParticipantInput,
  ): Promise<Participant>;
  getParticipant(context: ExecutionContext, id: string): Promise<Participant>;
  /** Add a role to a participant (idempotent, audited — AC-02, AC-05). */
  addRole(
    context: ExecutionContext,
    input: AddParticipantRoleInput,
  ): Promise<{ participant: Participant; added: boolean }>;
  /** Remove a role from a participant (idempotent, audited — AC-05). */
  removeRole(
    context: ExecutionContext,
    input: RemoveParticipantRoleInput,
  ): Promise<{ participant: Participant; removed: boolean }>;
  /** Resolve a participant by canonical reference (person/organization id). */
  resolveByReference(
    context: ExecutionContext,
    referenceId: string,
  ): Promise<Participant | null>;
  /** Check whether a participant holds a role (server-resolved). */
  hasRole(participantId: string, role: ParticipantRole): Promise<boolean>;
}

function assertValidRole(role: ParticipantRole): void {
  if (!(PARTICIPANT_ROLES as readonly string[]).includes(role)) {
    throw new OpenConError({
      code: "PARTICIPANT_ROLE_INVALID",
      classification: "validation",
      message: `invalid participant role: ${role}`,
      context: { role, valid: PARTICIPANT_ROLES },
    });
  }
}

export function createParticipantService(deps: ParticipantServiceDeps): ParticipantService {
  const { participants, auditWriter, logger } = deps;

  const service: ParticipantService = {
    async createParticipant(context, input) {
      if (!input.referenceId) {
        throw new OpenConError({
          code: "PARTICIPANT_VALIDATION",
          classification: "validation",
          message: "referenceId is required",
          context: { field: "referenceId" },
        });
      }
      if (!input.createdBy) {
        throw new OpenConError({
          code: "PARTICIPANT_VALIDATION",
          classification: "validation",
          message: "createdBy is required (provenance)",
          context: { field: "createdBy" },
        });
      }
      for (const r of input.roles ?? []) {
        assertValidRole(r);
      }
      const participant: Participant = {
        id: randomUUID(),
        kind: input.kind,
        referenceId: input.referenceId,
        roles: input.roles ? [...new Set(input.roles)] : [],
        organizationScopeId: input.organizationScopeId ?? null,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
      };
      try {
        await participants.save(participant);
      } catch (err) {
        if (err instanceof ConflictError) {
          throw err;
        }
        throw err;
      }
      logger.info("participant.created", { participantId: participant.id });
      return participant;
    },

    async getParticipant(_context, id) {
      const found = await participants.findById(id);
      if (!found) {
        throw new NotFoundError(`participant not found: ${id}`, { participantId: id });
      }
      return found;
    },

    async addRole(context, input) {
      assertValidRole(input.role);
      if (!input.addedBy) {
        throw new OpenConError({
          code: "PARTICIPANT_VALIDATION",
          classification: "validation",
          message: "addedBy is required (provenance)",
          context: { field: "addedBy" },
        });
      }
      const existing = await participants.findById(input.participantId);
      if (!existing) {
        throw new NotFoundError(
          `participant not found: ${input.participantId}`,
          { participantId: input.participantId },
        );
      }
      // Idempotent: re-adding an existing role is a no-op (no audit spam).
      if (existing.roles.includes(input.role)) {
        return { participant: existing, added: false };
      }
      const updated: Participant = {
        ...existing,
        roles: [...existing.roles, input.role],
      };
      await participants.save(updated);
      try {
        await auditWriter.append({
          eventType: ROLE_ADDED,
          context,
          actor: context.actor?.id ?? input.addedBy,
          subject: updated.id,
          resourceType: "participant",
          resourceId: updated.id,
          metadata: {
            role: input.role,
            addedBy: input.addedBy,
            referenceId: updated.referenceId,
          },
        });
      } catch (auditErr) {
        logger.error("participant.audit_failed", auditErr as Error, {
          eventType: ROLE_ADDED,
          participantId: updated.id,
        });
      }
      logger.info("participant.role_added", {
        participantId: updated.id,
        role: input.role,
      });
      return { participant: updated, added: true };
    },

    async removeRole(context, input) {
      assertValidRole(input.role);
      if (!input.removedBy) {
        throw new OpenConError({
          code: "PARTICIPANT_VALIDATION",
          classification: "validation",
          message: "removedBy is required (provenance)",
          context: { field: "removedBy" },
        });
      }
      const existing = await participants.findById(input.participantId);
      if (!existing) {
        throw new NotFoundError(
          `participant not found: ${input.participantId}`,
          { participantId: input.participantId },
        );
      }
      // Idempotent: removing a non-held role is a no-op (no audit spam).
      if (!existing.roles.includes(input.role)) {
        return { participant: existing, removed: false };
      }
      const updated: Participant = {
        ...existing,
        roles: existing.roles.filter((r) => r !== input.role),
      };
      await participants.save(updated);
      try {
        await auditWriter.append({
          eventType: ROLE_REMOVED,
          context,
          actor: context.actor?.id ?? input.removedBy,
          subject: updated.id,
          resourceType: "participant",
          resourceId: updated.id,
          metadata: {
            role: input.role,
            removedBy: input.removedBy,
            referenceId: updated.referenceId,
          },
        });
      } catch (auditErr) {
        logger.error("participant.audit_failed", auditErr as Error, {
          eventType: ROLE_REMOVED,
          participantId: updated.id,
        });
      }
      logger.info("participant.role_removed", {
        participantId: updated.id,
        role: input.role,
      });
      return { participant: updated, removed: true };
    },

    async resolveByReference(_context, referenceId) {
      return participants.findByReference(referenceId);
    },

    async hasRole(participantId, role) {
      const p = await participants.findById(participantId);
      if (!p) return false;
      return p.roles.includes(role);
    },
  };

  return service;
}

export { ConflictError, NotFoundError };
