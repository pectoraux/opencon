import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Api boundary module (skeletal).
 * Authority: external application/API contract (versioned, provider-independent). Concrete behaviour: NET-W001.
 */
export const apiModule = defineBoundaryModule({
  name: "api",
  tier: "infrastructure",
  summary: "external application/API contract (versioned, provider-independent) (skeleton; NET-W001)",
});
