import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Audit boundary module (skeletal).
 * Authority: append-oriented auditability boundary. Concrete behaviour: NET-W001.
 */
export const auditModule = defineBoundaryModule({
  name: "audit",
  tier: "infrastructure",
  summary: "append-oriented auditability boundary (skeleton; NET-W001)",
});
