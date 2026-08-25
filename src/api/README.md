# `api` boundary

**Tier:** infrastructure
**Authority:** external application/API contract (versioned, provider-independent)
**Architecture ref:** `spec/architecture.md` §18 (Module ownership)
**Concrete behaviour:** deferred to NET-W001

## Scope in NET-W001

This boundary is established as an explicit module with a documented
public interface (see `port.ts`) and a skeletal `Module` registration
(`module.ts`). **No domain logic is implemented in NET-W001** per the
work order explicit non-goals (§5). The boundary exists so that:

- the architecture enforcement check can verify dependency direction;
- future work items have a stable home for their contracts and rules;
- the module registry reports the boundary as initialized at startup.

## Dependencies

None beyond the shared `core` contracts. Cross-domain access will
occur through declared interfaces (added in later work items).
