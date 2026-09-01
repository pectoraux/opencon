# NET-W030 — External settlement adapters

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #61  
**Dependencies:** NET-W008, NET-W029 — merged/verified  
**Authority:** `/settlement` remains the SOLE economic authority; `/adapters` owns the provider-specific external integrations (transaction-FACT providers only)

## 1. Objective

Connect verified internal settlement state to external payment/settlement networks through provider-neutral adapter contracts: external settlement transactions arrive as AUTHENTICATED, IDEMPOTENT, append-only FACTS recorded inside the `/settlement` authority, deterministically reconciled against the internal ledger lineage. External adapters never execute internal economic mutations and their state is never internal authority — a transaction fact can inform traceability and reconciliation, never bypass, create, consume or mutate internal economic state (SETTLE-001..003, ADAPTER-008).

## 2. Authority placement

```text
/settlement internal economic authority (W008/W014/W020)
(ledger transactions, value records, credits, cash obligations)
        ↓ neutral references (internal transaction lineage ids)
/adapters provider-specific external settlement integrations
(authenticated + fail-closed; the W023 discipline)
        ↓
external settlement transaction FACTS (append-only, idempotent,
provider-authenticated, tenant-scoped)
        ↓
/settlement records the facts + DERIVES the deterministic reconciliation
(matched / pending / mismatched — never an economic mutation)
        ↓
PostgreSQL remains THE authoritative state
(an external fact can never mint, consume or mutate internal value)
```

`/settlement` consumes ONLY neutral `ExternalSettlementAdapter` contracts declared in its port and wired at the composition root; provider-specific code (network protocols, provider auth, payload schemas) lives exclusively in `/adapters` (the W023 OpenRTB precedent). No 17th domain.

## 3. Required semantics

### 3.1 External transaction facts (first-class /settlement records)

Append-only, immutable-after-recording external transaction records: canonical external id, provider reference (closed, versioned provider vocabulary), the internal settlement transaction lineage they reference, authenticated payload facts (amounts as REPORTED by the provider — never authority), state derived server-side. Recording is idempotent per (organization scope, provider, external id) with composite idempotency keys.

### 3.2 Provider authentication and fail-closed ingestion

Adapter-delivered facts are authenticated (per-provider verification material resolved ONLY through `SecretProvider`; the W023 authenticated + fresh-verification lesson). Unauthenticated, stale, malformed or unverifiable submissions fail closed — never silently recorded.

### 3.3 Deterministic reconciliation

The reconciliation verdict over (internal ledger lineage, recorded facts) is a DERIVED, deterministic, server-side computation: matched / pending / mismatched with machine-readable reasons. A mismatch is recorded + audited, never auto-corrected — reconciliation informs, humans/internal authority act.

### 3.4 No economic bypass

An external fact can NEVER create, consume, reverse or mutate internal value records, credits, cash or reward state. The only economic primitives remain the EXISTING `/settlement` commands; W030 adds facts + derived views + audit only.

### 3.5 Tenancy and authorization

External transaction facts and reconciliation views are tenant-scoped; cross-tenant and unauthorized access fails closed without existence oracles; creation/ingestion surfaces follow the established guard-action pattern.

### 3.6 Atomicity and audit

Recording + reconciliation derivation use composite idempotency, concurrency serialization, one authoritative transaction and transactional audit buffering with post-commit publication (the established pattern).

## 4. Boundary containment

W030 introduces NO second economic authority, NO external execution of internal mutations, NO consensus layer, NO token economics, NO portable reputation proofs (W031), NO decentralized validation participants (W032), NO end-to-end flows (W033+). AI output remains advisory-only. `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.

## 5. Lifecycle

External transaction facts are immutable after recording; correction semantics (if required) are new fact records referencing the corrected one (append-only), never in-place rewrites. Reconciliation states are DERIVED — never stored authoritative lifecycle.

## 6. Acceptance/evidence requirements

One-to-one AC coverage for SETTLE-001..003 + ADAPTER-008 plus architecture/out-of-scope regression coverage. Required evidence: fact recording round-trips over the neutral adapter contract; authentication fail-closed paths (unauthenticated/stale/malformed); deterministic reconciliation (matched/pending/mismatched + machine-readable reasons); no-economic-bypass containment (facts never move value); tenancy/authorization; idempotency/concurrency/atomicity and fault injection; mutation checks; `bun run verify`; architecture/authority checks; secret scan; configured real PostgreSQL/Redis integration.

## 7. Explicit non-goals

No second ledger or economic authority; no external execution of internal economic state; no consensus/decentralized validation; no portable reputation proofs; no token economics; no raw personal data on any public surface; no W031+ or W033+ behavior.

## 8. Decision of record

W030 is a FACT-INGESTION and RECONCILIATION layer over the existing economic authority, not a new authority. It is judged primarily on provider authentication (fail closed), idempotent exactly-once fact recording, deterministic reconciliation, traceability in both directions, and the impossibility of an external fact bypassing internal economic authority. The W008 ledger primitives and the W023 adapter discipline are the foundations; W030 composes them without rewriting either.
