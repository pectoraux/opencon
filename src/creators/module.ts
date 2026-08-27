import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Creators boundary module.
 * Authority: creator domain rules (NET-W015 — creator identity
 * anchors, provider-neutral platform references, privacy-minimized
 * audience metadata, versioned commercial preferences, rights,
 * restrictions, availability, canonical reputation references).
 */
export const creatorsModule = defineBoundaryModule({
  name: "creators",
  tier: "domain",
  summary:
    "creator domain rules (NET-W015: profile anchors to canonical identity, provider-neutral platform references, privacy-minimized audience aggregates, versioned commercial preferences/rights/restrictions/availability, canonical reputation references)",
});
