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

**NET-W035 — Complete creator lifecycle**

- Issue: #71 — completed
- Implementation PR: #73 — squash-merged
- Final reviewed head: `eaf19bd9292a1c924cf7a8e6d086838369a5affc`
- Merge SHA: `85e5d6d7b8ff1df2fda4740fdd1f541890496610`
- Architectural decision: APPROVED after same-PR remediation.
- Final evidence: `bun run verify` 2330 pass / 15 skip / 0 fail; architecture + authority 322/0; targeted mutations 16/16 caught with byte-identical restoration; real PostgreSQL + Redis 17/17; real-provider creator round-trip 23/23; exact-head CI green; no production `src/` changes.
- Determinism remediation closed the canonical rights/evidence wall-clock blockers and made payment identity deterministic; AC-09 retained genuine composite commit-failure rollback plus healthy same-key exactly-once retry.

### Previous completed milestones

NET-W001 through NET-W035 are complete and merged.

Key authority lineage: W004 workflows; W005 evidence; W006 outcomes/measurement; W008 settlement; W009/W010 disputes; W011 campaigns; W015/W016 creators; W017 rights; W018 disclosure; W019 inventory; W020 clearing; W021 matching; W022 attribution/privacy; W023 supply-chain; W024–W028 demand/procurement/savings/benefits; W029 attestations; W030 external settlement; W031 reputation proofs; W032 decentralized dispute coordination; W033 contribution E2E; W034 advertising E2E; W035 creator E2E.

## Next implementation target

**NET-W036 — Complete demand/procurement/benefit lifecycle**

- Canonical issue: #75 — OPEN, `ready-for-implementation`
- Duplicate transition issues #74, #76, #77 are closed as `duplicate`; temporary stop issue #78 is closed `not_planned`; #75 is the sole authoritative W036 issue.
- Documentation preparation PR: #80 — squash-merged `6d02bcea0b335dd8b8ea71a7316d40f922e38fe9`
- Work order: `spec/work-orders/NET-W036.md` — merged and frozen
- Evidence ledger: `docs/net-w036-complete-demand-procurement-benefit-lifecycle.md` — merged and frozen
- Implementation branch: `feat/net-w036-complete-demand-procurement-benefit-lifecycle`
- Implementation branch base: W035 merge SHA `85e5d6d7b8ff1df2fda4740fdd1f541890496610`
- Dependencies: NET-W028 + NET-W033 — VERIFIED/MERGED
- Scope: demand aggregation → privacy-safe qualified demand → supplier offers/hard eligibility/deterministic selection → fulfillment lifecycle → measurement/outcomes → W027 baseline/counterfactual → verified savings/PoV → `/settlement` → W028 benefit funding/deterministic allocation.

W036 is composition/proof-only. `/demand` owns demand pools/offers/selection; `/workflows` owns lifecycle; `/measurement` + `/outcomes` own measurement integration/semantics; W027 owns savings/baseline/counterfactual; `/evidence` owns provenance/PoV; `/settlement` owns all economic state; `/benefits` owns benefit-pool/allocation semantics; `/adapters` owns provider-specific facts. Do not create a second ledger, lifecycle engine, savings authority, benefit authority or W037 behavior.

The W036 executable order must be proven with authoritative state/version witnesses and durable audit ordering, not merely a local test array or terminal allocation.

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

W035 is complete. W036 is the active implementation target. Its canonical work order and evidence ledger are frozen on `main`, and the implementation branch `feat/net-w036-complete-demand-procurement-benefit-lifecycle` is rooted directly at W035 merge SHA `85e5d6d7b8ff1df2fda4740fdd1f541890496610`. The implementation agent should now implement exactly one W036 PR under `spec/work-orders/NET-W036.md`, with any architect remediation staying on that same PR/branch. Do not introduce W037 behavior or amend frozen architecture.
