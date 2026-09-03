# OpenCon Project State

**Purpose:** durable resume point for a new LLM architect or implementation agent. The repository is the source of truth; chat history is not required.

**Architecture:** v1.0 FROZEN  
**Requirements baseline:** v1.0 APPROVED  
**Canonical roadmap:** `spec/ROADMAP.md`  
**Canonical backlog:** `spec/work-items.md`  
**Canonical architecture:** `spec/architecture.md`  
**Canonical lock:** `spec/architecture-lock.md`  
**Canonical dependency graph:** `spec/dependency-graph.md`  
**Agent entry point:** `AGENTS.md`

## Current checkpoint

### Last merged work item

**NET-W036 — Complete demand/procurement/benefit lifecycle**

- Issue: #75 — completed
- Implementation PR: #81 — squash-merged
- Final reviewed head: `d795b12b3db26c56593357fc8e2da62295c3e8bb`
- Merge SHA: `e7e858e6f5734cf4be0a95b287e6b736f50f3287`
- Architectural decision: APPROVED at the exact reviewed head; merged with exact-head CI green on both the push and pull_request event paths.
- Final evidence: `bun run verify` 2404 pass / 15 skip / 0 fail (2419 tests / 312 files / 34,225 expect() calls); architecture + authority 322 files / 0 violations; targeted mutations 17/17 caught with byte-identical restoration; real PostgreSQL + Redis 17/17; real provider-selection round-trip 26/26 (run twice); secret scan PASS; no production `src/` changes; frozen architecture byte-identical.
- Traversal proof: the full 17-stage witness sequence (demand-pool-resolved → aggregate-disclosure-gated → qualified-demand-resolved → supplier-offers-recorded → supplier-eligibility-evaluated → competitive-selection-committed → fulfillment-entered-sanctioned → execution-state-observed → realized-outcome-normalized → baseline-counterfactual-resolved → savings-verified-pov-qualified → settlement-value-recognized-pending → risk-dispute-controls-exercised → value-matured → benefit-funding-reference-resolved → benefit-allocation-committed → lineage-reconstruction-completed), each with owning authority and durable record id, plus the fulfillment contribution's authoritative state/version ladder (ASSIGNED v2 → IN_PROGRESS v3 → MEASURING v5 → VERIFIED v10) and 44 strictly-ascending durable audit markers from `procurement_pool.created` to `benefits_pool.allocation.recorded`.
- Determinism record: the W036 harness contains zero wall-clock/random code tokens (regression-pinned); the baseline comparison window is derived from the pool's authoritative server-set `createdAt` via pure ISO day arithmetic; all fixture anchors are fixed constants; all canonical idempotency keys are fixed `w036-*` strings.
- Evidence ledger: `docs/net-w036-complete-demand-procurement-benefit-lifecycle.md` — merged as delivered.

### Previous completed milestones

NET-W001 through NET-W036 are complete and merged.

Key authority lineage: W004 workflows; W005 evidence; W006 outcomes/measurement; W008 settlement; W009/W010 disputes; W011 campaigns; W015/W016 creators; W017 rights; W018 disclosure; W019 inventory; W020 clearing; W021 matching; W022 attribution/privacy; W023 supply-chain; W024–W028 demand/procurement/savings/benefits; W029 attestations; W030 external settlement; W031 reputation proofs; W032 decentralized dispute coordination; W033 contribution E2E; W034 advertising E2E; W035 creator E2E; W036 demand/procurement/benefit E2E.

## Post-backlog product target

**UX-01 — Unified product client experience**

- Issue: #83 — OPEN, `ready-for-implementation`
- Governance PR: #82 — squash-merged `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`
- Work order: `spec/work-orders/UX-01.md` — frozen and bound to issue #83
- Evidence ledger: `docs/ux-01-unified-product-client.md` — governance merged; implementation evidence recorded from the product client environment
- Dependencies: none on new protocol work; consumes W001–W036 authorities and the external/versioned product API contract
- Scope: unified Home / Discover / Work / Wallet / You client, server-authoritative actions/value/lifecycle/evidence, responsive/a11y experience, with no protocol authority in the client
- Implementation branch: **to be created from the current `main` checkpoint after this state/roadmap update**

The canonical protocol backlog still terminates at NET-W036. UX-01 is the first authorized post-backlog product-client work item; it does not create W037 protocol behavior and does not amend Architecture v1.0.

## Review lessons that must persist

- Behavioral authority guards require positive and negative fixtures.
- Cross-tenant references fail closed without existence oracles.
- Lifecycle transitions use explicit sanctioned workflow paths.
- Coupled economic mutations use one authoritative transaction and `...WithinTx` primitives.
- Audit publication is post-commit; failed commits discard buffered audit.
- AI/model output is advisory only.
- Production secrets resolve through `SecretProvider` and fail closed.
- Aggregate disclosure gates protect all machine-readable aggregate facts.
- Procurement commitment count and distinct buyer-organization count are separate privacy dimensions.
- Supplier hard eligibility precedes deterministic selection; supplier competition stays in `/demand`.
- Savings/counterfactuals require supported baselines and observed/counterfactual evidence; preserve uncertainty and fail closed on stale/invalid/insufficient support.
- Benefit pools fund from authoritative value references, conserve source value, use deterministic versioned eligibility, and never become a second ledger.
- Completed same-key replay reaches idempotency storage before mutable reads; fresh keys re-check current-state guards.
- Mutation helpers must cause real differences and restore source byte-identically.
- Phase-9 traversal proofs require executable order plus authoritative state/version and durable audit witnesses.
- Atomicity proofs require fault after material work is staged inside the real composite transaction, then a healthy same-key exactly-once retry.
- Canonical proof fixtures must use fixed/authoritative anchors; fresh wall-clock or random identifiers are forbidden except explicitly isolated provider-freshness semantics.

## Quality gate

```bash
bun run verify
```

Material work also requires configured real PostgreSQL/Redis integration. Architectural work requires `arch:check` and `authority:check`; material trust/integrity work requires targeted mutation checks and secret scanning. Phase-9 composition milestones require a real end-to-end provider-selection round-trip.

## GitHub workflow state machine

```text
READY_FOR_IMPLEMENTATION
        ↓
implementation branch
        ↓
verification/evidence
        ↓
exactly one implementation PR
        ↓
architect review
   ┌────┴────┐
   ↓         ↓
CHANGES     APPROVED
REQUESTED      ↓
   ↓         merge
same PR        ↓
   └──→ re-review
```

## Current action

NET-W036 remains the last canonical protocol work item and is complete at PR #81 / merge SHA `e7e858e6f5734cf4be0a95b287e6b736f50f3287`. Governance PR #82 established UX-01 as the first authorized post-backlog product-client work item and merged at `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`; issue #83 is READY_FOR_IMPLEMENTATION. Create the single UX-01 implementation branch from the updated main checkpoint, then implement exactly one UX-01 implementation PR under the frozen work order. Any implementation remediation remains on that same PR/branch. Do not fabricate W037 protocol behavior or amend frozen architecture.
