import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Opportunities boundary module (skeletal).
 * Authority: opportunities and contribution submission state. Concrete behaviour: NET-W004.
 */
export const opportunitiesModule = defineBoundaryModule({
  name: "opportunities",
  tier: "domain",
  summary: "opportunities and contribution submission state (skeleton; NET-W004)",
});
