import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Demand boundary module (skeletal).
 * Authority: demand aggregation. Concrete behaviour: NET-W024.
 */
export const demandModule = defineBoundaryModule({
  name: "demand",
  tier: "domain",
  summary: "demand aggregation (skeleton; NET-W024)",
});
