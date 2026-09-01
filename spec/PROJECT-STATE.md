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

**NET-W030 — External settlement adapters**

- GitHub issue: #61 — completed
- PR: #62 — squash-merged
- Merge SHA: `1d902e2148920ddd04e2b170509184d7b585cb3e`
- Status: MERGED
- Authority: W030 added a FACT-INGESTION + reconciliation layer INSIDE the existing `/settlement` authority (never a second economic authority): external settlement transactions arrive as AUTHENTICATED, IDEMPOTENT, append-only FACTS (HMAC-SHA256 trust envelope per provider, SecretProvider-only material, fail-closed with no dev fallback, 15-minute freshness window), recorded exactly-once per (organization scope, provider, external id) with composite idempotency + an in-tx identity backstop, and deterministically RECONCILED against the internal ledger lineage (matched/pending/mismatched with machine-readable closed-vocabulary reasons, DERIVED on read, mismatches recorded + audited, never auto-corrected). The neutral `ExternalSettlementProviderAdapter`/`ExternalSettlementAuthenticator` contracts live in the `/settlement` port; the reference adapter implements them STRUCTURALLY under `/adapters` with zero domain imports (the W029 composition-root discipline applied to the adapter tier — the W023 precedent). An external fact can never mint, consume, reverse or mutate internal economic state; `/payments` stays skeletal (architecture-lock §14 invariant 25).
- Verification at reviewed head: `bun run verify` 1916 pass / 15 skip / 0 fail (1931 tests / 247 files); `arch:check` + `authority:check` 309 files / 0 violations; CI green 4/4 on BOTH events (verify + real PostgreSQL/Redis integration); 9/9 targeted mutation checks caught (driver re-executed end-to-end on the final head).
- Review lesson: a fixed-prepend character tamper in tests is a NO-OP on matching first characters — a latent ~1/16 flake (W029 AC-03 turned CI red on W030's first push). The durable rule: every tamper helper must GUARANTEE observable difference (the W023/W030 nibble-flip discipline — `x[0] === "0" ? "1" : "0"`), and a single lucky local green run is NOT gate evidence for randomized-signature surfaces; characterize flake candidates across many runs before claiming robustness.

### Previous completed milestones

NET-W001 through NET-W030 are complete and merged.

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
- NET-W029: cryptographic attestations and commitments (the Phase-8 integrity layer)
- NET-W030: external settlement adapters (the Phase-8 fact-ingestion/reconciliation layer)

## Next implementation target

**NET-W031 — Portable reputation proofs**

- GitHub issue: #63 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Branch: `feat/net-w031-portable-reputation-proofs` — prepare from this checkpoint
- Dependencies: NET-W007, NET-W029 — MERGED/VERIFIED
- Requirements: REP-003..004 (reputation evidence traceability in portable form), PRIV-001..003 (no raw private records on public surfaces; privacy-preserving proofs)
- Work order: `spec/work-orders/NET-W031.md`
- Evidence ledger: `docs/net-w031-portable-reputation-proofs.md`

Definition of done: a participant can present VERIFIABLE reputation claims without transferring raw private records — proofs derive from the authoritative `/reputation` state through the W029 signed-attestation machinery (neutral lookups; the composition root is the only join), verify deterministically and fail closed, and never expose raw personal history, cross-tenant records, or unpurchasable-reputation invariants (REP-002).

## W031 architecture checklist

1. Portable reputation proofs are DERIVED views over the authoritative `/reputation` state (W007 dimensions/inputs/snapshots) — never a second reputation authority, never raw record transfer.
2. Proof issuance composes the W029 signed-attestation machinery (versioned algorithm/key vocabularies, SecretProvider-only keys, deterministic fail-closed verification) — no new crypto, no new signing surface.
3. Proofs disclose AGGREGATE, scoped facts (dimensions, grades, time-decayed scores, evidence-reference counts) under the aggregate disclosure gate — never raw personal activity, payloads, or cross-tenant data (PRIV-001..003).
4. Proof verification is deterministic, server-side or presentation-side, non-mutating, and fail-closed with machine-readable reasons from a closed vocabulary.
5. Proofs are tenant-scoped at issuance and self-contained at presentation (no existence oracles against the issuing authority; verification does not query tenant-scoped state).
6. Reputation remains non-purchasable (REP-002): no proof path accepts spend/wealth as reputation substance; proofs carry only authoritative dimension state.
7. Time decay applies consistently at derivation (REP-003): a proof's disclosed scores are the SAME deterministic decayed values the authority computes, not presentation-side recomputations.
8. Material reputation changes trace to evidence (REP-004): proofs reference the authoritative input/evidence lineage ids (opaque references, never payloads).
9. Issuance follows composite idempotency + one authoritative transaction + transactional audit; presentation/verification mutates and audits nothing.
10. W032+ decentralized validation and W033+ end-to-end flows remain excluded.
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

### Attestation coverage and lifecycle binding
Covered-record commitments bind SUBSTANTIVE content only: mutable lifecycle bookkeeping (state/version/maturedAt/consumedBy/reversal) and per-write lineage stamps are excluded from the canonical facts, so legitimate lifecycle progression never invalidates a sound attestation while invalidation (REVERSED) fails closed through the explicit current-state gate with the precise machine-readable reason.

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

Implement **NET-W031** from its READY_FOR_IMPLEMENTATION issue on `feat/net-w031-portable-reputation-proofs`. Before coding, read `AGENTS.md`, this file, `spec/ROADMAP.md`, `spec/architecture.md`, `spec/architecture-lock.md`, `spec/work-items.md`, and `spec/work-orders/NET-W031.md`. Keep portable reputation proofs as DERIVED, privacy-preserving, verifiable claims: `/reputation` remains the sole reputation authority, proofs compose the W029 signed-attestation machinery (no new crypto), disclosure is aggregate-only under the aggregate disclosure gate, verification is deterministic and fail-closed, and no raw private record ever transfers. Author one-to-one AC evidence, mutation checks, exactly one implementation PR, and do not merge until green verification and architect approval are both present.
