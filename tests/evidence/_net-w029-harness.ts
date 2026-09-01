/**
 * NET-W029 shared test harness — signed attestations (issue #58).
 *
 * Wraps the NET-W005 harness (runtime + authenticated principal +
 * organization + W005 guard actions + the PoV transition policies) and
 * adds:
 *  - the four NET-W029 guard actions (signedAttestation.create|read|
 *    verify|revoke, subject "*" resource "*");
 *  - a SECOND person + organization for cross-tenant fail-closed
 *    tests;
 *  - an opportunity/contribution subject + evidence factories;
 *  - coverage-family seed factories (a REAL W007 reputation input, a
 *    REAL W008 settlement value record) built through the OWNERS'
 *    services — never through direct store writes;
 *  - REAL Ed25519 / ECDSA P-256 versioned adapter factories (key pairs
 *    generated per harness via node:crypto, wrapped by the
 *    composition-root helpers);
 *  - direct-store tamper/delete helpers for the tamper-evidence suites
 *    (the authority shim is the system-of-record test double; the
 *    helpers simulate out-of-band corruption of authoritative state).
 *
 * The harness uses the file-backed PostgresAuthorityShim so it runs
 * without a real PostgreSQL (the CI integration job exercises the real
 * adapters).
 */

import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createNetW005Harness,
  createContributionSubject,
  createOpportunitySubject,
  type NetW005Harness,
} from "./_net-w005-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  CreateSignedAttestationResult,
  Evidence,
  SignedAttestation,
  SignedAttestationSigner,
  SignedAttestationVerifier,
} from "../../src/evidence/port.ts";
import {
  createEd25519VersionedSignerVerifier,
  createEcdsaP256VersionedSignerVerifier,
} from "../../src/bootstrap/attestation-signing.ts";
import {
  SIGNED_ATTESTATIONS_COLLECTION,
} from "../../src/evidence/authority-signed-attestation-repository.ts";
import { EVIDENCE_COLLECTION } from "../../src/evidence/authority-evidence-repository.ts";
import { REPUTATION_INPUTS_COLLECTION } from "../../src/reputation/authority-input-repository.ts";
import { ECONOMIC_VALUE_RECORDS_COLLECTION } from "../../src/settlement/authority-value-repository.ts";
import type { ReputationInput } from "../../src/reputation/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";

export interface NetW029Harness {
  readonly runtime: NetW005Harness["runtime"];
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
  /** A contribution subject for evidence factories. */
  readonly contributionId: string;
  teardown(): Promise<void>;
}

export interface NetW029HarnessOptions {
  /**
   * Versioned (signed-attestation) adapters forwarded to the runtime
   * (e.g. REAL Ed25519/ECDSA pairs, or a FAILING signer for fault
   * injection). Omitted → the dev/test HMAC default.
   */
  readonly attestation?: {
    readonly versionedSigner?: SignedAttestationSigner;
    readonly versionedVerifier?: SignedAttestationVerifier;
  };
}

export async function createNetW029Harness(
  opts: NetW029HarnessOptions = {},
): Promise<NetW029Harness> {
  const w005 = await createNetW005Harness(
    opts.attestation ? { attestation: opts.attestation } : {},
  );
  const runtime = w005.runtime;
  const bootstrapCtx = w005.bootstrapCtx;

  // A second person + organization for cross-tenant fail-closed tests.
  const otherPerson = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Other Org Actor",
    subjectReferences: [{ subjectId: "other@example.com", providerKind: "internal" }],
  });
  const otherOrg = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Other Org",
    creatorId: otherPerson.id,
  });

  // NET-W029 guard actions (subject "*": any authenticated principal
  // with an allow policy can call; tenant scoping is enforced by the
  // services — the same convention as the W005 harness).
  for (const action of [
    "signedAttestation.create",
    "signedAttestation.read",
    "signedAttestation.verify",
    "signedAttestation.revoke",
  ]) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  const opportunity = await createOpportunitySubject(w005);
  const contribution = await createContributionSubject(w005, opportunity.id);

  return {
    runtime,
    bootstrapCtx,
    personId: w005.personId,
    subjectId: w005.subjectId,
    organizationScopeId: w005.organizationScopeId,
    otherPersonId: otherPerson.id,
    otherSubjectId: "other@example.com",
    otherOrganizationScopeId: otherOrg.id,
    contributionId: contribution.id,
    async teardown() {
      await w005.teardown();
    },
  };
}

/** Execution context for the harness person. */
export function actorCtx(harness: NetW029Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

/** Execution context for the SECOND (cross-tenant) person. */
export function otherActorCtx(harness: NetW029Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.otherPersonId, kind: "person" },
  });
}

/** A random idempotency key (per-call uniqueness). */
export function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

// ---------------------------------------------------------------------
// Coverage-family factories (through the OWNERS' services).
// ---------------------------------------------------------------------

export interface CreateEvidenceOptions {
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
  readonly sensitivity?: "standard" | "sensitive";
  readonly sensitivePayload?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Create the evidence in the OTHER org (cross-scope coverage tests). */
  readonly otherOrg?: boolean;
}

export async function createEvidenceRecord(
  harness: NetW029Harness,
  opts: CreateEvidenceOptions = {},
): Promise<Evidence> {
  const ctx = opts.otherOrg
    ? otherActorCtx(harness, "w029-evidence-other")
    : actorCtx(harness, "w029-evidence");
  return harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: opts.otherOrg
      ? harness.otherOrganizationScopeId
      : harness.organizationScopeId,
    ownerId: opts.otherOrg ? harness.otherPersonId : harness.personId,
    subjectReference: { subjectId: harness.contributionId, subjectType: "contribution" },
    provenance: {
      sourceType: opts.sourceType ?? "platform",
      method: "instrumentation",
    },
    confidence: { point: 0.9 },
    ...(opts.sensitivity !== undefined ? { sensitivity: opts.sensitivity } : {}),
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.sensitivePayload !== undefined ? { sensitivePayload: opts.sensitivePayload } : {}),
  });
}

/** A REAL W007 reputation input (through the reputation authority's own service). */
export async function seedReputationInput(
  harness: NetW029Harness,
  opts: { readonly sourceEvidenceId?: string } = {},
): Promise<ReputationInput> {
  const evidence = await ensureSourceEvidence(harness, opts.sourceEvidenceId);
  const ctx = actorCtx(harness, "w029-reputation-input");
  const result = await harness.runtime.reputationInputService.recordInput(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectPersonId: harness.personId,
    dimension: "helpfulness",
    sources: [{ kind: "evidence", id: evidence.id }],
    description: "w029 coverage input",
    occurredAt: "2026-01-15T00:00:00.000Z",
    idempotencyKey: key("w029-rep"),
  });
  return result.input;
}

/** A REAL W008 settlement value record (through the settlement authority's own service). */
export async function seedSettlementValue(
  harness: NetW029Harness,
  opts: {
    readonly amount?: number;
    readonly sourceEvidenceId?: string;
    readonly state?: "PENDING" | "MATURE";
  } = {},
): Promise<EconomicValueRecord> {
  const evidence = await ensureSourceEvidence(harness, opts.sourceEvidenceId);
  const ctx = actorCtx(harness, "w029-settlement-value");
  const result = await harness.runtime.economicValueService.recordPendingValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    beneficiaryPersonId: harness.personId,
    amount: opts.amount ?? 100,
    sources: [{ kind: "evidence", id: evidence.id }],
    maturation: { strategy: "immediate" },
    description: "w029 coverage value",
    idempotencyKey: key("w029-value"),
  });
  if (opts.state === "MATURE") {
    return harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: result.value.id,
      idempotencyKey: key("w029-mature"),
    });
  }
  return result.value;
}

/** Reverse a settlement value record through the settlement authority's own service. */
export async function reverseSettlementValue(
  harness: NetW029Harness,
  valueRecordId: string,
): Promise<EconomicValueRecord> {
  const ctx = actorCtx(harness, "w029-reverse-value");
  return harness.runtime.economicValueService.reverseValue(ctx, {
    valueRecordId,
    reason: "w029 reversal (containment test)",
    idempotencyKey: key("w029-reverse"),
  });
}

// Per-harness lazily-created source evidence (each harness owns its own
// authority store; a module-level singleton would leak across
// runtimes).
const sharedSourceEvidenceByHarness = new WeakMap<NetW029Harness, Evidence>();
async function ensureSourceEvidence(
  harness: NetW029Harness,
  sourceEvidenceId: string | undefined,
): Promise<Evidence> {
  if (sourceEvidenceId !== undefined) {
    return harness.runtime.evidenceService.getEvidence(
      actorCtx(harness, "w029-evidence-get"),
      sourceEvidenceId,
    );
  }
  let shared = sharedSourceEvidenceByHarness.get(harness);
  if (shared === undefined) {
    shared = await createEvidenceRecord(harness);
    sharedSourceEvidenceByHarness.set(harness, shared);
  }
  return shared;
}

// ---------------------------------------------------------------------
// Signed-attestation factory (service level).
// ---------------------------------------------------------------------

export interface CreateSignedAttestationOptions {
  readonly statement?: string;
  readonly verifierId?: string;
  readonly idempotencyKey?: string;
}

export async function createSignedAttestation(
  harness: NetW029Harness,
  coverage: readonly { readonly family: string; readonly recordId: string }[],
  opts: CreateSignedAttestationOptions = {},
): Promise<CreateSignedAttestationResult> {
  const ctx = actorCtx(harness, "w029-signed-attestation");
  return harness.runtime.signedAttestationService.createSignedAttestation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    verifierId: opts.verifierId ?? harness.personId,
    statement: opts.statement ?? "w029 test attestation",
    coverage,
    idempotencyKey: opts.idempotencyKey ?? key("w029-att"),
  });
}

// ---------------------------------------------------------------------
// REAL versioned adapter factories (Ed25519 / ECDSA P-256).
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

// ---------------------------------------------------------------------
// Direct-store tamper/delete helpers (tamper-evidence suites).
// ---------------------------------------------------------------------

/**
 * Corrupt an authoritative record in place (simulates out-of-band
 * tampering of the system of record — the exact threat the
 * re-derivation checks must detect).
 */
export async function tamperRecord<T>(
  harness: NetW029Harness,
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

/** Remove an authoritative record outright (covered_record_missing). */
export async function deleteRecord(
  harness: NetW029Harness,
  collection: string,
  id: string,
): Promise<void> {
  await harness.runtime.postgresAuthority.run(harness.bootstrapCtx, async (tx) => {
    await tx.delete(collection, id);
  });
}

/** Tamper a stored signed attestation (statement/coverage/signature/algorithm/key/revocation). */
export async function tamperSignedAttestation(
  harness: NetW029Harness,
  attestationId: string,
  mutate: (record: SignedAttestation) => SignedAttestation,
): Promise<void> {
  await tamperRecord<SignedAttestation>(
    harness,
    SIGNED_ATTESTATIONS_COLLECTION,
    attestationId,
    mutate,
  );
}

export {
  SIGNED_ATTESTATIONS_COLLECTION,
  EVIDENCE_COLLECTION,
  REPUTATION_INPUTS_COLLECTION,
  ECONOMIC_VALUE_RECORDS_COLLECTION,
};
