# NET-W028 Evidence Ledger — Benefit Pools

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Issue:** #56  
**Dependencies:** NET-W027 + NET-W008 merged/verified  
**Architecture:** v1.0 frozen  
**Implementation branch:** `feat/net-w028-benefit-pools`

## Evidence plan

| Area | Required proof |
|---|---|
| Pool model | first-class tenant-scoped pool, funding references, policy lineage |
| Funding authority | only authoritative upstream value can fund a pool; caller amounts rejected |
| Conservation | allocation never exceeds funding; deterministic rounding/remainder conservation |
| Policy | immutable/versioned allocation policy; cross-scope lineage cannot fork |
| Eligibility | server-derived member eligibility and weights; caller assertions ignored/rejected |
| Privacy | protected demand/procurement data absent from pool/member views |
| Tenancy/auth | cross-tenant and unauthorized reads/writes fail closed without existence oracles |
| Atomicity | coupled pool + settlement effects share one authoritative transaction |
| Idempotency/concurrency | duplicate/retry/concurrent effects remain exactly-once |
| Settlement containment | `/settlement` remains the sole economic authority |
| Current state | stale funding/eligibility cannot authorize new economic effects |
| Mutation evidence | targeted mutations must be caught by acceptance tests |
| Verification | `bun run verify`, architecture/authority checks, secret scan, configured PostgreSQL/Redis integration |

## Acceptance map

AC-01 — Benefit Pool first-class records  
AC-02 — authoritative funding gate  
AC-03 — deterministic policy/eligibility/allocation  
AC-04 — conservation and deterministic remainder handling  
AC-05 — privacy + tenancy + authorization  
AC-06 — idempotency/concurrency/atomicity + fault injection  
AC-07 — settlement authority containment  
AC-08 — architecture/out-of-scope regression and W029/W033 deferrals

## Architectural invariants

- No second ledger or economic authority.
- No caller-asserted funding balance.
- No allocation beyond authoritative available value.
- No silent precision loss.
- No workflow authority duplication.
- No AI authority.
- No disclosure of protected procurement demand.
- Frozen architecture and lock unchanged.
