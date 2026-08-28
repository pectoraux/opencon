# NET-W017 — UGC workflow and rights: evidence of record

**Work item:** NET-W017 (issue #33 — READY_FOR_IMPLEMENTATION)
**Branch:** `feat/net-w017-ugc-workflow-rights`
**Architecture:** v1.0 FROZEN (`spec/architecture.md`, `spec/architecture-lock.md` unchanged — regression-pinned)
**Requirements:** CRE-003, CRE-004, CRE-005
**Work order:** `spec/work-orders/NET-W017.md`

## 1. What shipped

NET-W017 turns the NET-W016 eligible match into a workflow-mediated
creator engagement with explicit, revocable usage rights and
evidence-linked UGC production — inside the frozen `/creators`
boundary (NO 17th domain) with ONE new canonical lifecycle subject
kind (`engagement`) whose transitions live in `/workflows` (the SOLE
lifecycle authority):

- **The engagement lifecycle** (`DRAFT → READY → ASSIGNED →
  IN_PROGRESS → SUBMITTED → VERIFIED/REJECTED/CANCELLED`): a new
  `LifecycleSubjectKind`, `ENGAGEMENT_TRANSITION_TABLE` (11 rules, no
  terminal sources, no risk states), workflow-service routing and an
  `AuthorityEngagementRepository` exposing the `LifecycleRepository`
  structural surface. Every state change executes through
  `WorkflowService.requestTransition`.
- **Deterministic auto-accept (CRE-003)**: a versioned
  `CreatorAcceptancePolicy` + a PURE evaluation engine with a
  nine-gate closed reason vocabulary; a qualifying evaluation
  composes the auto-grant + the workflow transition; a non-qualifying
  evaluation mutates NOTHING. Auto-match orchestration:
  `createEngagementsFromMatch` turns a match run's eligible
  candidates into DRAFT offers with per-candidate outcomes recorded
  in an auditable batch record.
- **Usage rights (CRE-004)**: explicit, immutable
  `UsageRightsGrant` records (uses/channels/territories/formats/
  window/exclusions, envelope-subset validated against the offer);
  `contentOwnership` frozen to `creator_retained` with NO input path
  to transfer it; ONE append-only revocation per grant
  (grantor-only); the effective status DERIVED (ACTIVE/REVOKED/
  EXPIRED — pure function over immutable records, no local status
  machine).
- **UGC production (AC-02/AC-05)**: append-only production records
  carrying the full creator/opportunity/contribution lineage;
  immutable deliverable versions with deterministic monotonic
  versioning per (production, deliverableKey) under an advisory-lock
  anchor; submissions requiring ≥1 deliverable + canonical evidence
  references validated for existence + tenant scope + exact
  `ugc_production` subject binding; provenance
  (execution/correlation/causation) preserved end-to-end.
- **API surface**: 9 guarded composed commands + 7 tenant-scoped read
  families + the EXISTING generic transition endpoint extended to
  subjectKind `engagement` (tender/verify/reject/cancel — the
  Proof-of-Value precedent).

## 2. Authority model — the decision of record

| Authority | NET-W017 interaction |
|---|---|
| `/workflows` | The SOLE lifecycle authority: the engagement is a new canonical subject kind; every transition routes through `requestTransition` (the sanctioned delegation). The `/creators` boundary has NO local transition machinery (structural pins in AC-01/AC-07). |
| `/campaigns` | Read-only campaign + pinned policy version + administrative status through the neutral `EngagementCampaignLookup` (composition-root adapter). The campaigns domain is NOT modified. |
| `/evidence` | Submission evidence references are canonical evidence records (subject type `ugc_production`, resolved through the bootstrap `SubjectLookup` extension). The UGC boundary only VALIDATES references — it never fabricates evidence (AC-05). |
| `/outcomes` | UNTOUCHED: no observations/measured outcomes/experiments (state-unchanged proof + import pins). |
| `/settlement` | UNTOUCHED: compensation terms are declared reference data only (no economic mutation surface; import + identifier pins). |
| `/reputation` | UNTOUCHED: referenced profile versions are read-only (import + identifier pins). |
| `/disputes` | Read-only safety gate in the auto-accept evaluation (the W016 neutral lookup). The engagement lifecycle carries NO BLOCKED/FRAUD_REVIEW/DISPUTED states. |
| `/llm` | UNTOUCHED: NET-W017 adds NO AI path (no LlmPort import, no purpose extension, no advisory input to the evaluation engine — structural pins). |
| `/adapters` | Provider-neutral external platform references (`{provider, externalId, url?}` — opaque strings) on deliverables; no provider SDK semantics, no credentials (AC-06). |

## 3. Acceptance-criteria → test → changed-file map

| AC | Suite (all green) | Primary changed files |
|---|---|---|
| AC-01 engagements accepted + executed through `/workflows`, no parallel lifecycle | `tests/creators/net-w017-ac-01-workflow-lifecycle.test.ts` (15 tests) | `src/core/workflow.ts`, `src/workflows/transition-table.ts`, `src/workflows/workflow-service.ts`, `src/workflows/port.ts`, `src/creators/engagement-service.ts`, `src/creators/engagement-engine.ts` |
| AC-02 production/submission records preserve lineage + deterministic versioning | `tests/creators/net-w017-ac-02-production-lineage.test.ts` (10 tests) | `src/creators/engagement-service.ts`, `src/creators/authority-engagement-repositories.ts`, `src/creators/port.ts` |
| AC-03 rights explicit, scoped, auditable, enforceable (expiry/revocation) | `tests/creators/net-w017-ac-03-usage-rights.test.ts` (8 tests) | `src/core/creators.ts`, `src/creators/engagement-engine.ts`, `src/creators/engagement-service.ts` |
| AC-04 producing UGC implies no ownership/publication authority | `tests/creators/net-w017-ac-04-ownership-boundary.test.ts` (7 tests) | `src/core/creators.ts` (`USAGE_RIGHTS_OWNERSHIP`), `src/creators/engagement-service.ts` |
| AC-05 evidence capture integrates canonical authorities + provenance | `tests/creators/net-w017-ac-05-evidence-integration.test.ts` (8 tests) | `src/creators/engagement-service.ts`, `src/bootstrap/runtime.ts` (subject lookup extension) |
| AC-06 provider-neutral adapters + secret isolation | `tests/creators/net-w017-ac-06-provider-neutrality.test.ts` (7 tests) | `src/creators/port.ts`, `src/creators/engagement-service.ts` |
| AC-07 architecture/out-of-scope regression | `tests/regression/net-w017-ac-07-architecture-out-of-scope.test.ts` (12 tests) | (pins across all files) |
| AC-08 idempotency, concurrency, tenancy, PostgreSQL authority, audit lineage | `tests/creators/net-w017-ac-08-tenancy-idempotency.test.ts` (11 tests) | `src/creators/engagement-service.ts`, `src/creators/authority-engagement-repositories.ts`, `src/api/server.ts`, `src/api/port.ts` |

Additional changed files: `src/creators/index.ts`,
`src/creators/module.ts`, `src/bootstrap/runtime.ts` (wiring),
`tests/creators/_net-w017-harness.ts`, and the refined regression
pins in `tests/regression/net-w016-ac-07-architecture-out-of-scope.test.ts`
(the W016 matching-implementation pin is scoped to the matching
section — the shared `/creators` port legitimately gained the W017
engagement contracts; the refinement preserves the original intent,
the W016→W015 refinement precedent).

## 4. Verification

`bun run verify` — typecheck + `arch:check` + `authority:check` +
the full unit suite including the eight NET-W017 suites above. The
dev/test PostgresAuthorityShim provides the authority boundary
(the NET-W003 established pattern; real-PostgreSQL integration runs
in CI).

## 4a. Remediation — composite atomicity (architect CHANGES REQUESTED on PR #34)

**Blocking issue (architect):** the composites committed their
material mutation and the workflow transition as SEPARATE
authoritative transactions; the second could fail after the first
committed (an orphaned ACTIVE usage-rights grant / production /
submission for a lifecycle state that never occurred).

**Decision of record (the architect's PREFERRED option — single
authoritative transaction):**

- `/workflows` gained `requestTransitionWithinTx` — the in-tx
  composition twin executing the SHARED `performTransition` machinery
  (one state machine; `/workflows` remains the sole lifecycle
  authority) inside a CALLER-OPENED transaction. Contract: the caller
  opened the tx via `applyIdempotent`, owns per-subject serialization,
  and passes its composite `ctx.recordId` for audit lineage.
- `acceptEngagement`/`autoAcceptEngagement` (grant + READY→ASSIGNED),
  `openProduction` (production + ASSIGNED→IN_PROGRESS) and
  `submitProduction` (submission + IN_PROGRESS→SUBMITTED) each run in
  ONE `applyIdempotent`: material record + audit + in-tx fresh state
  precondition + twin transition + one idempotency record commit
  atomically. Invariant → enforcement:
  - "no orphaned grant/production/submission can exist" → structural:
    there is no second transaction to fail (fault-injection proves
    each failure point rolls back EVERYTHING);
  - "the split composite cannot be reintroduced" → AC-07 pins the
    bare `workflow.requestTransition(` ABSENT from the engagement
    service + exactly three `requestTransitionWithinTx` calls.
- `createEngagementsFromMatch` became a JOURNAL-FIRST recoverable
  saga: the batch record is created RUNNING before any offer; every
  processed candidate appends a create-once journal row; unexpected
  failure marks ABORTED (machine-readable failure point) and
  rethrows; the same-key retry resumes (journaled candidates skipped)
  and finalizes COMPLETED with the journal-derived snapshot
  (ABORTED→COMPLETED is the sanctioned recovery edge). The audit
  lineage records batch.recorded → batch.aborted → batch.completed.
- Fault-injection evidence:
  `tests/creators/net-w017-remediation-composite-atomicity.test.ts`
  (5 tests) — the three transition-failure points, the authoritative
  COMMIT failure (wrapped-authority rebuild), retry convergence after
  each, and the batch abort/recovery cycle.

## 5. Out-of-scope confirmation

No sponsorship/disclosure execution (NET-W018), no ad inventory or
exchange (NET-W019+), no external payment execution, no new
reputation scoring or input, no outcome observation/measurement, no
risk case creation, no second workflow engine or local status
machine, no direct bypass of any frozen authority, no AI-assisted
acceptance/rights/publication/settlement/reputation mutation, no
provider SDK semantics in the domain. Architecture v1.0 and
`architecture-lock.md` are unchanged (regression-pinned).
