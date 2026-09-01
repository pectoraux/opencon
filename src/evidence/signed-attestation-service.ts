/**
 * SignedAttestationService — NET-W029 cryptographic attestations and
 * commitments over the authoritative record families (issue #58).
 *
 * Architecture ref: spec/architecture-lock.md §4 (evidence authority),
 * §6 (privacy authority: commitments + attestations prove integrity
 * without publishing raw personal data), §3 (PostgreSQL authoritative),
 * §12 (execution lineage), §14 (provider neutrality). Work order:
 * spec/work-orders/NET-W029.md; requirements EVID-006 + PRIV-003.
 *
 * THE KEY RULES (work order §2–§4 + issue #58):
 *  - EXTEND, never rewrite: the W005 AttestationService, the
 *    `attestation/v1` canonical-input discipline and the
 *    Attestation/AttestationSigner/AttestationVerifier contracts are
 *    untouched; this service is the ADDITIVE v2 surface;
 *  - /reputation and /settlement keep their authorities: their records
 *    are covered read-only through the NEUTRAL coverage lookups wired
 *    at the composition root (facts-shaped, committed + in-tx twins —
 *    the W021/W027/W028 dependency-inversion precedent); this domain
 *    imports core contracts only;
 *  - the signer/verifier are INJECTED interfaces (verifier-neutral;
 *    real Ed25519/ECDSA production crypto lives behind them in the
 *    composition root — provider-specific code never enters the
 *    domain, key material never enters this file);
 *  - material mutations follow the established discipline: composite
 *    idempotency (`signed_attestation:{scope}:{verifier}:{key}` — the
 *    W007 input precedent), ONE authoritative transaction (the
 *    applyIdempotent context transaction), transactional audit
 *    buffering with post-commit publication, and the covered digests
 *    re-derived INSIDE the transaction (work order §3.7);
 *  - verification is deterministic, server-side, non-mutating and
 *    non-audited (a derived 200-style decision — the W028 evaluate
 *    precedent); it fails closed with machine-readable reasons from
 *    the closed vocabulary, and an attestation can NEVER make revoked
 *    or invalidated authoritative state verify as current;
 *  - revocation is ONE-WAY (a field mutation — the W028 closure
 *    precedent; /workflows is not extended).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  isSignedAttestationAlgorithm,
  isSignedAttestationCoverageFamily,
  isSignedAttestationKeyReference,
  SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM,
  SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS,
  SIGNED_ATTESTATION_RECORD_FORMAT,
} from "./port.ts";
import type {
  CreateSignedAttestationInput,
  CreateSignedAttestationResult,
  Evidence,
  EvidenceRepository,
  ReputationInputCoverageFacts,
  RevokeSignedAttestationInput,
  SettlementValueCoverageFacts,
  SignedAttestation,
  SignedAttestationCheck,
  SignedAttestationCoverageEntry,
  SignedAttestationCoverageFamily,
  SignedAttestationCoverageLookups,
  SignedAttestationRepository,
  SignedAttestationService,
  SignedAttestationSigner,
  SignedAttestationVerification,
  SignedAttestationVerificationReason,
  SignedAttestationVerifier,
} from "./port.ts";
import {
  buildSignedAttestationDigestInput,
  canonicalEvidenceCoverageFacts,
  canonicalReputationInputCoverageFacts,
  canonicalSettlementValueCoverageFacts,
  deriveCoverageCommitment,
} from "./signed-attestation-input.ts";
import { verifyEvidenceCommitment } from "./commitments.ts";

const SIGNED_ATTESTATION_CREATED = "signed_attestation.created" as const;
const SIGNED_ATTESTATION_REVOKED = "signed_attestation.revoked" as const;

/**
 * Raised when a signed-attestation input or contract usage is
 * malformed (empty statement, unknown coverage family, duplicate or
 * unbounded coverage, vocabulary violations, invalid revocation
 * input). Validation failures NEVER create partial state.
 */
export class InvalidSignedAttestationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVALID_SIGNED_ATTESTATION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

export interface SignedAttestationServiceDeps {
  readonly repository: SignedAttestationRepository;
  /** In-tx + committed reads of evidence records (the "evidence" coverage family — this boundary's OWN records). */
  readonly evidenceRepository: EvidenceRepository;
  /** Neutral read paths for the reputation_input + settlement_value coverage families. */
  readonly coverageLookups: SignedAttestationCoverageLookups;
  readonly signer: SignedAttestationSigner;
  readonly verifier: SignedAttestationVerifier;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/** A covered record resolved to its canonical facts (in-tx or committed). */
interface ResolvedCoverage {
  readonly family: SignedAttestationCoverageFamily;
  readonly recordId: string;
  readonly organizationScopeId: string;
  readonly canonicalFacts: string;
  /** Current lifecycle state (settlement_value only; null for the immutable families). */
  readonly state: string | null;
}

export function createSignedAttestationService(
  deps: SignedAttestationServiceDeps,
): SignedAttestationService {
  const {
    repository,
    evidenceRepository,
    coverageLookups,
    signer,
    verifier,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /** Sort coverage refs by (family, recordId) — the deterministic coverage order. */
  function coverageOrder(
    a: { readonly family: string; readonly recordId: string },
    b: { readonly family: string; readonly recordId: string },
  ): number {
    if (a.family !== b.family) return a.family < b.family ? -1 : 1;
    return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  }

  /**
   * Resolve one coverage ref to its canonical facts + scope + (for
   * settlement_value) the current lifecycle state, reading INSIDE the
   * authoritative transaction (creation) or from committed state
   * (verification — a read-only decision).
   */
  async function resolveCoverage(
    ref: { readonly family: SignedAttestationCoverageFamily; readonly recordId: string },
    tx: AuthorityTransaction | null,
  ): Promise<ResolvedCoverage | null> {
    if (ref.family === "evidence") {
      const record: Evidence | null = tx
        ? await evidenceRepository.findByIdWithinTx(ref.recordId, tx)
        : await evidenceRepository.findById(ref.recordId);
      if (!record) return null;
      return {
        family: ref.family,
        recordId: ref.recordId,
        organizationScopeId: record.organizationScopeId,
        canonicalFacts: canonicalEvidenceCoverageFacts(record),
        state: null,
      };
    }
    if (ref.family === "reputation_input") {
      const facts: ReputationInputCoverageFacts | null = tx
        ? await coverageLookups.reputationInput.resolveWithinTx(ref.recordId, tx)
        : await coverageLookups.reputationInput.resolve(ref.recordId);
      if (!facts) return null;
      return {
        family: ref.family,
        recordId: ref.recordId,
        organizationScopeId: facts.organizationScopeId,
        canonicalFacts: canonicalReputationInputCoverageFacts(facts),
        state: null,
      };
    }
    const facts: SettlementValueCoverageFacts | null = tx
      ? await coverageLookups.settlementValue.resolveWithinTx(ref.recordId, tx)
      : await coverageLookups.settlementValue.resolve(ref.recordId);
    if (!facts) return null;
    return {
      family: ref.family,
      recordId: ref.recordId,
      organizationScopeId: facts.organizationScopeId,
      canonicalFacts: canonicalSettlementValueCoverageFacts(facts),
      state: facts.state,
    };
  }

  /**
   * Tenant-scoped load: a record in another organization scope is
   * INDISTINGUISHABLE from a nonexistent one (no existence oracle).
   */
  async function loadScoped(
    organizationScopeId: string,
    id: string,
  ): Promise<SignedAttestation> {
    const found = await repository.findById(id);
    if (!found || found.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`signed attestation not found: ${id}`, {
        attestationId: id,
      });
    }
    return found;
  }

  function check(
    checkName: SignedAttestationCheck["check"],
    subject: string | null,
    passed: boolean,
    reason: SignedAttestationVerificationReason,
  ): SignedAttestationCheck {
    return { check: checkName, subject, passed, reason };
  }

  function verdict(
    attestationId: string,
    valid: boolean,
    reason: SignedAttestationVerificationReason,
    checks: readonly SignedAttestationCheck[],
  ): SignedAttestationVerification {
    return Object.freeze({
      attestationId,
      valid,
      reason,
      checks: Object.freeze([...checks]),
    });
  }

  /** Validate the creation input (pure; before any mutation). */
  function validateCreateInput(input: CreateSignedAttestationInput): readonly {
    readonly family: SignedAttestationCoverageFamily;
    readonly recordId: string;
  }[] {
    if (!input.organizationScopeId?.trim()) {
      throw new InvalidSignedAttestationError("organizationScopeId is required", {
        field: "organizationScopeId",
      });
    }
    if (!input.verifierId?.trim()) {
      throw new InvalidSignedAttestationError("verifierId is required", {
        field: "verifierId",
      });
    }
    if (!input.statement?.trim()) {
      throw new InvalidSignedAttestationError("statement is required", {
        field: "statement",
      });
    }
    if (!input.idempotencyKey?.trim()) {
      throw new InvalidSignedAttestationError("idempotencyKey is required", {
        field: "idempotencyKey",
      });
    }
    if (!Array.isArray(input.coverage) || input.coverage.length === 0) {
      throw new InvalidSignedAttestationError(
        "a signed attestation must cover at least one authoritative record",
        { field: "coverage" },
      );
    }
    if (input.coverage.length > SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS) {
      throw new InvalidSignedAttestationError(
        `coverage must not exceed ${SIGNED_ATTESTATION_MAX_COVERAGE_RECORDS} records (got ${input.coverage.length})`,
        { field: "coverage", count: input.coverage.length },
      );
    }
    const refs: { family: SignedAttestationCoverageFamily; recordId: string }[] = [];
    const seen = new Set<string>();
    for (const ref of input.coverage) {
      if (!ref || typeof ref !== "object") {
        throw new InvalidSignedAttestationError("each coverage entry must be an object", {
          field: "coverage",
        });
      }
      if (!isSignedAttestationCoverageFamily(ref.family)) {
        throw new InvalidSignedAttestationError(
          `coverage family must be one of evidence | reputation_input | settlement_value (got ${String(ref.family)})`,
          { field: "coverage.family", family: ref.family },
        );
      }
      if (!ref.recordId?.trim()) {
        throw new InvalidSignedAttestationError("each coverage entry requires a recordId", {
          field: "coverage.recordId",
        });
      }
      const composite = `${ref.family}:${ref.recordId}`;
      if (seen.has(composite)) {
        throw new InvalidSignedAttestationError(
          `coverage must not contain duplicates (${composite})`,
          { field: "coverage", family: ref.family, recordId: ref.recordId },
        );
      }
      seen.add(composite);
      refs.push({ family: ref.family, recordId: ref.recordId });
    }
    refs.sort(coverageOrder);
    return refs;
  }

  const service: SignedAttestationService = {
    async createSignedAttestation(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      const refs = validateCreateInput(input);

      // ---- Idempotent, atomic, audited creation ------------------------
      const key = `signed_attestation:${input.organizationScopeId}:${input.verifierId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // Re-derive EVERY covered record's canonical facts + coverage
          // commitment INSIDE the authoritative transaction (work order
          // §3.7): missing records, cross-scope records and REVERSED
          // value records fail closed BEFORE anything is signed or
          // persisted.
          const entries: SignedAttestationCoverageEntry[] = [];
          for (const ref of refs) {
            const resolved = await resolveCoverage(ref, tx);
            if (!resolved) {
              throw new NotFoundError(
                `covered ${ref.family} record not found: ${ref.recordId}`,
                { family: ref.family, recordId: ref.recordId },
              );
            }
            if (resolved.organizationScopeId !== input.organizationScopeId) {
              throw new InvalidSignedAttestationError(
                `covered ${ref.family} record ${ref.recordId} belongs to organization scope ${resolved.organizationScopeId}, not ${input.organizationScopeId}`,
                {
                  family: ref.family,
                  recordId: ref.recordId,
                  recordScope: resolved.organizationScopeId,
                  attestationScope: input.organizationScopeId,
                },
              );
            }
            if (resolved.state === "REVERSED") {
              throw new InvalidSignedAttestationError(
                `covered settlement_value record ${ref.recordId} is REVERSED — an attestation can never cover invalidated authoritative state`,
                { family: ref.family, recordId: ref.recordId, state: resolved.state },
              );
            }
            entries.push({
              family: ref.family,
              recordId: ref.recordId,
              commitment: deriveCoverageCommitment(resolved.canonicalFacts, randomUUID()),
            });
          }

          // ---- Sign (verifier-neutral, versioned) ------------------------
          // The signer's declared (algorithm, keyReference) build the
          // canonical input; the returned triple MUST match them and the
          // closed vocabularies — fail closed on any deviation.
          const declaredAlgorithm = signer.algorithm;
          const declaredKeyReference = signer.keyReference;
          const canonicalInput = buildSignedAttestationDigestInput(
            input.statement,
            input.verifierId,
            declaredAlgorithm,
            declaredKeyReference,
            entries.map((e) => ({
              family: e.family,
              recordId: e.recordId,
              algorithm: e.commitment.algorithm,
              digest: e.commitment.digest,
            })),
          );
          const signed = await signer.signVersioned(canonicalInput);
          if (
            signed.algorithm !== declaredAlgorithm ||
            signed.keyReference !== declaredKeyReference ||
            !isSignedAttestationAlgorithm(signed.algorithm) ||
            !isSignedAttestationKeyReference(signed.keyReference) ||
            !(
              SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM[
                signed.algorithm as keyof typeof SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM
              ] ?? []
            ).includes(signed.keyReference as never)
          ) {
            throw new InvalidSignedAttestationError(
              `the injected signer returned a vocabulary violation (algorithm ${String(signed.algorithm)}, key reference ${String(signed.keyReference)}) — signing fails closed`,
              { algorithm: signed.algorithm, keyReference: signed.keyReference },
            );
          }

          const now = new Date().toISOString();
          const record: SignedAttestation = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            verifierId: input.verifierId,
            statement: input.statement,
            coverage: Object.freeze([...entries]),
            algorithm: signed.algorithm,
            keyReference: signed.keyReference,
            signature: signed.signature,
            signedAt: now,
            revokedAt: null,
            revocationReason: null,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            createdAt: now,
            recordFormat: SIGNED_ATTESTATION_RECORD_FORMAT,
          });

          // ---- Atomic mutation + audit (post-commit publication) --------
          await repository.saveWithinTx(record, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: SIGNED_ATTESTATION_CREATED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: record.id,
            resourceType: "signed_attestation",
            resourceId: record.id,
            metadata: {
              verifierId: record.verifierId,
              algorithm: record.algorithm,
              keyReference: record.keyReference,
              coverageCount: record.coverage.length,
              coverageFamilies: [...new Set(record.coverage.map((c) => c.family))].sort(),
              organizationScopeId: record.organizationScopeId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return record;
        },
        execution,
      );
      logger.info("signed_attestation.created", {
        attestationId: applied.result.id,
        algorithm: applied.result.algorithm,
        keyReference: applied.result.keyReference,
        coverageCount: applied.result.coverage.length,
        created: applied.executed,
      });
      return { attestation: applied.result, created: applied.executed };
    },

    async getSignedAttestation(_execution, organizationScopeId, id) {
      return loadScoped(organizationScopeId, id);
    },

    async verifySignedAttestation(_execution, organizationScopeId, id) {
      const attestation = await loadScoped(organizationScopeId, id);
      const checks: SignedAttestationCheck[] = [];

      // 1. Revocation — a revoked attestation NEVER verifies.
      if (attestation.revokedAt !== null) {
        checks.push(check("revocation", null, false, "attestation_revoked"));
        return verdict(id, false, "attestation_revoked", checks);
      }
      checks.push(check("revocation", null, true, "verified"));

      // 2. Algorithm vocabulary (closed, versioned).
      if (!isSignedAttestationAlgorithm(attestation.algorithm)) {
        checks.push(check("algorithm_vocabulary", null, false, "unsupported_algorithm"));
        return verdict(id, false, "unsupported_algorithm", checks);
      }
      checks.push(check("algorithm_vocabulary", null, true, "verified"));

      // 3. Key-reference vocabulary (closed, versioned).
      if (!isSignedAttestationKeyReference(attestation.keyReference)) {
        checks.push(check("key_reference_vocabulary", null, false, "unknown_key_reference"));
        return verdict(id, false, "unknown_key_reference", checks);
      }
      checks.push(check("key_reference_vocabulary", null, true, "verified"));

      // 4. Algorithm → key-reference pairing (the frozen map).
      const allowedReferences = SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM[
        attestation.algorithm
      ] as readonly string[];
      if (!allowedReferences.includes(attestation.keyReference)) {
        checks.push(
          check("algorithm_key_reference_pairing", null, false, "algorithm_key_reference_mismatch"),
        );
        return verdict(id, false, "algorithm_key_reference_mismatch", checks);
      }
      checks.push(check("algorithm_key_reference_pairing", null, true, "verified"));

      // 5. Signature — rebuild the canonical input from the STORED
      //    coverage commitments (NO plaintext disclosure) and delegate.
      const canonicalInput = buildSignedAttestationDigestInput(
        attestation.statement,
        attestation.verifierId,
        attestation.algorithm,
        attestation.keyReference,
        attestation.coverage.map((e) => ({
          family: e.family,
          recordId: e.recordId,
          algorithm: e.commitment.algorithm,
          digest: e.commitment.digest,
        })),
      );
      const decision = await verifier.verifyVersioned(canonicalInput, {
        algorithm: attestation.algorithm,
        signature: attestation.signature,
        keyReference: attestation.keyReference,
      });
      if (!decision.valid) {
        checks.push(check("signature", null, false, "signature_mismatch"));
        return verdict(id, false, "signature_mismatch", checks);
      }
      checks.push(check("signature", null, true, "verified"));

      // 6. Per-covered-record CURRENT-STATE + integrity re-derivation
      //    (deterministic coverage order). Committed reads —
      //    verification is a read-only derived decision.
      for (const entry of attestation.coverage) {
        const subject = `${entry.family}:${entry.recordId}`;
        const current = await resolveCoverage(
          { family: entry.family, recordId: entry.recordId },
          null,
        );
        if (!current) {
          checks.push(check("covered_current_state", subject, false, "covered_record_missing"));
          return verdict(id, false, "covered_record_missing", checks);
        }
        if (current.state === "REVERSED") {
          checks.push(check("covered_current_state", subject, false, "covered_state_invalid"));
          return verdict(id, false, "covered_state_invalid", checks);
        }
        checks.push(check("covered_current_state", subject, true, "verified"));

        // Integrity: re-derive the coverage commitment from the CURRENT
        // canonical facts with the STORED salt and compare in constant
        // time (the W005 primitive). Tampering with the underlying
        // record content (or the stored commitment) fails closed.
        const matches = verifyEvidenceCommitment(
          current.canonicalFacts,
          entry.commitment,
        );
        if (!matches) {
          checks.push(check("covered_integrity", subject, false, "covered_record_mutated"));
          return verdict(id, false, "covered_record_mutated", checks);
        }
        checks.push(check("covered_integrity", subject, true, "verified"));
      }

      return verdict(id, true, "verified", checks);
    },

    async revokeSignedAttestation(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw new InvalidSignedAttestationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.attestationId?.trim()) {
        throw new InvalidSignedAttestationError("attestationId is required", {
          field: "attestationId",
        });
      }
      if (!input.reason?.trim()) {
        throw new InvalidSignedAttestationError("a revocation reason is required", {
          field: "reason",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw new InvalidSignedAttestationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }

      // ---- ONE-WAY revocation under the per-attestation mutex ----------
      // The lock serializes concurrent revocations of the SAME record
      // (the check-then-act read-modify-write); the composite
      // idempotency key makes each revocation request replay-safe. The
      // lock key and the apply key are DISTINCT strings (nesting the
      // same key would deadlock — the IdempotencyStore contract).
      const revoked = await idempotency.withLock(
        `signed_attestation:${input.organizationScopeId}:${input.attestationId}`,
        async () => {
          const applied = await idempotency.applyIdempotent(
            `signed_attestation_revocation:${input.organizationScopeId}:${input.attestationId}:${input.idempotencyKey}`,
            async (ctx) => {
              const tx = ctx.transaction;
              const found = await repository.findByIdWithinTx(input.attestationId, tx);
              if (!found || found.organizationScopeId !== input.organizationScopeId) {
                throw new NotFoundError(
                  `signed attestation not found: ${input.attestationId}`,
                  { attestationId: input.attestationId },
                );
              }
              // ONE-WAY: an already-revoked attestation is returned
              // unchanged (no second mutation, no second audit event).
              if (found.revokedAt !== null) {
                return found;
              }
              const revokedRecord: SignedAttestation = Object.freeze({
                ...found,
                revokedAt: new Date().toISOString(),
                revocationReason: input.reason,
              });
              await repository.saveWithinTx(revokedRecord, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: SIGNED_ATTESTATION_REVOKED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: revokedRecord.id,
                resourceType: "signed_attestation",
                resourceId: revokedRecord.id,
                metadata: {
                  reason: revokedRecord.revocationReason,
                  algorithm: revokedRecord.algorithm,
                  keyReference: revokedRecord.keyReference,
                  organizationScopeId: revokedRecord.organizationScopeId,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return revokedRecord;
            },
            execution,
          );
          return applied.result;
        },
      );
      logger.info("signed_attestation.revoked", {
        attestationId: revoked.id,
        revokedAt: revoked.revokedAt,
      });
      return revoked;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
