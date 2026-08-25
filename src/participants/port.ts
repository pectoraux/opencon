/**
 * Participants boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: participant identity, roles, policies, reputation references and economic accounts.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W002. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface ParticipantsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "participants";
  /**
   * Boundary readiness. Always "skeleton" until NET-W002
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
