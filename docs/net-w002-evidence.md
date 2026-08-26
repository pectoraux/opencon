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
| `bun test` | Full automated test suite (18 files, 112 tests) |
| `bun run verify` | typecheck + arch:check + tests (canonical evidence command) |

The same pipeline is enforced in CI by `.github/workflows/ci.yml`
(inherited from NET-W001), so the architecture/dependency checks and
the test suite both gate every push and PR targeting `main`.

## 2. Verification results (reproduced)

```
$ bun run verify
$ tsc --noEmit                       # typecheck: PASS (exit 0)
$ bun scripts/check-architecture.ts  # ✓ 136 files scanned, 0 violations (exit 0)
$ bun test                           # 112 pass, 0 fail, 839 expect() calls, 18 files (exit 0)
```

Test breakdown:
- NET-W001 suites (unchanged, still pass): 52 tests across 8 files
- NET-W002 suites (original): 44 tests across 8 files
  - tests/identity/net-w002-ac-01-unified-identity.test.ts (2 tests)
  - tests/participants/net-w002-ac-02-participant-roles.test.ts (6 tests)
  - tests/api/net-w002-ac-03-server-side-authorization.test.ts (6 tests)
  - tests/organizations/net-w002-ac-04-organization-scoping.test.ts (3 tests)
  - tests/organizations/net-w002-ac-05-membership-lifecycle.test.ts (6 tests)
  - tests/identity/net-w002-ac-06-authentication-boundary.test.ts (7 tests)
  - tests/identity/net-w002-ac-07-privacy-boundary.test.ts (8 tests)
  - tests/audit/net-w002-ac-08-audit-lineage.test.ts (5 tests)
- NET-W002 PR #4 remediation suites (new): 16 tests across 2 files
  - tests/api/net-w002-remediation-actor-spoof.test.ts (6 tests)
  - tests/api/net-w002-remediation-claims-leak.test.ts (10 tests)
- NET-W001-AC-08 regression (split + forbidden-pattern widened to all 16
  domains; 6 tests, still pass)

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

## 6. PR #4 architect remediation

The architect requested CHANGES on PR #4 with two identity-boundary issues
that must be corrected before merge:

> 1. `X-Actor-Id` is currently caller-controlled and can spoof the actor
>    recorded in audit context.
> 2. Raw `X-Client-Claims` can flow into authorization logs and potentially
>    expose credential material.

Required evidence:
> - regression tests proving a forged `X-Actor-Id` cannot change the
>   authoritative audit actor;
> - regression tests proving credential-shaped/client-claim values do not
>   appear in captured logs;
> - `bun run verify` and CI green after remediation.

### 6.1 Remediation #1 — do not trust `X-Actor-Id` for audit actor

**Root cause:** `src/api/server.ts` built the request-scope
`ExecutionContext.actor` directly from the caller-controlled
`x-actor-id` header. Downstream services used `context.actor?.id` to
write audit lineage, so a forged header value would be recorded as the
audit actor for protected mutations.

**Fix (src/api/server.ts):**
- Removed the `x-actor-id` header read entirely. The request-scope
  `ExecutionContext` now carries `actor: null` (the request itself has
  not been authenticated yet — no caller-controlled actor is trusted).
- `guardMutation()` derives a child `ExecutionContext` via
  `deriveExecutionContext(ctx, { actor: { id: personId, kind: "person" } })`
  AFTER `ApiAuth.resolvePrincipal()` returns the canonical `personId`
  and `ApiAuth.authorize()` returns `allow`. This derived context is the
  authoritative execution scope for the protected mutation.
- Each protected command invocation is wrapped in
  `runWithExecutionContextAsync(guarded.execution, ...)` so BOTH audit
  records (via the `context` parameter) AND log lines (via AsyncLocalStorage)
  carry the server-resolved principal as the actor — never a header.
- The `guardMutation` deny condition was also hardened:
  `decision.decision !== "allow" || personId === null` — a wildcard allow
  policy can never authorize an unauthenticated principal.

**Regression evidence (tests/api/net-w002-remediation-actor-spoof.test.ts, 6 tests):**
- POST /api/identities with forged `X-Actor-Id` → audit actor for
  `identity.person_created` is the resolved `personId`, NOT the spoofed
  value; the spoofed id does not appear anywhere in the audit record JSON.
- POST /api/organizations with forged `X-Actor-Id` → audit actor for
  `organization.created` is the resolved `personId`.
- POST /api/organizations/:id/memberships with forged `X-Actor-Id` →
  audit actor for `organization.membership_granted` is the resolved `personId`.
- DELETE /api/organizations/:id/memberships/:membershipId with forged
  `X-Actor-Id` → audit actor for `organization.membership_revoked` is the
  resolved `personId`.
- A denied protected mutation writes NO audit record at all (no spoofed
  actor can appear in audit when the mutation never executes).
- Static contract: the API server source no longer reads
  `req.headers["x-actor-id"]`; the authoritative actor is derived
  exclusively from `personId` inside `guardMutation()`.

### 6.2 Remediation #2 — do not log raw `clientClaims`

**Root cause:** `src/participants/authorization-service.ts` logged
`clientClaims: request.clientClaims` (the raw claim object) on all three
deny paths (`denied_unauthenticated`, `denied_policy`, `denied_default`).
`X-Client-Claims` is untrusted external input and may contain tokens,
passwords, or other credential material — emitting it raw into logs
violates the privacy/secret boundary.

**Fix (src/participants/authorization-service.ts):**
- Added `safeClaimsFingerprint(clientClaims)` exported helper that
  produces ONLY:
  - `clientClaimsPresent` (boolean) — did the client send any claims;
  - `clientClaimKeys` (string[]) — a bounded list of top-level claim key
    names, capped at `MAX_CLIENT_CLAIM_KEYS = 16`, with credential-shaped
    key names (matching `password|token|secret|api[-_]?key|private[-_]?key|
    credential`) redacted to `<redacted>` — so even the structural
    indicator that a credential was carried is suppressed;
  - `clientClaimsCount` (number) — total top-level claim count for anomaly
    detection without exposing values.
- The fingerprint NEVER contains claim values. A credential-shaped key
  name is itself redacted.
- All three deny-path log calls now spread `...claimsFingerprint` instead
  of `clientClaims: request.clientClaims`.
- `src/api/server.ts`: `extractClientClaims()` is now a standalone function
  and `resolveActorPersonId()` always carries claims forward — even on the
  unauthenticated path — so the safe fingerprint is recorded when forged
  claims are rejected (previously claims were dropped when no subject id
  was present, losing anomaly signal).

**Regression evidence (tests/api/net-w002-remediation-claims-leak.test.ts, 10 tests):**
- Unit contract (5 tests): absent claims → `clientClaimsPresent=false`;
  non-credential claims → keys listed verbatim, no values; credential-
  shaped keys redacted to `<redacted>`; keys capped at 16 with
  `<truncated>` sentinel; fingerprint is shallow (no nested traversal,
  no values ever exposed).
- Deny path — deny-by-default (1 test): credential-shaped claim values
  (`SECRET-TOKEN-VALUE-DO-NOT-LEAK`, `hunter2-password-do-not-leak`,
  `ak-1234567890-do-not-leak`) sent in `X-Client-Claims` do not appear in
  ANY captured log line; the `authorization.denied_default` entry carries
  `clientClaimsPresent: true`, `clientClaimsCount: 4`, `clientClaimKeys:
  ["role","<redacted>","<redacted>","<redacted>"]`; the raw `clientClaims`
  field is absent.
- Deny path — unauthenticated (1 test): even with no auth subject, the
  claims fingerprint is recorded (proves the standalone-extraction fix);
  credential values do not appear in any log line.
- Deny path — explicit DENY policy (1 test): credential-shaped claim
  values do not appear in any log line; the `denied_policy` entry carries
  the safe fingerprint.
- Allow path (1 test): even on the allow path, credential values sent in
  `X-Client-Claims` do not appear in any log line; the `allowed_policy`
  entry carries neither raw claims nor the fingerprint.
- Static contract (1 test): the AuthorizationService source does not log
  a raw `clientClaims` field; the `safeClaimsFingerprint` helper is
  exported; all three deny-path log calls spread `...claimsFingerprint`.

### 6.3 Remediation verification

```
$ bun run verify
$ tsc --noEmit                       # typecheck: PASS (exit 0)
$ bun scripts/check-architecture.ts  # ✓ 136 files scanned, 0 violations (exit 0)
$ bun test                           # 112 pass, 0 fail, 839 expect() calls, 18 files (exit 0)
```

The frozen architecture (`spec/architecture.md`, `spec/architecture-lock.md`)
is unchanged. The tier allow matrix still passes (domain services import
only core + their own port; infrastructure never imports domain ports).
No secrets or real credentials are committed — all credential values in
the regression tests are deliberately synthetic strings
(`SECRET-TOKEN-VALUE-DO-NOT-LEAK`, etc.) that exist solely to prove the
privacy boundary rejects them. The NET-W001 foundation (deep immutability,
append-only audit, secrets isolation, CI enforcement) is preserved.
