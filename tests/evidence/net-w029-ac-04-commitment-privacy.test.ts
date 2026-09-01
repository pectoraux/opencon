/**
 * NET-W029 AC-04 — commitment privacy preservation (issue #58; work
 * order §3.5, §6; PRIV-003).
 *
 * Commitments hide sensitive payloads while binding to them: the
 * durable record carries ONLY (algorithm, digest, salt) per covered
 * record; the canonical facts string is hashed once and never
 * persisted; verification NEVER requires plaintext; salted digests of
 * identical content differ; tampering the stored salt fails closed.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  tamperSignedAttestation,
  type NetW029Harness,
} from "./_net-w029-harness.ts";
import {
  buildSignedAttestationDigestInput,
  canonicalJson,
  deriveCoverageCommitment,
} from "../../src/evidence/signed-attestation-input.ts";
import type { Evidence } from "../../src/evidence/port.ts";

let harness: NetW029Harness;

beforeAll(async () => {
  harness = await createNetW029Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W029-AC-04 commitment privacy preservation", () => {
  test("the attestation record carries NO plaintext of the covered sensitive material (PRIV-003)", async () => {
    const SENSITIVE = "TOP-SECRET-RAW-MATERIAL-9f8e7d6c";
    const evidence = await createEvidenceRecord(harness, {
      sensitivity: "sensitive",
      sensitivePayload: SENSITIVE,
    });
    // The evidence record itself never stores the raw material (W005).
    expect(JSON.stringify(evidence)).not.toContain(SENSITIVE);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    // And neither does the signed attestation: only the stored
    // commitment (algorithm + digest + salt) per covered record.
    expect(JSON.stringify(result.attestation)).not.toContain(SENSITIVE);
  });

  test("coverage commitments are SALTED sha256 digests and UNIQUE per covered record, even for identical content", async () => {
    const payload = { activity: "identical", count: 7 };
    const a = await createEvidenceRecord(harness, { payload });
    const b = await createEvidenceRecord(harness, { payload });
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: a.id },
      { family: "evidence", recordId: b.id },
    ]);
    const [entryA, entryB] = result.attestation.coverage;
    expect(entryA!.commitment.algorithm).toBe("sha256");
    expect(entryB!.commitment.algorithm).toBe("sha256");
    expect(entryA!.commitment.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(entryA!.commitment.salt).not.toBe(entryB!.commitment.salt);
    expect(entryA!.commitment.digest).not.toBe(entryB!.commitment.digest);
  });

  test("verification succeeds WITHOUT plaintext anywhere in the flow", async () => {
    const SENSITIVE = "OFF-RECORD-MATERIAL-a1b2c3";
    const evidence = await createEvidenceRecord(harness, {
      sensitivity: "sensitive",
      sensitivePayload: SENSITIVE,
    });
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    const verdict = await harness.runtime.signedAttestationService.verifySignedAttestation(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      result.attestation.id,
    );
    expect(verdict.valid).toBe(true);
  });

  test("deriveCoverageCommitment is DETERMINISTIC: same facts + same salt ⇒ same digest", () => {
    const facts = canonicalJson({ id: "ev-1", stable: true, nested: { b: 2, a: 1 } });
    const saltA = "salt-one";
    const first = deriveCoverageCommitment(facts, saltA);
    const second = deriveCoverageCommitment(facts, saltA);
    expect(first.digest).toBe(second.digest);
    // Different salt ⇒ different digest (precomputation resistance).
    const third = deriveCoverageCommitment(facts, "salt-two");
    expect(third.digest).not.toBe(first.digest);
    // Different facts ⇒ different digest.
    const fourth = deriveCoverageCommitment(`${facts}x`, saltA);
    expect(fourth.digest).not.toBe(first.digest);
  });

  test("the canonical input contains ONLY the closed headers + STORED digests (no covered content)", () => {
    const input = buildSignedAttestationDigestInput(
      "statement-value",
      "verifier-value",
      "ed25519/v1",
      "attestation-signing/ed25519/v1",
      [
        { family: "evidence", recordId: "ev-9", algorithm: "sha256", digest: "aa" },
        { family: "settlement_value", recordId: "val-1", algorithm: "sha256", digest: "bb" },
      ],
    );
    const lines = input.split("\n");
    expect(lines[0]).toBe("attestation/v2");
    expect(lines).toContain("statement:statement-value");
    expect(lines).toContain("verifier:verifier-value");
    expect(lines).toContain("algorithm:ed25519/v1");
    expect(lines).toContain("key-reference:attestation-signing/ed25519/v1");
    // Coverage lines sorted by (family, recordId); digest-only.
    expect(lines).toContain("coverage:evidence:ev-9:sha256:aa");
    expect(lines).toContain("coverage:settlement_value:val-1:sha256:bb");
    expect(lines.indexOf("coverage:evidence:ev-9:sha256:aa")).toBeLessThan(
      lines.indexOf("coverage:settlement_value:val-1:sha256:bb"),
    );
  });

  test("canonicalJson is key-order-insensitive (deterministic serialization)", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: [3, 2, 1] })).toBe(
      canonicalJson({ a: [3, 2, 1], b: { x: 2, y: 1 } }),
    );
  });

  test("tampering the STORED SALT fails closed (conservative fail-closed direction)", async () => {
    const evidence: Evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    await tamperSignedAttestation(harness, result.attestation.id, (r) => ({
      ...r,
      coverage: r.coverage.map((entry) => ({
        ...entry,
        commitment: { ...entry.commitment, salt: "tampered-salt" },
      })),
    }));
    const verdict = await harness.runtime.signedAttestationService.verifySignedAttestation(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      result.attestation.id,
    );
    expect(verdict.valid).toBe(false);
  });
});
