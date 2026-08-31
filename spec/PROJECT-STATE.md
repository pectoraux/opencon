# OpenCon Project State

**Purpose:** machine-readable/human-readable resume point for a new LLM architect or implementation agent.

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

**NET-W024 — Consumer Demand Pools**

- GitHub issue: #48 — completed
- PR: #49 (squash-merged)
- Merge SHA: `cdfe12b8d5d56e3158505bbc77878e9b9e3561f7`
- Status: MERGED
- Authority: `/demand` is the demand-aggregation authority — consumer demand pools, private commitments with server-written `aggregate_disclosure` consent grants, the versioned provider-neutral category/attribute vocabulary, the frozen privacy-disclosure floor, and the derived qualified-aggregate supplier view (never stored, never caller-asserted). `/settlement` remains the sole economic authority (zero economic surface in `/demand`); `/identity`//`organizations`//`participants` remain the membership/authorization authorities (neutral composition-root lookup); `/workflows` untouched (one-way closure/withdrawal fields).
- Important review lesson: aggregates are derived, never trusted — every aggregate fact (including counts inside machine-readable check details) is gated by the frozen privacy floor AND the requestor's server-resolved membership; individual commitments are unreachable except through the actor-scoped surface; the approved implementation preserves `/demand` as the single demand authority with no parallel economic authority.

### Previous completed milestones

NET-W001 through NET-W024 are complete and merged.

Important lineage checkpoints:

- NET-W004: `/workflows` lifecycle authority
- NET-W005: `/evidence` provenance/truth authority
- NET-W006: `/outcomes` normalized measurement authority
- NET-W007: deterministic multidimensional reputation
- NET-W008: economic ledger / credits / cash / settlement primitives
- NET-W009/010: risk/dispute authority
- NET-W011: campaign policy authority
- NET-W014: settlement/reputation integration
- NET-W015/016: creator identity and matching
- NET-W017: UGC lifecycle/rights and atomic composites
- NET-W018: sanctioned publication verification / disclosure gate
- NET-W019: inventory/placements and derived settlement-readiness
- NET-W020: cross-promotion clearing with one authoritative economic transaction
- NET-W021: campaign matching/optimization; selection only; AI advisory bounded after hard eligibility
- NET-W022: attribution/privacy adapter boundary; `/outcomes` remains semantic measurement authority
- NET-W023: OpenRTB/supply-chain adapter boundary with authenticated + fresh supply-chain verification
- NET-W024: consumer demand pools — privacy-preserving aggregation inside `/demand` with the frozen disclosure floor

## Next implementation target

**NET-W025 — Business procurement pools**

- GitHub issue: #50
- Status: READY_FOR_IMPLEMENTATION
- Branch prepared: `feat/net-w025-business-procurement-pools`
- Requirements: DEM-001..003, PROC-001..003
- Dependencies: NET-W024 and NET-W008 — VERIFIED/MERGED
- Work order: `spec/work-orders/NET-W025.md`
- Evidence document: `docs/net-w025-business-procurement-pools.md`

Definition of done: business procurement demand can be aggregated into privacy-preserving, competition-policy-governed pools built on the W024 foundations — with explicit organization/actor authorization, deterministic qualification, and supplier-facing minimized aggregate demand — without exposing competitors' exact quantities/prices/budgets/timing, without creating a second demand/procurement or economic authority, and without leaking W026–W028 semantics.

## W025 architecture checklist

1. `/demand` (the frozen sixteenth-domain home established by NET-W001) remains the sole demand/procurement-aggregation authority: NET-W025 implements business procurement pools INSIDE `/demand` on the W024 foundations — no 17th domain, no second demand or procurement ledger.
2. `/settlement` remains the sole economic authority: procurement pools create no ledger entries, credits, cash obligations, stakes or rewards; business commitments mint no value and create no settlement entries.
3. `/identity`, `/organizations` and `/participants` remain the identity/membership/authorization authorities: buyer-organization and actor authorization resolve server-side through the neutral membership lookup — no caller assertion may fabricate buyer eligibility, membership or qualification.
4. Aggregate demand is DERIVED from authoritative business commitment records at evaluation time; no caller-provided aggregate, count or qualification is ever trusted; nothing aggregate is stored as asserted truth.
5. Individual business commitments are private AND competitively sensitive: supplier-facing outputs are minimized aggregates (counts, bounded distributions, suppressed below-floor groups) emitted only above the frozen commitment floor AND the frozen distinct-organization floor; exact per-organization quantities, unit prices, budgets and timing never cross to aggregate views — only fixed bands/buckets/windows do; below-floor groups are counted, never named.
6. Qualification and aggregation are deterministic and reproducible: one explicit evaluation anchor per derivation, canonical digest over the aggregate facts (anchor excluded), fixed bucket/group ordering.
7. Qualification/competition policy is explicit and versioned on the pool record; the privacy/competition floors are frozen constants no pool policy can lower or bypass.
8. Procurement-pool closure and commitment withdrawal are ONE-WAY field mutations (the NET-W019/W024 retirement precedent — no local status machinery; `/workflows` untouched).
9. Cross-tenant references fail closed as not-found with no existence oracle; buyer-organization authorization failures are indistinguishable from nonexistent organizations.
10. Material mutations follow NET-W003/004/020 conventions exactly: composite idempotency keys, per-pool locking for concurrency conservation, ONE authoritative transaction, atomic audit lineage (buffer discarded on rollback, published only after commit).
11. No AI path exists anywhere in this surface; if one is ever introduced it is advisory only and can never authorize membership, privacy release, qualification, supplier selection or economic mutation.
12. Explicitly deferred: supplier offers/competitive selection (W026), verified savings/counterfactuals (W027), Benefit Pools (W028).
13. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged (frozen).
14. No new economic ledger, credit system, reputation authority, supplier-selection authority or payment authority.

## Review lessons that must persist

### Authority drift
Generic identifier matching is not sufficient for architecture policing. Preserve behavioral/static authority guards and positive/negative fixtures.

### Tenant isolation
For tenant-scoped reads, organization scope must flow service → port → runtime → HTTP where applicable. Cross-tenant identifiers should normally resolve as not-found rather than existence oracles.

### Policy lineage
When policy lineage is tenant-scoped, serialize identity independently of organization scope where required and re-check scope/version inside the authoritative transaction.

### Publication/disclosure
Semantic lifecycle gates owned outside generic workflow resolution must use sanctioned transition paths; generic callers must not bypass the gate.

### Economic atomicity
Coupled economic mutations must share one authoritative transaction. Use `...WithinTx` primitives; do not chain independently committing economic commands.

### Audit ordering
Audit publication occurs after durable commit; transactional buffers must not flush before commit succeeds.

### AI boundaries
AI outputs are advisory only and may not authorize hard eligibility, rights, tenancy, risk, settlement-readiness or lifecycle changes.

### Secrets
Provider credentials and signing material resolve only through `SecretProvider`; missing production secrets fail closed. Test/development doubles are never implicit production fallbacks.

### Adapter boundary
Provider-specific protocol vocabulary belongs entirely inside `/adapters`. Domains consume only neutral contracts. Cryptographic validity proves integrity/provenance, not authorization or ownership.

### Authenticated verification
Consistency of caller-supplied content is never authority: verification that `verified` implies requires an authenticated (operator-configured trust channel, composition-time only) and fresh (mandatory recency data) basis. Optional freshness fields must fail closed when absent, and regressions plus mutation checks must prove both gates.

### Aggregate disclosure gating
Every aggregate fact — including counts inside machine-readable check details — is disclosed only under the same gate as the aggregate itself (privacy/competition floors met AND the requestor server-authorized). Derived views re-derive from CURRENT authoritative records at one explicit anchor and never trust stored or caller-asserted aggregates; suppressed groups are counted, never named.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include TypeScript typecheck, `arch:check`, `authority:check`, and the full test suite. Run configured real PostgreSQL/Redis integration tests for material work.

Current baseline (post NET-W024): 1565 pass / 15 skip / 0 fail / 17006 expect() / 1580 tests / 198 files; `arch:check` + `authority:check` 286 files / 0 violations.

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

Implement NET-W025 from issue #50 and `spec/work-orders/NET-W025.md` on `feat/net-w025-business-procurement-pools`. Build on the NET-W024 implementation in `src/demand/` (reuse the membership-lookup pattern, the one-way closure/withdrawal fields, the pure aggregation-engine pattern, the frozen-floor discipline and the material-command conventions). Add the competition-policy dimension: a frozen distinct-organization floor, band/bucket/window-only disclosure of quantities/prices/budgets/timing, and buyer-organization authorization resolved server-side. Keep `/settlement` and `/workflows` untouched; keep W026–W028 semantics out. Add one-to-one acceptance coverage plus architecture, privacy, competition, tenancy, fail-closed, concurrency/idempotency and economic-bypass regressions. Do not merge until implementation, verification/CI and architect approval are all satisfied.
