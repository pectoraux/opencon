# NET-W014 — Reward and settlement integration (evidence document)

**Issue:** #27 · **Architecture:** v1.0 (FROZEN — `spec/architecture.md`,
`spec/architecture-lock.md` byte-unchanged) · **Work order:**
`spec/work-orders/NET-W014.md`

## What shipped

The economic integration layer connecting verified contribution
outcomes to the canonical pending/mature settlement layer and
evidence-backed reputation updates — WITHOUT bypassing fraud/risk or
dispute controls, WITHOUT a parallel ledger, and WITHOUT touching
another domain's authority:

```text
Verified Helpful Contribution        (/contributions + /workflows)
        ↓  recognizeContributionValue (composition-root composite)
Qualifying Contribution Value        (VERIFIED + QUALIFIED PoH + moderation + quality floor)
        ↓  recordPendingValue (the EXISTING /settlement input gate)
/settlement pending value            (EconomicValueRecord, PENDING)
        ↓  matureEconomicValue — risk + dispute gates (source-scoped)
Maturation                           (MATURE)
        ↓  executeCampaignClearing (declared NET-W011 clearing rules)
Campaign clearing policy             (rule + basis + cap + draw kind)
        ↓  allocateRewards / issueCredits / recordCashObligation
Deterministic reward allocation      (the UNTOUCHED NET-W008 primitives)
        ↓  applySettlementReputationEffect (material-outcome gate)
Evidence-backed reputation effect    (the EXISTING /reputation input service)
```

## The decision of record: an integration layer, not a domain

NET-W014 is a **composition-root orchestration** over the existing
authority services (the `recordModerationDecision` precedent — no
17th domain; the architecture-lock domain list is unchanged and
regression-pinned). The three composites live in
`src/bootstrap/runtime.ts` apiCommands:

- **`recognizeContributionValue`** (AC-01) — the deterministic
  qualification gate (contribution VERIFIED via /workflows +
  Proof-of-Helpfulness QUALIFIED via /contributions + derived
  moderation status ∉ {REJECTED, FLAGGED_FOR_REVIEW} + latest quality
  evaluation ≠ UNSATISFACTORY), then the EXISTING
  `recordPendingValue` (whose authoritative input gate re-resolves
  every source same-scope + VERIFIED).
- **`executeCampaignClearing`** (AC-03) — resolves the declared
  NET-W011 clearing rule from the campaign's current policy version,
  enforces the CAMP-005 basis + the `maxDrawAmount` hard cap, applies
  the source-scoped risk/dispute gates, then executes the EXISTING
  settlement primitive the rule names (`allocateRewards` /
  `issueCredits` / `recordCashObligation`) and records the draw as
  campaign bookkeeping (`clearing_executed` event — references only).
- **`applySettlementReputationEffect`** (AC-04) — the material-outcome
  gate (MATURE/CONSUMED only), then the EXISTING reputation input
  service (basis DERIVED from the resolved sources; references only).

## The additive amendments (the only shared-baseline changes)

1. `ECONOMIC_VALUE_SOURCES` (core/economics.ts) gains `"contribution"`
   — the verified helpful contribution as a first-class economic
   source, resolved through the NEW neutral
   `EconomicContributionLookup` with the IDENTICAL qualifying bar as
   the other lifecycle sources (same scope + state VERIFIED). This
   also closes the gate loop: the EXISTING dispute/risk gate
   machinery checks source ids, so a dispute or control on the
   CONTRIBUTION automatically gates maturation/consumption of value
   recognized from it (regression-proven in AC-02).
2. `CAMPAIGN_EVENTS` (campaigns/port.ts) gains `"clearing_executed"`
   — the append-only bookkeeping event for executed clearing draws
   (the `recordBudgetCommitment` precedent; references only).

Every other frozen vocabulary is UNCHANGED and regression-pinned
(economic account kinds, stake purpose kinds, ledger tx kinds, cash
kinds, campaign statuses, clearing bases/draw kinds, risk operation
classes, dispute subject types, reputation input sources).

## Gate extension: source-scoped risk controls

The dispute gate at maturation/consumption already covered the value
record + all source ids. The RISK gate matched only the record id +
beneficiary person — a control placed on the CONTRIBUTION did not
match a value record recognized from it. NET-W014 extends the
composition-root risk gate (`matureEconomicValue` / `issueCredits` /
`allocateRewards` / `executeCampaignClearing`) to check EVERY source
record id. /settlement domain code is untouched (composition-root
wiring only).

## Key design decisions

1. **Double-enforced recognition** — the composite's pre-flight gate
   (fail-fast) + the settlement input gate (authoritative: each
   source resolved same-scope + VERIFIED before the record commits).
2. **Replay tolerance** — the clearing composite tolerates a CONSUMED
   record only as the idempotent replay path of a consuming draw; the
   underlying primitive replays (same compound key) or refuses
   (consume-only-MATURE), so exactly-once holds either way (the W012
   publication-composite pattern).
3. **Credit draws respect lock invariant 20** — credit issuance
   requires a VERIFIED Proof-of-Value reference; a clearing credit
   draw on a value record without a PoV source is refused by the
   settlement authority itself (regression-proven).
4. **Reputation is non-economic** — the effect passes REFERENCES only
   (no amounts; the record-shape is pinned field-by-field); the decay
   anchor is the maturation/consumption time; the basis is DERIVED.
5. **No new economic state** — the campaign clearing bookkeeping is an
   EVENT (references only); no new collection, no balances, no
   postings; the settlement primitives own every economic mutation.
6. **Recognition is not gated by disputes** — invariant 2 gates
   MATURATION/consumption; recognized-but-disputed value can never
   mature until the dispute resolves (the lock-invariant-21
   semantics; an unbonded PENDING_STAKE dispute never freezes value —
   griefing resistance, regression-proven at the integration level).

## Invariant → enforcement map

| Invariant (issue #27) | Enforcement | Suite |
|---|---|---|
| 1. Only verified, qualifying value enters pending settlement | Composite gate + the settlement input gate (contribution source VERIFIED + same scope) | AC-01 |
| 2. Pending value cannot mature while gates are active | Source-scoped risk gate + dispute gate (record + beneficiary + ALL sources) at maturation/consumption/clearing | AC-02 |
| 3. Reward allocation deterministic, conserved, idempotent, auditable | The UNTOUCHED NET-W008 reward service; the rule selects the policy; cap enforced; conservation asserted globally | AC-03 + AC-05 |
| 4. Reputation: evidence-backed material outcomes only, non-economic | MATURE/CONSUMED gate + the existing input service (derived basis, non-empty verified sources) + field-level shape pin | AC-04 |
| 5. Cash/credits distinct except canonical conversion | No conversion is created (conversion count pinned); distinct primitives with distinct units | AC-06 |
| 6. No external payment execution | `/payments` skeletal + unimported by the domains; the composites reference no payment service (source pins) | AC-06 + AC-07 |
| 7. Cross-tenant references rejected at authoritative boundaries | The input gate's same-scope source check; the clearing composite's scope-first check; campaign/reputation scope checks | AC-01 + AC-03 + AC-05 |
| 8. AI never authorizes settlement or reputation | The composites consult no LLM/advisory path; the quality gate reads the DETERMINISTIC evaluation record only (source pins) | AC-07 |

## API surface

| Route | Guard action | Command |
|---|---|---|
| POST `/api/settlement/contribution-value` | `reward.recognize` | recognizeContributionValue |
| POST `/api/settlement/clearing-executions` | `reward.clear` | executeCampaignClearing |
| POST `/api/settlement/reputation-effects` | `reward.reputation` | applySettlementReputationEffect |

All three are guarded deny-by-default (regression-proven: 403 without
policies).

## AC → test mapping

| AC | Criterion | Suite |
|---|---|---|
| NET-W014-AC-01 | verified contribution deterministically enters canonical pending value | `tests/reward-integration/net-w014-ac-01-recognition.test.ts` (9) |
| NET-W014-AC-02 | settlement respects maturation + fraud/dispute gates; no /disputes bypass | `tests/reward-integration/net-w014-ac-02-gates.test.ts` (7) |
| NET-W014-AC-03 | campaign clearing rules drive deterministic reward allocation | `tests/reward-integration/net-w014-ac-03-clearing.test.ts` (13) |
| NET-W014-AC-04 | material effects update /reputation only through evidence-backed references | `tests/reward-integration/net-w014-ac-04-reputation.test.ts` (7) |
| NET-W014-AC-05 | conservation/idempotency/concurrency/tenancy/audit end-to-end | `tests/reward-integration/net-w014-ac-05-atomicity-tenancy.test.ts` (6) |
| NET-W014-AC-06 | cash/credit separation + external-payment boundary | `tests/reward-integration/net-w014-ac-06-boundaries.test.ts` (4) |
| NET-W014-AC-07 | architecture/out-of-scope regression | `tests/regression/net-w014-ac-07-architecture-out-of-scope.test.ts` (10) |

Harness: `tests/reward-integration/_net-w014-harness.ts` (wraps the
W013 chain; adds the VERIFIED-settled-contribution factory, the
measured-outcome/PoV basis factories, the recognition/maturation
helpers and the ACTIVE clearing-campaign factory). Harness-chain
amendments: the W008 harness threads `llm.providers` (the PR #26
remediation threading, pre-existing); the W011 harness's policy
options gain clearing-rule overrides (draw kind / basis / cap); the
W013 harness's quality-shape options gain explicit input rules — all
additive, no existing test changed.

## Non-goals honored

External payment execution (NET-W030 — `/payments` stays skeletal and
unimported), creator marketplace, ad inventory, procurement/benefit
pools, blockchain validation, cumulative cross-draw budget
conservation accounting (per-draw cap enforcement; the escrow stake
remains the budget authority), dispute-resolution-driven reversal
orchestration (the existing reverseValue/reverseAllocation primitives
remain the correction path).

## Verification

`bun run verify` → exit 0: typecheck PASS; `arch:check` 245 files /
0 violations; **952 pass / 15 skip / 0 fail**, 8,878 `expect()`
calls, 967 tests / 117 files (post-W013 baseline: 896 pass / 911
tests / 110 files; +56 NET-W014 tests). The frozen specs
(`spec/architecture.md`, `spec/architecture-lock.md`) are untouched.
