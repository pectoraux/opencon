/**
 * Persistence boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership), §19
 * (PostgreSQL is the authoritative application state in v1.0).
 * Authority: authoritative state (PostgreSQL in v1.0); transaction
 * boundaries; recovery; idempotency.
 *
 * NET-W001 shipped the boundary and contract only. NET-W003 ships
 * concrete authoritative persistence behavior: a file-backed authority
 * test double (proven by the PostgresAuthority contract), durable
 * transactions with real rollback/recovery, and idempotency.
 * No domain/economic behavior is created here (NET-W003 §5 non-goals).
 */

export interface PersistencePort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "persistence";
  /**
   * Boundary readiness. NET-W003 promotes this boundary from
   * "skeleton" to "concrete" — authoritative persistence, transactions,
   * recovery and idempotency are implemented behind the same ports.
   */
  readonly readiness: "concrete";
}
