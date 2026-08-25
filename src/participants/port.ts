/**
 * Participants boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership):
 *   `/identity`, `/organizations`, `/participants` → identity, roles,
 *   organization membership and eligibility.
 *   `/participants` authority: "participant identity, roles, policies,
 *   reputation references and economic accounts" (architecture §18).
 * Architecture ref: spec/architecture-lock.md §2 (core domain `/participants`).
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.3 Participant roles: support the v1.0 roles
 *      (PERSON, CREATOR, COMPANY, ADVERTISER, PUBLISHER, APP, SUPPLIER,
 *      COMMUNITY, MEASUREMENT_PROVIDER); a participant MAY have multiple
 *      roles; role assignment MUST be explicit, auditable and
 *      authorization-aware.
 *   §4.5 Authorization / policy: server-side authorization primitives
 *      including authenticated principal resolution, role checks,
 *      participant scope checks, organization membership checks,
 *      ownership checks, and explicit deny-by-default for protected
 *      mutations. Authorization MUST be enforced at the server boundary
 *      and MUST NOT rely on client-provided role/scope claims without
 *      server validation (§4.5, API-AC-02).
 *   §4.6 API integration: minimum middleware/guarding to demonstrate
 *      protected operations reject unauthenticated/unauthorized principals.
 *   §4.7 Persistence: explicit persistence ports; reuse NET-W001 boundary.
 *   §4.9 Audit: participant role added/removed, authorization policy
 *      changed are auditable (NET-W002-AC-08).
 *
 * This boundary owns the network-level participant model (a participant
 * is a person or organization acting in one or more v1.0 roles) and the
 * server-side AuthorizationService. It does NOT implement downstream
 * authorization decisions (campaigns, contributions, procurement,
 * benefits, settlement) — those are explicitly out of scope (§5).
 *
 * CROSS-DOMAIN LOOKUP PATTERN: the AuthorizationService needs to check
 * organization membership (owned by `/organizations`) and identity
 * existence (owned by `/identity`). The tier allow matrix prohibits
 * domain→domain imports, so this port declares minimal lookup interfaces
 * (`MembershipLookup`, `IdentityLookup`) that the bootstrap composition
 * root satisfies by wiring the concrete repositories from the other
 * domains (TypeScript structural typing makes them assignable).
 *
 * Tier compliance: contracts ONLY. Concrete in-memory repositories +
 * AuthorizationService live in this boundary and are wired by bootstrap.
 */

import type { ExecutionContext } from "../core/execution-context.ts";

/**
 * The frozen v1.0 participant roles (ID-002). A participant MAY hold
 * multiple roles simultaneously (architecture §3 "Actors may hold multiple
 * roles under one identity").
 */
export type ParticipantRole =
  | "PERSON"
  | "CREATOR"
  | "COMPANY"
  | "ADVERTISER"
  | "PUBLISHER"
  | "APP"
  | "SUPPLIER"
  | "COMMUNITY"
  | "MEASUREMENT_PROVIDER";

/** All v1.0 roles, in declared order (used by NET-W002-AC-02 evidence). */
export const PARTICIPANT_ROLES: readonly ParticipantRole[] = [
  "PERSON",
  "CREATOR",
  "COMPANY",
  "ADVERTISER",
  "PUBLISHER",
  "APP",
  "SUPPLIER",
  "COMMUNITY",
  "MEASUREMENT_PROVIDER",
] as const;

/**
 * The kind of subject a participant is. A participant is either a canonical
 * person identity or an organization (both can hold v1.0 roles — e.g. an
 * organization can be a COMPANY participant, a person can be a CREATOR
 * participant).
 */
export type ParticipantKind = "person" | "organization";

/**
 * A network-level participant: a person or organization holding one or more
 * v1.0 roles. Role assignment is explicit, auditable and authorization-aware
 * (§4.3, NET-W002-AC-02, NET-W002-AC-05). One canonical person identity can
 * be a participant holding multiple roles across multiple organizations
 * without duplicating the underlying identity (NET-W002-AC-01).
 */
export interface Participant {
  /** Stable, opaque participant identifier. */
  readonly id: string;
  /** Whether the participant is a person or an organization. */
  readonly kind: ParticipantKind;
  /** Canonical identity id (person identity id or organization id). */
  readonly referenceId: string;
  /** v1.0 roles currently held by this participant (no duplicates). */
  readonly roles: readonly ParticipantRole[];
  /** Optional organization scope (when the participant acts on behalf of an org). */
  readonly organizationScopeId: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Canonical identity id that created this participant (provenance). */
  readonly createdBy: string;
}

/** Authorization policy effect. Deny-by-default (§4.5). */
export type PolicyEffect = "allow" | "deny";

/**
 * An explicit authorization policy record. Policies are evaluated
 * server-side by the AuthorizationService. Deny-by-default: any
 * protected mutation not matched by an allow policy is denied (§4.5,
 * API-AC-02).
 *
 * NET-W002 ships the policy storage + evaluation primitives only.
 * Downstream authorization decisions (campaigns, contributions,
 * procurement, benefits, settlement) are explicitly out of scope (§5).
 */
export interface Policy {
  /** Stable, opaque policy id. */
  readonly id: string;
  /** Subject the policy applies to (participant id, or "*" for any). */
  readonly subject: string;
  /** Action the policy allows or denies (e.g. "organization.membership.grant"). */
  readonly action: string;
  /** Resource the policy applies to (organization id, participant id, or "*"). */
  readonly resource: string;
  /** Effect (allow or deny). Deny policies override allow policies. */
  readonly effect: PolicyEffect;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Canonical identity id that created the policy (provenance). */
  readonly createdBy: string;
}

/** Inputs to create a participant. */
export interface CreateParticipantInput {
  readonly kind: ParticipantKind;
  readonly referenceId: string;
  readonly roles?: readonly ParticipantRole[];
  readonly organizationScopeId?: string | null;
  readonly createdBy: string;
}

/** Inputs to add a role to a participant (NET-W002-AC-02, AC-05). */
export interface AddParticipantRoleInput {
  readonly participantId: string;
  readonly role: ParticipantRole;
  readonly addedBy: string;
}

/** Inputs to remove a role from a participant. */
export interface RemoveParticipantRoleInput {
  readonly participantId: string;
  readonly role: ParticipantRole;
  readonly removedBy: string;
}

/**
 * ParticipantRepository — persistence port for participants.
 *
 * Work order ref: §4.7. The authoritative PostgreSQL backend is NET-W003;
 * NET-W002 ships an in-memory implementation behind the same interface.
 */
export interface ParticipantRepository {
  save(participant: Participant): Promise<void>;
  findById(id: string): Promise<Participant | null>;
  /** Find a participant by its canonical reference (person/organization id). */
  findByReference(referenceId: string): Promise<Participant | null>;
  exists(id: string): Promise<boolean>;
  /** All participants holding a given role (for role checks). */
  findByRole(role: ParticipantRole): Promise<readonly Participant[]>;
}

/**
 * PolicyRepository — persistence port for authorization policies.
 *
 * Work order ref: §4.5 (Authorization/policy), §4.7 (persistence), §6
 * (PolicyRepository).
 */
export interface PolicyRepository {
  save(policy: Policy): Promise<void>;
  findById(id: string): Promise<Policy | null>;
  /** All policies matching a subject (or "*" wildcard). */
  findBySubject(subject: string): Promise<readonly Policy[]>;
  /** All policies matching an action. */
  findByAction(action: string): Promise<readonly Policy[]>;
  /** All policies (for evaluation scans). */
  all(): Promise<readonly Policy[]>;
}

/**
 * MembershipLookup — structural surface the AuthorizationService consumes
 * for organization-membership checks (§4.5). Mirrored from the
 * `/organizations` domain so this port stays self-contained (domain→domain
 * imports are prohibited by the tier allow matrix). The bootstrap wires
 * the concrete MembershipRepository (from organizations) to satisfy this.
 *
 * The lookup returns a minimal membership view (the AuthorizationService
 * only needs to know whether a membership is active).
 */
export interface MembershipLookup {
  /** Returns the membership status (active/revoked) or null if none. */
  membershipStatus(
    personId: string,
    organizationId: string,
  ): Promise<"active" | "revoked" | null>;
}

/**
 * IdentityLookup — structural surface the AuthorizationService consumes
 * for canonical identity existence checks. Mirrored from `/identity`.
 * The bootstrap wires the concrete IdentityRepository to satisfy this.
 */
export interface IdentityLookup {
  exists(personId: string): Promise<boolean>;
}

/**
 * A resolved principal context for authorization. Carries the canonical
 * participant id (if linked), the canonical person identity id, the
 * actor kind, and the execution context the request is scoped to.
 */
export interface ResolvedPrincipal {
  readonly participantId: string | null;
  readonly personId: string | null;
  readonly organizationScopeId: string | null;
  readonly execution: ExecutionContext;
}

/**
 * The decision returned by the AuthorizationService. Deny-by-default:
 * any protected mutation not matched by an allow policy is `deny`
 * (§4.5, API-AC-02).
 */
export interface AuthorizationDecision {
  readonly decision: PolicyEffect;
  readonly reason: string;
  readonly matchedPolicyId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly subject: string;
}

/**
 * Inputs to an authorization check.
 */
export interface AuthorizationRequest {
  readonly principal: ResolvedPrincipal;
  /** The action being authorized (e.g. "organization.membership.grant"). */
  readonly action: string;
  /** The resource being acted on (e.g. an organization id, or "*"). */
  readonly resource: string;
  /**
   * Client-asserted role/scope claims. The AuthorizationService MUST NOT
   * trust these for authorization — it re-resolves effective roles from
   * authoritative server state (§4.5, API-AC-02). They are carried here
   * only so they can be logged/audited when a forged claim is rejected.
   */
  readonly clientClaims?: Readonly<Record<string, unknown>>;
}

/**
 * AuthorizationService — server-side authorization primitives (§4.5, §6).
 *
 * Implements:
 *  - authenticated principal resolution (from a canonical person identity
 *    into a participant context);
 *  - role checks (does the participant hold a v1.0 role?);
 *  - participant scope checks (does the participant act within a scope?);
 *  - organization membership checks (is the person a member of the org?);
 *  - ownership checks (does the participant own the resource?);
 *  - explicit deny-by-default behavior for protected mutations.
 *
 * Authorization MUST be enforced at the server boundary and MUST NOT
 * rely on client-provided role/scope claims without server validation
 * (§4.5, API-AC-02). Client-asserted claims are NEVER trusted — the
 * AuthorizationService re-resolves effective roles from authoritative
 * server state.
 */
export interface AuthorizationService {
  /**
   * Resolve an authenticated canonical person identity into a participant
   * context. The principal is resolved server-side from the canonical
   * identity (NOT from client claims). Returns a principal with
   * `participantId: null` when the person is not yet a participant
   * (authorization will then deny protected mutations).
   */
  resolvePrincipal(
    execution: ExecutionContext,
    personId: string | null,
  ): Promise<ResolvedPrincipal>;

  /** Check whether a participant holds a v1.0 role (server-resolved). */
  hasRole(participantId: string, role: ParticipantRole): Promise<boolean>;

  /** Check organization membership (server-resolved, active only). */
  isOrganizationMember(
    personId: string,
    organizationId: string,
  ): Promise<boolean>;

  /** Check ownership: does the participant own the resource? */
  isOwner(participantId: string, resourceOwnerId: string): Promise<boolean>;

  /**
   * Authorize a request. Deny-by-default: any protected mutation not
   * matched by an allow policy is denied. Client-asserted role/scope
   * claims are NEVER trusted (§4.5, API-AC-02).
   */
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

/**
 * The ParticipantsPort describes the boundary's readiness. After NET-W002
 * it is `"ready"`.
 */
export interface ParticipantsPort {
  readonly boundary: "participants";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly roleAdded: "participant.role_added";
    readonly roleRemoved: "participant.role_removed";
    readonly policyChanged: "authorization.policy_changed";
  };
}

export type { ExecutionContext };
