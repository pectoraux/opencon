# `object-storage` boundary

**Tier:** infrastructure  
**Authority:** large/immutable artifact storage referenced from PostgreSQL  
**Architecture ref:** `spec/architecture.md` §18, §19 (object storage holds
large/immutable artifacts referenced from PostgreSQL);
`spec/architecture-lock.md` §17 (large/immutable artifacts live outside
core relational rows and are referenced durably)  
**Concrete behaviour:** NET-W003

## Scope in NET-W003

NET-W003 promotes this boundary from "skeleton" to "concrete". It ships:

- **`ObjectReferenceRepository` contract** (`src/core/object-store.ts`,
  extended) — durable references to large artifacts, stored in the
  PostgreSQL authority (NOT opaque giant blobs).
- **`DurableObjectStore`** (`src/object-storage/durable-object-store.ts`) —
  a file-backed test double that stores artifact BYTES on the filesystem
  (content-addressed by SHA-256). The authority holds a durable
  REFERENCE (key, bucket, size, content hash, created-at, immutable
  marker) plus metadata — NEVER the bytes themselves.
- **`createPostgresObjectReferenceRepository`** — authority-backed
  reference repository. Retrieval verifies content integrity: the
  recomputed SHA-256 of the retrieved bytes MUST match the stored
  reference's `contentHash`. A mismatched reference is rejected.

The NET-W001 in-memory `ObjectStore` remains a test double behind the
same port.

## Integrity invariant

Large/immutable artifacts live OUTSIDE core relational rows
(architecture-lock §17). The authority records durable references only.
A reference whose stored `contentHash` does not match the artifact bytes
is REJECTED on retrieval — evidence integrity is preserved.

## Dependencies

`core` contracts only. A real object-storage backend (S3/GCS/Azure-Blob)
is an adapter concern for a later work item and is forbidden by the
architecture check (only `zod` external package allowed).
