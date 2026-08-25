# `bootstrap` boundary

**Tier:** bootstrap (composition root)  
**Authority:** wires the modular-monolith runtime  
**Architecture ref:** `spec/architecture-lock.md` §9 (initial implementation posture: modular monolith with background workers)

## Scope

This is the composition root — the only tier permitted by the
architecture check to import concrete adapter/provider implementations
for wiring. It assembles configuration, logger, audit writer, object
store, secret provider, job queue, worker loop, module registry (all
31 boundary modules), health aggregator, and the HTTP API.

- `module-registry.ts` — concrete `ModuleRegistry` (topological init,
  reverse-order shutdown, peer-interface resolution by name).
- `runtime.ts` — `createRuntime()` wiring + the non-domain ECHO job
  handler used to demonstrate the async/context boundary (AC-03/AC-05).

`src/server.ts` is the process entry point that invokes the runtime,
handles SIGINT/SIGTERM, and fail-fasts on invalid configuration.
