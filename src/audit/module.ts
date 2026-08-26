import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Audit boundary module.
 * Authority: append-oriented auditability boundary; material-mutation
 * tracing. Concrete behaviour: NET-W001 (append-only writer + deep
 * immutability), NET-W002 (identity/org/participant/authorization
 * lineage), NET-W003 (transactional audit writer + durable-state
 * transaction/object-reference lineage).
 */
export const auditModule = defineBoundaryModule({
  name: "audit",
  tier: "infrastructure",
  summary:
    "append-oriented auditability + material-mutation tracing (NET-W001 + NET-W002 + NET-W003)",
});
