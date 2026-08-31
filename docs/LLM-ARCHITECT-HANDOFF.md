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

NET-W001 through **NET-W023 are complete**.

Latest merge:
- NET-W023 issue #46
- PR #47
- merge SHA `c31ca29d45feeb59f652f0f9c2075465a00dbc85`

The current implementation target is **NET-W024 — Consumer Demand Pools**.

- GitHub issue: #48
- Status: READY_FOR_IMPLEMENTATION
- Prepared branch: `feat/net-w024-consumer-demand-pools`
- Requirements: DEM-001..003
- Dependencies: NET-W002 and NET-W008 — merged
- Decision record: `spec/work-orders/NET-W024.md`
- Evidence artifact: `docs/net-w024-consumer-demand-pools.md`

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
- `/demand` — demand aggregation authority (consumer demand pools)
- `/measurement` — measurement integration/neutral measurement boundary
- `/adapters` — provider-specific external integrations
- `/llm` — provider-neutral LLM boundary
- `/agents` — agent/orchestration mechanisms

The v1.0 architecture freezes sixteen domain boundaries. A new domain requires an explicit Architecture Change Request and a new architecture version.

## W024 acceptance shape

W024 must aggregate consumer demand without becoming an economic or procurement authority:

```text
consumer demand commitments (consented, tenant-scoped)
                         ↓
        /demand pools + versioned neutral category/attribute vocabulary
                         ↓
        deterministic privacy-preserving aggregation (frozen privacy floor)
                         ↓
        qualified aggregate demand view (derived, never stored)
                         ↓
              composition root only (neutral membership reads)
                         ↓
     existing identity/organizations/settlement authorities (zero economic mutation)
```

Supplier-facing output is minimized aggregate facts only. Individual commitments, per-person quantities and suppressed below-floor groups are never disclosed.

## W024 non-negotiables

1. `/demand` owns pool, commitment, category-vocabulary, aggregation and qualification-derivation semantics (the frozen sixteenth-domain home — no 17th domain).
2. `/settlement` remains the sole economic authority: demand commitments mint no value and create no settlement entries; `/demand` has ZERO economic mutation surface.
3. `/identity`, `/organizations`, `/participants` remain the identity/membership/authorization authorities; consent and membership are server-enforced, never client-asserted.
4. Aggregates are derived at evaluation time from authoritative records; caller-provided aggregates are never trusted and nothing aggregate is stored as truth.
5. Individual commitments are private; outputs are counts/ranges/bounded distributions emitted only above the frozen privacy floor; suppressed groups are counted, never named.
6. Qualification is deterministic and reproducible (explicit evaluation anchor + canonical digest).
7. Threshold policy is explicit and versioned; the privacy floor is a frozen constant no policy can lower; raw activity, spend, wealth or reputation cannot influence qualification.
8. Pool closure and commitment withdrawal are one-way field mutations (no local status machinery; `/workflows` untouched).
9. Cross-tenant references fail closed as not-found with no existence oracle.
10. Material mutations are idempotent, concurrency-safe on one authoritative transaction, with atomic audit lineage.
11. No procurement pools (W025), supplier offers/selection (W026), savings/counterfactuals (W027) or Benefit Pools (W028) semantics leak into W024.
12. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

## Required acceptance coverage

The implementation must include tests for:

- first-class, tenant-scoped, durable pool + commitment records with provenance and explicit consent;
- deterministic qualification derivation (anchor, digest, order independence, threshold boundaries);
- privacy-preserving aggregation (no person/commitment identifiers or exact per-person values in supplier views; privacy-floor suppression of aggregates and small groups; reconstruction resistance);
- consent and authorization enforcement (membership gate, owner-only withdrawal, no fabricated membership/qualification);
- threshold-policy explicitness/versioning and impossibility of caller-asserted aggregates or floor bypass;
- tenancy fail-closed with no existence oracle;
- idempotency, concurrency conservation and atomic audit lineage (rollback leaves no partial state);
- economic-bypass regressions (no settlement/ledger/reputation vocabulary or calls in `/demand`);
- mutation checks proving the privacy, consent and threshold invariants;
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
