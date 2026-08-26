/**
 * Audit boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership),
 * §19. Authority: append-oriented auditability boundary; material-
 * mutation tracing (durable-state transaction + object-store reference
 * lineage).
 *
 * NET-W001 shipped the append-only AuditWriter contract + in-memory
 * and file-backed writers. NET-W002 emitted identity/organization/
 * participant/authorization audit events with actor/subject/resource
 * lineage. NET-W003 makes audit writes participate transactionally in
 * the material mutations they describe (atomicity: audit + mutation
 * commit together, or both roll back) and records durable-state
 * transaction/object-reference lineage.
 */

export interface AuditPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "audit";
  /**
   * Boundary readiness. NET-W003 adds the transactional audit writer
   * and material-mutation tracing; the NET-W001/NET-W002 append-only
   * + identity-lineage behaviour is preserved unchanged.
   */
  readonly readiness: "concrete";
}
