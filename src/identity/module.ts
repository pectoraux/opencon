import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Identity boundary module (skeletal).
 * Authority: identity, roles and eligibility. Concrete behaviour: NET-W002.
 */
export const identityModule = defineBoundaryModule({
  name: "identity",
  tier: "domain",
  summary: "identity, roles and eligibility (skeleton; NET-W002)",
});
