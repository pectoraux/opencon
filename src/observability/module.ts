import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Observability boundary module (skeletal).
 * Authority: structured logging, health/readiness/liveness, correlation. Concrete behaviour: NET-W001.
 */
export const observabilityModule = defineBoundaryModule({
  name: "observability",
  tier: "infrastructure",
  summary: "structured logging, health/readiness/liveness, correlation (skeleton; NET-W001)",
});
