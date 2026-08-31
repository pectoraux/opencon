# OpenCon LLM Architect Handoff

## Start here

For a new LLM architect with no conversation context, read in this order:

1. `AGENTS.md`
2. `spec/PROJECT-STATE.md`
3. `spec/ROADMAP.md`
4. `spec/architecture.md`
5. `spec/architecture-lock.md`
6. `spec/requirements.md`
7. `spec/work-items.md`
8. `spec/dependency-graph.md`
9. the active GitHub issue, work order, evidence package, and implementation PR

The repository, not prior conversation, is the source of truth.

## Current checkpoint

NET-W001 through **NET-W024 are complete**.

Latest merge:
- NET-W024 issue #48
- PR #49
- merge SHA `cdfe12b8d5d56e3158505bbc77878e9b9e3561f7`

The current implementation target is **NET-W025 — Business procurement pools**.

- GitHub issue: #50
- Status: READY_FOR_IMPLEMENTATION
- Prepared branch: `feat/net-w025-business-procurement-pools`
- Requirements: DEM-001..003, PROC-001..003
- Dependencies: NET-W024 and NET-W008 — merged
- Decision record: `spec/work-orders/NET-W025.md`
- Evidence artifact: `docs/net-w025-business-procurement-pools.md`

## Frozen authority map

- `/workflows` — lifecycle authority
- `/evidence` — evidence/proof authority
- `/outcomes` — normalized measurement authority
- `/reputation` — reputation authority
- `/settlement` — economic/ledger authority
- `/disputes` — risk/dispute authority
- `/campaigns` — campaign policy authority
- `/creators` — creator semantics and creator-facing records
- `/inventory` — inventory and placement authority
- `/demand` — demand aggregation authority (consumer demand pools; business procurement pools — NET-W025)
- `/measurement` — measurement integration/neutral measurement boundary
- `/adapters` — provider-specific external integrations
- `/llm` — provider-neutral LLM boundary
- `/agents` — agent/orchestration mechanisms

The v1.0 architecture freezes sixteen domain boundaries. A new domain requires an explicit Architecture Change Request and a new architecture version.

## W025 acceptance shape

W025 extends the W024 privacy model into competitively sensitive business procurement demand WITHOUT becoming a second demand, procurement or economic authority:

```text
business demand (tenant-scoped, buyer-organization-authorized, consented)
                         ↓
   /demand procurement pools + versioned neutral category/attribute vocabulary
   (the SAME frozen boundary — extended, not duplicated)
                         ↓
   privacy / competition policy: deterministic derivation behind the frozen
   commitment floor AND the frozen distinct-organization floor;
   bands/buckets/windows only — never exact quantities, unit prices,
   budgets or timing
                         ↓
   deterministic qualified aggregate (derived, never stored, never caller-asserted)
                         ↓
   supplier-facing minimized demand view
                         ↓
   composition root only (neutral membership reads) / zero economic mutation
```

Supplier-facing output is minimized aggregate facts only. Individual business commitments, buyer organizations, and competitor-specific commercial terms are never disclosed; below-floor groups are counted, never named.

## W025 non-negotiables

1. `/demand` remains THE demand/procurement-aggregation authority: W025 implements business procurement pools INSIDE the W024 boundary — no 17th domain, no second demand or procurement ledger (an Architecture Change Request would be required for either).
2. `/settlement` remains the sole economic authority: procurement commitments mint no value, create no settlement entries, no balances; `/demand` keeps ZERO economic mutation surface.
3. `/identity`, `/organizations`, `/participants` remain the identity/membership/authorization authorities: the acting person must hold ACTIVE membership in BOTH the tenant and the named buyer organization, server-resolved through neutral reads — never client-asserted.
4. Aggregates are derived at evaluation time from authoritative records; caller-provided aggregates/counts/qualifications are never trusted and nothing aggregate is stored as truth.
5. Individual business commitments are private AND competitively sensitive: outputs are counts/bounded distributions emitted only above the frozen commitment floor AND the frozen distinct-organization floor; suppressed groups are counted, never named; exact competitor quantities, prices, budgets and timing never appear in normal outputs (PROC-003).
6. Qualification is deterministic and reproducible (explicit evaluation anchor + canonical digest, anchor excluded).
7. Threshold/competition policy is explicit and versioned on the pool record; the floors are frozen constants no policy can lower; raw activity, spend, wealth or reputation cannot influence qualification.
8. Procurement-pool closure and commitment withdrawal are one-way field mutations (no local status machinery; `/workflows` untouched).
9. Cross-tenant references fail closed as not-found with no existence oracle; buyer-organization authorization failures are indistinguishable from nonexistent organizations.
10. Material mutations are idempotent, concurrency-safe on one authoritative transaction, with atomic audit lineage.
11. No supplier offers/competitive selection (W026), verified savings/counterfactuals (W027) or Benefit Pools (W028) semantics leak into W025.
12. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

## Required acceptance coverage

The implementation must include tests for:

- first-class, tenant-scoped, durable procurement-pool + business-commitment records with provenance, buyer-organization references and explicit server-written consent;
- deterministic qualification derivation (anchor, digest, order independence, threshold boundaries on BOTH the commitment and distinct-organization thresholds);
- privacy/competition-preserving aggregation (no person/commitment/buyer-organization identifiers or exact per-organization quantities, unit prices, budgets or timing in supplier views; commitment-floor AND organization-floor suppression of aggregates and small groups; reconstruction resistance);
- buyer-organization and tenant authorization enforcement (dual membership gate, owner-only withdrawal, no fabricated eligibility/qualification);
- threshold-policy explicitness/versioning and impossibility of caller-asserted aggregates or floor bypass;
- tenancy fail-closed with no existence oracle;
- idempotency, concurrency conservation and atomic audit lineage (rollback leaves no partial state);
- economic-bypass regressions (no settlement/ledger/reputation vocabulary or calls in `/demand`);
- mutation checks proving the privacy/minimization, authorization and threshold/disclosure invariants;
- frozen architecture and architecture-lock remain unchanged.

## Merge protocol

```text
implementation
→ verification + evidence
→ exactly one PR
→ architect review
→ changes requested: remediate same PR
→ approved + CI green: merge
```

Never merge solely because CI is green.

## Required persistence after every work item

After merge, update `spec/PROJECT-STATE.md` with the merged PR/SHA, next work item, architectural lessons, verification baseline, and active issue/work-order/evidence links. Update `spec/ROADMAP.md` when roadmap interpretation or sequencing changes. Keep `spec/work-items.md` as the original backlog unless the project explicitly versions it.
