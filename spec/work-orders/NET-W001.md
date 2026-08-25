# Work Order — NET-W001

**Work Item:** NET-W001 — Platform and modular-monolith foundation  
**Architecture:** v1.0 (FROZEN)  
**Status:** READY_FOR_IMPLEMENTATION  
**Implementation Agent:** Z.ai  
**Architect:** OpenCon Architect  
**Created:** 2026-08-25

## 1. Purpose

Establish the executable foundation for Open Contribution Protocol v1.0 as a TypeScript modular monolith with explicit architectural boundaries, configuration, asynchronous worker execution, structured logging, execution/correlation IDs, interface conventions, and architecture enforcement.

This work order establishes infrastructure only. It must not implement advertising, creator, helpfulness, demand, procurement, reputation, evidence evaluation, economic settlement, or other domain behavior beyond the minimum contracts/stubs required to establish the boundaries.

## 2. Authoritative references

The implementation MUST conform to:

- `spec/architecture.md`
- `spec/architecture-lock.md`
- `spec/requirements.md`
- `spec/work-items.md`
- `spec/dependency-graph.md`

The frozen architecture is authoritative. Do not reinterpret or expand it during implementation.

## 3. Requirements in scope

- CORE-001 — provider-independent protocol foundation
- CORE-002 — modular monolith with asynchronous workers
- CORE-004 — provider-specific behavior behind adapters
- AUD-001 — append-oriented auditability foundation

Related acceptance criteria:

- CORE-AC-01 — explicit frozen module boundaries
- CORE-AC-02 — declared cross-module interfaces
- CORE-AC-03 — long-running operations execute asynchronously

## 4. Scope

### 4.1 Repository/application skeleton

Create the initial TypeScript application structure with explicit boundaries for the v1.0 domains and infrastructure layers.

Required domain boundaries:

```text
src/
  identity/
  organizations/
  participants/
  opportunities/
  contributions/
  campaigns/
  inventory/
  creators/
  demand/
  benefits/
  reputation/
  evidence/
  outcomes/
  settlement/
  disputes/
  workflows/
```

Required infrastructure boundaries:

```text
src/
  api/
  workers/
  audit/
  persistence/
  queues/
  object-storage/
  secrets/
  observability/
```

Required external integration boundaries:

```text
src/
  adapters/
  agents/
  llm/
  measurement/
  payments/
  ledger/
```

The exact framework choices may be selected by Z.ai only where they do not conflict with the frozen architecture and are recorded in implementation documentation.

### 4.2 Module contract conventions

Establish one documented convention for:

- public module interfaces
- dependency direction
- DTO/schema ownership
- domain/application/infrastructure separation
- error propagation
- transaction boundaries
- asynchronous command/job boundaries

Domain modules must not import concrete external providers directly.

### 4.3 Configuration

Create centralized, typed configuration with:

- environment validation
- safe defaults for development
- required/optional secret classification
- fail-fast startup for invalid required configuration
- no committed secrets

### 4.4 Execution and correlation context

Implement a request/job execution context carrying at minimum:

- execution ID
- correlation ID
- actor/subject ID when available
- timestamp
- causation ID where applicable

The context must propagate across HTTP/API boundaries and asynchronous worker execution.

### 4.5 Worker boundary

Implement a minimal asynchronous job abstraction supporting:

- enqueue
- durable job identity
- execution/correlation context propagation
- retry policy abstraction
- failure/dead-letter handling boundary
- idempotency key support

The work order does not authorize implementation of domain-specific worker jobs.

### 4.6 Logging and observability

Implement structured logging with:

- JSON-capable structured events
- execution/correlation IDs
- log level
- module/component
- error classification
- timestamp

Add the minimal health/readiness/liveness observability needed to operate the skeleton.

### 4.7 Audit foundation

Create an append-oriented audit interface and persistence boundary for administrative/system actions.

The audit foundation must record at minimum:

- event ID
- event type
- actor/subject
- correlation/execution ID
- timestamp
- resource type/id where applicable
- structured metadata

Do not implement business-specific audit events yet.

### 4.8 Architecture enforcement

Add static or automated checks that fail when:

- domain modules import prohibited concrete infrastructure/provider implementations;
- dependency direction is violated;
- modules bypass declared interfaces;
- provider adapters are imported directly by domain code.

The checks may be simple and deterministic in this work item; they must be enforceable in CI.

## 5. Explicit non-goals

Do NOT implement:

- user authentication/authorization business rules
- identity persistence beyond skeleton contracts
- campaigns
- inventory
- creator profiles
- helpfulness scoring
- evidence evaluation
- attribution
- reputation algorithms
- Participation Credit issuance
- cash settlement
- fraud models
- Demand Pools
- procurement
- Benefit Pools
- blockchain/ledger consensus
- external platform integrations
- production AI routing

Do not create placeholder implementations that silently make domain decisions.

## 6. Required interfaces/contracts

At minimum define interfaces/contracts for:

```text
Module
ModuleRegistry
JobQueue
JobHandler
ExecutionContext
Logger
AuditWriter
ConfigurationProvider
ObjectStore
SecretProvider
ProviderAdapter
```

Concrete implementations may be skeletal where their full work item has not yet been authorized.

## 7. Acceptance criteria

### NET-W001-AC-01 — Module boundaries
All required frozen modules exist as explicit boundaries and expose documented public interfaces.

**Evidence:** source tree + architecture test output.

### NET-W001-AC-02 — Dependency direction
Architecture tests fail when a domain module imports a concrete provider/infrastructure implementation outside its allowed boundary.

**Evidence:** intentionally failing fixture/test plus passing normal suite.

### NET-W001-AC-03 — Async execution
A representative non-domain test job can be enqueued and executed by a worker while preserving execution/correlation context.

**Evidence:** integration test output.

### NET-W001-AC-04 — Configuration validation
Invalid required environment/configuration prevents startup with a classified validation error; valid development configuration starts successfully.

**Evidence:** automated configuration tests.

### NET-W001-AC-05 — Structured observability
A representative HTTP request and worker execution emit structured logs containing execution and correlation identifiers.

**Evidence:** automated logging/integration test.

### NET-W001-AC-06 — Audit append boundary
A representative system event can be appended to the audit interface and retrieved without mutation of prior entries.

**Evidence:** audit persistence test.

### NET-W001-AC-07 — Adapter isolation
A domain module can depend on a provider-neutral adapter interface without importing a concrete provider package.

**Evidence:** static dependency check + compile/test output.

### NET-W001-AC-08 — No premature domain logic
No implementation in this work item authorizes economically material value creation, settlement, reputation mutation, campaign delivery or user benefit allocation.

**Evidence:** architecture review of changed files + test suite.

## 8. Verification requirements

Z.ai MUST provide:

1. complete automated test output;
2. architecture/dependency check output;
3. startup/configuration validation evidence;
4. worker integration evidence;
5. audit persistence evidence;
6. a concise changed-files summary mapped to each acceptance criterion;
7. confirmation that no out-of-scope domain behavior was introduced.

All evidence must be reproducible from the repository checkout.

## 9. Implementation constraints

- Follow the frozen v1.0 architecture exactly.
- Do not modify `spec/architecture.md` or `spec/architecture-lock.md`.
- Do not change requirement semantics.
- Any architectural requirement discovered to be impossible or contradictory must be escalated as an Architecture Change Request rather than silently changing the design.
- Do not add provider-specific coupling to core domain modules.
- Do not commit secrets, credentials, access tokens or private keys.

## 10. PR requirements

Z.ai must create exactly one implementation PR for NET-W001.

The PR description MUST include:

```text
Work Item: NET-W001
Architecture: v1.0
Requirements: CORE-001..004, AUD-001
Acceptance Criteria: NET-W001-AC-01..08
Verification: <commands/results>
Out of Scope: <confirmation>
```

The PR must not claim completion solely through narrative. Review is based on repository state and reproducible evidence.

## 11. Completion state

The Work Item may move to verification only when:

- all acceptance criteria have objective evidence;
- required tests pass;
- the implementation PR exists and is the single active PR for NET-W001;
- no architecture lock was changed;
- no out-of-scope domain behavior was introduced.

Architect review determines whether the item is approved, changes requested, or escalated for architecture change.
