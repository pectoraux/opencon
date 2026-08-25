/**
 * Demand boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: demand aggregation.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W024. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface DemandPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "demand";
  /**
   * Boundary readiness. Always "skeleton" until NET-W024
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
