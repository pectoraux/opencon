# Work Order — NET-W011: Campaign domain

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md`)
**Requirements:** CAMP-001..005 (objectives CAMP-001, pre-activation
policy CAMP-002, ad-ecosystem interop CAMP-003, non-reciprocal
cross-promotion CAMP-004, multilateral clearing CAMP-005), API-002
(server-side authorization)
**Acceptance criteria:** NET-W011-AC-01..07
**Dependencies:** NET-W004 (idempotent mutations + opportunities/workflows), NET-W005 (evidence), NET-W008 (economic ledger) — all merged
**Canonical issue:** Issue #21

## 1. Objective

Generalize campaigns from Farmable into the protocol
contribution/campaign model. Campaigns represent objectives, outcome/
evidence policy, budgets, attribution rules and clearing rules
WITHOUT creating a separate economic system (they consume the
already-canonical settlement/evidence/workflow foundations).

Authority separation is the work item's strongest constraint (Issue
#21, binding):

```text
/campaigns  → campaign policy/configuration authority
/workflows   → opportunity/contribution lifecycle authority
/evidence    → evidence truth authority
/outcomes    → normalized measurement/outcome authority
/settlement  → economic/clearing authority
/reputation  → trust-signal authority
```

## 2. Design constraints (from Issue #21, binding)

```text
Campaign
  ↓
Objectives
  ↓
Outcome / Evidence policy
  ↓
Budget
  ↓
Attribution rules
  ↓
Clearing rules
  ↓
Contribution opportunities
```

No second economic system: budget commitments and clearing rules
consume the existing `/settlement` economic authority — no hidden
balances, no parallel ledger. No second lifecycle authority: campaign
composition goes through `/workflows` (opportunities are created via
the opportunities boundary; transitions stay with the workflow
service). The campaign domain may emit provider-neutral references/
commands consumed by the composition root, but must never directly
mutate workflow, evidence, outcomes, reputation or settlement state
through hidden back doors.

## 3. Scope

### 3.1 Core campaign vocabulary (`src/core/campaigns.ts`)

The administrative status machine owned by `/campaigns`:

```text
DRAFT ──activate──→ ACTIVE ⇄ pause/resume ⇄ PAUSED
  │                    │ │
  │                    └──┼── complete ──→ COMPLETED (terminal)
  └── cancel ──────────┴── cancel ──→ CANCELLED (terminal)
```

This is the CAMPAIGN RECORD's own policy/configuration status (the
dispute-record precedent) — deliberately NOT a `LifecycleSubjectKind`
(contribution opportunities remain the workflow-lifecycle subjects).

Closed vocabularies: the nine CAMP-001 objective kinds (awareness,
attention, engagement, intent, conversion, incremental_conversion,
creator_content, cross_promotion, referral), the neutral eligibility
attributes/operators, the evidence-requirement kinds, the clearing
bases/draw kinds. Pure validators reuse the frozen economic
arithmetic (`validateEconomicAmount`), the frozen evidence grades/
source types and the frozen outcome types/attribution modes.
Deterministic helpers: the incremental-conversion experimental
constraint and the versioned eligibility reference
`campaign_policy:{campaignId}:{version}:{specId}`. Policy-format
lineage constant `NET-W011:1`.

### 3.2 The budget escrow — the settlement authority side

Additive vocabulary ONLY (`core/economics.ts`): the stake purpose kind
`campaign_budget` joins `dispute_challenge` (the W010 additive
amendment pattern). The settlement `StakeService` — untouched code —
owns every posting: commit debits `credits(owner)`/credits
`stake_escrow(owner)`; release reverses. One COMMITTED stake per
purpose is enforced by settlement (single budget commitment per
campaign). No new account kind, no new tx kind, no hidden ledger.

### 3.3 The campaign aggregate (`/campaigns`)

- `CampaignRecord` — first-class, org-scoped, owner-carried, with an
  append-only event history and the REFERENCES-ONLY budget block (the
  NET-W010 stake-block precedent: `stakeId`/`committedAmount`/
  `committedAt`/`releasedAt` — never balances).
- `CampaignPolicy` — immutable versioned records (version = latest+1
  under the ORG-INDEPENDENT mutex `campaign_policy_lineage:{campaignId}`,
  the NET-W007/008/010 lineage pattern) carrying every section:
  objectives, eligibility, outcomePolicy, evidencePolicy, budget,
  attributionRules (confidence thresholds; incremental_conversion ⇒
  experimental + requiresExperiment), clearingRules (basis, settlement
  draw kind, reward-policy reference resolved same-scope, caps within
  the budget), opportunitySpecs.
- The CAMP-002 activation gate: a complete policy version with ≥1
  opportunity spec AND — when the declared budget is positive — a
  COMMITTED, recorded settlement escrow covering the declared total
  (no activation on credit). Zero-budget campaigns (CAMP-004
  non-reciprocal cross-promotion) activate without an escrow.
- Budget bookkeeping: `recordBudgetCommitment` verifies the settlement
  stake through the READ-ONLY lookup (scope, owner, purpose linkage,
  COMMITTED state, exact declared amount) and records the reference;
  `recordBudgetRelease` verifies the settlement-executed RELEASE
  first (terminal campaigns only).
- Composition: `resolveOpportunityDraft` returns the neutral spec
  fields + the deterministic eligibility reference;
  `recordOpportunityPublication` verifies the composed opportunity
  (same scope, exact type/reference) and appends the publication
  event. `listPublishedOpportunities` derives references ONLY (no
  lifecycle fields).

### 3.4 Composition-root orchestration

The runtime `apiCommands` sequence the authorities with COMPOUND
idempotency keys (the NET-W009/010 precedent): budget commit =
`commitStake("${key}:stake")` → `recordBudgetCommitment("${key}:record")`;
release = `releaseStake("${key}:release")` → `recordBudgetRelease`;
publish = `resolveOpportunityDraft` → `opportunityService.createOpportunity`
→ `recordOpportunityPublication("${key}:record")`. Neutral lookups
(stake, reward policy, opportunity, person) are thin read-only
adapters over the owning domains' repositories.

### 3.5 Persistence, idempotency, audit, tenancy

Authority collections `campaigns` + `campaign_policies` over the
`PostgresAuthority` contract; every mutation commits record + events
+ idempotency + audit (`campaign.*` namespace) in ONE transaction;
status mutations serialize under `campaign_record:{id}`; policy
lineage under the org-independent mutex; all reads org-scoped;
owner-only + person-actor-only authorization (API-002).

## 4. Required invariants (from Issue #21, binding)

1. Campaigns are first-class durable scoped records with immutable/
   append-only material history.
2. Objectives, eligibility, outcome/evidence policy, budgets,
   attribution, and clearing rules are explicit and versioned.
3. Economic commitments and clearing use the canonical settlement
   authority; no hidden ledger is introduced.
4. Campaign workflow composition preserves `/workflows` lifecycle
   authority and downstream domain ownership.
5. Tenant isolation, authorization, idempotency, concurrency safety,
   PostgreSQL authority, and transactional audit lineage are enforced.
6. Provider-specific semantics remain outside the core campaign domain.

## 5. Explicit non-goals

No helpfulness pipeline (NET-W012), no quality/moderation (NET-W013),
no reward integration beyond defining campaign clearing policy
(NET-W014 — clearing EXECUTION is explicitly out of scope), no creator
marketplace behavior (NET-W015+), no ad inventory/optimization
(NET-W019+), no demand/procurement pools, no external payments, no
blockchain consensus, no provider-specific campaign SDK semantics.

## 6. Acceptance criteria mapping

| Criterion | Tests | Changed files |
|---|---|---|
| NET-W011-AC-01 (first-class durable records) | `tests/campaigns/net-w011-ac-01-records.test.ts` | `core/campaigns.ts`, `campaigns/port.ts`, `campaigns/campaign-service.ts`, `campaigns/authority-campaign-repository.ts` |
| NET-W011-AC-02 (explicit versioned policy) | `tests/campaigns/net-w011-ac-02-policy.test.ts` | same + `campaigns/campaign-service.ts` validators |
| NET-W011-AC-03 (canonical settlement economics; no second economic system) | `tests/campaigns/net-w011-ac-03-economics.test.ts` | `core/economics.ts` (additive purpose kind), runtime `commitCampaignBudget`/`releaseCampaignBudget` |
| NET-W011-AC-04 (/workflows keeps lifecycle authority) | `tests/campaigns/net-w011-ac-04-composition.test.ts` | runtime `publishCampaignOpportunity`, `campaigns/port.ts` lookups |
| NET-W011-AC-05 (tenant isolation, authorization, idempotency, concurrency, PostgreSQL authority, audit lineage) | `tests/campaigns/net-w011-ac-05-platform.test.ts` | `campaigns/campaign-service.ts`, `campaigns/authority-campaign-repository.ts` |
| NET-W011-AC-06 (provider neutrality) | `tests/campaigns/net-w011-ac-06-neutrality.test.ts` | `core/campaigns.ts` closed vocabularies |
| NET-W011-AC-07 (architecture/out-of-scope regression) | `tests/regression/net-w011-ac-07-architecture-out-of-scope.test.ts` (+ deliberate amendments in `net-w010-ac-08` purpose pin and `ac-08-no-premature-domain-logic`) | this work order, `docs/net-w011-campaigns.md` |

## 7. Verification

`bun run verify` = typecheck + `arch:check` + the full test suite
(unit + regression; the real-PostgreSQL/Redis integration tests run
in CI where `PG_TEST_DATABASE_URL`/`REDIS_TEST_URL` are configured).
All AC suites above must pass with 0 failures.
