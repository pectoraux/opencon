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

**NET-W023 — OpenRTB and supply-chain adapters**

- GitHub issue: #46 — completed
- PR: #47 (squash-merged; includes the PR #47 remediation commit)
- Merge SHA: `c31ca29d45feeb59f652f0f9c2075465a00dbc85`
- Status: MERGED
- Authority: `/adapters` owns ALL provider-specific OpenRTB, ads.txt, app-ads.txt, sellers.json and SupplyChain (`schain`) parsing/types; the delivery-notice material path reuses the W022 `/measurement` ingestion composite; `/inventory`, `/campaigns`, `/outcomes`, `/evidence`, `/disputes`, `/settlement` untouched.
- Important review lesson: consistency of caller-supplied authorization files is NEVER authority. Supply-chain `verified` requires AUTHENTICATED (HMAC trust channel resolved only through the `SecretProvider` at composition time — fail-closed when unconfigured) AND FRESH (missing `observedAt` = stale) AND CONSISTENT. Untrusted evidence remains facts but can never govern.

### Previous completed milestones

NET-W001 through NET-W023 are complete and merged.

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

## Next implementation target

**NET-W024 — Consumer Demand Pools**

- GitHub issue: #48
- Status: READY_FOR_IMPLEMENTATION
- Branch prepared: `feat/net-w024-consumer-demand-pools`
- Requirements: DEM-001..003
- Dependencies: NET-W002 and NET-W008 — VERIFIED/MERGED
- Work order: `spec/work-orders/NET-W024.md`
- Evidence document: `docs/net-w024-consumer-demand-pools.md`

Definition of done: consumer demand can be aggregated into privacy-preserving pools with explicit server-enforced consent/authorization and deterministic qualification, and competing suppliers can receive qualified aggregate demand — without exposing individual commitments, trusting caller-asserted aggregates, or creating any parallel economic authority.

## W024 architecture checklist

1. `/demand` (the frozen sixteenth-domain home established by NET-W001) is the sole owner of consumer demand-pool semantics: pools, commitments, the versioned provider-neutral category/attribute vocabulary, privacy-preserving aggregation, and qualification derivation. No 17th domain.
2. `/settlement` remains the sole economic authority: demand pools create no ledger entries, credits, cash obligations, stakes or rewards; commitments mint no value and create no settlement entries.
3. `/identity`, `/organizations` and `/participants` remain the identity/membership/authorization authorities: pool/commitment authorization and consent are server-enforced through neutral reads — no caller assertion may fabricate demand membership or qualification.
4. Aggregate demand is DERIVED from authoritative commitment records at evaluation time; no caller-provided aggregate may be trusted; nothing aggregate is stored as asserted truth.
5. Individual commitments are private: supplier-facing outputs are minimized aggregates (counts, bounded distributions, suppressed below-floor groups) emitted only above the frozen privacy floor; suppressed groups are never named; individual commitments cannot be reconstructed from the normal output contract.
6. Qualification and aggregation are deterministic and reproducible: one explicit evaluation anchor per derivation, canonical digest over the aggregate facts, fixed bucket/group ordering.
7. Threshold/qualification policy is explicit and versioned; the privacy disclosure floor is a frozen constant no pool policy can lower or bypass.
8. Pool closure and commitment withdrawal are ONE-WAY field mutations (the NET-W019 retirement precedent — no local status machinery; `/workflows` untouched).
9. Cross-tenant references fail closed as not-found with no existence oracle.
10. Material mutations follow NET-W003/004 conventions exactly: composite idempotency keys, per-pool locking for concurrency conservation, ONE authoritative transaction, atomic audit lineage (buffer discarded on rollback, published only after commit).
11. No AI path exists anywhere in this surface; if one is ever introduced it is advisory only.
12. Explicitly deferred: business procurement pools (W025), supplier offers/competitive selection (W026), verified savings/counterfactuals (W027), Benefit Pools (W028).
13. `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged (frozen).
14. No new economic ledger, credit system, reputation authority, procurement authority or payment authority.

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

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include TypeScript typecheck, `arch:check`, `authority:check`, and the full test suite. Run configured real PostgreSQL/Redis integration tests for material work.

Current baseline (post NET-W023): 1509 pass / 15 skip / 0 fail / 16083 expect() / 1524 tests / 190 files; `arch:check` + `authority:check` 281 files / 0 violations.

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

Implement NET-W024 from issue #48 and `spec/work-orders/NET-W024.md` on `feat/net-w024-consumer-demand-pools`. Inspect the NET-W002 participants/membership/authorization conventions and the NET-W008/W019/W020 material-command conventions first (composite idempotency keys, `...WithinTx` repositories, ONE authoritative transaction, transactional audit buffers, derived never-stored views). Keep every aggregate a derivation; keep the privacy floor frozen; keep `/settlement` untouched. Add one-to-one acceptance coverage plus architecture, privacy, tenancy, fail-closed, concurrency/idempotency and economic-bypass regressions. Do not merge until implementation, verification/CI and architect approval are all satisfied.
