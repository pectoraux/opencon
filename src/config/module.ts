import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Config boundary module (skeletal).
 * Authority: centralized, typed, validated configuration. Concrete behaviour: NET-W001.
 */
export const configModule = defineBoundaryModule({
  name: "config",
  tier: "infrastructure",
  summary: "centralized, typed, validated configuration (skeleton; NET-W001)",
});
