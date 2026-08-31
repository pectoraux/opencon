# OpenCon Agent Handoff

This file is the entry point for any LLM architect, implementation agent, reviewer, or automation agent joining the repository without prior conversation context.

## Non-negotiable rule

**The repository is the source of truth. The chat is not.**

A new agent MUST be able to continue the project from repository state alone. Do not rely on conversation memory, summaries supplied by a previous agent, or undocumented assumptions.

Before changing code:

1. Read this file.
2. Read `spec/PROJECT-STATE.md`.
3. Read `spec/ROADMAP.md`.
4. Read `spec/architecture.md` and `spec/architecture-lock.md` before proposing architectural changes.
5. Read `spec/requirements.md`, `spec/work-items.md`, and `spec/dependency-graph.md` for the active work item.
6. Inspect the relevant existing implementation, tests, evidence, and work order before writing code.
7. Inspect GitHub issue/PR state for the active work item; never assume a PR is absent because the chat says so.

## Roles

### Architect / reviewer

The architect is the authority for architecture, acceptance, invariants, authority separation, and merge decisions.

The architect MUST:

- enforce the frozen architecture and lock;
- reject architectural drift even when implementation tests pass;
- verify acceptance criteria against code and evidence, not prose alone;
- require fault-injection, concurrency, tenancy, privacy, and mutation-check evidence where applicable;
- ensure each authority has one owner;
- require remediation on the same implementation PR when changes are requested;
- merge only after implementation, verification, and architect approval gates are all satisfied.

GitHub may reject self-approval when the architect and PR author are the same account. In that case, record the architect decision in the PR discussion/worklog and enforce the same merge gate manually.

### Z.ai / implementation agent

The implementation agent implements an already-approved work order. It is not the architecture authority.

The implementation agent MUST:

- work from the canonical work item/work order;
- preserve frozen architecture files unless an explicit Architecture Change Request exists;
- use the existing authority and transaction primitives before introducing new ones;
- add reproducible tests and evidence for each acceptance criterion;
- remediate on the same branch/PR when changes are requested;
- never create a second implementation PR for the same work item;
- never silently weaken a regression test or static guard to make CI pass.

## Canonical development loop

```text
Frozen architecture
  -> requirements
  -> work item
  -> work order / decision record
  -> implementation branch
  -> verification + evidence
  -> canonical implementation PR
  -> architect review
     -> CHANGES REQUESTED -> remediate same PR -> re-verify
     -> APPROVED -> merge
  -> update project state
  -> advance to next READY_FOR_IMPLEMENTATION work item
```

## Merge gate

A work item is mergeable only when all three are true:

```text
implementation complete
+ verification/CI green
+ architect approval
= merge
```

Do not merge on green CI alone.

## Remediation discipline

When an architect finds a defect:

- preserve the existing PR and branch;
- state the root cause in the work order/evidence;
- implement the fix at the authoritative boundary;
- add a regression that fails on the old behavior;
- where practical, run a mutation check that reintroduces the defect and proves the regression catches it;
- rerun the full verification gate;
- update the evidence and worklog;
- request re-review.

## Architecture-drift policing

OpenCon uses static architecture checks and an authority-boundary check. Keep both effective.

Important principles:

- No new domain boundary may be invented casually. The sixteen v1.0 domains are frozen by `spec/architecture-lock.md`.
- `/workflows` is the lifecycle authority.
- `/settlement` is the economic/ledger authority.
- `/evidence` is the evidence/truth authority.
- `/outcomes` is the normalized measurement authority.
- `/reputation` is the reputation authority.
- `/disputes` is the trust/risk/dispute authority.
- `/campaigns` owns campaign policy/configuration.
- `/creators` owns creator semantics and creator-facing records.
- `/inventory` owns supply/inventory and placement semantics.
- `/adapters` owns provider-specific integration details.
- Composition-root orchestration is allowed, but it must not silently become a second domain authority.

When a new requirement appears to require a new domain, first identify the frozen boundary that already owns the responsibility. If none exists, stop and treat it as an Architecture Change Request rather than adding a seventeenth domain.

## Evidence standard

Tests are evidence, not the only evidence. For material operations, the implementation should make it possible to prove:

- authorization and tenancy boundaries;
- idempotency and concurrency behavior;
- transaction atomicity and rollback/recovery;
- audit/trace lineage;
- privacy and secret isolation;
- provider neutrality;
- authority separation;
- deterministic behavior where the protocol requires reproducibility.

Prefer in-transaction re-derivation over trusting preflight reads, and prefer a single authoritative transaction for coupled material mutations. Use `...WithinTx` twins when an existing transaction-owning service must participate in a larger atomic operation.

## Current roadmap entry point

The canonical roadmap is `spec/ROADMAP.md`.

The current project state, including the active work item, merge baseline, and recent architecture decisions, is `spec/PROJECT-STATE.md`.

The original backlog remains `spec/work-items.md`; do not rewrite its frozen historical content merely to track current status. `spec/ROADMAP.md` provides the durable project-status interpretation of that backlog.

## Required handoff after every work item

After merge, update `spec/PROJECT-STATE.md` with:

- merged work item and merge SHA;
- next work item and issue number/state;
- relevant architectural decisions/guardrails learned from review;
- current verification baseline;
- any known outstanding non-blocking issues;
- links to the active PR/issue/evidence/work order.

This makes the project resumable even if every chat transcript disappears.
