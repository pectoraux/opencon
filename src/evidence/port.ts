/**
 * Evidence boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: evidence and evidence provenance, confidence and verification.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W005. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface EvidencePort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "evidence";
  /**
   * Boundary readiness. Always "skeleton" until NET-W005
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
