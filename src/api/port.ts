/**
 * Api boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: external application/API contract (versioned, provider-independent).
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W001. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface ApiPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "api";
  /**
   * Boundary readiness. Always "skeleton" until NET-W001
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
