# NET-W014 — Reward and settlement integration

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** ECON-003, SETTLE-001..003, REP-004 (spec/requirements.md)
**Dependencies:** NET-W008 (economic ledger), NET-W012 (helpful contributions), NET-W013 (quality/moderation) — all merged
**Tracking:** issue #27 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Connect verified contribution outcomes to the canonical pending/mature
economic settlement layer and evidence-backed reputation updates
WITHOUT bypassing fraud/risk or dispute controls, WITHOUT creating a
parallel ledger, and WITHOUT touching another domain's authority:

```text
Verified Helpful Contribution        (/contributions + /workflows)
        ↓  recognizeContributionValue (qualification gate)
Qualifying Contribution Value        (composition-root composite)
        ↓  recordPendingValue (the EXISTING /settlement input gate)
/settlement pending value            (EconomicValueRecord, PENDING)
        ↓  matureValue — risk control + dispute gates (NET-W009/W010)
Maturation                           (MATURE)
        ↓  executeCampaignClearing (declared NET-W011 clearing rules)
Campaign clearing policy             (/campaigns — rule + cap + draw kind)
        ↓  allocateRewards / issueCredits / recordCashObligation
Deterministic reward allocation      (/settlement — conserved, idempotent)
        ↓  applySettlementReputationEffect (material-outcome gate)
Evidence-backed reputation effect    (/reputation — non-economic)
```

## §2 Authority separation (the decision of record)

NET-W014 is an INTEGRATION layer, not a new domain. Following the
NET-W013 decision of record (no 17th domain; quality/moderation
semantics extend existing boundaries) and the `recordModerationDecision`
precedent (risk-signal emission lives at the composition root), every
NET-W014 composite is a **composition-root orchestration** over the
existing authority services:

- `/contributions` — verified helpfulness: the composite READS the
  contribution state (must be VERIFIED — the /workflows authority's
  terminal confirmation), the Proof-of-Helpfulness state (must be
  QUALIFIED) and the derived moderation status (must not be REJECTED /
  FLAGGED_FOR_REVIEW). It never mutates any of them.
- `/campaigns` — clearing policy: the composite READS the campaign +
  its pinned policy version, resolves the clearing rule and enforces
  basis + cap. A NEW append-only bookkeeping command
  (`recordClearingExecution` — the `recordBudgetCommitment` precedent)
  records the executed draw as a campaign event.
- `/settlement` — ALL economic authority: recognition goes through the
  EXISTING `recordPendingValue` input gate; clearing draws go through
  the EXISTING `allocateRewards` / `issueCredits` /
  `recordCashObligation`; consumption/maturation semantics, the
  double-entry ledger, conservation and reversals are UNTOUCHED.
- `/reputation` — trust signal: the composite records ONE reputation
  input through the EXISTING input service (sources resolved, basis
  DERIVED — never caller-asserted). No direct mutation, no economic
  dimension.
- `/disputes` + NET-W009 risk controls — the ONLY gates: maturation
  and consumption are refused while active risk controls or ACTIVE
  disputes cover the value record, its beneficiary, or ANY of its
  upstream source records (now including the CONTRIBUTION itself —
  §3.1).

No parallel ledger, no new economic record type, no payment execution
(`/payments` stays skeletal — NET-W030), no AI authority anywhere
(advisory quality feeds a read-only gate at most).

## §3 Scope

### §3.1 The contribution as a first-class economic source (additive amendment)

`ECONOMIC_VALUE_SOURCES` (core/economics.ts) gains `"contribution"` —
a NET-W014 AMENDMENT (the `RISK_SIGNAL_CATEGORIES` additive precedent
from NET-W013). Rationale:

1. The issue REQUIRES consuming "verified helpful contribution …
   through provider-neutral references" — the value record's lineage
   must carry the contribution itself, not just its PoH bases.
2. The EXISTING dispute gate + risk gate machinery at the composition
   root checks `valueRecord.sources[].id` — with the contribution as a
   source, a dispute opened on the CONTRIBUTION (subjectType
   `contribution`, DISPUTE_SUBJECT_TYPES since NET-W010) or a risk
   control placed on the contribution record AUTOMATICALLY gates
   maturation/consumption of value recognized from it. No new gate
   plumbing.
3. The input gate bar stays EXACTLY as strict: a `contribution` source
   resolves through a NEW `EconomicContributionLookup` (neutral
   structural interface — the EconomicSubjectLookup precedent) and
   qualifies ONLY when same-organization-scope AND state === VERIFIED.
   Unverified contributions are rejected at the authoritative input
   gate exactly like unverified PoVs/measured outcomes (invariant 1).

`src/settlement/value-service.ts` `resolveQualifyingSource` handles the
new kind; `narrowSources`' error message is updated additively. The
settlement domain still imports ONLY core contracts.

### §3.2 Composite 1 — `recognizeContributionValue` (AC-01)

Composition-root apiCommand. Input: `{ contributionId, amount,
maturation?, description?, idempotencyKey }`.

Deterministic qualification gate (pre-flight reads; the authoritative
bar remains the settlement input gate in §3.1):
1. the contribution exists (contributionService) — its organization
   scope is the record's scope;
2. contribution.state === "VERIFIED" (the /workflows terminal state —
   the lifecycle authority's confirmation, read-only);
3. Proof-of-Helpfulness state === "QUALIFIED" (the W012 verified
   usefulness claim);
4. derived moderation status ∉ { REJECTED, FLAGGED_FOR_REVIEW } (the
   W013 derived status — a moderated-down contribution never earns);
5. IF a quality evaluation exists for the contribution, its band ≠
   UNSATISFACTORY (the W013 deterministic evaluation — the advisory
   blend is bounded; AI alone can never certify, and a bottom-band
   deterministic evaluation blocks recognition).

Sources (deterministic derivation): `[{kind: "contribution", id}]` +
the PoH's qualifying bases mapped `proof_of_value → proof_of_value`,
`measured_outcome → measured_outcome`, `evidence_record → evidence`
(re-resolved + VERIFIED-enforced by the settlement input gate).
Beneficiary: the contributor. Then `recordPendingValue` (existing
atomic, idempotent, audited path).

Recognition is NOT gated by disputes/risk (invariant 2 gates
MATURATION — recognized-but-disputed value can never mature until the
dispute resolves; that is the designed semantics).

### §3.3 Composite 2 — clearing execution (AC-03)

Composition-root apiCommand `executeCampaignClearing`. Input:
`{ campaignId, valueRecordId, clearingRuleId?, creditsPerValueUnit?,
cashKind?, counterpartyPersonId?, description?, idempotencyKey }`.

1. Resolve the campaign (must be ACTIVE) + its current policy version
   → the clearing rule (by id, or the single rule matching the value
   record's basis — the caller may pass the rule id explicitly).
2. Resolve the value record: same scope, state MATURE (the existing
   consume-only-MATURE bar), amount ≤ rule.maxDrawAmount (the CAMP-005
   hard cap).
3. Basis check (deterministic, from the rule's `basis`):
   `attributed_outcome` → ≥1 `measured_outcome` source;
   `verified_evidence` → ≥1 `evidence` source;
   `measured_value` → ≥1 `proof_of_value` source.
   (The `contribution` source is lineage, not a clearing basis.)
4. Gates: `refuseWhenGated` (operation class per draw kind) +
   `refuseWhenDisputed` over the record id + beneficiary + ALL source
   ids (§3.4).
5. Draw (the EXISTING settlement primitive — no new economics):
   - `reward_allocation` → `allocateRewards` with the rule's
     `rewardPolicyId` (required by the W011 validation) — the
     deterministic conserved split (NET-W008);
   - `credit_issuance` → `issueCredits` with the input rate
     (ECON-003: credits tie to verified value);
   - `cash_obligation` → `recordCashObligation` with input kind +
     counterparty (internal payable state only — no payment execution).
6. Bookkeeping: `campaignService.recordClearingExecution` (§3.5).

### §3.4 Gate extension — source-scoped risk controls (AC-02)

The dispute gate at maturation/consumption ALREADY covers
`valueRecord.id + sources[].id`. The risk gate
(`refuseWhenGated`) matches only the record id + beneficiary person —
a control placed on the CONTRIBUTION record does not match the value
record. NET-W014 extends the composition-root risk gate at
`matureEconomicValue` / `issueCredits` / `allocateRewards` /
`executeCampaignClearing` to ALSO check every source record id
(`findGatingControl` per source — person-wide controls match first, so
one call suffices when a person control exists). /settlement domain
code remains untouched (composition-root wiring only).

### §3.5 Campaigns — `recordClearingExecution` bookkeeping (AC-03 lineage)

New campaign-service command (the `recordBudgetCommitment` precedent):
appends a `clearing_executed` event to the campaign record (details:
rule id, draw kind, value record id, primitive result id, amount,
transaction lineage). `CAMPAIGN_EVENTS` gains `clearing_executed`
(additive amendment). Idempotent by compound key; owner-actor only;
refused for terminal campaigns. REFERENCES ONLY — no balances, no
postings (the campaign record never becomes a ledger).

### §3.6 Composite 3 — `applySettlementReputationEffect` (AC-04)

Composition-root apiCommand. Input: `{ valueRecordId, dimension?,
description?, idempotencyKey }`.

1. Resolve the value record (same scope): state MUST be MATURE or
   CONSUMED — the MATERIAL-outcome gate (a merely-recognized PENDING
   record never feeds reputation; maturation passed the risk/dispute
   gates; consumption means rewards/credits were allocated).
2. Record ONE reputation input through the EXISTING input service:
   subject = the value beneficiary (the contributor); sources = the
   value record's sources (contribution + bases — all legal
   reputation source kinds, all verified-grade by construction);
   dimension defaults to `helpfulness` (closed vocabulary); occurredAt
   = maturedAt ?? recordedAt (the decay anchor — REP-003); basis is
   DERIVED by the input service (verified — never caller-asserted).
3. The description is non-economic prose; NO economic field of the
   value record (amount) is copied into the reputation input — the
   reputation record carries references only. Reputation remains
   non-economic (invariant 4): there is no code path from reputation
   to credits/cash and none is added.

## §4 Invariants (mechanically enforced)

1. Only verified, qualifying contribution value may enter pending
   settlement — the §3.2 gate (VERIFIED + QUALIFIED + moderation +
   quality floor) AND the §3.1 input gate (VERIFIED contribution
   source, same scope) — double-enforced.
2. Pending value cannot mature while fraud/risk/dispute gates are
   active — `refuseWhenGated` (now source-scoped) +
   `refuseWhenDisputed` (record + sources) at maturation AND
   consumption AND clearing.
3. Reward allocation is deterministic, conserved, idempotent,
   auditable — the UNTOUCHED NET-W008 reward service; the clearing
   composite only SELECTS the policy (from the declared rule) and
   enforces the cap.
4. Reputation receives evidence-backed material outcomes only and
   remains non-economic — the §3.6 MATURE|CONSUMED gate + the existing
   input service (non-empty verified sources, derived basis).
5. Cash and Credits remain distinct except through canonical
   conversion paths — no conversion is added; clearing draws select
   ONE primitive each (reward/credit/cash) through the existing
   services.
6. No external payment execution — `/payments` is never imported
   (regression-pinned); cash draws record internal obligations only.
7. Cross-tenant references are rejected at authoritative transaction
   boundaries — the §3.1 same-scope check inside the settlement input
   gate (in-tx discipline: sources resolve through the authority
   before the record commits); campaign clearing checks value-record
   scope == campaign scope; reputation checks scope == input scope.
8. AI/model outputs remain advisory evidence and never independently
   authorize settlement or reputation mutation — the quality gate at
   recognition reads the DETERMINISTIC evaluation (the advisory blend
   is structurally bounded by the W013 cap/weight invariants; advisory
   records are never passed to settlement or reputation).

## §5 Non-goals

External payment provider execution (NET-W030), creator marketplace
(NET-W015+), ad inventory (NET-W019+), procurement/benefit pools
(NET-W023/W028), blockchain/decentralized validation, cumulative
cross-draw budget conservation accounting (per-draw cap enforcement
only — the campaign budget stake remains escrow bookkeeping),
dispute-resolution-driven value reversal orchestration (the EXISTING
reverseValue/reverseAllocation primitives remain the correction path;
composing them into automatic dispute outcomes is future work).

## §6 Acceptance criteria → tests

| AC | Criterion | Suite |
|---|---|---|
| NET-W014-AC-01 | verified helpful contribution/outcome deterministically enters canonical pending value | `tests/reward-integration/net-w014-ac-01-recognition.test.ts` |
| NET-W014-AC-02 | settlement respects maturation + fraud/dispute gates; no /disputes bypass | `tests/reward-integration/net-w014-ac-02-gates.test.ts` |
| NET-W014-AC-03 | campaign clearing rules drive deterministic reward allocation through /settlement | `tests/reward-integration/net-w014-ac-03-clearing.test.ts` |
| NET-W014-AC-04 | material reward/outcome effects update /reputation only through evidence-backed references | `tests/reward-integration/net-w014-ac-04-reputation.test.ts` |
| NET-W014-AC-05 | conservation, idempotency, concurrency, tenant isolation, audit lineage end-to-end | `tests/reward-integration/net-w014-ac-05-atomicity-tenancy.test.ts` |
| NET-W014-AC-06 | cash/credit separation + external-payment boundary intact | `tests/reward-integration/net-w014-ac-06-boundaries.test.ts` |
| NET-W014-AC-07 | architecture/out-of-scope regression with frozen Architecture v1.0 unchanged | `tests/regression/net-w014-ac-07-architecture-out-of-scope.test.ts` |

## §7 Verification

`bun run verify` (typecheck + arch:check + full test suite) must pass.
Frozen specs (`spec/architecture.md`, `spec/architecture-lock.md`)
remain byte-identical. Evidence document:
`docs/net-w014-reward-settlement.md`.
