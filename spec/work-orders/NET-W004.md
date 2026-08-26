# NET-W004 — Opportunity and Contribution Lifecycle

**Status:** READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 (FROZEN)  
**Requirements:** OPP-001..004, API-003  
**Dependencies:** NET-W002 (merged), NET-W003 (merged)  
**Acceptance Criteria:** NET-W004-AC-01..08  

## 1. Objective

Implement the protocol's first authoritative business workflow: Opportunities and Contributions.

This work item establishes `/opportunities`, `/contributions`, and `/workflows` as the authoritative lifecycle system for contribution opportunities and participant submissions.

The implementation must build on the merged identity/authorization and persistence/coordination foundations. All authoritative transitions occur through authorized workflow operations, are deterministic and idempotent, and preserve execution/correlation/causation and audit lineage.

## 2. Architectural binding

This work item is bound to frozen Architecture v1.0.

The `/workflows` boundary is authoritative for lifecycle transitions and orchestration. Domain modules own their entities and business rules; workflow operations are the only authority allowed to mutate lifecycle state. Frontends, agents, AI services and external callers may propose or request transitions but may not directly mutate authoritative lifecycle state.

PostgreSQL remains authoritative application state. Redis/queues are coordination only. Existing provider adapters and SecretProvider boundaries remain unchanged.

## 3. Scope

### 3.1 Opportunity

Implement an Opportunity as a first-class protocol object with at minimum:

- stable identifier
- organization/participant owner
- opportunity type
- title/description or structured brief
- eligibility policy reference
- contribution requirements
- lifecycle state
- timestamps
- version/revision
- execution/correlation lineage for material mutations

Opportunity types shall remain extensible without creating product-specific alternate workflow systems.

### 3.2 Contribution

Implement Contribution as a first-class object linked to exactly one Opportunity and contributor, with at minimum:

- stable identifier
- opportunity reference
- contributor reference
- submission payload/reference appropriate to the contribution type
- lifecycle state
- timestamps
- revision/version
- evidence-reference placeholders only; no Proof-of-Value evaluation in this work item
- execution/correlation lineage

### 3.3 Workflow authority

Implement the canonical contribution lifecycle:

```text
DRAFT
→ READY
→ ASSIGNED
→ IN_PROGRESS
→ SUBMITTED
→ MEASURING
→ EVALUATING
→ CHALLENGE_WINDOW
→ SETTLING
→ SETTLED
→ VERIFIED
```

Exceptional states:

```text
BLOCKED
FRAUD_REVIEW
DISPUTED
REJECTED
CANCELLED
```

The work item must define the legal transition matrix explicitly and reject every unspecified transition.

### 3.4 API contract

Expose provider-neutral application operations for creating/getting opportunities and contributions and for requesting authorized workflow transitions.

Material mutation operations must be idempotent where duplicate delivery/retry is possible and must return stable identifiers plus execution references.

## 4. Required invariants

1. Only `/workflows` may authoritatively transition Opportunity/Contribution lifecycle state.
2. Domain/application services may validate business preconditions but may not bypass workflow authority.
3. Illegal transitions fail deterministically with stable error codes.
4. Repeating the same authorized transition with the same idempotency key is a deterministic replay and does not create duplicate mutations/audit records.
5. A transition is tenant/participant scoped and server-authorized.
6. Material lifecycle mutations persist through PostgreSQL-backed authority boundaries established by NET-W003.
7. Every material mutation preserves execution/correlation/causation lineage and append-oriented audit evidence.
8. Workflow state changes are versioned and use optimistic concurrency or equivalent conflict detection so stale writers cannot overwrite newer state.
9. External agents, AI systems and clients cannot directly set authoritative lifecycle state.
10. No economic value, reputation change, settlement, fraud decision, evidence evaluation or Proof-of-Value result is created by this work item.

## 5. Explicit non-goals

Do not implement:

- evidence evaluation or Proof-of-Value
- outcome/measurement semantics
- reputation calculation
- Participation Credits or cash settlement
- campaign behavior
- helpfulness scoring
- creator matching/UGC
- advertising inventory
- fraud scoring or challenge economics
- demand pools/procurement/benefit pools
- blockchain consensus or decentralized validation

Evidence references may be represented as neutral IDs/placeholders so later work can attach evidence without changing the workflow model.

## 6. Required acceptance criteria

### NET-W004-AC-01 — Opportunity first-class model

Opportunities can be created, retrieved and updated through authorized application operations, have stable IDs and versions, are tenant/participant scoped, and persist durably through PostgreSQL.

**Required evidence:** domain + API + persistence integration tests.

### NET-W004-AC-02 — Contribution first-class model

Contributions can be created and retrieved against an Opportunity and contributor, persist durably, and enforce the invariant that a Contribution belongs to exactly one Opportunity and contributor.

**Required evidence:** domain + API + persistence integration tests.

### NET-W004-AC-03 — Complete transition matrix

Every legal transition in the canonical lifecycle succeeds under its required preconditions; every unspecified transition is rejected with a stable error classification/code.

**Required evidence:** exhaustive transition-matrix tests, including all exceptional states.

### NET-W004-AC-04 — `/workflows` authority

Only the workflow service may mutate lifecycle state. Direct domain/application attempts to write lifecycle state outside the workflow boundary are rejected by architecture/static checks and runtime tests.

**Required evidence:** architecture fixture + runtime authorization tests.

### NET-W004-AC-05 — Authorization and scoping

A caller may transition only opportunities/contributions for which the server-side participant/organization policy permits the operation. Forged client claims cannot authorize a transition, and cross-organization access is rejected.

**Required evidence:** authorization/security tests.

### NET-W004-AC-06 — Idempotency and concurrency

Repeated delivery of the same transition request with the same idempotency key results in exactly one authoritative mutation/audit lineage. Concurrent stale writers are rejected or deterministically serialized; no lost update occurs.

**Required evidence:** concurrency/integration tests using NET-W003 persistence/idempotency boundaries.

### NET-W004-AC-07 — Trace/audit lineage

Every material lifecycle mutation records stable execution/correlation/causation identifiers, actor/subject/resource lineage and an append-oriented audit record that is committed atomically with the authoritative state mutation.

**Required evidence:** audit/trace integration tests.

### NET-W004-AC-08 — Architecture and out-of-scope regression

The architecture checker passes, frozen architecture files remain unchanged, and no downstream economic/evidence/reputation/product behavior is introduced.

**Required evidence:** static architecture check + regression tests.

## 7. Suggested API/application operations

Provider-neutral operations may include:

```text
createOpportunity
getOpportunity
requestOpportunityTransition
createContribution
getContribution
requestContributionTransition
```

Exact transport shape is implementation-defined, but domain semantics must remain independent of HTTP or any external platform.

## 8. Workflow state machine requirements

The implementation must define an explicit transition table with:

- source state
- target state
- required actor/role/policy
- required object preconditions
- idempotency semantics
- optimistic concurrency/version requirement
- audit event name
- resulting revision

Transitions that require later domains (for example evidence, settlement, fraud or dispute decisions) should be represented as workflow states/preconditions only. This work item must not invent downstream economic semantics.

## 9. Required evidence package

The implementation PR must contain:

- `docs/net-w004-evidence.md`
- tests mapped 1:1 to AC-01..08
- architecture/static fixture proving workflow authority
- explicit transition matrix artifact or test fixture
- reproducible `bun run verify` output
- if integration tests require services, the existing CI service-container path must continue to pass

## 10. Definition of done

NET-W004 is complete only when:

1. OPP-001..004 and API-003 are implemented.
2. `/workflows` is the sole lifecycle authority.
3. All legal transitions and rejection paths are exhaustively tested.
4. Persistence, idempotency, authorization and audit lineage are integrated with NET-W002/003 foundations.
5. Required evidence is mapped to every acceptance criterion.
6. Architecture checks and CI pass.
7. Frozen architecture files are unchanged.
8. No downstream economic/evidence/reputation/product behavior is introduced.
9. The canonical implementation PR is reviewed and approved by the architect.
