import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Demand boundary module.
 * Authority: demand aggregation. NET-W024 implements the consumer
 * demand-pool domain inside this boundary: tenant-scoped pools and
 * consented commitments with the versioned provider-neutral
 * category/attribute vocabulary, deterministic privacy-preserving
 * aggregation behind the frozen disclosure floor, and the derived
 * qualified-aggregate supplier view (never stored, never
 * caller-asserted, zero economic surface).
 */
export const demandModule = defineBoundaryModule({
  name: "demand",
  tier: "domain",
  summary: "demand aggregation (NET-W024: consumer demand pools)",
});
