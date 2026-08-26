import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Outcomes boundary module.
 * Authority: outcome evaluation and measurement semantics (NET-W006):
 * first-class immutable/append-corrected outcome observations, distinct
 * deterministic/probabilistic/experimental attribution representation,
 * experiments/holdouts + incrementality with derived causal status,
 * explicit counterfactual/baselines, and the measured-outcome
 * maturation lifecycle (DRAFT → MEASURING → VERIFIED via /workflows —
 * the SOLE lifecycle authority). Measurement establishes facts and
 * their uncertainty; it NEVER creates economic authority.
 */
export const outcomesModule = defineBoundaryModule({
  name: "outcomes",
  tier: "domain",
  summary:
    "outcome evaluation and measurement semantics: observations, attribution, experiments/incrementality, counterfactual baselines and the maturation lifecycle (NET-W006)",
});
