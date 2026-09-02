# NET-W036 Evidence Ledger — Complete demand/procurement/benefit lifecycle

**Status:** DELIVERED — implementation PR #81 open; awaiting architect decision (unmerged per the standing merge rule)  
**Issue:** #75  
**Dependencies:** NET-W028 + NET-W033 — merged/verified  
**Architecture:** v1.0 frozen  
**Preparation branch:** `docs/net-w036-prep`

## 1. Purpose

This ledger is the durable evidence contract for W036. The implementation PR must replace the verification placeholders with exact commands, counts, SHAs, CI runs, test paths and architect-reviewed remediation.

W036 proves one canonical demand/procurement/benefit execution through the existing authorities:

```text
demand pool
→ privacy-safe qualified demand
→ supplier offers / eligibility / deterministic selection
→ fulfillment lifecycle
→ measurement / outcomes
→ W027 baseline / counterfactual
→ evidence / Proof-of-Value
→ settlement
→ W028 benefit funding / allocation
```

A terminal benefit allocation is not sufficient evidence; executable order must be demonstrated with authoritative state/version witnesses and durable audit ordering.

## 2. Evidence contract by authority

| Area | Owner | Forbidden W036 behavior |
|---|---|---|
| demand pools / supplier offers / selection | `/demand` | second procurement authority or hidden supplier economics |
| lifecycle | `/workflows` | local fulfillment state machine |
| measurement integration | `/measurement`, `/adapters` | provider semantics in core |
| normalized outcomes | `/outcomes` | local measurement truth |
| savings/baseline/counterfactual | W027 / `/evidence` existing contracts | new savings semantics or caller-supplied savings |
| evidence / PoV | `/evidence` | caller/provider/model authorization |
| economics | `/settlement` | procurement/benefit ledger |
| benefits | `/benefits` | recreated economic value or second ledger |

## 3. Canonical traversal witness contract

The implementation must emit an ordered witness set with durable ids and owning-authority state/version where applicable. Minimum stages:

1. demand pool resolved;
2. aggregate disclosure gate passed;
3. qualified demand resolved;
4. supplier offers recorded;
5. supplier hard eligibility evaluated;
6. deterministic competitive selection committed;
7. fulfillment/execution entered through sanctioned lifecycle;
8. authoritative execution state/version observed;
9. realized outcome normalized;
10. supported baseline/counterfactual resolved;
11. savings verified / PoV qualified;
12. settlement value recognized pending;
13. applicable risk/dispute controls exercised and resolved;
14. value matured through `/settlement`;
15. benefit funding reference resolved;
16. deterministic member eligibility/allocation committed;
17. final lineage reconstruction completed.

If ordering depends on durable commits, audit insertion/commit order must corroborate the witness order. Local array order alone is not evidence.

## 4. Acceptance evidence map

### AC-01 Demand pool authority

**Required proof:** tenant-scoped pool, authorization, authoritative commitments, qualified demand and fail-closed foreign references.

**Mutation targets:** bypass tenant gate; trust caller aggregate; select unqualified demand.

### AC-02 Aggregate disclosure privacy

**Required proof:** commitment count and distinct buyer-organization count remain separate dimensions; every aggregate is behind the correct disclosure gate.

**Mutation targets:** collapse counts; bypass aggregate gate; leak participant/commercial detail.

### AC-03 Supplier offers and selection

**Required proof:** offers owned by `/demand`, hard eligibility precedes selection, at least one candidate excluded, deterministic winner.

**Mutation targets:** rank before hard gates; accept stale/ineligible offer; let AI/advisory override eligibility; create economic mutation during selection.

### AC-04 Fulfillment lifecycle

**Required proof:** execution uses existing `/workflows` authority wherever lifecycle state applies; no second procurement state machine.

**Mutation targets:** direct state write; bypass sanctioned lifecycle transition.

### AC-05 Measurement/outcomes

**Required proof:** deterministic measurement through provider boundary into `/outcomes`, provenance and uncertainty preserved, raw provider payload contained.

**Mutation targets:** accept before required measurement point; strip uncertainty; leak raw provider data; bypass adapter boundary.

### AC-06 Baseline/counterfactual/savings

**Required proof:** W027-supported baseline/counterfactual, observed/counterfactual evidence, uncertainty preserved, unsupported/stale/invalid support fails closed.

**Mutation targets:** accept unsupported baseline; accept stale baseline; invent deterministic savings from insufficient evidence; drop uncertainty.

### AC-07 Evidence / Proof-of-Value

**Required proof:** verified evidence/PoV authorizes downstream value only through `/evidence`; caller/provider/model assertions do not mint savings.

**Mutation targets:** trust caller grade/value; bypass verification; sever outcome-to-evidence lineage.

### AC-08 Settlement

**Required proof:** verified value enters `/settlement` through existing primitives, pending/mature distinction holds, applicable risk/dispute gates hold, no procurement ledger exists.

**Mutation targets:** recognize unverified value; mature while gated; write outside settlement primitive; create second ledger.

### AC-09 Benefits

**Required proof:** W028 consumes authoritative funded value; deterministic eligibility/allocation; allocation ≤ funded source; remainder/conservation explicit; no private supplier/buyer leakage.

**Mutation targets:** fund from caller-supplied value; allocate beyond funded amount; bypass eligibility; collapse privacy dimensions; write economic state outside settlement.

### AC-10 Replay/concurrency/atomicity/tenancy/lineage/architecture

**Required proof:** same-key replay returns identical records; race yields exactly-once economic effect; commit failure after staged work leaves no partial value/ledger/audit/idempotency state and healthy retry succeeds once; cross-tenant references fail closed; architecture and authority checks remain clean; no W037 behavior.

**Mutation targets:** skip idempotency store; remove concurrency lock; publish audit before commit; suppress rollback; remove tenant recheck; introduce local state/ledger.

## 5. Required implementation evidence

- `bun run typecheck`
- `bun run arch:check`
- `bun run authority:check`
- `bun run verify`
- targeted mutation driver with byte-identical source restoration;
- configured real PostgreSQL + Redis integration;
- applicable real provider-selection end-to-end round-trip;
- secret scan;
- exact changed-file inventory;
- frozen architecture byte comparison;
- one-to-one AC-01..AC-10 suites;
- final traversal and durable audit-order reconstruction;
- exact CI push + pull_request runs at the final reviewed head;
- architect approval and merge SHA.

## 6. Verification record

```text
Implementation PR: #81
Implementation branch: feat/net-w036-complete-demand-procurement-benefit-lifecycle
Reviewed head: see §6.1 note — the second commit (this ledger record); the ledger records the
  implementation-head CI runs; the final-head runs are posted on the PR
Merge SHA: pending — awaiting architect decision (unmerged per the standing merge rule)

Changed files: 14 (13 test files + this ledger)
Production src changes: 0
Frozen architecture file changes: 0

bun run typecheck: PASS
bun run arch:check: 322 files / 0 violations
bun run authority:check: 322 files / 0 violations
bun run verify: 2404 pass / 15 skip / 0 fail / 2419 tests / 312 files / 34,225 expect() calls
Targeted mutations: 17/17 caught; byte-identical restoration: PASS (sha256-verified; post-restore full suite green)
Real PostgreSQL + Redis: 17 pass / 0 fail (dedicated database opencon_w036_integration, created + dropped)
Real provider round-trip: 26 checks / 26 passed (dedicated database opencon_w036_roundtrip over the REAL
  PostgresAuthorityAdapter + RedisCoordinationAdapter + the env-key auto-wired OpenRTB delivery-notice
  provider; run twice; database dropped)
Secret scan: PASS (PAT/keys/tokens absent; only sanctioned test constants)
CI push exact-head: run 33696233835 / PASS (implementation head 238a4e2)
CI pull_request exact-head: run 33696310932 / PASS (implementation head 238a4e2)

Traversal witnesses: the exact 17-stage ledger-§3 sequence (demand-pool-resolved →
  aggregate-disclosure-gated → qualified-demand-resolved → supplier-offers-recorded →
  supplier-eligibility-evaluated → competitive-selection-committed → fulfillment-entered-sanctioned →
  execution-state-observed → realized-outcome-normalized → baseline-counterfactual-resolved →
  savings-verified-pov-qualified → settlement-value-recognized-pending → risk-dispute-controls-exercised →
  value-matured → benefit-funding-reference-resolved → benefit-allocation-committed →
  lineage-reconstruction-completed), each with authority + durable record id + the fulfillment
  contribution's authoritative state/version read through the owning boundary
  (ASSIGNED v2 → IN_PROGRESS v3 → MEASURING v5 → VERIFIED v10)
Durable audit markers: 44 ordered markers, strictly ascending positions, covering
  procurement_pool.created → 3× procurement_commitment.recorded → 4× procurement_offer.recorded →
  procurement_selection.recorded → the contribution lifecycle transition ladder → the
  measurement/outcome/PoV/attestation events → procurement_baseline.created →
  procurement_savings.recorded → economic_value.recorded → risk_control + dispute events →
  economic_value.matured → benefits_policy.version_created → benefits_pool.created →
  benefits_pool.allocation.recorded
AC-09 rollback proof: CommitFailingTransaction over the REBUILT benefit-allocation composite
  (allocation + reward draw + balanced postings + idempotency + buffered audit all staged inside the
  real authoritative transaction; COMMIT fails → nothing persists; healthy same-key retry succeeds
  exactly once)
Same-key retry: recognition + allocation replays return created:false + identical records with exactly
  one audit event each; the draw is never repeated
Concurrent exactly-once proof: 4-way Promise.allSettled same-key allocation race → exactly one
  allocation + one draw + conservation intact
Tenant matrix: cross-tenant pool/offer/selection/savings/benefit reads → NotFound with error-shape parity
  vs nonexistent ids (no existence oracles); cross-scope value/savings funding references fail closed
Benefit conservation: weights 3/2/1 → shares 60/40/20 usd, Σshares === 120 === funded amount
  (last_member_absorbs); retained_in_pool remainder explicitly conserved; assertGlobalConservation green
  over economic_ledger_entries; value record MATURE → CONSUMED exactly-once

Architect decision: PENDING
```

### 6.1 Delivered verification detail

**Determinism decision of record.** The W036 harness contains ZERO `Date.now(`/`randomUUID`/`new Date(`
code tokens (comment-stripped, regression-pinned — stronger than the W035 single-sanctioned-exception
bar; W036 has no provider-freshness wall-clock read at all — the delivery-notice timestamps are fixed
anchors). Fixed anchor values: `W036_EVIDENCE_CAPTURED_AT "2026-09-02T10:00:00.000Z"`,
`W036_RISK_CONTROL_EVALUATED_AT "2026-09-01T12:00:00.000Z"`, `W036_NOTICE_COLLECTED_AT
"2026-08-30T10:00:00.000Z"`, plus the stale anchors (`"2020-01-01…"`). The baseline comparison window
is DERIVED from the pool's authoritative server-set createdAt via pure ISO arithmetic
(`w036IsoMinusDays`; window = createdAt−31d … createdAt−1d), satisfying the 1..365-day length, the
historicality (endsAt ≤ submission), and the 365-day anchor-freshness rules for any wall clock. The
savings observation uses the server-stamped collectedAt (authoritative subject timestamp). All
canonical idempotency keys are fixed `w036-*` strings. Regression pins mechanically enforce the
zero-token contract.

**Deviations of record.**
1. The canonical hard-ineligible supplier-D mechanism is the REVOKED-membership `supplier_authorized`
   gate (reason supplier_membership_not_active) — createSupplierOffer rejects a validUntil not strictly
   after the server-set submission instant, so a deterministically expired-validity offer is
   unconstructible without a wall-clock race.
2. The AC-07 attestation-signature-tamper arm is unconstructible through the real service APIs
   (authority-minted attestations always verify against immutable stored commitments) — covered
   instead by the commitment-integrity (honest/tampered/commitment-less) + wrong-coverage negatives.
3. The AC-04 suite's directory-inventory pin was extended 7→9→11→12 as the staged implementation added
   files (pure filename-list extension, pinned finally by the regression suite).

**Mutation matrix summary.** 17 mutations across the demand/aggregation, competitive-selection,
workflows transition-table, measurement normalization/redaction, savings engine/service, PoV
verification, settlement source-state gate, runtime maturation gates, benefit funding re-derivation,
transactional audit-writer, and the harness determinism anchor — each caught by its targeted one-to-one
AC suite, each restored byte-identically (sha256); the driver/backups/report live outside the repository
and the post-restore full suite is green.

**Real-infrastructure record.** PG 17 (127.0.0.1:55432) + Redis (127.0.0.1:56379); the integration
suite 17/17 on a dedicated created+dropped database. The provider round-trip: 26/26 over the REAL
PostgresAuthorityAdapter + RedisCoordinationAdapter — adapter-class + composition-root
provider-selection assertions; the imported runW036Scenario unmodified over the real runtime; the 17
witnesses + 44 ascending audit markers + terminal states + conservation + full-table privacy scan
(124 rows / 29 collections) + durability re-read through a second adapter instance; run twice;
database dropped.

**Reviewed-head note.** "Reviewed head" is the second commit (this ledger record); its own both-event
CI runs are verified green and posted on PR #81 (the ledger records the implementation-head runs; the
final-head runs appear in the PR verification comment — the W035 clean-path precedent).

## 7. Remediation discipline

Any architect CHANGES REQUESTED finding is remediated on the same implementation PR/branch. Re-run the complete required gate at the resulting exact head, update this ledger, and re-review. No second implementation PR is permitted for W036.

## 8. Decision of record

W036 is a composition/evidence milestone. The implementation must use existing W024–W030/W033 authorities, with W027 savings/counterfactual semantics and W028 benefit semantics treated as existing truth. Missing primitives are formal architecture/work-item gaps, never an invitation to invent authority in W036.
