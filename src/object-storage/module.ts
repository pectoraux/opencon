import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Object-storage boundary module (skeletal).
 * Authority: large/immutable artifact storage referenced from PostgreSQL. Concrete behaviour: NET-W003.
 */
export const objectStorageModule = defineBoundaryModule({
  name: "object-storage",
  tier: "infrastructure",
  summary: "large/immutable artifact storage referenced from PostgreSQL (skeleton; NET-W003)",
});
