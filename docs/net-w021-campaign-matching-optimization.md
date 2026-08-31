# NET-W021 — Campaign matching and optimization (evidence)

**Work order:** spec/work-orders/NET-W021.md · **Issue:** #42 · **PR:** the canonical implementation PR closing #42
**Status:** implemented; `bun run verify` green (typecheck + arch:check + authority:check + the full suite).

## What shipped

The campaign-side matching/optimization boundary (the W016
creator-matching precedent, inverted: the CAMPAIGN is the matching
subject; W019 inventory items are the candidate SUPPLY — creator
supply enters through `surfaceKind "creator"` items, the W019
unified-supply decision):

```text
hard eligibility gates          campaign ACTIVE + pinned in-scope policy (CAMP-002),
        ↓                        supply verified + not retired, policy eligibility
                                 rules (the /inventory engine), targeting
                                 (format/surface/territory/language), risk holds
evidence-backed feature         VERIFIED measured outcomes (per required outcome
        ↓                        type) + canonical reputation (standing/reliability/
                                 fraud_resistance) + alignment depth + coverage
deterministic baseline ranking  six explicit weighted signals (sum 100), total
        ↓                        order (score DESC, itemId ASC)
bounded AI advisory             AI-002 matching (blends alignment) + AI-003
        ↓                        risk analysis (blends risk), each ≤ 25%,
                                 only-eligible, provider recorded
explainable candidate ordering  baseline + final ranks with deltas, per-signal
                                 inputs, digest, run record + audit event
```

- `src/core/campaigns.ts` — the additive NET-W021 vocabulary:
  `CAMPAIGN_MATCH_SIGNALS`, `CAMPAIGN_MATCH_GATE_REASONS`,
  `CAMPAIGN_MATCH_FORMAT` ("NET-W021:1"), weight/advisory/candidate
  caps, `CAMPAIGN_MATCH_DEFAULT_WEIGHTS`, the frozen
  surface-kind → standing-dimension mapping, the validators,
  `InvalidCampaignMatchError`.
- `src/campaigns/matching-engine.ts` — the PURE engine: gates
  (conjunction, complete traces), the evidence-backed baseline
  scoring (VERIFIED-only, min-max per required type across the run's
  evidence holders), the advisory blends (alignment + risk only),
  the baseline/final orderings, the result views, the SHA-256
  digest (canonical 1-decimal serialization).
- `src/campaigns/matching-service.ts` — all I/O: request validation,
  the campaign subject (own domain, read-only, CAMP-002 fail-closed),
  the effective-targeting merge (explicit ∪ the policy's positive
  region/language rules), candidate enumeration + fact assembly
  through the neutral lookups, the advisory consultations
  (only-eligible), the idempotent + transactionally-audited run
  record (`campaign_match.recorded`).
- `src/campaigns/authority-match-run-repository.ts` — the
  `campaign_match_runs` collection (append-only decision records).
- `src/outcomes/port.ts` + `measured-outcome-service.ts` +
  `authority-measured-outcome-repository.ts` — the additive
  READ-ONLY verified-performance surface
  (`listVerifiedMeasuredOutcomesBySubject` + repository
  `listBySubject`); the lifecycle + transition table are untouched.
- `src/bootstrap/runtime.ts` — the composition-root wiring: the four
  neutral lookups (supply over the inventory repositories + the W019
  PURE eligibility engine; reputation over the latest snapshots;
  safety over the `participant_eligibility` control registry;
  outcomes over the verified-performance read), the two LlmPort
  advisory adapters (purposes `"matching"` + `"safety"`), the run
  repository, the service, the apiCommands + view builder, and the
  `inventory_item` measurement-subject extension (the W019
  PoV-lookup precedent).
- `src/api/port.ts` + `src/api/server.ts` — the three routes
  (`POST /api/campaigns/matching` guarded by
  `campaigns.matching.run`; the two tenant-scoped GETs, placed
  BEFORE the generic `/api/campaigns/:id` route so the exact paths
  win).

## Design decisions (the decision of record)

1. **The optimizer lives in `/campaigns`** (architecture §18:
   campaign-domain rule — the campaign is the matching subject).
   NO 17th domain; matching is selection, not authority: the ONLY
   write is the append-only run record + its audit event.
2. **Candidates are W019 inventory items** (unified supply). Creator
   supply enters through `surfaceKind "creator"` items — W015/W016
   are deliberately NOT dependencies of W021 (the frozen dependency
   graph); the /creators matching boundary stays untouched.
3. **The policy-eligibility-rule evaluation delegates to the
   /inventory authority's PURE engine** through a neutral lookup
   (bootstrap imports `evaluatePlacementEligibility`; the campaigns
   domain sees only the interface). Matching never re-implements
   eligibility semantics — no second eligibility authority.
4. **Performance evidence = VERIFIED measured outcomes
   subject-scoped to the supply option** (the /outcomes authority
   owns "which states are evidence"). Item-subject measurements
   required extending the composition root's measurement subject
   lookup with `inventory_item` (the W019 evidence-subject
   precedent). Absence of evidence yields NO performance credit —
   adversarially safe (raw observations, still-maturing or
   cancelled measurements never influence ranking).
5. **Performance normalization is run-relative min-max** per
   required outcome type across the run's evidence holders, with
   the absolute evidence values + run bounds recorded in the signal
   inputs (ranking semantics with a reproducible explanation).
6. **TWO bounded advisory consultations** (AI-002 purpose
   `"matching"` → blends `alignment`; AI-003 purpose `"safety"` →
   blends `risk`), each independently ≤ 25%, disabled by default,
   only-eligible, provider-identity-recorded, privacy-minimized
   (aggregate supply facts + evidence PRESENCE + snapshot PRESENCE
   booleans — no owner identity, no scores, no evidence values).
   `evaluateEligibility` has NO advisory parameter — no advisory
   value can reach the verdict code (regression-pinned).
7. **Baseline ordering recorded alongside the final ordering** —
   every result carries baselineScore/score per signal,
   baselineTotalScore/totalScore, baselineRank/rank: the AI
   contribution is auditable per candidate (the pipeline's
   "deterministic baseline ranking → bounded AI advisory
   optimization → explainable candidate ordering" made inspectable).
8. **The settlement-readiness mapping** (the W019 contract): an
   ELIGIBLE candidate satisfies every settlement-readiness component
   decidable pre-placement (registered owner, supply available,
   policy scope, eligibility satisfied); `placement_active` is
   post-placement by definition. Execution (placement creation)
   remains the W019 command's authority — the run NEVER places.

## Invariant → enforcement map

| Invariant (issue #42) | Enforcement |
|---|---|
| 1. Hard constraints before ranking | gates are evaluated for every candidate before any advisory/scoring; excluded options are never ranked (AC-01/03); `evaluateEligibility` has no advisory parameter (AC-07 structural pin) |
| 2. Only eligible options ranked, deterministic total order | the engine scores only the eligible facts; order = totalScore DESC then itemId ASC; SHA-256 digest at 1-decimal canonical precision (AC-02/06) |
| 3. Performance signals evidence-backed | VERIFIED-outcome reads only (the /outcomes authority filter); reputation via the canonical latest snapshots (digest-pinned); no-evidence → no credit (AC-02/04 adversarial) |
| 4. AI advisory only, bounded, recorded, never authority | ≤25% blends into alignment/risk only; only-eligible consultation (spy-proven); provider+modelRef recorded; echo-reproducible; hard-gated candidates never consulted (AC-03) |
| 5. Selection not authority | the only writes are the run record + `campaign_match.recorded` (before/after counts across campaign/inventory/outcomes/reputation + the audit-ledger witness); structural no-mutation-surface scan (AC-05/07) |
| 6. Reputation/outcomes read-only through neutral interfaces; eligibility semantics owned by /inventory | the neutral lookups + the engine delegation (AC-07 wiring pins); the /outcomes change is a read-only addition with the transition table untouched (AC-07) |
| 7. Tenancy/authorization/idempotency/audit lineage | org-scoped lookups + cross-scope NotFound (no existence oracle); person-actor requirement; `applyIdempotent` + `forTransaction(tx)` audit; byte-identical replays (AC-05/06) |
| 8. Frozen architecture | no new domain; additive vocabulary only; every pre-existing frozen vocabulary pinned UNCHANGED (AC-07) |

## API surface

- `POST /api/campaigns/matching` — body: organizationScopeId,
  campaignId, policyVersion?, targeting? (requiredFormats/
  requiredSurfaceKinds/targetTerritories/requiredLanguages),
  candidateInventoryItemIds?, weights?, advisory? ({matching:{enabled,
  maxWeight}, risk:{enabled, maxWeight}}), idempotencyKey. Guarded
  (`campaigns.matching.run`); 403 unauthenticated; 201 with
  { run, created }.
- `GET /api/campaigns/matching?organizationScopeId[&campaignId]` —
  the org's runs (400 without scope).
- `GET /api/campaigns/matching/:id?organizationScopeId` — one run
  (404 cross-scope/unknown).

## AC → test mapping

| AC | Suite (all green) | Tests |
|---|---|---|
| 01 | tests/campaigns/net-w021-ac-01-hard-gates.test.ts | 11 |
| 02 | tests/campaigns/net-w021-ac-02-evidence-ranking.test.ts | 9 |
| 03 | tests/campaigns/net-w021-ac-03-advisory-non-authority.test.ts | 7 |
| 04 | tests/campaigns/net-w021-ac-04-optimization-adversarial.test.ts | 6 |
| 05 | tests/campaigns/net-w021-ac-05-selection-not-authority.test.ts | 3 |
| 06 | tests/campaigns/net-w021-ac-06-tenancy-idempotency-contract.test.ts | 7 |
| 07 | tests/regression/net-w021-ac-07-architecture-out-of-scope.test.ts | 11 |

Shared harness: tests/campaigns/_net-w021-harness.ts (wraps the
W019 harness — the full runtime + persons/orgs + the campaign,
supply, reputation-snapshot, verified-item-outcome, placement and
risk-control factories + the `campaigns.matching.run` guard and the
measured-outcome transition policies).

## Verification

`bun run verify` — typecheck PASS; arch:check 0 violations;
authority:check 0 violations; full suite green including the 54 new
NET-W021 tests. The dev/test PostgresAuthorityShim provides the
authority boundary; real-PostgreSQL/Redis integration runs in CI.
