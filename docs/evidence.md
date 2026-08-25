# NET-W001 — Evidence

**Work Item:** NET-W001  
**Architecture:** v1.0  
**Requirements:** CORE-001..004, AUD-001  
**Acceptance Criteria:** NET-W001-AC-01..08

All evidence is reproducible from a clean repository checkout via
`bun install && bun run verify`.

## 1. Verification commands

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies (zod) |
| `bun run typecheck` | TypeScript strict typecheck |
| `bun run arch:check` | Deterministic architecture/dependency check |
| `bun test` | Full automated test suite (8 files, 40 tests) |
| `bun run verify` | typecheck + arch:check + tests (canonical evidence command) |

## 2. Verification results (reproduced)

```
$ bun run verify
$ tsc --noEmit                       # typecheck: PASS (exit 0)
$ bun scripts/check-architecture.ts # ✓ 127 files scanned, 0 violations (exit 0)
$ bun test                          # 40 pass, 0 fail, 460 expect() calls, 8 files (exit 0)
```

Architecture check on the intentional failing fixture (proves the
check fires; not part of `verify`):

```
$ bun run arch:check --root=tests/architecture/fixtures/violation/src
✗ 3 violation(s) across 6 files:
  - evidence/port.ts → domain-must-not-import-other-domain
  - outcomes/port.ts  → domain-must-not-import-adapter
  - identity/port.ts  → domain-must-not-import-infrastructure
exit 1
```

## 3. Changed-files summary mapped to acceptance criteria

### NET-W001-AC-01 — Module boundaries (PASS)
- `src/core/{errors,execution-context,logger,config,module,queue,audit,object-store,secrets,adapter,domain-module,index}.ts` — 11 required contracts
- `src/<16 domain dirs>/{port,module,index,README.md}` — explicit boundaries + documented interfaces
- `src/<9 infra dirs>/{port,module,index,README.md}` + concrete impls
- `src/<6 external dirs>/{port,module,index,README.md}` + provider stubs
- `tests/contracts/ac-01-module-boundaries.test.ts`

### NET-W001-AC-02 — Dependency direction (PASS)
- `scripts/lib/architecture.ts` — deterministic import scanner + tier allow matrix
- `scripts/check-architecture.ts` — CLI (`bun run arch:check`)
- `tests/architecture/fixtures/violation/src/**` — intentional failing fixture (domain→infra, domain→adapter, domain→other-domain)
- `tests/architecture/ac-02-dependency-direction.test.ts` — asserts src clean (passing suite) + fixture flagged

### NET-W001-AC-03 — Async execution (PASS)
- `src/core/queue.ts` — `JobQueue`/`JobHandler`/`RetryPolicy` contracts
- `src/queues/in-memory-queue.ts` — durable id, idempotency, retry, dead-letter, requeue
- `src/workers/worker-loop.ts` — dequeue/dispatch, context propagation, audit
- `src/bootstrap/runtime.ts` — ECHO handler wiring
- `tests/workers/ac-03-async-execution.test.ts` — enqueue+execute, context preservation, idempotency, retry→dead-letter

### NET-W001-AC-04 — Configuration validation (PASS)
- `src/config/schema.ts` — zod schema, field classification
- `src/config/provider.ts` — typed snapshot (frozen), fail-fast, redacted diagnostics
- `src/core/errors.ts` — `ConfigurationValidationError`
- `tests/config/ac-04-configuration-validation.test.ts` — invalid→classified error; valid dev→boots; production missing secrets→fail-fast

### NET-W001-AC-05 — Structured observability (PASS)
- `src/observability/logger.ts` — JSON structured logs with execution+correlation IDs, level, module, classified error
- `src/observability/health.ts` — health aggregator
- `src/api/server.ts` — per-request `ExecutionContext`, correlation headers echoed
- `tests/observability/ac-05-structured-observability.test.ts` — HTTP request + worker execution both emit structured logs with IDs

### NET-W001-AC-06 — Audit append boundary (PASS)
- `src/core/audit.ts` — `AuditWriter`/`AuditEvent` contracts
- `src/audit/audit-writer.ts` — in-memory + file-backed append-only; entries deeply frozen
- `tests/audit/ac-06-audit-append.test.ts` — append+retrieve, no mutation of prior entries, file persistence across writer instances

### NET-W001-AC-07 — Adapter isolation (PASS)
- `src/core/adapter.ts` — `ProviderAdapter` contract
- `src/llm/port.ts`, `src/agents/port.ts`, `src/measurement/port.ts`, `src/payments/port.ts`, `src/ledger/port.ts` — provider-neutral ports
- `src/llm/providers/echo-llm-provider.ts` (+ 4 more echo providers, `src/adapters/echo-adapter/`) — concrete adapters (never imported by domain)
- `src/outcomes/port.ts` — domain depends on neutral `LlmPort` only
- `tests/adapters/ac-07-adapter-isolation.test.ts` — neutral dependency compiles; scanner confirms zero domain→adapter imports

### NET-W001-AC-08 — No premature domain logic (PASS)
- `src/core/domain-module.ts` — `defineBoundaryModule` (skeletal, no domain behaviour)
- 16 domain `module.ts`/`port.ts` — interfaces only
- `tests/regression/ac-08-no-premature-domain-logic.test.ts` — domain modules skeletal (tier domain, "skeleton"); forbidden material-operation patterns absent; ports declare interfaces only; architecture lock unmodified

## 4. Out-of-scope confirmation

Per work order §5 (explicit non-goals), this work item introduces NONE of:

- user authentication/authorization business rules
- identity persistence beyond skeleton contracts
- campaigns, inventory, creator profiles, helpfulness scoring
- evidence evaluation, attribution, reputation algorithms
- Participation Credit issuance, cash settlement, fraud models
- Demand Pools, procurement, Benefit Pools, blockchain/ledger consensus
- external platform integrations, production AI routing

No placeholder implementation silently makes domain decisions. The only
executable "job" is the non-domain ECHO handler (used to prove the
async/context boundary). No domain module mutates economically/material
state. The frozen architecture (`spec/architecture.md`,
`spec/architecture-lock.md`) is unchanged.

## 5. Single PR

Exactly one implementation PR is created for NET-W001
(see PR description for the required format).
