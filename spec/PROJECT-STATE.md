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

**NET-W034 — Complete advertising lifecycle**

- GitHub issue: #69 — completed by merged PR #70
- PR: #70 — squash-merged
- Final reviewed head: `f66cb4f380afde56ed23716453a297d0280b2411`
- Merge SHA: `7c19a19addd44a07965fa25ee7cab021bab2016a`
- Status: MERGED
- Architectural decision: APPROVED after same-PR remediation.
- Scope: Phase-9 advertising composition/evidence milestone; no new production domain, authority, ledger, workflow engine, cryptographic primitive, AI authority or frozen-architecture amendment.
- Canonical executable order proven: campaign/policy → supply/provenance → W021 selection → placement → campaign opportunity → contribution entry/publication → `/workflows` MEASURING → W022 measurement → `/outcomes` → `/evidence` Proof-of-Value → PoH evaluation → `/workflows` completion to VERIFIED → risk/dispute gates → `/settlement` pending/mature → declared campaign clearing.
- The architect initially requested changes because the first AC-09 fault fixture pre-consumed the value out-of-band and therefore proved only stale-state fail-closed behavior, not rollback of a partially staged clearing transaction. The same PR remediated this with a genuine composite-level commit-failure proof over the actual W020 clearing composite, and replaced the dispute fixture's `Date.now()` anchor with the authoritative subject timestamp.
- Final W034 verification recorded in the ledger: `bun run verify` 2258 pass / 15 skip / 0 fail; `arch:check` + `authority:check` 322 files / 0 violations; 12/12 targeted behavioral mutations caught with byte-identical source restoration; real PostgreSQL + Redis integration 17/0; real-provider advertising round-trip 11/11 on a freshly recreated dedicated database; exact-head CI green on push and pull_request; no production `src/` changes.
- The clean dedicated round-trip reported 26 real ledger entries rather than an earlier 46-entry run because the earlier database contained 20 residual entries from a prior development iteration; conservation held in the clean run and the discrepancy was explicitly documented rather than hidden.

### Previous completed milestones

NET-W001 through NET-W034 are complete and merged.

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

## Next implementation target

**NET-W035 — Complete creator lifecycle**

- GitHub issue: #70-equivalent backlog target (create/confirm canonical issue before activation)
- Status: NEXT / DEPENDENCY-READY after W034 merge
- Branch: to be created from W034 merge SHA `7c19a19addd44a07965fa25ee7cab021bab2016a`
- Dependencies: NET-W018 + NET-W034 — VERIFIED/MERGED
- Requirements/scope: prove creator discovery → contract → UGC → disclosure → measurement → payment using existing frozen authorities.
- Work order: author `spec/work-orders/NET-W035.md` before coding.
- Evidence ledger: author `docs/net-w035-complete-creator-lifecycle.md` before coding.

W035 is a composition/proof milestone. Do not add a new domain or authority. `/creators` remains creator identity/matching/creator-record authority; `/campaigns` remains campaign policy; `/inventory` remains supply/placement; `/workflows` remains lifecycle; `/evidence` remains provenance/PoV; `/outcomes` and `/measurement` remain measurement authority/integration; `/disputes` remains risk/control; `/settlement` remains payment/economic authority; `/adapters` remains provider-specific integration.

Required proof shape:

```text
creator discovery
  → contract / campaign terms
  → UGC production / rights
  → disclosure / compliance
  → measurement
  → evidence / Proof-of-Value
  → settlement / payment
```

The exact executable order must be established in the W035 work order and proven with authoritative state/version and durable audit witnesses; terminal payment alone is insufficient.

## Review lessons that must persist

### Authority drift
Use behavioral authority guards with positive and negative fixtures. Generic identifier matching alone is insufficient.

### Tenant isolation
Tenant scope must flow service → port → composition root → HTTP where applicable. Cross-tenant identifiers normally resolve as not-found.

### Policy lineage
When policy identity can exist across organizations, serialize lineage with an organization-independent mutex and re-check scope/version inside the authoritative transaction.

### Sanctioned lifecycle paths
Semantically gated lifecycle edges must not be exposed through generic workflow resolution. Use explicit sanctioned transition contracts. For traversal/composition proofs, prove executable ordering, not merely the terminal state.

### Economic atomicity
Coupled economic mutations must share one authoritative transaction. Use `...WithinTx`; never chain independently committing economic commands.

### Audit ordering
Audit publication is post-commit. Durable commit failure discards the audit buffer; audit publication failure must never fabricate an uncommitted business mutation.

### AI boundaries
AI is advisory only and may not authorize eligibility, rights, tenancy, risk, settlement-readiness, lifecycle, privacy or economics.

### Attestation coverage and lifecycle binding
Covered-record commitments bind substantive content only where intended; mutable lifecycle invalidation must fail closed through explicit current-state checks. Portable verification must not invent a second authority.

### Secrets and authenticated verification
Production secrets resolve only through `SecretProvider` and fail closed. Caller-supplied consistency is not authenticated truth; trusted verification requires an authenticated channel and mandatory freshness when freshness governs authority.

### Aggregate disclosure
Every aggregate fact, including counts in machine-readable details, is disclosed only under the same aggregate disclosure gate.

### Procurement privacy
Commitment count and distinct buyer-organization count are separate privacy dimensions. Never collapse one into the other.

### Supplier selection
Supplier competition remains a procurement decision inside `/demand`, never hidden economic authority. Hard eligibility precedes deterministic selection.

### Savings/counterfactuals
Savings require explicit supported baselines and observed/counterfactual evidence. Preserve uncertainty and fail closed on invalid, stale or insufficient support. W028 consumes verified/authoritative value rather than recreating savings semantics.

### Benefit pools / economic orchestration
Pools fund from references only; amounts re-derive in-tx. Drawable value posts exclusively through `/settlement` `WithinTx` primitives with a mirroring reward policy; verified savings fund entitlement-only allocations that post nothing. Conservation arithmetic uses scaled integers with explicit remainders. Stale snapshots never authorize economic effects.

### Idempotent replay ordering
For every material mutation, separate pure request-shape validation from mutable acceptance checks. Completed same-key replay must reach the idempotency store before mutable state reads that could have changed after the original commit. Fresh-key attempts must still enforce every current-state guard.

### Test mutation quality
Every tamper helper must guarantee a real difference; fixed-prepend character tampering can be a no-op. Targeted mutation checks must mutate each material guard and restore source byte-identically.

### End-to-end traversal proof
A Phase-9 composition milestone must pin the declared executable order explicitly. Use authoritative state/version witnesses and, where ordering depends on committed mutations, durable audit insertion/commit order. Reorder a scenario on the same PR when the architect identifies sequencing drift; do not weaken the owning-domain gates merely to make the fixture executable.

### Composite transaction-failure proof
When a work item claims atomicity for a coupled composite, a stale-state rejection is not a rollback proof. The evidence must force failure after material work is staged inside the composite transaction and prove that no economic, bookkeeping, audit or idempotency state survives; then prove a healthy same-key retry commits exactly once.

### Deterministic fixtures
Canonical end-to-end fixtures must derive policy/window timestamps from fixed anchors or authoritative subject timestamps. Do not introduce fresh `Date.now()` dependencies into proof paths whose semantics are expected to be reproducible.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Material work also requires configured real PostgreSQL/Redis integration. Architectural work requires `arch:check` and `authority:check`; material trust/integrity work requires targeted mutation checks and secret scanning. Phase-9 composition milestones additionally require a real end-to-end round-trip over the actual provider-selection path.

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

W034 is merged and architect-approved. Confirm/create the canonical NET-W035 issue from `spec/work-items.md`, then author `spec/work-orders/NET-W035.md` and `docs/net-w035-complete-creator-lifecycle.md` on a branch created from merge SHA `7c19a19addd44a07965fa25ee7cab021bab2016a`. Read the frozen architecture/lock, dependency graph, W018, W033 and W034 evidence/work orders before implementation. Do not introduce W036 behavior or alter frozen architecture.