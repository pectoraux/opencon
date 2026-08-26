/**
 * Object-storage boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18, §19 (object storage holds
 * large/immutable artifacts referenced from PostgreSQL). Authority:
 * durable large/immutable artifact references (in PostgreSQL authority);
 * artifact bytes (in object storage).
 *
 * NET-W001 shipped the boundary and the in-memory ObjectStore contract.
 * NET-W003 adds the durable object store (file-backed test double) and
 * the ObjectReferenceRepository (authority-backed durable references).
 * No domain/economic behavior is created here (NET-W003 §5 non-goals).
 */

export interface ObjectStoragePort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "object-storage";
  /**
   * Boundary readiness. NET-W003 promotes this boundary from
   * "skeleton" to "concrete" — durable object storage + durable
   * references are implemented behind the same ports.
   */
  readonly readiness: "concrete";
}
