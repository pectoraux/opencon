# NET-W032 Evidence Ledger — Decentralized validation/dispute layer

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Issue:** #65  
**Dependencies:** NET-W010 + NET-W029 + NET-W030 + NET-W031 merged/verified  
**Architecture:** v1.0 frozen (byte-identical)  
**Implementation branch:** `feat/net-w032-decentralized-validation-dispute`

## Scope

W032 extends `/disputes` with independent validator/challenge coordination. It does not create a seventeenth domain or replace any existing authority. Validators create observations/challenges; deterministic quorum/outcome derivation produces an accepted result; the owning authority alone applies authoritative mutation.

## Acceptance map

| AC | Required proof | Delivered |
|---|---|---|
| AC-01 validator model | scoped participant identity, eligibility, role/authorization, server-bound actor | TBD |
| AC-02 deterministic assignment | explicit anchor, eligibility filtering, conflict exclusion, stable tie-break | TBD |
| AC-03 challenges | bounded challenge window, idempotent creation, terminal rounds, re-challenge as new round | TBD |
| AC-04 validator observations | assignment-bound, actor-bound, evidence/attestation references, no impersonation | TBD |
| AC-05 quorum/outcome | versioned policy, deterministic thresholds, insufficient/conflict/invalid cases | TBD |
| AC-06 conflict/tenancy | self-dealing, beneficiary, scope and cross-tenant isolation | TBD |
| AC-07 authority containment | validators cannot directly mutate workflow/reputation/evidence/settlement state | TBD |
| AC-08 economic containment | stake/reserve/penalty flows use `/settlement` only, with atomicity | TBD |
| AC-09 atomicity/concurrency | composite idempotency, locks, rollback, transactional audit, fault injection | TBD |
| AC-10 architecture regression | frozen architecture/authority boundaries, no W033+ or new crypto | TBD |

## Verification record

To be completed on the implementation head:

- `bun run typecheck`
- `bun run arch:check`
- `bun run authority:check`
- `bun run verify`
- targeted mutation driver: every acceptance guard caught; byte-identical restoration; clean tree
- secret scan
- configured real PostgreSQL/Redis integration
- CI verification + integration jobs on push and pull-request events

## Design decisions to close before merge

1. Exact validator eligibility predicate and versioned policy.
2. Exact assignment cardinality and deterministic ordering/tie-break.
3. Challenge-window duration and evaluation semantics.
4. Observation verdict vocabulary and treatment of abstention/invalid observation.
5. Quorum/threshold formula and conflict/tie behavior.
6. Terminal outcome vocabulary.
7. Revalidation/rechallenge round identity and immutability.
8. Exact owner-authority application contracts for any supported dispute target.
9. Economic stake/reserve/penalty semantics and `/settlement` WithinTx calls.
10. Failure/rollback guarantees when authority application or audit publication fails.

## Review notes

This ledger is intentionally incomplete until the implementation closes the exact protocol rules above. No implementation agent may treat unspecified constants as final protocol semantics merely because tests happen to pass.
