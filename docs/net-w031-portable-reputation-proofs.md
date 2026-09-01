# NET-W031 Evidence Ledger — Portable reputation proofs

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Issue:** #63  
**Dependencies:** NET-W007 + NET-W029 merged/verified  
**Architecture:** v1.0 frozen (byte-identical)  
**Implementation branch:** `feat/net-w031-portable-reputation-proofs`

## Evidence plan → evidence delivered

| Area | Required proof | Delivered |
|---|---|---|
| Proof model | derived, self-contained, tenant-scoped portable reputation proofs (aggregate facts + W029 signed envelope) | TBD (AC-01) |
| Aggregate disclosure | aggregate/scoped facts only; no raw personal activity, no payloads, no cross-tenant data | TBD (AC-02) |
| Verification | deterministic, non-mutating, fail-closed with machine-readable closed-vocabulary reasons | TBD (AC-03) |
| Non-purchasability | spend/wealth never alters disclosed dimension state through any proof path | TBD (AC-04) |
| Time-decay consistency | disclosed scores equal the authority's own deterministic decayed values at issuance | TBD (AC-05) |
| Evidence lineage | proofs reference authoritative input/evidence lineage ids opaquely (REP-004) | TBD (AC-06) |
| Tenancy/auth | tenant-scoped issuance; guard-action authorization; no existence oracles | TBD (AC-07) |
| Idempotency/atomicity | composite idempotency, one authoritative transaction, transactional audit, fault injection | TBD (AC-08) |
| Mutation evidence | targeted mutations must be caught by acceptance tests | TBD (below) |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration | TBD (below) |

## Acceptance map (to be filled as implemented)

TBD — one-to-one AC suites will be authored under `tests/` per the work order §6, plus the architecture/out-of-scope regression suite.

## Verification record (to be executed)

TBD — the implementing agent records here: typecheck, arch:check, authority:check, full-suite counts (baseline 1916/15/0 / 1931 tests / 247 files), mutation-driver results, secret scan, CI both events, and any remediation disclosures.

## Architectural invariants

- No second reputation authority; no raw private record transfer (PRIV-001..002).
- No new cryptographic primitives or signing surfaces — the W029 machinery is composed, not extended.
- Aggregate disclosure only under the aggregate disclosure gate (PRIV-003).
- Non-purchasable reputation (REP-002); time decay at derivation (REP-003); evidence lineage via opaque references (REP-004).
- No decentralized validation (W032); no end-to-end flows (W033+).
- Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.
