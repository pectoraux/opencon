import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Opportunities boundary module.
 *
 * Authority (architecture §18): `/opportunities` owns the Opportunity
 * entity and its business rules. Lifecycle mutation authority is
 * delegated to `/workflows` (work order §4.1).
 *
 * Concrete behaviour introduced in NET-W004:
 *  - Opportunity first-class model (stable id, org/participant owner,
 *    opportunity type, brief, eligibility policy reference, contribution
 *    requirements, lifecycle state, version, lineage, timestamps);
 *  - Authority-backed repository (PostgresAuthority boundary from
 *    NET-W003);
 *  - OpportunityService (createOpportunity → DRAFT, getOpportunity,
 *    updateBrief — never mutates lifecycle state directly).
 *
 * Out of scope (NET-W004 §5): no economic value, reputation, settlement,
 * fraud, evidence evaluation or Proof-of-Value.
 */
export const opportunitiesModule = defineBoundaryModule({
  name: "opportunities",
  tier: "domain",
  summary:
    "opportunities and contribution submission state (NET-W004: Opportunity " +
    "first-class model + authority-backed repository + OpportunityService; " +
    "lifecycle transitions delegated to /workflows)",
});
