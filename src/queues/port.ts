/**
 * Queues boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: non-authoritative coordination queues.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W003. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface QueuesPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "queues";
  /**
   * Boundary readiness. Always "skeleton" until NET-W003
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
