/**
 * Reputation boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: reputation computation and provenance.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W007. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface ReputationPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "reputation";
  /**
   * Boundary readiness. Always "skeleton" until NET-W007
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
