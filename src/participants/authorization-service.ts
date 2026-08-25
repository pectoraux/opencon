/**
 * AuthorizationService — server-side authorization primitives.
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.5 Authorization / policy: server-side authorization primitives
 *      supporting at minimum: authenticated principal resolution; role
 *      checks; participant scope checks; organization membership checks;
 *      ownership checks; explicit deny-by-default behavior for protected
 *      mutations. Authorization MUST be enforced at the server boundary
 *      and MUST NOT rely on client-provided role/scope claims without
 *      server validation (API-AC-02).
 *   §4.6 API integration: minimum middleware/guarding so protected
 *      operations reject unauthenticated/unauthorized principals.
 *
 * Deny-by-default (§4.5, API-AC-02): any protected mutation not matched
 * by an allow policy is denied. Deny policies override allow policies.
 * Client-asserted role/scope claims (request.clientClaims) are NEVER
 * trusted — the AuthorizationService re-resolves effective roles from
 * authoritative server state (ParticipantRepository). Forged client
 * claims are rejected (and may be audited/logged).
 *
 * The AuthorizationService consumes:
 *  - ParticipantRepository (same domain — direct dependency);
 *  - PolicyRepository (same domain — direct dependency);
 *  - MembershipLookup (structural interface mirrored here; the concrete
 *    MembershipRepository from organizations is wired by bootstrap to
 *    satisfy it);
 *  - IdentityLookup (structural interface mirrored here; the concrete
 *    IdentityRepository from identity is wired by bootstrap to satisfy it).
 *
 * Tier compliance: domain tier (participants boundary). Imports only its
 * own port (self, same dir — allowed) and core (ExecutionContext, Logger,
 * OpenConError subclasses — allowed). No infrastructure/adapter/other-
 * domain imports.
 *
 * Out of scope (§5): no downstream authorization decisions for campaigns,
 * contributions, procurement, benefits or settlement. The AuthorizationService
 * only resolves server-side identity/role/membership/ownership facts.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import { AuthorizationError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationService,
  IdentityLookup,
  MembershipLookup,
  Participant,
  ParticipantRepository,
  ParticipantRole,
  Policy,
  PolicyRepository,
  ResolvedPrincipal,
} from "./port.ts";

export interface AuthorizationServiceDeps {
  readonly participants: ParticipantRepository;
  readonly policies: PolicyRepository;
  readonly membershipLookup: MembershipLookup;
  readonly identityLookup: IdentityLookup;
  readonly logger: Logger;
}

const ALLOW = "allow" as const;
const DENY = "deny" as const;

export function createAuthorizationService(
  deps: AuthorizationServiceDeps,
): AuthorizationService {
  const { participants, policies, membershipLookup, identityLookup, logger } = deps;

  function deny(
    request: AuthorizationRequest,
    reason: string,
    matchedPolicyId: string | null,
  ): AuthorizationDecision {
    return {
      decision: DENY,
      reason,
      matchedPolicyId,
      action: request.action,
      resource: request.resource,
      subject: request.principal.participantId ?? request.principal.personId ?? "<anonymous>",
    };
  }

  function allow(
    request: AuthorizationRequest,
    reason: string,
    matchedPolicyId: string | null,
  ): AuthorizationDecision {
    return {
      decision: ALLOW,
      reason,
      matchedPolicyId,
      action: request.action,
      resource: request.resource,
      subject: request.principal.participantId ?? request.principal.personId ?? "<anonymous>",
    };
  }

  const service: AuthorizationService = {
    async resolvePrincipal(execution, personId) {
      // Resolve the participant context server-side from the canonical
      // person identity. NEVER trust client claims.
      if (!personId) {
        return {
          participantId: null,
          personId: null,
          organizationScopeId: null,
          execution,
        };
      }
      const participant = await participants.findByReference(personId);
      return {
        participantId: participant?.id ?? null,
        personId,
        organizationScopeId: participant?.organizationScopeId ?? null,
        execution,
      };
    },

    async hasRole(participantId, role: ParticipantRole) {
      const p: Participant | null = await participants.findById(participantId);
      if (!p) return false;
      return p.roles.includes(role);
    },

    async isOrganizationMember(personId, organizationId) {
      const status = await membershipLookup.membershipStatus(personId, organizationId);
      return status === "active";
    },

    async isOwner(participantId, resourceOwnerId) {
      // Ownership check: does the participant's canonical reference own
      // the resource? For NET-W002 the "owner" is the identity that
      // created the resource (resourceOwnerId). The participant's
      // referenceId is the canonical person identity id.
      const p = await participants.findById(participantId);
      if (!p) return false;
      return p.referenceId === resourceOwnerId;
    },

    async authorize(request) {
      const principal = request.principal;

      // 1) Unauthenticated principal → deny (§4.5, API-AC-02).
      if (!principal.personId) {
        logger.warn("authorization.denied_unauthenticated", {
          action: request.action,
          resource: request.resource,
          clientClaims: request.clientClaims,
        });
        return deny(request, "unauthenticated principal", null);
      }

      // 2) Client claims are NEVER trusted. They are recorded for audit
      //    only when a forged claim is rejected, but authorization
      //    decisions are based exclusively on server-resolved state.
      //    (No assertion on clientClaims here — they are simply ignored
      //    for the decision. This is the core invariant of §4.5/API-AC-02.)

      // 3) Evaluate policies in policy-order. Deny policies override
      //    allow policies. Deny-by-default if no allow policy matches.
      const all = await policies.all();
      let allowMatch: Policy | null = null;
      let denyMatch: Policy | null = null;
      for (const p of all) {
        if (!policyMatches(p, request, principal)) continue;
        if (p.effect === "deny") {
          denyMatch = p;
          // Deny short-circuits: deny overrides any allow.
          break;
        }
        if (p.effect === "allow" && !allowMatch) {
          allowMatch = p;
        }
      }

      if (denyMatch) {
        logger.warn("authorization.denied_policy", {
          action: request.action,
          resource: request.resource,
          policyId: denyMatch.id,
          clientClaims: request.clientClaims,
        });
        return deny(request, "explicit deny policy", denyMatch.id);
      }

      if (allowMatch) {
        logger.debug("authorization.allowed_policy", {
          action: request.action,
          resource: request.resource,
          policyId: allowMatch.id,
        });
        return allow(request, "allow policy matched", allowMatch.id);
      }

      // 4) No policy matched → deny-by-default (§4.5, API-AC-02).
      logger.warn("authorization.denied_default", {
        action: request.action,
        resource: request.resource,
        personId: principal.personId,
        participantId: principal.participantId,
        clientClaims: request.clientClaims,
      });
      return deny(request, "no allow policy matched (deny-by-default)", null);
    },
  };

  return service;
}

/**
 * A policy matches a request when:
 *  - subject: policy.subject === "*" OR policy.subject === principal.participantId
 *    OR policy.subject === principal.personId;
 *  - action: policy.action === request.action (exact match; no wildcards);
 *  - resource: policy.resource === "*" OR policy.resource === request.resource
 *    OR policy.resource === principal.organizationScopeId.
 */
function policyMatches(
  policy: Policy,
  request: AuthorizationRequest,
  principal: ResolvedPrincipal,
): boolean {
  const subjectMatch =
    policy.subject === "*" ||
    policy.subject === principal.participantId ||
    policy.subject === principal.personId;
  if (!subjectMatch) return false;
  const actionMatch = policy.action === request.action;
  if (!actionMatch) return false;
  const resourceMatch =
    policy.resource === "*" ||
    policy.resource === request.resource ||
    (principal.organizationScopeId !== null &&
      policy.resource === principal.organizationScopeId);
  return resourceMatch;
}

/**
 * Convenience helper: throw AuthorizationError when a decision is deny.
 * Used by API boundary guards and domain services.
 */
export function assertAuthorized(decision: AuthorizationDecision): void {
  if (decision.decision !== "allow") {
    throw new AuthorizationError(
      `authorization denied: ${decision.action} on ${decision.resource} — ${decision.reason}`,
      {
        action: decision.action,
        resource: decision.resource,
        subject: decision.subject,
        reason: decision.reason,
        matchedPolicyId: decision.matchedPolicyId,
      },
    );
  }
}

export { AuthorizationError, OpenConError };
