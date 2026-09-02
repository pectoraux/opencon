import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Reputation boundary module.
 * Authority: reputation computation and provenance. Concrete behaviour:
 * NET-W007 (multidimensional inputs, versioned deterministic scoring
 * policies, time decay, append-only snapshots/history) + NET-W031
 * (additive: portable reputation proofs — derived, aggregate-disclosure
 * claims over recorded snapshots, signed through the composed W029
 * machinery and verified deterministically fail-closed).
 */
export const reputationModule = defineBoundaryModule({
  name: "reputation",
  tier: "domain",
  summary:
    "reputation computation and provenance (NET-W007: multidimensional dimensions, evidence-backed inputs, deterministic versioned scoring, time decay, auditable snapshots; NET-W031: portable reputation proofs — derived, privacy-preserving, deterministically verifiable)",
});
