import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Inventory boundary module (skeletal).
 * Authority: inventory domain rules. Concrete behaviour: NET-W019.
 */
export const inventoryModule = defineBoundaryModule({
  name: "inventory",
  tier: "domain",
  summary: "inventory domain rules (skeleton; NET-W019)",
});
