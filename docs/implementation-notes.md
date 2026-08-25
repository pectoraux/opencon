# Implementation Notes — NET-W001

**Architecture:** v1.0 (FROZEN)  
**Work item:** NET-W001 — Platform and modular-monolith foundation

## 1. Technology choices (recorded per work order §4.1)

The work order permits framework selection where it does not conflict
with the frozen architecture. All choices are recorded here.

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5 (strict) | Required by work order §1 ("TypeScript modular monolith") |
| Runtime / package manager | Bun ≥1.3 | Runs TypeScript natively; built-in test runner; fast; available in the dev environment |
| Test runner | `bun test` (`bun:test`) | Built-in, zero-config; deterministic; reproducible from checkout |
| Configuration validation | `zod` | Typed schemas, classified errors, safe defaults, fail-fast |
| HTTP server | Node built-in `node:http` | Zero framework coupling; sufficient for health/readiness/liveness + representative request (§4.6) |
| Identifiers | `node:crypto.randomUUID()` | Standard, dependency-free |
| Context propagation | `node:async_hooks` (`AsyncLocalStorage`) | Standard execution-context propagation across HTTP and worker scopes |
| Architecture enforcement | Custom deterministic import scanner (`scripts/lib/architecture.ts`) | No AST dependency; fully reproducible; enforces the tier allow matrix (§4.8) |

No other external runtime dependencies are introduced. The dependency
footprint is intentionally minimal (only `zod`) to maximize
reproducibility and audit surface.

## 2. What is implemented in NET-W001

- **Module boundaries:** all 16 domain + 9 infrastructure + 6 external
  integration directories exist with documented `port.ts`, `module.ts`,
  `index.ts`, `README.md` (AC-01).
- **Core contracts:** `Module`, `ModuleRegistry`, `ExecutionContext`,
  `Logger`, `ConfigurationProvider`, `JobQueue`, `JobHandler`,
  `AuditWriter`, `ObjectStore`, `SecretProvider`, `ProviderAdapter`
  (plus error taxonomy) in `src/core/`.
- **Configuration:** typed, validated, fail-fast, with safe development
  defaults and required-secret enforcement in non-development
  environments. Snapshot is frozen (immutable) for process lifetime.
  Secrets boundary: `ConfigurationProvider.get()` throws
  `SecretAccessError` (classification `invariant`) for any classified
  secret key — secret material is NEVER returned through the config
  provider. `getSecretReference()` returns an opaque `SecretReference`
  (`key` + redacted diagnostics, never the value); the value is
  resolved exclusively by the `SecretProvider` at the infrastructure
  boundary. This closes the boundary leak where secrets could previously
  be retrieved via `get()` / `getSecretReference()`.
- **Execution/correlation context:** propagates across HTTP (via
  `X-Correlation-Id`/`X-Causation-Id` headers and AsyncLocalStorage) and
  worker execution (via `deriveExecutionContext`).
- **Worker boundary:** in-memory `JobQueue` with durable job identity,
  idempotency keys, retry policy, dead-letter, and requeue. Worker loop
  with a non-domain ECHO handler for demonstration.
- **Structured logging:** JSON in non-development, pretty text in
  development, always stamped with execution+correlation IDs, level,
  module/component, and classified errors.
- **Health/readiness/liveness:** `/health`, `/ready`, `/live`.
- **Audit foundation:** append-only `AuditWriter` (in-memory + file
  backed). Entries are DEEPLY frozen — the event object, its metadata,
  and every nested object/array reachable through it are recursively
  immutable (deep freeze via `structuredClone` + `deepFreeze`), so
  callers cannot mutate prior entries, including nested metadata. The
  caller's own input metadata is cloned, never frozen in place.
- **Architecture enforcement:** deterministic import scanner enforcing
  dependency direction and adapter isolation; an intentional failing
  fixture proves it fires. Enforced in CI via `.github/workflows/ci.yml`
  (runs `typecheck` + `arch:check` + `bun test` on every push and PR
  targeting `main`), satisfying NET-W001 §4.8 ("must be enforceable in CI").

## 3. What is deliberately NOT implemented (out of scope per §5)

- No user authentication/authorization business rules.
- No identity persistence beyond skeleton contracts.
- No campaigns, inventory, creator profiles, helpfulness, evidence
  evaluation, attribution, reputation algorithms, Participation
  Credit issuance, cash settlement, fraud models, Demand Pools,
  procurement, Benefit Pools, blockchain/ledger consensus, external
  platform integrations, or production AI routing.
- No concrete PostgreSQL/Redis/object-storage backends (NET-W003).
- No domain-specific worker jobs (deferred).
- No placeholder implementations that silently make domain decisions.

## 4. Composition root

`src/bootstrap/runtime.ts` is the single composition root. It is the
only location permitted by the architecture check to import concrete
adapter/provider implementations for wiring (tier `bootstrap`).
`src/server.ts` is the process entry point; it loads configuration
(fail-fast), initializes the module registry, starts the worker loop
and HTTP API, and handles graceful shutdown (SIGINT/SIGTERM).

## 5. Reproducibility

From a clean checkout:

```bash
bun install
bun run verify          # typecheck + architecture check + tests
bun run arch:check      # architecture check only
bun test                # tests only
bun run dev             # start the server (development)
```

`bun run verify` is the canonical evidence command.
