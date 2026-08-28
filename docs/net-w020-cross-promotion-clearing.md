# NET-W020 — Cross-promotion clearing: implementation evidence

**Work item:** NET-W020 (issue #39 — https://github.com/pectoraux/opencon/issues/39)
**Branch:** `feat/net-w020-cross-promotion-clearing`
**Architecture:** v1.0 FROZEN (`spec/architecture.md`, `spec/architecture-lock.md` byte-identical)
**Work order:** `spec/work-orders/NET-W020.md`
**Requirements:** CAMP-004..005, ECON-001..005 (esp. ECON-003), SETTLE-001..003, INV-004, AUD-001..004 (the §1.1 resolution of record)

## 1. Verification commands

| Command | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun run arch:check` | PASS — 264 files, 0 violations |
| `bun run authority:check` | PASS — 264 files, 0 violations |
| `bun test` | PASS — see the PR verification block for the exact counts (baseline 1289 pass / 15 skip / 0 fail before W020; every W020 suite green, nothing broken) |

## 2. What was built

### 2.1 The authority decision of record (work order §2)

Cross-promotion clearing is an ORCHESTRATION/INTEGRATION concern —
NOT a new domain. The durable clearing records live INSIDE the frozen
`/settlement` boundary (additive); the execution composite is a
composition-root apiCommand (the W014 `executeCampaignClearing`
precedent); the eligibility is a settlement-domain DERIVED view
consumed through four new neutral lookups (the W019
`getPlacementSettlementReadiness` precedent). `/workflows` is
COMPLETELY untouched; `/inventory`, `/campaigns`, `/contributions`,
`/disputes` are consumed read-only. There is NO second ledger: the
clearing record posts NOTHING (no new `EconomicAccountKind`,
`EconomicLedgerTxKind` or `EconomicValueSourceKind` exists — the
pinned vocabularies stay byte-identical) and every economic mutation
flows exclusively through the UNTOUCHED `allocateRewards` /
`issueCredits` / `recordCashObligation` primitives.

### 2.2 Changed/added files

| File | Change |
|---|---|
| `src/settlement/port.ts` | ADDITIVE §NET-W020: the four neutral lookups (contribution/placement/campaign/gate), `CrossPromotionClearingRecord`, the record/evaluate inputs + repository + service contracts, the `cross_promotion_clearing.recorded` audit-event type |
| `src/settlement/clearing-eligibility.ts` | NEW — the PURE evaluator (`evaluateCrossPromotionClearing`: the six-check machine-readable trace; `clearingGateSubjectIds`, `clearingOperationClass` helpers) |
| `src/settlement/clearing-service.ts` | NEW — the service: the derived eligibility view + the AUTHORITATIVE record command (in-tx re-derivation + draw-result verification + create-once pair constraint + the lineage audit event) + tenant-scoped reads |
| `src/settlement/authority-clearing-repository.ts` | NEW — the authority-backed repository (`cross_promotion_clearings` collection) |
| `src/settlement/module.ts`, `src/settlement/README.md` | Additive scope notes |
| `src/bootstrap/runtime.ts` | The four lookup wirings (thin read-only adapters over the owning services/repos), the service wiring, the `executeCrossPromotionClearing` composite (pair mutex → hard gates → derived eligibility → draw → record → campaign bookkeeping) + the read commands + the Runtime exports |
| `src/api/port.ts` | The command declarations (execute / evaluate / get / list) |
| `src/api/server.ts` | `POST /api/settlement/cross-promotion-clearings` (guard `reward.clear`), `GET .../eligibility`, `GET ...` (list), `GET .../:id` |
| `spec/work-orders/NET-W020.md` | NEW — the work order (the design/decision record) |
| `tests/settlement-clearing/*` | NEW — the harness + AC-01..AC-07 suites (32 tests) |
| `tests/regression/net-w020-ac-08-architecture-out-of-scope.test.ts` | NEW — the AC-08 regression (13 tests) |
| `docs/net-w020-cross-promotion-clearing.md` | This evidence document |

## 3. Acceptance criteria → tests → files

| AC | Criterion | Suite (green) | Key evidence |
|---|---|---|---|
| NET-W020-AC-01 | qualifying contributions + settlement-ready placements enter the deterministic clearing | `tests/settlement-clearing/net-w020-ac-01-qualifying-entry.test.ts` (5 tests) | The golden path (all six checks satisfied; reward/credit/cash draws through the canonical primitives); non-VERIFIED contributions and non-ready placements refused with machine-readable reasons |
| NET-W020-AC-02 | eligibility re-derived from current records; never caller-asserted | `tests/settlement-clearing/net-w020-ac-02-derived-eligibility.test.ts` (5 tests) | Paused campaign blocks / resume re-opens; retired placement + withdrawn supply block; the record command's IN-TX re-derivation refuses a stale pre-flight; the structural no-assertion input pin |
| NET-W020-AC-03 | exactly-once settlement through /settlement with conservation | `tests/settlement-clearing/net-w020-ac-03-exactly-once-settlement.test.ts` (4 tests) | ONE allocation per clearing; Σdebit === Σcredit per unit over the whole org; the participant summary moves exactly the drawn amount; the campaign bookkeeping event; a second clearing of the same pair never draws |
| NET-W020-AC-04 | concurrency cannot duplicate; same-key replay deterministic | `tests/settlement-clearing/net-w020-ac-04-concurrency-replay.test.ts` (4 tests) | Concurrent different-key same-pair → ONE winner + the stable `CLEARING_CONFLICT`; concurrent same-key → the identical committed clearing; sequential replay → identical ids, created:false; the mid-chain crash-window replay converges with exactly one draw |
| NET-W020-AC-05 | cross-tenant + stale/withdrawn/retired/ineligible contexts fail closed | `tests/settlement-clearing/net-w020-ac-05-fail-closed.test.ts` (6 tests) | A second-org placement never resolves (no existence oracle); a cross-tenant value record is NotFound; the rules-less campaign binding; over-cap amount; unresolvable rule; the stale-window composite refusal with NOTHING recorded |
| NET-W020-AC-06 | risk/dispute gates consulted before settlement mutation; unbonded disputes do not grief | `tests/settlement-clearing/net-w020-ac-06-risk-dispute-gates.test.ts` (4 tests) | A HOLD control on the contribution refuses (`RISK_CONTROL`, no draw); an ACTIVE bonded dispute refuses (`DISPUTE_CHALLENGE` + the view's gated check) until rejected; a PENDING_STAKE (unbonded) dispute NEVER gates; a person-wide HOLD on the placement owner refuses |
| NET-W020-AC-07 | audit + transaction lineage complete; commit failure leaves no partial economic mutation | `tests/settlement-clearing/net-w020-ac-07-atomicity-lineage.test.ts` (3 tests) | CommitFailingTransaction on the record command → NOTHING persists (no record, no audit) and the healthy replay converges (exactly one allocation + one record); the audit event binds campaign + contribution + placement + clearing record + idempotency record + authoritative transaction + draw transaction + the six-check eligibility trace; the clearing record's ledger footprint is EXACTLY the draw's own transaction |
| NET-W020-AC-08 | architecture/out-of-scope regression with frozen Architecture v1.0 unchanged | `tests/regression/net-w020-ac-08-architecture-out-of-scope.test.ts` (13 tests) | The authority guard (0 violations); the NO-17TH-DOMAIN pin; the NO-SECOND-LEDGER pin (the frozen economic vocabularies byte-identical); the CLEARING-RECORD-POSTS-NOTHING pin; /workflows untouched (subject union + tables + sanctions); NO AI PATH; no payment execution; the non-goal fences; the W019 inventory fence re-proven; the API surface pins; the file list; no secrets |

## 4. Invariant → enforcement map (work order §4)

1. Derived eligibility only — the pure evaluator; NO eligibility input exists on any command (AC-02 structural pin).
2. Currently-settlement-ready source context — the W019 readiness check at evaluation AND in-tx at record time (AC-02).
3. `/settlement` is the sole economic authority — the record posts nothing; the pinned vocabularies are byte-identical (AC-03 + AC-08).
4. Risk/dispute gates before mutation — the composite's hard gates (specific error codes) + the view's gate check + the in-tx re-derivation; PENDING_STAKE never gates (AC-06).
5. Deterministic, idempotent, replay-safe — compound idempotency keys + the advisory pair mutex + the create-once pair record (AC-04).
6. Tenant scoping fail-closed — the value-record scope anchor + same-scope lookups + the in-tx re-derivation (AC-05).
7. Audit lineage binds everything — the `cross_promotion_clearing.recorded` event metadata (AC-07).
8. No AI path — no LLM import anywhere in the clearing surface (AC-08).
9. Frozen architecture unchanged — the regression pins + the byte-identical specs (AC-08).

## 5. Out-of-scope confirmation

No campaign matching/optimization (NET-W021), no attribution/privacy
adapters (NET-W022), no OpenRTB (NET-W023), no demand/procurement/
benefit pools (NET-W024+), no external payment execution (`/payments`
untouched — NET-W030), no decentralized consensus, no cumulative
cross-draw budget conservation accounting (per-draw cap enforcement
only), no clearing-record reversal orchestration (the existing
reversal primitives remain the correction path), no netting engine, no
new economic primitive, no workflow/lifecycle surface, no AI authority
(regression-pinned by AC-08).

## 6. Reproduction

```bash
bun install
bun run verify          # typecheck + arch:check + authority:check + tests
```
