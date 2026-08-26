/**
 * OrganizationService + MembershipService — domain services.
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.2 Organizations and membership: organization records + explicit
 *      membership records supporting member status, membership
 *      lifecycle, organization-scoped authorization, actor/member
 *      provenance. No business-specific org workflows beyond
 *      membership/authorization state.
 *   §4.5 Authorization: organization membership checks.
 *   §4.9 Audit: organization.created, organization.membership_granted,
 *      organization.membership_revoked are auditable (NET-W002-AC-08).
 *
 * Membership lifecycle invariants (NET-W002-AC-05):
 *   - grant is deterministic + idempotent (re-granting an active membership
 *     returns the existing record; no duplicate, no audit spam on replay);
 *   - revoke is deterministic + idempotent;
 *   - role changes (participant roles) are owned by /participants; here we
 *     model the membership lifecycle only;
 *   - every material mutation emits an audit record with actor/subject/
 *     resource/execution+correlation IDs.
 *
 * Tier compliance: domain tier (organizations boundary). Imports only its
 * own port (self, same dir — allowed) and core (ExecutionContext, AuditWriter,
 * Logger, OpenConError subclasses, randomUUID — all from core, allowed).
 * The AuditWriter is the CORE contract; the concrete writer is injected by
 * the bootstrap composition root.
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
  CreateOrganizationInput,
  GrantMembershipInput,
  Membership,
  MembershipRepository,
  MembershipStatus,
  Organization,
  OrganizationRepository,
} from "./port.ts";

const ORG_CREATED = "organization.created" as const;
const MEMBERSHIP_GRANTED = "organization.membership_granted" as const;
const MEMBERSHIP_REVOKED = "organization.membership_revoked" as const;

export interface OrganizationServiceDeps {
  readonly organizations: OrganizationRepository;
  readonly memberships: MembershipRepository;
  readonly auditWriter: AuditWriter;
  readonly logger: Logger;
}

export interface OrganizationService {
  createOrganization(
    context: ExecutionContext,
    input: CreateOrganizationInput,
  ): Promise<Organization>;
  getOrganization(context: ExecutionContext, id: string): Promise<Organization>;
}

export interface MembershipService {
  /**
   * Grant a membership. Idempotent: re-granting an ACTIVE membership
   * returns the existing record without emitting a duplicate audit
   * event (NET-W002-AC-05). Throws ConflictError only if the caller
   * attempts to grant a membership that is currently REVOKED (the
   * caller must explicitly re-grant after revocation).
   */
  grantMembership(
    context: ExecutionContext,
    input: GrantMembershipInput,
  ): Promise<{ membership: Membership; created: boolean }>;
  /**
   * Revoke a membership. Idempotent: revoking an already-revoked
   * membership is a no-op (returns the existing record, `already: true`,
   * no audit spam). Throws NotFoundError if no membership record exists.
   */
  revokeMembership(
    context: ExecutionContext,
    membershipId: string,
    revokedBy: string,
  ): Promise<{ membership: Membership; already: boolean }>;
  /** Look up the membership for a person in an organization. */
  getMembership(
    context: ExecutionContext,
    personId: string,
    organizationId: string,
  ): Promise<Membership | null>;
  /** All memberships for an organization (active + revoked). */
  listForOrganization(
    context: ExecutionContext,
    organizationId: string,
  ): Promise<readonly Membership[]>;
  /** All memberships for a person (active + revoked). */
  listForPerson(
    context: ExecutionContext,
    personId: string,
  ): Promise<readonly Membership[]>;
}

export function createOrganizationService(deps: OrganizationServiceDeps): OrganizationService {
  const { organizations, auditWriter, logger } = deps;

  const service: OrganizationService = {
    async createOrganization(context, input) {
      if (!input.name?.trim()) {
        throw new OpenConError({
          code: "ORGANIZATION_VALIDATION",
          classification: "validation",
          message: "organization name is required",
          context: { field: "name" },
        });
      }
      if (!input.creatorId) {
        throw new OpenConError({
          code: "ORGANIZATION_VALIDATION",
          classification: "validation",
          message: "creatorId is required (actor provenance, §4.2)",
          context: { field: "creatorId" },
        });
      }
      const org: Organization = {
        id: randomUUID(),
        name: input.name.trim(),
        createdBy: input.creatorId,
        createdAt: new Date().toISOString(),
      };
      await organizations.save(org);
      try {
        await auditWriter.append({
          eventType: ORG_CREATED,
          context,
          actor: context.actor?.id ?? input.creatorId,
          subject: org.id,
          resourceType: "organization",
          resourceId: org.id,
          metadata: {
            name: org.name,
            createdBy: org.createdBy,
          },
        });
      } catch (auditErr) {
        logger.error("organization.audit_failed", auditErr as Error, {
          eventType: ORG_CREATED,
          organizationId: org.id,
        });
      }
      logger.info("organization.created", { organizationId: org.id });
      return org;
    },

    async getOrganization(_context, id) {
      const found = await organizations.findById(id);
      if (!found) {
        throw new NotFoundError(`organization not found: ${id}`, { organizationId: id });
      }
      return found;
    },
  };

  return service;
}

export function createMembershipService(deps: OrganizationServiceDeps): MembershipService {
  const { organizations, memberships, auditWriter, logger } = deps;

  async function ensureOrgExists(organizationId: string): Promise<void> {
    const exists = await organizations.exists(organizationId);
    if (!exists) {
      throw new NotFoundError(
        `organization not found: ${organizationId}`,
        { organizationId },
      );
    }
  }

  const service: MembershipService = {
    async grantMembership(context, input) {
      if (!input.personId) {
        throw new OpenConError({
          code: "MEMBERSHIP_VALIDATION",
          classification: "validation",
          message: "personId is required",
          context: { field: "personId" },
        });
      }
      if (!input.organizationId) {
        throw new OpenConError({
          code: "MEMBERSHIP_VALIDATION",
          classification: "validation",
          message: "organizationId is required",
          context: { field: "organizationId" },
        });
      }
      if (!input.grantedBy) {
        throw new OpenConError({
          code: "MEMBERSHIP_VALIDATION",
          classification: "validation",
          message: "grantedBy is required (actor provenance, §4.2)",
          context: { field: "grantedBy" },
        });
      }
      await ensureOrgExists(input.organizationId);

      // Idempotent grant: if an ACTIVE membership already exists for this
      // person+org, return it without a duplicate audit event (AC-05).
      const existing = await memberships.findByPersonAndOrganization(
        input.personId,
        input.organizationId,
      );
      if (existing && existing.status === "active") {
        return { membership: existing, created: false };
      }
      if (existing && existing.status === "revoked") {
        // Re-grant after revocation: throw — caller must use a fresh
        // membership id (revoked memberships are terminal; re-grant is a
        // new membership record). This keeps the lifecycle deterministic.
        throw new ConflictError(
          `membership was revoked; re-grant requires a new record`,
          {
            personId: input.personId,
            organizationId: input.organizationId,
            revokedMembershipId: existing.id,
          },
        );
      }

      const membership: Membership = {
        id: randomUUID(),
        personId: input.personId,
        organizationId: input.organizationId,
        status: "active",
        grantedAt: new Date().toISOString(),
        grantedBy: input.grantedBy,
        revokedAt: null,
        revokedBy: null,
      };
      await memberships.save(membership);
      try {
        await auditWriter.append({
          eventType: MEMBERSHIP_GRANTED,
          context,
          actor: context.actor?.id ?? input.grantedBy,
          subject: input.personId,
          resourceType: "membership",
          resourceId: membership.id,
          metadata: {
            personId: membership.personId,
            organizationId: membership.organizationId,
            grantedBy: membership.grantedBy,
          },
        });
      } catch (auditErr) {
        logger.error("membership.audit_failed", auditErr as Error, {
          eventType: MEMBERSHIP_GRANTED,
          membershipId: membership.id,
        });
      }
      logger.info("membership.granted", {
        membershipId: membership.id,
        personId: membership.personId,
        organizationId: membership.organizationId,
      });
      return { membership, created: true };
    },

    async revokeMembership(context, membershipId, revokedBy) {
      if (!revokedBy) {
        throw new OpenConError({
          code: "MEMBERSHIP_VALIDATION",
          classification: "validation",
          message: "revokedBy is required (actor provenance, §4.2)",
          context: { field: "revokedBy" },
        });
      }
      const existing = await memberships.findById(membershipId);
      if (!existing) {
        throw new NotFoundError(
          `membership not found: ${membershipId}`,
          { membershipId },
        );
      }
      // Idempotent revoke: already-revoked → no-op (no audit spam).
      if (existing.status === "revoked") {
        return { membership: existing, already: true };
      }
      const revoked: Membership = {
        ...existing,
        status: "revoked" as MembershipStatus,
        revokedAt: new Date().toISOString(),
        revokedBy,
      };
      await memberships.save(revoked);
      try {
        await auditWriter.append({
          eventType: MEMBERSHIP_REVOKED,
          context,
          actor: context.actor?.id ?? revokedBy,
          subject: existing.personId,
          resourceType: "membership",
          resourceId: existing.id,
          metadata: {
            personId: existing.personId,
            organizationId: existing.organizationId,
            revokedBy,
          },
        });
      } catch (auditErr) {
        logger.error("membership.audit_failed", auditErr as Error, {
          eventType: MEMBERSHIP_REVOKED,
          membershipId: existing.id,
        });
      }
      logger.info("membership.revoked", { membershipId: existing.id });
      return { membership: revoked, already: false };
    },

    async getMembership(_context, personId, organizationId) {
      return memberships.findByPersonAndOrganization(personId, organizationId);
    },

    async listForOrganization(_context, organizationId) {
      return memberships.findByOrganization(organizationId);
    },

    async listForPerson(_context, personId) {
      return memberships.findByPerson(personId);
    },
  };

  return service;
}

export { ConflictError, NotFoundError };
