# `demand` boundary

**Tier:** domain
**Authority:** demand aggregation
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), §9 (Demand architecture)
**Concrete behaviour:** NET-W024 — consumer demand pools

## Scope

`/demand` owns the consumer demand-pool domain (NET-W024; requirements DEM-001..003):

- **Pools** — first-class, tenant-scoped, durable records with an explicit, versioned qualification policy and one-way closure. The acting person at creation is the creator (no creator input exists).
- **Commitments** — first-class, tenant-scoped, durable, PRIVATE consumer records with bounded provider-neutral attributes (closed region/quantity/budget-band vocabularies in `src/core/demand.ts`), a server-written aggregate-disclosure consent grant, and one-way withdrawal. The acting person at submission is the consumer (no consumer input exists). One active commitment per (pool, consumer).
- **The derived qualified aggregate** — the privacy-preserving supplier-facing view (`aggregation-engine.ts`): re-derived from CURRENT durable records on every evaluation at ONE explicit anchor; deterministic digest over the decision facts; aggregate facts (including the count) emitted only above the frozen privacy floor; below-floor distribution groups suppressed (counted, never named). Never stored, never caller-asserted.

## Authority separation

- `/settlement` remains the sole economic authority: NO ledger entries, credits, cash, stakes or rewards are created here — commitments mint nothing (supplier competition on the aggregate is NET-W025/W026).
- `/identity`, `/organizations`, `/participants` remain the membership/authorization authorities: membership resolves read-only through the neutral `DemandMembershipLookup` (wired at the bootstrap root over the organizations membership repository); consent and membership are server-enforced, never client-asserted.
- `/workflows` is untouched: closure and withdrawal are one-way field mutations, not status machines.
- No coupling to `/evidence`, `/outcomes`, `/reputation`, `/disputes`, `/campaigns`, `/inventory` or `/adapters` — qualification cannot be influenced by activity, spend, wealth or reputation.

## Conventions

Material mutations follow the NET-W003/004/008/019/020 conventions: composite idempotency keys, per-pool advisory locking, ONE authoritative transaction, `...WithinTx` repository twins, transactional audit buffers (`demand_pool.created` / `demand_pool.closed` / `demand_commitment.recorded` / `demand_commitment.withdrawn`). The derived evaluation mutates and audits nothing.

## Files

- `port.ts` — the declared public interface (records, inputs, derived view, lookups, repositories, service).
- `module.ts` — boundary registration.
- `authority-demand-repositories.ts` — PostgresAuthority-backed append-only repositories (`demand_pools`, `demand_commitments`).
- `aggregation-engine.ts` — the pure deterministic privacy-preserving derivation + canonical digest.
- `demand-service.ts` — the domain service (commands + derived evaluation).
