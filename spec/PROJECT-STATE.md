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

**NET-W026 — Supplier offers and competitive selection**

- GitHub issue: #52 — completed
- PR: #53 (squash-merged)
- Merge SHA: `6b8d8424587405aae7e0d8b8ea6bd5e48a5e0936`
- Status: MERGED
- Authority: `/demand` remains the sole demand/procurement/selection authority. W026 extended the W025 boundary with tenant/pool-scoped supplier offers, server-derived hard eligibility, deterministic competitive selection and immutable selection lineage. `/settlement` remains the sole economic authority; `/workflows` remained untouched.
- Important W026 review lesson: supplier offers and selection remain procurement decisions, never economic mutations; qualified-demand gates are re-derived from current W025 commitments, hard eligibility precedes ranking, supplier terms stay within authorized selection surfaces, and selection is deterministic/reproducible with an explicit anchor and stable tie-break.

### Previous completed milestones

NET-W001 through NET-W026 are complete and merged.

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
- NET-W025: business procurement pools — competition-aware aggregation inside `/demand` with dual frozen disclosure floors
- NET-W026: supplier offers and competitive selection — deterministic, privacy-preserving, selection-only procurement decision inside `/demand`

## Next implementation target

**NET-W027 — Verified savings and counterfactuals**

- GitHub issue: #54 — OPEN
- Status: READY_FOR_IMPLEMENTATION
- Branch: `feat/net-w027-verified-savings-counterfactuals` — prepared from merged W026 baseline
- Dependencies: NET-W006 and NET-W026 — VERIFIED/MERGED
- Requirements: PROC-002
- Work order: `spec/work-orders/NET-W027.md` — to be authored on activation
- Evidence document: `docs/net-w027-verified-savings-counterfactuals.md` — to be authored on activation

Definition of done: procurement savings require an explicit evidence-backed baseline and supported observed/counterfactual inputs; uncertainty is preserved; derivation is deterministic and anchor-aware; stale/invalid/insufficient evidence fails closed for authoritative use; and no second economic authority is created.

## W027 architecture checklist

1. `/demand` remains the procurement authority; any W027 procurement-specific semantics must extend the existing boundary or be composed at the bootstrap root without creating a second procurement authority.
2. `/outcomes` remains the normalized measurement authority; W027 cannot fabricate or redefine measurement semantics.
3. `/evidence` remains the provenance/truth authority; baseline/counterfactual inputs require traceable evidence or canonical outcome references.
4. `/settlement` remains the sole economic authority: W027 does not mint value, create a new ledger, settle savings, or create a parallel economic state.
5. Savings must not be inferred solely from supplier offer price, spend, reputation, or caller-provided arithmetic.
6. Baselines, counterfactual methods and assumptions are explicit, versioned/immutable where required, auditable, tenant-scoped and lineage-linked.
7. Uncertainty is first-class: intervals/brackets and method confidence are preserved; unsupported point claims fail closed.
8. Derived savings use one explicit evaluation anchor; canonical digest excludes the anchor so identical state yields identical derivation.
9. Invalid, stale, missing or insufficient evidence fails closed for economically authoritative use; evidence freshness and provenance are never silently downgraded.
10. Cross-tenant references fail closed without existence oracles; authorization is server-resolved.
11. Material mutations use composite idempotency keys, concurrency serialization, one authoritative transaction, transactional audit buffering and post-commit publication.
12. AI/model output, if used, is advisory only and cannot authorize a savings claim, evidence sufficiency, privacy release or economic mutation.
13. W028 Benefit Pools remain excluded.
14. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged unless a formal Architecture Change Request is approved.

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

### Supplier selection
Supplier competition remains inside `/demand`; qualified-demand gating must be current and server-derived; offers are private to suppliers while selection surfaces are pool-creator-authorized; selection is procurement state and must never become a hidden economic authority.

### Verified savings / counterfactuals (W027)
Savings are claims about realized outcomes, not offers alone. Every authoritative savings result must point to an explicit baseline and supported observed/counterfactual evidence, preserve uncertainty and method/version lineage, and fail closed when evidence is invalid, stale or insufficient. W028 benefit allocation remains deferred.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include TypeScript typecheck, `arch:check`, `authority:check`, and the full test suite. Run configured real PostgreSQL/Redis integration tests for material work.

W026 final verification: 1675 pass / 15 skip / 0 fail / 19038 expect() / 1690 tests / 214 files; `arch:check` + `authority:check` 294 files / 0 violations; 7/7 targeted mutation checks caught; CI green for verify + real PostgreSQL/Redis integration.

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

Implement NET-W027 from Issue #54 on `feat/net-w027-verified-savings-counterfactuals`. Before coding, author `spec/work-orders/NET-W027.md` and the evidence ledger. Resolve authority placement explicitly against the frozen architecture: `/outcomes` owns normalized measurement semantics, `/evidence` owns provenance/truth, `/demand` owns procurement semantics, and `/settlement` owns economics. Use neutral references and composition-root orchestration where necessary; do not create a second authority. Preserve uncertainty, explicit baselines/counterfactual assumptions, tenant isolation, deterministic anchor-based derivation, idempotency/concurrency/atomicity/audit lineage, and the W028 deferral. Do not merge until implementation, verification/CI and architect approval are all satisfied.
