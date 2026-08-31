# OpenCon Project State

**Purpose:** machine-readable/human-readable resume point for a new LLM architect or implementation agent.

**Architecture:** v1.0 FROZEN
**Requirements baseline:** v1.0 APPROVED
**Canonical roadmap:** `spec/ROADMAP.md`
**Canonical backlog:** `spec/work-items.md`
**Canonical architecture:** `spec/architecture.md`
**Canonical lock:** `spec/architecture-lock.md`
**Canonical dependency graph:** `spec/dependency-graph.md`
**Agent entry point:** `AGENTS.md`

## Current checkpoint

### Last merged work item

**NET-W020 — Cross-promotion clearing**

- PR: #40
- Merge SHA: `3f1f6aaddfb1ceb0b28b5570b2d902bd06e84c48`
- Status: MERGED
- Authority: `/settlement`
- Important review lesson: coupled economic draw + clearing record + campaign bookkeeping + audit must share one authoritative transaction. The implementation was remediated to use `...WithinTx` primitives and a single composite transaction.

### Previous completed milestones

NET-W001 through NET-W020 are complete and merged. They established the protocol foundation, identity, persistence, evidence, measurement, reputation, economic ledger, risk/disputes, campaigns, helpful contributions, creator network, inventory/placements, and cross-promotion clearing.

Known merge checkpoints that are particularly important for design lineage:

- NET-W003: real PostgreSQL/Redis adapters and composition-root provider selection
- NET-W004: workflow authority and lifecycle machinery
- NET-W005: evidence/attestation boundary and fail-closed production signing
- NET-W006: normalized outcome/measurement authority
- NET-W007: deterministic reputation with org-independent policy-lineage serialization
- NET-W008: economic ledger and credit/cash primitives
- NET-W009/010: risk/dispute authority and stake/challenge controls
- NET-W014: contribution settlement/reputation integration
- NET-W017: UGC lifecycle/rights with single-transaction coupled commands and recoverable batch journal
- NET-W018: publication verification moved to a sanctioned workflow transition so generic workflow callers cannot bypass disclosure
- NET-W019: inventory/placement settlement-readiness derivation
- NET-W020: cross-promotion clearing with one authoritative economic transaction

## Next implementation target

**NET-W021 — Campaign matching and optimization**

Canonical backlog: `spec/work-items.md` → Phase 6 → NET-W021.

Expected GitHub tracking issue: use the canonical NET-W021 issue if it exists; otherwise create it from the frozen backlog and mark it `READY_FOR_IMPLEMENTATION` only after dependency/readiness checks pass.

Dependencies: NET-W006, NET-W007, NET-W009, NET-W019.
Requirements: CAMP-001..003, AI-002..003.
Definition of done: matching honors hard constraints first, then ranks eligible options using evidence-backed performance.

## W021 architecture checklist

Before implementation, verify these facts from the repository rather than relying on chat:

1. `/campaigns` owns campaign policy/configuration.
2. `/inventory` owns supply and placement semantics.
3. `/creators` owns creator profiles and matching attributes.
4. `/reputation` owns reputation state.
5. `/outcomes` + `/evidence` own normalized measurement/truth.
6. `/disputes` owns risk/control decisions.
7. `/workflows` owns lifecycle state.
8. `/settlement` owns economic state and mutations.
9. `/llm` is provider-neutral; concrete providers stay behind `/adapters`.
10. Matching/optimization may orchestrate these authorities but must not become a second authority for any of them.
11. Hard eligibility precedes optimization.
12. AI can advise ranking only after eligibility and cannot override policy, rights, tenancy, risk, or settlement-readiness.
13. Material mutation requires established idempotency, transaction, audit, and trace conventions.
14. A cross-authority composite with coupled material state must use one authoritative transaction or an explicitly approved recoverable saga.
15. No seventeenth domain without an Architecture Change Request.

## Review lessons that must persist

### Authority drift

Generic identifier matching is not sufficient for architecture policing. The authority guard was corrected to use behavioral detection and positive/negative fixtures. Never weaken that guard simply to make an existing source tree pass; update the rule and fixtures together when architecture evolves.

### Tenant isolation

For ID-based reads, require organization scope through service → port → runtime → HTTP where the entity is tenant-scoped. Cross-tenant IDs should normally resolve as not-found to avoid existence oracles.

### Policy lineage

When a policy lineage is single-tenant, serialization must be organization-independent (`{policyId}`) and the authoritative transaction must re-check scope and version. An org-scoped idempotency key alone is not sufficient.

### Publication/disclosure

If a lifecycle edge has a semantic gate owned by another boundary, keep the edge out of the generic workflow resolver and expose it through a sanctioned transition path. Generic workflow authorization must not accidentally bypass the gate.

### Economic atomicity

Do not chain independently committing economic services inside a larger clearing operation. Use their `...WithinTx` variants or an equivalent single settlement-authority transaction boundary. Campaign/economic bookkeeping coupled to the draw belongs in the same transaction when the operation's correctness depends on all-or-nothing behavior.

### Audit ordering

Audit publication occurs only after durable transaction commit. The audit buffer is registered with `afterCommit`/`afterRollback` hooks and must never flush/publish before the authoritative commit succeeds.

### AI boundaries

AI/model outputs remain advisory. Domain semantics must be able to evaluate hard eligibility without an AI result. Never feed prohibited user/activity fields into an advisory provider simply because they are available upstream.

### Secrets

Production/staging provider configuration and cryptographic signing material must resolve through `SecretProvider` and fail closed when missing. Development/test doubles must never be an implicit production fallback.

## Quality gate

Canonical local gate:

```bash
bun run verify
```

Expected components include:

- TypeScript typecheck
- `arch:check`
- `authority:check`
- full test suite

When external services are required, run the real PostgreSQL/Redis integration tests as specified by the repository CI/local instructions.

## GitHub workflow state machine

For every work item:

```text
READY_FOR_IMPLEMENTATION
        ↓
implementation branch
        ↓
verification/evidence
        ↓
exactly one implementation PR
        ↓
architect review
   ┌────┴────┐
   ↓         ↓
CHANGES     APPROVED
REQUESTED      ↓
   ↓         merge
same PR        ↓
   └──→ re-review
```

Never merge merely because CI is green. Never create a second implementation PR when remediation is requested.

## Required project-state update after each merge

The next architect/agent must update this document immediately after a merge with:

- merged PR and SHA;
- next work item/issue/readiness;
- any new authority or transaction-boundary lessons;
- verification baseline;
- links to the new work order/evidence/PR.

## Current verification baseline

The latest completed implementation checkpoint before this documentation branch is NET-W020. Its final remediation verification was green with `bun run verify`, and the PR's GitHub checks were green before merge. The exact current test-count baseline for future work should be taken from the freshly synced `main`, not from this document, because tests may evolve through independent documentation/maintenance changes.

## Current action

Sync to `origin/main`, confirm NET-W020 merge and repository cleanliness, then resolve NET-W021's GitHub issue/readiness state. Read the W021 work item from the frozen backlog, create its work order, implement only within existing authorities, run the complete quality gate, create one PR, and wait for architect review.
