/**
 * NET-W029 AC-03 — deterministic verification + tamper detection
 * (issue #58; work order §3.4, §6).
 *
 * Verification is deterministic and reproducible (identical state ⇒
 * identical verdict). Tampering with the statement, the covered set,
 * the underlying records, the signature, the algorithm or the key
 * reference fails closed with a MACHINE-READABLE reason from the closed
 * vocabulary. The verdict for a covered-record tamper names the exact
 * subject.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  seedReputationInput,
  seedSettlementValue,
  tamperRecord,
  tamperSignedAttestation,
  deleteRecord,
  EVIDENCE_COLLECTION,
  ECONOMIC_VALUE_RECORDS_COLLECTION,
  type NetW029Harness,
} from "./_net-w029-harness.ts";
import type { Evidence, SignedAttestation } from "../../src/evidence/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import {
  SIGNED_ATTESTATION_VERIFICATION_REASONS,
  type SignedAttestationVerification,
} from "../../src/evidence/port.ts";

let harness: NetW029Harness;
/** A committed, verifying mixed-family attestation (re-seeded per tamper test). */
let base: { evidence: Evidence; attestationId: string };

async function verify(id: string): Promise<SignedAttestationVerification> {
  return harness.runtime.signedAttestationService.verifySignedAttestation(
    harness.bootstrapCtx,
    harness.organizationScopeId,
    id,
  );
}

async function seed(): Promise<{ evidence: Evidence; attestationId: string }> {
  const evidence = await createEvidenceRecord(harness, {
    payload: { activity: "baseline-payload", count: 42 },
  });
  const result = await createSignedAttestation(harness, [
    { family: "evidence", recordId: evidence.id },
  ]);
  return { evidence, attestationId: result.attestation.id };
}

beforeAll(async () => {
  harness = await createNetW029Harness();
  base = await seed();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W029-AC-03 deterministic verification + tamper detection", () => {
  test("a sound attestation verifies: valid + the closed reason vocabulary + all checks passed", async () => {
    const verdict = await verify(base.attestationId);
    expect(verdict.valid).toBe(true);
    expect(verdict.reason).toBe("verified");
    expect(SIGNED_ATTESTATION_VERIFICATION_REASONS).toContain(verdict.reason);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  test("DETERMINISM: repeated verification of identical state produces identical verdict objects", async () => {
    const a = await verify(base.attestationId);
    const b = await verify(base.attestationId);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A second sound attestation over the same record: same verdict shape.
    const second = await seed();
    const c = await verify(second.attestationId);
    expect(c.valid).toBe(true);
    expect(c.reason).toBe("verified");
    expect(c.checks.length).toBe(a.checks.length);
  });

  test("tampered STATEMENT fails closed: signature_mismatch", async () => {
    const s = await seed();
    await tamperSignedAttestation(harness, s.attestationId, (r) => ({
      ...r,
      statement: "forged statement",
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered COVERED SET (dropped entry) fails closed: signature_mismatch", async () => {
    const evidence = await createEvidenceRecord(harness);
    const other = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
      { family: "evidence", recordId: other.id },
    ]);
    await tamperSignedAttestation(harness, result.attestation.id, (r) => ({
      ...r,
      coverage: r.coverage.slice(0, 1),
    }));
    const verdict = await verify(result.attestation.id);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered SIGNATURE fails closed: signature_mismatch", async () => {
    const s = await seed();
    await tamperSignedAttestation(harness, s.attestationId, (r) => ({
      ...r,
      // Flip one hex nibble (a minimal, GUARANTEED-different tamper — a
      // fixed prepend character is a no-op whenever the signature already
      // starts with that character, which flakes ~1/16 runs).
      signature: `${r.signature[0] === "0" ? "1" : "0"}${r.signature.slice(1)}`,
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered ALGORITHM (unknown identifier) fails closed: unsupported_algorithm", async () => {
    const s = await seed();
    await tamperSignedAttestation(harness, s.attestationId, (r) => ({
      ...r,
      algorithm: "rsa/v9" as SignedAttestation["algorithm"],
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("unsupported_algorithm");
  });

  test("tampered KEY REFERENCE (unknown identifier) fails closed: unknown_key_reference", async () => {
    const s = await seed();
    await tamperSignedAttestation(harness, s.attestationId, (r) => ({
      ...r,
      keyReference: "attestation-signing/rogue/v1" as SignedAttestation["keyReference"],
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("unknown_key_reference");
  });

  test("a VALID-vocabulary but WRONG (algorithm, keyReference) PAIR fails closed: algorithm_key_reference_mismatch", async () => {
    const s = await seed();
    await tamperSignedAttestation(harness, s.attestationId, (r) => ({
      ...r,
      keyReference: "attestation-signing/ed25519/v1" as SignedAttestation["keyReference"],
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("algorithm_key_reference_mismatch");
  });

  test("tampered UNDERLYING EVIDENCE record fails closed: covered_record_mutated + the exact subject", async () => {
    const s = await seed();
    await tamperRecord<Evidence>(harness, EVIDENCE_COLLECTION, s.evidence.id, (r) => ({
      ...r,
      payload: { activity: "tampered-payload", count: 43 },
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("covered_record_mutated");
    const failed = verdict.checks.find((c) => !c.passed)!;
    expect(failed.check).toBe("covered_integrity");
    expect(failed.subject).toBe(`evidence:${s.evidence.id}`);
  });

  test("a DELETED covered record fails closed: covered_record_missing", async () => {
    const s = await seed();
    await deleteRecord(harness, EVIDENCE_COLLECTION, s.evidence.id);
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("covered_record_missing");
    const failed = verdict.checks.find((c) => !c.passed)!;
    expect(failed.check).toBe("covered_current_state");
  });

  test("tampered UNDERLYING REPUTATION INPUT fails closed: covered_record_mutated", async () => {
    const evidence = await createEvidenceRecord(harness);
    const input = await seedReputationInput(harness, { sourceEvidenceId: evidence.id });
    const result = await createSignedAttestation(harness, [
      { family: "reputation_input", recordId: input.id },
    ]);
    const REPUTATION_INPUTS = "reputation_inputs";
    await tamperRecord(harness, REPUTATION_INPUTS, input.id, (r: Record<string, unknown>) => ({
      ...r,
      basis: "forged",
    }));
    const verdict = await verify(result.attestation.id);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("covered_record_mutated");
  });

  test("tampered UNDERLYING SETTLEMENT VALUE (amount) fails closed: covered_record_mutated", async () => {
    const evidence = await createEvidenceRecord(harness);
    const value = await seedSettlementValue(harness, { sourceEvidenceId: evidence.id });
    const result = await createSignedAttestation(harness, [
      { family: "settlement_value", recordId: value.id },
    ]);
    await tamperRecord<EconomicValueRecord>(
      harness,
      ECONOMIC_VALUE_RECORDS_COLLECTION,
      value.id,
      (r) => ({ ...r, amount: 999999 }),
    );
    const verdict = await verify(result.attestation.id);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("covered_record_mutated");
  });

  test("tampered STORED COMMITMENT (digest/salt) fails closed: covered_record_mutated", async () => {
    const s = await seed();
    await tamperSignedAttestation(harness, s.attestationId, (r) => ({
      ...r,
      coverage: r.coverage.map((entry) => ({
        ...entry,
        commitment: {
          ...entry.commitment,
          // Same guaranteed-different-nibble discipline: a fixed `f`
          // prepend is a no-op on a digest that already starts with `f`.
          digest: `${entry.commitment.digest[0] === "f" ? "0" : "f"}${entry.commitment.digest.slice(1)}`,
        },
      })),
    }));
    const verdict = await verify(s.attestationId);
    expect(verdict.valid).toBe(false);
    // The signed canonical input changed with the digest → the signature
    // mismatch fires before the integrity re-derivation.
    expect(["signature_mismatch", "covered_record_mutated"]).toContain(verdict.reason);
  });

  test("verification MUTATES and AUDITS nothing (a derived, read-only decision)", async () => {
    const auditBefore = (
      await harness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
    ).length;
    await verify(base.attestationId);
    await verify(base.attestationId);
    const allEvents = await harness.runtime.auditWriter.query({});
    const revokedCount = allEvents.filter(
      (e) => e.eventType === "signed_attestation.revoked",
    ).length;
    const createdAfter = (
      await harness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
    ).length;
    expect(createdAfter).toBe(auditBefore);
    expect(revokedCount).toBe(0);
  });
});
