# Module Conventions

**Architecture:** v1.0 (FROZEN)  
**Work item:** NET-W001  
**Scope:** This document records the single, documented convention for how
OpenCon modules expose interfaces, depend on each other, own DTOs/schemas,
separate concerns, propagate errors, bound transactions, and bound
asynchronous commands. It is normative for all future work items.

## 1. Tier model

Every source file belongs to exactly one tier, determined by its path
under `src/` (see `scripts/lib/architecture.ts`):

| Tier            | Location | Role |
|-----------------|----------|------|
| `core`          | `src/core/**` | Provider-neutral contracts/interfaces only. Imported by everyone. Imports nothing outside core + node builtins + `zod`. |
| `bootstrap`     | `src/server.ts`, `src/bootstrap/**` | Composition root. The ONLY tier allowed to import concrete adapter/provider implementations for wiring. |
| `domain`        | 16 frozen domain dirs | Owns entities and business rules for one bounded context. NO concrete infra/provider imports. |
| `infrastructure`| `api`, `workers`, `audit`, `persistence`, `queues`, `object-storage`, `secrets`, `observability`, `config` | Concrete technical implementations of the contracts in `core`. |
| `neutral`       | `*/port.ts`, `*/index.ts`, `*/module.ts` at the root of `llm`, `agents`, `measurement`, `payments`, `ledger`, `adapters` | Provider-neutral integration ports. Importable by domain. |
| `adapter`       | `*/providers/**`, `adapters/<provider>/**` | Concrete external provider implementations. NEVER imported by domain or non-bootstrap infrastructure. |

## 2. Dependency direction (allow matrix)

The architecture check (`bun run arch:check`) enforces:

| Importer        | May import |
|------------------|------------|
| `core`           | core, node builtins, `zod` |
| `bootstrap`      | anything (composition root) |
| `domain`         | core, neutral ports, self (same dir), node builtins, `zod` |
| `infrastructure` | core, neutral, infrastructure, node builtins, `zod` |
| `neutral`        | core, neutral, node builtins, `zod` |
| `adapter`        | core, neutral, adapter, node builtins, `zod`, external provider SDKs |

**Prohibited (violations fail the build):**

- domain → infrastructure/adapter/other-domain/bootstrap
- infrastructure → domain/adapter/bootstrap
- neutral → domain/infrastructure/adapter
- adapter → domain/infrastructure/bootstrap
- core → anything but core

A self-contained intentionally-failing fixture lives at
`tests/architecture/fixtures/violation/src/` and is scanned separately
to prove the check fires (NET-W001-AC-02).

## 3. Public module interfaces

Each boundary exposes:

- `port.ts` — the declared public interface (typed contracts only). For
  domains this is the `<Name>Port` interface describing the boundary's
  future responsibility per `spec/architecture.md` §18. No executable
  logic.
- `module.ts` — a `Module` registration (via `defineBoundaryModule`)
  declaring `name`, `tier`, `version`, `dependencies`, `summary`. `init`
  is idempotent and MUST NOT perform economically/material state changes.
- `index.ts` — barrel re-exporting `port.ts` and `module.ts`.
- `README.md` — documents the boundary, authority, and deferred work item.

Cross-domain access occurs ONLY through declared interfaces (the neutral
ports or core contracts). Future work items add cross-domain declared
interfaces as needed; NET-W001 intentionally prohibits domain→domain
imports to keep boundaries clean.

## 4. DTO/schema ownership

- Domain modules own their DTOs/schemas (declared in `port.ts`).
- Cross-module DTOs that are genuinely shared live in `src/core/` (e.g.
  `ExecutionContext`, `LogEntry`, `AuditEvent`).
- Provider-specific SDK types NEVER cross into core or domain
  (`architecture-lock.md` §14, invariant 24). Adapter modules translate
  provider types into neutral DTOs at the boundary.

## 5. Domain/application/infrastructure separation

- **Domain** (`/domain dirs`): entities, lifecycle, invariants, rules.
- **Application** (future work items, lives behind `/workflows`):
  orchestrates domain operations, enforces transaction boundaries,
  composes evidence→outcome→settlement.
- **Infrastructure** (`/infrastructure dirs`): implements core contracts
  (queues, persistence, audit, object storage, secrets, observability,
  config, api, workers). Never authoritative for domain truth.

In v1.0 (NET-W001) only the infrastructure tier and contracts exist;
domain behaviour is deferred. The `/workflows` boundary owns
authoritative lifecycle transitions (`architecture-lock.md` §7).

## 6. Error propagation

All cross-module errors extend `OpenConError` (`src/core/errors.ts`),
carrying a stable `code` and `classification`:

| Classification | Meaning | HTTP (when surfaced) | Retryable |
|----------------|---------|----------------------|-----------|
| `validation` | invalid input/config/contract | 400 | no |
| `authorization` | not permitted | 403 | no |
| `not_found` | missing resource | 404 | no |
| `conflict` | duplicate/idempotent replay | 409 | no |
| `precondition` | precondition not met | 412 | no |
| `transient` | infra failure | 503 | yes (per policy) |
| `invariant` | architecture/invariant violation | 500 | no |
| `unknown` | unclassified (bug) | 500 | no |

Conventions:

- Domain modules throw `OpenConError` (or subclasses). They never
  swallow errors.
- Infrastructure rethrows with added context, never silently discards.
- The worker boundary classifies thrown values via `classifyError` and
  applies the retry policy only for `transient` (retryable) errors.
- The HTTP boundary maps `classification` → status code.
- Errors are never used to silently make domain/economic decisions
  (`architecture-lock.md` invariant: no reward from raw activity).

## 7. Transaction boundaries

- `TransactionManager` (`src/persistence/transaction-manager.ts`) is the
  abstraction. NET-W001 ships an in-memory skeletal implementation; a
  PostgreSQL-backed authoritative implementation is NET-W003.
- Transactions carry an `ExecutionContext` so audit records correlate
  the transaction with its execution.
- `run(ctx, work)` commits on success, rolls back on error, rethrows.
- PostgreSQL is authoritative application state
  (`architecture-lock.md` §3); Redis/queues/caches/worker memory are
  NEVER authoritative (§16).

## 8. Asynchronous command/job boundaries

- Long-running operations execute through the `JobQueue`/`JobHandler`
  boundary (`src/core/queue.ts`, `src/queues/`, `src/workers/`).
- A job carries: durable `id`, `type`, `payload`, optional
  `idempotencyKey`, `RetryPolicy`, and an `ExecutionContext`.
- The worker loop derives a child `ExecutionContext` (new `executionId`,
  preserved `correlationId`, `causationId` = parent's `executionId`) so
  the causal chain propagates across the enqueue→execute boundary.
- Failed jobs retry per `RetryPolicy`; exhausted jobs move to
  `dead_letter` and are recoverable via `requeueFromDeadLetter`.
- Idempotency: an enqueue with a key already pending/running returns the
  existing job id with `created: false` (no duplicate enqueue).
- NET-W001 authorizes ONLY the boundary and a non-domain ECHO handler
  for demonstration. Domain-specific jobs are deferred to later work
  items (§4.5, §5 non-goals).
