import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Evidence boundary module (skeletal).
 * Authority: evidence and evidence provenance, confidence and verification. Concrete behaviour: NET-W005.
 */
export const evidenceModule = defineBoundaryModule({
  name: "evidence",
  tier: "domain",
  summary: "evidence and evidence provenance, confidence and verification (skeleton; NET-W005)",
});
