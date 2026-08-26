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

/**
 * Credential-shaped key fragment matcher. Any claim key whose name contains
 * one of these fragments is treated as a credential-bearing key and is
 * NEVER emitted to logs/audit — neither the key name NOR its value. The
 * fragment set is deliberately broad (password, token, secret, api key,
 * private key, credential) so a malicious or misbehaving client cannot
 * smuggle credential material past the fingerprint boundary under a
 * synonym (PR #4 remediation: do not log raw clientClaims).
 */
const CREDENTIAL_KEY_FRAGMENTS = [
  "password",
  "token",
  "secret",
  "api-key",
  "apikey",
  "private-key",
  "privatekey",
  "credential",
] as const;

const CREDENTIAL_KEY_RE = new RegExp(
  CREDENTIAL_KEY_FRAGMENTS.map((f) => f.replace(/[-]/g, "[-_]?")).join("|"),
  "i",
);

/**
 * Maximum number of claim keys retained in the fingerprint. Prevents a
 * client from flooding the log surface with thousands of keys (denial-of-
 * observability). Truncated keys are reported as `<truncated>`.
 */
const MAX_CLIENT_CLAIM_KEYS = 16;

/**
 * Produce a privacy-safe fingerprint of the inbound client claims. The
 * fingerprint exposes:
 *  - `clientClaimsPresent` (boolean) — did the client send any claims;
 *  - `clientClaimKeys` (string[]) — a bounded list of the top-level claim
 *    key names, with credential-shaped key names redacted to `<redacted>`
 *    so even the structural indicator that a credential was sent is
 *    suppressed, and capped at MAX_CLIENT_CLAIM_KEYS entries;
 *  - `clientClaimsCount` (number) — total top-level claim count (for
 *    anomaly detection without exposing values).
 *
 * The fingerprint NEVER contains claim values. A credential-shaped key
 * name is itself redacted (not even the key name is exposed) so that ops
 * engineers reading the log cannot infer that a credential was carried.
 * This is the privacy boundary required by PR #4 remediation item #2.
 */
export function safeClaimsFingerprint(
  clientClaims: Readonly<Record<string, unknown>> | undefined,
): {
  readonly clientClaimsPresent: boolean;
  readonly clientClaimKeys: readonly string[];
  readonly clientClaimsCount: number;
} {
  if (!clientClaims || typeof clientClaims !== "object") {
    return { clientClaimsPresent: false, clientClaimKeys: [], clientClaimsCount: 0 };
  }
  const allKeys = Object.keys(clientClaims);
  const count = allKeys.length;
  const visible = allKeys.slice(0, MAX_CLIENT_CLAIM_KEYS).map((k) =>
    CREDENTIAL_KEY_RE.test(k) ? "<redacted>" : k,
  );
  if (count > MAX_CLIENT_CLAIM_KEYS) {
    visible.push("<truncated>");
  }
  return {
    clientClaimsPresent: true,
    clientClaimKeys: visible,
    clientClaimsCount: count,
  };
}

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
      // Privacy boundary (PR #4 remediation): emit only a safe fingerprint
      // of the inbound client claims — NEVER the raw claim object, which
      // may contain tokens, passwords or other credential material.
      const claimsFingerprint = safeClaimsFingerprint(request.clientClaims);

      // 1) Unauthenticated principal → deny (§4.5, API-AC-02).
      if (!principal.personId) {
        logger.warn("authorization.denied_unauthenticated", {
          action: request.action,
          resource: request.resource,
          ...claimsFingerprint,
        });
        return deny(request, "unauthenticated principal", null);
      }

      // 2) Client claims are NEVER trusted. They are NOT recorded in raw
      //    form anywhere in logs/audit; only the safe fingerprint is emitted
      //    when a forged claim is rejected. Authorization decisions are
      //    based exclusively on server-resolved state. (§4.5, API-AC-02.)

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
          ...claimsFingerprint,
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
        ...claimsFingerprint,
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
