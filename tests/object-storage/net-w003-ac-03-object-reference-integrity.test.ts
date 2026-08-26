/**
 * NET-W003-AC-03 — Object-storage reference integrity.
 *
 * Evidence: integration test proving large artifacts live in object
 * storage; the PostgreSQL authority records durable REFERENCES (not
 * opaque giant blobs); retrieval verifies content integrity.
 *
 * architecture-lock §17: large/immutable artifacts live outside core
 * relational rows and are referenced durably.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DurableObjectStore, createPostgresObjectReferenceRepository } from "../../src/object-storage/durable-object-store.ts";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let authDir: string;
let objDir: string;
let authority: PostgresAuthorityShim;
let store: DurableObjectStore;

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), "opencon-obj-auth-"));
  objDir = mkdtempSync(join(tmpdir(), "opencon-obj-bytes-"));
  authority = new PostgresAuthorityShim({ dir: authDir });
  store = new DurableObjectStore({ dir: objDir, bucket: "opencon-test" });
});

afterEach(() => {
  rmSync(authDir, { recursive: true, force: true });
  rmSync(objDir, { recursive: true, force: true });
});

describe("NET-W003-AC-03 object-storage reference integrity", () => {
  test("large artifact bytes live in object storage, NOT in the authority", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-bytes" });
    const refs = createPostgresObjectReferenceRepository({ authority });
    await authority.recover();

    // A 64KB artifact — large enough to prove it lives outside the DB.
    const big = Buffer.alloc(64 * 1024, 0x42);
    big.write("PAYLOAD-START", 0, "utf8");
    big.write("PAYLOAD-END", big.length - 11, "utf8");

    const ref = await store.put({ key: "artifact-1", body: big, contentType: "application/octet-stream" });
    expect(ref.size).toBe(64 * 1024);

    // Record the durable reference in the authority WITHIN a transaction.
    await authority.run(ctx, async (tx) => {
      await refs.record(tx, ref, { source: "evidence" }, ctx);
    });

    // The authority holds a reference — NOT the bytes.
    const lookup = await refs.lookup("artifact-1");
    expect(lookup).not.toBeNull();
    expect(lookup!.size).toBe(64 * 1024);
    expect(lookup!.bucket).toBe("opencon-test");
    expect(lookup!.metadata.source).toBe("evidence");
    expect(lookup!.executionId).toBe(ctx.executionId);
    expect(lookup!.correlationId).toBe("ac03-bytes");

    // Prove the authority does NOT contain the byte payload: the value
    // stored under object_references does NOT include the raw bytes
    // (the reference record holds metadata + a content hash, not the
    // 64KB blob).
    const storedValue = (await authority.get("object_references", "artifact-1"))?.value as {
      size: number;
      contentHash: string;
    };
    expect(storedValue.size).toBe(64 * 1024);
    expect(storedValue.contentHash).toBe(ref.contentHash);
    // The serialized authority record must be far smaller than the 64KB
    // blob (proving the bytes are not inlined into the DB).
    const serialized = JSON.stringify(storedValue);
    expect(serialized.length).toBeLessThan(2_000);

    // The bytes live on disk in the object-storage dir.
    const recovered = await store.get("artifact-1");
    expect(recovered).not.toBeNull();
    expect(recovered!.body.length).toBe(64 * 1024);
    expect(Buffer.from(recovered!.body.slice(0, 13)).toString("utf8")).toBe("PAYLOAD-START");
  });

  test("retrieval verifies content integrity (hash mismatch rejected)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-integrity" });
    const refs = createPostgresObjectReferenceRepository({ authority });
    await authority.recover();

    const body = Buffer.from("evidence-payload-v1", "utf8");
    const ref = await store.put({ key: "artifact-2", body });
    await authority.run(ctx, async (tx) => {
      await refs.record(tx, ref, {}, ctx);
    });

    // Correct hash: lookup succeeds.
    const ok = await refs.lookup("artifact-2", { expectedContentHash: ref.contentHash });
    expect(ok).not.toBeNull();
    expect(ok!.contentHash).toBe(ref.contentHash);

    // Stale / mismatched hash: lookup returns null (integrity violation).
    const stale = await refs.lookup("artifact-2", { expectedContentHash: "deadbeef" });
    expect(stale).toBeNull();

    // No expected hash provided: lookup returns the stored reference
    // (the caller can re-verify by recomputing the bytes' hash).
    const plain = await refs.lookup("artifact-2");
    expect(plain?.contentHash).toBe(ref.contentHash);
  });

  test("recomputing the bytes' hash matches the stored reference hash", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-recompute" });
    const refs = createPostgresObjectReferenceRepository({ authority });
    await authority.recover();
    const body = Buffer.from("hello world", "utf8");
    const ref = await store.put({ key: "artifact-3", body });
    await authority.run(ctx, async (tx) => {
      await refs.record(tx, ref, {}, ctx);
    });
    const retrieved = await store.get("artifact-3");
    expect(retrieved).not.toBeNull();
    // Recompute the hash of the retrieved bytes and assert it matches
    // the stored reference hash.
    const { createHash } = await import("node:crypto");
    const recomputed = createHash("sha256").update(retrieved!.body).digest("hex");
    expect(recomputed).toBe(ref.contentHash);
    const lookup = await refs.lookup("artifact-3");
    expect(lookup?.contentHash).toBe(recomputed);
  });

  test("immutability: a put to an existing key with different content is rejected", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-immutable" });
    const refs = createPostgresObjectReferenceRepository({ authority });
    await authority.recover();
    await store.put({ key: "artifact-4", body: "v1" });
    await expect(store.put({ key: "artifact-4", body: "v2" })).rejects.toThrow(
      /already exists with different content/i,
    );
    // Same content is idempotent (no throw).
    const ref2 = await store.put({ key: "artifact-4", body: "v1" });
    expect(ref2.contentHash).toBeTruthy();
    const ref = await store.put({ key: "artifact-4", body: "v1" });
    await authority.run(ctx, async (tx) => {
      await refs.record(tx, ref, {}, ctx);
    });
    expect(await refs.count()).toBe(1);
  });

  test("durable references survive restart (in the authority)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-durable" });
    const refs = createPostgresObjectReferenceRepository({ authority });
    await authority.recover();
    const ref = await store.put({ key: "artifact-5", body: "persist-me" });
    await authority.run(ctx, async (tx) => {
      await refs.record(tx, ref, { kind: "evidence" }, ctx);
    });
    await authority.close();
    // Restart the authority — the reference survives.
    const recovered = new PostgresAuthorityShim({ dir: authDir });
    await recovered.recover();
    const recoveredRefs = createPostgresObjectReferenceRepository({ authority: recovered });
    const lookup = await recoveredRefs.lookup("artifact-5");
    expect(lookup).not.toBeNull();
    expect(lookup!.metadata.kind).toBe("evidence");
    expect(lookup!.contentHash).toBe(ref.contentHash);
    // The bytes survive too (object storage is file-backed).
    const retrieved = await store.get("artifact-5");
    expect(retrieved).not.toBeNull();
    expect(Buffer.from(retrieved!.body).toString("utf8")).toBe("persist-me");
  });
});
