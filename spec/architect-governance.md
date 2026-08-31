# OpenCon Architect Governance

This file records the review and merge rules that govern implementation independently of any chat conversation.

## Authority

The architect is the acceptance authority for architecture, invariants, authority separation, evidence, and merge decisions. Implementation agents do not self-authorize architectural changes.

## Frozen architecture

`spec/architecture.md` and `spec/architecture-lock.md` define v1.0. They are frozen. A requirement that cannot fit inside the existing architecture requires an Architecture Change Request rather than silent drift.

## One authority per concern

Do not duplicate authority. Reuse these canonical owners:

- lifecycle → `/workflows`
- evidence → `/evidence`
- outcomes/measurement → `/outcomes`
- reputation → `/reputation`
- economics/ledger/settlement → `/settlement`
- risk/disputes → `/disputes`
- campaign policy → `/campaigns`
- creator domain semantics → `/creators`
- inventory/placements → `/inventory`
- provider execution → `/adapters`
- neutral LLM interface → `/llm`

Composition-root functions may orchestrate authorities but must not create hidden second authorities.

## Review checklist

For every work item, inspect:

1. authority placement;
2. tenant and authorization boundaries;
3. policy lineage and concurrency serialization;
4. deterministic/idempotent mutation semantics;
5. transaction atomicity and rollback/recovery;
6. audit/trace lineage and post-commit publication ordering;
7. provider/secret isolation;
8. privacy boundaries and no-existence-oracle behavior where relevant;
9. AI advisory-only behavior where relevant;
10. static architecture and authority checks;
11. negative/positive fixtures for the most important guardrails;
12. evidence mapped to every acceptance criterion;
13. frozen-spec integrity.

## Known correctness patterns

### Policy lineage

If a policy id is globally unique, the serialization key must not include organization scope. The authoritative transaction must re-read lineage, verify scope, then verify version. Cross-org version-1 forks are forbidden.

### Tenant reads

Tenant-scoped ID reads should require organization context through the complete stack. Cross-tenant records normally resolve as not-found rather than leaking existence.

### Gated lifecycle transitions

When a lifecycle edge has semantics owned by another boundary, do not expose that edge through the generic workflow resolver. Use a sanctioned transition path owned by the domain that owns the gate.

### Transaction ordering

Audit publication is post-commit. For coupled material mutations, prefer a single authoritative transaction and `...WithinTx` primitives. Do not chain independently committing economic operations inside a larger economic operation.

### AI

Hard constraints precede model optimization. Model outputs are advisory evidence, not authorization. Prohibited inputs must be excluded structurally, not merely by prompt convention.

### Provider integration

Provider-specific SDKs/types live in `/adapters`. Provider-neutral contracts live in `/core` or the owning domain port as appropriate.

### Secrets

Production/staging secrets resolve through `SecretProvider`; missing required configuration fails closed. Development/test doubles are never an implicit production fallback.

## Remediation policy

When changes are requested:

- remediate on the same branch and PR;
- add tests that fail under the old behavior;
- mutation-check high-risk regressions where practical;
- update work order/evidence/worklog;
- rerun the full verification gate;
- obtain architect re-review before merge.

Never create a second implementation PR merely to resolve review comments.

## Merge gate

A work item is accepted only when:

```text
Implementation complete
+ Evidence complete
+ Verification/CI green
+ Architect approval
→ Merge
```

GitHub self-review limitations do not weaken this rule; record the architect decision in repository/PR state when a formal review action cannot be submitted by the PR author.

## Continuity rule

Every merge must update `spec/PROJECT-STATE.md`. This is mandatory because conversation history may be lost. The next agent must be able to derive the next action from repository files plus GitHub state alone.
