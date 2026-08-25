import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Persistence boundary module (skeletal).
 * Authority: authoritative state (PostgreSQL in v1.0); transaction boundaries. Concrete behaviour: NET-W003.
 */
export const persistenceModule = defineBoundaryModule({
  name: "persistence",
  tier: "infrastructure",
  summary: "authoritative state (PostgreSQL in v1.0); transaction boundaries (skeleton; NET-W003)",
});
