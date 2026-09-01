# NET-W029 — Cryptographic attestations and commitments

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #58  
**Dependencies:** NET-W005, NET-W007, NET-W008 — merged/verified  
**Authority:** existing `/evidence` boundary owns attestation/commitment semantics; PostgreSQL remains authoritative for every record

## 1. Objective

Extend the existing W005 verifier-neutral attestation and commitment machinery into the Phase-8 integrity layer: production-grade signed attestations with versioned algorithms and key references resolved through `SecretProvider`, and commitment coverage extended beyond evidence records to the authoritative record families the frozen architecture already owns (reputation inputs, settlement value records). W029 must not change centralized semantic authority: PostgreSQL stays authoritative, and no consensus, network validation, token economics or external execution is introduced.

## 2. Authority placement

```text
existing authoritative records
(/evidence evidence records; /reputation inputs; /settlement value records)
        ↓ neutral reference (canonical record ids, committed digests)
/evidence attestation + commitment semantics (the SAME frozen boundary W005 created)
        ↓
signed attestations (versioned algorithm + key reference; signer/verifier interfaces)
+ hash commitments (payload-hiding, binding — the W005 discipline)
        ↓
deterministic server-side verification (rebuild the canonical input; fail closed)
        ↓
PostgreSQL remains THE authoritative state
(an attestation never mints, mutates or resurrects authority)
```

`/reputation` and `/settlement` keep their authorities untouched; their records are referenced read-only through neutral lookups wired at the composition root (the W021/W027/W028 precedent). `/workflows` stays the lifecycle authority. No 17th domain.

## 3. Required semantics

### 3.1 Existing foundation (reuse, never rewrite)

The W005 machinery is the foundation and must NOT be re-implemented: `src/evidence/commitments.ts` (sha256/sha512 salted commitments, constant-time comparison), the `Attestation`/`AttestationSigner`/`AttestationVerifier` contracts in `src/evidence/port.ts`, and the canonical digest-input discipline (attestation/v1; statement + verifier + evidence digests). W029 extends coverage and production-hardens the signer/verifier layer.

### 3.2 Signed attestations

Production signature algorithms (real asymmetric cryptography — e.g. Ed25519/ECDSA via `node:crypto`, still behind the injected signer/verifier interfaces, never provider-specific code in the domain). Algorithm identifiers and key references form closed, versioned vocabularies. Private keys resolve only through `SecretProvider`; key material is never committed, logged or persisted. The dev-only HMAC default remains clearly-marked for development/test.

### 3.3 Coverage extension

Attestations/commitments can cover the authoritative record families beyond evidence: reputation inputs (W007) and settlement value records (W008), referenced by canonical id through neutral read paths. Verification rebuilds the canonical input from STORED committed digests — no plaintext disclosure, no cross-authority mutation.

### 3.4 Deterministic verification

Verification is server-side, deterministic and reproducible: identical (canonical input, signature, algorithm, key reference) ⇒ identical verdict. Tampering with the statement, the covered set, the underlying commitments, the signature, the algorithm or the key reference fails closed with a machine-readable reason. An attestation can never make revoked, invalidated or superseded authoritative state verify as current.

### 3.5 Privacy

Commitments hide sensitive payloads while binding to them (the W005 discipline). Verification never requires plaintext on the record. Disclosure reveals only what the frozen privacy rules permit (PRIV-003; the aggregate-disclosure lesson applies to any counts in machine-readable detail).

### 3.6 Tenancy and authorization

Attestations are tenant-scoped; cross-tenant and unauthorized access fails closed without existence oracles. Creation/verification surfaces follow the established guard-action pattern.

### 3.7 Atomicity and audit

Material attestation mutations use composite idempotency, concurrency serialization, one authoritative transaction and transactional audit buffering with post-commit publication (the established pattern). Attestation creation that covers authoritative records re-derives the covered digests inside the authoritative transaction.

## 4. Boundary containment

W029 introduces NO consensus layer, NO blockchain/network validation, NO token economics, NO external payment execution, NO portable-proof presentation surface (W031), NO external settlement adapters (W030), NO decentralized dispute/validation participants (W032). AI output remains advisory-only. `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.

## 5. Lifecycle

Attestations and commitments are immutable records; revocation/invalidation semantics, if required, are one-way field mutations (the W028 closure precedent) — `/workflows` is not extended.

## 6. Acceptance/evidence requirements

One-to-one AC coverage for EVID-006 + PRIV-003 plus architecture/out-of-scope regression coverage. Required evidence: signing/verification round-trips over all three record families; tamper detection (mutated payload/statement/covered-set/signature/algorithm/key fails closed); commitment binding + privacy preservation; tenancy/authorization; idempotency/concurrency/atomicity and fault injection; PostgreSQL-authority containment (an attestation never resurrects invalidated state); mutation tests; `bun run verify`; architecture/authority checks; secret scan; configured real PostgreSQL/Redis integration.

## 7. Explicit non-goals

No new semantic authority; no 17th domain; no consensus/decentralized validation; no external adapters; no portable reputation proofs; no token economics; no raw personal data on any public surface; no W030+ or W033+ behavior.

## 8. Decision of record

W029 is an integrity layer over existing authoritative records, not a new authority. It is judged primarily on tamper-evidence, verification determinism, key-material safety, privacy preservation and PostgreSQL-authority containment. The W005 contracts are the foundation; W029 extends coverage and production-hardens the signer/verifier layer without rewriting the canonical-input discipline.
