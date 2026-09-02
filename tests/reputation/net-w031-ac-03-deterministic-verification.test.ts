/**
 * NET-W031-AC-03 — DETERMINISTIC, fail-closed verification with
 * machine-readable reasons (issue #63; work order §3.3 — including
 * the PR #64 architect-review remediation: the SIGNED revocation
 * representation + the presentation PAIR protocol).
 *
 *  - repeated verification (authority-side AND presentation-side)
 *    produces byte-identical verdicts — no wall clock, no hidden state;
 *  - the checks pipelines are pinned: the authority-side single-
 *    artifact pipeline (revocation → proof_shape → algorithm_
 *    vocabulary → key_reference_vocabulary → algorithm_key_reference_
 *    pairing → signature → staleness) and the presentation-side PAIR
 *    pipeline (presented:* gates → pair_binding → current:* gates);
 *  - the tamper matrix: EVERY substantive field is tamper-evident —
 *    the proof id, subject, scope, lineage (snapshot/policy/version/
 *    referenceAt/digest), aggregate facts, issuance timestamp, the
 *    signature itself (the GUARANTEED-DIFFERENT-NIBBLE discipline — a
 *    fixed prepend character is a no-op whenever the signature already
 *    starts with it, which flakes ~1/16 runs; the W029 CI lesson),
 *    the algorithm and the key reference;
 *  - malformed shapes fail closed with proof_shape detail (the
 *    closed dimension vocabulary, frozen order, count consistency);
 *  - revoked and stale proofs never verify; the staleness boundary
 *    is exact;
 *  - THE PR #64 REMEDIATION CASES: a portable artifact CAPTURED
 *    before revocation can never subsequently return `verified`
 *    (paired with the authority's current sealed record, whose SIGNED
 *    one-way revocation state governs); tampering/REMOVAL of the
 *    revocation representation fails closed (the fields are SIGNED —
 *    stripped/reset copies fail the signature check); mismatched
 *    presentation pairs fail closed (proof_pair_mismatch);
 *  - verification MUTATES and AUDITS nothing;
 *  - the presentation surface is SELF-CONTAINED: the verification
 *    function is a PURE derivation over the presented pair — deleting
 *    the stored record does not change the presented verdict.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { PresentedReputationProof, ReputationProof } from "../../src/reputation/port.ts";
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

/** Deep-copy capture of a presented artifact (the holder's export). */
function captureOf(proof: ReputationProof): PresentedReputationProof {
  return JSON.parse(JSON.stringify(presentedFrom(proof))) as PresentedReputationProof;
}

/** Re-read the CURRENT sealed record of a proof from the authority. */
async function currentOf(proof: ReputationProof): Promise<ReputationProof> {
  return harness.runtime.reputationProofService.getProof(
    readerCtx(harness, "ac03-current-read"),
    proof.organizationScopeId,
    proof.id,
  );
}

async function revoke(proof: ReputationProof, reason: string): Promise<ReputationProof> {
  return harness.runtime.reputationProofService.revokeProof(
    readerCtx(harness, "ac03-revoke"),
    {
      organizationScopeId: proof.organizationScopeId,
      proofId: proof.id,
      reason,
      idempotencyKey: key("ac03-revoke"),
    },
  );
}

describe("NET-W031-AC-03 deterministic verification", () => {
  test("repeated verification is byte-identical on BOTH surfaces (no wall clock, no hidden state)", async () => {
    expect(await stored()).toBe(await stored());
    expect(await presented()).toBe(await presented());
    // The two surfaces AGREE on the decision for the same artifact
    // (valid + reason + proof id); the pair surface reports the
    // pair-qualified checks detail, the single-artifact surface the
    // bare pipeline.
    const storedVerdict = JSON.parse(await stored());
    const presentedVerdict = JSON.parse(await presented());
    expect(presentedVerdict.valid).toBe(storedVerdict.valid);
    expect(presentedVerdict.reason).toBe(storedVerdict.reason);
    expect(presentedVerdict.proofId).toBe(storedVerdict.proofId);
  });

  test("the checks pipelines are pinned (fixed order, closed names — single-artifact AND pair)", async () => {
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

    // The presentation-side PAIR pipeline: the presented artifact's
    // seven gates, the pair binding, then the current record's seven
    // gates (the PR #64 remediation contract).
    const pair = await verifyPresented(harness, presentedFrom(base), freshAt(base));
    expect(pair.valid).toBe(true);
    expect(pair.checks.map((c) => c.check)).toEqual([
      "presented:revocation",
      "presented:proof_shape",
      "presented:algorithm_vocabulary",
      "presented:key_reference_vocabulary",
      "presented:algorithm_key_reference_pairing",
      "presented:signature",
      "presented:staleness",
      "pair_binding",
      "current:revocation",
      "current:proof_shape",
      "current:algorithm_vocabulary",
      "current:key_reference_vocabulary",
      "current:algorithm_key_reference_pairing",
      "current:signature",
      "current:staleness",
    ]);
    for (const c of pair.checks) {
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
    // fails its OWN signature check (verified as BOTH halves of the
    // pair, so the re-scoped claim itself — not the pair — is what
    // fails).
    const rescoped = {
      ...presentedFrom(base),
      organizationScopeId: harness.otherOrganizationScopeId,
    } as ReputationProof;
    const verdict = await verifyPresented(harness, rescoped, freshAt(base), {
      current: rescoped,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
    // A re-scoped CURRENT record paired with the GENUINE presented
    // artifact is not a presentation of the same proof — the pair
    // binding fails first (machine-readable field detail).
    const mismatched = await verifyPresented(harness, presentedFrom(base), freshAt(base), {
      current: rescoped,
    });
    expect(mismatched.valid).toBe(false);
    expect(mismatched.reason).toBe("proof_pair_mismatch");
    expect(mismatched.checks.at(-1)?.subject).toBe("organizationScopeId");
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
    // SIGNED revocation state — re-read the STORED (re-sealed, revoked)
    // record so the artifact carries the current revocation state.
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

  // ---- THE PR #64 ARCHITECT-REVIEW REMEDIATION CASES ----------------

  test("PR #64 REMEDIATION: a portable artifact CAPTURED before revocation can never subsequently return `verified`", async () => {
    // The architect's demanded scenario: capture (export) the portable
    // artifact while the proof is live, revoke the authoritative proof,
    // then verify the captured copy — paired with the authority's
    // CURRENT sealed record (the verifier's protocol: the current
    // record's SIGNED one-way revocation state governs).
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    const captured = captureOf(proof);

    // Pre-revocation: the pair verifies.
    const before = await verifyPresented(harness, captured, freshAt(proof));
    expect(before.valid).toBe(true);
    expect(before.reason).toBe("verified");

    // Revoke the AUTHORITATIVE proof.
    await revoke(proof, "ac03 post-capture revocation");

    // The captured artifact — evaluated at a STILL-FRESH time — can
    // no longer return `verified` on ANY surface:
    const current = await currentOf(proof);
    expect(current.revokedAt).not.toBeNull();
    const verdict = await verifyPresented(harness, captured, freshAt(proof), {
      current,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("proof_revoked");
    // The failing check is the CURRENT record's revocation gate
    // (machine-readable detail — the captured artifact's own gates
    // all pass; the current state governs).
    expect(verdict.checks.at(-1)?.check).toBe("current:revocation");
    expect(verdict.checks.at(-1)?.passed).toBe(false);
    expect(verdict.checks.at(-1)?.reason).toBe("proof_revoked");
    // The authority-side surface fails closed too.
    expect((await verifyStored(harness, proof.id, freshAt(proof))).reason).toBe("proof_revoked");
    // And the CURRENT presentation paired with itself fails (a fresh
    // re-read cannot rescue the captured copy either).
    const currentPresentation = await verifyPresented(harness, presentedFrom(current), freshAt(proof), {
      current: presentedFrom(current),
    });
    expect(currentPresentation.valid).toBe(false);
    expect(currentPresentation.reason).toBe("proof_revoked");
    // Repeated verification of the same (captured, current, evaluatedAt)
    // triple stays byte-identical — deterministic, fail-closed.
    const repeat = await verifyPresented(harness, captured, freshAt(proof), {
      current,
    });
    expect(JSON.stringify(repeat)).toBe(JSON.stringify(verdict));
  });

  test("PR #64 REMEDIATION: tampering/REMOVAL of the revocation representation fails closed (the fields are SIGNED)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    const captured = captureOf(proof);
    await revoke(proof, "ac03 tamper-matrix revocation");
    const current = await currentOf(proof);

    // A revoked artifact with its revocation fields STRIPPED or RESET
    // no longer retains a valid signature: the canonical input
    // includes the SIGNED revoked-at/revocation-reason lines.
    const stripped: ReputationProof[] = [
      // Full strip (both fields reset to null).
      { ...current, revokedAt: null, revocationReason: null },
      // Timestamp stripped, reason kept.
      { ...current, revokedAt: null },
      // Reason altered, timestamp stripped (pins that the REASON is
      // signed too — altering it breaks the re-seal).
      { ...current, revokedAt: null, revocationReason: "reset reason" },
    ];
    for (const tampered of stripped) {
      // As the PRESENTED half (the stripped artifact's own gates: the
      // revocation gate passes on the stripped state, the signature
      // check catches the forgery).
      const asPresented = await verifyPresented(harness, tampered, freshAt(proof), {
        current,
      });
      expect(asPresented.valid).toBe(false);
      expect(asPresented.reason).toBe("signature_mismatch");
      // As the CURRENT half (a verifier fed a stripped "current"
      // record fails the same way — the stripped copy is not the
      // sealed record).
      const asCurrent = await verifyPresented(harness, captured, freshAt(proof), {
        current: tampered,
      });
      expect(asCurrent.valid).toBe(false);
      expect(asCurrent.reason).toBe("signature_mismatch");
    }

    // A RESET timestamp (non-null, not the sealed value) still fails
    // closed at the revocation gate — belt and suspenders.
    const resetTimestamp = {
      ...current,
      revokedAt: shiftIso(current.revokedAt ?? "", 1000),
    } as ReputationProof;
    const verdict = await verifyPresented(harness, resetTimestamp, freshAt(proof), {
      current,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("proof_revoked");
  });

  test("PR #64 REMEDIATION: mismatched presentation pairs fail closed: proof_pair_mismatch", async () => {
    const snapshotA = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const a = (await issueProof(harness, { snapshotId: snapshotA.id })).proof;
    const snapshotB = await seedSubjectSnapshot(harness, { inputCount: 3 });
    const b = (await issueProof(harness, { snapshotId: snapshotB.id })).proof;

    // A DIFFERENT proof's genuine capture paired with proof A's
    // current record: both artifacts are internally valid, but the
    // pair is not a presentation of the same proof.
    const mismatch = await verifyPresented(harness, presentedFrom(b), freshAt(a), {
      current: presentedFrom(a),
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.reason).toBe("proof_pair_mismatch");
    expect(mismatch.checks.at(-1)?.check).toBe("pair_binding");
    expect(mismatch.checks.at(-1)?.subject).toBe("id");
    // The presented artifact's OWN gates all passed before the pair
    // binding fired (the capture is a genuine artifact of ANOTHER
    // proof — the machine-readable detail shows exactly that).
    expect(mismatch.checks.filter((c) => c.check.startsWith("presented:")).every((c) => c.passed)).toBe(
      true,
    );

    // A RE-LABELED artifact (another proof's id on a genuine capture)
    // fails the SIGNATURE check — the proof id is SIGNED into the
    // canonical input (a revocation target cannot be re-pointed).
    const relabeled = { ...presentedFrom(b), id: a.id } as ReputationProof;
    const relabelVerdict = await verifyPresented(harness, relabeled, freshAt(a), {
      current: presentedFrom(a),
    });
    expect(relabelVerdict.valid).toBe(false);
    expect(relabelVerdict.reason).toBe("signature_mismatch");
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
    // The verifier holds the presented PAIR (the holder's captured
    // artifact + the current sealed record fetched BEFORE the
    // deletion); the verification function is a PURE derivation over
    // that pair — zero tenant-state queries.
    const current = presentedFrom(base);
    const before = await verifyPresented(harness, presentedFrom(base), freshAt(base), {
      current,
    });
    await deleteRecord(harness, REPUTATION_PROOFS_COLLECTION, base.id);
    const after = await verifyPresented(harness, presentedFrom(base), freshAt(base), {
      current,
    });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // The authority-side surface, by contrast, is store-backed: the
    // deleted record is NOT FOUND (indistinguishable from any other
    // missing id — no existence oracle).
    await expect(verifyStored(harness, base.id, freshAt(base))).rejects.toThrow(
      /reputation proof not found/,
    );
  });
});
