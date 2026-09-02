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

**NET-W033 — Complete contribution lifecycle**

- GitHub issue: #67 — completed by merged PR #68
- PR: #68 — squash-merged
- Final reviewed head: `476b57971a06a9e74d1545fa30824904cbc2359b`
- Merge SHA: `92482c6ea3b3dc18f8286d37b9c6236f9ef1c001`
- Status: MERGED
- Architectural decision: APPROVED after same-PR remediation.
- Scope: composition/evidence milestone only; no new source implementation, domain, authority, vocabulary, state machine, crypto or economic primitive.
- Canonical executable order proven by the scenario: contribution creation → sanctioned publication through `/workflows` to SUBMITTED → `/workflows` SUBMITTED→MEASURING → `/evidence` PoV/bases → `/outcomes` measurement → PoH evaluation → `/workflows` completion to VERIFIED → reputation → settlement pending/mature → benefits.
- The remediation was required because the first PR implementation created evidence/outcome artifacts before the lifecycle had reached the intended MEASURING point. The same branch reordered the scenario and added deterministic traversal/audit-order witnesses; no owning-boundary gate was bypassed.
- Final verification recorded in the W033 ledger: `bun run verify` 2170 pass / 15 skip / 0 fail; `arch:check` + `authority:check` 322 files / 0 violations; 9/9 targeted behavioral mutations caught and sources restored byte-identically; real PostgreSQL + Redis integration 17/0; real-PG end-to-end round-trip passed; current-head CI green on push and pull_request paths.
- Two unrelated pre-existing wall-clock flakes in legacy W027/W030 suites were transparently recorded and re-run successfully; they were not folded into the W033 composition-only scope.

### Previous completed milestones

NET-W001 through NET-W033 are complete and merged.

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

## Next implementation target

**NET-W034 — Complete advertising lifecycle**

- GitHub issue: #69 — OPEN
- Status: READY_FOR_IMPLEMENTATION
- Branch: `feat/net-w034-complete-advertising-lifecycle`
- Dependencies: NET-W020, NET-W021, NET-W022, NET-W023, NET-W033 — VERIFIED/MERGED
- Requirements/scope: prove advertiser → inventory/creator supply → measurement → Evidence/Proof-of-Value → applicable risk/privacy controls → settlement using only existing authorities.
- Work order: author `spec/work-orders/NET-W034.md` before coding.
- Evidence ledger: author `docs/net-w034-complete-advertising-lifecycle.md` before coding.

W034 is a composition/proof milestone. Do not add a new domain or authority. Campaign policy remains `/campaigns`; inventory/placement/supply semantics remain in the existing frozen boundary; measurement semantics remain `/measurement` + `/outcomes`; evidence/PoV remains `/evidence`; risk remains `/disputes`; economic state remains `/settlement`; provider-specific protocol behavior remains `/adapters`; reputation remains `/reputation` where applicable.

Required proof shape:

```text
advertiser/campaign
  → inventory / creator supply
  → measurement
  → evidence / Proof-of-Value
  → risk/privacy/disclosure gates where applicable
  → /settlement
```

The exact executable order must be established in the W034 work order and then proven by the scenario; terminal end state alone is insufficient for a traversal milestone.

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

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Material work also requires configured real PostgreSQL/Redis integration. Architectural work requires `arch:check` and `authority:check`; material trust/integrity work requires targeted mutation checks and secret scanning. W034 must additionally include a real end-to-end advertising round-trip over the actual provider-selection path.

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

Activate **NET-W034** from issue #69 and `spec/work-orders/NET-W034.md` on `feat/net-w034-complete-advertising-lifecycle`. First author the work order and evidence ledger, re-read the frozen architecture/lock, roadmap, backlog and dependency graph, then inspect the W019–W023 authorities and the W033 traversal-proof precedent. Implement exactly one composition/proof PR. Do not introduce W035/W036 behavior or alter frozen architecture.