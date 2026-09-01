# `demand` boundary

**Tier:** domain
**Authority:** demand aggregation
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), §9 (Demand architecture)
**Concrete behaviour:** NET-W024 — consumer demand pools; NET-W025 — business procurement pools

## Scope

`/demand` owns the consumer demand-pool domain (NET-W024; requirements DEM-001..003) AND the business procurement-pool domain (NET-W025; requirements DEM-001..003 + PROC-001..003 bounded to demand/qualification/supplier-discovery) — the SAME frozen boundary, NOT a second demand or procurement authority:

- **Pools** — first-class, tenant-scoped, durable records with an explicit, versioned qualification policy and one-way closure. The acting person at creation is the creator (no creator input exists). Procurement pools add the distinct-organization threshold (the competition-policy dimension of the qualification policy).
- **Commitments** — first-class, tenant-scoped, durable, PRIVATE records with bounded provider-neutral attributes (closed region/quantity/budget-band vocabularies in `src/core/demand.ts`; procurement categories, business-scale budget bands, unit-price bands and delivery-timing windows in `src/core/procurement.ts`), a server-written aggregate-disclosure consent grant, and one-way withdrawal. The acting person at submission is the consumer/submitter (no consumer or submittedBy input exists). One active commitment per (pool, consumer) — and per (pool, buyer organization) for procurement, where the acting person must additionally hold ACTIVE membership in the named buyer organization (server-enforced, indistinguishable from a nonexistent organization).
- **The derived qualified aggregate** — the privacy/competition-preserving supplier-facing view (`aggregation-engine.ts` / `procurement-aggregation-engine.ts`): re-derived from CURRENT durable records on every evaluation at ONE explicit anchor; deterministic digest over the decision facts; aggregate facts (including the counts) emitted only above the frozen privacy floor (W024) — or above the frozen commitment floor AND the frozen distinct-organization floor (W025, PROC-003); below-floor distribution groups suppressed (counted, never named). Never stored, never caller-asserted. Exact quantities, unit prices, budgets and timing never cross — only bands/buckets/windows.

## Authority separation

- `/settlement` remains the sole economic authority: NO ledger entries, credits, cash, stakes or rewards are created here — commitments mint nothing (supplier competition on the aggregate is W025/W026: offers and selection are NET-W026, savings are NET-W027).
- `/identity`, `/organizations`, `/participants` remain the membership/authorization authorities: membership resolves read-only through the neutral `DemandMembershipLookup` (wired at the bootstrap root over the organizations membership repository); consent and membership are server-enforced, never client-asserted.
- `/workflows` is untouched: closure and withdrawal are one-way field mutations, not status machines.
- No coupling to `/evidence`, `/outcomes`, `/reputation`, `/disputes`, `/campaigns`, `/inventory` or `/adapters` — qualification cannot be influenced by activity, spend, wealth or reputation.

## Conventions

Material mutations follow the NET-W003/004/008/019/020 conventions: composite idempotency keys, per-pool advisory locking, ONE authoritative transaction, `...WithinTx` repository twins, transactional audit buffers (`demand_pool.created` / `demand_pool.closed` / `demand_commitment.recorded` / `demand_commitment.withdrawn` / `procurement_pool.created` / `procurement_pool.closed` / `procurement_commitment.recorded` / `procurement_commitment.withdrawn`). The derived evaluations mutate and audit nothing.

## Files

- `port.ts` — the declared public interface (records, inputs, derived views, lookups, repositories, services).
- `module.ts` — boundary registration.
- `authority-demand-repositories.ts` — PostgresAuthority-backed append-only repositories (`demand_pools`, `demand_commitments`).
- `aggregation-engine.ts` — the pure deterministic privacy-preserving derivation + canonical digest (W024).
- `demand-service.ts` — the consumer demand domain service (commands + derived evaluation).
- `authority-procurement-repositories.ts` — PostgresAuthority-backed append-only repositories (`procurement_pools`, `procurement_commitments`) (W025).
- `procurement-aggregation-engine.ts` — the pure deterministic privacy/competition-preserving derivation with the dual frozen floors (W025).
- `procurement-pool-service.ts` — the business procurement domain service (commands + derived evaluation) (W025).
