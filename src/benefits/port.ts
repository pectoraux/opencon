/**
 * Benefits boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: benefit allocation.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W028. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface BenefitsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "benefits";
  /**
   * Boundary readiness. Always "skeleton" until NET-W028
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
