import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Disputes boundary module (skeletal).
 * Authority: challenges, disputes, appeals and penalties. Concrete behaviour: NET-W010.
 */
export const disputesModule = defineBoundaryModule({
  name: "disputes",
  tier: "domain",
  summary: "challenges, disputes, appeals and penalties (skeleton; NET-W010)",
});
