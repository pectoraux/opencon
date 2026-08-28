# NET-W020 — Cross-promotion clearing

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** CAMP-004..005, ECON-001..005 (esp. ECON-003), SETTLE-001..003, INV-004, AUD-001..004 (see §1.1)
**Dependencies:** NET-W008 (economic ledger), NET-W011 (campaign domain), NET-W014 (reward/settlement integration), NET-W019 (inventory + placement settlement-readiness) — all merged
**Tracking:** issue #39 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Protocol-native cross-promotion clearing: participating companies/apps/creators
exchange qualifying promotional contributions through the existing campaign,
inventory, workflow, evidence, risk/dispute, reputation and settlement
authorities — WITHOUT introducing a second economic or campaign authority:

```text
Qualified Contribution              (/contributions + /workflows + W012/W013 bars)
        +  recognized mature value  (/settlement — the W014 recognition path)
Settlement-ready Placement          (/inventory — the W019 derived readiness gate)
Campaign Clearing Policy            (/campaigns — the declared clearing rules)
Risk/Dispute Gate                   (/disputes — controls + ACTIVE disputes)
        ↓  evaluateCrossPromotionClearing (the DERIVED eligibility view)
Clearing Eligibility                (re-derived from CURRENT records — never stored)
        ↓  executeCrossPromotionClearing (the composition-root composite)
Clearing Execution                  (draw through the EXISTING settlement primitive)
        ↓  recordCrossPromotionClearing + recordClearingExecution
/settlement                         (the SOLE economic authority — conserved)
```

### §1.1 Requirement-family resolution (the decision of record)

The tracking issue cites "AD-001..004, ECON-001..006, CAMP-006". The approved
baseline (`spec/requirements.md`, v1.0) contains NO literal `AD-*`, `ECON-006`
or `CAMP-006` families. Resolution (the NET-W019 guard-resolution precedent —
the frozen baseline is the authority):

- **"AD-001..004"** → **AUD-001..004** (append-oriented audit trail, evidence
  lineage, settlement lineage, reputation lineage): the issue's invariant 7
  ("audit lineage must bind campaign, contribution, placement, clearing
  record, idempotency record and authoritative transaction") is exactly the
  AUD family's operative content. No adapter work is in scope (ADAPTER-001..004
  are NET-W022/W023 non-goals here).
- **"ECON-001..006"** → **ECON-001..005** (no sixth ECON requirement exists
  in the baseline).
- **"CAMP-006"** → **CAMP-004..005** (non-reciprocal cross-promotion +
  multilateral advertising-value clearing) — the canonical backlog provenance
  (`spec/work-items.md` NET-W020) names exactly these.

## §2 Authority separation (the decision of record)

NET-W020 is a clearing/integration layer, NOT a new domain (the NET-W013/W014
decision-of-record chain; the issue's "no new domain, ledger, workflow
engine, reputation engine, risk authority, or payment authority"):

- **`/settlement` — the economic authority — owns the clearing RECORDS.**
  The `CrossPromotionClearingRecord` is an additive first-class record in the
  FROZEN `/settlement` boundary (one of the sixteen frozen core domains;
  architecture.md §18 assigns `/settlement` credits, pending/mature value and
  cash/credit settlement). The record is pure LINEAGE: it references the
  campaign/contribution/placement/value-record/draw-result and snapshots the
  derived eligibility trace — it posts NOTHING itself. The pinned economic
  vocabularies stay byte-identical: NO new `EconomicAccountKind`, NO new
  `EconomicLedgerTxKind`, NO new `EconomicValueSourceKind` (regression-pinned
  by NET-W010/W011/W013/W014 and re-pinned by AC-08). There is no second
  ledger: every economic mutation still flows exclusively through the
  EXISTING `allocateRewards` / `issueCredits` / `recordCashObligation`
  primitives and their conservation guards.
- **The clearing EXECUTION COMPOSITE is a composition-root apiCommand**
  `executeCrossPromotionClearing` (the NET-W014 `executeCampaignClearing`
  precedent exactly): cross-domain orchestration over the existing authority
  services, chained through compound idempotency keys — the draw
  (`{key}:draw`), the clearing record (`{key}:record`), the campaign
  bookkeeping (`{key}:campaign`, REUSING the W014 `recordClearingExecution`
  event — references only).
- **The clearing ELIGIBILITY is a settlement-domain DERIVED VIEW**
  `evaluateCrossPromotionClearing` (the NET-W019
  `getPlacementSettlementReadiness` precedent): re-derived from CURRENT
  durable records through neutral lookups on every read. There is NO command
  that asserts, stores or waives clearing eligibility — callers can only
  REFERENCE records (contribution, placement, value record, rule); every
  eligibility fact is derived.
- **`/campaigns` stays the campaign policy authority**: the clearing rule
  (basis, draw kind, reward-policy reference, hard cap) is READ from the
  campaign's current policy version through a neutral lookup. The W014
  `clearing_executed` bookkeeping event is REUSED unchanged.
- **`/inventory` stays the supply/placement authority**: the target
  placement's settlement readiness is the W019 DERIVED gate, consumed
  READ-ONLY through a neutral lookup. `/inventory` files gain NOTHING (the
  W019 regression fence — no cross-promotion vocabulary in the inventory
  boundary — stays green).
- **`/contributions` + `/workflows` stay the contribution/lifecycle
  authorities**: the source contribution qualifies only in lifecycle state
  VERIFIED with Proof-of-Helpfulness QUALIFIED, a clean derived moderation
  status and no UNSATISFACTORY latest quality evaluation (the EXACT W014
  recognition bar — no second qualification path). `/workflows` is
  COMPLETELY UNTOUCHED: clearing carries NO lifecycle subject kind, NO
  transition table, NO sanction — eligibility is a derived fact and the
  clearing record is an append-only execution fact (the W018/W019
  no-lifecycle precedent; regression-pinned).
- **`/disputes` stays the risk/dispute authority**: the composition root
  consults `refuseWhenGated` (active HOLD/BLOCK controls) +
  `refuseWhenDisputed` (ACTIVE disputes) over the value record, ALL its
  upstream source ids (including the contribution) and the placement id,
  with the value beneficiary AND the placement owner as person subjects —
  BEFORE any settlement mutation (AC-06). Unbonded/pending disputes
  (PENDING_STAKE) NEVER gate clearing (the NET-W010 griefing-resistance
  semantics — no griefing vector; regression-pinned).
- **NO AI path**: model output is never consulted for clearing (advisory
  quality feeds nothing here; the deterministic quality band is the only
  W013 signal consumed, and it can only BLOCK).

## §3 Scope

### §3.1 Neutral lookups (settlement port, additive — dependency inversion)

- `ClearingContributionLookup.resolve(contributionId)` → the structural
  qualification view `{organizationScopeId, lifecycleState,
  contributorPersonId, proofOfHelpfulnessState, moderationStatus,
  qualityBand}` (the W014 composite's four gates as one read-only view) —
  null when unresolvable.
- `ClearingPlacementLookup.readiness(organizationScopeId, placementId)` →
  the W019 readiness view + `{campaignId, campaignPolicyVersion,
  ownerPersonId}` (the placement's campaign binding + registered owner) —
  null when the placement does not resolve in scope.
- `ClearingCampaignRuleLookup.resolve(campaignId)` →
  `{organizationScopeId, administrativeStatus (the campaigns boundary's own field name in its neutral views), currentPolicyVersion,
  clearingRules[]}` — null when the campaign/policy does not resolve.
- `ClearingGateLookup.assess({organizationScopeId, operationClass,
  recordSubjectIds, personSubjectId})` → `{clear, source, controlId,
  disputeId, detail}` — the active-control + ACTIVE-dispute gate read
  (PENDING_STAKE never gates). Used by the derived eligibility view and the
  in-tx re-derivation; the EXECUTION composite additionally uses the
  existing `refuseWhenGated`/`refuseWhenDisputed` helpers for the uniform
  hard-refusal error semantics.

### §3.2 The pure eligibility evaluator (`src/settlement/clearing-eligibility.ts`)

`evaluateCrossPromotionClearing(input)` — a PURE function (the W019
eligibility-engine precedent) over the resolved structural views, returning
`{eligible, checks[], resolvedRule}` with a COMPLETE, machine-readable check
trace (every applicable check, deterministic `reason` codes):

1. `source_contribution_qualified` — VERIFIED + PoH QUALIFIED + moderation ∉
   {REJECTED, FLAGGED_FOR_REVIEW} + quality band ≠ UNSATISFACTORY (absent
   evaluation is allowed — the W014 bar);
2. `placement_settlement_ready` — the W019 readiness `eligible === true`
   (registered owner + available supply + active placement + publishable
   policy scope + satisfied eligibility — re-derived upstream);
3. `placement_campaign_bound` — the placement's campaign binding matches the
   clearing campaign (the placement IS the campaign's inventory context);
4. `campaign_clearing_policy` — campaign ACTIVE + the rule resolves in the
   CURRENT policy version (explicit id, else the single declared rule);
5. `value_eligible` — same scope, MATURE (the CONSUMED replay tolerance of
   the W014 composite), the contribution IS among the value record's sources
   (lineage), amount ≤ `maxDrawAmount`, and the rule's basis is satisfied by
   the source kinds (the W014 basis check);
6. `risk_dispute_gate` — no active control and no ACTIVE dispute over the
   source contexts.

### §3.3 The clearing record + repository + service (in `/settlement`)

- `CrossPromotionClearingRecord` — tenant-scoped, append-only: the canonical
  references (`campaignId`, `campaignPolicyVersion`, `clearingRuleId`,
  `sourceContributionId`, `targetPlacementId`, `valueRecordId`), the draw
  result (`drawKind`, `drawResultId`, `drawTransactionId`, `amount`), the
  ELIGIBILITY SNAPSHOT (the re-derived check trace — deterministic audit
  lineage), `status: "cleared"`, and the standard
  idempotency/execution/correlation/causation lineage. ONE record per
  `(sourceContributionId, targetPlacementId)` — a stable conflict otherwise
  (the W019 active-placement pair precedent).
- `CrossPromotionClearingRepository` — authority-backed
  (`cross_promotion_clearings` collection): `findById`,
  `listByOrganization`, `findByPair`, `findByPairWithinTx`, `createWithinTx`.
- `CrossPromotionClearingService`:
  - `evaluateClearingEligibility(execution, {organizationScopeId,
    sourceContributionId, targetPlacementId, valueRecordId,
    clearingRuleId?})` — the DERIVED view (§3.2 + the lookups + the value
    repository). Read-only; cross-scope references fail closed.
  - `recordCrossPromotionClearing(execution, {organizationScopeId,
    sourceContributionId, targetPlacementId, valueRecordId, clearingRuleId,
    drawKind, drawResultId, idempotencyKey})` — the AUTHORITATIVE record
    command: applied idempotently in ONE authoritative transaction that
    (a) RE-DERIVES the full eligibility in-tx through the lookups + the
    value repository (nothing caller-asserted qualifies), (b) VERIFIES
    the draw result through the SAME domain's allocation/issuance/
    obligation repositories (same scope, same value record,
    kind-consistent amount — a fabricated draw reference cannot be
    recorded), and (c) enforces the create-once pair constraint (a
    second record for the same pair is a stable `CLEARING_CONFLICT`).
    Pair-level serialization is the COMPOSITE's contract (§3.4 step 2
    holds the advisory pair mutex across the whole chain — the record
    command itself must NOT re-acquire it: withLock is not reentrant);
    the record command is serialized per idempotency key by
    applyIdempotent, with the in-tx pair check as the durable
    backstop. Commits the `cross_promotion_clearing.recorded` audit
    event binding campaign + contribution + placement + clearing
    record + idempotency record + authoritative transaction + draw
    transaction.
  - `getCrossPromotionClearing` / `listCrossPromotionClearings` —
    tenant-scoped reads.

### §3.4 The execution composite (the atomic clearing operation — §3.4a)

`executeCrossPromotionClearing` (input: `{sourceContributionId,
targetPlacementId, valueRecordId, clearingRuleId?, creditsPerValueUnit?,
cashKind?, counterpartyPersonId?, cashAmount?, description?,
idempotencyKey}`):

1. The VALUE RECORD anchors the tenant scope (the economic authority's own
   record); the contribution, placement and campaign must all resolve
   same-scope (cross-tenant → fail closed BEFORE any status logic).
2. Advisory pair mutex over the whole operation (§3.3) — concurrent
   same-pair attempts serialize; the pre-flight pair check fails a second
   DIFFERENT-key attempt BEFORE any economic mutation, while a SAME-key
   replay returns the committed composite result verbatim
   (`created:false`).
3. Pre-flight (fast-fail, committed reads): hard gates with the uniform
   `RISK_CONTROL`/`DISPUTE_CHALLENGE` codes over
   `[value.id, ...value.sources[].id, placementId]` with the value
   beneficiary and the placement owner as person subjects (the W014
   source-scoped discipline + the placement source context), then the
   derived evaluation must be `eligible` (§3.2).
4. THE SINGLE AUTHORITATIVE TRANSACTION (§3.4a): the campaign
   bookkeeping lock + the economic account locks (the exact set the
   selected draw primitive's standalone form would acquire; the reward
   policy version is PINNED so the locked and posted accounts are always
   the same set) are held across ONE `IdempotencyStore.applyIdempotent`
   under the composite key
   `cross_promotion_clearing_execute:{org}:{contribution}:{placement}:{key}`
   whose ONE `AuthorityTransaction` executes, in order:
   - the in-tx fresh value read (TOCTOU closure);
   - the in-tx hard gates (the authoritative pass, uniform codes);
   - the in-tx eligibility re-derivation (the authoritative pre-draw bar)
     + the rule/policy drift refusal;
   - THE DRAW — the same-domain `...WithinTx` primitive selected by the
     rule's `drawKind` (posting + allocation/issuance/obligation record +
     exactly-once value consumption), staged on THIS transaction;
   - the clearing record (`recordCrossPromotionClearingWithinTx`:
     re-derives eligibility with the post-draw CONSUMED tolerance,
     verifies the STAGED draw result in-tx, the create-once pair
     backstop, the audit lineage);
   - the campaign clearing bookkeeping (`recordClearingExecutionWithinTx`
     through the neutral port — the event append + audit lineage);
   - COMMIT — everything durable together, or NOTHING.
5. The composition-root apiCommand is the THIN adapter: input coercion +
   the view mapping over the committed composite result.

### §3.4a THE SINGLE AUTHORITATIVE TRANSACTION (the PR #40 remediation decision of record)

The architect review of PR #40 (CHANGES REQUESTED) found the original
composite chained FOUR separately-committed transactions (the draw's own
`applyIdempotent`, then the record's, then the campaign bookkeeping's), so
a failure after the draw's commit could leave a committed economic
mutation without its clearing record — precisely a PARTIAL ECONOMIC
MUTATION, violating AC-07's "authoritative commit failure leaves no
partial economic mutation". The remediation (this section):

- **ONE transaction boundary.** The whole clearing operation — qualify →
  risk/dispute gate → draw → clearing record → campaign bookkeeping — is
  ONE exactly-once economic unit in ONE authoritative transaction (the
  architect's preferred shape verbatim). The composite moved INTO the
  settlement domain (`CrossPromotionClearingService.executeCrossPromotionClearing`),
  making it a settlement-authority transaction API over the same-domain
  `...WithinTx` draw primitives
  (`allocateRewardsWithinTx`/`issueCreditsWithinTx`/`recordCashObligationWithinTx`)
  — the composition root never calls the transaction-owning draw commands
  from the clearing composite (structurally pinned by the AC-08
  regression).
- **No compensating reversals.** A committed economic mutation followed by
  a compensating mutation is NOT the same atomic boundary; the remediation
  contains NO compensating-reversal machinery — the transaction either
  commits whole or rolls back whole.
- **Campaign bookkeeping participates in the SAME transaction** (the
  review's "former" option): the campaigns domain exposes
  `recordClearingExecutionWithinTx` (the same bookkeeping body on the
  caller's transaction) through the neutral `ClearingCampaignBookkeepingPort`;
  the composite holds the campaign record's own serialization key
  (`campaign_record:{id}`) ACROSS the transaction (the campaign save is
  last-write-wins; the standalone bookkeeping command serializes on the
  same key).
- **Exactly-once.** ONE idempotency record (the composite key) covers the
  whole unit: a same-key retry replays the committed composite result
  verbatim; a crash (or an injected COMMIT failure) leaves NO state — the
  retry re-executes the whole unit. The pre-remediation compound
  step keys (`{key}:draw`/`{key}:record`/`{key}:campaign`) and the
  mid-chain crash window they created are ELIMINATED (a value consumed by
  a DIRECT primitive draw now fails the composite closed — the primitive
  is the exactly-once consumption authority; the composite never adopts a
  foreign draw).
- **Required regression (the review's exact scenario).** AC-07's
  composite-level fault injection runs the ACTUAL end-to-end operation
  against a COMMIT-FAILING authority (the economic draw fully staged
  inside the transaction) and asserts — simultaneously — no clearing
  record, no reward allocation, no economic ledger entries, no campaign
  clearing bookkeeping event, no clearing audit event, no idempotency
  record, the value in its pre-clearing state, and the same-key retry
  succeeding exactly once; plus the successful-path SAME-LINEAGE assertion
  (the clearing record, the economic draw, the campaign bookkeeping and
  every audit event reference ONE transaction id and ONE idempotency
  record).
- **Lock ordering** (deadlock freedom): pair mutex → campaign bookkeeping
  lock → economic account locks (ascending account id) → the composite
  per-key mutex. The standalone primitives take economic locks → their own
  key mutex (never the pair/campaign locks); the standalone bookkeeping
  takes the campaign lock → its own key mutex (never the account locks) —
  no cycle exists.

**Replay-safety/recovery (AC-07)**: the whole unit commits atomically —
there is NO mid-chain state to converge from; a same-key retry after a
failed commit re-executes the unit exactly once (the injected-COMMIT-failure
regression proves it end-to-end).

### §3.5 API surface

- `POST /api/settlement/cross-promotion-clearings` (protected; guard action
  `reward.clear`) — the composite.
- `GET /api/settlement/cross-promotion-clearings` — tenant-scoped list.
- `GET /api/settlement/cross-promotion-clearings/:id` — one record.
- `GET /api/settlement/cross-promotion-clearings/eligibility?organizationScopeId=…&sourceContributionId=…&targetPlacementId=…&valueRecordId=…`
  — the DERIVED eligibility view (public read; re-derived every call).

## §4 Invariants (mechanically enforced)

1. Clearing is derived over valid campaign+contribution+placement context —
   the §3.2 evaluator (no caller-asserted eligibility input EXISTS).
2. The inventory source context is currently settlement-ready at clearing
   time — the W019 readiness check re-derived at evaluation AND in-tx at
   record time (a retired/withdrawn/paused context fails closed).
3. `/settlement` stays the sole economic authority — the clearing record
   posts nothing; the draw flows through the untouched primitives; the
   pinned economic vocabularies are byte-identical (AC-08).
4. Risk/dispute gates are consulted before settlement mutation — §3.4
   step 3 (pre-flight) + step 4's in-tx pass; PENDING_STAKE disputes
   never gate (griefing resistance).
5. Clearing is deterministic, idempotent and replay-safe — ONE
   composite idempotency key over the WHOLE atomic unit (§3.4a) + the
   pair mutex + the create-once pair record; concurrent same-pair
   attempts cannot duplicate value (AC-04).
6. Tenant scoping is fail-closed — the value-record scope anchor + every
   lookup's same-scope resolution + the in-tx re-derivation (AC-05).
7. Audit lineage binds campaign, contribution, placement, clearing record,
   idempotency record and authoritative transaction — the
   `cross_promotion_clearing.recorded` event metadata; THE WHOLE
   OPERATION commits in ONE authoritative transaction whose id (and ONE
   idempotency record) appears on the draw's, the record's AND the
   campaign bookkeeping's audit events (AC-07, §3.4a).
8. No AI path — no LLM import in any clearing artifact; the deterministic
   quality band is the only W013 signal and can only BLOCK (AC-08).
9. Frozen architecture/architecture-lock unchanged (AC-08).

## §5 Non-goals

Campaign matching/optimization (NET-W021), attribution/privacy adapters
(NET-W022), OpenRTB (NET-W023), demand/procurement/benefit pools (NET-W024+),
external payment execution (NET-W030; cash draws book internal obligations
only), decentralized consensus, cumulative cross-draw budget conservation
accounting (per-draw cap enforcement only — the campaign budget stake stays
escrow bookkeeping), clearing-record reversal orchestration (the EXISTING
`reverseAllocation`/`reverseIssuance`/`reverseCashObligation` primitives
remain the correction path), netting/offsetting logic (multilateral clearing
here composes per-operation draws; netting is future work), any new economic
primitive, any workflow/lifecycle surface, any AI authority.

## §6 Acceptance criteria → tests

| AC | Criterion | Suite |
|---|---|---|
| NET-W020-AC-01 | qualifying source contributions + settlement-ready placements enter the deterministic clearing operation | `tests/settlement-clearing/net-w020-ac-01-qualifying-entry.test.ts` |
| NET-W020-AC-02 | clearing eligibility is re-derived from current authoritative records and cannot be caller-asserted | `tests/settlement-clearing/net-w020-ac-02-derived-eligibility.test.ts` |
| NET-W020-AC-03 | each clearing results in exactly-once economic settlement through /settlement with conservation preserved | `tests/settlement-clearing/net-w020-ac-03-exactly-once-settlement.test.ts` |
| NET-W020-AC-04 | concurrent same-clearing attempts cannot duplicate value; same-key replay is deterministic | `tests/settlement-clearing/net-w020-ac-04-concurrency-replay.test.ts` |
| NET-W020-AC-05 | cross-tenant and stale/withdrawn/retired/ineligible inventory contexts fail closed | `tests/settlement-clearing/net-w020-ac-05-fail-closed.test.ts` |
| NET-W020-AC-06 | risk/dispute gates are consulted on source contexts before settlement mutation; unbonded disputes do not grief | `tests/settlement-clearing/net-w020-ac-06-risk-dispute-gates.test.ts` |
| NET-W020-AC-07 | audit + transaction lineage complete; authoritative commit failure leaves no partial economic mutation — THE COMPOSITE-LEVEL FAULT INJECTION (the PR #40 remediation regression: the actual end-to-end operation against a commit-failing authority, the draw staged in-tx) + the SAME-LINEAGE successful path | `tests/settlement-clearing/net-w020-ac-07-atomicity-lineage.test.ts` |
| NET-W020-AC-08 | architecture/out-of-scope regression with frozen Architecture v1.0 unchanged | `tests/regression/net-w020-ac-08-architecture-out-of-scope.test.ts` |

## §7 Verification

`bun run verify` (typecheck + `arch:check` + `authority:check` + the full
test suite) must pass. Frozen specs (`spec/architecture.md`,
`spec/architecture-lock.md`) remain byte-identical. Evidence document:
`docs/net-w020-cross-promotion-clearing.md`.
