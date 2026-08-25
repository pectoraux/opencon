# Work Order — NET-W002

**Work Item:** NET-W002 — Identity, organizations and participant model  
**Architecture:** v1.0 (FROZEN)  
**Status:** READY_FOR_IMPLEMENTATION  
**Implementation Agent:** Z.ai  
**Architect:** OpenCon Architect  
**Created:** 2026-08-25

## 1. Purpose

Implement the authoritative identity, organization, participant-role and server-side authorization foundation required by Open Contribution Protocol v1.0.

This work establishes who can act, on whose behalf, in which roles, and within which participant/organization scope. It must remain provider-independent and must not implement downstream contribution, campaign, reputation, economic, procurement or benefit behavior.

## 2. Authoritative references

Implementation MUST conform to:

- `spec/architecture.md`
- `spec/architecture-lock.md`
- `spec/requirements.md`
- `spec/work-items.md`
- `spec/dependency-graph.md`
- `spec/work-orders/NET-W001.md`

NET-W001's merged foundation is the implementation baseline. Do not reopen frozen architecture.

## 3. Requirements in scope

- ID-001 — one identity usable across network products
- ID-002 — supported participant roles
- ID-003 — portable network-level reputation identity anchor
- ID-004 — separate reputation dimensions identity anchor
- PRIV-001 — personal activity is not published to a public ledger
- API-002 — server-side authentication, authorization and participant/tenant scoping

Related acceptance criteria:

- API-AC-02 — unauthorized domain mutations rejected server-side

## 4. Scope

### 4.1 Identity model

Implement a provider-neutral identity model with stable identifiers for:

- person/user identities;
- organization identities;
- participant identities;
- role assignments;
- membership relationships between people and organizations.

A single person identity MUST be able to hold multiple roles and participate in multiple organizations without duplicating the underlying identity.

The model MUST distinguish identity from authentication credentials/provider accounts. External auth providers are integration details and are not the canonical identity model.

### 4.2 Organizations and membership

Implement organization records and explicit membership records supporting:

- member status;
- role assignment;
- membership lifecycle;
- organization-scoped authorization;
- actor/member provenance.

Do not implement business-specific organization workflows beyond membership/authorization state.

### 4.3 Participant roles

Support the v1.0 roles:

```text
PERSON
CREATOR
COMPANY
ADVERTISER
PUBLISHER
APP
SUPPLIER
COMMUNITY
MEASUREMENT_PROVIDER
```

A participant MAY have multiple roles.

Role assignment MUST be explicit, auditable and authorization-aware.

### 4.4 Authentication boundary

Define an authentication-provider-neutral interface for resolving an authenticated principal into the canonical network identity.

NET-W002 MUST NOT implement a production external authentication provider.

A deterministic test/in-memory authenticator is permitted solely for integration/security tests.

Credentials, password hashes, OAuth provider secrets and access tokens MUST NOT be stored in domain modules.

### 4.5 Authorization / policy

Implement server-side authorization primitives supporting at minimum:

- authenticated principal resolution;
- role checks;
- participant scope checks;
- organization membership checks;
- ownership checks;
- explicit deny-by-default behavior for protected mutations.

Authorization MUST be enforced at the server boundary and MUST NOT rely on client-provided role/scope claims without server validation.

### 4.6 API integration

Add the minimum API middleware/guarding needed to demonstrate that protected operations cannot be executed by an unauthenticated or unauthorized principal.

Use the execution/correlation context established by NET-W001 to carry actor/subject identity where available.

### 4.7 Persistence

Define explicit persistence ports for identity, organization, membership and participant policy data.

Use the existing persistence boundary established by NET-W001. Do not introduce a second persistence abstraction.

NET-W003 will establish production PostgreSQL authority; NET-W002 MAY use the existing in-memory/test persistence boundary for executable tests provided production persistence remains behind the same interface.

### 4.8 Privacy

Identity records MUST NOT expose credentials or raw private activity data through public protocol responses.

Public-facing identity representations should use stable identifiers and only the minimum metadata required by the endpoint.

### 4.9 Audit

Material identity/authorization mutations MUST be auditable using the audit boundary established by NET-W001.

Examples include:

- organization created;
- membership granted/revoked;
- participant role added/removed;
- authorization policy changed.

Do not add audit event types for future business domains.

## 5. Explicit non-goals

Do NOT implement:

- advertising campaigns;
- inventory;
- creators marketplace behavior;
- helpfulness scoring;
- evidence evaluation;
- attribution;
- reputation algorithms or score changes;
- Participation Credit issuance;
- cash settlement;
- fraud scoring;
- Demand Pools;
- procurement;
- Benefit Pools;
- blockchain/ledger consensus;
- production external authentication providers;
- production external identity providers;
- downstream business authorization policies.

Do not create placeholder implementations that silently authorize downstream domain actions.

## 6. Required interfaces/contracts

At minimum define or extend provider-neutral interfaces for:

```text
IdentityProvider / PrincipalResolver
IdentityRepository
OrganizationRepository
MembershipRepository
ParticipantRepository
AuthorizationService
PolicyRepository
```

Names may differ if they preserve the same responsibilities and remain consistent with the existing module conventions.

External authentication must remain behind an adapter/provider boundary.

## 7. Acceptance criteria

### NET-W002-AC-01 — Unified identity
A single canonical person identity can be associated with multiple organizations and multiple participant roles without creating duplicate canonical identities.

**Evidence:** integration test covering one identity → two memberships → multiple roles.

### NET-W002-AC-02 — Participant roles
All v1.0 participant roles are representable, persistable and independently assignable to a participant.

**Evidence:** domain/persistence test covering the complete role set.

### NET-W002-AC-03 — Server-side authorization
Protected mutations reject unauthenticated and unauthorized principals regardless of client-supplied role/scope claims.

**Evidence:** API/security integration tests with forged client role/scope inputs.

### NET-W002-AC-04 — Organization scoping
A principal cannot access or mutate another organization’s protected participant/membership data unless explicitly authorized by server-side policy.

**Evidence:** multi-organization integration/security test.

### NET-W002-AC-05 — Membership lifecycle
Membership grants, role changes and revocation are deterministic, idempotent and auditable.

**Evidence:** lifecycle tests + audit assertions.

### NET-W002-AC-06 — Authentication boundary
Canonical identity resolution depends on a provider-neutral authentication interface; no production authentication provider is coupled into domain code.

**Evidence:** static architecture test + adapter contract test.

### NET-W002-AC-07 — Privacy boundary
Protected identity data and credentials are never returned by public identity endpoints, and no raw personal activity is persisted as public-ledger data.

**Evidence:** API contract/security tests + static inspection.

### NET-W002-AC-08 — Audit lineage
Material identity and authorization mutations emit append-oriented audit records with actor, subject, resource and execution/correlation identifiers.

**Evidence:** integration test against the NET-W001 audit boundary.

## 8. Verification requirements

Z.ai MUST provide:

1. complete automated test output;
2. API/security integration evidence;
3. multi-organization authorization evidence;
4. authentication adapter/static dependency evidence;
5. persistence contract evidence;
6. audit lineage evidence;
7. changed-files summary mapped to each acceptance criterion;
8. confirmation that no downstream domain/economic behavior was introduced.

All evidence must be reproducible from the repository checkout.

## 9. Implementation constraints

- Follow frozen Architecture v1.0 exactly.
- Preserve all NET-W001 architecture enforcement rules.
- Reuse the existing core execution/correlation, logging, audit, API and module contracts where applicable.
- Do not bypass the persistence boundary.
- Do not couple domain code directly to an authentication provider.
- Do not place secrets or credentials in identity-domain models.
- Do not implement downstream authorization decisions that belong to campaigns, contributions, procurement, benefits or settlement.
- Any architectural contradiction MUST be escalated as an Architecture Change Request.

## 10. PR requirements

Z.ai must create exactly one implementation PR for NET-W002.

The PR description MUST include:

```text
Work Item: NET-W002
Architecture: v1.0
Requirements: ID-001..004, PRIV-001, API-002
Acceptance Criteria: NET-W002-AC-01..08
Verification: <commands/results>
Out of Scope: <confirmation>
```

Review is based on repository state and reproducible evidence.

## 11. Completion state

The Work Item may move to verification only when:

- all acceptance criteria have objective evidence;
- required tests pass;
- architecture/static checks pass;
- the implementation PR exists and is the single active PR for NET-W002;
- frozen architecture files remain unchanged;
- no downstream domain behavior is introduced.

Architect review determines whether the item is approved, changes requested, or escalated for architecture change.
