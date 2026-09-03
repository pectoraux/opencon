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
**Architect handoff:** `docs/LLM-ARCHITECT-HANDOFF.md`  
**Post-backlog use-case governance:** `spec/USE-CASE-PROGRAM.md`

## Current checkpoint

### Last merged canonical protocol work item

**NET-W036 — Complete demand/procurement/benefit lifecycle**

- Implementation PR: #81 — squash-merged
- Final reviewed head: `d795b12b3db26c56593357fc8e2da62295c3e8bb`
- Merge SHA: `e7e858e6f5734cf4be0a95b287e6b736f50f3287`
- Status: COMPLETE

NET-W001 through NET-W036 are complete and merged. The canonical protocol backlog terminates at NET-W036.

### Post-backlog product work completed

**UX-01 — Unified product client experience**

- Governance PR: #82 — squash-merged `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`
- Issue: #83 — closed as `completed`
- Work order: `spec/work-orders/UX-01.md` — frozen
- Evidence ledger: `docs/ux-01-unified-product-client.md` — COMPLETE
- Implementation PR: #84 — squash-merged `d87977c7ed14bb67f51925a3d3d09c67e76c79a1`
- Final reviewed head: `acc44c90789f0705d7b3866dc893accc9333c50a`
- Architectural decision: APPROVED at the exact reviewed head.
- Repository change: documentation-only implementation record; no frontend surface or client authority added to the protocol repository.
- Evidence: 23 interaction-path tests / 125 assertions; protocol repository architecture + authority checks 322/0; product-client scaffold arch baseline unchanged at 7 pre-existing violations; fresh browser verification of five destinations, creator/dispute/campaign/benefit journeys, deep links, responsive behavior and zero console/page errors; exact-head CI green including real PostgreSQL + Redis integration.
- Pre-PR defects remediated and reverified: fragment navigation rerendering, settled campaign-spend wallet semantics, 390px grid overflow, and page title.

## Current program position

**STATUS: POST-BACKLOG GOVERNANCE CHECKPOINT — no successor work item is currently authorized.**

The canonical protocol backlog remains W001–W036. UX-01 is complete as the first authorized post-backlog product-client work item. Do not invent W037, UX-02, a new dependency edge, or a new architecture version without an architect-authored governance amendment.

The next intended operating mode is **use-case-driven platform validation**. The governing method is frozen in `spec/USE-CASE-PROGRAM.md` and summarized in `docs/LLM-ARCHITECT-HANDOFF.md`. Realistic end-to-end scenarios should be used to exercise as much of the existing platform as possible while preserving authority boundaries. A candidate scenario is not an authorized implementation.

### Next valid action

The next architect should:

1. review the completed W001–W036 protocol evidence and UX-01 product evidence;
2. select candidate real-world use cases using the coverage/ranking model in `spec/USE-CASE-PROGRAM.md`;
3. classify capability gaps instead of implementing missing behavior opportunistically;
4. author and approve one governance-bound use-case work item with frozen scope, acceptance criteria, authority placement, evidence contract, verification gate and GitHub issue binding;
5. only then create its implementation branch and exactly one implementation PR.

No successor work item is currently authorized.

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
- Product clients consume the versioned API and cannot become protocol authority; backend capability gaps require separately authorized `/api` or integration work.

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

Never merge merely because CI is green. Any CHANGES REQUESTED remediation stays on the same implementation PR/branch.
