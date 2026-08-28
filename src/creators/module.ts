import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Creators boundary module.
 * Authority: creator domain rules (NET-W015 — creator identity
 * anchors, provider-neutral platform references, audience metadata,
 * versioned commercial preferences, rights, restrictions,
 * availability, canonical reputation references; NET-W016 —
 * deterministic creator matching: hard-gate eligibility,
 * explicit-signal ranking, bounded AI advisory, append-only
 * match-run records; NET-W017 — UGC workflow and rights: the
 * workflow-mediated engagement lifecycle subject, deterministic
 * auto-accept, explicit/revocable usage rights with creator-retained
 * ownership, UGC production/deliverable/submission lineage;
 * NET-W018 — sponsorship and disclosure: explicit commercial
 * relationships (DISC-001), evidence-bound disclosure declarations
 * (CRE-006) and the publication lifecycle subject whose
 * DRAFT → VERIFIED transition is the derived disclosure gate).
 */
export const creatorsModule = defineBoundaryModule({
  name: "creators",
  tier: "domain",
  summary:
    "creator domain rules (NET-W015: profile anchors to canonical identity, provider-neutral platform references, privacy-minimized audience aggregates, versioned commercial preferences/rights/restrictions/availability, canonical reputation references; NET-W016: deterministic creator matching — hard-gate eligibility, explicit-signal ranking, bounded advisory, append-only match-run records; NET-W017: UGC workflow and rights — the engagement lifecycle subject kind (transitions through /workflows, the sole lifecycle authority), deterministic auto-accept policies, explicit scoped revocable usage rights with creator-retained ownership, UGC production/deliverable/submission records with canonical evidence lineage; NET-W018: sponsorship and disclosure — explicit commercial relationships with campaign/engagement/creator lineage and reference-only compensation, evidence-bound disclosure declarations, and the publication lifecycle subject kind whose DRAFT → VERIFIED transition is the derived disclosure gate (campaign policy ∪ relationship obligations, never caller claims))",
});
