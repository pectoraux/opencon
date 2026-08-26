/**
 * Queues boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership), §19
 * (Redis, queues and caches are coordination infrastructure and are
 * never authoritative). Authority: non-authoritative coordination
 * queues, distributed/worker locks, ephemeral coordination state.
 *
 * NET-W001 shipped the boundary and the in-memory JobQueue contract.
 * NET-W003 adds the `CoordinationService` contract (non-authoritative
 * locks + ephemeral state) and the `RedisCoordinationShim` test double.
 * No domain/economic behavior is created here (NET-W003 §5 non-goals).
 */

export interface QueuesPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "queues";
  /**
   * Boundary readiness. NET-W003 promotes this boundary from
   * "skeleton" to "concrete" — non-authoritative coordination
   * (locks, ephemeral state) is implemented behind the CoordinationService port.
   */
  readonly readiness: "concrete";
}
