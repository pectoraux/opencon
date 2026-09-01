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

**NET-W029 — Cryptographic attestations and commitments**

- GitHub issue: #58 — completed
- PR: #60 — squash-merged
- Merge SHA: `cf53378e1c432dfd735e1b408010eece55d7612f`
- Status: MERGED
- Authority: W029 EXTENDED the existing frozen `/evidence` boundary (the W005 attestation/commitment foundation — never rewritten) with production-grade signed attestations: real Ed25519 / ECDSA P-256 via `node:crypto` behind the injected versioned signer/verifier interfaces (constructed ONLY in the composition root with construction-time key validation), closed versioned algorithm + key-reference vocabularies with a frozen pairing map, keys resolved exclusively through the SecretProvider (fail-closed selection; default `hmac-sha256` keeps existing deployments booting), coverage over the three authoritative record families (evidence, reputation inputs, settlement value records) through neutral in-tx lookups, the deterministic `attestation/v2` canonical-input discipline rebuilt from STORED salted commitments (no plaintext — PRIV-003), fail-closed verification with a closed machine-readable reason vocabulary (tamper detection + REVERSED-state containment), composite idempotency + one authoritative transaction + transactional audit, and one-way revocation. PostgreSQL remains authoritative; no consensus, no external execution.
- Verification at reviewed head: `bun run verify` 1858 pass / 15 skip / 0 fail (1873 tests / 239 files); `arch:check` + `authority:check` 304 files / 0 violations; CI green 4/4 on BOTH events (verify + real PostgreSQL/Redis integration); 9/9 targeted mutation checks caught (corrected driver — the first run's per-edit backup defect is recorded in the ledger).
- Review lesson: the lifecycle/substantive-content dichotomy for covered records — commitments bind SUBSTANTIVE content while mutable lifecycle bookkeeping (state/version/maturedAt/consumedBy/reversal) and per-write lineage stamps are excluded, so legitimate lifecycle progression never invalidates a sound attestation while invalidation (REVERSED) fails closed with the precise reason. Key material is validated at construction (type + sign/verify probe), never at first use. Two independent signing surfaces (v1 W005 / v2 W029) preserve existing deployment boot contracts.

### Previous completed milestones

NET-W001 through NET-W029 are complete and merged.

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

## Next implementation target

**NET-W030 — External settlement adapters**

- GitHub issue: #61 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Branch: `feat/net-w030-external-settlement-adapters` — prepare from this checkpoint
- Dependencies: NET-W008, NET-W029 — MERGED/VERIFIED
- Requirements: SETTLE-001..003, ADAPTER-008
- Work order: `spec/work-orders/NET-W030.md`
- Evidence ledger: `docs/net-w030-external-settlement-adapters.md`

Definition of done: external settlement transactions arrive as authenticated, idempotent, append-only FACTS inside `/settlement`, deterministically reconciled against the internal ledger lineage with machine-readable reasons — traceable in both directions, and structurally unable to bypass, create, consume or mutate internal economic authority (the adapters provide transaction facts; `/settlement` retains semantic authority — architecture-lock §14 invariant 25).

## W030 architecture checklist

1. External transaction facts are first-class, append-only, immutable-after-recording `/settlement` records referenced by canonical id; they never mint, consume or mutate internal economic state.
2. `/settlement` remains the SOLE economic authority: adapters provide transaction FACTS (architecture-lock §14 invariant 25); no external execution of internal mutations.
3. `/adapters` owns ALL provider-specific code; `/settlement` consumes ONLY the neutral `ExternalSettlementAdapter` contract wired at the composition root (the W023 discipline).
4. Adapter-delivered facts are AUTHENTICATED with SecretProvider-resolved material; unauthenticated, stale or malformed submissions fail closed (the W023 authenticated + fresh-verification lesson).
5. Fact recording is idempotent per (organization scope, provider, external id); replays are exactly-once.
6. Reconciliation (matched/pending/mismatched) is DERIVED, deterministic and server-side with machine-readable reasons; mismatches are recorded + audited, never auto-corrected.
7. Tenant and authorization failures remain fail-closed without existence oracles.
8. Existing composite idempotency, one-authoritative-transaction and transactional-audit patterns apply to fact recording.
9. AI/model outputs remain advisory-only and cannot authorize ingestion or reconciliation outcomes.
10. W031+ portable reputation proofs, W032+ decentralized validation and W033+ end-to-end flows remain excluded.
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

Implement **NET-W030** from its READY_FOR_IMPLEMENTATION issue on `feat/net-w030-external-settlement-adapters`. Before coding, read `AGENTS.md`, this file, `spec/ROADMAP.md`, `spec/architecture.md`, `spec/architecture-lock.md`, `spec/work-items.md`, and `spec/work-orders/NET-W030.md`. Keep external settlement adapters as FACT providers (the W023 adapter discipline): `/settlement` retains the sole economic authority, provider-specific code stays in `/adapters`, ingestion is authenticated and fail-closed, recording is idempotent, reconciliation is derived and deterministic — an external fact can never bypass, create, consume or mutate internal economic state. Author one-to-one AC evidence, mutation checks, real-provider integration, exactly one implementation PR, and do not merge until green verification and architect approval are both present.
