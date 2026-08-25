import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Benefits boundary module (skeletal).
 * Authority: benefit allocation. Concrete behaviour: NET-W028.
 */
export const benefitsModule = defineBoundaryModule({
  name: "benefits",
  tier: "domain",
  summary: "benefit allocation (skeleton; NET-W028)",
});
