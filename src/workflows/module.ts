import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Workflows boundary module (skeletal).
 * Authority: authoritative lifecycle transitions and orchestration. Concrete behaviour: NET-W004.
 */
export const workflowsModule = defineBoundaryModule({
  name: "workflows",
  tier: "domain",
  summary: "authoritative lifecycle transitions and orchestration (skeleton; NET-W004)",
});
