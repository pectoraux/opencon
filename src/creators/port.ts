/**
 * Creators boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: creator domain rules.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W015. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface CreatorsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "creators";
  /**
   * Boundary readiness. Always "skeleton" until NET-W015
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
