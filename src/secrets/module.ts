import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Secrets boundary module (skeletal).
 * Authority: secrets isolation boundary. Concrete behaviour: NET-W001.
 */
export const secretsModule = defineBoundaryModule({
  name: "secrets",
  tier: "infrastructure",
  summary: "secrets isolation boundary (skeleton; NET-W001)",
});
