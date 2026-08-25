import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Contributions boundary module (skeletal).
 * Authority: contribution lifecycle and submission state. Concrete behaviour: NET-W004.
 */
export const contributionsModule = defineBoundaryModule({
  name: "contributions",
  tier: "domain",
  summary: "contribution lifecycle and submission state (skeleton; NET-W004)",
});
