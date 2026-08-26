/**
 * Organizations boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership):
 *   `/identity`, `/organizations`, `/participants` → identity, roles,
 *   organization membership and eligibility.
 * Architecture ref: spec/architecture-lock.md §2 (core domain `/organizations`).
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.2 Organizations and membership: organization records + explicit
 *      membership records supporting member status, role assignment,
 *      membership lifecycle, organization-scoped authorization, actor/
 *      member provenance. No business-specific org workflows beyond
 *      membership/authorization state.
 *   §4.5 Authorization / policy: server-side authorization primitives
 *      including organization membership checks.
 *   §4.7 Persistence: explicit persistence ports; reuse NET-W001 boundary.
 *   §4.9 Audit: material mutations (organization created, membership
 *      granted/revoked, role added/removed, policy changed) are auditable.
 *
 * This boundary owns organization records and the person↔organization
 * membership relationship. Network-level participant roles (PERSON,
 * CREATOR, COMPANY, …) are owned by `/participants` (a separate domain);
 * the {@link MembershipLookup} interface below is the structural surface
 * the participants `AuthorizationService` consumes for org-membership
 * checks (declared there to respect the domain→domain prohibition).
 *
 * Tier compliance: this port declares contracts ONLY (no executable
 * material logic). The concrete in-memory repositories + OrganizationService
 * + MembershipService live in this boundary and are wired by the bootstrap
 * composition root. No economically material behaviour (campaigns,
 * settlement, credit issuance) is introduced (§5).
 */

import type { ExecutionContext } from "../core/execution-context.ts";

/** An organization record. */
export interface Organization {
  /** Stable, opaque canonical identifier. */
  readonly id: string;
  /** Human-readable organization name. */
  readonly name: string;
  /** Canonical identity id of the creator (actor provenance, §4.2). */
  readonly createdBy: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Membership status. Lifecycle: active → revoked (terminal). */
export type MembershipStatus = "active" | "revoked";

/**
 * An explicit membership record linking a canonical person identity to an
 * organization. Carries lifecycle state + actor provenance (§4.2).
 */
export interface Membership {
  /** Stable, opaque membership id. */
  readonly id: string;
  /** Canonical person identity id. */
  readonly personId: string;
  /** Organization id. */
  readonly organizationId: string;
  /** Lifecycle status (active or revoked). */
  readonly status: MembershipStatus;
  /** ISO-8601 timestamp the membership was granted. */
  readonly grantedAt: string;
  /** Canonical identity id that granted the membership (provenance). */
  readonly grantedBy: string;
  /** ISO-8601 timestamp the membership was revoked, if applicable. */
  readonly revokedAt: string | null;
  /** Canonical identity id that revoked the membership, if applicable. */
  readonly revokedBy: string | null;
}

/** Inputs used to create an organization. */
export interface CreateOrganizationInput {
  readonly name: string;
  /** Canonical identity id of the creator (becomes `createdBy`). */
  readonly creatorId: string;
}

/** Inputs used to grant a membership. */
export interface GrantMembershipInput {
  readonly personId: string;
  readonly organizationId: string;
  /** Canonical identity id authorizing the grant (becomes `grantedBy`). */
  readonly grantedBy: string;
}

/**
 * OrganizationRepository — persistence port for organization records.
 *
 * Work order ref: §4.7. The authoritative PostgreSQL backend is NET-W003;
 * NET-W002 ships an in-memory implementation behind the same interface.
 */
export interface OrganizationRepository {
  save(organization: Organization): Promise<void>;
  findById(id: string): Promise<Organization | null>;
  exists(id: string): Promise<boolean>;
}

/**
 * MembershipRepository — persistence port for membership records.
 *
 * This interface is also the structural surface the participants
 * `AuthorizationService` consumes as `MembershipLookup` (for
 * organization-membership checks). The bootstrap composition root wires
 * a single concrete implementation to satisfy both roles.
 */
export interface MembershipRepository {
  save(membership: Membership): Promise<void>;
  findById(id: string): Promise<Membership | null>;
  /**
   * Find the (most recent) membership for a person in an organization.
   * Returns null when no membership record exists. A revoked membership
   * is returned with `status: "revoked"` so callers can distinguish.
   */
  findByPersonAndOrganization(
    personId: string,
    organizationId: string,
  ): Promise<Membership | null>;
  /** All memberships for an organization (active + revoked, audit use). */
  findByOrganization(organizationId: string): Promise<readonly Membership[]>;
  /** All memberships for a person (active + revoked, audit use). */
  findByPerson(personId: string): Promise<readonly Membership[]>;
}

/**
 * MembershipLookup — the structural subset the participants
 * AuthorizationService consumes for organization-membership checks
 * (§4.5). Declared here so participants can import it (it lives in this
 * port — `organizations` is a domain; participants importing another
 * domain's port would violate the tier rules). Instead, the participants
 * port declares an equivalent `MembershipLookup` interface and the
 * bootstrap wires the concrete MembershipRepository to satisfy it
 * structurally. This indirection keeps domains decoupled.
 *
 * (This interface is retained for documentation/test convenience; the
 * authoritative contract the AuthorizationService consumes is mirrored
 * in participants/port.ts.)
 */
export interface MembershipLookup {
  findByPersonAndOrganization(
    personId: string,
    organizationId: string,
  ): Promise<Membership | null>;
  findByPerson(personId: string): Promise<readonly Membership[]>;
}

/**
 * The OrganizationsPort describes the boundary's readiness. After NET-W002
 * it is `"ready"`.
 */
export interface OrganizationsPort {
  readonly boundary: "organizations";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly organizationCreated: "organization.created";
    readonly membershipGranted: "organization.membership_granted";
    readonly membershipRevoked: "organization.membership_revoked";
  };
}

export type { ExecutionContext };
