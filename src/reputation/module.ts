import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Reputation boundary module.
 * Authority: reputation computation and provenance. Concrete behaviour:
 * NET-W007 (multidimensional inputs, versioned deterministic scoring
 * policies, time decay, append-only snapshots/history).
 */
export const reputationModule = defineBoundaryModule({
  name: "reputation",
  tier: "domain",
  summary:
    "reputation computation and provenance (NET-W007: multidimensional dimensions, evidence-backed inputs, deterministic versioned scoring, time decay, auditable snapshots)",
});
