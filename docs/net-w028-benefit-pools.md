# NET-W028 Evidence Ledger — Benefit Pools

**Status:** MERGED  
**Issue:** #56 (completed)  
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

## Verification summary

| Gate | Result |
|---|---|
| `bun run typecheck` | **GREEN** |
| `bun run arch:check` | **GREEN** (301 files / 0 violations) |
| `bun run authority:check` | **GREEN** (301 files / 0 violations) |
| `bun test` | **GREEN — 1783 pass / 15 skip / 0 fail / 22,270 expect() / 1798 tests / 231 files** (W027 baseline 1727/1742/223 → +56 tests, +8 files) |
| Secret scan (W028 files) | **CLEAN** |
| Mutation checks (9 directions) | **9/9 CAUGHT** |
| Real PostgreSQL/Redis integration | CI integration job (postgres:17 + redis:7 service containers) |

## Architectural guardrails (verified)

- `/benefits` is the existing frozen domain boundary (the sixteenth and LAST skeletal v1.0 domain — activated INSIDE the boundary; no 17th domain; `architecture.md`/`architecture-lock.md` unchanged; 301 files / 0 arch+authority violations).
- `/settlement` remains the sole economic authority — the ONLY economic primitive `/benefits` touches is the EXISTING `rewardService.allocateRewardsWithinTx` on the caller's authoritative transaction (wired as the neutral `BenefitEconomicDrawPort` at the composition root); entitlement-only (savings-funded) allocations post NOTHING; no credits/cash/pending-value/maturity/standalone-reward vocabulary exists in the `/benefits` files; `ECONOMIC_VALUE_SOURCES` and `ECONOMIC_ACCOUNT_KINDS` are unchanged (no benefit source or account kind was minted).
- `/demand` remains the procurement/savings authority — W027 `ProcurementSavings` records are consumed as verified/derived FACTS through the neutral `BenefitSavingsFundingLookup` (the current re-derivation; invalidated baselines and superseded observations fail funding closed at every anchor — never stale snapshots); W028 fabricates no measurements and adds no method to the `/demand` port.
- `/organizations` remains the membership authority — the `active_membership` eligibility criterion resolves through the neutral `BenefitMembershipLookup` (server-derived; caller-supplied eligibility/weights are never authority).
- `/workflows` remains the lifecycle authority — pool closure is a ONE-WAY field mutation (`closedAt`), never a status transition; no lifecycle machinery in `/benefits`.
- Funding is references-only — pool records carry NO amount fields; authoritative amounts are re-derived in-tx at every allocation (MATURE + not-consumed + not-reversed + positive for economic draws; currently-supported savings for entitlement funding); caller amounts are forbidden on economic draws and validated-only on entitlement requests.
- Allocation is deterministic and conservation-preserving — scaled-integer (ECONOMIC_SCALE 1e6) proportional-weights floor arithmetic; `last_member_absorbs` mirrors the `/settlement` split exactly (Σ shares === source EXACTLY — required for economic draws); `retained_in_pool` keeps the remainder EXPLICIT and inside the funding envelope (never lost, never silently redistributed); the in-tx conservation check rejects any allocation that would exceed the authoritative envelope.
- The draw-policy consistency bridge — economic draws require the settlement reward policy to mirror the benefits policy member declarations EXACTLY (order, persons, weights — the locked accounts are always the posted accounts); drift fails closed.
- Privacy — the member view exposes ONLY the requesting member's own shares and totals (no other-member identities, weights, amounts; no funding resolution details; no procurement internals); non-member reads are indistinguishable from nonexistent pools (no existence oracles); cross-tenant reads fail closed as not-found.
- Current-state authorization — funding availability, eligibility and conservation are re-derived INSIDE the authoritative transaction before any economic effect (a stale pool snapshot can never authorize value movement).
- W029+ decentralization, W033–W036 end-to-end flows, external payment execution and AI authority are explicitly excluded (source-level bans + frozen vocabulary pins).

## Architectural decision record

1. **Requirement mapping** — BEN-001 (benefit types: the six closed types are DECLARATIVE pool classification — the economic execution is always the existing settlement reward draw or nothing, never a per-type primitive), BEN-002 (funding: `economic_value` for advertising/sponsorship/network-contribution value recognized through the W008/W014 authoritative value records; `verified_savings` for procurement funding through the W027 verified realized-savings lineage), BEN-003 (allocation by defined eligibility policies: the versioned policy + server-derived `active_membership` eligibility + server-owned weights), BEN-004 (measurable value delivered: the append-only allocation lineage + derived views + the anchor-excluded decision digest).
2. **The economic dichotomy** — a pool with `economic_value` funding EXECUTES the settlement reward-allocation draw (exactly-once value consumption; `last_member_absorbs` REQUIRED so the benefits plan and the settlement split are always equal); a pool with only `verified_savings` funding is ENTITLEMENT-ONLY (allocations record deterministic entitlement plans and post NOTHING — verified savings are measurement decisions, not drawable ledger value).
3. **Policy lineage** (`benefit_pool_policies`) — append-only, immutable per version, tenant-scoped, with the ORGANIZATION-INDEPENDENT lineage mutex (a lineage can never fork across organizations — the W007 precedent); bounded declaration sets (≤64 members, ≤8 funding refs), closed vocabularies (types, criteria, dispositions), positive ≤6-decimal weights, unique members.
4. **Pool records** (`benefit_pools`) — tenant-scoped, created by an active member, funding REFERENCES ONLY (kind + id; shape-validated at creation), policy version pinned server-side at creation; closure is ONE-WAY (a closed pool never allocates again).
5. **Allocation lineage** (`benefit_pool_allocations`) — immutable authoritative snapshots of completed allocations (funding resolution, eligible members, plan, conservation facts, the draw lineage when economic); the cumulative envelope is re-derived in-tx over the lineage (the TOCTOU closure).
6. **Deterministic plan** (`allocation-engine.ts`) — PURE; scaled-integer floor per share in DECLARATION order; the last-member absorption (economic draws) or the explicit retained remainder; the digest over canonical facts EXCLUDING the anchor (identical authoritative state ⇒ identical digest).
7. **Atomicity** — ONE authoritative transaction per allocation: in-tx pool/policy/funding/eligibility/prior-lineage re-reads, the plan, the conservation check, the (optional) settlement draw through `allocateRewardsWithinTx`, the lineage record and the buffered audit event (post-commit publication); composite idempotency (`benefits_allocation:{scope}:{pool}:{actor}:{key}`) + the pool mutex + the pinned settlement draw lock set (the exact keys the standalone draw would acquire — the locked accounts are always the posted accounts).
8. **Sanctioned shared-file amendments** — the no-premature suite activates `NET_W028_DOMAINS = ["benefits"]` (the sixteenth-of-sixteen activation); the NET-W004 deferred list retires its LAST entry (`benefits`) with the sanctioned `NET-W028 UPDATE` comment — every frozen v1.0 domain is now implemented. The historical `allocateBenefit` forbidden pattern stays banned verbatim (the sanctioned surface is `allocatePoolBenefits`/`BenefitPoolAllocation`).

## Implementation shape

- `src/benefits/port.ts` — the full contract: the frozen NET-W028 vocabularies (record formats `NET-W028:1`; benefit/funding/criteria/disposition sets; bounds; the versioned allocation policy `proportional-weights-scaled-floor` + 7 machine-readable criteria), the FIVE neutral joins (membership / value-funding facts incl. the WithinTx variant / savings-funding re-derivation / reward-policy facts / the economic draw port), the record contracts (policies, pools, allocation lineage, derived views, the privacy-preserving member view), repositories + service interfaces, `InvalidBenefitPoolError`/`BenefitPoolConflictError`/`BenefitPoolNotFoundError`, audit vocabulary (4 events).
- `src/benefits/allocation-engine.ts` — the PURE deterministic plan + the anchor-excluded canonical digest.
- `src/benefits/benefit-pool-service.ts` — policy versioning under the org-independent lineage mutex; pool records + ONE-WAY closure; the DERIVED allocation view (7 machine-readable checks + draw-consistency preview); the ATOMIC allocation operation (draw + entitlement paths over one shared in-tx body); the member view; guarded read surfaces.
- `src/benefits/authority-benefit-repositories.ts` — the PostgreSQL-authority backed append-only repositories (`benefit_pool_policies`, `benefit_pools`, `benefit_pool_allocations`).
- Wiring: `src/bootstrap/runtime.ts` (repositories + the five neutral lookups over the /organizations-membership, /settlement value-record + reward-policy services, the /demand savings re-derivation, and the `rewardService.allocateRewardsWithinTx` draw port + service + 9 apiCommands + view shapers + `Runtime.benefitPoolService`), `src/api/port.ts` (9 guarded commands), `src/api/server.ts` (9 guarded routes under `/api/benefits/*`), module/README/index amendments.
- Tests: `tests/benefits/_net-w028-harness.ts` (guard actions; the value-funded scenario over the REAL W008 mature-value factory + mirrored reward policy; the savings-funded scenario over the REAL W027 savings machinery), AC-01..07 suites, `tests/regression/net-w028-ac-08-architecture-out-of-scope.test.ts`, the no-premature amendment, the NET-W004 deferred-list retirement, and the mutation driver outside the repository.

## Evidence matrix (AC → suite → result)

| AC | Suite | Tests | Result |
|---|---|---:|---|
| AC-01 pool records | `tests/benefits/net-w028-ac-01-pool-records.test.ts` | 7 | PASS |
| AC-02 authoritative funding gate | `tests/benefits/net-w028-ac-02-funding-gate.test.ts` | 6 | PASS |
| AC-03 deterministic policy/eligibility/allocation | `tests/benefits/net-w028-ac-03-deterministic-allocation.test.ts` | 7 | PASS |
| AC-04 conservation + deterministic remainder | `tests/benefits/net-w028-ac-04-conservation-remainder.test.ts` | 6 | PASS |
| AC-05 privacy + tenancy + authorization | `tests/benefits/net-w028-ac-05-privacy-tenancy.test.ts` | 5 | PASS |
| AC-06 idempotency/concurrency/atomicity | `tests/benefits/net-w028-ac-06-idempotency-concurrency.test.ts` | 7 | PASS |
| AC-07 settlement-authority containment | `tests/benefits/net-w028-ac-07-settlement-containment.test.ts` | 6 | PASS |
| AC-08 architecture/out-of-scope | `tests/regression/net-w028-ac-08-architecture-out-of-scope.test.ts` (+ no-premature + W004 deferred-list amendments) | 11 | PASS |

## Mutation evidence (9/9 caught)

| # | Mutation | Target | Result |
|---|---|---|---|
| M1 | Caller-supplied amount allowed on economic draws (caller arithmetic becomes authority) | AC-02 | CAUGHT |
| M2 | In-tx funding-envelope conservation check removed (allocation can exceed authoritative funding) | AC-04 | CAUGHT |
| M3 | Settlement reward-policy mirror verification removed (drifted accounts could be posted) | AC-03 | CAUGHT |
| M4 | In-tx eligibility re-derivation failure removed (ineligible members allocate) | AC-03 | CAUGHT |
| M5 | PENDING (unmatured) value qualifies as funding in both derivations (funding gate bypass) | AC-02 | CAUGHT |
| M6 | Composite allocation idempotency key randomized (replays become fresh mutations) | AC-06 | CAUGHT |
| M7 | Member-view privacy filter removed (every member's shares leak into each view) | AC-05 | CAUGHT |
| M8 | Retained remainder silently dropped (value destroyed, not conserved) | AC-04 | CAUGHT |
| M9 | Pool tenancy-scope check removed (cross-tenant reads succeed for the creator) | AC-05 | CAUGHT |

Driver: `opencon-tmp/w028-mutation-driver.py` (outside the repository; cp-backup + assert-applied + assert-failed + assert-reverted + final-green; working tree verified clean after each direction).

## Delivery record

- Implementation commit: `e7e1b5a006424b4ba49375281dd0ddcf3659e128` (branch head; 23 files, +7445/−35)
- PR: **#57** — squash-merged as `6e309e2af05a962e3417999ad8079da16d9ebc37` ("feat(benefits): NET-W028 — Benefit Pools (#57)")
- CI: **GREEN 4/4 on BOTH events at e7e1b5a** (verify + integration with real PostgreSQL 17 + Redis 7 service containers, push + pull_request)
- Verification-status comment: id 5495635081; architect review decision-of-record comment: id 5495655558 (architect == PR author under the single-account setup — the recorded decision is the authoritative review per the standing protocol)
- Issue #56 closed as completed by the merge
- Post-merge durable state: `spec/PROJECT-STATE.md` + `spec/ROADMAP.md` advanced to NET-W029 at the merge checkpoint
