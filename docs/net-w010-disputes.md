# NET-W010 — Stake, challenges, disputes and appeals (evidence)

**Work order:** `spec/work-orders/NET-W010.md` (canonical issue #19)
**Architecture:** v1.0 FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched
**Status:** implemented on `feat/net-w010-disputes-challenges`

## 1. Component map

| Piece | File | Notes |
| ----- | ---- | ----- |
| Core dispute vocabulary | `src/core/disputes.ts` | kinds/states/outcomes/control+stake dispositions/subject types; deterministic window math (`challengeWindowExpiry`, `appealWindowExpiry`, `isWithinWindow`) and the frozen `stakeDispositionForOutcome` mapping; policy lineage `NET-W010:1`. Pure data + validation only. |
| Stake escrow vocabulary | `src/core/economics.ts` (additive) | `stake_escrow` account kind (credit-normal, credits unit), `stake_commit`/`stake_release`/`stake_forfeit` tx kinds, `stake` ledger subject kind (in `settlement/port.ts`), `ECONOMIC_STAKE_STATES`, `dispute_challenge` purpose kind. |
| `risk_case` source kind | `src/core/risk.ts` (additive) | a resolved risk CASE is an authoritative prior decision — citable as a supporting reference. |
| Stake commands (economic authority) | `src/settlement/stake-service.ts`, `src/settlement/authority-stake-repository.ts` | commit/release/forfeit through the shared posting layer; per-purpose + per-record + per-account lock ordering; one COMMITTED stake per purpose; append-only outcome lineage; `stake.*` audit events. |
| Dispute aggregate | `src/disputes/dispute-service.ts`, `src/disputes/authority-dispute-repository.ts` (collection `disputes`), port additions in `src/disputes/port.ts` | openDispute (eligibility gate) → bondStake (read-only settlement verification) → startReview (COI gate) → resolveDispute/rejectDispute → appealDispute (new linked record) / withdrawDispute; markStakeOutcome bookkeeping; `dispute.*` audit events (8 types). |
| Neutral lookups | composition root (`src/bootstrap/runtime.ts`) | `DisputeSubjectLookup` over the owning domains' repositories (per-kind authoritative anchor + beneficiary), `DisputeStakeLookup` over the stake repository (read-only), `RiskRecordLookup.resolveCase` (additive). |
| Dispute gate | composition root (`refuseWhenDisputed`) | lock invariant 21 (disputed half): refuses maturation/issuance/allocation when an ACTIVE dispute (OPEN/UNDER_REVIEW/APPEALED) covers the record id or any upstream source id; `DISPUTE_CHALLENGE` precondition error. |
| Composite commands | composition root (`apiCommands`) | bond/reject/resolve/withdraw sequence dispute decisions + settlement stake commands with compound idempotency keys (`:stake`, `:bond`, `:release`, `:forfeit`, `:record`). |
| API surface | `src/api/port.ts`, `src/api/server.ts` | 7 guarded mutation routes (`dispute.open`…`dispute.withdraw`) + dispute/stake reads. |

## 2. The authority-separation decision of record

The work item's strongest constraint — `/disputes` owns decisions,
`/settlement` owns economics — is enforced structurally at THREE
layers:

1. **Domain code:** `src/disputes/dispute-service.ts` contains NO
   stake command and NO posting path (asserted by the AC-08 denylist:
   `commitStake`/`releaseStake`/`forfeitStake`/`postLedgerTransaction`
   are forbidden identifiers in `/disputes`). Its only settlement
   touchpoints are the READ-ONLY stake lookup (`bondStake` verifies;
   `markStakeOutcome` verifies the terminal state) and bookkeeping
   fields on the dispute record.
2. **Composition root:** the composite commands sequence the two
   authorities with compound idempotency keys — the exact
   `applyWorkflowHold` precedent from NET-W009. A retried composite
   replays each step idempotently.
3. **Regression tests:** `net-w010-ac-08` asserts the commands live in
   `/settlement`, the dispute gate lives only in the composition root,
   and `/evidence`, `/reputation`, `/workflows` carry no
   `/disputes` imports (invariants 2–3). A full dispute lifecycle
   leaves reputation/evidence/contribution state byte-identical
   (AC-07).

## 3. Invariant → enforcement mapping

| # | Invariant (Issue #19) | Enforcement |
| - | --------------------- | ----------- |
| 1 | No hidden economic authority | Stake postings exist only in `/settlement/stake-service.ts` (posting layer conservation + non-negative guards); disputes carry no economic-unit mutation methods (AC-03, AC-07, AC-08 denylists). |
| 2 | No direct reputation mutation | No reputation imports/mutations in `/disputes`; the full-lifecycle test snapshots reputation records (AC-07). |
| 3 | No evidence rewriting | Disputes reference evidence as subjects/sources only; AC-07 snapshots evidence records across a lifecycle. |
| 4 | Determinism | Explicit `effectiveAt` against authoritative subject anchors (inclusive window bounds); server wall clock only for event/audit `recordedAt` (the NET-W009 convention); the outcome→stake mapping is a frozen pure function; `policyVersion` lineage on every record (AC-02, AC-04). |
| 5 | Authority separation | §2 above; the control disposition is RECORDED for consumers (`RELEASE_CONTROL` etc.), never executed against `/workflows` here (AC-07). |
| 6 | Tenant isolation | Subject scope checks at open (scope mismatch rejected); stake owner/purpose/linkage checks at bond; org-scoped listings; the gate read is org-scoped (AC-01, AC-02, AC-03). |
| 7 | Auditability + atomicity | Every mutation = `applyIdempotent` + `*WithinTx` writes + transactional audit buffer in ONE authoritative transaction; idempotency/transaction lineage in every audit event; rollback cleanliness (AC-05, AC-06). |
| 8 | Append-only resolution | Events only append; the resolution block is immutable; appeals create NEW linked records and flip the original via an append-only event + forward pointer (AC-01, AC-04). |

## 4. Design decisions

1. **One aggregate record (`DisputeRecord`), kind CHALLENGE|APPEAL.**
   Appeals are new linked records with their own full stake/review
   cycle ("APPEAL (0..n)" — each appeal can itself be resolved and
   appealed); the original's `APPEALED` state is terminal with a
   forward pointer, its resolution byte-identical (the NET-W009
   supersession-flip pattern).
2. **`PENDING_STAKE` is a pre-formal state.** The two-step explicit
   bonding (open → bond) keeps stake placement an explicit,
   separately-authorized economic command — and an UNBONDED challenge
   request never gates downstream operations (griefing resistance:
   freezing a claim requires putting 10 credits in escrow). The work
   item's state list is explicitly illustrative ("for example OPEN,
   …"); PENDING_STAKE is documented in the frozen core vocabulary.
3. **The gate matches record id ∪ upstream source ids.** Disputing
   the PoV blocks maturation of the value it backs — "disputed value
   cannot mature prematurely" (work-item DoD) covers the claim chain,
   not just the leaf record.
4. **Resolution requires a started review** (due process — stricter
   than the NET-W009 case's direct-resolve path) and the reviewer is
   COI-barred from both the challenger and the subject beneficiary.
5. **The stake disposition is derived, never chosen.** REJECTED →
   RELEASE; UPHELD/DISMISSED → RELEASE; DENIED → FORFEIT (the
   unsuccessful-challenge penalty); WITHDRAWN → RELEASE. Reviewers
   cannot override (invariant 4).
6. **Serialization beyond the idempotency key.** The duplicate gate
   guards the SUBJECT (`dispute_subject:{org}:{type}:{id}` mutex) and
   the state machine guards the RECORD (`dispute_record:{id}` mutex) —
   the same org-independent-lock reasoning as the NET-W007 lineage
   remediation; different-key concurrent mutations serialize to
   exactly one committed history (AC-06).
7. **Additive frozen-vocabulary extensions.** `stake_escrow`, the
   three stake tx kinds, the `stake` subject kind, `risk_case` source
   kind, and `RiskRecordLookup.resolveCase` — each documented as
   NET-W010 additive, non-breaking; the NET-W008 account-kind pin and
   the NET-W009 dispute denylist were amended deliberately with
   comments pointing at this work order.
8. **`/settlement` stays dispute-free.** The stake service implements
   ECONOMIC encumbrance primitives only — no dispute states, windows
   or lifecycle (asserted by the untouched NET-W008 denylist:
   `disputeState`/`challengeWindow`/`bondStake` remain forbidden
   identifiers in `/settlement`; the stake command names
   `commitStake`/`releaseStake`/`forfeitStake` deliberately avoid
   them).

## 5. API surface (NET-W010)

| Route | Action | Guard |
| ----- | ------ | ----- |
| `POST /api/disputes` | open (challenge request → PENDING_STAKE) | `dispute.open` |
| `POST /api/disputes/:id/bond` | bond the stake (settlement commit + dispute bond) | `dispute.bond` |
| `POST /api/disputes/:id/review` | start review (COI gate) | `dispute.review` |
| `POST /api/disputes/:id/reject` | reject (inadmissible; stake RELEASE) | `dispute.reject` |
| `POST /api/disputes/:id/resolve` | resolve (outcome + control disposition + deterministic stake consequence) | `dispute.resolve` |
| `POST /api/disputes/:id/appeal` | appeal (new linked record) | `dispute.appeal` |
| `POST /api/disputes/:id/withdraw` | withdraw (stake RELEASE) | `dispute.withdraw` |
| `GET /api/disputes?organizationScopeId=&state=` | org listing (state filter) | public read |
| `GET /api/disputes/:id` | record + immutable history | public read |
| `GET /api/stakes/:id` | the settlement authority's stake record | public read |

## 6. AC → test mapping

| AC | Suite | Highlights |
| -- | ----- | ---------- |
| AC-01 | `tests/disputes/net-w010-ac-01-records.test.ts` | full record shape; byte-identical prior events; durability; org-scoped listings; PENDING_STAKE never gates. |
| AC-02 | `tests/disputes/net-w010-ac-02-eligibility.test.ts` | person-actor authorization; unknown/cross-scope subjects; before/after-window refusals (boundary inclusive); duplicate gate + reopening after resolution; reason/refs required; same-key replay. |
| AC-03 | `tests/disputes/net-w010-ac-03-stakes.test.ts` | escrow accounting + conservation; purpose linkage + ledger subject lineage; over-commitment refused; one committed stake per purpose; foreign stake cannot bond; release/forfeit postings. |
| AC-04 | `tests/disputes/net-w010-ac-04-lifecycle.test.ts` | resolve-requires-review; vocabulary checks; DENIED⇒FORFEIT derivation; double bond/withdraw refusals; appeal = new linked record with byte-identical original resolution; window/standing refusals. |
| AC-05 | `tests/disputes/net-w010-ac-05-reviewers.test.ts` | COI (challenger + beneficiary) on review AND resolve; reviewer identity from the execution actor; audit events with reasons/refs/lineage. |
| AC-06 | `tests/disputes/net-w010-ac-06-atomicity.test.ts` | same-key concurrency (one record, one audit event); different-key concurrent opens/resolves (exactly one committed history); rollback cleanliness; atomic audit lineage. |
| AC-07 | `tests/disputes/net-w010-ac-07-authority.test.ts` | `refuseWhenDisputed` on the guarded maturation command; PENDING_STAKE non-gating + post-resolution reopening; source-id gate coverage; trust-surface immutability across a full lifecycle; no economic-unit mutation surface on the record; global conservation. |
| AC-08 | `tests/regression/net-w010-ac-08-architecture-out-of-scope.test.ts` | arch check 0 violations; FROZEN specs + invariant-21 sentence intact; work-order binding; module readiness; denylists (stake commands forbidden in `/disputes`; dispute lifecycle forbidden in `/settlement`); gate-only-at-composition-root; no cross-domain imports in evidence/reputation/workflows; frozen vocabulary pins; expected files; secrets scan. |

## 7. Verification summary

- `bun run typecheck` — PASS.
- `bun run arch:check` — PASS (233 files, 0 violations).
- `bun test` — all NET-W010 suites green (AC-01..07: 50 tests) + the
  AC-08 regression green + every prior suite (NET-W001..W009)
  unchanged-green except the two deliberate amendments documented in
  §4.7 (the NET-W008 `ECONOMIC_ACCOUNT_KINDS` pin gains `stake_escrow`;
  the NET-W009 dispute denylist drops `bondStake`/`resolveDispute`,
  which are now legitimate NET-W010 `/disputes` identifiers, while
  keeping every economic-mutation/provider/decentralized pattern
  forbidden).
- Frozen specs untouched: `spec/architecture.md`,
  `spec/architecture-lock.md`, `spec/requirements.md`,
  `spec/dependency-graph.md`, `spec/work-items.md` unmodified.
