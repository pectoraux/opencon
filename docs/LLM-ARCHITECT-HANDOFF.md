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

NET-W001 through NET-W020 are complete. NET-W020 merged as `3f1f6aaddfb1ceb0b28b5570b2d902bd06e84c48`.

The next implementation target is **NET-W021 — Campaign matching and optimization**.

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
- `/adapters` — provider-specific integrations
- `/llm` — provider-neutral LLM boundary
- `/agents` — agent/orchestration mechanisms

The v1.0 architecture freezes sixteen domain boundaries. A new domain requires an explicit Architecture Change Request and a new architecture version.

## W021 acceptance shape

W021 must remain an optimization/matching layer, not an authority:

```text
campaign policy + inventory + creator data + measured performance
                         ↓
                 hard eligibility
                         ↓
                  eligible set
                         ↓
            evidence-backed features
                         ↓
             deterministic ranking
                         ↓
          bounded AI advisory ranking
```

Hard policy, rights, tenancy, risk, and settlement constraints always win. AI cannot authorize a candidate that failed eligibility and cannot mutate another authority directly.

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

Update `spec/PROJECT-STATE.md` with the merged PR/SHA, next work item, architectural lessons, and verification baseline. Update `spec/ROADMAP.md` only when roadmap interpretation or sequencing changes. Keep `spec/work-items.md` as the original canonical backlog unless the project explicitly versions it.
