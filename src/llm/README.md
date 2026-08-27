# `llm` boundary

**Tier:** adapter
**Authority:** provider-neutral AI execution (matching, fraud, helpfulness/content scoring, safety, etc.)
**Architecture ref:** `spec/architecture.md` §14 (AI architecture), §18 (Module ownership)
**Concrete behaviour:** NET-W013 (advisory scoring contract + reference provider)

## Scope in NET-W013

The boundary is concrete (its designated NET-W013 purpose):

- `port.ts` — the provider-neutral contracts: `complete` (text
  completion) and `score` (advisory scoring over neutral record-level
  facts against a rubric reference). Every output carries the literal
  `authoritative: false` type — AI output is NEVER authoritative
  (architecture-lock §4/§5);
- `providers/echo-llm-provider.ts` — the deterministic ECHO reference
  provider (SHA-256-derived advisory scores; no external calls, no
  network). Concrete external providers are adapter-tier extensions of
  the same neutral port — they change advisory INPUTS, never the
  deterministic evaluation semantics of consuming domains.

Providers are instantiated and invoked at the composition root ONLY
(the architecture check's `domain-must-not-import-adapter` rule);
domain modules depend on nothing from this boundary — advisory results
arrive through the composition-root composites as ordinary inputs with
provider/model identity recorded.

## Scope in NET-W001

The boundary was established as an explicit module with a documented
public interface (`port.ts`) and a `Module` registration (`module.ts`)
so that the architecture enforcement check can verify dependency
direction and the module registry reports the boundary as initialized
at startup.

## Dependencies

None beyond the shared `core` contracts.
