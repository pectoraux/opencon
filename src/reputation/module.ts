import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Reputation boundary module (skeletal).
 * Authority: reputation computation and provenance. Concrete behaviour: NET-W007.
 */
export const reputationModule = defineBoundaryModule({
  name: "reputation",
  tier: "domain",
  summary: "reputation computation and provenance (skeleton; NET-W007)",
});
