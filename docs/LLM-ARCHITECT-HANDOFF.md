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

NET-W001 through **NET-W027 are complete**.

Latest merge:
- NET-W027 issue #54
- PR #55
- merge SHA `d78a9b8bbb8e4319e73e75e1ca4bc8229b2ed300`

The current implementation target is **NET-W028 — Benefit Pools**.

- GitHub issue: #56
- Status: READY_FOR_IMPLEMENTATION
- Prepared branch: `feat/net-w028-benefit-pools`
- Requirements: BEN-001..004
- Dependencies: NET-W027 and NET-W008 — merged/verified
- Decision record: `spec/work-orders/NET-W028.md`
- Evidence artifact: `docs/net-w028-benefit-pools.md`

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
- `/demand` — demand/procurement/supplier-selection/savings semantics
- `/benefits` — Benefit Pool semantics (W028; existing frozen boundary)
- `/measurement` — measurement integration/neutral measurement boundary
- `/adapters` — provider-specific external integrations
- `/llm` — provider-neutral LLM boundary
- `/agents` — agent/orchestration mechanisms

The v1.0 architecture freezes sixteen domain boundaries. A new domain requires an explicit Architecture Change Request and a new architecture version.

## W027 completed shape

W027 extends `/demand` with evidence-backed procurement baselines, counterfactual representations and realized-savings derivation while preserving `/outcomes` and `/evidence` as truth authorities and `/settlement` as the sole economic authority.

Key safeguards retained for W028:
- explicit baseline and supported observed/counterfactual inputs;
- uncertainty is first-class and unsupported exact claims fail closed;
- deterministic anchor-aware derivation with anchor-excluded canonical digest;
- stale/invalid/insufficient evidence cannot authorize an economic effect;
- W028 was explicitly excluded from W027 and must now consume, not recreate, verified savings semantics.

## W028 acceptance shape

```text
verified authoritative upstream value / realized savings
                    ↓ neutral references
             /benefits Benefit Pool
                    ↓
       deterministic member eligibility
                    ↓
          versioned allocation policy
                    ↓
       conserved allocation plan/lineage
                    ↓
       /settlement economic mutation
```

## W028 non-negotiables

1. Stay inside the existing `/benefits` frozen boundary; do not create a 17th domain.
2. `/settlement` remains the sole economic authority. No second ledger, balance, credits, cash, reward, or payment authority.
3. Pool funding resolves server-side to authoritative existing value/results. Caller-supplied funding amounts are not authority.
4. Allocation cannot exceed authoritative available funding; arithmetic uses deterministic/scaled representations where needed and explicitly conserves remainders.
5. Allocation policy is explicit, versioned and immutable once referenced; cross-tenant policy lineage cannot fork.
6. Member eligibility and weights derive from authoritative participant inputs and policy; caller assertions are never trusted.
7. Current funding availability, eligibility and allocation capacity are re-derived inside the authoritative transaction before any material economic effect.
8. Pool/member views preserve privacy and do not disclose protected procurement commitments or unnecessary participant identity.
9. Cross-tenant and unauthorized operations fail closed without existence oracles.
10. Material coupled mutations use composite idempotency, concurrency serialization, one authoritative transaction, transactional audit buffering and post-commit publication; use settlement `...WithinTx` primitives for coupled economic operations.
11. AI/model output, if used, is advisory only and cannot authorize funding, eligibility, privacy release, allocation or economics.
12. `/workflows` remains lifecycle authority; no local workflow engine.
13. W029+ decentralization and W033+ end-to-end flows remain excluded.
14. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

## Required acceptance coverage

The implementation must include tests for:

- first-class tenant-scoped Benefit Pool and funding-reference records;
- authoritative funding resolution and caller-amount rejection;
- deterministic versioned allocation policy and policy-lineage serialization;
- member eligibility and weight derivation;
- conservation, no-overallocation, deterministic rounding and explicit remainder handling;
- current-state re-derivation and stale-state refusal;
- privacy-preserving pool/member views;
- tenancy and authorization fail-closed semantics;
- idempotency, concurrency and composite atomicity with commit-failure injection;
- settlement-only economic mutation and no parallel ledger/economic authority;
- targeted mutation checks for funding, conservation, privacy, tenancy, determinism and settlement bypass;
- `bun run verify`, architecture/authority checks, secret scan and configured PostgreSQL/Redis integration;
- frozen architecture and architecture-lock unchanged.

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
