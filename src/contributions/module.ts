import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Contributions boundary module.
 *
 * Authority (architecture §18): `/contributions` owns the Contribution
 * entity. Lifecycle mutation authority is delegated to `/workflows`
 * (work order §4.1).
 *
 * Concrete behaviour introduced in NET-W004:
 *  - Contribution first-class model (stable id, opportunity reference,
 *    contributor reference, contribution type, submission, evidence-
 *    reference placeholders, lifecycle state, version, lineage,
 *    timestamps);
 *  - Authority-backed repository (PostgresAuthority boundary from
 *    NET-W003);
 *  - ContributionService (createContribution → DRAFT, getContribution —
 *    enforces the AC-02 invariant: a contribution belongs to exactly
 *    one opportunity + one contributor; never mutates lifecycle state
 *    directly).
 *
 * Out of scope (NET-W004 §5): no evidence evaluation or Proof-of-Value,
 * no outcome/measurement, no reputation, no settlement.
 */
export const contributionsModule = defineBoundaryModule({
  name: "contributions",
  tier: "domain",
  summary:
    "contribution lifecycle and submission state (NET-W004: Contribution " +
    "first-class model + authority-backed repository + ContributionService; " +
    "lifecycle transitions delegated to /workflows)",
});
