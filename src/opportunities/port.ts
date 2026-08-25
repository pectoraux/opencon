/**
 * Opportunities boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: opportunities and contribution submission state.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W004. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface OpportunitiesPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "opportunities";
  /**
   * Boundary readiness. Always "skeleton" until NET-W004
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
