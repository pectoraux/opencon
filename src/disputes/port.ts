/**
 * Disputes boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: challenges, disputes, appeals and penalties.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W010. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface DisputesPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "disputes";
  /**
   * Boundary readiness. Always "skeleton" until NET-W010
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
