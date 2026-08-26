# Open Contribution Protocol

Open Contribution Protocol (OpenCon) is an open protocol for coordinating advertising, creator partnerships, helpful contributions, collective demand, procurement, and member benefits.

## Development status

**Architecture:** v1.0 FROZEN  
**Requirements:** v1.0 APPROVED BASELINE  
**Implementation:** NET-W003 in review (persistence, queues, objects, secrets, observability)  
**Next eligible work item:** `NET-W003` (PR #6 re-review)  
**Implementation agent:** Z.ai  
**Architect:** OpenCon architecture authority

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
- `spec/work-items.md` — implementation backlog and definitions of done
- `spec/dependency-graph.md` — implementation dependencies and eligibility rules

## Implementation (NET-W003)

NET-W003 establishes the production persistence/coordination boundary:
PostgreSQL authoritative persistence, Redis non-authoritative
coordination, durable object-storage references, secret-provider
isolation, transactions/rollback/recovery, idempotency/concurrency,
observability trace/correlation lineage, and audit material-mutation
tracing. The provider-neutral contracts live in `src/core/`; the REAL
`pg` and `ioredis` drivers live behind the adapter boundary
(`src/adapters/postgres/`, `src/adapters/redis/`), permitted ONLY there
by the architecture checker; clearly-marked test doubles
(`src/persistence/`, `src/queues/`, `src/object-storage/`) cover the
same contracts for deterministic unit tests. See:

- `docs/module-conventions.md` — documented module/dependency/DTO/error/transaction/async conventions
- `docs/implementation-notes.md` — recorded technology choices and scope
- `docs/evidence.md` — NET-W001 acceptance-criteria evidence + verification
- `docs/net-w002-evidence.md` — NET-W002 acceptance-criteria evidence + verification
- `docs/net-w003-evidence.md` — NET-W003 acceptance-criteria evidence + verification

### Run

```bash
bun install
bun run verify   # typecheck + architecture check + tests (canonical evidence; integration tests skip without services)
bun run dev      # start the server (development)
```

### Real-provider integration tests (PostgreSQL + Redis)

The real `pg` and `ioredis` adapters are exercised by conditional
integration tests. They skip when the service env vars are unset, so
`bun run verify` stays green without external services.

```bash
docker compose up -d   # provisions PostgreSQL 17 + Redis 7
export PG_TEST_DATABASE_URL="postgres://opencon:opencon@localhost:55432/opencon_test"
export REDIS_TEST_URL="redis://localhost:56379"
bun test tests/integration/
docker compose down
```

CI runs both jobs on every push/PR: `verify` (the architecture +
unit gate, no services) and `integration` (real PostgreSQL + Redis
service containers exercising the real adapters).

The NET-W002 HTTP surface extends NET-W001's `/health`, `/ready`,
`/live`, `/api/modules`, `/api/config`, `/api/echo` with protected
endpoints (`POST /api/identities`, `GET /api/identities/:id`,
`POST /api/organizations`,
`POST /api/organizations/:id/memberships`,
`DELETE /api/organizations/:id/memberships/:membershipId`) guarded
by server-side authorization. Protected mutations reject
unauthenticated and unauthorized principals; client-asserted
role/scope claims are never trusted (§4.5, API-AC-02).

## Architectural principles

- Evidence over claims.
- Verified value over raw activity.
- Provider-independent core with explicit adapters.
- PostgreSQL is authoritative application state in v1.0.
- External platforms remain authoritative for their own platform state.
- AI recommendations never unilaterally authorize settlement or reputation.
- Participation Credits are distinct from cash settlement.
- Public ledger storage does not contain raw personal activity.
- Frozen architecture changes require an Architecture Change Request and a new architecture version.

## Product expressions

The common protocol may be surfaced through separate clients/products:

- Farmable — contribution/helpfulness marketplace
- Creator Partnerships — creator/UGC market
- Ad Network — advertising/cross-promotion market
- Demand — consumer/business demand aggregation and procurement
- Benefits — member benefit pools

These are clients over common protocol primitives, not separate economic systems.
