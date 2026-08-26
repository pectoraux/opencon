/**
 * Observability boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership), §19.
 * Authority: structured logging, health/readiness/liveness, correlation,
 * trace/span lineage. NON-AUTHORITATIVE (coordination, not truth).
 *
 * NET-W001 shipped the structured logger + execution-context + health
 * aggregator. NET-W003 adds the TraceRecorder (span/trace correlation
 * lineage). No domain/economic behavior is created here (NET-W003 §5).
 */

export interface ObservabilityPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "observability";
  /**
   * Boundary readiness. NET-W003 adds the TraceRecorder; the NET-W001
   * structured logger + execution context + health aggregator remain.
   */
  readonly readiness: "concrete";
}
