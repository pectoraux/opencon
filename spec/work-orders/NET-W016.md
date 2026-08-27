# NET-W016 — Creator matching

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** CRE-002, AI-002 (spec/requirements.md)
**Dependencies:** NET-W006 (outcomes), NET-W007 (reputation), NET-W015 (creator identity/preferences) — all merged
**Tracking:** issue #31 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Turn the NET-W015 creator profile into deterministic campaign
eligibility. Matching is **selection, not authority**: it computes
an eligible candidate set ranked by explicit signals with
explanations — and NOTHING else:

```text
Campaign requirements        (explicit provider-neutral data,
        +                      optionally derived read-only from a
Creator profile               pinned campaign policy version)
        +
Reputation references        (canonical /reputation snapshots —
        +                      verified + resolved read-only)
Availability / rights /
participation rules          (the versioned profile sections)
        ↓
Deterministic eligibility    (hard gates, closed reason vocabulary)
        ↓
Candidate set                (eligible creators only)
        ↓
Ranking / explanation        (six explicit CRE-002 signals, weights,
                               per-signal input trace, stable order)
```

The matching boundary performs NO mutation of workflow, settlement,
reputation or risk state. Its ONLY write is its own append-only,
idempotent, tenant-scoped match-run record with transactional audit
lineage (the record-of-decision pattern — the run pins exactly what
was evaluated so the selection is reproducible).

## §2 Authority separation (the decision of record)

NET-W016 lives inside the existing `/creators` boundary (the frozen
Phase-5 Creator boundary — NO 17th domain; the architecture-lock
domain list is unchanged and regression-pinned). Every authority
boundary stays exactly where the architecture puts it:

- `/campaigns` — campaign policy authority: matching may REFERENCE a
  pinned campaign policy version through the neutral
  `CreatorMatchCampaignLookup` (a thin composition-root adapter over
  the campaign policy repository). The lookup derives a
  provider-neutral creator-requirements view (language/territory
  eligibility rules, objective kinds, budget declaration) — the
  matching engine never imports campaign semantics and the campaigns
  domain is NOT modified.
- `/reputation` — trust-signal authority: profile-version reputation
  REFERENCES are re-verified at match time (existence + org scope +
  subject person + pinned digest) and their canonical dimension
  scores are RESOLVED READ-ONLY through the neutral
  `CreatorMatchReputationLookup`. Matching never computes, stores,
  mints or mutates a reputation score.
- `/disputes` — risk-control authority: safety is READ through the
  neutral `CreatorMatchSafetyLookup` (a thin composition-root adapter
  over the risk-control registry's `participant_eligibility` gate
  read). An active control (HOLD/BLOCK) is a HARD eligibility gate.
  Matching never creates, supersedes or resolves a control.
- `/workflows` — lifecycle authority: UNTOUCHED. A match run is not
  a lifecycle subject; engagements/invitations are NET-W017 concerns
  that would go through /workflows. The run record has NO status
  machine (it is a completed, immutable decision record).
- `/settlement` — economic authority: UNTOUCHED. Rate ceilings and
  price signals are declared data consumed read-only; a match run
  creates NO economic state, NO commitments, NO ledger entries.
- `/identity` + `/participants` — identity/authorization: candidates
  are existing creator profiles (already anchored to canonical
  persons); match commands are authorized server-side (the API guard
  action `creators.matching.run`); tenant isolation is enforced on
  every read.
- `/llm` — provider-neutral AI execution: the AI-assisted matching
  path (AI-002) is an injected provider-neutral advisory port wired
  at the composition root over `LlmPort.score` (purpose
  `"matching"`). The advisory is consulted ONLY for already-eligible
  candidates, blends ONLY into the relevance signal under an
  explicit capped weight, records its provider identity on the run,
  and can NEVER flip a hard gate (structural — see §3.3).

## §3 Scope

### §3.1 The deterministic eligibility gates (AC-01)

A pure engine (`src/creators/matching-engine.ts`) evaluates, per
candidate, the hard gates over the pinned profile version's
sections + the resolved reputation scores + the safety read. Every
gate yields a CLOSED-VOCABULARY reason when it fails
(`core/creators.ts`: `CREATOR_MATCH_GATE_REASONS`):

- `no_profile_version` — the profile has no versioned sections yet;
- `profile_not_active` — administrative status ≠ ACTIVE;
- `not_accepting_work` — availability.acceptingWork = false;
- `no_capacity` — weeklyCapacity ≤ 0;
- `notice_window_exceeded` — minimumNoticeDays > the request's
  noticeWindowDays (when provided);
- `direct_campaigns_not_accepted` — participation.acceptsDirectCampaigns = false;
- `invitation_required` — participation.requiresInvitation = true;
- `format_unsupported` — a required format is not offered by any
  platform connection;
- `format_restricted` — a required format is in the creator's
  restrictedFormats;
- `language_unsupported` — a required language is not published by
  any platform connection;
- `territory_unsupported` — target territories do not intersect the
  audience's topGeographies (when targets are declared);
- `territory_restricted` — a target territory is in the creator's
  restrictedTerritories;
- `topic_restricted` — a campaign topic matches a restricted topic
  (case-insensitive exact match);
- `rights_not_granted` — a required rights kind is not granted;
- `rate_exceeds_ceiling` — no rate for a required format within the
  declared ceiling (currency + unit) when a ceiling is declared;
- `audience_band_below_minimum` — audience sizeBand rank below the
  declared floor (when declared);
- `reputation_reference_unresolvable` — a reputation reference fails
  re-verification at match time (missing snapshot, scope/subject
  mismatch, or pinned-digest mismatch);
- `reputation_below_minimum` — a resolved canonical score is below
  the declared role threshold (when declared);
- `active_risk_control` — the safety lookup reports an active
  `participant_eligibility` control on the creator person.

Eligibility is the conjunction of all gates; verdicts carry the full
per-gate trace (passed or failed+reason), and evaluation is
short-circuit-free over the gate list so the trace is complete.

### §3.2 Ranking by explicit signals (AC-02)

The six CRE-002 signals, each scored 0–100 deterministically with a
machine-readable explanation naming the inputs used:

- `relevance` — coverage of required formats, coverage of required
  languages, and audience-territory alignment (share of the audience
  in target territories, capped at 100; 100 when no targets are
  declared), averaged;
- `audience_quality` — engagement-band ordinal blended 50/50 with the
  canonical `audience_influence` reference score;
- `historic_outcomes` — the canonical `production` reference score;
- `safety` — 100 when no active control (held creators are already
  ineligible — the gate carries the semantics; the signal keeps the
  six-signal contract uniform and inspectable);
- `price` — affordability headroom against the declared rate ceiling
  (lowest qualifying rate for a required format within the ceiling
  currency/unit: 100 × (ceiling − rate)/ceiling, clamped to [0,
  100]; 100 when no ceiling is declared);
- `availability` — capacity headroom (min(100, weeklyCapacity × 25)).

Weights are explicit: a `CreatorMatchWeights` profile over the six
signals (integers 0–100, summing to EXACTLY 100), defaulting to the
canonical profile (relevance 30, audienceQuality 20,
historicOutcomes 20, safety 10, price 10, availability 10). The
total score is Σ(score × weight)/100. The ranked order is
totalScore DESC, then profileId ASC — a deterministic total order.
Per-candidate explanations carry each signal's score, weight,
contribution and the inputs used.

### §3.3 AI-assisted matching — advisory, never authority (AC-03)

The provider-neutral advisory (`CreatorMatchAdvisory`, wired at the
composition root over `LlmPort.score` with purpose `"matching"`):

- consulted ONLY for candidates that already passed every hard gate;
- blends ONLY into the `relevance` signal:
  `relevance' = (1 − blend) × relevance + blend × advisory` with
  `blend = advisoryMaxWeight/100 ≤ CREATOR_MATCH_ADVISORY_MAX_BLEND`
  (0.25);
- its input is a MINIMAL neutral-fact set (campaign requirement
  labels + creator PUBLIC aggregate facts: platform kinds, format
  capabilities, languages, audience size/engagement bands, top
  geographies with aggregate shares) — NO rates, NO restricted
  topics, NO reputation scores, NO identity material (the
  W013 privacy-minimized advisory-input precedent, regression-pinned
  bit-for-bit);
- the run records whether the advisory was used, the blend, the
  provider and the modelRef (provider identity preserved — any
  provider's output enters identically, with identity recorded);
- with the advisory disabled (the default), ranking is pure
  deterministic;
- STRUCTURALLY, the advisory can never override a hard restriction:
  hard-gated candidates are excluded before the advisory is ever
  consulted, and the advisory only adjusts a ranking signal within
  the capped blend — there is no code path from advisory output to
  an eligibility verdict.

### §3.4 The match-run record — selection, not authority (AC-04/05/06)

`runMatch` — the single material command:

- validates the request (organization scope, provider-neutral
  requirements against the frozen vocabularies, weights sum, advisory
  cap, idempotency key);
- resolves the campaign linkage (when declared) through the neutral
  campaign lookup: the pinned policy version must exist within the
  caller's organization scope (cross-scope = indistinguishable from
  nonexistent), and its derived language/territory requirements are
  UNIONED with the explicit ones;
- enumerates candidates (the org's ACTIVE profiles by default, or an
  explicit tenant-scoped profile-id list);
- re-verifies reputation references and resolves canonical scores
  read-only; reads safety through the neutral lookup;
- runs the pure engine (gates → signals → optional advisory blend →
  ranking);
- persists ONE append-only `CreatorMatchRunRecord` (requirements +
  weights + advisory metadata + ranked results with per-signal
  explanations + excluded candidates with reasons + deterministic
  SHA-256 digest over the canonical serialization) — idempotent
  (`creator_match_run:{org}:{key}`), transactionally audited
  (`creator_match.recorded`), PostgreSQL-authoritative;
- re-running identical inputs replays the committed run
  (created = false, byte-identical record).

Reads: `getMatchRun` / `listMatchRuns` — tenant-scoped (a cross-scope
run id is indistinguishable from a nonexistent one).

NO OTHER MUTATION EXISTS in the matching boundary — no workflow
transition, no economic unit, no reputation input/snapshot, no risk
signal/control (regression-pinned structurally + behaviorally).

### §3.5 API surface

- `POST /api/creators/matching` — run a match (guard action
  `creators.matching.run`; idempotency key required);
- `GET /api/creators/matching` — list an org's runs (optionally
  filtered by campaignId);
- `GET /api/creators/matching/:id` — fetch one run (tenant-scoped).

## §4 Key invariants (issue #31)

1. Determinism: identical inputs produce identical verdicts,
   rankings and digests.
2. Hard restrictions cannot be overridden by model ranking.
3. AI output is advisory evidence only — never the eligibility
   authority.
4. Matching mutates no workflow/settlement/reputation/risk state.
5. Reputation is referenced, verified and resolved read-only from
   the canonical authority — never recomputed or duplicated.
6. Safety is read through the canonical risk-control registry; an
   active `participant_eligibility` hold is a hard gate.
7. Campaign requirements are provider-neutral explicit data,
   traceable to a pinned campaign policy version.
8. Tenant isolation, authorization, idempotency, concurrency safety,
   PostgreSQL authority and audit lineage hold.

## §5 Explicit non-goals

No auto-match/auto-accept EXECUTION (CRE-003 — NET-W017), no UGC
production workflow or rights EXECUTION (NET-W017), no
sponsorship/disclosure EXECUTION (NET-W018), no ad inventory or
optimization (NET-W019+), no invitation/engagement lifecycle
(/workflows authority), no external platform EXECUTION, no direct
reputation scoring or mutation, no payment/settlement EXECUTION, no
opaque AI eligibility, no blockchain consensus, no economic mutation
of any kind.

## §6 Acceptance-criteria → test map

| AC | Suite | Proves |
|---|---|---|
| 01 | tests/creators/net-w016-ac-01-eligibility.test.ts | every hard gate fails with its closed-vocabulary reason; conjunction semantics; deterministic identical-input verdicts; per-gate trace |
| 02 | tests/creators/net-w016-ac-02-ranking-explanation.test.ts | six explicit signals with exact deterministic scores; weights validation (sum 100); total order + stable tie-break; per-signal explanations naming inputs |
| 03 | tests/creators/net-w016-ac-03-advisory-non-authority.test.ts | advisory consulted only for eligible candidates; blend capped; provider identity recorded; hard-gated creators never ranked regardless of advisory; disabled advisory = pure deterministic; neutral-fact input pinned bit-for-bit (no rates/restrictions/reputation/identity in the LLM input) |
| 04 | tests/creators/net-w016-ac-04-selection-not-authority.test.ts | a run mutates NO workflow/settlement/reputation/risk state (before/after record counts + state assertions); the only writes are the run record + audit event; re-runs are side-effect-free |
| 05 | tests/creators/net-w016-ac-05-tenancy-idempotency.test.ts | tenant-scoped reads (cross-scope = NotFoundError); campaign cross-scope resolution refused; idempotent replays (created=false, byte-identical); run persistence + list + audit lineage |
| 06 | tests/creators/net-w016-ac-06-matching-contract.test.ts | the run-record contract: shape stability, digest determinism, campaign policy-version pinning, excluded-candidate explanations |
| 07 | tests/regression/net-w016-ac-07-architecture-out-of-scope.test.ts | arch:check + authority:check 0 violations; frozen specs unchanged; frozen vocabularies pinned UNCHANGED + new matching vocab pinned; no workflow/settlement/reputation/risk mutation surface in the matching boundary; file list; secret scan |

## §7 Verification

`bun run verify` — typecheck + arch:check + authority:check + full
unit suite (the net-w016 suites included). The dev/test
PostgresAuthorityShim provides the authority boundary without a real
PostgreSQL (the NET-W003 established pattern; real-PostgreSQL
integration runs in CI).
