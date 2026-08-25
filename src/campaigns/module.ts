import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Campaigns boundary module (skeletal).
 * Authority: campaign domain rules. Concrete behaviour: NET-W011.
 */
export const campaignsModule = defineBoundaryModule({
  name: "campaigns",
  tier: "domain",
  summary: "campaign domain rules (skeleton; NET-W011)",
});
