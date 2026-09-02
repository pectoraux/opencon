/**
 * NET-W031-AC-08 — atomicity, idempotency, concurrency, lifecycle
 * (issue #63; work order §3.6/§5).
 *
 *  - composite idempotency: same key → deterministic replay (exactly
 *    one record + one audit event); different keys → additional
 *    proofs (append-only);
 *  - concurrent same-key issuance → exactly one record;
 *  - a SIGNER failure inside the issuance transaction rolls the
 *    mutation back ENTIRELY (no proof record, no audit, no idempotency
 *    consumption — the retry succeeds);
 *  - an AUDIT append failure inside the transaction rolls the mutation
 *    back entirely;
 *  - ONE-WAY revocation: a revoked proof never verifies again;
 *    revoking an already-revoked proof is an idempotent no-op (no
 *    second mutation, no second audit event); concurrent revocations
 *    produce exactly one audit event;
 *  - staleness is a VERIFICATION-TIME derivation: the verdict flips
 *    with evaluatedAt WITHOUT any stored lifecycle mutation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  AuthorityTransaction,
} from "../../src/core/postgres-authority.ts";
import type {
  TransactionalAuditBuffer,
  TransactionalAuditWriter,
} from "../../src/core/audit.ts";
import { REPUTATION_PROOFS_COLLECTION } from "../../src/reputation/authority-proof-repository.ts";
import { createAuthorityReputationProofRepository } from "../../src/reputation/authority-proof-repository.ts";
import { createAuthorityReputationSnapshotRepository } from "../../src/reputation/authority-snapshot-repository.ts";
import { createReputationProofService } from "../../src/reputation/proof-service.ts";
import type {
  ReputationProofSigner,
  ReputationProofVerifier,
} from "../../src/reputation/port.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import {
  SIGNED_ATTESTATION_ALGORITHMS,
  SIGNED_ATTESTATION_KEY_REFERENCES,
  SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM,
  type SignedAttestationSigner,
  type SignedAttestationVerifier,
} from "../../src/evidence/port.ts";
import {
  createHmacVersionedSignerVerifier,
} from "../../src/bootstrap/attestation-signing.ts";
import { DEV_INSECURE_ATTESTATION_KEY } from "../../src/evidence/hmac-attestation-verifier.ts";
import type { ReputationProof, ReputationSnapshot } from "../../src/reputation/port.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  verifyStored,
  freshAt,
  staleAt,
  actorCtx,
  key,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
  forModule() {
    return this;
  },
} as unknown as Parameters<typeof createReputationProofService>[0]["logger"];

let harness: NetW031Harness;
let snapshot: ReputationSnapshot;

beforeEach(async () => {
  harness = await createNetW031Harness();
  snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
});

afterEach(async () => {
  await harness.teardown();
});

/** The REAL dev-default versioned pair (the test-env selection). */
function devPair(): SignedAttestationSigner & SignedAttestationVerifier {
  return createHmacVersionedSignerVerifier({
    key: DEV_INSECURE_ATTESTATION_KEY,
    keyReference: "attestation-signing/dev-insecure/v1",
  });
}

/** A failing neutral signer (fault injection at the composed boundary). */
function failingSigner(): SignedAttestationSigner {
  return {
    algorithm: "hmac-sha256/v1",
    keyReference: "attestation-signing/dev-insecure/v1",
    async signVersioned(): Promise<never> {
      throw new Error("injected signer failure");
    },
  };
}

// The NEUTRAL-contract adapters — the exact thin wrappers the
// composition root wires (the reputation port's contracts over the
// W029 versioned surface; the only join).
function asProofSigner(signer: SignedAttestationSigner): ReputationProofSigner {
  return {
    algorithm: signer.algorithm,
    keyReference: signer.keyReference,
    signProof: (canonicalInput) => signer.signVersioned(canonicalInput),
  };
}
function asProofVerifier(verifier: SignedAttestationVerifier): ReputationProofVerifier {
  return {
    verifyProof: (canonicalInput, envelope) =>
      verifier.verifyVersioned(canonicalInput, envelope),
  };
}

/** Build a proof service over the harness authority with custom parts. */
function buildService(
  harness: NetW031Harness,
  parts: {
    readonly signer?: SignedAttestationSigner;
    readonly verifier?: SignedAttestationVerifier;
    readonly auditWriter?: TransactionalAuditWriter;
  },
) {
  const authority = harness.runtime.postgresAuthority;
  const pair = devPair();
  return createReputationProofService({
    proofRepository: createAuthorityReputationProofRepository({ authority }),
    snapshotRepository: createAuthorityReputationSnapshotRepository({ authority }),
    signer: asProofSigner(parts.signer ?? pair),
    verifier: asProofVerifier(parts.verifier ?? pair),
    signingVocabulary: {
      algorithms: SIGNED_ATTESTATION_ALGORITHMS,
      keyReferences: SIGNED_ATTESTATION_KEY_REFERENCES,
      keyReferenceByAlgorithm:
        SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM as Readonly<Record<string, readonly string[]>>,
    },
    idempotency: createPostgresIdempotencyStore({ authority }),
    auditWriter: parts.auditWriter ?? harness.runtime.auditWriter,
    logger: silentLogger,
  });
}

describe("NET-W031-AC-08 atomicity/idempotency/concurrency", () => {
  test("repeating an issuance with the SAME idempotency key is a deterministic replay (one record, one audit event)", async () => {
    const ctx = actorCtx(harness, "ac08-replay");
    const request = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      snapshotId: snapshot.id,
      idempotencyKey: "ac08-replay-key",
    };
    const first = await harness.runtime.reputationProofService.issueProof(ctx, request);
    const second = await harness.runtime.reputationProofService.issueProof(ctx, request);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.proof).toEqual(first.proof);
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_proof.issued",
      resourceId: first.proof.id,
    });
    expect(events).toHaveLength(1);
    expect(await harness.runtime.postgresAuthority.count(REPUTATION_PROOFS_COLLECTION)).toBe(1);
  });

  test("two CONCURRENT same-key issuances produce exactly one record", async () => {
    const ctx = actorCtx(harness, "ac08-concurrent");
    const request = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      snapshotId: snapshot.id,
      idempotencyKey: "ac08-concurrent-key",
    };
    const [a, b] = await Promise.all([
      harness.runtime.reputationProofService.issueProof(ctx, request),
      harness.runtime.reputationProofService.issueProof(ctx, request),
    ]);
    expect(a.created !== b.created).toBe(true);
    expect(a.proof.id).toBe(b.proof.id);
    expect(await harness.runtime.postgresAuthority.count(REPUTATION_PROOFS_COLLECTION)).toBe(1);
  });

  test("different keys append (independent records, independent audit events)", async () => {
    const a = await issueProof(harness, { snapshotId: snapshot.id, idempotencyKey: key("ac08-a") });
    const b = await issueProof(harness, { snapshotId: snapshot.id, idempotencyKey: key("ac08-b") });
    expect(a.proof.id).not.toBe(b.proof.id);
    expect(await harness.runtime.postgresAuthority.count(REPUTATION_PROOFS_COLLECTION)).toBe(2);
    for (const proof of [a.proof, b.proof]) {
      const events = await harness.runtime.auditWriter.query({
        eventType: "reputation_proof.issued",
        resourceId: proof.id,
      });
      expect(events).toHaveLength(1);
    }
  });

  test("a SIGNER failure inside the issuance transaction rolls the mutation back ENTIRELY (no record, no audit, no idempotency consumption)", async () => {
    const ctx = actorCtx(harness, "ac08-signer-failure");
    const service = buildService(harness, { signer: failingSigner() });

    await expect(
      service.issueProof(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        snapshotId: snapshot.id,
        idempotencyKey: "ac08-signer-failure-key",
      }),
    ).rejects.toThrow("injected signer failure");

    // NOTHING survived: no proof record, no issued audit event.
    expect(await harness.runtime.postgresAuthority.count(REPUTATION_PROOFS_COLLECTION)).toBe(0);
    expect(
      await harness.runtime.auditWriter.query({ eventType: "reputation_proof.issued" }),
    ).toHaveLength(0);

    // A RETRY with the SAME key through the healthy wired service
    // succeeds — the failed attempt consumed no idempotency record.
    const retried = await harness.runtime.reputationProofService.issueProof(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      snapshotId: snapshot.id,
      idempotencyKey: "ac08-signer-failure-key",
    });
    expect(retried.created).toBe(true);
    expect(await harness.runtime.postgresAuthority.count(REPUTATION_PROOFS_COLLECTION)).toBe(1);
  });

  test("an AUDIT append failure inside the transaction rolls the mutation back ENTIRELY", async () => {
    const ctx = actorCtx(harness, "ac08-audit-failure");
    const throwingBuffer: TransactionalAuditBuffer = {
      async append() {
        throw new Error("injected audit append failure");
      },
      async query() {
        return [];
      },
      async count() {
        return 0;
      },
      pendingCount() {
        return 0;
      },
    };
    const throwingWriter: TransactionalAuditWriter = {
      async append(input) {
        return harness.runtime.auditWriter.append(input);
      },
      async query(query) {
        return harness.runtime.auditWriter.query(query);
      },
      async count() {
        return harness.runtime.auditWriter.count();
      },
      forTransaction(_tx: AuthorityTransaction) {
        return throwingBuffer;
      },
      async retryPendingPublications() {
        return { published: 0, remaining: 0 };
      },
      pendingPublicationCount() {
        return 0;
      },
    };
    // REAL signing material (the dev-default pair), broken audit path.
    const service = buildService(harness, { auditWriter: throwingWriter });

    await expect(
      service.issueProof(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        snapshotId: snapshot.id,
        idempotencyKey: "ac08-audit-failure-key",
      }),
    ).rejects.toThrow("injected audit append failure");

    // NOTHING survived: no proof record, no published audit event, no
    // idempotency consumption.
    expect(await harness.runtime.postgresAuthority.count(REPUTATION_PROOFS_COLLECTION)).toBe(0);
    const healed = await harness.runtime.reputationProofService.issueProof(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      snapshotId: snapshot.id,
      idempotencyKey: "ac08-audit-failure-key",
    });
    expect(healed.created).toBe(true);
  });

  test("ONE-WAY revocation: revoked never verifies; re-revocation is an idempotent no-op; audited once", async () => {
    const ctx = actorCtx(harness, "ac08-revoke");
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    expect((await verifyStored(harness, proof.id, freshAt(proof))).valid).toBe(true);

    const revoked = await harness.runtime.reputationProofService.revokeProof(ctx, {
      organizationScopeId: harness.organizationScopeId,
      proofId: proof.id,
      reason: "ac08 revocation reason",
      idempotencyKey: key("ac08-revoke"),
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revocationReason).toBe("ac08 revocation reason");
    expect((await verifyStored(harness, proof.id, freshAt(proof))).reason).toBe("proof_revoked");

    // Re-revocation: the record is returned UNCHANGED (no second
    // mutation, no second audit event).
    const reRevoked = await harness.runtime.reputationProofService.revokeProof(ctx, {
      organizationScopeId: harness.organizationScopeId,
      proofId: proof.id,
      reason: "different reason on replay",
      idempotencyKey: key("ac08-revoke-again"),
    });
    expect(reRevoked).toEqual(revoked);
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_proof.revoked",
      resourceId: proof.id,
    });
    expect(events).toHaveLength(1);
    const event = events[0] as { metadata: Record<string, unknown> };
    expect(event.metadata.reason).toBe("ac08 revocation reason");
  });

  test("two CONCURRENT revocations produce exactly one revokedAt value and one audit event", async () => {
    const ctx = actorCtx(harness, "ac08-concurrent-revoke");
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    const [a, b] = await Promise.all([
      harness.runtime.reputationProofService.revokeProof(ctx, {
        organizationScopeId: harness.organizationScopeId,
        proofId: proof.id,
        reason: "concurrent revocation",
        idempotencyKey: key("ac08-cr-a"),
      }),
      harness.runtime.reputationProofService.revokeProof(ctx, {
        organizationScopeId: harness.organizationScopeId,
        proofId: proof.id,
        reason: "concurrent revocation",
        idempotencyKey: key("ac08-cr-b"),
      }),
    ]);
    expect(a.revokedAt).toBe(b.revokedAt);
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_proof.revoked",
      resourceId: proof.id,
    });
    expect(events).toHaveLength(1);
  });

  test("staleness is a VERIFICATION-TIME derivation (no stored lifecycle state flips with the verdict)", async () => {
    const { proof }: { proof: ReputationProof } = await issueProof(harness, {
      snapshotId: snapshot.id,
    });
    const before = JSON.stringify(proof);
    // Fresh at t1, stale at t2 — the STORED record never changes.
    expect((await verifyStored(harness, proof.id, freshAt(proof))).valid).toBe(true);
    expect((await verifyStored(harness, proof.id, staleAt(proof))).reason).toBe("proof_stale");
    const after = await harness.runtime.reputationProofService.getProof(
      actorCtx(harness, "ac08-stale-read"),
      harness.organizationScopeId,
      proof.id,
    );
    expect(JSON.stringify(after)).toBe(before);
    // ...and flips BACK to fresh at a fresh time (no one-way latch).
    expect((await verifyStored(harness, proof.id, freshAt(proof))).valid).toBe(true);
  });
});
