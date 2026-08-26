/**
 * NET-W005-AC-05 — Commitments and attestations prove integrity without
 * plaintext disclosure (EVID-006).
 *
 * Evidence commitments verify integrity when plaintext is presented
 * (and fail on tampered plaintext/digest); attestations verify over
 * commitment digests WITHOUT plaintext disclosure; tampered
 * attestations fail verification.
 *
 * Evidence: commitment/attestation roundtrip tests + tampering tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createEvidenceCommitment,
  verifyEvidenceCommitment,
  validateEvidenceCommitment,
} from "../../src/evidence/commitments.ts";
import { buildAttestationDigestInput } from "../../src/evidence/attestation-service.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  createEvidence,
  type NetW005Harness,
} from "./_net-w005-harness.ts";

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W005-AC-05 evidence commitments (EVID-006)", () => {
  test("commitment roundtrip: sha256 + sha512 are deterministic and verify", () => {
    const payload = "sensitive-activity-log-42";
    const c256 = createEvidenceCommitment(payload);
    expect(c256.algorithm).toBe("sha256");
    expect(c256.digest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic.
    expect(createEvidenceCommitment(payload).digest).toBe(c256.digest);
    // Verification passes for the exact material.
    expect(verifyEvidenceCommitment(payload, c256)).toBe(true);
    // sha512 support.
    const c512 = createEvidenceCommitment(payload, { algorithm: "sha512" });
    expect(c512.algorithm).toBe("sha512");
    expect(c512.digest).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvidenceCommitment(payload, c512)).toBe(true);
    expect(verifyEvidenceCommitment("other", c512)).toBe(false);
  });

  test("TAMPERED plaintext fails commitment verification", () => {
    const payload = "the original material";
    const commitment = createEvidenceCommitment(payload);
    expect(verifyEvidenceCommitment("the tampered material", commitment)).toBe(false);
    expect(verifyEvidenceCommitment(`${payload} `, commitment)).toBe(false);
    expect(verifyEvidenceCommitment("", commitment)).toBe(false);
  });

  test("a TAMPERED digest fails verification (constant-time compare, length-safe)", () => {
    const payload = "material";
    const commitment = createEvidenceCommitment(payload);
    const flipped = commitment.digest.slice(0, 63) + (commitment.digest.slice(63) === "0" ? "1" : "0");
    expect(verifyEvidenceCommitment(payload, { ...commitment, digest: flipped })).toBe(false);
    // A wrong-length digest also fails (never throws).
    expect(verifyEvidenceCommitment(payload, { ...commitment, digest: "abc" })).toBe(false);
  });

  test("salted commitments: the salt participates in the digest input", () => {
    const payload = "low-entropy-material";
    const salted = createEvidenceCommitment(payload, { salt: "random-salt-1" });
    const unsalted = createEvidenceCommitment(payload);
    expect(salted.digest).not.toBe(unsalted.digest);
    // Verification with the commitment's own salt succeeds.
    expect(verifyEvidenceCommitment(payload, salted)).toBe(true);
    // A different salt produces a different (non-matching) digest.
    const otherSalt = createEvidenceCommitment(payload, { salt: "random-salt-2" });
    expect(verifyEvidenceCommitment(payload, otherSalt)).toBe(true);
    expect(otherSalt.digest).not.toBe(salted.digest);
  });

  test("unsupported commitment algorithms are rejected with a stable code", () => {
    expect(() => createEvidenceCommitment("x", { algorithm: "md5" as never })).toThrow(
      /unsupported commitment algorithm/i,
    );
    expect(() =>
      validateEvidenceCommitment({ algorithm: "sha256", digest: "zzz" }),
    ).toThrow(/commitment digest/i);
    expect(() =>
      validateEvidenceCommitment({ algorithm: "sha256", digest: "a".repeat(63) }),
    ).toThrow(/commitment digest/i);
  });

  test("verifyEvidenceCommitment (service): presented material verifies against the STORED commitment", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const material = "PRIVATE: user-7 clicked creative-9 at 2026-02-03T04:05:06Z";
    const evidence = await createEvidence(harness, subject.id, {
      sensitivity: "sensitive",
      sensitivePayload: material,
    });
    const ctx = actorCtx(harness, "ac05-service-verify");

    const ok = await harness.runtime.evidenceService.verifyEvidenceCommitment(
      ctx,
      evidence.id,
      material,
    );
    expect(ok.valid).toBe(true);

    const tampered = await harness.runtime.evidenceService.verifyEvidenceCommitment(
      ctx,
      evidence.id,
      "PRIVATE: user-7 clicked creative-999 at 2026-02-03T04:05:06Z",
    );
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toMatch(/does NOT match/i);
  });

  test("verification fails closed for evidence without a commitment", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const evidence = await createEvidence(harness, subject.id, {
      payload: { events: 5 },
    });
    const ctx = actorCtx(harness, "ac05-no-commitment");
    const result = await harness.runtime.evidenceService.verifyEvidenceCommitment(
      ctx,
      evidence.id,
      "anything",
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no commitment/i);
  });
});

describe("NET-W005-AC-05 attestations (verifier-neutral)", () => {
  test("an attestation verifies over commitment DIGESTS — NO plaintext disclosure anywhere on the path", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const secretMaterial = "SUPER-SECRET-EVIDENCE-CONTENT";
    const evidence = await createEvidence(harness, subject.id, {
      sensitivity: "sensitive",
      sensitivePayload: secretMaterial,
    });
    const ctx = actorCtx(harness, "ac05-attest");

    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "The committed activity log was independently reviewed and its counts confirmed.",
      evidenceIds: [evidence.id],
    });
    expect(attestation.algorithm).toBe("hmac-sha256");
    expect(attestation.signature).toMatch(/^[0-9a-f]{64}$/);

    // Verification rebuilds the canonical input from the STORED
    // commitments — the plaintext NEVER participates.
    const verification = await harness.runtime.attestationService.verifyAttestation(
      ctx,
      attestation.id,
    );
    expect(verification.valid).toBe(true);
    expect(verification.reason).toMatch(/verified/i);
    // The attestation entity itself carries no plaintext.
    expect(JSON.stringify(attestation)).not.toContain(secretMaterial);
  });

  test("a TAMPERED statement invalidates the attestation (canonical input mismatch)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const evidence = await createEvidence(harness, subject.id, {
      sensitivity: "sensitive",
      sensitivePayload: "sensitive-material",
    });
    const ctx = actorCtx(harness, "ac05-attest-tamper");
    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Original statement.",
      evidenceIds: [evidence.id],
    });

    // Tamper with the stored attestation's statement: the rebuilt
    // canonical input no longer matches the signature.
    const { ATTESTATIONS_COLLECTION } = await import(
      "../../src/evidence/authority-attestation-repository.ts"
    );
    const record = await harness.runtime.postgresAuthority.get<
      import("../../src/evidence/port.ts").Attestation
    >(ATTESTATIONS_COLLECTION, attestation.id);
    const tampered = {
      ...record!.value,
      statement: "TAMPERED statement.",
    };
    await harness.runtime.postgresAuthority.run(ctx, async (tx) => {
      await tx.put(ATTESTATIONS_COLLECTION, attestation.id, tampered);
    });

    const verification = await harness.runtime.attestationService.verifyAttestation(
      ctx,
      attestation.id,
    );
    expect(verification.valid).toBe(false);
    expect(verification.reason).toMatch(/does not match|tampered/i);
  });

  test("an attestation over TAMPERED underlying commitments fails verification", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const evidence = await createEvidence(harness, subject.id, {
      sensitivity: "sensitive",
      sensitivePayload: "original-material",
    });
    const ctx = actorCtx(harness, "ac05-attest-tamper-commitment");
    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Statement over the commitments.",
      evidenceIds: [evidence.id],
    });

    // Tamper with the EVIDENCE commitment (swap the digest): the rebuilt
    // canonical input changes → the signature no longer matches.
    const { EVIDENCE_COLLECTION } = await import(
      "../../src/evidence/authority-evidence-repository.ts"
    );
    const record = await harness.runtime.postgresAuthority.get<
      import("../../src/evidence/port.ts").Evidence
    >(EVIDENCE_COLLECTION, evidence.id);
    const tamperedEvidence = {
      ...record!.value,
      commitment: {
        algorithm: "sha256" as const,
        digest: "f".repeat(64),
      },
    };
    await harness.runtime.postgresAuthority.run(ctx, async (tx) => {
      await tx.put(EVIDENCE_COLLECTION, evidence.id, tamperedEvidence);
    });

    const verification = await harness.runtime.attestationService.verifyAttestation(
      ctx,
      attestation.id,
    );
    expect(verification.valid).toBe(false);
  });

  test("attestation validation: unknown evidence + cross-org evidence are rejected; empty coverage is rejected", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac05-attest-validation");

    await expect(
      harness.runtime.attestationService.createAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.personId,
        statement: "Statement.",
        evidenceIds: [],
      }),
    ).rejects.toThrow(/at least one evidence record/i);

    await expect(
      harness.runtime.attestationService.createAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.personId,
        statement: "Statement.",
        evidenceIds: ["urn:unknown:evidence"],
      }),
    ).rejects.toThrow(/evidence not found/i);

    // Cross-org evidence: evidence in another organization scope.
    const otherOrgOpp = await harness.runtime.opportunityService.createOpportunity(
      harness.bootstrapCtx,
      {
        organizationScopeId: "urn:another:org",
        ownerId: harness.personId,
        opportunityType: "test",
        title: "Other Org Opportunity",
      },
    );
    const foreignEvidence = await harness.runtime.evidenceService.createEvidence(
      harness.bootstrapCtx,
      {
        organizationScopeId: "urn:another:org",
        ownerId: harness.personId,
        subjectReference: {
          subjectId: otherOrgOpp.id,
          subjectType: "opportunity",
        },
        provenance: { sourceType: "platform", method: "counter" },
        confidence: { point: 0.9 },
      },
    );
    await expect(
      harness.runtime.attestationService.createAttestation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.personId,
        statement: "Statement.",
        evidenceIds: [foreignEvidence.id],
      }),
    ).rejects.toThrow(/organization scope/i);
  });

  test("attestation creation is audited (attestation.created)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const evidence = await createEvidence(harness, subject.id);
    const ctx = actorCtx(harness, "ac05-attest-audit");
    const before = await harness.runtime.auditWriter.count();
    await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Reviewed.",
      evidenceIds: [evidence.id],
    });
    const after = await harness.runtime.auditWriter.count();
    expect(after - before).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "attestation.created",
    });
    expect(events[events.length - 1]!.metadata?.coveredEvidenceCount).toBe(1);
  });

  test("the canonical digest input is deterministic + order-insensitive over covered evidence", () => {
    const covered = [
      { evidenceId: "ev-b", digest: "ddd2" },
      { evidenceId: "ev-a", digest: "ddd1" },
    ];
    const a = buildAttestationDigestInput("stmt", "verifier", covered);
    const b = buildAttestationDigestInput("stmt", "verifier", [covered[1]!, covered[0]!]);
    expect(a).toBe(b);
    // Any change to statement/verifier/digests changes the input.
    expect(buildAttestationDigestInput("stmt2", "verifier", covered)).not.toBe(a);
    expect(buildAttestationDigestInput("stmt", "verifier2", covered)).not.toBe(a);
    expect(
      buildAttestationDigestInput("stmt", "verifier", [
        { evidenceId: "ev-b", digest: "dddX" },
        { evidenceId: "ev-a", digest: "ddd1" },
      ]),
    ).not.toBe(a);
  });

  test("the API verifies an attestation without plaintext (public verification endpoint)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const evidence = await createEvidence(harness, subject.id, {
      sensitivity: "sensitive",
      sensitivePayload: "api-attestation-secret",
    });
    const ctx = actorCtx(harness, "ac05-attest-api");
    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Independently verified via API test.",
      evidenceIds: [evidence.id],
    });
    const res = await fetch(
      `http://127.0.0.1:${harness.runtime.api.port}/api/attestations/${attestation.id}/verify`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as { valid: boolean; attestationId: string };
    expect(view.valid).toBe(true);
    expect(view.attestationId).toBe(attestation.id);
  });
});
