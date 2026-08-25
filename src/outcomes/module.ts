import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Outcomes boundary module (skeletal).
 * Authority: outcome evaluation and measurement semantics. Concrete behaviour: NET-W006.
 */
export const outcomesModule = defineBoundaryModule({
  name: "outcomes",
  tier: "domain",
  summary: "outcome evaluation and measurement semantics (skeleton; NET-W006)",
});
