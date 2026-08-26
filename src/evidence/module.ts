import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Evidence boundary module.
 * Authority: evidence and evidence provenance, grades, confidence,
 * commitments, attestations, aggregation, outcome claims, and the
 * Proof-of-Value foundation (NET-W005). Lifecycle transitions for
 * Proof-of-Value objects are owned by /workflows (the SOLE lifecycle
 * authority); this boundary validates domain preconditions.
 */
export const evidenceModule = defineBoundaryModule({
  name: "evidence",
  tier: "domain",
  summary:
    "evidence provenance, grades, confidence, commitments, attestations, aggregation and the Proof-of-Value foundation (NET-W005)",
});
