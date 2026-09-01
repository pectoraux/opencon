/**
 * NET-W029 AC-07 — authority containment (issue #58; work order §3.4,
 * §4, §6).
 *
 * PostgreSQL remains THE authoritative state: an attestation never
 * mints, mutates or resurrects semantic authority. REVERSED covered
 * value records fail closed at creation AND at verification (never
 * verify as current); legitimate lifecycle progression
 * (PENDING → MATURE) does NOT invalidate a sound attestation; creating
 * and verifying attestations leaves the covered records byte-identical
 * and adds NO records to the owners' collections; revocation is
 * one-way; the machine-readable reason vocabulary stays closed.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  seedReputationInput,
  seedSettlementValue,
  reverseSettlementValue,
  type NetW029Harness,
} from "./_net-w029-harness.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import type { ReputationInput } from "../../src/reputation/port.ts";
import type { Evidence } from "../../src/evidence/port.ts";
import {
  SIGNED_ATTESTATION_VERIFICATION_REASONS,
  type SignedAttestationVerification,
} from "../../src/evidence/port.ts";

let harness: NetW029Harness;

function verify(id: string): Promise<SignedAttestationVerification> {
  return harness.runtime.signedAttestationService.verifySignedAttestation(
    harness.bootstrapCtx,
    harness.organizationScopeId,
    id,
  );
}

beforeAll(async () => {
  harness = await createNetW029Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W029-AC-07 authority containment (PostgreSQL authoritative)", () => {
  test("a REVERSED settlement value record CANNOT be covered: creation fails closed", async () => {
    const evidence = await createEvidenceRecord(harness);
    const value = await seedSettlementValue(harness, { sourceEvidenceId: evidence.id });
    await reverseSettlementValue(harness, value.id);
    await expect(
      createSignedAttestation(harness, [{ family: "settlement_value", recordId: value.id }]),
    ).rejects.toThrow(/is REVERSED/i);
  });

  test("a REVERSED-after-attestation value record NEVER verifies as current: covered_state_invalid", async () => {
    const evidence = await createEvidenceRecord(harness);
    const value = await seedSettlementValue(harness, { sourceEvidenceId: evidence.id });
    const result = await createSignedAttestation(harness, [
      { family: "settlement_value", recordId: value.id },
    ]);
    // Sound before the reversal.
    expect((await verify(result.attestation.id)).valid).toBe(true);
    // The settlement authority reverses the record (a legitimate,
    // authorized lifecycle mutation by the OWNER domain).
    await reverseSettlementValue(harness, value.id);
    const verdict = await verify(result.attestation.id);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("covered_state_invalid");
    expect(SIGNED_ATTESTATION_VERIFICATION_REASONS).toContain(verdict.reason);
    const failed = verdict.checks.find((c) => !c.passed)!;
    expect(failed.check).toBe("covered_current_state");
    expect(failed.subject).toBe(`settlement_value:${value.id}`);
  });

  test("LEGITIMATE lifecycle progression (PENDING → MATURE) does NOT invalidate a sound attestation", async () => {
    const evidence = await createEvidenceRecord(harness);
    const value = await seedSettlementValue(harness, { sourceEvidenceId: evidence.id });
    const result = await createSignedAttestation(harness, [
      { family: "settlement_value", recordId: value.id },
    ]);
    expect((await verify(result.attestation.id)).valid).toBe(true);
    // Mature the record through the settlement authority's own service.
    const ctx = harness.runtime.economicValueService;
    const matured: EconomicValueRecord = await (ctx as unknown as {
      matureValue: (
        execution: unknown,
        input: { valueRecordId: string; idempotencyKey: string },
      ) => Promise<EconomicValueRecord>;
    }).matureValue(harness.bootstrapCtx, {
      valueRecordId: value.id,
      idempotencyKey: `ac07-mature-${crypto.randomUUID()}`,
    });
    expect(matured.state).toBe("MATURE");
    // The attestation still verifies (the substantive content is
    // unchanged; maturation is a legitimate current state).
    const verdict = await verify(result.attestation.id);
    expect(verdict.valid).toBe(true);
  });

  test("the covered records are NEVER mutated by attestation creation/verification (byte-identical)", async () => {
    const evidence: Evidence = await createEvidenceRecord(harness, {
      payload: { frozen: "content", n: 1 },
    });
    const input: ReputationInput = await seedReputationInput(harness, {
      sourceEvidenceId: evidence.id,
    });
    const value: EconomicValueRecord = await seedSettlementValue(harness, {
      sourceEvidenceId: evidence.id,
    });
    const before = JSON.stringify([evidence, input, value]);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
      { family: "reputation_input", recordId: input.id },
      { family: "settlement_value", recordId: value.id },
    ]);
    await verify(result.attestation.id);
    await verify(result.attestation.id);
    const evidenceAfter = await harness.runtime.evidenceService.getEvidence(
      harness.bootstrapCtx,
      evidence.id,
    );
    const inputAfter = await harness.runtime.reputationInputService.getInput(
      harness.bootstrapCtx,
      input.id,
    );
    const valueAfter = await harness.runtime.economicValueService.getValue(
      harness.bootstrapCtx,
      value.id,
    );
    const after = JSON.stringify([evidenceAfter, inputAfter, valueAfter]);
    expect(after).toBe(before);
  });

  test("attestations mint NO records in the owners' collections (no semantic authority minted)", async () => {
    const evidence = await createEvidenceRecord(harness);
    const authority = harness.runtime.postgresAuthority;
    const evidenceBefore = await authority.count("evidence");
    const reputationBefore = await authority.count("reputation_inputs");
    const valueBefore = await authority.count("economic_value_records");
    await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    expect(await authority.count("evidence")).toBe(evidenceBefore);
    expect(await authority.count("reputation_inputs")).toBe(reputationBefore);
    expect(await authority.count("economic_value_records")).toBe(valueBefore);
    // The signed attestations themselves live in their OWN authority
    // collection (the system of record, not the owners' collections).
    expect(await authority.count("signed_attestations")).toBeGreaterThan(0);
  });

  test("revocation is ONE-WAY: a revoked attestation never verifies again; the revocation trail is append-only", async () => {
    const evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    const ctx = harness.bootstrapCtx;
    const revoked = await harness.runtime.signedAttestationService.revokeSignedAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      attestationId: result.attestation.id,
      reason: "compromised verifier key (test)",
      idempotencyKey: `ac07-revoke-${crypto.randomUUID()}`,
    });
    expect(revoked.revokedAt).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      const verdict = await verify(result.attestation.id);
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toBe("attestation_revoked");
    }
    // There is NO un-revocation path on the service (no such operation
    // exists — the type surface has exactly four methods).
    const methods = Object.keys(
      harness.runtime.signedAttestationService,
    ).sort();
    expect(methods).toEqual([
      "createSignedAttestation",
      "getSignedAttestation",
      "revokeSignedAttestation",
      "verifySignedAttestation",
    ]);
  });

  test("an attestation over records of ALL families fails closed the moment ANY covered record is invalidated", async () => {
    const evidence = await createEvidenceRecord(harness);
    const input = await seedReputationInput(harness, { sourceEvidenceId: evidence.id });
    const value = await seedSettlementValue(harness, { sourceEvidenceId: evidence.id });
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
      { family: "reputation_input", recordId: input.id },
      { family: "settlement_value", recordId: value.id },
    ]);
    expect((await verify(result.attestation.id)).valid).toBe(true);
    await reverseSettlementValue(harness, value.id);
    const verdict = await verify(result.attestation.id);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("covered_state_invalid");
    // The failing check names the settlement record (coverage order:
    // evidence, reputation_input, settlement_value — the earlier
    // families passed first: precise, deterministic attribution).
    const failed = verdict.checks.find((c) => !c.passed)!;
    expect(failed.subject).toBe(`settlement_value:${value.id}`);
  });
});
