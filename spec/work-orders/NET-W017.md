# NET-W017 — UGC workflow and rights

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** CRE-003, CRE-004, CRE-005 (spec/requirements.md)
**Dependencies:** NET-W016 (creator matching), NET-W011 (campaign policy), NET-W014 (settlement references) — all merged
**Tracking:** issue #33 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Turn the NET-W016 eligible match into a creator engagement that is
executed through the canonical lifecycle authority, produces UGC with
explicit provenance and deterministic versioning, and grants usage
rights as durable, auditable, revocable records — WITHOUT the
protocol ever taking ownership of creator channels:

```text
Creator matching            (NET-W016 run — referenced lineage,
        ↓                    never re-ranked or mutated here)
Engagement offer            (explicit requested rights/terms,
        ↓                    campaign + profile + match lineage)
Acceptance                  (creator manual OR deterministic
        ↓                    auto-accept policy — CRE-003)
Usage rights grant          (explicit scope/channels/territory/
        ↓                    duration/uses; ownership ALWAYS
                            creator-retained — CRE-004)
UGC production              (deliverables, deterministic versions,
        ↓                    provider-neutral external references)
Submission + evidence       (canonical /evidence records,
        ↓                    validated subject-bound references)
Verification                (lifecycle terminal — measurement and
                             settlement stay with /outcomes and
                             /settlement)
```

The engagement/production lifecycle is the canonical `/workflows`
machinery (a NEW subject kind — exactly the Proof-of-Value and
measured-outcome precedent). NET-W017 introduces NO second lifecycle
authority, NO second state machine in `/creators`, NO economic
mutation, NO reputation mutation, NO risk mutation, and NO
measurement fabrication.

## §2 Authority separation (the decision of record)

NET-W017 lives inside the existing `/creators` boundary (the frozen
Phase-5 Creator boundary — NO 17th domain; the architecture-lock
domain list is unchanged and regression-pinned). Every authority
boundary stays exactly where the architecture puts it:

- `/workflows` — lifecycle authority: the engagement is a NEW
  canonical lifecycle subject kind (`"engagement"`) whose transition
  table lives in `src/workflows/transition-table.ts` and whose
  transitions execute ONLY through the existing
  `WorkflowService.requestTransition` (authorization, idempotency,
  optimistic concurrency, coordination lock, transactional audit).
  The `/creators` domain services validate business preconditions
  and REQUEST transitions through the provider-neutral delegation
  callback — the sanctioned pattern every lifecycle-owning domain
  already uses. The `WorkflowsPort` audit namespace gains
  `engagement` (additive).
- `/campaigns` — campaign policy authority: the engagement references
  a campaign (+ pinned policy version) resolved read-only through a
  neutral `EngagementCampaignLookup` (a thin composition-root adapter
  over the campaign repository, extending the W016 lookup precedent
  with the administrative status read the tender precondition
  needs). The campaigns domain is NOT modified.
- `/creators` (NET-W015/016 contracts) — creator identity and
  matching inputs: the engagement validates the creator profile
  (ACTIVE administrative status), the pinned profile version, and —
  when a match run is referenced — that the creator was an ELIGIBLE
  candidate of that run (read-only lineage verification; the run is
  never mutated).
- `/evidence` — truth authority: submission evidence references are
  canonical evidence records created through the canonical
  `EvidenceService` (subject type `"ugc_production"`, subject-bound
  through the neutral `SubjectLookup` extension wired at the
  composition root). The UGC boundary NEVER fabricates evidence or
  truth; every submission evidence id is validated (existence +
  organization scope + subject binding) before the submission
  transition is requested.
- `/outcomes` — measurement authority: UNTOUCHED. The UGC boundary
  creates no observations, no measured outcomes, no experiments. A
  VERIFIED engagement is a referencable subject for later
  measurement work items; NET-W017 fabricates no measurement
  (regression-pinned structurally).
- `/settlement` — economic authority: UNTOUCHED. Offer compensation
  terms are DECLARED REFERENCE DATA only (a reward-policy reference
  and/or declared rate terms). NET-W017 creates no economic units,
  commitments, ledger entries, or rewards.
- `/disputes` — risk-control authority: the auto-accept evaluation
  READS the active-control registry through the neutral safety
  lookup (the W016 precedent) — an active `participant_eligibility`
  control on the creator person is a hard auto-accept gate. The
  engagement lifecycle deliberately carries NO
  BLOCKED/FRAUD_REVIEW/DISPUTED states: risk escalation on an
  engagement is a `/disputes` case referencing the engagement, not a
  local lifecycle branch.
- `/identity` + `/participants` — identity/authorization: engagement
  actors are canonical persons; commands are authorized server-side
  (API guard actions `creators.engagements.*`,
  `creators.productions.*`, `creators.usageRights.*`,
  `creators.acceptancePolicy.set`); transition policy actions are
  `engagement.transition.*` (derived by the shared
  `policyActionFor`); tenant isolation is enforced on every read.
- `/llm` — UNTOUCHED. NET-W017 adds NO AI path: acceptance,
  production, rights and submission are fully deterministic; there
  is no advisory input anywhere in this work item (the matching
  advisory remains NET-W016's bounded, non-authoritative blend).

## §3 Scope

### §3.1 The engagement lifecycle (AC-01)

A NEW canonical subject kind `"engagement"` (core vocabulary +
transition table + workflow-service routing + an
`AuthorityEngagementRepository` in `/creators` exposing the
`LifecycleRepository` structural surface):

```text
DRAFT       offer recorded (campaign + creator + requested rights
            + optional match/opportunity lineage)
  → READY   offer tendered (campaign must be ACTIVE)
  → ASSIGNED  engagement accepted (manual acceptance OR the
            deterministic auto-accept policy evaluation)
  → IN_PROGRESS  production opened (the UGC production record)
  → SUBMITTED  deliverables + canonical evidence tendered
  → VERIFIED   terminal: submission verified
SUBMITTED → REJECTED  terminal: submission rejected
DRAFT/READY/ASSIGNED/IN_PROGRESS/SUBMITTED → CANCELLED  terminal
```

- Every transition executes through `WorkflowService.requestTransition`
  (per-subject authorization, idempotency, optimistic concurrency,
  coordination lock, transactional audit lineage — the SOLE lifecycle
  authority). Pure transitions (tender, verify, reject, cancel) are
  requested through the EXISTING generic transition endpoint; composed
  commands (accept, auto-accept, production open, submit) validate
  domain preconditions then request the same transitions.
- The engagement RECORD is static after creation except the lifecycle
  fields the workflow service owns (the Opportunity/Contribution
  precedent): acceptance details, grants, productions, deliverables
  and submissions are separate append-only records referencing the
  engagement.
- Creation is serialized by the advisory-lock unique-anchor
  `engagement_anchor:{organizationScopeId}:{campaignId}:{creatorPersonId}`
  (the W015 creator-anchor remediation precedent): at most ONE
  non-terminal engagement may exist per (org, campaign, creator);
  a concurrent duplicate create is rejected with a stable conflict
  error even when the idempotency keys differ.

### §3.2 Deterministic auto-accept (CRE-003, AC-01)

A versioned `CreatorAcceptancePolicy` record per
(organizationScopeId, creatorPersonId) — append-only versions, the
latest is effective. A PURE evaluation engine
(`src/creators/engagement-engine.ts`) evaluates an offer against the
policy + pinned profile facts + the safety read + the open-engagement
count. Qualification is the conjunction of gates with a CLOSED
reason vocabulary (`AUTO_ACCEPT_GATE_REASONS`):

- `policy_not_auto_accept` — the effective policy is manual;
- `policy_not_found` — no acceptance policy recorded for the creator;
- `profile_not_active` — the creator profile administrative status
  is not ACTIVE;
- `not_accepting_work` — availability.acceptingWork = false;
- `too_many_active_engagements` — the creator's non-terminal
  engagement count ≥ policy.maxActiveEngagements;
- `rate_below_floor` — the offer's declared compensation for a
  requested format is below the policy floor (currency + unit +
  format matched);
- `rights_not_auto_grantable` — a requested usage-rights kind is not
  in the policy's autoGrantableRights;
- `grant_duration_exceeds_policy` — the requested grant duration
  exceeds policy.maxGrantDurationDays;
- `active_risk_control` — the safety lookup reports an active
  `participant_eligibility` control on the creator person.

The evaluation is deterministic (identical inputs → identical
verdict + trace) and is RECORDED: the acceptance transition metadata
+ audit event carry the mode (`manual`/`auto`), the policy version
and the gate trace. A non-qualifying evaluation performs NO
mutation. Auto-match orchestration composes the same machinery: a
batch command turns ONE match run's eligible candidates into DRAFT
offers atomically (per-candidate duplicate/conflict outcomes are
recorded, never silently dropped).

### §3.3 Usage rights — explicit, scoped, revocable (AC-03/AC-04)

A `UsageRightsGrant` is an append-only, tenant-scoped, immutable
record created ONLY by an acceptance (manual or auto):

- **scope**: the granted `formats` (media/content scope — the frozen
  `CREATOR_CONTENT_FORMATS` vocabulary), `uses` (permitted uses — the
  frozen `CREATOR_RIGHTS_KINDS` vocabulary, each with optional
  human-readable terms), `channels` (the closed
  `USAGE_RIGHTS_CHANNELS` vocabulary:
  `creator_owned_channel`/`organizer_channel`/`network_channel`/
  `paid_media`), `territories` (ISO-3166-style codes) and
  `exclusions` (explicit exclusions);
- **duration**: `startsAt`/`endsAt` (explicit license window);
- **envelope**: the granted set MUST be a subset of the
  engagement's requested rights on every dimension (uses, channels,
  territories, formats; the duration window within the requested
  window) — an acceptance can only grant what the offer requested;
- **ownership boundary (CRE-004)**: `contentOwnership` is frozen to
  `"creator_retained"` — the ONLY value in
  `USAGE_RIGHTS_OWNERSHIP`; the grant input carries NO ownership
  field at all (there is structurally no code path that transfers
  ownership of creator content or channels to the protocol);
- **publication boundary**: producing UGC NEVER mints a grant —
  grants exist only through explicit acceptance, and publication on
  `creator_owned_channel` requires an explicit grant containing the
  `channel_publication` use kind scoped to that channel. A
  production/submission record with NO grant confers NO usage
  rights whatsoever;
- **revocation**: the grantor (creator) may append ONE revocation
  record (`revokeUsageRights`; grantor-only actor check; a second
  revocation is a stable conflict). Revocation carries an explicit
  `effectiveAt`;
- **expiry**: the EFFECTIVE status is DERIVED, never stored:
  `REVOKED` when a revocation exists and `asOf ≥ effectiveAt`;
  `EXPIRED` when `asOf > endsAt`; `ACTIVE` otherwise. Reads accept
  an optional `asOf` (deterministic evaluation at any time).

### §3.4 UGC production, deliverables, submission (AC-02/AC-05)

- `openProduction` — creates the `UgcProduction` record (creator /
  campaign / pinned policy version / optional opportunity +
  contribution lineage; the engagement MUST be ASSIGNED and covered
  by an ACTIVE-as-of-now usage-rights grant) and requests
  ASSIGNED → IN_PROGRESS.
- `recordDeliverable` — appends an IMMUTABLE `UgcDeliverableVersion`:
  per `(productionId, deliverableKey)` the version number is the
  monotonically increasing count (deterministic versioning —
  recorded under the production advisory lock so concurrent
  recordings cannot fork the sequence). Each version carries the
  content format, an optional provider-neutral content reference
  and an optional provider-neutral external-platform reference
  (`{ provider, externalId, url? }` — opaque strings; NO provider
  SDK semantics in the domain).
- `submitProduction` — appends the `UgcSubmission` record and
  requests IN_PROGRESS → SUBMITTED. Preconditions: ≥1 recorded
  deliverable version; ≥1 evidence reference; EVERY evidence id
  resolves through the canonical evidence authority to THIS
  production (existence + organization scope + subject binding
  `{ subjectType: "ugc_production", subjectId: productionId }`).
  The submission preserves the full lineage (creator, engagement,
  campaign, opportunity/contribution references, evidence ids) and
  execution/correlation/causation identifiers.

### §3.6 Composite atomicity — the remediation decision of record

Architect review on PR #34 returned CHANGES REQUESTED with one blocking
issue: the composites (`acceptEngagement`, `openProduction`,
`submitProduction`) performed their material mutation and the workflow
transition as SEPARATE authoritative transactions — the second could
fail after the first committed, leaving e.g. a durable ACTIVE
usage-rights grant for an engagement still in READY (the orphaned-grant
scenario), or an orphaned production/submission.

**The implemented solution (the architect's PREFERRED option): the
coupled material record and the lifecycle transition participate in the
SAME authoritative transaction.**

1. `/workflows` exposes `requestTransitionWithinTx` — the in-tx
   composition twin of `requestTransition`. It executes the EXACT SAME
   machinery (in-tx re-read, `expectedVersion` optimistic concurrency,
   deny-by-default authorization, pure state-machine evaluation,
   `saveWithinTx`, buffered transactional audit) inside a
   CALLER-OPENED `AuthorityTransaction`. One state machine, no
   divergent copy: `/workflows` REMAINS the sole lifecycle authority.
   The twin performs no lock acquisition and no idempotency
   bookkeeping of its own — the composite caller owns both (the port
   contract documents the three caller obligations).
2. Each composite runs inside ONE `applyIdempotent` keyed per command
   (`engagement_accept:` / `ugc_production:` / `ugc_submission:`):
   the material record + its audit append + the in-tx state
   precondition (fresh re-read) + the twin transition + the single
   composite idempotency record commit as ONE authoritative unit. A
   failure at ANY point — grant/production/submission write, audit
   append, transition rejection (authorization, state machine, stale
   version), or the authoritative COMMIT itself — rolls back
   EVERYTHING. No partial commit can survive; no compensating
   transaction or saga is needed for these commands.
3. The auto-match batch (`createEngagementsFromMatch`) is an explicitly
   recoverable JOURNAL-FIRST saga (per-candidate offers remain
   individually idempotent commits):
   - the batch decision record is created FIRST (`status: RUNNING`,
     empty snapshot);
   - every processed candidate APPENDS a create-once journal row
     (`outcome:{batchId}:{profileId}`);
   - an unexpected failure marks the record ABORTED with the
     machine-readable failure point and RETHROWS — the journal
     accurately describes every candidate processed so far;
   - a same-key retry resumes deterministically: journaled candidates
     are skipped, unprocessed ones execute, the finalize transitions
     the record to COMPLETED with the journal-derived snapshot
     (ABORTED → COMPLETED is the sanctioned recovery edge; COMPLETED
     can never be aborted).
   No durable offer can exist without its batch journal accurately
   describing it.

Fault-injection evidence (`tests/creators/net-w017-remediation-composite-atomicity.test.ts`):
accept / open / submit transition failures each leave NOTHING
(no record, no audit, no idempotency record, state+version unchanged);
the deepest point (authoritative COMMIT failure) leaves NOTHING; every
retry converges deterministically; the batch saga abort + same-key
recovery completes with an exact journal (recorded → aborted →
completed, each exactly once). Regression pins (AC-07) make the
split-transaction composite structurally impossible to reintroduce
(the bare `workflow.requestTransition(` call is pinned ABSENT from the
engagement service; exactly three `requestTransitionWithinTx` calls).

### §3.5 API surface

- `POST /api/creators/engagements` — create an offer (guard
  `creators.engagements.create`);
- `POST /api/creators/engagements/from-match` — auto-match batch
  from a match run (guard `creators.engagements.createFromMatch`);
- `POST /api/creators/engagements/:id/accept` — manual acceptance
  with the granted usage rights (guard `creators.engagements.accept`);
- `POST /api/creators/engagements/:id/auto-accept` — deterministic
  auto-accept evaluation + execution (guard
  `creators.engagements.autoAccept`);
- `POST /api/creators/engagements/:id/productions` — open production
  (guard `creators.productions.open`);
- `POST /api/creators/productions/:id/deliverables` — record a
  deliverable version (guard `creators.productions.deliverable`);
- `POST /api/creators/productions/:id/submission` — submit with
  canonical evidence references (guard `creators.productions.submit`);
- `POST /api/creators/usage-rights/:id/revocation` — revoke a grant
  (guard `creators.usageRights.revoke`);
- `POST /api/creators/acceptance-policy` — set the next acceptance
  policy version (guard `creators.acceptancePolicy.set`);
- pure lifecycle transitions (tender / verify / reject / cancel) —
  the EXISTING `POST /api/workflows/transitions` endpoint with
  subjectKind `engagement` (the Proof-of-Value precedent);
- reads: `GET /api/creators/engagements/:id`,
  `GET /api/creators/engagements?organizationScopeId…`,
  `GET /api/creators/productions/:id`,
  `GET /api/creators/productions/:id/deliverables`,
  `GET /api/creators/usage-rights/:id`,
  `GET /api/creators/usage-rights?organizationScopeId&engagementId`,
  `GET /api/creators/acceptance-policy?organizationScopeId&creatorPersonId`
  — all tenant-scoped (cross-scope = indistinguishable from
  nonexistent).

## §4 Key invariants (issue #33)

1. Creator acceptance/production is represented through the canonical
   `/workflows` lifecycle authority (new subject kind; NO parallel
   lifecycle machinery anywhere in `/creators`).
2. UGC records are first-class, tenant-scoped, immutable/versioned
   where material, and linked to the creator,
   opportunity/contribution and evidence lineage.
3. Rights are explicit rather than implicit: scope, territory,
   duration, channels, permitted uses and exclusions are persisted
   and auditable.
4. OpenCon does not obtain ownership/control of creator channels
   merely because UGC is produced through the protocol.
5. Evidence capture references the canonical `/evidence` /
   `/outcomes` authorities; the UGC domain cannot fabricate truth or
   measurement.
6. External platform execution remains behind provider-neutral
   adapter boundaries; credentials stay behind secrets/adapters.
7. AI/model output remains advisory and cannot itself authorize
   acceptance, rights, publication, settlement or reputation
   mutation (NET-W017 adds NO AI path at all).
8. Economic consequences use `/settlement`; no parallel payment or
   ledger state is introduced (compensation terms are declared
   reference data only).
9. Tenant isolation, server-side authorization, idempotency,
   concurrency safety, PostgreSQL authority and transactional audit
   lineage hold.

## §5 Explicit non-goals

No sponsorship/disclosure EXECUTION beyond the prerequisite
provider-neutral references (NET-W018), no ad inventory or exchange
(NET-W019+), no external payment execution or reward payout, no new
reputation scoring or input, no outcome observation/measurement, no
risk case creation, no second workflow engine or local status
machine in `/creators`, no direct bypass of `/workflows`,
`/evidence`, `/outcomes`, `/settlement`, `/disputes` or `/adapters`
authority, no AI-assisted acceptance or rights evaluation, no
provider SDK semantics in the domain.

## §6 Acceptance-criteria → test map

| AC | Suite | Proves |
|---|---|---|
| 01 | tests/creators/net-w017-ac-01-workflow-lifecycle.test.ts | engagements transition through `/workflows` (every legal transition incl. manual + auto acceptance, production open, submission, verify/reject/cancel); illegal transitions rejected with stable codes; optimistic concurrency; the transition table is the ONLY lifecycle machinery (no local status machine in `/creators`); auto-accept determinism + full gate trace + closed reason vocabulary |
| 02 | tests/creators/net-w017-ac-02-production-lineage.test.ts | production records preserve creator/opportunity/contribution/evidence lineage; deliverable versions are immutable, monotonic and deterministic (concurrent recordings serialize — no forked sequences); submission requires ≥1 deliverable + validated canonical evidence references |
| 03 | tests/creators/net-w017-ac-03-usage-rights.test.ts | grants are explicit/scoped/auditable; envelope subset validation; expiry semantics (derived EXPIRED past endsAt); revocation semantics (grantor-only, one revocation, derived REVOKED at/after effectiveAt, prospective-only evaluation); deterministic effective status at any asOf |
| 04 | tests/creators/net-w017-ac-04-ownership-boundary.test.ts | producing UGC mints NO rights and NO ownership; contentOwnership frozen to creator_retained (no input path to transfer); channel publication on creator-owned channels requires an explicit channel_publication grant scoped to creator_owned_channel; a grantless production confers nothing |
| 05 | tests/creators/net-w017-ac-05-evidence-integration.test.ts | submission evidence ids must resolve through the canonical evidence authority with the exact subject binding; cross-scope / wrong-subject / nonexistent evidence references are rejected; evidence records are created through the canonical evidence service (subject type ugc_production); provenance (execution/correlation lineage) preserved end-to-end; the UGC boundary fabricates no outcome/measurement |
| 06 | tests/creators/net-w017-ac-06-provider-neutrality.test.ts | external platform references are opaque provider-neutral strings (no SDK semantics in the domain); secrets never enter the creators boundary; channel/territory/format vocabularies are closed and validated |
| 07 | tests/regression/net-w017-ac-07-architecture-out-of-scope.test.ts | arch:check + authority:check 0 violations; frozen specs unchanged; frozen W015/W016 vocabularies pinned UNCHANGED + new W017 vocabulary pinned; no workflow/settlement/reputation/risk/outcome mutation surface in the engagement boundary; no LLM import in the W017 surface; file list; secret scan |
| 08 | tests/creators/net-w017-ac-08-tenancy-idempotency.test.ts | tenant-scoped reads (cross-scope = NotFoundError); idempotent replays of every command (created=false, byte-identical records); concurrent duplicate engagement creation rejected through the advisory-lock anchor; HTTP surface (403/400/404/201) |
| remediation | tests/creators/net-w017-remediation-composite-atomicity.test.ts | §3.6 composite atomicity by fault injection: accept/open/submit transition failures commit NOTHING (no record, no audit, no idempotency record; state+version unchanged); the authoritative COMMIT failure commits NOTHING; every retry converges deterministically; the batch saga aborts with an exact journal and the same-key retry resumes → COMPLETED |

## §7 Verification

`bun run verify` — typecheck + arch:check + authority:check + full
unit suite (the net-w017 suites included). The dev/test
PostgresAuthorityShim provides the authority boundary without a real
PostgreSQL (the NET-W003 established pattern; real-PostgreSQL
integration runs in CI).
