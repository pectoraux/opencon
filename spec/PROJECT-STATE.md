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

## Next implementation target

**None — the canonical backlog terminates at NET-W036.**

- `spec/work-items.md` defines no work item after NET-W036, and the canonical dependency sequence ends at `W028/W033 → W036`.
- Phases 1–9 are all COMPLETE. There is no authorized next work item.
- Do not fabricate a W037 issue, work order, branch, PR or behavior. The standing "no W037 behavior / no second authority / no architecture amendment" prohibitions recorded in the W036 work order and evidence ledger remain in force.
- The next valid action, if the program continues, is an architect-authored canonical backlog amendment: a new work item defined in `spec/work-items.md` and `spec/dependency-graph.md`, with frozen acceptance criteria, before any implementation branch or PR exists. A seventeenth domain boundary additionally requires an Architecture Change Request and a new architecture version per the program invariant.

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

W036 is complete and merged: PR #81 at merge SHA `e7e858e6f5734cf4be0a95b287e6b736f50f3287`, from architect-approved reviewed head `d795b12b3db26c56593357fc8e2da62295c3e8bb`, with issue #75 completed. The canonical backlog terminates at W036: every work item W001–W036 is merged and verified, and there is no authorized next work item. Do not open new implementation branches or PRs, and do not fabricate W037 issues or behavior. If work resumes, it must begin with an architect-authored backlog amendment that defines the next canonical work item, its dependencies and its acceptance criteria first. Until then, the repository is at its terminal state.
