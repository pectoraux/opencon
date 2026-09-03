# Open Contribution Protocol

Open Contribution Protocol (OpenCon) is an open protocol for coordinating advertising, creator partnerships, helpful contributions, collective demand, procurement, and member benefits.

## Development status

**Architecture:** v1.0 FROZEN  
**Requirements:** v1.0 APPROVED BASELINE  
**Implementation:** NET-W001 through NET-W036 complete and merged  
**Post-backlog product work:** UX-01 complete  
**Current program:** `UC-01` — Consumer demand to member benefit validation  
**Implementation status:** UC-01 governance frozen; implementation begins only after governance merge

### Resume the project without conversation history

The repository is self-describing. Start here:

1. `AGENTS.md` — durable instructions for LLM architects/reviewers and implementation agents.
2. `spec/PROJECT-STATE.md` — current merged checkpoint, authorized use case, architectural lessons, and resume procedure.
3. `spec/ROADMAP.md` — durable roadmap and post-backlog use-case validation state.
4. `spec/USE-CASE-PROGRAM.md` — governance method for selecting and validating realistic end-to-end use cases.
5. `spec/work-items.md` — original canonical backlog; it terminates at NET-W036 and remains historical.
6. `spec/dependency-graph.md` — dependency/readiness rules.
7. `spec/architecture.md` + `spec/architecture-lock.md` — frozen architecture and non-negotiable invariants.
8. `spec/work-orders/UC-01.md` — frozen first post-backlog use-case work order.
9. `docs/uc-01-consumer-demand-benefit.md` — UC-01 evidence contract.

**The chat is not a source of truth.** A new LLM must be able to continue the project from repository state alone.

## Development model

Architecture-first, evidence-driven implementation following the WorkflowOS development method:

```text
Architecture
→ Requirements
→ Acceptance Criteria
→ Work Items
→ Work Orders
→ Z.ai Implementation
→ Verification
→ Architect Review
→ Merge
→ Verified
```

Z.ai is an implementation participant, not the authority for architecture, workflow state, verification semantics, or settlement truth.

## Initial specification

- `spec/architecture.md` — approved v1.0 architectural design
- `spec/architecture-lock.md` — frozen architectural invariants
- `spec/requirements.md` — v1.0 requirements and acceptance criteria
- `spec/work-items.md` — historical implementation backlog through NET-W036
- `spec/dependency-graph.md` — implementation dependencies and eligibility rules
- `spec/ROADMAP.md` — durable roadmap and current use-case state
- `spec/PROJECT-STATE.md` — durable project checkpoint
- `spec/USE-CASE-PROGRAM.md` — post-backlog use-case governance
- `spec/work-orders/UC-01.md` — current frozen use-case work order
- `docs/uc-01-consumer-demand-benefit.md` — current evidence contract
- `AGENTS.md` — durable LLM architect/implementation handoff

## Post-backlog validation program

The canonical protocol backlog ends at NET-W036 and UX-01 is complete. Future work is selected as realistic end-to-end use-case validation rather than speculative feature accumulation. A use case is a capability-composition instrument, not permission to invent missing subsystems.

UC-01 validates:

```text
consumer demand
→ privacy-preserving qualification
→ supplier competition
→ sanctioned fulfillment
→ provider measurement
→ normalized outcome
→ evidence-backed savings
→ savings-funded member benefit entitlement
→ privacy-preserving member view
```

Capability gaps must be classified and separately authorized when they require new API/product exposure, provider integration, or architectural change. `W037` and new protocol domains are not implied.

## Legacy implementation notes

NET-W003 established the production persistence/coordination boundary:
PostgreSQL authoritative persistence, Redis non-authoritative
coordination, durable object-storage references, secret-provider
isolation, transactions/rollback/recovery, idempotency/concurrency,
observability trace/correlation lineage, and audit material-mutation
tracing. The provider-neutral contracts live in `src/core/`; the REAL
`pg` and `ioredis` drivers live behind the adapter boundary
(`src/adapters/postgres/`, `src/adapters/redis/`), permitted ONLY there
by the architecture checker; clearly-marked test doubles
(`src/persistence/`, `src/queues/`, `src/object-storage/`) cover the
same contracts for deterministic unit tests.

See the historical evidence records and work orders under `docs/` and
`spec/work-orders/` for the completed NET-W001..036 implementation
program.

### Run

```bash
bun install
bun run verify
```
