/**
 * ObjectStore contract — large/immutable artifact storage boundary.
 *
 * Work order ref: NET-W001 §4.1 (infrastructure boundary `object-storage`),
 * architecture-lock.md §3 (object storage holds large/immutable artifacts
 * referenced from PostgreSQL), §17 (large/immutable artifacts live outside
 * core relational rows).
 *
 * Concrete implementation lives in src/object-storage/. NET-W001 ships
 * a skeletal in-memory implementation sufficient to prove the boundary.
 * A real durable backend is the subject of NET-W003.
 */

export interface ObjectRef {
  readonly key: string;
  readonly bucket: string;
  readonly size: number;
  readonly contentType: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly immutable: true;
}

export interface ObjectStore {
  /** Store a buffer and return an immutable reference. */
  put(input: {
    readonly key: string;
    readonly body: Uint8Array | string;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<ObjectRef>;
  /** Retrieve an artifact. Returns null if absent. */
  get(key: string): Promise<{ readonly body: Uint8Array; readonly ref: ObjectRef } | null>;
  /** Retrieve metadata only (no body). */
  head(key: string): Promise<ObjectRef | null>;
  /** Check existence. */
  exists(key: string): Promise<boolean>;
}
