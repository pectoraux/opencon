import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Organizations boundary module (skeletal).
 * Authority: organization membership and eligibility. Concrete behaviour: NET-W002.
 */
export const organizationsModule = defineBoundaryModule({
  name: "organizations",
  tier: "domain",
  summary: "organization membership and eligibility (skeleton; NET-W002)",
});
