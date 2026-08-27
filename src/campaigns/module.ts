import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Campaigns boundary module.
 * Authority: campaign domain rules (NET-W011 — campaign policy/
 * configuration: objectives, eligibility, outcome/evidence policy,
 * budgets, attribution rules, clearing rules, contribution
 * opportunity composition references).
 */
export const campaignsModule = defineBoundaryModule({
  name: "campaigns",
  tier: "domain",
  summary:
    "campaign domain rules (NET-W011: campaign policy/configuration — objectives, eligibility, outcome/evidence policy, budget declarations, attribution rules, clearing rules, opportunity composition references)",
});
