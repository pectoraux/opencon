import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Settlement boundary module (skeletal).
 * Authority: credits, pending/mature value, cash/credit settlement. Concrete behaviour: NET-W008.
 */
export const settlementModule = defineBoundaryModule({
  name: "settlement",
  tier: "domain",
  summary: "credits, pending/mature value, cash/credit settlement (skeleton; NET-W008)",
});
