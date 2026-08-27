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
