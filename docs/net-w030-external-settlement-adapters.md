# NET-W030 Evidence Ledger — External settlement adapters

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Issue:** #61  
**Dependencies:** NET-W008 + NET-W029 merged/verified  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w030-external-settlement-adapters`

## Evidence plan

| Area | Required proof |
|---|---|
| Fact model | first-class tenant-scoped external transaction facts (append-only, immutable, provider-referenced) |
| Provider authentication | adapter facts authenticated (SecretProvider-resolved material); unauthenticated/stale/malformed fail closed |
| Adapter neutrality | provider-specific code ONLY in /adapters; /settlement consumes the neutral ExternalSettlementAdapter contract |
| Idempotency | exactly-once fact recording per (scope, provider, external id); replay-safe |
| Reconciliation | deterministic server-side matched/pending/mismatched with machine-readable reasons |
| No bypass | an external fact can never create/consume/reverse/mutate internal economic state |
| Tenancy/auth | cross-tenant and unauthorized access fails closed without existence oracles |
| Atomicity | recording + derivation idempotent, concurrency-safe, atomically audited |
| Traceability | internal lineage ⇄ external facts, both directions |
| Mutation evidence | targeted mutations must be caught by acceptance tests |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration |

## Acceptance map (to be finalized in the implementation session)

AC-01 — external transaction fact records (append-only, idempotent)  
AC-02 — authenticated adapter ingestion (fail-closed verification)  
AC-03 — deterministic reconciliation + machine-readable reasons  
AC-04 — no-economic-bypass containment  
AC-05 — privacy + tenancy + authorization  
AC-06 — idempotency/concurrency/atomicity + fault injection  
AC-07 — traceability + settlement-authority containment  
AC-08 — architecture/out-of-scope regression and W031+/W032 deferrals

## Architectural invariants

- No second economic authority; no external execution of internal mutations.
- No consensus layer, no blockchain/network validation, no token economics.
- No portable reputation proofs (W031); no decentralized validation (W032).
- Secrets resolve only through `SecretProvider`; no committed key material.
- Frozen architecture and lock unchanged.
