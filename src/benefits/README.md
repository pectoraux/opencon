# `benefits` boundary

**Tier:** domain
**Authority:** benefit allocation
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), §5 (economic model), §19
**Work order:** `spec/work-orders/NET-W028.md` (Issue #56)
**Evidence ledger:** `docs/net-w028-benefit-pools.md`

## Scope in NET-W028 — Benefit Pools

This boundary ships the concrete Benefit Pool domain (NET-W028):

- **`port.ts`** — the full contract: the frozen NET-W028 vocabularies
  (benefit types, funding source kinds, eligibility criteria,
  remainder dispositions), the neutral read-only lookups
  (membership / value-record facts / savings re-derivation / reward
  policy facts / the economic draw port), the record contracts
  (versioned allocation policies, tenant-scoped pools, append-only
  allocation lineage, derived views, privacy-preserving member view)
  and the repository + service interfaces.
- **`allocation-engine.ts`** — the PURE deterministic plan derivation
  (scaled-integer proportional-weights floor split with EXPLICIT
  remainder handling; anchor-excluded digest).
- **`benefit-pool-service.ts`** — the service: policy versioning under
  the organization-independent lineage mutex, pool records, ONE-WAY
  closure, the DERIVED allocation view, and THE ATOMIC ALLOCATION
  OPERATION (in-tx funding + eligibility re-derivation, deterministic
  plan, conservation, the /settlement draw through the neutral port,
  the lineage record and the buffered audit — ONE authoritative
  transaction).
- **`authority-benefit-repositories.ts`** — the PostgreSQL-authority
  backed repositories (append-only key-value collections
  `benefit_pool_policies`, `benefit_pools`,
  `benefit_pool_allocations`).

## Authority model (frozen)

```text
verified authoritative upstream value / realized savings
        ↓ neutral references (never caller-asserted amounts)
/benefits — pool + versioned policy + deterministic allocation
        ↓ allocation lineage / execution request
/settlement — SOLE economic posting authority (the existing
  reward-allocation draw, executed WithinTx on the caller's
  authoritative transaction — no second ledger, no new balances,
  accounts, credits, cash, rewards or payment primitives)
```

`/settlement` remains the sole economic authority. Entitlement-only
allocations (savings-funded pools) post nothing and mint nothing.
`/workflows` remains the lifecycle authority (closure is a one-way
field mutation). AI output has no authority surface here.

## Dependencies

Core contracts only (tier matrix: domain → core/neutral/self). Every
cross-domain fact arrives read-only through the neutral structural
interfaces declared in `port.ts`, wired at the composition root
(`src/bootstrap/runtime.ts`) over the owning authorities'
repositories/services.
