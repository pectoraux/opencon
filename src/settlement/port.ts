/**
 * Settlement boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: credits, pending/mature value, cash/credit settlement.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W008. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface SettlementPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "settlement";
  /**
   * Boundary readiness. Always "skeleton" until NET-W008
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
