# Implementation Notes — NET-W001

**Architecture:** v1.0 (FROZEN)  
**Work item:** NET-W001 — Platform and modular-monolith foundation

## 1. Technology choices (recorded per work order §4.1)

The work order permits framework selection where it does not conflict
with the frozen architecture. All choices are recorded here.

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5 (strict) | Required by work order §1 ("TypeScript modular monolith") |
| Runtime / package manager | Bun ≥1.3 | Runs TypeScript natively; built-in test runner; fast; available in the dev environment |
| Test runner | `bun test` (`bun:test`) | Built-in, zero-config; deterministic; reproducible from checkout |
| Configuration validation | `zod` | Typed schemas, classified errors, safe defaults, fail-fast |
| HTTP server | Node built-in `node:http` | Zero framework coupling; sufficient for health/readiness/liveness + representative request (§4.6) |
| Identifiers | `node:crypto.randomUUID()` | Standard, dependency-free |
| Context propagation | `node:async_hooks` (`AsyncLocalStorage`) | Standard execution-context propagation across HTTP and worker scopes |
| Architecture enforcement | Custom deterministic import scanner (`scripts/lib/architecture.ts`) | No AST dependency; fully reproducible; enforces the tier allow matrix (§4.8) |

No other external runtime dependencies are introduced. The dependency
footprint is intentionally minimal (only `zod`) to maximize
reproducibility and audit surface.

## 2. What is implemented in NET-W001

- **Module boundaries:** all 16 domain + 9 infrastructure + 6 external
  integration directories exist with documented `port.ts`, `module.ts`,
  `index.ts`, `README.md` (AC-01).
- **Core contracts:** `Module`, `ModuleRegistry`, `ExecutionContext`,
  `Logger`, `ConfigurationProvider`, `JobQueue`, `JobHandler`,
  `AuditWriter`, `ObjectStore`, `SecretProvider`, `ProviderAdapter`
  (plus error taxonomy) in `src/core/`.
- **Configuration:** typed, validated, fail-fast, with safe development
  defaults and required-secret enforcement in non-development
  environments. Snapshot is frozen (immutable) for process lifetime.
  Secrets boundary: `ConfigurationProvider.get()` throws
  `SecretAccessError` (classification `invariant`) for any classified
  secret key — secret material is NEVER returned through the config
  provider. `getSecretReference()` returns an opaque `SecretReference`
  (`key` + redacted diagnostics, never the value); the value is
  resolved exclusively by the `SecretProvider` at the infrastructure
  boundary. This closes the boundary leak where secrets could previously
  be retrieved via `get()` / `getSecretReference()`.
- **Execution/correlation context:** propagates across HTTP (via
  `X-Correlation-Id`/`X-Causation-Id` headers and AsyncLocalStorage) and
  worker execution (via `deriveExecutionContext`).
- **Worker boundary:** in-memory `JobQueue` with durable job identity,
  idempotency keys, retry policy, dead-letter, and requeue. Worker loop
  with a non-domain ECHO handler for demonstration.
- **Structured logging:** JSON in non-development, pretty text in
  development, always stamped with execution+correlation IDs, level,
  module/component, and classified errors.
- **Health/readiness/liveness:** `/health`, `/ready`, `/live`.
- **Audit foundation:** append-only `AuditWriter` (in-memory + file
  backed). Entries are DEEPLY frozen — the event object, its metadata,
  and every nested object/array reachable through it are recursively
  immutable (deep freeze via `structuredClone` + `deepFreeze`), so
  callers cannot mutate prior entries, including nested metadata. The
  caller's own input metadata is cloned, never frozen in place.
- **Architecture enforcement:** deterministic import scanner enforcing
  dependency direction and adapter isolation; an intentional failing
  fixture proves it fires. Enforced in CI via `.github/workflows/ci.yml`
  (runs `typecheck` + `arch:check` + `bun test` on every push and PR
  targeting `main`), satisfying NET-W001 §4.8 ("must be enforceable in CI").

## 3. What is deliberately NOT implemented (out of scope per §5)

- No user authentication/authorization business rules.
- No identity persistence beyond skeleton contracts.
- No campaigns, inventory, creator profiles, helpfulness, evidence
  evaluation, attribution, reputation algorithms, Participation
  Credit issuance, cash settlement, fraud models, Demand Pools,
  procurement, Benefit Pools, blockchain/ledger consensus, external
  platform integrations, or production AI routing.
- No concrete PostgreSQL/Redis/object-storage backends (NET-W003).
- No domain-specific worker jobs (deferred).
- No placeholder implementations that silently make domain decisions.

## 4. Composition root

`src/bootstrap/runtime.ts` is the single composition root. It is the
only location permitted by the architecture check to import concrete
adapter/provider implementations for wiring (tier `bootstrap`).
`src/server.ts` is the process entry point; it loads configuration
(fail-fast), initializes the module registry, starts the worker loop
and HTTP API, and handles graceful shutdown (SIGINT/SIGTERM).

## 5. Reproducibility

From a clean checkout:

```bash
bun install
bun run verify          # typecheck + architecture check + tests
bun run arch:check      # architecture check only
bun test                # tests only
bun run dev             # start the server (development)
```

`bun run verify` is the canonical evidence command.

---

## 6. NET-W002 additions (identity, organizations, participant model)

**Work item:** NET-W002 — Identity, organizations and participant model.

### What is implemented in NET-W002

- **Identity boundary** (`src/identity/`):
  - `port.ts` — `PersonIdentity` (stable canonical id, display name, opaque
    `subjectReferences`, optional `reputationAnchors` — NO credentials);
    `SubjectReference`; `AuthenticatedSubject`; `PrincipalResolver`
    (provider-neutral auth-boundary interface); `PublicIdentityView`
    (privacy-safe public representation); `IdentityRepository`;
    `CreatePersonIdentityInput`.
  - `in-memory-identity-repository.ts` — in-memory repo; one-subject→one-
    identity invariant (ConflictError on duplicate subject link).
  - `identity-service.ts` — `createIdentity`, `getIdentity`, `getPublicView`
    (returns ONLY id + displayName), `resolve` (PrincipalResolver contract).
    `assertNoCredentialMaterial` recursively scans inputs + subjectReferences
    + clientClaims for credential-shaped field names and throws
    `SecretAccessError` (PRIV-001, §4.4, §4.8).
  - `in-memory-principal-resolver.ts` — deterministic in-memory
    PrincipalResolver, clearly marked "NOT a production auth provider;
    test/dev ONLY" (§4.4). Production external auth providers (OIDC/SAML/
    JWT) will be adapters in `src/adapters/` in a future work item.
- **Organizations boundary** (`src/organizations/`):
  - `port.ts` — `Organization`; `Membership` (lifecycle status
    active/revoked + `grantedBy`/`grantedAt` + `revokedBy`/`revokedAt`
    provenance); `OrganizationRepository`; `MembershipRepository`;
    `CreateOrganizationInput`; `GrantMembershipInput`.
  - `in-memory-organization-repository.ts` — in-memory org + membership
    repos (membership re-save updates lifecycle; idempotent re-save of
    same state is a no-op).
  - `organization-service.ts` — `OrganizationService.createOrganization`;
    `MembershipService.grantMembership` (idempotent: re-grant active →
    no-op; re-grant revoked → ConflictError, revoked is terminal),
    `revokeMembership` (idempotent: re-revoke → no-op), `getMembership`,
    `listForOrganization`, `listForPerson`.
- **Participants boundary** (`src/participants/`):
  - `port.ts` — `ParticipantRole` union (the 9 v1.0 roles: PERSON,
    CREATOR, COMPANY, ADVERTISER, PUBLISHER, APP, SUPPLIER, COMMUNITY,
    MEASUREMENT_PROVIDER); `PARTICIPANT_ROLES`; `Participant`;
    `ParticipantRepository`; `Policy` + `PolicyRepository`;
    `MembershipLookup` (structural surface mirrored here so participants
    can consume org-membership checks without importing the organizations
    domain — bootstrap wires the real MembershipRepository to satisfy it);
    `IdentityLookup` (mirrored from identity); `AuthorizationService`
    (resolvePrincipal, hasRole, isOrganizationMember, isOwner, authorize);
    `AuthorizationDecision`; `AuthorizationRequest`; `ResolvedPrincipal`.
  - `in-memory-participant-repository.ts` — in-memory participant + policy
    repos.
  - `participant-service.ts` — `createParticipant`, `addRole` (idempotent +
    audited), `removeRole` (idempotent + audited), `hasRole`,
    `resolveByReference`.
  - `authorization-service.ts` — `createAuthorizationService`: deny-by-
    default; client-asserted role/scope claims NEVER trusted (§4.5,
    API-AC-02); `policyMatches` evaluates subject + action + resource;
    explicit DENY policies override ALLOW; unauthenticated → deny.
  - `policy-service.ts` — `createPolicy` (audited as
    `authorization.policy_changed`, §4.9).
- **API boundary** (`src/api/`):
  - `port.ts` — `ApiAuth` + `ApiCommands` interfaces (infrastructure
    contract; the API server consumes these and never imports the domain
    ports — dependency inversion at the composition root). Also
    `ApiAuthSubject`, `ApiResolvedPrincipal`, `ApiAuthDecision`,
    `ApiPublicIdentityView`, `ApiOrganizationView`, `ApiMembershipView`,
    `ApiCreateOrganizationInput`, `ApiGrantMembershipInput`.
  - `server.ts` — `guardMutation()` helper: extract auth subject from
    headers → resolve via ApiAuth → authorize via ApiAuth → 403 on deny;
    protected endpoints `POST /api/identities`, `GET /api/identities/:id`,
    `POST /api/organizations`, `POST /api/organizations/:id/memberships`,
    `DELETE /api/organizations/:id/memberships/:membershipId`. Public read
    endpoint `GET /api/identities/:id` returns only the privacy-safe
    PublicIdentityView (PRIV-001, AC-07).
- **Bootstrap wiring** (`src/bootstrap/runtime.ts`):
  - Creates in-memory repositories + domain services (IdentityService,
    OrganizationService, MembershipService, ParticipantService,
    AuthorizationService, PolicyService).
  - Cross-domain lookup adapters (`membershipLookup`, `identityLookup`)
    wire the organizations/identity repos into the participants
    AuthorizationService (structural typing; no domain→domain imports).
  - `apiAuth` + `apiCommands` adapters bridge the API server to the real
    domain services (dependency inversion).
  - All NET-W002 services are exposed on the `Runtime` interface for
    integration/security tests.
- **Audit lineage**: every material identity/authorization mutation emits
  an append-oriented audit record via the NET-W001 `AuditWriter` (deeply-
  frozen, append-only). New event types: `identity.person_created`,
  `organization.created`, `organization.membership_granted`,
  `organization.membership_revoked`, `participant.role_added`,
  `participant.role_removed`, `authorization.policy_changed`. All records
  carry actor/subject/resourceType/resourceId/correlationId/executionId.
- **Tests**: 8 new NET-W002 suites (44 tests) covering AC-01..08, plus the
  updated NET-W001-AC-08 regression (split into skeleton vs NET-W002-non-
  skeleton assertions; forbidden-pattern check now covers all 16 domains
  including the 3 NET-W002 ones).

### What is deliberately NOT implemented (out of scope per §5)

- No advertising campaigns, inventory, creator profiles, helpfulness,
  evidence evaluation, attribution, reputation algorithms, Participation
  Credit issuance, cash settlement, fraud models, Demand Pools,
  procurement, Benefit Pools, blockchain/ledger consensus.
- No production external authentication provider (the in-memory
  PrincipalResolver is clearly marked "NOT a production auth provider";
  production OIDC/SAML/JWT providers will be adapters in `src/adapters/`).
- No downstream authorization decisions (campaigns, contributions,
  procurement, benefits, settlement). The AuthorizationService only
  resolves server-side identity/role/membership/ownership facts.
- No real PostgreSQL backend (NET-W003). In-memory repositories are used
  behind the same port interfaces; production persistence will drop in
  unchanged.
- No placeholder implementations that silently authorize downstream
  domain actions.

### NET-W001 regression update

`tests/regression/ac-08-no-premature-domain-logic.test.ts` was updated to
reflect the NET-W002 scope: identity/organizations/participants are no
longer "skeleton" (they carry concrete identity/org/authz behaviour). The
test now asserts:
- still-deferred domains (13) remain skeletal;
- NET-W002 domains (3) are non-skeletal and tier "domain" with a
  "NET-W002" marker in describe();
- the forbidden-pattern check (issueCredit, mintCredit, settleAmount,
  mutateReputation, allocateBenefit, deliverCampaign, issueReward,
  ProofOfValue, cashSettlement/Payout) applies to ALL 16 domains —
  including the 3 NET-W002 ones, which introduce identity/org/authz
  behaviour but NEVER economic-material behaviour;
- the architecture check still passes (no domain leak);
- the frozen architecture files remain unchanged.
