# `measurement` boundary

**Tier:** adapter (the root `port.ts` / `index.ts` / `module.ts` are the
neutral integration surface)
**Authority:** measurement provider integrations; **measurement
semantics remain in `/outcomes`** (architecture §18; architecture-lock
§14 invariant 25)
**Architecture ref:** `spec/architecture.md` §13, §18;
`spec/architecture-lock.md` §14
**Work order:** `spec/work-orders/NET-W006.md` §3.7

## Scope after NET-W006

`port.ts` declares the provider-neutral `MeasurementProviderAdapter`
contract. Every external measurement platform integration implements
it; the `/outcomes` domain consumes ONLY this neutral port (domain →
neutral is allowed by the tier matrix; provider SDKs/types never cross
into the domain — architecture-lock §14 invariant 24).

Provider observations are NORMALIZED facts
(`ProviderObservationReport`): outcome type from the OUT-001
vocabulary, measured value + unit, confidence with uncertainty, and
method + methodVersion provenance. Raw provider payloads stay on the
provider side of the adapter boundary.

The reference adapter (`providers/echo-measurement-provider.ts`)
reports no observations; it exists so the composition root has a real
adapter to wire and health-check, and as a compile-checked reference
for later providers. Concrete platform adapters — browser/platform
attribution and iOS attribution (requirements ADAPTER-003..004) —
arrive in NET-W022 under `providers/`.

## Dependencies

Core contracts (`src/core/measurement.ts`, `src/core/evidence.ts`) —
vocabulary only. No domain imports (the semantics live in `/outcomes`;
this boundary only carries the integration surface).
