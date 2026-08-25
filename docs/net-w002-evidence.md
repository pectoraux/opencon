# NET-W002 — Evidence

**Work Item:** NET-W002 — Identity, organizations and participant model  
**Architecture:** v1.0 (FROZEN)  
**Requirements:** ID-001..004, PRIV-001, API-002  
**Acceptance Criteria:** NET-W002-AC-01..08

All evidence is reproducible from a clean repository checkout via
`bun install && bun run verify`.

## 1. Verification commands

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies (zod) |
| `bun run typecheck` | TypeScript strict typecheck |
| `bun run arch:check` | Deterministic architecture/dependency check |
| `bun test` | Full automated test suite (16 files, 96 tests) |
| `bun run verify` | typecheck + arch:check + tests (canonical evidence command) |

The same pipeline is enforced in CI by `.github/workflows/ci.yml`
(inherited from NET-W001), so the architecture/dependency checks and
the test suite both gate every push and PR targeting `main`.

## 2. Verification results (reproduced)

```
$ bun run verify
$ tsc --noEmit                       # typecheck: PASS (exit 0)
$ bun scripts/check-architecture.ts  # ✓ 136 files scanned, 0 violations (exit 0)
$ bun test                           # 96 pass, 0 fail, 757 expect() calls, 16 files (exit 0)
```

Test breakdown:
- NET-W001 suites (unchanged, still pass): 52 tests across 8 files
- NET-W002 suites (new): 44 tests across 8 files
  - tests/identity/net-w002-ac-01-unified-identity.test.ts (2 tests)
  - tests/participants/net-w002-ac-02-participant-roles.test.ts (6 tests)
  - tests/api/net-w002-ac-03-server-side-authorization.test.ts (6 tests)
  - tests/organizations/net-w002-ac-04-organization-scoping.test.ts (3 tests)
  - tests/organizations/net-w002-ac-05-membership-lifecycle.test.ts (6 tests)
  - tests/identity/net-w002-ac-06-authentication-boundary.test.ts (7 tests)
  - tests/identity/net-w002-ac-07-privacy-boundary.test.ts (8 tests)
  - tests/audit/net-w002-ac-08-audit-lineage.test.ts (5 tests)
- NET-W001-AC-08 regression updated (split into skeleton + NET-W002-non-
  skeleton assertions; forbidden-pattern check now covers all 16 domains
  including the 3 NET-W002 domains; 6 tests, still pass)

## 3. Changed-files summary mapped to acceptance criteria

### NET-W002-AC-01 — Unified identity (PASS)
- `src/identity/port.ts` — `PersonIdentity` (stable canonical id, display
  name, opaque `subjectReferences`, optional `reputationAnchors` — NO
  credentials); `SubjectReference`; `CreatePersonIdentityInput`;
  `IdentityRepository` (save/findById/findBySubjectReference/exists).
- `src/identity/in-memory-identity-repository.ts` — in-memory repo;
  one-subject→one-identity invariant (ConflictError on duplicate subject).
- `src/identity/identity-service.ts` — `createIdentity`, `resolve`
  (PrincipalResolver contract).
- `tests/identity/net-w002-ac-01-unified-identity.test.ts` — one identity →
  two memberships → multiple roles; duplicate-subject rejection.

### NET-W002-AC-02 — Participant roles (PASS)
- `src/participants/port.ts` — `ParticipantRole` union (the 9 v1.0
  roles); `PARTICIPANT_ROLES` exported; `Participant`; `ParticipantRepository`;
  `CreateParticipantInput`/`AddParticipantRoleInput`/`RemoveParticipantRoleInput`.
- `src/participants/participant-service.ts` — `createParticipant`,
  `addRole` (idempotent + audited), `removeRole` (idempotent + audited),
  `hasRole`, `resolveByReference`.
- `tests/participants/net-w002-ac-02-participant-roles.test.ts` — all 9
  roles representable + independently assignable; multiple roles
  simultaneously; independent removal; invalid role rejected; organizations
  can hold roles too.

### NET-W002-AC-03 — Server-side authorization (PASS)
- `src/participants/authorization-service.ts` — `AuthorizationService`
  (resolvePrincipal, hasRole, isOrganizationMember, isOwner, authorize);
  deny-by-default; client claims NEVER trusted (§4.5, API-AC-02).
- `src/api/port.ts` — `ApiAuth` + `ApiCommands` interfaces (infrastructure
  contract; the API server consumes these and never imports domain ports).
- `src/api/server.ts` — `guardMutation()` helper: resolve auth subject →
  authorize → 403 on deny; protected endpoints `POST /api/identities`,
  `POST /api/organizations`, `POST /api/organizations/:id/memberships`,
  `DELETE /api/organizations/:id/memberships/:membershipId`.
- `src/bootstrap/runtime.ts` — `apiAuth` + `apiCommands` adapters (dependency
  inversion: bridges API server to real PrincipalResolver + AuthorizationService
  + domain services).
- `tests/api/net-w002-ac-03-server-side-authorization.test.ts` — unauthenticated
  → 403; forged ADMIN client-claims → 403 (no allow policy); explicit DENY
  policy → 403 (matched); matching ALLOW policy → 201; forged claims do NOT
  elevate; correlation+execution IDs propagate.

### NET-W002-AC-04 — Organization scoping (PASS)
- `src/participants/port.ts` — `MembershipLookup` interface (structural
  surface the AuthorizationService consumes for org-membership checks);
  `policyMatches()` evaluates `resource` against the target org id or
  `principal.organizationScopeId`.
- `src/organizations/port.ts` — `Membership` (personId, organizationId,
  status, lifecycle provenance); `MembershipRepository`; `MembershipLookup`.
- `src/bootstrap/runtime.ts` — `membershipLookup` adapter wires the
  organizations `MembershipRepository` into the participants
  `AuthorizationService` (cross-domain, dependency-inverted).
- `tests/organizations/net-w002-ac-04-organization-scoping.test.ts` —
  cross-org mutation rejected (allow policy scoped to orgA only);
  scoped allow works for the right org; wildcard still requires
  authentication.

### NET-W002-AC-05 — Membership lifecycle (PASS)
- `src/organizations/organization-service.ts` — `MembershipService`:
  `grantMembership` (idempotent: re-grant active → no-op, no audit spam;
  re-grant revoked → ConflictError, revoked is terminal), `revokeMembership`
  (idempotent: re-revoke → no-op), `getMembership`, `listForOrganization`,
  `listForPerson`.
- `tests/organizations/net-w002-ac-05-membership-lifecycle.test.ts` —
  grant idempotent; revoke idempotent; NotFoundError on unknown; revoked
  is terminal (ConflictError on re-grant); grant+revoke emit audit with
  actor/subject/resource/IDs; role add/remove idempotent + audited.

### NET-W002-AC-06 — Authentication boundary (PASS)
- `src/identity/port.ts` — `PrincipalResolver` interface (provider-neutral);
  `AuthenticatedSubject` (opaque subject ref + provider kind + optional
  clientClaims — NO credentials).
- `src/identity/in-memory-principal-resolver.ts` — deterministic in-memory
  resolver (clearly marked "NOT a production auth provider"; "test/dev ONLY"
  per §4.4).
- `tests/identity/net-w002-ac-06-authentication-boundary.test.ts` —
  static: port declares PrincipalResolver + AuthenticatedSubject; no
  domain file imports an external auth SDK (openid-client/passport/jose/
  jsonwebtoken/@auth0/next-auth/firebase-admin/...); in-memory resolver
  marked as test/dev; architecture check passes. Contract: resolver
  resolves an AuthenticatedSubject to canonical identity; returns null
  for unlinked subjects; rejects credential-bearing inputs.

### NET-W002-AC-07 — Privacy boundary (PASS)
- `src/identity/port.ts` — `PublicIdentityView` (stable id + display name
  ONLY); `PersonIdentity` has NO credential fields.
- `src/identity/identity-service.ts` — `assertNoCredentialMaterial`
  recursively scans input + subjectReferences + clientClaims for
  credential-shaped field names (password*, *token*, apiKey, privateKey)
  and throws `SecretAccessError`; `getPublicView` returns ONLY the
  PublicIdentityView shape.
- `tests/identity/net-w002-ac-07-privacy-boundary.test.ts` — static:
  PersonIdentity has no credential fields; PublicIdentityView exposes
  only id+displayName; no identity-domain file declares credential
  fields; no raw-activity fields (browsingHistory/clickStream/location/
  deviceFingerprint) in identity/org ports. Contract: public endpoint
  returns only id+displayName; 404 for unknown id; credential-bearing
  input rejected (SecretAccessError); credential-bearing clientClaims
  rejected; no raw personal activity persisted.

### NET-W002-AC-08 — Audit lineage (PASS)
- `src/identity/identity-service.ts` — emits `identity.person_created`
  with actor/subject/resourceType=identity/resourceId/correlationId/
  executionId.
- `src/organizations/organization-service.ts` — emits
  `organization.created`, `organization.membership_granted`,
  `organization.membership_revoked`.
- `src/participants/participant-service.ts` — emits
  `participant.role_added`, `participant.role_removed`.
- `src/participants/policy-service.ts` — emits
  `authorization.policy_changed`.
- All audit records reuse the NET-W001 `AuditWriter` (deeply-frozen,
  append-only — the NET-W001-AC-06 deep immutability is preserved).
- `tests/audit/net-w002-ac-08-audit-lineage.test.ts` — identity creation
  emits audit with full lineage; org+membership grant/revoke each emit
  audit; role add/remove + policy change each emit audit; audit records
  are deeply immutable (NET-W001 boundary preserved); stable unique event
  ids.

## 4. Out-of-scope confirmation

Per work order §5 (explicit non-goals), this work item introduces NONE of:

- advertising campaigns; inventory; creators marketplace behavior;
  helpfulness scoring; evidence evaluation; attribution; reputation
  algorithms or score changes; Participation Credit issuance; cash
  settlement; fraud scoring; Demand Pools; procurement; Benefit Pools;
  blockchain/ledger consensus; production external authentication
  providers; production external identity providers; downstream business
  authorization policies.

No placeholder implementation silently authorizes downstream domain
actions. The AuthorizationService only resolves server-side identity/
role/membership/ownership facts — it does NOT make downstream
authorization decisions for campaigns, contributions, procurement,
benefits or settlement (§5). The deterministic in-memory PrincipalResolver
is clearly marked "NOT a production auth provider" and is permitted
solely for integration/security tests (§4.4).

The frozen architecture (`spec/architecture.md`, `spec/architecture-lock.md`)
is unchanged. No secrets or credentials are committed. The NET-W001-AC-08
regression test was updated to reflect the NET-W002 scope (identity/
organizations/participants are no longer skeletons) while keeping the
forbidden-pattern check, the architecture check, and the frozen-spec
checks intact for all 16 domains.

## 5. Single PR

Exactly one implementation PR is created for NET-W002 (see PR description
for the required format).
