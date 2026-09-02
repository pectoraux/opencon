/**
 * NET-W031-AC-03 — DETERMINISTIC, fail-closed verification with
 * machine-readable reasons (issue #63; work order §3.3).
 *
 *  - repeated verification (authority-side AND presentation-side)
 *    produces byte-identical verdicts — no wall clock, no hidden state;
 *  - the checks pipeline is pinned: revocation → proof_shape →
 *    algorithm_vocabulary → key_reference_vocabulary →
 *    algorithm_key_reference_pairing → signature → staleness;
 *  - the tamper matrix: EVERY substantive field is tamper-evident —
 *    subject, scope, lineage (snapshot/policy/version/referenceAt/
 *    digest), aggregate facts, issuance timestamp, the signature
 *    itself (the GUARANTEED-DIFFERENT-NIBBLE discipline — a fixed
 *    prepend character is a no-op whenever the signature already
 *    starts with it, which flakes ~1/16 runs; the W029 CI lesson),
 *    the algorithm and the key reference;
 *  - malformed shapes fail closed with proof_shape detail (the
 *    closed dimension vocabulary, frozen order, count consistency);
 *  - revoked and stale proofs never verify; the staleness boundary
 *    is exact;
 *  - verification MUTATES and AUDITS nothing;
 *  - the presentation surface is SELF-CONTAINED: deleting the stored
 *    record does not change the presented verdict.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ReputationProof } from "../../src/reputation/port.ts";
import { REPUTATION_PROOF_FRESHNESS_WINDOW_MS } from "../../src/reputation/port.ts";
import { REPUTATION_PROOFS_COLLECTION } from "../../src/reputation/authority-proof-repository.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  verifyStored,
  verifyPresented,
  presentedFrom,
  freshAt,
  staleAt,
  shiftIso,
  tamperProof,
  deleteRecord,
  key,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

function readerCtx(harness: NetW031Harness, correlationId: string) {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

let harness: NetW031Harness;
let base: ReputationProof;

beforeEach(async () => {
  harness = await createNetW031Harness();
  const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
  base = (await issueProof(harness, { snapshotId: snapshot.id })).proof;
});

afterEach(async () => {
  await harness.teardown();
});

async function stored(): Promise<ReturnType<typeof JSON.stringify>> {
  const verdict = await verifyStored(harness, base.id, freshAt(base));
  return JSON.stringify(verdict);
}

async function presented(proof: ReputationProof = base): Promise<string> {
  const verdict = await verifyPresented(harness, presentedFrom(proof), freshAt(base));
  return JSON.stringify(verdict);
}

describe("NET-W031-AC-03 deterministic verification", () => {
  test("repeated verification is byte-identical on BOTH surfaces (no wall clock, no hidden state)", async () => {
    expect(await stored()).toBe(await stored());
    expect(await presented()).toBe(await presented());
    // And the two surfaces agree on the same artifact.
    const storedVerdict = JSON.parse(await stored());
    const presentedVerdict = JSON.parse(await presented());
    expect(presentedVerdict).toEqual(storedVerdict);
  });

  test("the checks pipeline is pinned (fixed order, closed names)", async () => {
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(true);
    expect(verdict.checks.map((c) => c.check)).toEqual([
      "revocation",
      "proof_shape",
      "algorithm_vocabulary",
      "key_reference_vocabulary",
      "algorithm_key_reference_pairing",
      "signature",
      "staleness",
    ]);
    for (const c of verdict.checks) {
      expect(c.passed).toBe(true);
      expect(c.reason).toBe("verified");
    }
  });

  test("tampered SUBJECT fails closed: signature_mismatch", async () => {
    await tamperProof(harness, base.id, (r) => ({ ...r, subjectPersonId: harness.otherPersonId }));
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered ORGANIZATION scope fails closed (presented: signature_mismatch; stored: tenant isolation first)", async () => {
    // Presented surface: the scope is SIGNED — a re-scoped artifact
    // fails the signature check.
    const rescoped = {
      ...presentedFrom(base),
      organizationScopeId: harness.otherOrganizationScopeId,
    } as ReputationProof;
    const verdict = await verifyPresented(harness, rescoped, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
    // Stored surface: a re-scoped STORED record is indistinguishable
    // from not-found (tenant isolation PRECEDES the pipeline — no
    // existence oracle).
    await tamperProof(harness, base.id, (r) => ({
      ...r,
      organizationScopeId: harness.otherOrganizationScopeId,
    }));
    await expect(verifyStored(harness, base.id, freshAt(base))).rejects.toThrow(
      /reputation proof not found/,
    );
  });

  test("tampered aggregate SCORE fails closed: signature_mismatch", async () => {
    await tamperProof(harness, base.id, (r) => {
      const dimensions = r.dimensions.slice();
      const first = dimensions[0]!;
      dimensions[0] = { ...first, score: first.score + 10 };
      return { ...r, dimensions };
    });
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered COUNTS and CAP flag fail closed: signature_mismatch", async () => {
    // A CONSISTENT count inflation (all three counts shifted, so the
    // shape validator's count-consistency rule passes) — the tamper
    // then reaches the signature check and fails closed there.
    await tamperProof(harness, base.id, (r) => {
      const dimensions = r.dimensions.slice();
      const first = dimensions[0]!;
      dimensions[0] = {
        ...first,
        inputCount: first.inputCount + 5,
        verifiedInputCount: first.verifiedInputCount + 5,
      };
      return { ...r, dimensions };
    });
    expect((await verifyStored(harness, base.id, freshAt(base))).reason).toBe("signature_mismatch");

    // Fresh proof; tamper the capped flag on a second record.
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const second = (await issueProof(harness, { snapshotId: snapshot.id })).proof;
    await tamperProof(harness, second.id, (r) => {
      const dimensions = r.dimensions.slice();
      const first = dimensions[0]!;
      dimensions[0] = { ...first, capped: !first.capped };
      return { ...r, dimensions };
    });
    expect((await verifyStored(harness, second.id, freshAt(second))).reason).toBe("signature_mismatch");
  });

  test("tampered LINEAGE (snapshot id / policy / digest / referenceAt) fails closed: signature_mismatch", async () => {
    const cases: Array<(r: ReputationProof) => ReputationProof> = [
      (r) => ({ ...r, snapshotId: "not-the-bound-snapshot" }),
      (r) => ({ ...r, policyId: "rogue-policy" }),
      (r) => ({ ...r, policyVersion: r.policyVersion + 1 }),
      // Same guaranteed-different-nibble discipline on the lineage
      // digest (a fixed prepend is a no-op on a digest already
      // starting with that character).
      (r) => ({ ...r, digest: `${r.digest[0] === "f" ? "0" : "f"}${r.digest.slice(1)}` }),
      (r) => ({ ...r, referenceAt: "2020-01-01T00:00:00.000Z" }),
    ];
    for (const mutate of cases) {
      const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
      const proof = (await issueProof(harness, { snapshotId: snapshot.id })).proof;
      await tamperProof(harness, proof.id, mutate);
      const verdict = await verifyStored(harness, proof.id, freshAt(proof));
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toBe("signature_mismatch");
    }
  });

  test("tampered issuedAt fails closed: signature_mismatch (the staleness anchor is signed)", async () => {
    await tamperProof(harness, base.id, (r) => ({
      ...r,
      issuedAt: shiftIso(r.issuedAt, REPUTATION_PROOF_FRESHNESS_WINDOW_MS),
    }));
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered SIGNATURE fails closed: signature_mismatch (guaranteed-different nibble)", async () => {
    await tamperProof(harness, base.id, (r) => ({
      ...r,
      // Flip one hex nibble (a minimal, GUARANTEED-different tamper — a
      // fixed prepend character is a no-op whenever the signature
      // already starts with that character, which flakes ~1/16 runs).
      signature: `${r.signature[0] === "0" ? "1" : "0"}${r.signature.slice(1)}`,
    }));
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("tampered ALGORITHM (unknown identifier) fails closed: unsupported_algorithm", async () => {
    await tamperProof(harness, base.id, (r) => ({
      ...r,
      algorithm: "rsa/v9" as ReputationProof["algorithm"],
    }));
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("unsupported_algorithm");
  });

  test("tampered KEY REFERENCE fails closed: unknown_key_reference", async () => {
    await tamperProof(harness, base.id, (r) => ({
      ...r,
      keyReference: "attestation-signing/rogue/v1" as ReputationProof["keyReference"],
    }));
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("unknown_key_reference");
  });

  test("a valid-but-wrong algorithm/key pairing fails closed: algorithm_key_reference_mismatch", async () => {
    await tamperProof(harness, base.id, (r) => ({
      ...r,
      // ed25519/v1 IS in the algorithm vocabulary, and its key
      // reference IS in the key-reference vocabulary — but the PAIR
      // does not match the frozen pairing map under the hmac algo.
      algorithm: "ed25519/v1" as ReputationProof["algorithm"],
    }));
    const verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("algorithm_key_reference_mismatch");
  });

  test("malformed DIMENSIONS (wrong order / dropped / unknown / count mismatch) fail closed: malformed_proof with field detail", async () => {
    // Wrong ORDER (vocabulary-valid, frozen-order-invalid).
    await tamperProof(harness, base.id, (r) => {
      const dimensions = r.dimensions.slice();
      const a = dimensions[0]!;
      const b = dimensions[1]!;
      dimensions[0] = b;
      dimensions[1] = a;
      return { ...r, dimensions };
    });
    let verdict = await verifyStored(harness, base.id, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("malformed_proof");
    expect(verdict.checks.at(-1)?.subject).toBe("dimensions");

    // DROPPED dimension (7 of 8).
    const s1 = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const p1 = (await issueProof(harness, { snapshotId: s1.id })).proof;
    await tamperProof(harness, p1.id, (r) => ({ ...r, dimensions: r.dimensions.slice(0, 7) }));
    verdict = await verifyStored(harness, p1.id, freshAt(p1));
    expect(verdict.reason).toBe("malformed_proof");
    expect(verdict.checks.at(-1)?.subject).toBe("dimensions");

    // UNKNOWN dimension name.
    const s2 = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const p2 = (await issueProof(harness, { snapshotId: s2.id })).proof;
    await tamperProof(harness, p2.id, (r) => {
      const dimensions = r.dimensions.slice();
      const first = dimensions[0]!;
      dimensions[0] = { ...first, dimension: "generosity" as never };
      return { ...r, dimensions };
    });
    verdict = await verifyStored(harness, p2.id, freshAt(p2));
    expect(verdict.reason).toBe("malformed_proof");
    expect(verdict.checks.at(-1)?.subject).toBe("dimensions[0].dimension");

    // COUNT inconsistency (inputCount !== verified + indicated).
    const s3 = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const p3 = (await issueProof(harness, { snapshotId: s3.id })).proof;
    await tamperProof(harness, p3.id, (r) => {
      const dimensions = r.dimensions.slice();
      const first = dimensions[0]!;
      dimensions[0] = { ...first, verifiedInputCount: first.inputCount + 1 };
      return { ...r, dimensions };
    });
    verdict = await verifyStored(harness, p3.id, freshAt(p3));
    expect(verdict.reason).toBe("malformed_proof");
    expect(verdict.checks.at(-1)?.subject).toContain("inputCount");

    // Unsupported record format.
    const s4 = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const p4 = (await issueProof(harness, { snapshotId: s4.id })).proof;
    await tamperProof(harness, p4.id, (r) => ({ ...r, recordFormat: "NET-W999:1" as never }));
    verdict = await verifyStored(harness, p4.id, freshAt(p4));
    expect(verdict.reason).toBe("malformed_proof");
    expect(verdict.checks.at(-1)?.subject).toBe("recordFormat");
  });

  test("untrusted presented garbage fails closed: malformed_proof (runtime-tolerant validation)", async () => {
    const garbage = {
      ...presentedFrom(base),
      dimensions: "not-an-array",
    } as unknown as ReputationProof;
    let verdict = await verifyPresented(harness, garbage, freshAt(base));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("malformed_proof");

    const garbageScore = {
      ...presentedFrom(base),
      dimensions: base.dimensions.map((d) => ({ ...d, score: "high" as unknown as number })),
    } as unknown as ReputationProof;
    verdict = await verifyPresented(harness, garbageScore, freshAt(base));
    expect(verdict.reason).toBe("malformed_proof");

    const garbageTimestamp = {
      ...presentedFrom(base),
      issuedAt: "not-a-timestamp",
    } as unknown as ReputationProof;
    verdict = await verifyPresented(harness, garbageTimestamp, freshAt(base));
    expect(verdict.reason).toBe("malformed_proof");
  });

  test("a REVOKED proof NEVER verifies on EITHER surface: proof_revoked", async () => {
    await harness.runtime.reputationProofService.revokeProof(
      readerCtx(harness, "ac03-revoke"),
      {
        organizationScopeId: harness.organizationScopeId,
        proofId: base.id,
        reason: "ac03 revocation",
        idempotencyKey: key("ac03-revoke"),
      },
    );
    const storedVerdict = await verifyStored(harness, base.id, freshAt(base));
    expect(storedVerdict.valid).toBe(false);
    expect(storedVerdict.reason).toBe("proof_revoked");
    // The presentation surface fails closed on the artifact's OWN
    // one-way revocation field — re-read the STORED (revoked) record
    // so the artifact carries the current revocation state.
    const revokedRecord = await harness.runtime.reputationProofService.getProof(
      readerCtx(harness, "ac03-revoke-read"),
      harness.organizationScopeId,
      base.id,
    );
    const presentedVerdict = await verifyPresented(
      harness,
      presentedFrom(revokedRecord),
      freshAt(base),
    );
    expect(presentedVerdict.valid).toBe(false);
    expect(presentedVerdict.reason).toBe("proof_revoked");
  });

  test("STALENESS is a verification-time derivation: stale fails closed, the boundary is exact, pre-issuance evaluation fails closed", async () => {
    // Comfortably fresh.
    expect((await verifyStored(harness, base.id, freshAt(base))).valid).toBe(true);
    // Exactly at the window boundary → still fresh (<=).
    const boundary = shiftIso(base.issuedAt, REPUTATION_PROOF_FRESHNESS_WINDOW_MS);
    expect((await verifyStored(harness, base.id, boundary)).valid).toBe(true);
    // One ms beyond → stale.
    expect((await verifyStored(harness, base.id, staleAt(base))).reason).toBe("proof_stale");
    // Evaluated BEFORE issuance → not fresh (fail closed).
    const before = shiftIso(base.issuedAt, -1000);
    expect((await verifyStored(harness, base.id, before)).reason).toBe("proof_stale");
    // An unparseable evaluatedAt is a caller INPUT error (fail closed,
    // validation-class — never a silent accept).
    await expect(verifyStored(harness, base.id, "not-a-timestamp")).rejects.toThrow(
      /evaluatedAt must be a valid ISO-8601 timestamp/,
    );
  });

  test("verification MUTATES and AUDITS nothing (a derived, read-only decision)", async () => {
    const authority = harness.runtime.postgresAuthority;
    const proofsBefore = await authority.count(REPUTATION_PROOFS_COLLECTION);
    const eventsBefore = await harness.runtime.auditWriter.query({
      eventType: "reputation_proof.issued",
    });
    const revokedEventsBefore = await harness.runtime.auditWriter.query({
      eventType: "reputation_proof.revoked",
    });
    const storedBefore = JSON.stringify(base);

    for (let i = 0; i < 3; i += 1) {
      await verifyStored(harness, base.id, freshAt(base));
      await verifyPresented(harness, presentedFrom(base), freshAt(base));
    }

    expect(await authority.count(REPUTATION_PROOFS_COLLECTION)).toBe(proofsBefore);
    expect(await harness.runtime.auditWriter.query({ eventType: "reputation_proof.issued" })).toEqual(
      eventsBefore,
    );
    expect(
      await harness.runtime.auditWriter.query({ eventType: "reputation_proof.revoked" }),
    ).toEqual(revokedEventsBefore);
    const after = await harness.runtime.reputationProofService.getProof(
      readerCtx(harness, "ac03-read-after"),
      harness.organizationScopeId,
      base.id,
    );
    expect(JSON.stringify(after)).toBe(storedBefore);
  });

  test("the presentation surface is SELF-CONTAINED: deleting the stored record changes NOTHING for the presented verdict", async () => {
    const before = await presented();
    await deleteRecord(harness, REPUTATION_PROOFS_COLLECTION, base.id);
    expect(await presented()).toBe(before);
    // The authority-side surface, by contrast, is store-backed: the
    // deleted record is NOT FOUND (indistinguishable from any other
    // missing id — no existence oracle).
    await expect(verifyStored(harness, base.id, freshAt(base))).rejects.toThrow(
      /reputation proof not found/,
    );
  });
});
