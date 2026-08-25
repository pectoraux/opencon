/**
 * In-memory ObjectStore — skeletal boundary implementation.
 *
 * Work order ref: NET-W001 §6 (ObjectStore). A durable backend is the
 * subject of NET-W003; here we prove the boundary and contract.
 */

import { createHash } from "node:crypto";
import type { ObjectRef, ObjectStore } from "../core/object-store.ts";

interface StoredObject {
  readonly ref: ObjectRef;
  readonly body: Uint8Array;
}

export function createInMemoryObjectStore(
  bucket = "opencon-dev",
): ObjectStore & { _dump(): readonly ObjectRef[] } {
  const store = new Map<string, StoredObject>();

  function toBytes(body: Uint8Array | string): Uint8Array {
    return typeof body === "string" ? Buffer.from(body, "utf8") : body;
  }

  const impl: ObjectStore = {
    async put(input) {
      const body = toBytes(input.body);
      const hash = createHash("sha256").update(body).digest("hex");
      const ref: ObjectRef = {
        key: input.key,
        bucket,
        size: body.byteLength,
        contentType: input.contentType ?? "application/octet-stream",
        contentHash: hash,
        createdAt: new Date().toISOString(),
        immutable: true as const,
      };
      // Object store keys are immutable: a put to an existing key with a
      // different hash is rejected to preserve evidence integrity.
      const existing = store.get(input.key);
      if (existing && existing.ref.contentHash !== hash) {
        throw new Error(
          `object key "${input.key}" already exists with different content (immutable store)`,
        );
      }
      if (!existing) {
        store.set(input.key, { ref, body });
      }
      return ref;
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return { body: o.body, ref: o.ref };
    },
    async head(key) {
      return store.get(key)?.ref ?? null;
    },
    async exists(key) {
      return store.has(key);
    },
  };

  return Object.assign(impl, {
    _dump: () => Array.from(store.values()).map((o) => o.ref),
  });
}
