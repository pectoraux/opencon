/**
 * Campaigns boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: campaign domain rules.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete domain
 * behaviour is deferred to NET-W011. This port is
 * intentionally a contract surface, not an implementation; no
 * economically/material state is created here (work order §5).
 */

export interface CampaignsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "campaigns";
  /**
   * Boundary readiness. Always "skeleton" until NET-W011
   * ships concrete behaviour.
   */
  readonly readiness: "skeleton";
}
