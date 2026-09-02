/**
 * NET-W031 shared test harness — portable reputation proofs (issue #63).
 *
 * Wraps the NET-W007 harness (runtime + authenticated principal +
 * organization + the W007/W005 guard actions + the transition
 * policies) and adds:
 *  - the four NET-W031 guard actions (reputationProof.create|read|
 *    verify|revoke, subject "*" resource "*");
 *  - a SECOND person + organization for cross-tenant fail-closed
 *    tests (the W029 harness pattern);
 *  - a subject-snapshot seed factory (policy + verified input +
 *    recorded snapshot through the OWNERS' services — never direct
 *    store writes), for the harness person AND the second tenant;
 *  - a service-level proof issuance factory;
 *  - the self-contained presentation projection helper + staleness
 *    timestamp derivation helpers (issuedAt-relative, deterministic);
 *  - REAL Ed25519 / ECDSA P-256 versioned adapter factories (the W029
 *    pattern — proofs COMPOSE the same machinery);
 *  - direct-store tamper/delete helpers for the tamper-evidence and
 *    self-containment suites (the authority shim is the
 *    system-of-record test double).
 *
 * The harness uses the file-backed PostgresAuthorityShim so it runs
 * without a real PostgreSQL (the CI integration job exercises the real
 * adapters).
 */

import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ReputationDimension } from "../../src/core/reputation.ts";
import type { SignedAttestationSigner, SignedAttestationVerifier } from "../../src/evidence/port.ts";
import {
  createEd25519VersionedSignerVerifier,
  createEcdsaP256VersionedSignerVerifier,
} from "../../src/bootstrap/attestation-signing.ts";
import type {
  PresentedReputationProof,
  ReputationProof,
  ReputationScoringPolicy,
  ReputationSnapshot,
} from "../../src/reputation/port.ts";
import { REPUTATION_PROOF_FRESHNESS_WINDOW_MS } from "../../src/reputation/port.ts";
import { REPUTATION_PROOFS_COLLECTION } from "../../src/reputation/authority-proof-repository.ts";
import {
  createNetW007Harness,
  DEFAULT_POLICY_RULES,
  REF_AT,
  type NetW007Harness,
  type NetW007HarnessOptions,
} from "./_net-w007-harness.ts";
export { REF_AT, REF_AT_LATER } from "./_net-w007-harness.ts";

export interface NetW031Harness {
  readonly runtime: NetW007Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The canonical person identity id of the authorized actor. */
  readonly personId: string;
  /** The subject id used by the API auth guard (X-Auth-Subject-Id). */
  readonly subjectId: string;
  readonly organizationScopeId: string;
  /** A SECOND person in a SECOND organization (cross-tenant tests). */
  readonly otherPersonId: string;
  readonly otherSubjectId: string;
  readonly otherOrganizationScopeId: string;
  teardown(): Promise<void>;
}

export async function createNetW031Harness(
  opts: NetW007HarnessOptions = {},
): Promise<NetW031Harness> {
  const w007 = await createNetW007Harness(opts.attestation ? { attestation: opts.attestation } : {});
  const runtime = w007.runtime;
  const bootstrapCtx = w007.bootstrapCtx;

  // A second person + organization for cross-tenant fail-closed tests.
  const otherPerson = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Other Org Proof Actor",
    subjectReferences: [{ subjectId: "other-proof@example.com", providerKind: "internal" }],
  });
  const otherOrg = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Other Proof Org",
    creatorId: otherPerson.id,
  });

  // NET-W031 guard actions (subject "*": any authenticated principal
  // with an allow policy can call; tenant scoping is enforced by the
  // services — the same convention as the W007/W029 harnesses).
  for (const action of [
    "reputationProof.create",
    "reputationProof.read",
    "reputationProof.verify",
    "reputationProof.revoke",
  ]) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    runtime,
    bootstrapCtx,
    personId: w007.personId,
    subjectId: w007.subjectId,
    organizationScopeId: w007.organizationScopeId,
    otherPersonId: otherPerson.id,
    otherSubjectId: "other-proof@example.com",
    otherOrganizationScopeId: otherOrg.id,
    async teardown() {
      await w007.teardown();
    },
  };
}

/** Execution context for the harness person. */
export function actorCtx(harness: NetW031Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

/** Execution context for the SECOND (cross-tenant) person. */
export function otherActorCtx(harness: NetW031Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.otherPersonId, kind: "person" },
  });
}

/** A random idempotency key (per-call uniqueness). */
export function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Deterministic ISO timestamp shift (ms from a base timestamp). */
export function shiftIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** A timestamp comfortably INSIDE the freshness window of `proof`. */
export function freshAt(proof: { readonly issuedAt: string }): string {
  return shiftIso(proof.issuedAt, 1000);
}

/** A timestamp OUTSIDE the freshness window of `proof` (stale). */
export function staleAt(proof: { readonly issuedAt: string }): string {
  return shiftIso(proof.issuedAt, REPUTATION_PROOF_FRESHNESS_WINDOW_MS + 1000);
}

/**
 * The SELF-CONTAINED presentation projection of a stored proof — the
 * exact artifact a verifier receives (identity + lineage + aggregate
 * facts + envelope; write bookkeeping stripped).
 */
export function presentedFrom(proof: ReputationProof): PresentedReputationProof {
  return {
    id: proof.id,
    organizationScopeId: proof.organizationScopeId,
    subjectPersonId: proof.subjectPersonId,
    snapshotId: proof.snapshotId,
    policyId: proof.policyId,
    policyVersion: proof.policyVersion,
    referenceAt: proof.referenceAt,
    digest: proof.digest,
    dimensions: proof.dimensions,
    algorithm: proof.algorithm,
    keyReference: proof.keyReference,
    signature: proof.signature,
    issuedAt: proof.issuedAt,
    revokedAt: proof.revokedAt,
    revocationReason: proof.revocationReason,
    createdAt: proof.createdAt,
    recordFormat: proof.recordFormat,
  };
}

// ---------------------------------------------------------------------
// Subject-snapshot seeding (through the OWNERS' services).
// ---------------------------------------------------------------------

export interface SeedSubjectSnapshotOptions {
  /** Number of verified inputs to record (default 1). */
  readonly inputCount?: number;
  readonly dimension?: ReputationDimension;
  readonly occurredAt?: string;
  readonly referenceAt?: string;
  /** Seed in the OTHER org for the OTHER subject (cross-tenant proofs). */
  readonly otherOrg?: boolean;
  /** A distinct policy lineage per snapshot (default: one per call). */
  readonly policyId?: string;
}

/**
 * Seed an authoritative subject snapshot (policy + verified evidence
 * input(s) + recorded snapshot) for the harness person — or, with
 * `otherOrg`, for the SECOND tenant's person — through the W007
 * authority's OWN services. Returns the recorded snapshot.
 */
export async function seedSubjectSnapshot(
  harness: NetW031Harness,
  opts: SeedSubjectSnapshotOptions = {},
): Promise<ReputationSnapshot> {
  const otherOrg = opts.otherOrg === true;
  const ctx = otherOrg
    ? otherActorCtx(harness, "w031-seed-other")
    : actorCtx(harness, "w031-seed");
  const organizationScopeId = otherOrg
    ? harness.otherOrganizationScopeId
    : harness.organizationScopeId;
  const subjectPersonId = otherOrg ? harness.otherPersonId : harness.personId;

  const policyId = opts.policyId ?? `policy-w031-${randomUUID()}`;
  const policy: ReputationScoringPolicy =
    await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId,
      policyId,
      version: 1,
      description: "NET-W031 test policy",
      rules: DEFAULT_POLICY_RULES,
    });

  const dimension = opts.dimension ?? "helpfulness";
  const occurredAt = opts.occurredAt ?? "2024-06-01T00:00:00.000Z";
  const inputCount = opts.inputCount ?? 1;
  for (let i = 0; i < inputCount; i += 1) {
    // A platform-evidence source in the SAME scope (basis: verified).
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId,
      ownerId: subjectPersonId,
      subjectReference: { subjectId: subjectPersonId, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "instrumentation" },
      confidence: { point: 0.9 },
    });
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId,
      subjectPersonId,
      dimension,
      sources: [{ kind: "evidence", id: evidence.id }],
      occurredAt,
      idempotencyKey: key("w031-input"),
    });
  }

  const result = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
    organizationScopeId,
    subjectPersonId,
    policyId: policy.policyId,
    version: 1,
    referenceAt: opts.referenceAt ?? REF_AT,
    idempotencyKey: key("w031-snapshot"),
  });
  return result.snapshot;
}

// ---------------------------------------------------------------------
// Proof issuance factory (service level).
// ---------------------------------------------------------------------

export interface IssueProofOptions {
  readonly subjectPersonId?: string;
  readonly organizationScopeId?: string;
  readonly snapshotId?: string;
  readonly idempotencyKey?: string;
  readonly otherOrg?: boolean;
}

/** Issue a proof through the reputation proof service. */
export async function issueProof(
  harness: NetW031Harness,
  opts: IssueProofOptions = {},
) {
  const ctx = opts.otherOrg
    ? otherActorCtx(harness, "w031-issue-other")
    : actorCtx(harness, "w031-issue");
  return harness.runtime.reputationProofService.issueProof(ctx, {
    organizationScopeId:
      opts.organizationScopeId ??
      (opts.otherOrg ? harness.otherOrganizationScopeId : harness.organizationScopeId),
    // otherOrg defaults the subject to the SECOND tenant's person.
    subjectPersonId:
      opts.subjectPersonId ??
      (opts.otherOrg ? harness.otherPersonId : harness.personId),
    ...(opts.snapshotId !== undefined ? { snapshotId: opts.snapshotId } : {}),
    idempotencyKey: opts.idempotencyKey ?? key("w031-proof"),
  });
}

/** Verify a STORED proof by id at `evaluatedAt` (authority-side). */
export async function verifyStored(
  harness: NetW031Harness,
  proofId: string,
  evaluatedAt: string,
  opts: { readonly otherOrg?: boolean } = {},
) {
  return harness.runtime.reputationProofService.verifyProof(
    opts.otherOrg ? otherActorCtx(harness, "w031-verify-other") : actorCtx(harness, "w031-verify"),
    {
      organizationScopeId: opts.otherOrg
        ? harness.otherOrganizationScopeId
        : harness.organizationScopeId,
      proofId,
      evaluatedAt,
    },
  );
}

/** Verify a PRESENTED artifact at `evaluatedAt` (presentation-side). */
export async function verifyPresented(
  harness: NetW031Harness,
  presented: PresentedReputationProof,
  evaluatedAt: string,
) {
  return harness.runtime.reputationProofService.verifyPresentedProof(
    actorCtx(harness, "w031-verify-presented"),
    presented,
    evaluatedAt,
  );
}

// ---------------------------------------------------------------------
// REAL versioned adapter factories (Ed25519 / ECDSA P-256 — the W029
// pattern: proofs compose the SAME machinery).
// ---------------------------------------------------------------------

export interface RealVersionedAdapters {
  readonly versionedSigner: SignedAttestationSigner;
  readonly versionedVerifier: SignedAttestationVerifier;
  /** The PKCS#8 PEM (for SecretProvider-driven production-mode tests). */
  readonly privateKeyPem: string;
}

/** A REAL Ed25519 versioned pair (fresh key per call). */
export function makeEd25519Adapters(): RealVersionedAdapters {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pair = createEd25519VersionedSignerVerifier({ privateKeyPem });
  return { versionedSigner: pair, versionedVerifier: pair, privateKeyPem };
}

/** A REAL ECDSA P-256 versioned pair (fresh key per call). */
export function makeEcdsaP256Adapters(): RealVersionedAdapters {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pair = createEcdsaP256VersionedSignerVerifier({ privateKeyPem });
  return { versionedSigner: pair, versionedVerifier: pair, privateKeyPem };
}

export type { NetW007Harness };

// ---------------------------------------------------------------------
// Direct-store tamper/delete helpers (tamper-evidence suites).
// ---------------------------------------------------------------------

/**
 * Corrupt an authoritative record in place (simulates out-of-band
 * tampering of the system of record — the exact threat the signature
 * re-derivation must detect).
 */
export async function tamperRecord<T>(
  harness: NetW031Harness,
  collection: string,
  id: string,
  mutate: (value: T) => T,
): Promise<void> {
  await harness.runtime.postgresAuthority.run(harness.bootstrapCtx, async (tx) => {
    const rec = await tx.get<T>(collection, id);
    if (rec === null) {
      throw new Error(`tamper target not found: ${collection}/${id}`);
    }
    await tx.put(collection, id, mutate(rec.value));
  });
}

/** Remove an authoritative record outright. */
export async function deleteRecord(
  harness: NetW031Harness,
  collection: string,
  id: string,
): Promise<void> {
  await harness.runtime.postgresAuthority.run(harness.bootstrapCtx, async (tx) => {
    await tx.delete(collection, id);
  });
}

/** Tamper a stored proof (subject/facts/lineage/envelope/revocation). */
export async function tamperProof(
  harness: NetW031Harness,
  proofId: string,
  mutate: (record: ReputationProof) => ReputationProof,
): Promise<void> {
  await tamperRecord<ReputationProof>(harness, REPUTATION_PROOFS_COLLECTION, proofId, mutate);
}

export { REPUTATION_PROOFS_COLLECTION };
