/**
 * Secrets boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: secrets isolation boundary.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W001. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface SecretsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "secrets";
  /**
   * Boundary readiness. Always "skeleton" until NET-W001
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
