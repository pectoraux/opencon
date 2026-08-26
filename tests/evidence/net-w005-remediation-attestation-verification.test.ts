/**
 * NET-W005 remediation (architect review on PR #10) — PoV verification
 * must verify an attestation CRYPTOGRAPHICALLY.
 *
 * `ProofOfValueService.verify()` previously required only
 * `attestationIds.length > 0` — proving an attestation RECORD exists,
 * nothing more. Before EVALUATING → VERIFIED it must now call the
 * injected verifier-neutral AttestationVerifier and require at least
 * one attached attestation to return `valid: true` against the
 * canonical input REBUILT from the CURRENT STORED commitment digests.
 *
 * Evidence:
 *  - a TAMPERED attestation signature blocks VERIFIED (fail closed)
 *    and the PoV can still take the honest REJECTED outcome;
 *  - a TAMPERED underlying evidence commitment blocks VERIFIED (the
 *    rebuilt canonical input no longer matches the signature);
 *  - ≥1 VALID attestation among the attached set suffices (a single
 *    invalid one does not poison a PoV with other valid attestations);
 *  - ALL attached attestations invalid → blocked, with per-attestation
 *    failure reasons in the error context;
 *  - an injected verifier that rejects everything blocks VERIFIED even
 *    though the attestation record exists and every other precondition
 *    passes (the exact existence-only gap from the review);
 *  - the verifier is actually CALLED with the canonical input rebuilt
 *    from the current stored commitment digests (spy verifier via the
 *    composition root's explicit-adapters path).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHmacAttestationSignerVerifier } from "../../src/evidence/hmac-attestation-verifier.ts";
import type {
  Attestation,
  AttestationSigner,
  AttestationVerifier,
} from "../../src/evidence/port.ts";
import type { OpenConError } from "../../src/core/errors.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  createEvidence,
  createProofOfValue,
  povTransitionInput,
  type NetW005Harness,
} from "./_net-w005-harness.ts";

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

/**
 * Drive a PoV through DRAFT → MEASURING → (attach attestation) →
 * EVALUATING → aggregate, stopping immediately before the
 * EVALUATING → VERIFIED attempt. Returns everything the caller needs.
 */
async function prepareEvaluatingPoV(
  h: NetW005Harness,
  opts: { sensitive?: boolean } = {},
): Promise<{
  proofId: string;
  evidenceId: string;
  attestationId: string;
  ctx: ReturnType<typeof actorCtx>;
}> {
  const opp = await createOpportunitySubject(h);
  const subject = await createContributionSubject(h, opp.id);
  const evidence = await createEvidence(h, subject.id, {
    sourceType: "platform",
    sourceId: "inst-remediation",
    ...(opts.sensitive
      ? { sensitivity: "sensitive" as const, sensitivePayload: "PRIVATE: remediation material" }
      : {}),
  });
  const proof = await createProofOfValue(h, subject.id, {
    evidenceIds: [evidence.id],
  });
  const ctx = actorCtx(h, "w005-remediation");
  await h.runtime.proofOfValueService.beginMeasuring(
    ctx,
    povTransitionInput(h, proof.id, 0, "rem-begin"),
  );
  const attestation = await h.runtime.attestationService.createAttestation(ctx, {
    organizationScopeId: h.organizationScopeId,
    verifierId: h.personId,
    statement: "Independently reviewed the attached evidence.",
    evidenceIds: [evidence.id],
  });
  await h.runtime.proofOfValueService.attachAttestation(ctx, proof.id, attestation.id);
  await h.runtime.proofOfValueService.completeEvidenceGathering(
    ctx,
    povTransitionInput(h, proof.id, 1, "rem-complete"),
  );
  await h.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  return { proofId: proof.id, evidenceId: evidence.id, attestationId: attestation.id, ctx };
}

/** Overwrite a stored attestation record field directly at the authority. */
async function tamperAttestation(
  h: NetW005Harness,
  attestationId: string,
  patch: Partial<Attestation>,
): Promise<void> {
  const { ATTESTATIONS_COLLECTION } = await import(
    "../../src/evidence/authority-attestation-repository.ts"
  );
  const record = await h.runtime.postgresAuthority.get<Attestation>(
    ATTESTATIONS_COLLECTION,
    attestationId,
  );
  expect(record).not.toBeNull();
  const tampered = { ...record!.value, ...patch };
  await h.runtime.postgresAuthority.run(h.bootstrapCtx, async (tx) => {
    await tx.put(ATTESTATIONS_COLLECTION, attestationId, tampered);
  });
}

describe("NET-W005 remediation — PoV VERIFIED requires a CRYPTOGRAPHICALLY valid attestation", () => {
  test("a TAMPERED attestation signature BLOCKS the EVALUATING → VERIFIED transition (fail closed)", async () => {
    const { proofId, attestationId, ctx } = await prepareEvaluatingPoV(harness);
    // Tamper the stored signature: the record still EXISTS (the old
    // length-only precondition would pass) but it no longer verifies.
    await tamperAttestation(harness, attestationId, { signature: "f".repeat(64) });

    let caught: unknown = null;
    try {
      await harness.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(harness, proofId, 2, "rem-tampered-signature"),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error).message).toMatch(/cryptographically/i);
    // The per-attestation failure reason is carried in the error context.
    const failures = (caught as OpenConError).context?.failures as
      | { attestationId: string; reason: string }[]
      | undefined;
    expect(failures).toBeTruthy();
    expect(failures!.length).toBe(1);
    expect(failures![0]!.attestationId).toBe(attestationId);
    expect(failures![0]!.reason).toMatch(/does not match|tampered/i);

    // The PoV state is UNCHANGED (still EVALUATING) and the honest
    // REJECTED outcome remains available.
    const stored = await harness.runtime.proofOfValueService.getProofOfValue(ctx, proofId);
    expect(stored.state).toBe("EVALUATING");
    const rejected = await harness.runtime.proofOfValueService.reject(
      ctx,
      povTransitionInput(harness, proofId, 2, "rem-tampered-reject"),
    );
    expect(rejected.proof.state).toBe("REJECTED");
  });

  test("a TAMPERED underlying evidence commitment BLOCKS verification (canonical input mismatch)", async () => {
    const { proofId, evidenceId, ctx } = await prepareEvaluatingPoV(harness, {
      sensitive: true,
    });
    // Tamper the stored evidence commitment digest: the canonical input
    // rebuilt from the CURRENT stored digests no longer matches the
    // signature that was taken over the ORIGINAL digests.
    const { EVIDENCE_COLLECTION } = await import(
      "../../src/evidence/authority-evidence-repository.ts"
    );
    const record = await harness.runtime.postgresAuthority.get<
      import("../../src/evidence/port.ts").Evidence
    >(EVIDENCE_COLLECTION, evidenceId);
    expect(record).not.toBeNull();
    const tamperedEvidence = {
      ...record!.value,
      commitment: { algorithm: "sha256" as const, digest: "a".repeat(64) },
    };
    await harness.runtime.postgresAuthority.run(ctx, async (tx) => {
      await tx.put(EVIDENCE_COLLECTION, evidenceId, tamperedEvidence);
    });

    await expect(
      harness.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(harness, proofId, 2, "rem-tampered-commitment"),
      ),
    ).rejects.toThrow(/cryptographically/i);
  });

  test("≥1 VALID attestation suffices: a single invalid attestation does not block a PoV with another valid one", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e = await createEvidence(harness, subject.id, {
      sourceType: "platform",
      sourceId: "inst-multi",
    });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [e.id],
    });
    const ctx = actorCtx(harness, "rem-at-least-one");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "multi-begin"),
    );
    const first = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "First attestation (will be tampered).",
      evidenceIds: [e.id],
    });
    const second = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Second attestation (valid).",
      evidenceIds: [e.id],
    });
    await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, first.id);
    await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, second.id);
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "multi-complete"),
    );
    await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
    // Tamper the FIRST-attached attestation (the loop encounters the
    // invalid one before the valid one — proving it keeps checking).
    await tamperAttestation(harness, first.id, { signature: "0".repeat(64) });

    const verified = await harness.runtime.proofOfValueService.verify(
      ctx,
      povTransitionInput(harness, proof.id, 2, "multi-verify"),
    );
    expect(verified.proof.state).toBe("VERIFIED");
    expect(verified.auditEventName).toBe("proof_of_value.transition.evaluating_to_verified");
  });

  test("ALL attached attestations invalid → BLOCKED, with every failure reason in the error context", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e = await createEvidence(harness, subject.id, {
      sourceType: "platform",
      sourceId: "inst-all-invalid",
    });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [e.id],
    });
    const ctx = actorCtx(harness, "rem-all-invalid");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "allinv-begin"),
    );
    const a1 = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "First.",
      evidenceIds: [e.id],
    });
    const a2 = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Second.",
      evidenceIds: [e.id],
    });
    await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, a1.id);
    await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, a2.id);
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "allinv-complete"),
    );
    await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
    // Tamper BOTH statements: every rebuilt input mismatches.
    await tamperAttestation(harness, a1.id, { statement: "TAMPERED one." });
    await tamperAttestation(harness, a2.id, { statement: "TAMPERED two." });

    let caught: unknown = null;
    try {
      await harness.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(harness, proof.id, 2, "allinv-verify"),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    const failures = (caught as OpenConError).context?.failures as
      | { attestationId: string; reason: string }[]
      | undefined;
    expect(failures!.length).toBe(2);
    expect(failures!.map((f) => f.attestationId).sort()).toEqual([a1.id, a2.id].sort());
  });

  test("an injected verifier that rejects EVERYTHING blocks VERIFIED although the attestation record exists (existence alone proves nothing)", async () => {
    // Explicit adapters through the composition root: a REAL HMAC
    // signer (so the attestation record is genuinely well-formed) plus
    // a verifier that refuses everything. This is the exact gap from
    // the review: every other precondition passes and the attestation
    // record exists — only the cryptographic decision matters.
    const signer: AttestationSigner = createHmacAttestationSignerVerifier({
      key: "explicit-adapter-test-key",
    });
    const rejectAll: AttestationVerifier = {
      async verify() {
        return { valid: false, reason: "test verifier: signature not trusted" };
      },
    };
    const h = await createNetW005Harness({
      attestation: { signer, verifier: rejectAll },
    });
    try {
      expect(h.runtime.attestationSigning.mode).toBe("explicit-adapters");
      const { proofId, ctx } = await prepareEvaluatingPoV(h);
      await expect(
        h.runtime.proofOfValueService.verify(
          ctx,
          povTransitionInput(h, proofId, 2, "rem-reject-all"),
        ),
      ).rejects.toThrow(/cryptographically/i);
    } finally {
      await h.teardown();
    }
  });

  test("the injected verifier IS called with the canonical input REBUILT from the current stored commitment digests (spy)", async () => {
    // Spy verifier wrapping the real HMAC verifier: records every
    // canonical input it receives, then delegates. Proves verify()
    // actually consults the verifier (not just the record's existence)
    // and that the input was rebuilt from the STORED digests.
    const hmac = createHmacAttestationSignerVerifier({ key: "spy-adapter-key" });
    const seen: string[] = [];
    const spyVerifier: AttestationVerifier = {
      async verify(canonicalInput, attestation) {
        seen.push(canonicalInput);
        return hmac.verify(canonicalInput, attestation);
      },
    };
    const h = await createNetW005Harness({
      attestation: { signer: hmac, verifier: spyVerifier },
    });
    try {
      expect(h.runtime.attestationSigning.mode).toBe("explicit-adapters");
      const { proofId, evidenceId, ctx } = await prepareEvaluatingPoV(h, {
        sensitive: true,
      });
      expect(seen.length).toBe(0); // not consulted before the VERIFIED attempt

      const verified = await h.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(h, proofId, 2, "rem-spy-verify"),
      );
      expect(verified.proof.state).toBe("VERIFIED");
      expect(seen.length).toBe(1);

      // The canonical input is the attestation/v1 format rebuilt over
      // the CURRENT STORED commitment digest (never the plaintext).
      const evidence = await h.runtime.evidenceService.getEvidence(ctx, evidenceId);
      expect(evidence.commitment).not.toBeNull();
      const expectedLine = `evidence:${evidenceId}:${evidence.commitment!.digest}`;
      expect(seen[0]).toContain("attestation/v1");
      expect(seen[0]).toContain(expectedLine);
      expect(seen[0]).not.toContain("PRIVATE: remediation material");
    } finally {
      await h.teardown();
    }
  });

  test("the happy path still verifies with a GENUINE attestation (regression guard for the new precondition)", async () => {
    const { proofId, ctx } = await prepareEvaluatingPoV(harness);
    const verified = await harness.runtime.proofOfValueService.verify(
      ctx,
      povTransitionInput(harness, proofId, 2, "rem-happy"),
    );
    expect(verified.proof.state).toBe("VERIFIED");
    expect(verified.proof.version).toBe(3);
    expect(verified.transactionId).toBeTruthy();
  });
});
