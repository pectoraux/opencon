# NET-W004 — Evidence

**Work item:** NET-W004 — Opportunity and Contribution Lifecycle
**Work order:** spec/work-orders/NET-W004.md
**Architecture:** v1.0 (FROZEN)
**Requirements:** OPP-001..004, API-003
**Acceptance Criteria:** NET-W004-AC-01..08
**Dependencies:** NET-W002 (merged 2f14140), NET-W003 (merged bf9c774)
**Branch:** feat/net-w004-opportunity-contribution-lifecycle
**Tracking issue:** https://github.com/pectoraux/opencon/issues/7

## 1. Verification commands

| command                              | purpose                                                    | result                                |
|--------------------------------------|------------------------------------------------------------|---------------------------------------|
| `bun run typecheck`                  | TypeScript strict-mode typecheck                           | PASS                                  |
| `bun run arch:check`                 | Architecture import-scanner (tier allow matrix)           | PASS — 162 files, 0 violations        |
| `bun test`                           | Run all unit/integration tests (skips real PG/Redis)       | PASS — 245 pass / 15 skip / 0 fail    |
| `bun run verify`                     | typecheck + arch:check + tests                             | exit 0                                |

(Counts as of this PR; the NET-W001..003 regression suites continue to pass alongside the new NET-W004 suites.)

## 2. Acceptance criteria → changed files → test mapping

### AC-01 — Opportunity first-class model

Opportunities can be created, retrieved and updated through authorized
application operations, have stable IDs and versions, are tenant/
participant scoped, and persist durably through PostgreSQL.

**Changed files (implementation):**
- `src/opportunities/port.ts` (MODIFIED) — Opportunity entity, CreateOpportunityInput, UpdateOpportunityInput, OpportunityRepository, OpportunityService, OpportunitiesPort (readiness `"ready"`).
- `src/opportunities/authority-opportunity-repository.ts` (NEW) — PostgresAuthority-backed repository; `save`, `findById`, `listByOrganization`, `exists`, `getByIdWithinTx`, `saveWithinTx` (preserves non-lifecycle fields via read-modify-write; checks `expectedVersion` for optimistic concurrency).
- `src/opportunities/opportunity-service.ts` (NEW) — OpportunityService.createOpportunity (→ DRAFT, v0), getOpportunity, updateBrief (does NOT mutate state/version).
- `src/opportunities/module.ts` (MODIFIED) — readiness `"ready"`; summary references NET-W004.
- `src/opportunities/index.ts` (MODIFIED) — barrel exports the new modules.

**Test evidence:** `tests/opportunities/net-w004-ac-01-opportunity-model.test.ts` (7 tests).

### AC-02 — Contribution first-class model

Contributions can be created and retrieved against an Opportunity and
contributor, persist durably, and enforce the invariant that a
Contribution belongs to exactly one Opportunity and contributor.

**Changed files (implementation):**
- `src/contributions/port.ts` (MODIFIED) — Contribution entity (opportunityId, contributorId, contributionType, submission, evidenceReferencePlaceholders), ContributionRepository, ContributionService, OpportunityLookup structural interface, ContributionsPort (readiness `"ready"`).
- `src/contributions/authority-contribution-repository.ts` (NEW) — PostgresAuthority-backed repository mirroring the opportunity pattern.
- `src/contributions/contribution-service.ts` (NEW) — ContributionService.createContribution (validates opportunity exists + contributor's org scope matches opportunity's scope; → DRAFT, v0), getContribution.
- `src/contributions/module.ts` (MODIFIED) — readiness `"ready"`.
- `src/contributions/index.ts` (MODIFIED) — barrel exports.

**Test evidence:** `tests/contributions/net-w004-ac-02-contribution-model.test.ts` (7 tests, including the AC-02 invariant: rejects unknown opportunity id; rejects org-scope mismatch).

### AC-03 — Complete transition matrix

Every legal transition in the canonical lifecycle succeeds under its
required preconditions; every unspecified transition is rejected with
a stable error classification/code.

**Changed files (implementation):**
- `src/workflows/transition-table.ts` (NEW) — exhaustive legal-transition matrix; `OPPORTUNITY_TRANSITION_TABLE`, `CONTRIBUTION_TRANSITION_TABLE`, `findRule`, `legalTargets`, `ALL_LIFECYCLE_STATES`.
- `src/workflows/state-machine.ts` (NEW) — PURE `evaluateTransition` evaluator; returns `legal: true` with the matching rule OR `legal: false` with `IllegalTransitionError` / `TerminalStateError`.
- `src/workflows/port.ts` (MODIFIED) — LifecycleRepository (tx-explicit), TransitionAuthorizer, WorkflowService, WorkflowsPort (readiness `"ready"`).
- `src/workflows/workflow-service.ts` (NEW) — `requestTransition`: per-subject coordination lock (non-authoritative) → idempotency store apply (exactly-once-per-key) → within authoritative tx: re-read subject, check expectedVersion (optimistic concurrency), authorize via TransitionAuthorizer (deny-by-default), evaluate legality (pure state machine), write updated subject + audit record (atomic).
- `src/workflows/lifecycle-repository.ts` (NEW) — `createLifecycleRepository` adapter factory; wraps a domain repository so the workflow service (operating on plain LifecycleSubject) can mutate lifecycle state uniformly via read-modify-write.
- `src/workflows/module.ts` (MODIFIED) — readiness `"ready"`; `/workflows` is the SOLE lifecycle authority.
- `src/workflows/index.ts` (MODIFIED) — barrel exports.

**Test evidence:** `tests/workflows/net-w004-ac-03-transition-matrix.test.ts` (13 tests):
- opportunity transition matrix is non-empty + covers canonical path;
- every legal transition evaluates to `legal=true` with the matching rule;
- every illegal transition is rejected as `IllegalTransitionError` (or `TerminalStateError` for terminal sources);
- terminal states (VERIFIED, REJECTED, CANCELLED) have no legal outgoing transitions;
- every legal target from DRAFT is enumerated (no hidden transitions);
- REJECTED is reachable only via DISPUTED → REJECTED;
- CANCELLED is reachable from every non-terminal canonical state except SETTLED/VERIFIED;
- the contribution transition table mirrors the opportunity table;
- end-to-end workflow service transitions (DRAFT → READY → ASSIGNED; illegal rejected; terminal rejected).

### AC-04 — /workflows authority

Only the workflow service may mutate lifecycle state. Direct domain/
application attempts to write lifecycle state outside the workflow
boundary are rejected by architecture/static checks and runtime tests.

**Changed files (implementation):**
- `src/core/workflow.ts` (NEW) — shared lifecycle vocabulary (LifecycleState, LifecycleSubject, TransitionRequest, TransitionResult, IllegalTransitionError, ConcurrentTransitionError, LifecycleSubjectNotFoundError, TerminalStateError). Core importable by all domains.
- `src/workflows/workflow-service.ts` (NEW) — the SOLE entry point for lifecycle mutation.
- The OpportunityService + ContributionService ports deliberately declare NO method named `setState`/`setVersion`/`transition` (verified by AC-04 static test).

**Test evidence:** `tests/workflows/net-w004-ac-04-workflow-authority.test.ts` (6 tests):
- the OpportunityService port declares NO lifecycle mutation method;
- the ContributionService port declares NO lifecycle mutation method;
- the architecture checker rejects a domain-tier fixture that imports another domain (domain→other-domain prohibited);
- the architecture check passes with all NET-W004 files (0 violations);
- runtime: OpportunityService.updateBrief does NOT mutate state/version;
- runtime: WorkflowService.requestTransition DOES mutate state + increment version.

### AC-05 — Authorization and scoping

A caller may transition only opportunities/contributions for which the
server-side participant/organization policy permits the operation.
Forged client claims cannot authorize a transition, and cross-
organization access is rejected.

**Changed files (implementation):**
- `src/bootstrap/runtime.ts` (MODIFIED) — wires the `TransitionAuthorizer` adapter that delegates to the existing `AuthorizationService` (deny-by-default from NET-W002 §4.5). The subject's `organizationScopeId` is the resource checked; cross-org transitions are denied.
- `src/api/server.ts` (MODIFIED) — `POST /api/workflows/transitions` endpoint guarded by `guardMutation` (action `workflow.transition`, resource `*`). The API guard authenticates the principal server-side (never trusts client-asserted claims).
- `src/api/port.ts` (MODIFIED) — `ApiRequestTransitionInput`, `ApiTransitionResultView`, `ApiCommands.requestTransition`.

**Test evidence:** `tests/workflows/net-w004-ac-05-authorization-scoping.test.ts` (8 tests):
- authenticated principal WITH a matching allow policy can transition;
- unauthenticated principal is rejected (deny-by-default);
- cross-organization transition is rejected;
- a principal with NO allow policies is denied even with forged client claims;
- the subject's organizationScopeId is the resource checked (contribution in different org rejected);
- the API auth guard rejects an unauthenticated transition request (403);
- the API auth guard rejects a transition request with forged client claims (403);
- the API auth guard authorizes a transition request when the principal has a matching allow policy (201).

### AC-06 — Idempotency and concurrency

Repeated delivery of the same transition request with the same
idempotency key results in exactly one authoritative mutation/audit
lineage. Concurrent stale writers are rejected or deterministically
serialized; no lost update occurs.

**Changed files (implementation):**
- `src/core/idempotency.ts` (MODIFIED) — `IdempotentApplyContext` now exposes `transaction: AuthorityTransaction` (additive, non-breaking). The workflow service uses this to perform the lifecycle mutation + audit record within the SAME authoritative tx as the idempotency record (true atomicity).
- `src/persistence/idempotency-store.ts` (MODIFIED) — populates `transaction: tx` on the apply context.
- `src/workflows/workflow-service.ts` (NEW) — per-key coordination lock (non-authoritative serializer) + idempotency store apply + optimistic-concurrency check (rejects stale `expectedVersion` with `ConcurrentTransitionError`).

**Test evidence:** `tests/workflows/net-w004-ac-06-idempotency-concurrency.test.ts` (5 tests):
- repeating the same transition with the same idempotency key is a deterministic replay (`executed=false`, single mutation, single audit record);
- different idempotency keys produce different transitions (no false replays);
- a stale writer (wrong expectedVersion) is rejected as `ConcurrentTransitionError`;
- two concurrent transition requests with the SAME idempotency key produce exactly one mutation (idempotency store's per-key mutex serializes);
- the idempotency record persists durably (PostgresAuthority-backed).

### AC-07 — Trace/audit lineage

Every material lifecycle mutation records stable execution/correlation/
causation identifiers, actor/subject/resource lineage, and an append-
oriented audit record that is committed atomically with the authoritative
state mutation.

**REMEDIATION (architect re-review on PR #8):** the workflow's audit
writes now go through the **transactional audit writer** — not the
ordinary in-memory direct writer. The lifecycle mutation, the idempotency
record, and the audit record all commit via the SAME `AuthorityTransaction`:

```
lifecycle mutation   (repo.saveWithinTx — buffered in the authority tx)
+ idempotency record (idempotency store — buffered in the authority tx)
+ audit record       (auditWriter.forTransaction(tx) buffer, flushed
                      before the tx commits; flush failure throws so the
                      tx rolls back)
```

Rollback-on-audit-failure is proven by a fault-injection test: when the
underlying audit writer fails, the transition is rejected AND the subject
remains unmutated (DRAFT, version 0), no idempotency record is committed,
and no audit records exist — no committed mutation without committed
audit lineage.

Correct `transactionId` lineage: the audit record's
`metadata.transactionId` and the returned `TransitionResult.transactionId`
are the AUTHORITATIVE `AuthorityTransaction.transactionId` — NOT the
execution id (previously the workflow returned `executionId` as the tx
reference). The idempotency-record lineage in the audit metadata now
references the REAL idempotency record id (`IdempotentApplyContext.recordId`)
which equals `IdempotentResult.recordId` — previously the tx id was
incorrectly used.

**Changed files (implementation):**
- `src/core/audit.ts` (MODIFIED, remediation) — the `TransactionalAuditWriter` + `TransactionalAuditBuffer` contracts are promoted to core so the workflows domain can consume them as provider-neutral type-only imports (domain→core is allowed by the tier allow matrix). The concrete implementation stays in the audit infrastructure boundary.
- `src/audit/transactional-audit-writer.ts` (MODIFIED, remediation) — imports the contracts from core; `createTransactionalAuditWriter` remains the concrete infrastructure factory. The buffer's `commit()` flush failure surfaces to the caller so the bound authoritative tx rolls back.
- `src/workflows/workflow-service.ts` (MODIFIED, remediation) — `performTransition` obtains `auditWriter.forTransaction(tx)` (a transaction-scoped buffer bound to the SAME AuthorityTransaction as the lifecycle mutation + the idempotency record), appends the audit record through the buffer, and flushes it BEFORE the idempotency store commits the tx. An append or flush failure throws so the idempotency store rolls back the WHOLE tx (mutation + idempotency record + audit record all discarded). The returned `transactionId` is `tx.transactionId` (the authoritative tx id).
- `src/core/idempotency.ts` (MODIFIED, remediation, additive) — `IdempotentApplyContext` now also exposes `recordId: string` (the idempotency record's stable id, generated before the callback runs) so the audit lineage references the exact record that deduplicated the mutation.
- `src/persistence/idempotency-store.ts` (MODIFIED, remediation) — populates `recordId` on the apply context.
- `src/workflows/port.ts` (MODIFIED, remediation) — `WorkflowServiceDeps.auditWriter` is the `TransactionalAuditWriter` core contract (bootstrap wires the concrete implementation).
- `src/bootstrap/runtime.ts` (MODIFIED, remediation) — the runtime's audit writer is `createTransactionalAuditWriter({ underlying: createInMemoryAuditWriter(...) })`. Non-transactional consumers (identity/organizations/participants/opportunities/contributions/workers) call append/query/count which delegate directly to the underlying append-only writer (identical NET-W001/NET-W002 behaviour); the workflow authority calls `forTransaction(tx)` for atomic audit lineage.
- `src/core/workflow.ts` (NEW) — `TransitionResult` carries `executionId`/`correlationId`/`causationId`/`transactionId`/`auditEventName`/`transitionId`/`recordId`.

**Test evidence:** `tests/workflows/net-w004-ac-07-audit-lineage.test.ts` (7 tests):
- a transition result carries execution/correlation/causation identifiers + the AUTHORITATIVE transaction id (distinct from the execution id);
- an audit record is appended atomically with the lifecycle mutation (single commit) — the audit metadata's `transactionId` equals the authoritative tx id (not the execution id), and the `idempotencyRecordId` equals the REAL idempotency record id (verified against `idempotency.get(key).recordId`);
- a rolled-back transition does NOT append an audit record (atomicity: audit + mutation commit together or both roll back);
- REMEDIATION: rollback-on-audit-failure — a faulty audit writer (append throws) makes the transition fail AND the subject remain unmutated (DRAFT v0), no idempotency record is committed, no audit records exist, and a retry with the same key executes again (the whole apply rolled back atomically);
- REMEDIATION: the runtime's audit writer IS the transactional audit writer (bootstrap wiring) — `forTransaction(tx)` buffers appends (not visible via query/count until the buffer commits) and stamps the authoritative `tx.transactionId` lineage;
- audit records are append-only and immutable (deeply frozen — NET-W001-AC-06 preserved);
- the audit record carries actor/subject/resource lineage for both opportunity and contribution transitions (with the same authoritative tx lineage).

### AC-08 — Architecture and out-of-scope regression

The architecture checker passes, frozen architecture files remain
unchanged, and no downstream economic/evidence/reputation/product
behavior is introduced.

**Changed files (regression + tests):**
- `tests/regression/ac-08-no-premature-domain-logic.test.ts` (MODIFIED) — adds `NET_W004_DOMAINS = ["opportunities", "contributions", "workflows"]` to the non-skeleton set; the forbidden-pattern scan continues to apply to ALL 16 domains (no economic/reputation/settlement/credit/evidence-evaluation logic introduced).
- `tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts` (MODIFIED) — relaxes the "no domain-tier file references PostgresAuthority/IdempotencyStore" assertion to allow the NET-W004 domains to consume the provider-neutral CORE contracts (PostgresAuthority, AuthorityTransaction, IdempotencyStore, CoordinationService) as type-only imports. The CONCRETE implementation class/factory names (PostgresAuthorityShim, RedisCoordinationShim, DurableObjectStore, TraceRecorder, createTransactionalAuditWriter, SecretMaterialRedactor) remain forbidden in domain-tier files. REMEDIATION UPDATE: `TransactionalAuditWriter` is now a CORE contract (src/core/audit.ts) that the workflows domain consumes as a type-only import — only the concrete factory `createTransactionalAuditWriter` is forbidden in domain files, mirroring how `PostgresAuthority` (contract) is allowed while `PostgresAuthorityShim` (implementation) is not.

**Test evidence:** `tests/regression/net-w004-ac-08-architecture-out-of-scope.test.ts` (10 tests):
- NET-W004 domains introduce no forbidden material-operation patterns (issueCredit, mintCredit, settleAmount, mutateReputation, allocateBenefit, deliverCampaign, issueReward, createProofOfValue, evaluateProofOfValue, cashSettlement);
- NET-W004 domains reference NET-W004 in their module summaries (no "skeleton" marker);
- domains deferred past NET-W004 (campaigns, inventory, creators, demand, benefits, reputation, evidence, outcomes, settlement, disputes) remain skeletons;
- the architecture check passes with all NET-W004 files (0 violations);
- spec/architecture.md and spec/architecture-lock.md remain FROZEN;
- the NET-W004 work order exists and binds to frozen Architecture v1.0;
- no secrets or real credentials are committed in NET-W004 domain files;
- the NET-W004 domains do NOT import the concrete provider drivers (pg, ioredis) — only the provider-neutral core contracts;
- the NET-W004 domains do NOT import any other domain (tier allow matrix: domain→other-domain prohibited);
- the transition matrix artifact (docs/net-w004-transition-matrix.md) exists and enumerates every legal transition;
- the NET-W004 evidence document exists.

## 3. Verification results

```
$ bun run verify
$ bun run typecheck   # PASS
$ bun run arch:check  # PASS — 162 files, 0 violations
$ bun test             # 258 pass / 15 skip / 0 fail (remediation: +2 AC-07 tests)
```

The 15 skips are the real PostgreSQL + Redis integration tests from
NET-W003 that require service containers (CI provisions them; the
NET-W004 unit/integration tests use the file-backed PostgresAuthorityShim
test double which demonstrates the SAME authority semantics required by
the workflow service).

## 4. Out of scope confirmation (work order §5)

NET-W004 introduces NO:

- evidence evaluation or Proof-of-Value (NET-W005)
- outcome/measurement semantics (NET-W006)
- reputation calculation (NET-W007)
- Participation Credits or cash settlement (NET-W008)
- campaign behavior (NET-W011)
- helpfulness scoring (NET-W012)
- creator matching/UGC (NET-W015..017)
- advertising inventory
- fraud scoring or challenge economics (NET-W009..010)
- demand pools/procurement/benefit pools
- blockchain consensus or decentralized validation

The transition table declares states + preconditions only. Transitions
that require later domains (for example `EVALUATING` → `CHALLENGE_WINDOW`
requires evidence evaluation) are represented as workflow states +
preconditions; the `requiresEvidenceReference` flag is a placeholder
that NET-W004 does NOT enforce. Later work items (NET-W005..014) attach
the downstream semantics.

## 5. Frozen architecture confirmation

- `spec/architecture.md` — UNCHANGED (byte-for-byte vs main).
- `spec/architecture-lock.md` — UNCHANGED (byte-for-byte vs main).
- The workflow authority model conforms to architecture §17 (canonical
  lifecycle), §18 (module ownership: `/workflows` is the SOLE lifecycle
  authority), §19 (authority rules).
- The provider-neutral contracts (PostgresAuthority, AuthorityTransaction,
  IdempotencyStore, CoordinationService) are unchanged core contracts
  declared in NET-W003. The NET-W004 domains consume them as type-only
  imports; the concrete drivers (pg, ioredis) remain in the adapter tier
  only (architecture §14, §18).

## 6. NET-W001..003 regression confirmation

- NET-W001 (52 tests) — unchanged, still pass.
- NET-W002 (60 tests) — unchanged, still pass.
- NET-W003 (58 tests + 15 skipped integration tests requiring services)
  — unchanged, still pass alongside the new NET-W004 suites.
- The architecture checker (ac-02) continues to enforce the tier allow
  matrix: domain→infra prohibited, domain→adapter prohibited, domain→
  other-domain prohibited, infrastructure→domain prohibited, adapter→
  domain prohibited.

## 7. CI

The existing `.github/workflows/ci.yml` (added in NET-W001, updated in
NET-W003 to provision PostgreSQL + Redis service containers for the
integration tests) continues to gate every push/PR. The CI workflow
runs `bun install --frozen-lockfile`, `bun run typecheck`,
`bun run arch:check`, and `bun test` as separate failing steps. No CI
changes are required for NET-W004 (the NET-W004 tests use the file-backed
PostgresAuthorityShim test double, not the real PostgreSQL service
container — they run in the `bun test` step without service-container
dependencies).

## 8. Definition of done (work order §10)

1. ✅ OPP-001..004 and API-003 are implemented.
2. ✅ `/workflows` is the sole lifecycle authority.
3. ✅ All legal transitions and rejection paths are exhaustively tested (AC-03).
4. ✅ Persistence, idempotency, authorization and audit lineage are integrated with NET-W002/003 foundations.
5. ✅ Required evidence is mapped to every acceptance criterion (this document).
6. ✅ Architecture checks and CI pass.
7. ✅ Frozen architecture files are unchanged.
8. ✅ No downstream economic/evidence/reputation/product behavior is introduced.
9. ⏳ The canonical implementation PR is reviewed and approved by the architect (awaiting review).
