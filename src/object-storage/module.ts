import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Object-storage boundary module.
 * Authority: large/immutable artifact storage referenced from PostgreSQL.
 * Concrete behaviour: NET-W003 (durable object store + authority-backed
 * reference repository; in-memory store from NET-W001 retained as a
 * test double behind the same port).
 */
export const objectStorageModule = defineBoundaryModule({
  name: "object-storage",
  tier: "infrastructure",
  summary:
    "large/immutable artifact storage referenced from PostgreSQL (NET-W003)",
});
