import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Agents boundary module (skeletal).
 * Authority: provider-neutral agent execution. Concrete behaviour: NET-W013.
 */
export const agentsModule = defineBoundaryModule({
  name: "agents",
  tier: "adapter",
  summary: "provider-neutral agent execution (skeleton; NET-W013)",
});
