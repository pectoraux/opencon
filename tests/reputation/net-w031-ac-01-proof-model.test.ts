/**
 * NET-W031-AC-01 — the proof MODEL (issue #63): derived, self-contained,
 * tenant-scoped portable reputation proofs composing the W029
 * signed-attestation machinery.
 *
 *  - issuance round-trips through the composed machinery and the
 *    presentation read returns the SAME self-contained artifact;
 *  - every disclosed dimension fact is DERIVED from the authoritative
 *    snapshot's STORED values (bit-identical; the frozen 8-dimension
 *    vocabulary order) — never recomputed, never caller-asserted;
 *  - the snapshot/policy/version/referenceAt/digest lineage is bound
 *    into the proof;
 *  - explicit snapshotId resolution AND latest-snapshot resolution;
 *  - re-issuance produces a NEW proof (records immutable, both
 *    coexist);
 *  - the W029 envelope carries the versioned algorithm + key reference
 *    (dev HMAC default in test env; a REAL Ed25519 pair composes the
 *    same surface);
 *  - the disclosed per-dimension projection is exactly the AGGREGATE
 *    six-field shape.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { REPUTATION_DIMENSIONS } from "../../src/core/reputation.ts";
import type { ReputationProof, ReputationSnapshot } from "../../src/reputation/port.ts";
import { REPUTATION_PROOF_RECORD_FORMAT } from "../../src/reputation/port.ts";
import { SIGNED_ATTESTATION_ALGORITHMS, SIGNED_ATTESTATION_KEY_REFERENCES } from "../../src/evidence/port.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  presentedFrom,
  verifyStored,
  verifyPresented,
  freshAt,
  key,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

let harness: NetW031Harness;

beforeEach(async () => {
  harness = await createNetW031Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W031-AC-01 proof model", () => {
  test("issuance round-trips through the composed W029 machinery; the presentation read returns the SAME self-contained artifact", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const result = await issueProof(harness, { snapshotId: snapshot.id });
    expect(result.created).toBe(true);

    const read = await harness.runtime.reputationProofService.getProof(
      createExecutionContext({
        correlationId: "ac01-read",
        actor: { id: harness.personId, kind: "person" },
      }),
      harness.organizationScopeId,
      result.proof.id,
    );
    expect(read).toEqual(result.proof);
    // The artifact is self-contained: the presented projection
    // (bookkeeping stripped) carries identity + lineage + facts +
    // envelope + revocation fields + format marker.
    const presented = presentedFrom(read);
    for (const field of [
      "id",
      "organizationScopeId",
      "subjectPersonId",
      "snapshotId",
      "policyId",
      "policyVersion",
      "referenceAt",
      "digest",
      "dimensions",
      "algorithm",
      "keyReference",
      "signature",
      "issuedAt",
      "revokedAt",
      "revocationReason",
      "createdAt",
      "recordFormat",
    ] as const) {
      expect((presented as unknown as Record<string, unknown>)[field]).toBeDefined();
    }
  });

  test("every disclosed dimension fact is DERIVED from the snapshot's STORED values (bit-identical, frozen order, all eight)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 3 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });

    expect(proof.dimensions).toHaveLength(REPUTATION_DIMENSIONS.length);
    expect(proof.dimensions.map((d) => d.dimension)).toEqual([...REPUTATION_DIMENSIONS]);
    snapshot.scores.forEach((score, i) => {
      const fact = proof.dimensions[i]!;
      expect(fact.dimension).toBe(score.dimension);
      expect(fact.score).toBe(score.score);
      expect(fact.capped).toBe(score.capped);
      expect(fact.inputCount).toBe(score.inputCount);
      expect(fact.verifiedInputCount).toBe(score.verifiedInputCount);
      expect(fact.indicatedInputCount).toBe(score.indicatedInputCount);
    });
    // The helpfulness dimension actually carries the seeded inputs.
    const helpfulness = proof.dimensions[0]!;
    expect(helpfulness.inputCount).toBe(3);
    expect(helpfulness.verifiedInputCount).toBe(3);
    expect(helpfulness.indicatedInputCount).toBe(0);
  });

  test("the snapshot/policy/version/referenceAt/digest lineage is bound into the proof", async () => {
    const snapshot: ReputationSnapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    expect(proof.snapshotId).toBe(snapshot.id);
    expect(proof.policyId).toBe(snapshot.policyId);
    expect(proof.policyVersion).toBe(snapshot.policyVersion);
    expect(proof.referenceAt).toBe(snapshot.referenceAt);
    expect(proof.digest).toBe(snapshot.digest);
    expect(proof.organizationScopeId).toBe(harness.organizationScopeId);
    expect(proof.subjectPersonId).toBe(harness.personId);
  });

  test("omitted snapshotId resolves the subject's LATEST recorded snapshot; explicit snapshotId resolves the EXACT one", async () => {
    const first = await seedSubjectSnapshot(harness, { inputCount: 1 });
    // A second input + snapshot makes `first` no longer the latest.
    const second = await seedSubjectSnapshot(harness, { inputCount: 2 });

    const latestProof = await issueProof(harness, {});
    expect(latestProof.proof.snapshotId).toBe(second.id);

    const exactProof = await issueProof(harness, { snapshotId: first.id });
    expect(exactProof.proof.snapshotId).toBe(first.id);
    // The exact-resolution proof discloses the FIRST snapshot's facts.
    expect(exactProof.proof.dimensions[0]!.inputCount).toBe(1);
  });

  test("re-issuance produces a NEW proof; the records are immutable and coexist", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const a = await issueProof(harness, { snapshotId: snapshot.id, idempotencyKey: key("ac01-a") });
    const b = await issueProof(harness, { snapshotId: snapshot.id, idempotencyKey: key("ac01-b") });
    expect(b.created).toBe(true);
    expect(b.proof.id).not.toBe(a.proof.id);
    // Same derivation, different record ids (issued independently).
    expect(b.proof.dimensions).toEqual(a.proof.dimensions);
    expect(b.proof.digest).toBe(a.proof.digest);
    // Both verify.
    expect((await verifyStored(harness, a.proof.id, freshAt(a.proof))).valid).toBe(true);
    expect((await verifyStored(harness, b.proof.id, freshAt(b.proof))).valid).toBe(true);
    // Records are frozen objects.
    expect(Object.isFrozen(a.proof)).toBe(true);
    expect(Object.isFrozen(a.proof.dimensions)).toBe(true);
  });

  test("the composed W029 envelope: versioned algorithm + key reference from the frozen vocabularies (dev HMAC default in test env)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    expect(SIGNED_ATTESTATION_ALGORITHMS as readonly string[]).toContain(proof.algorithm);
    expect(SIGNED_ATTESTATION_KEY_REFERENCES as readonly string[]).toContain(proof.keyReference);
    expect(proof.algorithm).toBe("hmac-sha256/v1");
    expect(proof.keyReference).toBe("attestation-signing/dev-insecure/v1");
    expect(proof.recordFormat).toBe(REPUTATION_PROOF_RECORD_FORMAT);
    expect(proof.signature).toMatch(/^[0-9a-f]+$/);
    expect(proof.revokedAt).toBeNull();
    expect(proof.revocationReason).toBeNull();
  });

  test("a REAL Ed25519 versioned pair composes the same proof surface (asymmetric production path)", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { createEd25519VersionedSignerVerifier } = await import(
      "../../src/bootstrap/attestation-signing.ts"
    );
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pair = createEd25519VersionedSignerVerifier({ privateKeyPem });

    const edHarness = await createNetW031Harness({
      attestation: { versionedSigner: pair, versionedVerifier: pair },
    });
    try {
      const snapshot = await seedSubjectSnapshot(edHarness, { inputCount: 1 });
      const { proof } = await issueProof(edHarness, { snapshotId: snapshot.id });
      expect(proof.algorithm).toBe("ed25519/v1");
      expect(proof.keyReference).toBe("attestation-signing/ed25519/v1");
      // Ed25519 signatures are 64 raw bytes → 128 hex chars.
      expect(proof.signature).toMatch(/^[0-9a-f]{128}$/);
      const verdict = await verifyPresented(edHarness, presentedFrom(proof), freshAt(proof));
      expect(verdict.valid).toBe(true);
      expect(verdict.reason).toBe("verified");
    } finally {
      await edHarness.teardown();
    }
  });

  test("the disclosed per-dimension projection is exactly the AGGREGATE six-field shape", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof }: { proof: ReputationProof } = await issueProof(harness, {
      snapshotId: snapshot.id,
    });
    for (const fact of proof.dimensions) {
      expect(Object.keys(fact).sort()).toEqual([
        "capped",
        "dimension",
        "indicatedInputCount",
        "inputCount",
        "score",
        "verifiedInputCount",
      ]);
    }
  });
});
