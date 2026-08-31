import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Campaigns boundary module.
 * Authority: campaign domain rules (NET-W011 — campaign policy/
 * configuration: objectives, eligibility, outcome/evidence policy,
 * budgets, attribution rules, clearing rules, contribution
 * opportunity composition references; NET-W021 — campaign matching
 * and optimization: SELECTION, not authority — hard eligibility
 * gates, evidence-backed ranking, bounded AI advisory and
 * explainable candidate ordering over W019 inventory supply).
 */
export const campaignsModule = defineBoundaryModule({
  name: "campaigns",
  tier: "domain",
  summary:
    "campaign domain rules (NET-W011: campaign policy/configuration — objectives, eligibility, outcome/evidence policy, budget declarations, attribution rules, clearing rules, opportunity composition references; NET-W021: campaign matching and optimization — hard gates, evidence-backed ranking, bounded AI advisory, explainable ordering; selection, not authority)",
});
