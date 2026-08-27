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
 * Concrete behaviour introduced in NET-W012 (helpful contributions —
 * spec/work-orders/NET-W012.md):
 *  - The structured helpful submission semantics on the opaque W004
 *    extension points (no new LifecycleSubjectKind; the Contribution
 *    remains the workflow-lifecycle subject);
 *  - The versioned helpfulness-policy lineage (deterministic
 *    usefulness criteria) and the Proof-of-Helpfulness domain
 *    aggregate (mentions recorded but never qualifying; advisory
 *    model/heuristic scores never qualifying; qualifying bases
 *    re-resolved through the truth-authority lookups at evaluation);
 *  - First-class auditable commercial disclosures;
 *  - The user-controlled publication gate (protocol preparation never
 *    publishes; only the contributor publishes, through /workflows at
 *    the composition root);
 *  - The first fail-closed consumer of the NET-W011
 *    eligibility-policy reference.
 */
export const contributionsModule = defineBoundaryModule({
  name: "contributions",
  tier: "domain",
  summary:
    "contribution lifecycle and submission state (NET-W004: Contribution " +
    "first-class model + authority-backed repository + ContributionService; " +
    "lifecycle transitions delegated to /workflows. NET-W012: helpful " +
    "contributions — structured helpful submissions, versioned helpfulness " +
    "policy, the Proof-of-Helpfulness aggregate with evidenced qualifying " +
    "bases, first-class commercial disclosures, user-controlled " +
    "publication, and fail-closed campaign-eligibility enforcement)",
});
