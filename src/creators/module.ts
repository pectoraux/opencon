import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Creators boundary module (skeletal).
 * Authority: creator domain rules. Concrete behaviour: NET-W015.
 */
export const creatorsModule = defineBoundaryModule({
  name: "creators",
  tier: "domain",
  summary: "creator domain rules (skeleton; NET-W015)",
});
