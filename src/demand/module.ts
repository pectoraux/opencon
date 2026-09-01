import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Demand boundary module.
 * Authority: demand aggregation. NET-W024 implements the consumer
 * demand-pool domain inside this boundary: tenant-scoped pools and
 * consented commitments with the versioned provider-neutral
 * category/attribute vocabulary, deterministic privacy-preserving
 * aggregation behind the frozen disclosure floor, and the derived
 * qualified-aggregate supplier view (never stored, never
 * caller-asserted, zero economic surface). NET-W025 extends the SAME
 * boundary with business procurement pools: buyer-organization-
 * authorized commitments, competition-policy-governed aggregation
 * behind the frozen commitment floor AND the frozen
 * distinct-organization floor, and the derived supplier-facing
 * minimized demand view (bands/buckets/windows only — never exact
 * quantities, prices, budgets or timing). NET-W026 extends the SAME
 * boundary again with supplier offers and competitive selection:
 * authorized supplier offers against currently qualified demand,
 * server-derived hard eligibility, deterministic auditable selection
 * lineage, and W025 privacy intact. NET-W027 extends the SAME
 * boundary again with verified savings and counterfactuals:
 * evidence-backed explicit baselines (counterfactuals require
 * quantified uncertainty), authoritative /outcomes observations
 * consumed through neutral lookups, deterministic anchor-aware
 * derivation that fails closed on invalid, stale or insufficient
 * evidence, and immutable savings lineage. Still zero economic
 * surface (a verified savings claim is a measurement decision,
 * never an economic one); still no second demand/procurement
 * authority.
 */
export const demandModule = defineBoundaryModule({
  name: "demand",
  tier: "domain",
  summary:
    "demand aggregation (NET-W024: consumer demand pools; NET-W025: business procurement pools; NET-W026: supplier offers and competitive selection; NET-W027: verified savings and counterfactuals)",
});
