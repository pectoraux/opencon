/**
 * Api boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership): `/api`
 *   authority: "external application/API contract" (versioned,
 *   provider-independent).
 * Architecture ref: spec/architecture-lock.md §2 (infrastructure boundary).
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.6 API integration: "Add the minimum API middleware/guarding needed
 *      to demonstrate that protected operations cannot be executed by an
 *      unauthenticated or unauthorized principal. Use the execution/
 *      correlation context established by NET-W001 to carry actor/subject
 *      identity where available."
 *   §4.5 Authorization: server-side authorization enforced at the server
 *      boundary; client-provided role/scope claims not trusted.
 *
 * CROSS-BOUNDARY NOTE: the `/api` boundary is infrastructure tier. The
 * tier allow matrix (scripts/lib/architecture.ts) PROHIBITS infrastructure
 * → domain imports. The API server therefore CANNOT import the identity
 * or participants domain ports directly. Instead this port declares a
 * minimal {@link ApiAuth} interface that the API server consumes; the
 * bootstrap composition root wires a thin adapter that delegates to the
 * real `PrincipalResolver` (identity) and `AuthorizationService`
 * (participants). Dependency inversion at the composition root.
 *
 * The {@link ApiAuth} interface deliberately uses only primitive shapes
 * (strings + a decision union) so it carries no domain DTO coupling. The
 * adapter in bootstrap translates between these primitives and the domain
 * DTOs (ResolvedPrincipal, AuthorizationDecision, PersonIdentity).
 */

import type { ExecutionContext } from "../core/execution-context.ts";

/**
 * The ApiPort describes the boundary's readiness. After NET-W002 it is
 * `"ready"` (the boundary now carries protected endpoints + auth guard).
 */
export interface ApiPort {
  readonly boundary: "api";
  readonly readiness: "ready";
}

/**
 * An opaque auth subject extracted from the request (e.g. from headers).
 * Carries NO credential material — only the resolved subject id + provider
 * kind + any client-asserted claims. Client claims are NEVER trusted for
 * authorization (§4.5, API-AC-02); they are carried only so they can be
 * logged/audited when a forged claim is rejected.
 */
export interface ApiAuthSubject {
  readonly subjectId: string;
  readonly providerKind: string;
  readonly clientClaims?: Readonly<Record<string, unknown>>;
}

/**
 * The result of resolving an auth subject into a canonical person identity.
 * `personId` is null when the subject is not linked to any canonical
 * identity (unauthenticated).
 */
export interface ApiResolvedPrincipal {
  readonly personId: string | null;
}

/**
 * The authorization decision returned by the API auth guard. Deny-by-
 * default: any protected mutation not matched by an allow policy is
 * denied (§4.5, API-AC-02).
 */
export interface ApiAuthDecision {
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly matchedPolicyId: string | null;
}

/**
 * Inputs to an API authorization check.
 */
export interface ApiAuthorizeRequest {
  readonly execution: ExecutionContext;
  readonly personId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly clientClaims?: Readonly<Record<string, unknown>>;
}

/**
 * ApiAuth — the minimal auth surface the API server consumes. The
 * bootstrap composition root wires a thin adapter that delegates to the
 * real identity PrincipalResolver + participants AuthorizationService.
 */
export interface ApiAuth {
  /** Resolve an auth subject into a canonical person id (server-side). */
  resolvePrincipal(subject: ApiAuthSubject): Promise<ApiResolvedPrincipal>;
  /** Authorize a protected mutation (deny-by-default). */
  authorize(request: ApiAuthorizeRequest): Promise<ApiAuthDecision>;
}

/** The public view of an identity returned by public read endpoints. */
export interface ApiPublicIdentityView {
  readonly id: string;
  readonly displayName: string;
}

/** The public view of an organization returned by endpoints. */
export interface ApiOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Inputs to create an organization via the API. */
export interface ApiCreateOrganizationInput {
  readonly name: string;
}

/** The membership view returned by the API. */
export interface ApiMembershipView {
  readonly id: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly status: "active" | "revoked";
  readonly grantedAt: string;
  readonly grantedBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
}

/** Inputs to grant a membership via the API. */
export interface ApiGrantMembershipInput {
  readonly personId: string;
}

/**
 * ApiCommands — the protected mutation surface the API server consumes
 * (after the {@link ApiAuth} guard has authorized the request). The
 * bootstrap composition root wires a thin adapter that delegates to the
 * real domain services (IdentityService, OrganizationService,
 * MembershipService, ParticipantService). The API server never imports
 * the domain ports directly (infrastructure→domain is prohibited by the
 * tier allow matrix).
 *
 * Every method here corresponds to a protected mutation that has ALREADY
 * been authorized by the {@link ApiAuth.authorize} guard before the
 * command is invoked. The adapter is the dependency-inversion seam.
 */
export interface ApiCommands {
  /** Create a canonical person identity. Returns the public view. */
  createIdentity(
    execution: ExecutionContext,
    input: { readonly displayName: string; readonly subjectId: string; readonly providerKind: string },
  ): Promise<ApiPublicIdentityView>;

  /** Fetch the public view of an identity (privacy-safe — PRIV-001, AC-07). */
  getPublicIdentity(execution: ExecutionContext, id: string): Promise<ApiPublicIdentityView | null>;

  /** Create an organization (protected mutation). */
  createOrganization(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateOrganizationInput,
  ): Promise<ApiOrganizationView>;

  /** Grant a membership in an organization (protected mutation). */
  grantMembership(
    execution: ExecutionContext,
    actorPersonId: string,
    organizationId: string,
    input: ApiGrantMembershipInput,
  ): Promise<{ membership: ApiMembershipView; created: boolean }>;

  /** Revoke a membership (protected mutation). */
  revokeMembership(
    execution: ExecutionContext,
    actorPersonId: string,
    membershipId: string,
  ): Promise<{ membership: ApiMembershipView; already: boolean }>;
}

export type { ExecutionContext };
