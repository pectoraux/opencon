# NET-W029 Evidence Ledger — Cryptographic attestations and commitments

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Issue:** #58  
**Dependencies:** NET-W005 + NET-W007 + NET-W008 merged/verified  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w029-cryptographic-attestations`

## Evidence plan

| Area | Required proof |
|---|---|
| Foundation reuse | W005 commitments + canonical-input discipline extended, never rewritten |
| Signed attestations | production asymmetric algorithms; versioned algorithm/key vocabularies; keys via SecretProvider only |
| Coverage | attestations/commitments over evidence + reputation inputs + settlement value records |
| Determinism | identical inputs ⇒ identical verification verdicts; reproducible canonical input |
| Tamper evidence | mutated payload/statement/covered-set/signature/algorithm/key fails closed with machine-readable reason |
| Privacy | commitments bind without plaintext; disclosure only under frozen privacy rules (PRIV-003) |
| Tenancy/auth | cross-tenant and unauthorized access fails closed without existence oracles |
| Atomicity | material mutations idempotent, concurrency-safe, atomically audited |
| Authority containment | an attestation never mints/mutates/resurrects authoritative state; PostgreSQL authoritative |
| Mutation evidence | targeted mutations must be caught by acceptance tests |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration |

## Acceptance map (to be finalized in the implementation session)

AC-01 — attestation/commitment records over the three authoritative record families  
AC-02 — signed attestations: versioned algorithms + SecretProvider key references  
AC-03 — deterministic verification + tamper detection  
AC-04 — commitment privacy preservation  
AC-05 — privacy + tenancy + authorization  
AC-06 — idempotency/concurrency/atomicity + fault injection  
AC-07 — authority containment (PostgreSQL authoritative; no consensus/external execution)  
AC-08 — architecture/out-of-scope regression and W030+/W033+ deferrals

## Architectural invariants

- No new semantic authority; no 17th domain.
- No consensus layer, no blockchain/network validation, no token economics.
- No external payment/settlement adapters; no portable reputation proofs.
- Keys only through `SecretProvider`; no committed key material.
- An attestation never resurrects revoked/invalidated/superseded authoritative state.
- Frozen architecture and lock unchanged.
