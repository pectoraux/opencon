# NET-W016 — Creator matching (evidence document)

**Work item:** NET-W016 (issue #31) · **Architecture:** v1.0 FROZEN ·
**Requirements:** CRE-002, AI-002 · **Dependencies:** NET-W006, NET-W007, NET-W015 (all merged)

## What shipped

NET-W016 turns the NET-W015 creator profile into **deterministic
campaign eligibility**. It ships INSIDE the frozen `/creators`
boundary (no 17th domain; the architecture-lock domain list is
unchanged and regression-pinned):

- `src/creators/matching-engine.ts` — the PURE, DETERMINISTIC engine:
  19 hard-gate evaluations over a closed reason vocabulary
  (`CREATOR_MATCH_GATE_REASONS`), the six explicit CRE-002 signal
  scores (0–100, 1-decimal rounding), the capped advisory blend into
  `relevance`, the deterministic total order (totalScore DESC, then
  profileId ASC) and the SHA-256 canonical digest.
- `src/creators/matching-service.ts` — the domain service: request
  validation (closed vocabularies, weights sum, advisory cap,
  credential/raw-audience key guards), read-only campaign linkage
  resolution, tenant-scoped candidate enumeration, reputation
  reference re-verification + read-only score resolution, safety
  reads, engine orchestration, the privacy-minimized advisory input
  builder, and the idempotent append-only run-record commit with the
  `creator_match.recorded` audit event.
- `src/creators/authority-match-run-repository.ts` — the
  PostgreSQL-authoritative run-record repository
  (`creator_match_runs` collection; created-once decision records).
- Additive vocabulary in `src/core/creators.ts` (signals, gate
  reasons, format lineage, weight/default/advisory caps, band-rank
  helpers, validators) and additive port types in
  `src/creators/port.ts`.
- `src/llm/port.ts`: the `LlmScoringInput.purpose` union gains
  `"matching"` (AI-002 — the provider-neutral advisory path).
- Composition-root wiring (`src/bootstrap/runtime.ts`): three thin
  READ-ONLY lookups (campaign policy, reputation snapshots, the
  `participant_eligibility` risk-control registry) + the advisory
  adapter over `LlmPort.score` (purpose `"matching"`, provider
  identity preserved).
- API surface (`src/api/server.ts` + `src/api/port.ts`):
  `POST /api/creators/matching` (guard `creators.matching.run`),
  `GET /api/creators/matching` (list, optional campaign filter),
  `GET /api/creators/matching/:id` (tenant-scoped read).
- `spec/work-orders/NET-W016.md` — the work order (the decision of
  record for authority separation).

## The decision of record: matching is selection, not authority

- `/campaigns` stays the campaign policy authority: requirements are
  DERIVED READ-ONLY from a PINNED policy version through the neutral
  `CreatorMatchCampaignLookup` (language/region eligibility rules →
  requiredLanguages/targetTerritories; the campaigns domain is
  untouched).
- `/reputation` stays the trust-signal authority: profile-version
  references are re-verified (existence + org scope + subject person
  + pinned digest + frozen dimension) and their canonical dimension
  scores are RESOLVED READ-ONLY through the neutral
  `CreatorMatchReputationLookup`.
- `/disputes` stays the risk-control authority: safety is a READ over
  the active-control registry (`participant_eligibility`); an active
  HOLD/BLOCK is a hard gate (`active_risk_control`).
- `/workflows` and `/settlement` are untouched: a match run creates
  NO lifecycle subject and NO economic state. Rate ceilings and price
  signals are declared data consumed read-only.
- AI (AI-002) is ADVISORY ONLY: consulted exclusively for
  already-eligible candidates, blending only into `relevance` under
  `CREATOR_MATCH_ADVISORY_MAX_BLEND = 0.25`, provider identity
  recorded on the run, structurally unable to flip any hard gate
  (`evaluateEligibility` has no advisory parameter — there is no code
  path from advisory output to an eligibility verdict).

## Key design decisions

1. **Hard gates before ranking.** Eligibility is the conjunction of
   19 closed-vocabulary gates; every applicable gate is evaluated
   (complete traces); hard restrictions can never be overridden by
   model ranking because ranking operates exclusively on the eligible
   set.
2. **Explicit signals with explicit weights.** The six CRE-002
   signals score deterministically (documented formulas; 1-decimal
   rounding); weights are integers summing to exactly 100 (canonical
   default 30/20/20/10/10/10); every signal explanation names the
   inputs used (coverage fractions, canonical snapshot ids + scores,
   cheapest qualifying rate, capacity/notice).
3. **The run record is the unit of decision.** One append-only,
   idempotent, tenant-scoped `CreatorMatchRunRecord` pins the
   effective requirements (explicit ∪ campaign-derived), weights,
   advisory metadata, ranked results, excluded candidates and a
   SHA-256 digest over the canonical serialization — re-running the
   same inputs reproduces the digest bit-for-bit; a pinned campaign
   policy version never rewrites under later versions.
4. **Privacy-minimized advisory input.** The neutral-fact label set
   is closed (10 labels: campaign requirement labels + creator PUBLIC
   aggregate facts). NO rates, NO restricted topics, NO reputation
   scores, NO identity material ever reach the provider
   (regression-pinned bit-for-bit; the W013 mention-exclusion
   precedent).

## The additive vocabulary (the only shared-baseline additions)

`core/creators.ts`: `CREATOR_MATCH_SIGNALS`,
`CREATOR_MATCH_GATE_REASONS`, `CREATOR_MATCH_FORMAT` ("NET-W016:1"),
`CREATOR_MATCH_WEIGHT_SUM` (100), `CREATOR_MATCH_ADVISORY_MAX_BLEND`
(0.25), `CREATOR_MATCH_MAX_CANDIDATES` (200),
`CREATOR_MATCH_DEFAULT_WEIGHTS`, `creatorAudienceSizeBandRank`,
`creatorEngagementBandRank`, `InvalidCreatorMatchError`,
`validateCreatorMatchWeights`,
`validateCreatorMatchAdvisoryMaxWeight`,
`validateCreatorMatchReputationThreshold`. `llm/port.ts`: the purpose
union gains `"matching"`. No frozen vocabulary changed
(regression-pinned).

## Invariant → enforcement map (issue #31)

| Invariant | Enforcement |
|---|---|
| 1. Determinism | 1-decimal rounding everywhere; canonical digest; AC-01 determinism test; AC-06 digest tests |
| 2. Hard restrictions never overridden by model ranking | `evaluateEligibility(facts, requirements)` has no advisory parameter (structural, pinned); advisory consulted only post-verdict (pinned order); AC-03 spy proof |
| 3. AI advisory, never authority | disabled by default; ≤ 25% blend into relevance only; provider identity recorded; bounded-influence proof (AC-03); privacy-minimized input (AC-03) |
| 4. No workflow/settlement/reputation/risk mutation | the only write is the run record + `creator_match.recorded`; audit-ledger before/after proof (AC-04); structural pins (AC-07) |
| 5. Reputation referenced, never duplicated | reference re-verification + read-only score resolution; bit-for-bit canonical-score flow into signals (AC-02) |
| 6. Safety through the canonical registry | `participant_eligibility` control read; active HOLD/BLOCK hard gate (AC-01); control survives runs unchanged (AC-04) |
| 7. Provider-neutral, pinned campaign requirements | neutral campaign lookup; policy version pinned on the run; later versions never rewrite a pin (AC-06) |
| 8. Tenancy/idempotency/PostgreSQL/audit | tenant-scoped reads (no existence oracle); idempotent byte-identical replays; authority repository; transactional audit lineage (AC-05, AC-06) |

## API surface

- `POST /api/creators/matching` — run a match (protected;
  `creators.matching.run`; idempotent; 201 + `created` flag).
- `GET /api/creators/matching?organizationScopeId[&campaignId]` —
  list runs (tenant-scoped).
- `GET /api/creators/matching/:id?organizationScopeId` — fetch one
  run (400 missing scope; 404 cross-scope; 200 same-scope).

## Acceptance-criteria → test mapping

| AC | Suite |
|---|---|
| 01 | tests/creators/net-w016-ac-01-eligibility.test.ts (19 tests) |
| 02 | tests/creators/net-w016-ac-02-ranking-explanation.test.ts (9 tests) |
| 03 | tests/creators/net-w016-ac-03-advisory-non-authority.test.ts (6 tests) |
| 04 | tests/creators/net-w016-ac-04-selection-not-authority.test.ts (6 tests) |
| 05 | tests/creators/net-w016-ac-05-tenancy-idempotency.test.ts (8 tests) |
| 06 | tests/creators/net-w016-ac-06-matching-contract.test.ts (5 tests) |
| 07 | tests/regression/net-w016-ac-07-architecture-out-of-scope.test.ts |

The NET-W015 AC-07 regression was refined (not weakened): the
"no AI path in the creators domain" pin became "no opaque AI/LLM
AUTHORITY" — the provider-neutral injected advisory port is now in
scope per the NET-W016 work order §3.3, while the LLM import ban,
reputation-mutation bans and the new ADVISORY-FREE eligibility
evaluator pin preserve the W015 intent ("AI cannot establish creator
eligibility") with sharper precision.

## Verification

`bun run verify` — typecheck + arch:check + authority:check + the
full unit suite (the net-w016 suites included). The dev/test
PostgresAuthorityShim provides the authority boundary; real
PostgreSQL/Redis integration runs in CI.

## Out of scope (confirmed)

No auto-match/auto-accept EXECUTION (CRE-003 — NET-W017), no UGC
production workflow or rights EXECUTION (NET-W017), no
sponsorship/disclosure EXECUTION (NET-W018), no ad inventory or
optimization (NET-W019+), no invitation/engagement lifecycle
(/workflows authority), no external platform execution, no direct
reputation scoring or mutation, no payment/settlement execution, no
opaque AI eligibility, no blockchain consensus.
