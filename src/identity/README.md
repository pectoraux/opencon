# `identity` boundary

**Tier:** domain
**Authority:** identity, roles and eligibility
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), `spec/architecture-lock.md` §2 (core domain)
**Implemented in:** NET-W002 (provider-neutral identity model, PrincipalResolver auth boundary)

## Scope in NET-W002

The identity boundary establishes the canonical, provider-neutral person
identity model and the authentication-boundary interface required by
OpenCon v1.0.

It implements:

- **`PersonIdentity`** — the canonical identity (stable opaque id, display
  name, subject references linking to external auth subjects, optional
  reputation anchors). One identity is usable across all network products
  (ID-001) and may hold multiple roles across multiple organizations
  without duplication (NET-W002-AC-01).
- **`PrincipalResolver`** + **`AuthenticatedSubject`** — the
  provider-neutral authentication-boundary interface (§4.4). The resolver
  accepts an opaque authenticated-subject descriptor (NO credential
  material — no token, no password) and returns the canonical identity.
  NET-W002 ships a deterministic in-memory resolver for integration/
  security tests; production external auth providers (OIDC/SAML/JWT) will
  live as adapter-tier modules in `src/adapters/` in a future work item,
  implementing the same interface.
- **`IdentityRepository`** — the persistence port. A concrete in-memory
  implementation lives here for executable tests; the authoritative
  PostgreSQL backend is NET-W003 behind the same interface (§4.7).
- **`IdentityService`** — the domain service. It creates/fetches identities,
  enforces the privacy boundary, and emits audit lineage
  (`identity.person_created`) with actor/subject/resource/execution+correlation
  identifiers (NET-W002-AC-08).
- **`PublicIdentityView`** — the privacy-safe public representation
  (stable id + display name only). Public endpoints return this, never
  the full identity record (PRIV-001, NET-W002-AC-07).

## Privacy boundary

The identity model carries **NO credentials** — no password hashes, no
OAuth tokens, no access tokens, no refresh tokens (§4.4, §4.8). External
auth provider accounts are modelled as opaque `SubjectReference`s (stable
handles resolved by the `PrincipalResolver`). `IdentityService` rejects
any input carrying credential-shaped field names (`password*`, `*token*`,
`apiKey`, `privateKey`, …) with `SecretAccessError`.

## Dependencies

The identity boundary imports only:
- `src/core/*` (contracts: `ExecutionContext`, `AuditWriter`, `Logger`,
  `OpenConError` subclasses, `randomUUID`) — allowed (core importable by all);
- its own `port.ts` — allowed (self, same dir).

It does NOT import infrastructure (config/audit-writer/persistence/queues),
adapters, or any other domain — that would violate the tier allow matrix
enforced by `scripts/check-architecture.ts` (NET-W001-AC-02).

The concrete `AuditWriter` and `IdentityRepository` are injected by the
bootstrap composition root (the only place permitted to import concrete
implementations for wiring).
