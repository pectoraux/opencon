# `campaigns` boundary

**Tier:** domain
**Authority:** campaign domain rules — campaign policy/configuration ONLY
**Architecture ref:** `spec/architecture.md` §7 (Farmable contribution
market), §18 (Module ownership); `spec/architecture-lock.md` §2, §5, §7
**Concrete behaviour:** NET-W011

## Authority separation (the strongest constraint)

```text
/campaigns  → campaign policy/configuration authority
/workflows   → opportunity/contribution lifecycle authority
/evidence    → evidence truth authority
/outcomes    → normalized measurement/outcome authority
/settlement  → economic/clearing authority
/reputation  → trust-signal authority
```

The campaign domain may emit provider-neutral references/commands
consumed by the composition root, but it must never directly mutate
workflow, evidence, outcomes, reputation or settlement state through
hidden back doors:

- **No second economic system (AC-03).** Budgets are DECLARATIONS in
  versioned policy; the actual encumbrance is the settlement
  authority's stake escrow (`campaign_budget` purpose, additive to
  NET-W010's `dispute_challenge`), committed through the composition
  root with compound idempotency keys. The campaign record carries
  only REFERENCES (the NET-W010 stake-block precedent) — no balances,
  no postings, no parallel ledger. Clearing rules are declared policy
  consumed by NET-W014; executing them is an explicit non-goal.
- **No second lifecycle authority (AC-04).** Contribution
  opportunities are materialized through the opportunity service at
  the composition root (`resolveOpportunityDraft` → create →
  `recordOpportunityPublication` with the exact versioned eligibility
  reference `campaign_policy:{campaignId}:{version}:{specId}`); every
  lifecycle transition stays with `/workflows`. The campaign's own
  status machine (DRAFT → ACTIVE ⇄ PAUSED → COMPLETED/CANCELLED) is
  an administrative POLICY status — the dispute-record precedent, not
  a workflow lifecycle.
- **Truth/measurement authorities untouched (AC-06).** Policies
  REFERENCE the frozen `/evidence` grades + source types, the
  standard outcome types and the attribution modes; provider-specific
  semantics stay outside the domain (closed neutral vocabularies,
  enforced by the NET-W011 regression suite).

## What lives here (NET-W011)

- `port.ts` — the boundary contracts: `CampaignRecord` (first-class,
  org-scoped, append-only history), the versioned `CampaignPolicy`
  (objectives, eligibility, outcome/evidence policy, budget,
  attribution rules, clearing rules, opportunity specs), the neutral
  cross-domain lookups (stake / reward-policy / opportunity / person)
  and `CampaignService`.
- `campaign-service.ts` — the domain service: the administrative
  status machine with the CAMP-002 activation gate (complete policy +
  escrowed budget before ACTIVE), the org-independent policy-lineage
  mutex (`campaign_policy_lineage:{campaignId}`, version = latest+1),
  budget bookkeeping through the read-only stake lookup and
  publication bookkeeping through the read-only opportunity lookup.
  Every mutation commits record + events + idempotency + audit in ONE
  authoritative transaction.
- `authority-campaign-repository.ts` — the `campaigns` and
  `campaign_policies` collections over the provider-neutral
  `PostgresAuthority` contract (concrete driver in `src/adapters/`).

## Dependencies

Core contracts only (`core/campaigns.ts`, `core/economics.ts`,
`core/evidence.ts`, `core/measurement.ts`). Cross-domain access occurs
exclusively through the declared neutral lookups wired by the
bootstrap composition root.

## What lives here (NET-W021 — campaign matching and optimization)

Selection, not authority: the campaign is the matching SUBJECT; W019
inventory items are the candidate SUPPLY (creator supply enters
through `surfaceKind "creator"` items). The pipeline: hard
eligibility gates → evidence-backed feature extraction →
deterministic baseline ranking → bounded AI advisory optimization →
explainable candidate ordering.

- `matching-engine.ts` — the PURE engine: the hard gates
  (closed-vocabulary reasons, conjunction, complete traces), the
  six-signal baseline scoring (VERIFIED-outcome performance,
  canonical reputation standing/reliability/risk, alignment depth,
  coverage), the bounded advisory blends (alignment + risk ONLY),
  the baseline/final orderings and the SHA-256 digest (canonical
  1-decimal serialization). No I/O, no advisory on the eligibility
  path.
- `matching-service.ts` — all I/O: request validation, the campaign
  subject (read-only, CAMP-002 fail-closed: ACTIVE + pinned in-scope
  policy version), the effective-targeting merge, candidate
  enumeration + fact assembly through the NEUTRAL lookups
  (supply/eligibility over /inventory, reputation over /reputation,
  safety over /disputes, outcome evidence over /outcomes), the
  only-eligible advisory consultations, and ONE append-only,
  idempotent, tenant-scoped run record (`campaign_match_runs`) +
  its `campaign_match.recorded` audit event — the ONLY writes.
- `authority-match-run-repository.ts` — the run-record collection
  over the `PostgresAuthority` contract.

The optimizer mutates NO campaign, inventory, workflow, settlement,
reputation, risk or outcome state; placement EXECUTION remains the
W019 command's authority. See spec/work-orders/NET-W021.md and
docs/net-w021-campaign-matching-optimization.md.
