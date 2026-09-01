# NET-W031 — Portable reputation proofs

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #63  
**Dependencies:** NET-W007, NET-W029 — merged/verified  
**Authority:** `/reputation` remains the SOLE reputation authority; proofs COMPOSE the W029 signed-attestation machinery (no new crypto, no new signing surface)

## 1. Objective

Make reputation evidence portable without exposing raw private history: a participant can present VERIFIABLE reputation claims — derived, aggregate, signed — that verify deterministically and fail closed, while the authoritative reputation state remains in PostgreSQL and no raw private record ever transfers (REP-003..004, PRIV-001..003; work-items NET-W031).

## 2. Authority placement

```text
/reputation internal reputation authority (W007 — UNCHANGED)
(dimension state, authoritative inputs, snapshots, time decay)
        ↓ neutral lookups (aggregate, opaque-reference facts only)
/evidence W029 signed-attestation machinery (COMPOSED — no new crypto)
(versioned algorithm/key vocabularies, SecretProvider-only keys,
 deterministic fail-closed verification)
        ↓
portable reputation PROOFS (derived, tenant-scoped at issuance,
 self-contained at presentation, aggregate disclosure only)
        ↓
verification: deterministic + fail-closed (machine-readable reasons)
no raw private record, no cross-tenant data, no reputation transfer
```

`/reputation` remains the SOLE reputation authority; W031 adds proof DERIVATION, presentation and verification only. Proofs compose the existing W029 machinery through neutral contracts (the composition root is the only join — the W029/W030 discipline). No 18th domain; no new key-material class.

## 3. Required semantics

### 3.1 Proof records (derived, portable)

A proof is a derived, self-contained artifact: subject reference (participant), organization scope of issuance, the aggregate disclosed facts (dimension scores/grades as the authority's own time-decayed values, evidence-reference counts as opaque lineage references — REP-004), issuance metadata, and the W029 signed-attestation envelope over the canonical proof facts. Proofs are immutable after issuance; re-issuance produces a NEW proof.

### 3.2 Aggregate disclosure only (PRIV-001..003)

Disclosed facts are aggregate and scoped. A proof NEVER contains raw personal activity, evidence payloads, input sources' raw content, or cross-tenant data. Disclosure follows the aggregate disclosure gate (the established lesson: every aggregate fact, including counts, is disclosed only under the same gate).

### 3.3 Deterministic fail-closed verification

Verification re-derives the verdict from the presented proof WITHOUT querying tenant-scoped state: signature checks (the W029 closed reason vocabulary), proof-shape validation, staleness/freshness window, revocation state, and the closed subject/dimension vocabularies. Machine-readable reasons; no silent acceptance; no exceptions leaking payload material.

### 3.4 Non-purchasability containment (REP-002)

No proof path accepts advertising spend or wealth as reputation substance. Proofs carry ONLY authoritative dimension state derived from the W007 inputs; the proof surface adds no score-altering input.

### 3.5 Time-decay consistency (REP-003)

Disclosed scores are the SAME deterministic decayed values the authority computes at issuance time. Presentation-side recomputation is forbidden (no drift between the authority and the portable claim).

### 3.6 Tenancy, idempotency, atomicity

Proof issuance is tenant-scoped with guard-action authorization, composite idempotency, ONE authoritative transaction and transactional audit. Presentation and verification are read-only: they mutate and audit nothing.

## 4. Boundary containment

W031 introduces NO second reputation authority, NO raw record transfer, NO new cryptographic primitives, NO decentralized validation participants (W032), NO end-to-end flows (W033+), NO token economics. AI output remains advisory-only. `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.

## 5. Lifecycle

Proofs are immutable after issuance; revocation is a one-way field mutation (the W029 discipline). Staleness is a verification-time derivation over the issuance timestamp — never a stored lifecycle state. No in-place rewrites.

## 6. Acceptance/evidence requirements

One-to-one AC coverage for REP-003..004 + PRIV-001..003 plus architecture/out-of-scope regression coverage. Required evidence: proof issuance round-trips composing the W029 machinery; aggregate-disclosure containment (no raw records, no cross-tenant leakage); deterministic verification with fail-closed paths (tamper/stale/revoked/malformed); non-purchasability containment; time-decay consistency; tenancy/authorization; idempotency/concurrency/atomicity and fault injection; mutation checks; `bun run verify`; architecture/authority checks; secret scan; configured real PostgreSQL/Redis integration.

## 7. Explicit non-goals

No second reputation authority; no raw private records on any surface; no new crypto or signing surface; no consensus/decentralized validation (W032); no end-to-end flows (W033+); no zero-knowledge-proof infrastructure beyond what the frozen architecture specifies (aggregate salted commitments over authoritative facts are the sanctioned mechanism); no token economics.

## 8. Decision of record

W031 is a DERIVATION and PRESENTATION layer over the existing reputation authority composed with the existing attestation machinery, not a new authority. It is judged primarily on privacy containment (no raw records transfer, aggregate disclosure only), verification soundness (deterministic, fail-closed, machine-readable reasons), non-purchasability, decay consistency, and tenancy. The W007 reputation model and the W029 attestation machinery are the foundations; W031 composes them without rewriting either.
