import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Inventory boundary module.
 * Authority: inventory domain rules (NET-W019: supply registration
 * with explicit ownership, placement context with policy scoping +
 * provenance, server-enforced supply authorization, and the derived
 * settlement-readiness source-context gate).
 */
export const inventoryModule = defineBoundaryModule({
  name: "inventory",
  tier: "domain",
  summary: "inventory domain rules (NET-W019: inventory and placements)",
});
