# NET-W021 — Campaign matching and optimization

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** CAMP-001..003, AI-002..003 (spec/requirements.md)
**Dependencies:** NET-W006 (outcomes), NET-W007 (reputation), NET-W009 (fraud/risk), NET-W019 (inventory/placements) — all merged
**Tracking:** issue #42 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Optimize campaign-to-inventory/creator matching under hard policy
constraints using evidence-backed measured performance. Matching is
**selection, not authority** — the architect-pinned pipeline:

```text
hard eligibility gates            (§3.1 — BEFORE any ranking or
        ↓                          advisory; ineligible options are
evidence-backed feature           never ranked)
        ↓
deterministic baseline ranking    (§3.2 — advisory-off ordering)
        ↓
bounded AI advisory optimization  (§3.3 — AI-002 matching + AI-003
        ↓                          risk analysis; each ≤ 25%)
explainable candidate ordering    (§3.4 — baseline + final ranks,
                                   per-signal inputs, digest)
```

Definition of done: **hard constraints are enforced first; only
eligible options are ranked; performance signals are
evidence-backed.** AI must never override a hard restriction, risk
hold, tenant boundary, rights constraint, or settlement-readiness
requirement. The optimizer must NOT become a second authority over
campaign policy, supply, creator rules, reputation, risk, lifecycle
or economics: its ONLY write is its own append-only, idempotent,
tenant-scoped match-run record with transactional audit lineage.

## §2 Authority separation (the decision of record)

NET-W021 lives INSIDE the existing `/campaigns` boundary (the
campaign is the matching SUBJECT — a campaign-domain rule; the
W016 creator-matching precedent inverted). NO 17th domain; the
architecture-lock domain list is unchanged and regression-pinned.
Every authority boundary stays exactly where the architecture puts
it:

- `/inventory` — supply + placement + eligibility-rule-semantics
  authority: candidates are W019 INVENTORY ITEMS (creator supply
  enters through `surfaceKind "creator"` items — the W019
  unified-supply decision; /creators matching stays its own
  authority and W015/W016 are deliberately NOT dependencies).
  Candidate enumeration, the already-placed set and the
  POLICY-RULE EVALUATION arrive through the neutral
  `CampaignMatchSupplyLookup` — a thin composition-root adapter over
  the inventory repositories + the W019 PURE eligibility engine
  (`evaluatePlacementEligibility`). Matching never re-implements
  eligibility semantics: the engine is THE rule-semantics authority.
- `/outcomes` — measurement authority: performance evidence is the
  VERIFIED measured outcomes subject-scoped to the supply option,
  read through the neutral `CampaignMatchOutcomeLookup` over the
  authority's NEW additive read
  (`listVerifiedMeasuredOutcomesBySubject` — only lifecycle-VERIFIED
  measurements are evidence; DRAFT/MEASURING/CANCELLED are not; the
  lifecycle semantics stay in /outcomes, the transition table is
  untouched). Item-subject measured outcomes require the composition
  root's measurement subject lookup to recognize `inventory_item`
  subjects (the W019 PoV-lookup precedent — read-only).
- `/reputation` — trust-signal authority: the standing/reliability/
  risk signals resolve the owner person's LATEST canonical snapshots
  (surface-kind → standing-dimension mapping frozen in
  core/campaigns.ts) read-only through the neutral
  `CampaignMatchReputationLookup`; the digest is pinned on the run
  so the evidence base is reproducible. Matching never computes,
  stores or mints a score.
- `/disputes` — risk-control authority: the owner risk gate is READ
  through the neutral `CampaignMatchSafetyLookup` (the W016
  precedent: ACTIVE `participant_eligibility` HOLD/BLOCK is a HARD
  gate). Matching never creates, supersedes or resolves a control.
- `/campaigns` — campaign policy authority + the matching domain
  rule: the service loads its OWN campaign records read-only (the
  subject), enforces CAMP-002 (ACTIVE campaign with a pinned
  in-scope policy version — fail-closed), merges the policy's
  POSITIVE region/language rules into the effective targeting, and
  derives the required outcome types from the policy's outcome
  requirements.
- `/workflows` — lifecycle authority: UNTOUCHED. A match run is not
  a lifecycle subject; it is a completed, immutable decision record
  (no status machine — the W016 run-record precedent).
- `/settlement` — economic authority: UNTOUCHED. A match run creates
  NO economic state, NO commitments, NO ledger entries.
- `/llm` — provider-neutral AI execution: TWO bounded advisory
  consultations wired at the composition root over `LlmPort.score` —
  AI-002 (purpose `"matching"`, rubric `campaign-matching:…`, blends
  `alignment`) and AI-003 (purpose `"safety"`, rubric
  `campaign-matching-risk:…`, blends `risk`). Each consulted ONLY
  for already-eligible candidates, each capped at a 25% blend,
  provider identity recorded on the run, and structurally unable to
  flip a gate (see §3.3).

## §3 Scope

### §3.1 The deterministic hard eligibility gates (AC-01)

A pure engine (`src/campaigns/matching-engine.ts`) evaluates, per
candidate supply option, the hard gates over the neutral supply view
+ the policy-rule evaluation + the safety read. Every applicable gate
is evaluated (no short-circuit — complete traces); eligibility is
the conjunction. The closed reason vocabulary is
`CAMPAIGN_MATCH_GATE_REASONS` (core/campaigns.ts):

- `campaign_not_publishable` — the campaign status is not ACTIVE
  (CAMP-002: policy defined and activated before matching — a
  run-level fail-closed constraint, not a per-candidate gate);
- `policy_version_unresolved` — the pinned policy version does not
  resolve (run-level, fail-closed);
- `policy_scope_out_of_tenant` — the resolved policy version is
  outside the caller's organization scope (run-level, fail-closed);
- `item_out_of_scope` — defensive: the candidate item's org scope
  must equal the run's (the lookups are already org-scoped);
- `item_retired` — the supply's one-way retirement is set;
- `supply_not_verified` — the item carries no supply-verification
  evidence (the W019 settlement-readiness `supply_available`
  component);
- `eligibility_rules_not_satisfied` — the pinned policy's
  eligibility rules, evaluated by the /inventory authority's OWN
  pure engine over the item's declared supply attributes
  (region/language are supply-carried — the W019 semantics
  unchanged);
- `format_not_targeted` / `surface_kind_not_targeted` — explicit
  targeting excludes the item's format/surface kind;
- `territory_not_reached` / `language_not_supported` — the item
  reaches none of the (explicit ∪ campaign-derived) target
  territories / required languages;
- `owner_risk_control` — an ACTIVE `participant_eligibility`
  HOLD/BLOCK control covers the supply owner.

The settlement-readiness mapping (the W019 contract): an ELIGIBLE
candidate satisfies every settlement-readiness component decidable
pre-placement (registered owner + supply available + policy scope +
eligibility satisfied); `placement_active` is post-placement by
definition — the matching output is a placement-ready ordering, and
execution remains the W019 placement command's authority.

### §3.2 Evidence-backed feature extraction + baseline ranking (AC-02/AC-04)

The six explicit signals (closed vocabulary
`CAMPAIGN_MATCH_SIGNALS`), each scored 0–100 deterministically with a
machine-readable explanation naming the inputs used:

- `alignment` — territory + language overlap depth against the
  effective targeting (the binary format/surface fit is a HARD GATE;
  alignment measures the depth of the remaining fit);
- `performance` — the VERIFIED measured-outcome evidence for the
  policy's required outcome types, min-max normalized per type
  across THIS RUN's evidence holders (ranking semantics — the
  absolute evidence values, ids and confidence are recorded in the
  signal inputs). Absent evidence yields NO performance credit
  (adversarially safe: raw observations, still-maturing or cancelled
  measurements never influence the ranking);
- `standing` — the owner's canonical reputation score for the
  surface-kind dimension (creator → `creator_performance`,
  publisher/app → `inventory_quality` — the frozen mapping);
- `reliability` — the owner's `measurement_reliability` score;
- `risk` — the owner's `fraud_resistance` score (the HARD hold/block
  gate carries the control semantics; the signal keeps the
  six-signal contract uniform — the W016 safety-signal precedent);
- `coverage` — the share of required outcome types with VERIFIED
  evidence (evidence completeness, distinct from magnitude).

Weights are explicit (`CampaignMatchWeights`: six integers 0–100
summing to EXACTLY 100), defaulting to the canonical profile
(alignment 25, performance 30, standing 15, reliability 10, risk 10,
coverage 10 — evidence-backed performance carries the largest
share). The BASELINE ordering (advisory off) is totalScore DESC then
itemId ASC — a deterministic total order.

### §3.3 The bounded AI advisory optimization (AC-03)

TWO provider-neutral consultations per ELIGIBLE candidate (wired at
the composition root over `LlmPort.score`):

- AI-002 matching assessment (purpose `"matching"`) blends into
  `alignment`: `alignment' = (1 − blend) × alignment + blend ×
  assessment.score`;
- AI-003 fraud/risk ANALYSIS (purpose `"safety"`) blends into `risk`:
  `risk' = (1 − blend) × risk + blend × assessment.score`;

with `blend = maxWeight/100 ≤ CAMPAIGN_MATCH_ADVISORY_MAX_BLEND`
(0.25) each, independently configurable and disabled by default (a
disabled advisory is pure-deterministic). Inputs are
privacy-minimized neutral facts (campaign requirement labels + the
item's PUBLIC aggregate supply facts + evidence PRESENCE booleans +
reputation-snapshot PRESENCE booleans) — NO owner identity, NO
reputation scores, NO evidence values, NO digests, NO external
references (the W013/W016 privacy-minimized precedent,
regression-pinned bit-for-bit). The run records per-kind usage, the
blend, the provider and the modelRef. STRUCTURALLY the advisories can
never override a hard restriction: hard-gated candidates are
excluded before either advisory is ever consulted, the blends adjust
ranking signals only, and `evaluateEligibility` has no advisory
parameter (regression-pinned: no advisory value can reach the
verdict code).

**§3.3a Per-candidate advisory recording (the PR #43 review
remediation — the decision of record).** The persisted
`CampaignMatchCandidateResult.advisory` is the faithful record of
THAT candidate's own matching and risk assessments, resolved by
inventory item id from the per-candidate assessment maps
(`buildCandidateResults(ranked, matchingByItem, riskByItem,
placedItemIds)`) — NEVER a run-level or top-candidate projection. The
run-level `advisory` block remains a SUMMARY: `used` reflects the
consultations actually made; `provider`/`modelRef` are the
advisory-source identity shared by EVERY consultation of that purpose
in the run (uniform under the single-adapter wiring), and `null` when
none were consulted or the assessments diverge (a divergent run
cannot be faithfully summarized by one value — the per-candidate
results carry the faithful identities). Regression-pinned: ≥2
eligible candidates with intentionally distinct assessments preserve
their distinct scores/provider/modelRef per candidate (both purposes,
matching and risk); the digest/recomputation suite pins that the
per-candidate advisory metadata is digest-covered, so a future
refactor that collapses it back to a single run-level value can no
longer reproduce the stored digest.

### §3.4 The match-run record — selection, not authority (AC-04/05/06)

`runCampaignMatch` — the single material command:

- validates the request (organization scope, person actor, targeting
  against the frozen inventory vocabularies, weights sum, advisory
  caps, idempotency key, the candidate cap of 200);
- resolves the campaign subject (own domain, read-only): ACTIVE
  status (CAMP-002 fail-closed) + the pinned in-scope policy version;
- merges the effective targeting (explicit ∪ the policy's POSITIVE
  region/language rules) and derives the required outcome types;
- derives the run's SINGLE deterministic evaluation anchor
  (`evaluatedAt`) at the service boundary (the W019 `nowIso()`
  precedent) — every /inventory rule evaluation in the run receives
  this EXPLICIT anchor (the composition-root adapter NEVER consults
  wall-clock time), and the anchor is recorded on the run record as
  part of the decision; it is NOT digested (wall-clock identity —
  re-runs of identical decision content stay bit-for-bit
  reproducible) — the PR #43 review remediation;
- enumerates candidates (the org's non-retired supply by default, or
  an explicit tenant-scoped item-id list — cross-scope is
  indistinguishable from nonexistent) + the already-placed set;
- assembles facts through the NEUTRAL lookups (policy-rule
  evaluation, reputation resolution, safety read, outcome evidence);
- runs the pure engine (gates → baseline signals → optional advisory
  blends → final signals → baseline/final orderings);
- persists ONE append-only `CampaignMatchRunRecord`
  (targeting + required outcome types + weights + advisory config
  and metadata + ranked results with per-signal explanations,
  baseline/final scores, ranks and rank deltas + excluded candidates
  with closed-vocabulary reasons + deterministic SHA-256 digest over
  the canonical 1-decimal serialization) — idempotent
  (`campaign_match_run:{org}:{key}`), transactionally audited
  (`campaign_match.recorded`), PostgreSQL-authoritative;
- re-running identical inputs replays the committed run
  (created = false, byte-identical record).

Reads: `getMatchRun` / `listMatchRuns` — tenant-scoped (a
cross-scope run id is indistinguishable from a nonexistent one).

NO OTHER MUTATION EXISTS in the matching boundary — no inventory
item/placement mutation, no campaign record or policy mutation, no
workflow transition, no economic unit, no reputation input/snapshot,
no risk signal/control, no outcome record (regression-pinned
structurally + behaviorally).

### §3.5 API surface

- `POST /api/campaigns/matching` — run a match (guard action
  `campaigns.matching.run`; idempotency key required);
- `GET /api/campaigns/matching` — list an org's runs (optionally
  filtered by campaignId);
- `GET /api/campaigns/matching/:id` — fetch one run (tenant-scoped;
  cross-scope is 404).

## §4 Key invariants (issue #42)

1. Hard constraints are enforced before ranking: ineligible options
   are never ranked, consulted by AI, or recommended.
2. Only eligible options are ranked; the ordering is a deterministic
   total order with a stable tie-break and a reproducible digest.
3. Performance signals are evidence-backed: verified measured
   outcomes and canonical reputation snapshots only, with recorded
   evidence bases; absence of evidence yields no performance credit.
4. AI output is advisory only: bounded blends into ranking signals,
   consulted only for already-eligible candidates, provider identity
   recorded, never an eligibility authority, never able to override
   a hard restriction, risk hold, tenant boundary, rights
   constraint, or settlement-readiness requirement.
5. A match run mutates no campaign, inventory, workflow, settlement,
   reputation, risk or outcome state; the only mutation is the
   append-only, idempotent, tenant-scoped run record and its audit
   event.
6. Reputation and outcomes are referenced read-only through neutral
   interfaces; eligibility-rule semantics remain owned by the
   inventory authority.
7. Tenant isolation, server-side authorization, idempotency,
   concurrency safety, PostgreSQL authority and transactional audit
   lineage hold.
8. Frozen architecture and architecture-lock remain unchanged.

## §5 Explicit non-goals

No placement creation/retirement EXECUTION (NET-W019 commands remain
the only placement authority), no attribution/privacy measurement
adapters (NET-W022), no OpenRTB/ads.txt integration (NET-W023), no
auto-execution or auto-acceptance of match results, no new economic
state, no lifecycle subjects, no direct reputation scoring or
mutation, no opaque AI eligibility, no blockchain consensus, no
economic mutation of any kind.

## §6 Acceptance-criteria → test map

| AC | Suite | Proves |
|---|---|---|
| 01 | tests/campaigns/net-w021-ac-01-hard-gates.test.ts | every hard gate fails with its closed-vocabulary reason; conjunction semantics + complete traces (engine-level); the run-level CAMP-002 constraints fail closed (no partial run); risk holds exclude; no existence oracle; deterministic verdicts |
| 02 | tests/campaigns/net-w021-ac-02-evidence-ranking.test.ts | only eligible options ranked; six explicit signals with exact deterministic scores; weights validation (sum 100); deterministic total order + stable tie-break; VERIFIED-only outcome evidence; digest-pinned reputation bases; per-signal machine-readable explanations |
| 03 | tests/campaigns/net-w021-ac-03-advisory-non-authority.test.ts | both advisories disabled by default; echo-reproducible blends with provider identity; ≤25% caps; only-eligible consultation (spy); privacy-minimized neutral facts (pinned bit-for-bit); no score can flip eligibility or override a hold (structural); REGRESSION (PR #43): the persisted per-candidate advisory is each candidate's OWN assessment (distinct score/provider/modelRef per candidate, both purposes — never a top-candidate projection); REGRESSION (PR #43): every inventory-rule evaluation receives the run's SINGLE recorded evaluation anchor |
| 04 | tests/campaigns/net-w021-ac-04-optimization-adversarial.test.ts | the optimization fixture (evidence-backed performers outrank unevidenced supply under identical constraints); baseline + final orderings with rank deltas; adversarial raw/matiring observations never influence; alreadyPlaced explainability; run-relative normalization with recorded bounds |
| 05 | tests/campaigns/net-w021-ac-05-selection-not-authority.test.ts | a run writes ONLY the run record + one audit event (before/after counts + state assertions across campaign/inventory/outcomes/reputation); byte-identical side-effect-free replays; structural no-mutation-surface scan |
| 06 | tests/campaigns/net-w021-ac-06-tenancy-idempotency-contract.test.ts | tenant-scoped reads (cross-scope = NotFoundError); person-actor requirement; policy-version pinning; digest determinism + recomputability; the pinned run-record contract (incl. the recorded evaluation anchor); the HTTP surface (403/201/created=false/400/404/200); REGRESSION (PR #43): the digest covers the PER-CANDIDATE advisory metadata (per-candidate echo recomputation + swap/mutation sensitivity — a top-candidate collapse cannot reproduce the stored digest) |
| 07 | tests/regression/net-w021-ac-07-architecture-out-of-scope.test.ts | authority guard 0 violations; frozen specs unchanged; frozen vocabularies pinned UNCHANGED + the new matching vocabulary pinned; no mutation surface + no cross-domain imports in the matching boundary; advisory cannot reach the eligibility evaluator (structural); provider-neutral wiring; the /outcomes change is read-only; no NET-W022/W023 leakage; file list; secret scan |

## §7 Verification

`bun run verify` — typecheck + arch:check + authority:check + full
unit suite (the net-w021 suites included). The dev/test
PostgresAuthorityShim provides the authority boundary without a real
PostgreSQL (the NET-W003 established pattern; real-PostgreSQL
integration runs in CI).
