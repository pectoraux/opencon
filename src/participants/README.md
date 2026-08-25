# `participants` boundary

**Tier:** domain
**Authority:** participant identity, roles, policies, reputation references and economic accounts
**Architecture ref:** `spec/architecture.md` §18, `spec/architecture-lock.md` §2
**Implemented in:** NET-W002 (v1.0 participant roles, PolicyRepository, server-side AuthorizationService)

## Scope in NET-W002

The participants boundary owns the network-level participant model and
server-side authorization.

It implements:

- **`ParticipantRole`** — the frozen v1.0 roles (PERSON, CREATOR,
  COMPANY, ADVERTISER, PUBLISHER, APP, SUPPLIER, COMMUNITY,
  MEASUREMENT_PROVIDER) (ID-002). A participant MAY hold multiple roles.
  All 9 roles are representable, persistable and independently assignable
  (NET-W002-AC-02).
- **`Participant`** — a person or organization holding one or more v1.0
  roles. One canonical person identity can be a participant holding
  multiple roles across multiple organizations without duplicating the
  underlying identity (NET-W002-AC-01).
- **`ParticipantRepository`** + **`PolicyRepository`** — persistence
  ports. In-memory implementations live here; the authoritative
  PostgreSQL backend is NET-W003 behind the same interface (§4.7).
- **`ParticipantService`** — creates participants, adds/removes roles.
  Role assignment is explicit, auditable and idempotent
  (NET-W002-AC-02, AC-05); material mutations emit
  `participant.role_added` / `participant.role_removed` audit records
  (NET-W002-AC-08).
- **`AuthorizationService`** — server-side authorization primitives
  (§4.5, §6). Implements: authenticated principal resolution; role
  checks; participant scope checks; organization membership checks
  (via `MembershipLookup`); ownership checks; explicit deny-by-default
  for protected mutations. Client-asserted role/scope claims are NEVER
  trusted — the AuthorizationService re-resolves effective roles from
  authoritative server state (§4.5, API-AC-02).

## Cross-domain lookup pattern

The AuthorizationService needs to check organization membership (owned
by `/organizations`) and identity existence (owned by `/identity`). The
tier allow matrix prohibits domain→domain imports, so this port declares
minimal `MembershipLookup` and `IdentityLookup` interfaces. The bootstrap
composition root wires the concrete `MembershipRepository` (from
organizations) and `IdentityRepository` (from identity) to satisfy them
structurally (TypeScript structural typing). This keeps domains decoupled
while letting the AuthorizationService resolve cross-domain facts
server-side.

## Out of scope (§5)

Reputation references and economic accounts remain deferred to later
work items. The AuthorizationService only resolves server-side
identity/role/membership/ownership facts — it does NOT make downstream
authorization decisions for campaigns, contributions, procurement,
benefits or settlement.
