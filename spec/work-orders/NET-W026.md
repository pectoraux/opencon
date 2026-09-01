# NET-W026 — Supplier offers and competitive selection

**Status:** READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` MUST remain unchanged)  
**Dependencies:** NET-W025, NET-W008 — VERIFIED/MERGED  
**Tracking:** GitHub issue #52  
**Implementation branch:** to be prepared

## §1 Objective

Extend the existing `/demand` procurement boundary with supplier offers against qualified NET-W025 business demand and deterministic competitive selection, while preserving the authority, privacy, tenancy, auditability and economic boundaries established by W025.

## §2 Architecture decision of record

```text
NET-W025 qualified business demand
        ↓
supplier offers (tenant/pool scoped, durable, provenance + validity)
        ↓
server-derived hard eligibility
        ↓
deterministic competitive ranking / selection
        ↓
auditable selection result
        ↓
/settlement remains the SOLE economic authority
```

`/demand` remains the single authority for procurement demand, procurement pools, supplier-facing demand qualification, supplier offers and selection semantics. No new domain or second procurement authority is permitted without an Architecture Change Request.

## §3 Authority rules

- `/demand` owns offer and selection semantics; `/settlement` owns all economic state and effects.
- NET-W025 remains authoritative for pool qualification and minimized buyer-demand disclosure. Offers cannot bypass or weaken its qualification/privacy gates.
- `/identity`, `/organizations`, `/participants` remain membership/authorization authorities.
- Hard supplier eligibility is server-derived and deterministic. Caller assertions cannot authorize eligibility or selection.
- AI/model output, if later introduced, may be advisory for ranking only AFTER hard eligibility. It may never authorize eligibility, privacy release, selection, tenancy or economic mutation.
- Cross-tenant references fail closed without existence oracles.
- No W027 verified savings/counterfactual semantics and no W028 Benefit Pool semantics.
- `/workflows` remains the lifecycle authority; no local lifecycle machinery may be introduced.

## §4 Scope

### §4.1 Supplier offer record

A first-class, tenant-scoped durable offer record with:

- pool identity and tenant scope;
- server-resolved supplier identity/authorization;
- bounded provider-neutral offer attributes matching the qualified demand contract;
- explicit validity/effective windows;
- provenance/execution/correlation/causation lineage;
- record-format/version lineage;
- idempotency/execution lineage fields;
- one-way withdrawal/expiry semantics as fields, without `/workflows` transition machinery.

Exact buyer commitment identities and protected commitment records never become part of the supplier offer/selection surface.

### §4.2 Eligibility

Selection MUST operate only over offers that are:

1. tenant/pool scoped correctly;
2. submitted by an authorized supplier actor;
3. associated with a currently qualified NET-W025 demand pool;
4. valid at the explicit evaluation/selection anchor;
5. compliant with all hard pool/offer policy constraints.

Eligibility is re-derived from authoritative records. No caller-provided `eligible`, `qualified`, ranking score or selection result is trusted.

### §4.3 Deterministic competitive selection

- Ranking inputs and tie-break ordering are explicit, bounded, versioned and server-owned.
- Identical authoritative state and evaluation anchor produce identical ranking/selection output.
- Selection must be reproducible and auditable.
- AI may optionally provide an advisory ranking signal only after deterministic hard eligibility; deterministic policy remains authoritative.
- The selected offer/result is a procurement decision, NOT a settlement transaction.

### §4.4 Privacy

Supplier-facing demand and selection outputs must preserve W025 minimization:

- no person identifiers from buyer commitments;
- no buyer-organization identifiers;
- no exact competitor commitment quantities, prices, budgets or delivery timing;
- no reconstructed competitor-level demand;
- no disclosure path created by offer comparison that defeats W025 floors.

Selection output may expose only the supplier/offer facts explicitly required by the W026 contract and must not expose unrelated buyer-sensitive information.

### §4.5 Economic boundary

No W026 command may mint value, create credits, cash obligations, rewards, balances, payment instructions or parallel economic records. Any eventual economic consequence must cross the `/settlement` authority through an explicitly scoped future/economic work item.

## §5 Material mutation pattern

Follow the established W003/W004/W020/W025 pattern:

`validation → server-resolved actor → tenant/pool reads → authorization/eligibility → composite idempotency → concurrency control → ONE authoritative transaction → WithinTx writes → transactional audit buffer → COMMIT → publish audit`

Same-key replays are exactly once. Concurrency must not permit conflicting duplicate durable records or nondeterministic selection state.

## §6 Derived selection

Selection is derived from CURRENT authoritative offer + pool state at ONE explicit evaluation anchor. The normal selection path must never trust stored/caller-asserted qualification or ranking results.

Where a material selection decision is persisted, the stored record is the authoritative selection lineage, while any ranking/eligibility details that are purely derivable remain derived and must be reproducible.

## §7 Acceptance criteria

### AC-01 — First-class offer records

Supplier offers are durable, tenant/pool-scoped, authorized, provenance-bearing and versioned; invalid provider-neutral vocabulary fails closed.

### AC-02 — Qualified-demand gating

Offers can only be evaluated against currently qualified NET-W025 demand. Unqualified, closed, withdrawn or otherwise invalid demand cannot enter competitive selection.

### AC-03 — Server-derived eligibility

Eligibility is completely server-derived and cannot be caller-asserted. Unauthorized suppliers and cross-tenant references fail closed without existence leakage.

### AC-04 — Deterministic competitive selection

Given identical authoritative state + anchor, ranking and selection are identical. Tie-breaking is explicit and stable. Selection lineage is auditable.

### AC-05 — Privacy / competition preservation

No selection or offer-comparison output leaks W025-protected buyer commitment identities or exact competitor commercial terms. Offer surfaces cannot reconstruct individual buyer demand.

### AC-06 — Idempotency / concurrency / atomicity

Offer creation and material selection mutations are exactly-once under replay, concurrency-safe, and atomically audited in one authoritative transaction.

### AC-07 — Economic-authority containment

No `/demand` code writes economic state or bypasses `/settlement`. Economic vocabulary and settlement mutations remain absent from W026 paths.

### AC-08 — Architecture / out-of-scope regression

Frozen architecture and architecture-lock are unchanged; no second procurement/domain authority; no W027 savings/counterfactual semantics; no W028 Benefit Pool semantics; no unauthorized workflow lifecycle machinery; architecture/authority guards remain clean.

## §8 Required evidence

- `spec/work-orders/NET-W026.md`
- `docs/net-w026-supplier-offers-competitive-selection.md`
- shared W026 harness built on W025 fixtures with multiple suppliers and qualified/unqualified pools;
- one-to-one AC suites `tests/demand/net-w026-ac-0N-*.test.ts` plus regression suite;
- privacy/tenant/authorization mutation checks;
- nondeterministic ranking mutation check;
- idempotency/concurrency mutation checks;
- economic-bypass regression;
- `bun run verify` plus configured real PostgreSQL/Redis integration tests;
- evidence ledger updated before PR review.

## §9 Explicit non-goals

No verified savings/counterfactuals (W027), no Benefit Pools (W028), no external payment execution, no decentralized consensus, no new economic primitives, no AI authority.

## §10 Merge gate

Exactly one canonical implementation PR for W026. Do not merge until implementation evidence, CI, architecture/authority checks, mutation checks and recorded architect approval are all green.
