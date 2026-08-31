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

**NET-W022 — Attribution and privacy measurement adapters**

- GitHub issue: #44 — completed
- PR: #45
- Merge SHA: `45f1884656e470666e764266735ea59ec728c0ea`
- Status: MERGED
- Authority: `/measurement` adapter boundary with `/outcomes` measurement semantics
- Important review lesson: raw provider payloads remain confined to the owning adapter; normalization is fail-closed and deterministic; secrets are composition-time inputs only; persistence/idempotency/audit remain in the `/outcomes` authority and material coupled operations use one authoritative transaction.

### Previous completed milestones

NET-W001 through NET-W022 are complete and merged.

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

## Next implementation target

**NET-W023 — OpenRTB and supply-chain adapters**

- GitHub issue: #46
- Status: READY_FOR_IMPLEMENTATION
- Branch prepared: `feat/net-w023-openrtb-supply-chain-adapters`
- Requirements: ADAPTER-001..002
- Dependencies: NET-W019 and NET-W022 — VERIFIED/MERGED
- Work order: `spec/work-orders/NET-W023.md`
- Evidence document: `docs/net-w023-openrtb-supply-chain.md`

Definition of done: existing external ad supply can connect through provider-specific adapters while OpenCon inventory, campaign, measurement, evidence, risk and settlement semantics remain authoritative and cannot be bypassed.

## W023 architecture checklist

1. `/adapters` is the sole owner of provider-specific OpenRTB, ads.txt, app-ads.txt, sellers.json and SupplyChain (`schain`) parsing/types.
2. `/inventory` remains authoritative for registered supply, ownership, placement context, eligibility and settlement-readiness.
3. `/campaigns` remains authoritative for campaign policy/targeting; external bid-request fields cannot override it.
4. `/measurement` remains the adapter/measurement boundary and `/outcomes` remains normalized measurement authority.
5. `/evidence` remains truth/provenance authority for material external attestations.
6. `/disputes` remains risk/control authority; external assertions cannot self-clear risk.
7. `/settlement` remains the sole economic authority; OpenRTB bid/request/response data cannot directly create ledger state.
8. External identifiers must resolve to exactly one authoritative inventory source or fail closed; syntax alone is not authorization.
9. Raw bid requests are opaque outside the owning adapter and must not be retained by default.
10. Normalization must be deterministic, privacy-minimized, versioned and provider-neutral.
11. Any material mutation must use established tenancy, authorization, idempotency, concurrency, transaction and audit conventions.
12. Coupled material state must use one authoritative transaction or an explicitly approved recoverable saga.
13. No seventh/eighteenth/etc. domain: no new domain boundary without Architecture Change Request.
14. Provider SDK/types must not cross from `/adapters` into domain authorities.

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

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include TypeScript typecheck, `arch:check`, `authority:check`, and the full test suite. Run configured real PostgreSQL/Redis integration tests for material work.

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

Implement NET-W023 from issue #46 and `spec/work-orders/NET-W023.md` on `feat/net-w023-openrtb-supply-chain-adapters`. Inspect W019 inventory contracts and W022 adapter conventions first. Keep provider-specific protocol types isolated in `/adapters`; compose normalized facts only at the bootstrap boundary. Add one-to-one acceptance coverage plus architecture, privacy, tenancy, fail-closed, concurrency/idempotency and settlement-bypass regressions. Do not merge until implementation, verification/CI and architect approval are all satisfied.