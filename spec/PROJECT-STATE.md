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

**NET-W032 — Decentralized validation/dispute layer**

- GitHub issue: #65 — completed
- PR: #66 — merged
- Implementation branch: `feat/net-w032-decentralized-validation-dispute`
- Final remediation head: `fe2c9001753a3bacac553fed953103005e1e4b59`
- Merge SHA: `a65bfdbd967ab6a606757a49538aa184f6838480`
- Status: MERGED
- Authority: W032 extends the existing `/disputes` authority with independent validator participants, deterministic assignment and conflict exclusion, bounded immutable challenge rounds, actor/assignment-bound observations, deterministic count-based quorum/outcome derivation, and explicit application records. Validators cannot directly mutate lifecycle, reputation, evidence, or economic authority. Accepted outcomes cross the owning authority's sanctioned mutation boundary; `/settlement` remains the sole economic authority and `/workflows` remains the sole lifecycle authority.
- Integrity/privacy: W029 attestations and W031 reputation proofs are referenced opaquely; revoked evidence fails closed for fresh submissions. No new cryptographic primitive or key-material class was introduced.
- Economics: validator stakes use the existing settlement authority only, with `validation_assignment` purpose lineage. Submitted assignments release; bonded-but-silent assignments forfeit. No second balance/reserve ledger exists.
- Replay-ordering remediation: an architect review found that mutable checks before `applyIdempotent` could break completed same-key replays. The same PR moved state-dependent acceptance checks into the idempotent callbacks across all audited W032 material mutations and added temporal replay regressions. The repository contract is now: completed same-key replay returns the cached result before mutable authority state is re-read; a fresh key still executes all current-state gates and fails closed.
- Verification: remediation head passed `bun run verify` 2103 pass / 15 skip / 0 fail (2118 tests); `arch:check` + `authority:check` 322 files / 0 violations; targeted mutation driver 29/29 behavioral mutations caught plus structural pins; secret scan clean; real PostgreSQL 17.11 + Redis 8.0 integration 17/17; dedicated real-PG W032 round-trip including revoked-evidence replay ordering passed; PR `pull_request` CI run `33593084872` had both verify and integration jobs successful.
- Architect decision: APPROVED after remediation; merge completed under the canonical protocol.

### Previous completed milestones

NET-W001 through NET-W032 are complete and merged.

Important lineage checkpoints:
- NET-W004: `/workflows` lifecycle authority
- NET-W005: `/evidence` provenance/truth authority
- NET-W006: `/outcomes` normalized measurement authority
- NET-W007: deterministic multidimensional reputation
- NET-W008: `/settlement` economic ledger / credits / cash / settlement primitives
- NET-W009/010: `/disputes` risk and dispute authority
- NET-W011: `/campaigns` policy authority
- NET-W012/013: contribution helpfulness, quality, moderation
- NET-W014: settlement/reward integration
- NET-W015/016: creator identity, preferences and matching
- NET-W017: UGC workflow/rights and atomic composites
- NET-W018: sanctioned publication verification / disclosure gate
- NET-W019: inventory/placements and derived settlement-readiness
- NET-W020: cross-promotion clearing with one authoritative economic transaction
- NET-W021: campaign matching/optimization; selection-only, bounded AI advisory
- NET-W022: attribution/privacy adapter boundary
- NET-W023: OpenRTB/supply-chain adapters with authenticated + fresh verification
- NET-W024: privacy-preserving consumer demand pools
- NET-W025: competition-preserving business procurement pools
- NET-W026: supplier offers and deterministic competitive selection
- NET-W027: verified savings and counterfactuals
- NET-W028: benefit pools (the last frozen v1.0 domain activated)
- NET-W029: cryptographic attestations and commitments (Phase-8 integrity layer)
- NET-W030: external settlement adapters (Phase-8 fact-ingestion/reconciliation layer)
- NET-W031: portable reputation proofs (derived privacy-preserving reputation claims)
- NET-W032: decentralized validation/dispute coordination inside `/disputes`

## Next implementation target

**NET-W033 — Complete contribution lifecycle**

- Status: CURRENT IMPLEMENTATION TARGET
- Dependencies: NET-W014, NET-W018, NET-W023, NET-W028 — MERGED/VERIFIED
- Requirements/scope: prove contribution → evidence → outcome → reputation → settlement → benefit through the canonical authorities; this is a composition/proof work item, not a new domain or authority.
- Work order: author `spec/work-orders/NET-W033.md` before coding.
- Evidence ledger: author the corresponding `docs/net-w033-*.md` ledger before coding.
- Constraints: no new domain, no second authority, no W034+ implementation leakage, no new crypto, preserve `/workflows` lifecycle authority, `/evidence` provenance authority, `/outcomes` measurement authority, `/reputation` reputation authority, `/settlement` economic authority, and `/disputes` risk/dispute authority.

## Review lessons that must persist

### Authority drift
Use behavioral authority guards with positive and negative fixtures. Generic identifier matching alone is insufficient and creates false positives.

### Tenant isolation
Tenant scope must flow through service → port → composition root → HTTP where applicable. Cross-tenant identifiers normally resolve as not-found.

### Policy lineage
When policy identity can exist across organizations, serialize the lineage with an organization-independent mutex and re-check scope/version inside the authoritative transaction.

### Sanctioned lifecycle paths
Semantically gated lifecycle edges must not be exposed through generic workflow resolution. Use explicit sanctioned transition contracts.

### Economic atomicity
Coupled economic mutations must share one authoritative transaction. Use `...WithinTx`; never chain independently committing economic commands.

### Audit ordering
Audit publication is post-commit. A durable commit failure must discard the audit buffer; an audit publication failure must never fabricate an uncommitted business mutation.

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
Savings require explicit supported baselines and observed/counterfactual evidence. Preserve uncertainty and fail closed on invalid, stale or insufficient support. W028 must consume verified/authoritative value rather than recreate savings semantics.

### Benefit pools / economic orchestration
Pools fund from references only; amounts re-derive in-tx. Drawable value posts exclusively through `/settlement` `WithinTx` primitives with a mirroring reward policy; verified savings fund entitlement-only allocations that post nothing. Conservation arithmetic uses scaled integers with explicit remainders. Stale snapshots never authorize economic effects.

### Idempotent replay ordering
For every material mutation, distinguish pure request-shape validation from mutable acceptance checks. Completed same-key replay must reach the idempotency store before mutable state reads that could have changed after the original commit. Fresh-key attempts must still enforce every current-state guard.

### Test mutation quality
Every tamper helper must guarantee a real difference; fixed-prepend character tampering can be a no-op and create latent probabilistic false greens. Targeted mutation checks must mutate each material guard and restore the source byte-identically.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Material work also requires configured real PostgreSQL/Redis integration. Architectural work requires `arch:check` and `authority:check`; material trust/integrity work requires targeted mutation checks and secret scanning.

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

Implement **NET-W033** only after its work order and evidence ledger are authored and the frozen architecture/lock, roadmap, canonical backlog, and dependency graph have been re-read. W033 is the first end-to-end proof slice: compose already-authoritative contribution, evidence, outcome, reputation, settlement, and benefit semantics without creating any new authority or bypassing existing controls.
