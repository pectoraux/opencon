import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Organizations boundary module.
 *
 * Authority: organization membership and eligibility (architecture.md §18).
 * Concrete behaviour: NET-W002 (organization records, explicit membership
 * records, membership lifecycle with idempotent grant/revoke, audit lineage).
 */
export const organizationsModule = defineBoundaryModule({
  name: "organizations",
  tier: "domain",
  summary: "organization membership and eligibility (NET-W002: organization records + membership lifecycle)",
});
