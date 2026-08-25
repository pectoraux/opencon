import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Api boundary module.
 *
 * Authority: external application/API contract (versioned, provider-
 * independent) (architecture.md §18). NET-W002 extends the API boundary
 * with protected endpoints + an auth guard (deny-by-default; client
 * claims never trusted) for identity/organization/membership mutations
 * (§4.6, API-AC-02).
 */
export const apiModule = defineBoundaryModule({
  name: "api",
  tier: "infrastructure",
  summary: "external application/API contract (versioned, provider-independent) (NET-W002: protected endpoints + auth guard)",
});
