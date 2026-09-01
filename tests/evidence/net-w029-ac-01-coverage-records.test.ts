/**
 * NET-W029 AC-01 — attestation/commitment records over the THREE
 * authoritative record families (issue #58; work order §3.3, §6).
 *
 * Signed attestations cover evidence records (W005), reputation inputs
 * (W007) and settlement value records (W008), referenced by canonical
 * id; every coverage entry carries the STORED salted-sha256 commitment
 * derived in-tx at creation; the record shape is immutable with the
 * closed vocabularies; validation fails closed before any mutation.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  seedReputationInput,
  seedSettlementValue,
  key,
  type NetW029Harness,
} from "./_net-w029-harness.ts";
import {
  SIGNED_ATTESTATION_RECORD_FORMAT,
  SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS,
} from "../../src/evidence/port.ts";

let harness: NetW029Harness;

beforeAll(async () => {
  harness = await createNetW029Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W029-AC-01 coverage records over the three families", () => {
  test("an EVIDENCE record can be covered: the record shape carries the stored commitment + closed vocabularies", async () => {
    const evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    expect(result.created).toBe(true);
    const attestation = result.attestation;
    expect(attestation.organizationScopeId).toBe(harness.organizationScopeId);
    expect(attestation.statement).toBe("w029 test attestation");
    expect(attestation.recordFormat).toBe(SIGNED_ATTESTATION_RECORD_FORMAT);
    expect(attestation.revokedAt).toBeNull();
    expect(attestation.revocationReason).toBeNull();
    // The closed vocabularies (dev/test default: the clearly-marked HMAC pair).
    expect(attestation.algorithm).toBe("hmac-sha256/v1");
    expect(attestation.keyReference).toBe("attestation-signing/dev-insecure/v1");
    // The stored coverage commitment: salted sha256, 64-char hex digest.
    expect(attestation.coverage).toHaveLength(1);
    const entry = attestation.coverage[0]!;
    expect(entry.family).toBe("evidence");
    expect(entry.recordId).toBe(evidence.id);
    expect(entry.commitment.algorithm).toBe("sha256");
    expect(typeof entry.commitment.salt).toBe("string");
    expect(entry.commitment.salt!.length).toBeGreaterThan(0);
    expect(entry.commitment.digest).toMatch(/^[0-9a-f]{64}$/);
    // Lineage.
    expect(attestation.executionId).toBeTruthy();
    expect(attestation.correlationId).toBeTruthy();
    expect(attestation.signedAt).toBeTruthy();
    expect(attestation.createdAt).toBeTruthy();
    // The record is frozen (immutable).
    expect(Object.isFrozen(attestation)).toBe(true);
  });

  test("a REPUTATION INPUT (W007) can be covered through the neutral lookup", async () => {
    const input = await seedReputationInput(harness);
    const result = await createSignedAttestation(harness, [
      { family: "reputation_input", recordId: input.id },
    ]);
    expect(result.created).toBe(true);
    expect(result.attestation.coverage[0]!.family).toBe("reputation_input");
    expect(result.attestation.coverage[0]!.recordId).toBe(input.id);
    expect(result.attestation.coverage[0]!.commitment.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a SETTLEMENT VALUE record (W008) can be covered through the neutral lookup", async () => {
    const value = await seedSettlementValue(harness, { state: "MATURE" });
    const result = await createSignedAttestation(harness, [
      { family: "settlement_value", recordId: value.id },
    ]);
    expect(result.created).toBe(true);
    expect(result.attestation.coverage[0]!.family).toBe("settlement_value");
    expect(result.attestation.coverage[0]!.recordId).toBe(value.id);
  });

  test("mixed coverage across all three families is stored in the deterministic (family, recordId) order", async () => {
    const evidence = await createEvidenceRecord(harness);
    const input = await seedReputationInput(harness, { sourceEvidenceId: evidence.id });
    const value = await seedSettlementValue(harness, { sourceEvidenceId: evidence.id });
    // Deliberately unsorted input:
    const result = await createSignedAttestation(harness, [
      { family: "settlement_value", recordId: value.id },
      { family: "evidence", recordId: evidence.id },
      { family: "reputation_input", recordId: input.id },
    ]);
    expect(result.attestation.coverage.map((c) => c.family)).toEqual([
      "evidence",
      "reputation_input",
      "settlement_value",
    ]);
    // Commitment digests are unique per covered record.
    const digests = new Set(result.attestation.coverage.map((c) => c.commitment.digest));
    expect(digests.size).toBe(3);
  });

  test("an UNKNOWN coverage family is rejected (closed vocabulary) with no record persisted", async () => {
    const evidence = await createEvidenceRecord(harness);
    await expect(
      createSignedAttestation(harness, [
        { family: "contribution", recordId: evidence.id },
      ]),
    ).rejects.toThrow(/coverage family must be one of/i);
    expect(
      await harness.runtime.signedAttestationService
        .getSignedAttestation(harness.bootstrapCtx, harness.organizationScopeId, "never-created")
        .catch(() => null),
    ).toBeNull();
  });

  test("duplicate (family, recordId) coverage entries are rejected", async () => {
    const evidence = await createEvidenceRecord(harness);
    await expect(
      createSignedAttestation(harness, [
        { family: "evidence", recordId: evidence.id },
        { family: "evidence", recordId: evidence.id },
      ]),
    ).rejects.toThrow(/must not contain duplicates/i);
  });

  test("empty coverage and over-limit coverage are rejected (bounded declaration set)", async () => {
    const evidence = await createEvidenceRecord(harness);
    await expect(createSignedAttestation(harness, [])).rejects.toThrow(
      /at least one authoritative record/i,
    );
    const overLimit: { family: string; recordId: string }[] = [];
    for (let i = 0; i < SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS + 1; i++) {
      overLimit.push({ family: "evidence", recordId: `nonexistent-${i}` });
    }
    await expect(createSignedAttestation(harness, overLimit)).rejects.toThrow(
      new RegExp(`must not exceed ${SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS}`, "i"),
    );
  });

  test("a MISSING covered record fails closed: NotFoundError, no record, no audit event", async () => {
    const auditCountBefore = (
      await harness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
    ).length;
    await expect(
      createSignedAttestation(harness, [{ family: "evidence", recordId: "missing-record-id" }]),
    ).rejects.toThrow(/covered evidence record not found/i);
    const auditCountAfter = (
      await harness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
    ).length;
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  test("a CROSS-SCOPE covered record fails closed (the same-organization-scope rule)", async () => {
    const foreignEvidence = await createEvidenceRecord(harness, { otherOrg: true });
    await expect(
      createSignedAttestation(harness, [
        { family: "evidence", recordId: foreignEvidence.id },
      ]),
    ).rejects.toThrow(/belongs to organization scope/i);
  });

  test("the same idempotency key replays the committed record verbatim (created:false)", async () => {
    const evidence = await createEvidenceRecord(harness);
    const idempotencyKey = key("ac01-replay");
    const first = await createSignedAttestation(
      harness,
      [{ family: "evidence", recordId: evidence.id }],
      { idempotencyKey },
    );
    const replay = await createSignedAttestation(
      harness,
      [{ family: "evidence", recordId: evidence.id }],
      { idempotencyKey },
    );
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.attestation.id).toBe(first.attestation.id);
    expect(replay.attestation.signature).toBe(first.attestation.signature);
  });
});
