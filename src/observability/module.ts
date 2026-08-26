import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Observability boundary module.
 * Authority: structured logging, health/readiness/liveness, correlation,
 * trace/span lineage. NON-AUTHORITATIVE (coordination, not truth).
 * Concrete behaviour: NET-W001 (logger + execution context + health
 * aggregator) + NET-W003 (TraceRecorder — span/trace correlation lineage).
 */
export const observabilityModule = defineBoundaryModule({
  name: "observability",
  tier: "infrastructure",
  summary:
    "structured logging, health, correlation, trace lineage (NET-W001 + NET-W003)",
});
