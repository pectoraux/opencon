import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Identity boundary module.
 *
 * Authority: identity, roles and eligibility (architecture.md §18).
 * Concrete behaviour: NET-W002 (provider-neutral identity model,
 * PrincipalResolver authentication boundary, privacy-safe public views,
 * audit lineage for material identity mutations).
 *
 * `init` is idempotent and performs no economically/material state changes.
 * The domain services are wired by the bootstrap composition root, not by
 * module init (composition root imports concrete in-memory implementations
 * for wiring — the only place permitted to do so).
 */
export const identityModule = defineBoundaryModule({
  name: "identity",
  tier: "domain",
  summary: "identity, roles and eligibility (NET-W002: provider-neutral identity model + PrincipalResolver auth boundary)",
});
