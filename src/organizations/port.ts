/**
 * Organizations boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: organization membership and eligibility.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W002. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface OrganizationsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "organizations";
  /**
   * Boundary readiness. Always "skeleton" until NET-W002
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
