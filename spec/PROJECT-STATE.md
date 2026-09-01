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

**NET-W027 — Verified savings and counterfactuals**

- GitHub issue: #54 — completed
- PR: #55 — squash-merged
- Merge SHA: `d78a9b8bbb8e4319e73e75e1ca4bc8229b2ed300`
- Status: MERGED
- Authority: W027 extends the existing `/demand` procurement authority with evidence-backed baselines, counterfactuals and realized-savings derivation. `/outcomes` remains the normalized measurement authority, `/evidence` remains the provenance/truth authority, and `/settlement` remains the sole economic authority.
- Verification at reviewed head: `bun run verify` 1727 pass / 15 skip / 0 fail; `arch:check` + `authority:check` 298 files / 0 violations; CI green for verify + real PostgreSQL/Redis integration; 7/7 targeted mutation checks caught.
- Review lesson: savings are claims about realized outcomes, never offer price or caller arithmetic alone; uncertainty, evidence sufficiency, provenance, freshness and counterfactual method/version are authoritative inputs and must fail closed when unsupported.

### Previous completed milestones

NET-W001 through NET-W027 are complete and merged.

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

## Next implementation target

**NET-W028 — Benefit Pools**

- GitHub issue: #56 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Branch: `feat/net-w028-benefit-pools` — prepare from this checkpoint
- Dependencies: NET-W027 and NET-W008 — MERGED/VERIFIED
- Requirements: BEN-001..004
- Work order: `spec/work-orders/NET-W028.md`
- Evidence ledger: `docs/net-w028-benefit-pools.md`

Definition of done: Benefit Pools are tenant-scoped, privacy-preserving, funded only from already-authoritative value, use explicit immutable/versioned allocation policy, preserve conservation and deterministic remainder handling, and route every economic mutation through `/settlement` without creating a parallel economic authority.

## W028 architecture checklist

1. `/benefits` is the existing frozen domain boundary; no new 17th domain may be created.
2. `/settlement` is the sole economic authority. Benefit Pool code must not create a ledger, balance, credits, cash, reward or payment authority.
3. Funding must resolve server-side to authoritative W027/W014-compatible value/results. Caller-supplied funded amounts are never authoritative.
4. Pool allocation must conserve funded value; no over-allocation is possible. Rounding/remainders must be deterministic and explicitly accounted for.
5. Member eligibility and weights are derived from explicit versioned policy and authoritative inputs; policy lineage cannot fork across tenant scope.
6. Current funding availability, eligibility and allocation capacity must be re-derived when authorizing material economic effects; stale snapshots cannot authorize new value movement.
7. Pool/member views must preserve privacy and must not expose protected demand/procurement commitments or unnecessary participant identity.
8. Cross-tenant and unauthorized access fails closed without existence oracles.
9. Material mutations use the established composite idempotency, concurrency serialization, one-authoritative-transaction and transactional-audit pattern; coupled settlement mutations must use `...WithinTx` primitives.
10. AI/model outputs, if used, are advisory-only and cannot authorize funding, eligibility, privacy release, allocation or economics.
11. `/workflows` remains lifecycle authority; do not create local workflow machinery unless explicitly authorized by the frozen architecture.
12. W029+ decentralization and W033+ end-to-end flows remain excluded.
13. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.

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

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include TypeScript typecheck, `arch:check`, `authority:check`, and the full test suite. Material work also requires configured real PostgreSQL/Redis integration.

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

Implement **NET-W028** from Issue #56 on `feat/net-w028-benefit-pools`. Before coding, read `AGENTS.md`, this file, `spec/ROADMAP.md`, `spec/architecture.md`, `spec/architecture-lock.md`, `spec/work-items.md`, and `spec/work-orders/NET-W028.md`. Keep Benefit Pool semantics inside the existing `/benefits` boundary, consume authoritative upstream value through neutral references, and route economic mutations exclusively through `/settlement`. Author one-to-one AC evidence, mutation checks, real-provider integration, exactly one implementation PR, and do not merge until green verification and architect approval are both present.
