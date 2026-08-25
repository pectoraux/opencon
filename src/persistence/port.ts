/**
 * Persistence boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: authoritative state (PostgreSQL in v1.0); transaction boundaries.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W003. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface PersistencePort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "persistence";
  /**
   * Boundary readiness. Always "skeleton" until NET-W003
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
