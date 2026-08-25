/**
 * Deterministic in-memory PrincipalResolver / authenticator (test/dev ONLY).
 *
 * Work order ref: spec/work-orders/NET-W002.md §4.4 (Authentication
 * boundary):
 *   "NET-W002 MUST NOT implement a production external authentication
 *    provider. A deterministic test/in-memory authenticator is permitted
 *    solely for integration/security tests."
 *
 * This is NOT a production auth provider. It maps opaque {@link AuthenticatedSubject}
 * descriptors (produced by some external auth adapter — out of scope here)
 * to canonical identities by delegating to the real {@link IdentityRepository}.
 * It carries NO credentials, NO tokens, NO password hashes. Production
 * external auth providers (OIDC/SAML/JWT) will live in `src/adapters/`
 * as adapter-tier modules in a future work item; they will implement the
 * same {@link PrincipalResolver} interface.
 *
 * Tier compliance: domain tier (identity boundary). Imports only its own
 * port (self, same dir — allowed) and core contracts (allowed). No
 * infrastructure/adapter/other-domain imports.
 */

import type {
  AuthenticatedSubject,
  IdentityRepository,
  PersonIdentity,
  PrincipalResolver,
} from "./port.ts";

export interface InMemoryPrincipalResolverOptions {
  readonly repository: IdentityRepository;
}

/**
 * A deterministic in-memory PrincipalResolver. It resolves an
 * {@link AuthenticatedSubject} to a canonical identity by looking up the
 * subject reference in the {@link IdentityRepository}. Client-asserted
 * role/scope claims (subject.clientClaims) are NEVER trusted for
 * authorization — they are ignored here. The {@link AuthorizationService}
 * re-resolves effective roles from authoritative server state (§4.5).
 */
export function createInMemoryPrincipalResolver(
  opts: InMemoryPrincipalResolverOptions,
): PrincipalResolver {
  const repository = opts.repository;
  const resolver: PrincipalResolver = {
    async resolve(subject: AuthenticatedSubject): Promise<PersonIdentity | null> {
      // The subject carries only an opaque subject reference + optional
      // client-asserted claims. We ignore the claims — authorization is
      // re-resolved server-side by the AuthorizationService.
      return repository.findBySubjectReference(subject.subject);
    },
  };
  return resolver;
}
