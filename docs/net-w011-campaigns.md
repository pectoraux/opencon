# NET-W011 — Campaign domain (evidence document)

**Work order:** `spec/work-orders/NET-W011.md` (bound to Issue #21)
**Architecture:** v1.0 (FROZEN — unchanged, verified by regression)
**Verification:** `bun run verify` — typecheck PASS, `arch:check` PASS
(236 files, 0 violations), full suite green (see the PR's CI run for
the real-PG/Redis integration subset).

## What shipped

The Phase-4 Campaign foundation in the `/campaigns` boundary:

1. **First-class campaign records** — org-scoped, owner-carried, with
   the administrative status machine (`DRAFT → ACTIVE ⇄ PAUSED →
   COMPLETED/CANCELLED`) and an append-only event history. This
   status is a POLICY status (the dispute-record precedent), not a
   workflow lifecycle: contribution opportunities remain lifecycle
   subjects owned by `/workflows`.
2. **Versioned campaign policy** — immutable lineage records
   (version = latest+1 under the org-independent mutex
   `campaign_policy_lineage:{campaignId}`) carrying every CAMP-002
   section: objectives (the nine frozen CAMP-001 kinds), neutral
   eligibility rules, outcome requirements (frozen outcome types +
   attribution modes), evidence requirements (frozen grades/source
   types), the credits budget declaration, attribution rules
   (confidence thresholds; `incremental_conversion` ⇒ experimental +
   requiresExperiment), clearing rules (settlement draw kinds,
   same-scope reward-policy resolution, caps within the budget) and
   opportunity specs.
3. **Budget economics through the settlement authority** — the
   declared budget is escrowed as a settlement stake with the new
   additive purpose kind `campaign_budget` (postings owned entirely
   by `/settlement`; no new account/tx kinds). The campaign record
   carries REFERENCES only (the NET-W010 stake-block precedent). The
   CAMP-002 gate refuses activation while a positive declared budget
   is unescrowed; the release flows settlement-first and only after
   a terminal status; later policy versions cannot exceed the
   committed escrow.
4. **Composition through /workflows** — `resolveOpportunityDraft` →
   `opportunityService.createOpportunity` (DRAFT, version 0, carrying
   the deterministic versioned eligibility reference
   `campaign_policy:{campaignId}:{version}:{specId}`) →
   `recordOpportunityPublication` (read-only verification) — all
   sequenced at the composition root with compound idempotency keys.
   Clearing rules are DECLARED policy consumed by NET-W014.

## Authority separation (decision of record)

```text
/campaigns  → campaign policy/configuration (this boundary)
/workflows   → opportunity/contribution lifecycle (untouched)
/evidence    → truth authority (referenced vocabularies only)
/outcomes    → measurement authority (referenced vocabularies only)
/settlement  → economic authority (the escrow posts through StakeService)
/reputation  → trust-signal authority (untouched)
```

The campaign domain code contains no settlement command call, no
opportunity/workflow mutation call, no evidence/outcome/reputation
mutation path (pinned by the AC-07 regression denylist + the
domain-import scan). The ONLY touchpoints are the four neutral
read-only lookups (person, stake, reward policy, opportunity) wired
by the bootstrap composition root.

## Invariant → enforcement map

| Invariant | Enforcement |
|---|---|
| Append-only material history | `withEvent` builds a new frozen record; events only ever appended; prior events byte-identical (AC-01 test) |
| Policy explicit + versioned | `validatePolicySections` (closed vocabularies, frozen references, economic arithmetic) + the lineage mutex (AC-02 tests) |
| No second economic system | Budget = declaration in policy; escrow = settlement stake (`campaign_budget`); budget block = references; AC-03 + the AC-07 denylist |
| /workflows keeps lifecycle authority | Composition through the opportunities boundary at the root; references-only listings; AC-04 proves a workflow transition still works and the campaign gains no lifecycle fields |
| Platform invariants | Idempotency keys per command; `campaign_record:{id}` mutex; org-independent policy mutex; owner-only + person-only actors; atomic record+events+idempotency+audit transactions (AC-05) |
| Provider neutrality | Closed attribute/operator/objective vocabularies; frozen reference vocabularies; static provider-name scan (AC-06) |
| Frozen architecture | `arch:check` 0 violations; frozen specs untouched; deliberate additive amendments only (W010 purpose-kind pin, premature-module flip) (AC-07) |

## Design decisions

1. **The campaign status machine is NOT a LifecycleSubjectKind.** The
   authority block scopes `/workflows` to "opportunity/contribution
   lifecycle". The campaign record's own status is administrative
   policy/configuration state (exactly how W009/W010 dispute records
   own OPEN/UNDER_REVIEW/RESOLVED without becoming workflow
   subjects). Opportunities remain the composition targets.
2. **The budget escrow reuses the W010 stake primitive** with an
   additive purpose kind instead of new account/tx kinds — the
   smallest surface that makes "economic commitments use the
   canonical settlement authority" mechanically true (the settlement
   code is untouched; only the frozen vocabulary grew).
3. **Single commitment per campaign** mirrors the settlement
   one-COMMITTED-stake-per-purpose rule; top-ups are future work
   (NET-W014+) rather than a fork of stake semantics.
4. **Policy versions after a commitment cannot exceed it** — the
   recorded escrow is the fact; declarations stay within it (no
   activation-on-credit through version bumps).
5. **Clearing rules are declared, not executed** — NET-W014 owns
   execution; the campaign domain only validates that draws reference
   real settlement primitives (reward policies resolve same-scope).
6. **Zero-budget campaigns are first-class** (CAMP-004 non-reciprocal
   cross-promotion): no escrow is required or allowed.
7. **Publication is recorded, not owned** — a paused/terminal
   campaign simply refuses new publications; already-published
   opportunities live out their lifecycle under `/workflows`
   unaffected.

## API surface (guarded mutations + public reads)

| Route | Guard action | Command |
|---|---|---|
| POST /api/campaigns | campaign.create | createCampaign |
| POST /api/campaigns/:id/policy | campaign.policy | defineCampaignPolicy |
| POST /api/campaigns/:id/activate | campaign.activate | activateCampaign |
| POST /api/campaigns/:id/pause | campaign.pause | pauseCampaign |
| POST /api/campaigns/:id/resume | campaign.resume | resumeCampaign |
| POST /api/campaigns/:id/complete | campaign.complete | completeCampaign |
| POST /api/campaigns/:id/cancel | campaign.cancel | cancelCampaign |
| POST /api/campaigns/:id/budget | campaign.budget.commit | commitCampaignBudget (stake → record) |
| POST /api/campaigns/:id/budget/release | campaign.budget.release | releaseCampaignBudget (release → record) |
| POST /api/campaigns/:id/opportunities | campaign.opportunity.publish | publishCampaignOpportunity (draft → create → record) |
| GET /api/campaigns | — | listCampaigns |
| GET /api/campaigns/:id | — | getCampaign |
| GET /api/campaigns/:id/policies | — | listCampaignPolicies |
| GET /api/campaigns/:id/opportunities | — | listCampaignOpportunities |

## AC → test mapping

See `spec/work-orders/NET-W011.md` §6. Summary: AC-01 `tests/campaigns/net-w011-ac-01-records.test.ts`;
AC-02 `net-w011-ac-02-policy.test.ts`; AC-03 `net-w011-ac-03-economics.test.ts`;
AC-04 `net-w011-ac-04-composition.test.ts`; AC-05 `net-w011-ac-05-platform.test.ts`;
AC-06 `net-w011-ac-06-neutrality.test.ts`; AC-07
`tests/regression/net-w011-ac-07-architecture-out-of-scope.test.ts`
plus the two deliberate amendments (the W010 purpose-kind pin gains
`campaign_budget`; `ac-08-no-premature-domain-logic` flips campaigns
out of the skeleton set with a NET-W011 reference check).
