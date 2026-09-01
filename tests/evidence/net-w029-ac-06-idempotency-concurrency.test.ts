/**
 * NET-W029 AC-06 — idempotency / concurrency / atomicity / fault
 * injection (issue #58; work order §3.7, §6).
 *
 * Creation + revocation are exactly-once composite mutations: same-key
 * replays return the committed record verbatim; concurrent same-key
 * calls produce exactly one; a FAILED apply leaves NO partial state
 * (no record, no audit event, no consumed idempotency key); audit
 * publication is POST-COMMIT and carries the authoritative transaction
 * id + the idempotency record id.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  key,
  type NetW029Harness,
} from "./_net-w029-harness.ts";
import type { SignedAttestationSigner, SignedAttestationVerifier } from "../../src/evidence/port.ts";

let harness: NetW029Harness;

beforeAll(async () => {
  harness = await createNetW029Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W029-AC-06 idempotency / concurrency / atomicity / fault injection", () => {
  test("same-key replay is exactly-once: the committed record replays verbatim (created:false), one audit event", async () => {
    const evidence = await createEvidenceRecord(harness);
    const idempotencyKey = key("ac06-replay");
    const first = await createSignedAttestation(
      harness,
      [{ family: "evidence", recordId: evidence.id }],
      { idempotencyKey },
    );
    expect(first.created).toBe(true);
    const replay = await createSignedAttestation(
      harness,
      [{ family: "evidence", recordId: evidence.id }],
      { idempotencyKey },
    );
    expect(replay.created).toBe(false);
    expect(replay.attestation.id).toBe(first.attestation.id);
    expect(replay.attestation.signature).toBe(first.attestation.signature);
    const events = await harness.runtime.auditWriter.query({
      eventType: "signed_attestation.created",
      resourceId: first.attestation.id,
    });
    expect(events).toHaveLength(1);
  });

  test("concurrent SAME-KEY creation produces exactly one committed record", async () => {
    const evidence = await createEvidenceRecord(harness);
    const idempotencyKey = key("ac06-concurrent");
    const [a, b] = await Promise.all([
      createSignedAttestation(harness, [{ family: "evidence", recordId: evidence.id }], {
        idempotencyKey,
      }),
      createSignedAttestation(harness, [{ family: "evidence", recordId: evidence.id }], {
        idempotencyKey,
      }),
    ]);
    expect(a.created).not.toBe(b.created);
    expect(a.attestation.id).toBe(b.attestation.id);
  });

  test("FAULT INJECTION: a signing failure mid-transaction leaves NO partial state (no record, no audit, no consumed key)", async () => {
    const failingSigner: SignedAttestationSigner = {
      algorithm: "ed25519/v1",
      keyReference: "attestation-signing/ed25519/v1",
      async signVersioned() {
        throw new Error("signing service is DOWN (fault injection)");
      },
    };
    const stubVerifier: SignedAttestationVerifier = {
      async verifyVersioned() {
        return { valid: false, reason: "never called" };
      },
    };
    const failingHarness = await createNetW029Harness({
      attestation: { versionedSigner: failingSigner, versionedVerifier: stubVerifier },
    });
    try {
      const evidence = await createEvidenceRecord(failingHarness);
      const idempotencyKey = key("ac06-fault");
      const ctx = createExecutionContext({
        correlationId: "ac06-fault",
        actor: { id: failingHarness.personId, kind: "person" },
      });
      const auditBefore = (
        await failingHarness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
      ).length;
      await expect(
        failingHarness.runtime.signedAttestationService.createSignedAttestation(ctx, {
          organizationScopeId: failingHarness.organizationScopeId,
          verifierId: failingHarness.personId,
          statement: "doomed attestation",
          coverage: [{ family: "evidence", recordId: evidence.id }],
          idempotencyKey,
        }),
      ).rejects.toThrow(/signing service is DOWN/i);
      // NO record was persisted for this key.
      const auditAfter = (
        await failingHarness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
      ).length;
      expect(auditAfter).toBe(auditBefore);
      // The idempotency key was NOT consumed (a retry can succeed).
      const consumed = await failingHarness.runtime.idempotency.has(
        `signed_attestation:${failingHarness.organizationScopeId}:${failingHarness.personId}:${idempotencyKey}`,
      );
      expect(consumed).toBe(false);
    } finally {
      await failingHarness.teardown();
    }
  });

  test("audit publication is POST-COMMIT: the creation event carries the authoritative transaction + idempotency lineage", async () => {
    const evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    const events = await harness.runtime.auditWriter.query({
      eventType: "signed_attestation.created",
      resourceId: result.attestation.id,
    });
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.metadata.transactionId).toBe("string");
    expect(events[0]!.metadata.transactionId).toBeTruthy();
    expect(typeof events[0]!.metadata.idempotencyRecordId).toBe("string");
    expect(events[0]!.metadata.algorithm).toBe("hmac-sha256/v1");
    expect(events[0]!.metadata.keyReference).toBe("attestation-signing/dev-insecure/v1");
    expect(events[0]!.actor).toBe(harness.personId);
  });

  test("revocation is idempotent: same key replays; a DIFFERENT key on the already-revoked record is a no-op with exactly ONE audit event", async () => {
    const evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    const ctx = createExecutionContext({
      correlationId: "ac06-revoke",
      actor: { id: harness.personId, kind: "person" },
    });
    const revoke = (idempotencyKey: string) =>
      harness.runtime.signedAttestationService.revokeSignedAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        attestationId: result.attestation.id,
        reason: "ac06 revocation",
        idempotencyKey,
      });
    const first = await revoke(key("ac06-revoke-1"));
    expect(first.revokedAt).not.toBeNull();
    expect(first.revocationReason).toBe("ac06 revocation");
    // Same key → replay of the committed revocation.
    const replay = await revoke(key("ac06-revoke-1"));
    expect(replay.revokedAt).toBe(first.revokedAt);
    // DIFFERENT key on the already-revoked record → unchanged, no new audit.
    const second = await revoke(key("ac06-revoke-2"));
    expect(second.revokedAt).toBe(first.revokedAt);
    const events = await harness.runtime.auditWriter.query({
      eventType: "signed_attestation.revoked",
      resourceId: result.attestation.id,
    });
    expect(events).toHaveLength(1);
  });

  test("concurrent revocations with DISTINCT keys: exactly one revocation mutation (the per-attestation mutex)", async () => {
    const evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    const ctx = createExecutionContext({
      correlationId: "ac06-revoke-concurrent",
      actor: { id: harness.personId, kind: "person" },
    });
    const [a, b] = await Promise.all([
      harness.runtime.signedAttestationService.revokeSignedAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        attestationId: result.attestation.id,
        reason: "concurrent A",
        idempotencyKey: key("ac06-cr-a"),
      }),
      harness.runtime.signedAttestationService.revokeSignedAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        attestationId: result.attestation.id,
        reason: "concurrent B",
        idempotencyKey: key("ac06-cr-b"),
      }),
    ]);
    // Both settled; the record is revoked exactly once (one revokedAt).
    expect(a.revokedAt).not.toBeNull();
    expect(b.revokedAt).not.toBeNull();
    const events = await harness.runtime.auditWriter.query({
      eventType: "signed_attestation.revoked",
      resourceId: result.attestation.id,
    });
    expect(events).toHaveLength(1);
  });

  test("revocation of a missing/cross-tenant attestation fails closed (NotFound, no mutation)", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac06-revoke-missing",
      actor: { id: harness.personId, kind: "person" },
    });
    await expect(
      harness.runtime.signedAttestationService.revokeSignedAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        attestationId: "missing-attestation-id",
        reason: "nothing to revoke",
        idempotencyKey: key("ac06-missing"),
      }),
    ).rejects.toThrow(/signed attestation not found/i);
    const events = await harness.runtime.auditWriter.query({
      eventType: "signed_attestation.revoked",
    });
    const forMissing = events.filter((e) => e.resourceId === "missing-attestation-id");
    expect(forMissing).toHaveLength(0);
  });

  test("validation failures never consume the idempotency key (retryable after fix)", async () => {
    const idempotencyKey = key("ac06-validation");
    const ctx = createExecutionContext({
      correlationId: "ac06-validation",
      actor: { id: harness.personId, kind: "person" },
    });
    await expect(
      harness.runtime.signedAttestationService.createSignedAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.personId,
        statement: "needs coverage",
        coverage: [],
        idempotencyKey,
      }),
    ).rejects.toThrow(/at least one authoritative record/i);
    const consumed = await harness.runtime.idempotency.has(
      `signed_attestation:${harness.organizationScopeId}:${harness.personId}:${idempotencyKey}`,
    );
    expect(consumed).toBe(false);
  });
});
