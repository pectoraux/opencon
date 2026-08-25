import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Participants boundary module (skeletal).
 * Authority: participant identity, roles, policies, reputation references and economic accounts. Concrete behaviour: NET-W002.
 */
export const participantsModule = defineBoundaryModule({
  name: "participants",
  tier: "domain",
  summary: "participant identity, roles, policies, reputation references and economic accounts (skeleton; NET-W002)",
});
