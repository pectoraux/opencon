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

/**
 * ObjectReferenceRepository — durable references to large/immutable
 * artifacts, stored in the PostgreSQL authority (NOT opaque giant blobs).
 *
 * Work order ref: NET-W003 §4.3 (Object storage with durable references),
 * AC-03, architecture-lock §17 (large/immutable artifacts live outside
 * core relational rows and are referenced durably).
 *
 * The object store holds artifact bytes; the authority holds a durable
 * reference (key, bucket, size, content hash, created-at, immutable
 * marker) plus metadata. Retrieval verifies content integrity: the stored
 * content hash MUST match the artifact bytes returned by the object store.
 *
 * A reference whose stored content hash does not match the artifact bytes
 * is REJECTED on retrieval — evidence integrity is preserved.
 */
export interface ObjectReferenceRecord {
  readonly key: string;
  readonly bucket: string;
  readonly size: number;
  readonly contentType: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly immutable: true;
  readonly metadata: Readonly<Record<string, string>>;
  readonly executionId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly recordId: string;
}

export interface ObjectReferenceRepository {
  /** Record a durable reference (within an authoritative transaction). */
  record(
    tx: import("./postgres-authority.ts").AuthorityTransaction,
    ref: ObjectRef,
    metadata: Readonly<Record<string, string>>,
    execution: import("./execution-context.ts").ExecutionContext,
  ): Promise<ObjectReferenceRecord>;
  /**
   * Look up a durable reference by key. Returns null when absent.
   * Integrity check: when `expectedContentHash` is provided, the stored
   * reference's `contentHash` MUST match; a mismatch returns null
   * (integrity violation — the reference is considered corrupted).
   */
  lookup(
    key: string,
    options?: { readonly expectedContentHash?: string },
  ): Promise<ObjectReferenceRecord | null>;
  /** List all durable references (for tests). */
  list(): Promise<readonly ObjectReferenceRecord[]>;
  /** Count of durable references (for integrity tests). */
  count(): Promise<number>;
}
