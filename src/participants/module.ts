import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Participants boundary module.
 *
 * Authority: participant identity, roles, policies, reputation references
 * and economic accounts (architecture.md §18). NET-W002 implements
 * participant roles (v1.0), the PolicyRepository, and the server-side
 * AuthorizationService (deny-by-default; client claims never trusted).
 *
 * Reputation references and economic accounts remain deferred to later
 * work items (§5 non-goals).
 */
export const participantsModule = defineBoundaryModule({
  name: "participants",
  tier: "domain",
  summary: "participant identity, roles, policies, reputation references and economic accounts (NET-W002: roles + PolicyRepository + AuthorizationService)",
});
