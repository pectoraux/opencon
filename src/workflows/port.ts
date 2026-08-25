/**
 * Workflows boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: authoritative lifecycle transitions and orchestration.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W004. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface WorkflowsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "workflows";
  /**
   * Boundary readiness. Always "skeleton" until NET-W004
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
