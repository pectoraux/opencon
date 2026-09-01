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

**NET-W028 — Benefit Pools**

- GitHub issue: #56 — completed
- PR: #57 — squash-merged
- Merge SHA: `6e309e2af05a962e3417999ad8079da16d9ebc37`
- Status: MERGED
- Authority: W028 activates the existing frozen `/benefits` boundary (the sixteenth and LAST skeletal v1.0 domain — every frozen domain is now implemented) with Benefit Pools: funding references resolve server-side to authoritative upstream value only (MATURE unconsumed `/settlement` value records + W027 verified savings consumed as re-derived facts), versioned immutable allocation policies under the organization-independent lineage mutex, deterministic scaled-integer conservation-preserving allocation, privacy-preserving member views, and the economic mutation routed exclusively through the existing `/settlement` reward-allocation draw `WithinTx` primitive on ONE authoritative transaction. `/settlement` remains the sole economic authority.
- Verification at reviewed head: `bun run verify` 1783 pass / 15 skip / 0 fail (1798 tests / 231 files); `arch:check` + `authority:check` 301 files / 0 violations; CI green 4/4 on BOTH events (verify + real PostgreSQL/Redis integration); 9/9 targeted mutation checks caught.
- Review lesson: benefit pools are allocation ORCHESTRATORS over already-authoritative value, never a second ledger: funding is references-only (amounts re-derived in-tx at every anchor), the drawable/entitlement dichotomy keeps every posting inside `/settlement` (verified savings post nothing), and the settlement reward policy must mirror the member declarations exactly so the locked accounts are always the posted accounts.

### Previous completed milestones

NET-W001 through NET-W028 are complete and merged.

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

## Next implementation target

**NET-W029 — Cryptographic attestations and commitments**

- GitHub issue: #58 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Branch: `feat/net-w029-cryptographic-attestations` — prepare from this checkpoint
- Dependencies: NET-W005, NET-W007, NET-W008 — MERGED/VERIFIED
- Requirements: EVID-006, PRIV-003
- Work order: `spec/work-orders/NET-W029.md`
- Evidence ledger: `docs/net-w029-cryptographic-attestations.md`

Definition of done: signed attestations and commitments can prove integrity of evidence/reputation/settlement references without changing centralized semantic authority — PostgreSQL remains authoritative, verification is deterministic and reproducible, and no decentralized consensus or external payment execution is introduced.

## W029 architecture checklist

1. Attestations/commitments attach to existing authoritative records (evidence/reputation/settlement); they never mint new semantic authority or mutate authoritative state.
2. Cryptography is a provenance/integrity layer, not a consensus layer: no blockchain, no network validation, no token economics (W032/W030 remain out of scope).
3. `/evidence` remains the provenance/truth authority; `/reputation` the reputation authority; `/settlement` the sole economic authority. Attestations reference records by canonical id through neutral read paths.
4. Signature verification is deterministic and server-side; verification failures fail closed; algorithms/key references are versioned and pinned.
5. Commitments (hash commitments) hide sensitive payloads while binding to them; disclosure/verification reveals only what the frozen privacy rules permit (PRIV-003).
6. Keys resolve only through `SecretProvider` (never committed); secret scan stays clean.
7. PostgreSQL remains authoritative for every record; an attestation can never resurrect revoked/invalidated authoritative state.
8. Existing composite idempotency, concurrency, one-authoritative-transaction and transactional-audit patterns apply to material attestation mutations.
9. AI/model outputs remain advisory-only and cannot authorize attestations, commitments or their verification.
10. W030+ external settlement adapters, W031+ portable reputation proofs, W032+ decentralized validation and W033+ end-to-end flows remain excluded.
11. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.

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

### Benefit pools / economic orchestration
Pools fund from references only; amounts re-derive in-tx. Drawable value posts exclusively through `/settlement` WithinTx primitives with a mirroring reward policy; verified savings fund entitlement-only allocations that post nothing. Conservation arithmetic uses scaled integers with explicit remainders. Stale snapshots never authorize economic effects.

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

Implement **NET-W029** from its READY_FOR_IMPLEMENTATION issue on `feat/net-w029-cryptographic-attestations`. Before coding, read `AGENTS.md`, this file, `spec/ROADMAP.md`, `spec/architecture.md`, `spec/architecture-lock.md`, `spec/work-items.md`, and `spec/work-orders/NET-W029.md`. Keep attestation/commitment semantics as an integrity layer over existing authoritative records — never new semantic authority, never consensus, never external execution. PostgreSQL stays authoritative; keys resolve through `SecretProvider`; verification is deterministic and fails closed. Author one-to-one AC evidence, mutation checks, real-provider integration, exactly one implementation PR, and do not merge until green verification and architect approval are both present.
