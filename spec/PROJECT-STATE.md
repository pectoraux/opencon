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

**NET-W025 — Business procurement pools**

- GitHub issue: #50 — completed
- PR: #51 (squash-merged)
- Merge SHA: `bcaf81b82088688af701f1a90242cc61b1fdd094`
- Status: MERGED
- Authority: `/demand` remains the sole demand/procurement aggregation authority. W025 extends the W024 demand boundary with tenant-scoped business procurement pools, private buyer-authorized commitments, deterministic qualification, and privacy/competition-preserving derived aggregates. `/settlement` remains the sole economic authority; `/identity`, `/organizations`, `/participants` remain membership/authorization authorities; `/workflows` remains lifecycle authority and was untouched.
- Important W025 review lesson: commitment uniqueness must be per `(pool, submitter)`, not `(pool, buyerOrganization)`, so commitment count and distinct-organization count remain independent privacy/competition dimensions. Both frozen disclosure floors gate every aggregate fact, and exact competitor commercial terms remain unrepresentable in supplier-facing output.

### Previous completed milestones

NET-W001 through NET-W025 are complete and merged.

Important lineage checkpoints:

- NET-W004: `/workflows` lifecycle authority
- NET-W005: `/evidence` provenance/truth authority
- NET-W006: `/outcomes` normalized measurement
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
- NET-W025: business procurement pools — competition-aware aggregation inside `/demand` with dual frozen disclosure floors

## Next implementation target

**NET-W026 — Supplier offers and competitive selection**

- GitHub issue: #52 — OPEN
- Status: READY_FOR_IMPLEMENTATION
- Branch: `feat/net-w026-supplier-offers-competitive-selection`
- Dependencies: NET-W025 and NET-W008 — VERIFIED/MERGED
- Work order: `spec/work-orders/NET-W026.md`
- Evidence document: `docs/net-w026-supplier-offers-competitive-selection.md`

Definition of done: authorized suppliers can submit bounded, tenant/pool-scoped offers against currently qualified W025 demand; hard eligibility is server-derived; competitive ranking/selection is deterministic and auditable; W025 privacy remains intact; `/demand` remains the single procurement authority; and `/settlement` remains the sole economic authority.

## W026 architecture checklist

1. `/demand` remains the sole authority for procurement demand, pools, qualification, supplier offers and selection semantics; no 17th domain and no second procurement authority.
2. `/settlement` remains the sole economic authority: no offer/selection command may mint value, credits, cash obligations, rewards, balances or payment state.
3. `/identity`, `/organizations`, `/participants` remain identity/membership/authorization authorities; supplier authorization is server-resolved.
4. Offers are first-class, tenant/pool-scoped durable records with provenance, validity and record-format lineage.
5. Offers can only compete against currently qualified W025 demand; closed/withdrawn/unqualified demand is a hard gate.
6. Hard eligibility is deterministic and server-derived; caller-provided eligibility, qualification, scores or selection results are never trusted.
7. Competitive ranking/selection is deterministic and reproducible at one explicit evaluation anchor; tie-breaking is explicit and stable.
8. W025 buyer commitments remain private: no buyer IDs, commitment IDs, exact competitor quantities, prices, budgets or timing may cross supplier-facing surfaces.
9. Any AI/model output is advisory only, after hard eligibility, and can never authorize privacy release, eligibility, selection, tenancy or economic mutation.
10. Material mutations follow the established idempotency → concurrency → one authoritative transaction → transactional audit → post-commit publication pattern.
11. Cross-tenant references fail closed without existence oracles; unauthorized supplier actions fail closed.
12. `/workflows` remains lifecycle authority; do not introduce local transition machinery.
13. W027 verified savings/counterfactual semantics and W028 Benefit Pool semantics are excluded.
14. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

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
Consistency of caller-supplied content is never authority: verification that `verified` implies requires an authenticated trust channel and fresh mandatory recency data. Optional freshness fields must fail closed when absent, and regressions plus mutation checks must prove both gates.

### Aggregate disclosure gating
Every aggregate fact — including counts inside machine-readable check details — is disclosed only under the same gate as the aggregate itself. Derived views re-derive from CURRENT authoritative records at one explicit anchor and never trust stored or caller-asserted aggregates; suppressed groups are counted, never named.

### Procurement privacy/competition
For business procurement, commitment count and distinct buyer-organization count are separate dimensions. Uniqueness is per `(pool, submitter)` so a single organization cannot bypass the distinct-organization floor by using multiple members; both frozen floors gate disclosed counts and distributions.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include TypeScript typecheck, `arch:check`, `authority:check`, and the full test suite. Run configured real PostgreSQL/Redis integration tests for material work.

W025 final verification: 1625 pass / 15 skip / 0 fail / 18000 expect() / 1640 tests / 206 files; `arch:check` + `authority:check` 290 files / 0 violations; 6/6 targeted mutation checks caught; CI run 160 green for verify + real PostgreSQL/Redis integration.

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

Activate NET-W026 from issue #52 and `spec/work-orders/NET-W026.md` on `feat/net-w026-supplier-offers-competitive-selection`. Prepare exactly one implementation PR. Build strictly on the merged W025 procurement boundary: supplier offers consume only the minimized qualified demand contract, hard eligibility is authoritative and deterministic, selection is reproducible and auditable, buyer commitment privacy remains intact, and no economic authority is introduced outside `/settlement`. Do not introduce W027/W028 semantics or alter the frozen architecture.
