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

- GitHub issue: #71 — completed
- Implementation PR: #73 — squash-merged
- Final reviewed head: `eaf19bd9292a1c924cf7a8e6d086838369a5affc`
- Merge SHA: `85e5d6d7b8ff1df2fda4740fdd1f541890496610`
- Documentation preparation PR: #72 — squash-merged `d480b71521a72de6bee63a7dc9cf58ff1cfedc3a`
- Status: MERGED
- Architectural decision: APPROVED after same-PR remediation.
- Scope: Phase-9 creator composition/evidence milestone; no new production domain, authority, ledger, workflow engine, payment primitive, crypto primitive, AI authority or frozen-architecture amendment.
- Canonical traversal proven: creator discovery/matching → campaign terms → W017 acceptance/rights → contribution entry → UGC/rights → W018 disclosure/compliance → `/workflows` MEASURING → real W022 measurement → `/outcomes` → `/evidence` PoV → PoH → workflow VERIFIED → settlement pending → risk/dispute gates → settlement matured → W030 external payment.
- Final evidence: `bun run verify` 2330 pass / 15 skip / 0 fail; architecture + authority checks 322 files / 0 violations; targeted mutations 16/16 caught with byte-identical restoration; real PostgreSQL + Redis 17/17; real-provider creator round-trip 23/23; exact-head CI green; no production `src/` changes.
- Same-PR remediation closed two determinism blockers: fixed/authoritative anchors replaced canonical wall-clock rights/evidence timestamps; payment identity became deterministic from the authoritative value record and signing timestamp fixed, with only the W030 freshness observation remaining wall-clock-dependent. The strengthened regression pin and M13–M16 mutations protect the fix.
- AC-09 used a genuine composite-level commit-failure proof with real repositories/ledger/idempotency/audit writer, proving no partial state survives and a healthy same-key retry commits exactly once.

### Previous completed milestones

NET-W001 through NET-W035 are complete and merged.

Important lineage checkpoints:
- W004 `/workflows` lifecycle authority
- W005 `/evidence` provenance/truth authority
- W006 `/outcomes` normalized measurement authority
- W007 deterministic multidimensional reputation
- W008 `/settlement` economic ledger / credits / cash / settlement primitives
- W009/W010 `/disputes` risk and dispute authority
- W011 `/campaigns` policy authority
- W012/W013 contribution helpfulness, quality and moderation
- W014 settlement/reward integration
- W015/W016 creator identity, preferences and matching
- W017 UGC workflow/rights and atomic composites
- W018 sanctioned publication/disclosure gate
- W019 inventory/placements and derived settlement-readiness
- W020 cross-promotion clearing with one authoritative economic transaction
- W021 campaign matching/optimization; selection-only, bounded AI advisory
- W022 attribution/privacy adapter boundary
- W023 OpenRTB/supply-chain adapters with authenticated + fresh verification
- W024 privacy-preserving consumer demand pools
- W025 competition-preserving business procurement pools
- W026 supplier offers and deterministic competitive selection
- W027 verified savings and counterfactuals
- W028 benefit pools
- W029 cryptographic attestations and commitments
- W030 external settlement adapters
- W031 portable reputation proofs
- W032 decentralized validation/dispute coordination inside `/disputes`
- W033 complete contribution lifecycle composition proof
- W034 complete advertising lifecycle composition proof
- W035 complete creator lifecycle composition proof

## Next implementation target

**NET-W036 — Complete demand/procurement/benefit lifecycle**

- Canonical GitHub issue: #75 — OPEN, `ready-for-implementation`
- Duplicate transition issues #74, #76, #77 were closed as `duplicate`; issue #78 was a temporary stop marker and is closed `not_planned`. Issue #75 is the only authoritative W036 issue.
- Documentation preparation PR: #80 — squash-merged `6d02bcea0b335dd8b8ea71a7316d40f922e38fe9`
- Work order: `spec/work-orders/NET-W036.md` — merged and frozen
- Evidence ledger: `docs/net-w036-complete-demand-procurement-benefit-lifecycle.md` — merged and frozen
- Implementation branch: to be created from W035 merge ancestry after the preparation checkpoint; do not reuse the documentation branch.
- Dependencies: NET-W028 + NET-W033 — VERIFIED/MERGED
- Scope: demand aggregation → supplier offers/eligibility/selection → fulfillment/execution → measurement/outcomes → W027 baseline/counterfactual → verified savings/PoV → `/settlement` → W028 benefit funding/allocation.

W036 is a composition/proof milestone. `/demand` remains demand/offer/selection authority; `/workflows` remains lifecycle authority; `/measurement` + `/outcomes` remain measurement boundaries; W027 remains savings/counterfactual semantics; `/evidence` remains PoV/provenance authority; `/settlement` remains sole economic authority; `/benefits` remains pool/allocation authority; `/adapters` remains provider integration. Do not create a second ledger, lifecycle engine, savings authority, benefit authority, or W037 behavior.

Required proof shape:

```text
demand pool
  → privacy-safe qualified demand
  → supplier offers / hard eligibility / deterministic selection
  → fulfillment lifecycle
  → measurement / outcomes
  → supported baseline / counterfactual
  → verified savings / Proof-of-Value
  → settlement
  → benefit funding / deterministic allocation
```

The executable order must be proven with authoritative state/version and durable audit witnesses, not merely an ordered test array or terminal allocation.

## Review lessons that must persist

### Authority drift
Use behavioral authority guards with positive and negative fixtures. Identifier matching alone is insufficient.

### Tenant isolation
Scope must flow service → port → composition root → HTTP where applicable. Cross-tenant identifiers fail closed without existence oracles.

### Sanctioned lifecycle paths
Semantically gated lifecycle edges must use explicit sanctioned transition contracts; do not expose generic workflow resolution as a bypass. E2E proofs must establish executable order.

### Economic atomicity
Coupled economic mutations share one authoritative transaction; use `...WithinTx` and never chain independently committing economic commands.

### Audit ordering
Audit is post-commit; commit failure discards buffered audit. Never fabricate uncommitted business state through audit publication.

### AI boundaries
AI is advisory only and may not authorize eligibility, rights, tenancy, lifecycle, evidence, measurement truth, risk, privacy or economics.

### Secrets/authenticated verification
Production credentials resolve only through `SecretProvider` and fail closed. Authenticated verification and freshness remain mandatory where governing authority depends on them.

### Aggregate disclosure / procurement privacy
All aggregate facts are behind the same applicable disclosure gate. Commitment count and distinct buyer-organization count are separate privacy dimensions and must never be collapsed.

### Supplier selection
Hard eligibility precedes deterministic competitive selection. Supplier competition stays inside `/demand` and never becomes hidden economic authority.

### Savings/counterfactuals
Savings require explicit supported baselines and observed/counterfactual evidence. Preserve uncertainty and fail closed on stale, invalid or insufficient support.

### Benefit pools
Pools fund from references to authoritative value; amounts re-derive inside the authoritative transaction where required. Allocation conserves source value, uses deterministic versioned eligibility, and never creates a second ledger.

### Idempotent replay ordering
Completed same-key replay reaches idempotency storage before mutable reads that may have changed. Fresh keys re-check every current-state guard.

### Mutation quality
Every mutation helper must make a real change and restore source byte-identically. Deterministic proof paths must not depend on fresh wall-clock or random identifiers except explicitly isolated provider-freshness semantics.

### End-to-end traversal
Phase-9 composition proofs pin executable order and use authoritative state/version plus durable audit commit order. A terminal state is not sufficient.

### Composite transaction-failure proof
Atomicity requires failure after material work is staged inside the real composite transaction, proving no economic/bookkeeping/audit/idempotency state survives, followed by a healthy same-key retry that commits exactly once.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Material work also requires configured real PostgreSQL/Redis integration. Architectural work requires `arch:check` and `authority:check`; material trust/integrity work requires targeted mutations and secret scanning. Phase-9 composition milestones additionally require a real end-to-end round-trip over the actual provider-selection path.

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

Never merge merely because CI is green. Never create a second implementation PR for the same work item after CHANGES REQUESTED.

## Current action

W035 is complete and merged. NET-W036 is now the active implementation target. Its work order and evidence ledger are merged on `main` via preparation PR #80 at `6d02bcea0b335dd8b8ea71a7316d40f922e38fe9`. Create the implementation branch from W035 merge SHA `85e5d6d7b8ff1df2fda4740fdd1f541890496610`, then implement exactly one W036 PR under the frozen work order. Do not introduce W037 behavior or alter frozen architecture.
