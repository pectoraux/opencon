/**
 * ReputationProofService — NET-W031 portable reputation proofs
 * (issue #63): DERIVED, privacy-preserving, verifiable reputation
 * claims composed from the W007 reputation authority and the W029
 * signed-attestation machinery.
 *
 * Architecture ref: spec/architecture.md §11 (multidimensional, not
 * purchasable, evidence-traced), §18 (/reputation owns reputation
 * computation and provenance); spec/architecture-lock.md §3
 * (PostgreSQL authoritative), §6 (privacy authority — proofs prove
 * without publishing raw personal data), §12 (execution lineage),
 * §14 (provider neutrality). Work order:
 * spec/work-orders/NET-W031.md; requirements REP-003..004 +
 * PRIV-001..003.
 *
 * THE KEY RULES (work order §2–§5 + issue #63):
 *  - EXTEND, never rewrite: the W007 input/policy/snapshot services,
 *    the deterministic scoring engine and every W007 contract are
 *    untouched; this service is the ADDITIVE derivation/presentation
 *    layer over the SAME boundary (/reputation stays the SOLE
 *    reputation authority — no 18th domain);
 *  - proofs COMPOSE the W029 machinery through the NEUTRAL
 *    `ReputationProofSigner` / `ReputationProofVerifier` /
 *    `ReputationProofSigningVocabulary` contracts declared on THIS
 *    boundary's port — the bootstrap composition root is the ONLY
 *    join (it injects the same versioned attestation signing pair
 *    selected for the W029 surface + W029's frozen vocabularies as
 *    data). No new cryptographic primitive, no new signing surface,
 *    no key material ever enters this file;
 *  - disclosed facts are DERIVED at issuance from the STORED snapshot
 *    (the authority's OWN time-decayed values — REP-003: presentation
 *    never recomputes) and are AGGREGATE ONLY (PRIV-001..003: no raw
 *    personal activity, no input ids, no payloads, no cross-tenant
 *    data; the evidence-reference COUNTS are the REP-004 opaque
 *    lineage);
 *  - the issuance input carries NO caller-asserted facts — the only
 *    inputs are scope, subject, the optional snapshot reference and
 *    the idempotency key (REP-002: no proof path accepts spend or
 *    wealth as reputation substance);
 *  - verification is DETERMINISTIC, non-mutating, non-auditing and
 *    FAIL-CLOSED with machine-readable reasons from the closed
 *    vocabulary — in fixed order: revocation → shape → algorithm
 *    vocabulary → key-reference vocabulary → pairing → signature →
 *    staleness. The presentation-side surface verifies a
 *    self-contained artifact WITHOUT querying tenant-scoped state
 *    (work order §3.3);
 *  - material mutations follow the established discipline: composite
 *    idempotency (`reputation_proof:{scope}:{subject}:{key}` — the
 *    W007/W029 precedent), ONE authoritative transaction (the
 *    applyIdempotent context transaction), transactional audit
 *    buffering with post-commit publication; the snapshot is resolved
 *    and the canonical input is signed INSIDE that transaction;
 *  - revocation is ONE-WAY (the W029/W028 closure precedent — a field
 *    mutation, never a lifecycle transition; /workflows is not
 *    extended); a revoked proof NEVER verifies again. Staleness is a
 *    verification-time derivation over the issuance timestamp — never
 *    a stored lifecycle state (work order §5).
 *
 * PostgreSQL remains THE authoritative state: proofs DERIVE from
 * recorded snapshots; issuance mutates NO reputation authority state
 * (inputs, policies and snapshots are untouched) and no economic
 * state; verification and presentation mutate and audit nothing.
 *
 * Tier compliance: reputation domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  PresentedReputationProof,
  ReputationProof,
  ReputationProofCheck,
  ReputationProofCheckName,
  ReputationProofDimensionFact,
  ReputationProofService,
  ReputationProofSignatureMaterial,
  ReputationProofSigningVocabulary,
  ReputationProofVerification,
  ReputationProofVerificationReason,
  ReputationSnapshot,
  ReputationSnapshotRepository,
  IssueReputationProofInput,
  IssueReputationProofResult,
  RevokeReputationProofInput,
  VerifyReputationProofInput,
  ReputationProofRepository,
  ReputationProofSigner,
  ReputationProofVerifier,
} from "./port.ts";
import { REPUTATION_PROOF_RECORD_FORMAT } from "./port.ts";
import {
  buildReputationProofDigestInput,
  isReputationProofFresh,
  reputationProofCanonicalFacts,
  validateReputationProofShape,
} from "./proof-input.ts";

const PROOF_ISSUED = "reputation_proof.issued" as const;
const PROOF_REVOKED = "reputation_proof.revoked" as const;

/** Validation failures on the proof surface (closed, non-retryable). */
export class InvalidReputationProofError extends OpenConError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({
      code: "INVALID_REPUTATION_PROOF",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

export interface ReputationProofServiceDeps {
  readonly proofRepository: ReputationProofRepository;
  /** The authority's OWN snapshot store (this boundary's records — read-only at issuance). */
  readonly snapshotRepository: ReputationSnapshotRepository;
  /** Neutral versioned signing surface (composed from the W029 machinery at the composition root). */
  readonly signer: ReputationProofSigner;
  /** Neutral versioned verification surface (composed from the W029 machinery at the composition root). */
  readonly verifier: ReputationProofVerifier;
  /** W029's frozen algorithm/key vocabularies, injected as data (single source of truth). */
  readonly signingVocabulary: ReputationProofSigningVocabulary;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createReputationProofService(
  deps: ReputationProofServiceDeps,
): ReputationProofService {
  const {
    proofRepository,
    snapshotRepository,
    signer,
    verifier,
    signingVocabulary,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /**
   * Tenant-scoped load: a record in another organization scope is
   * INDISTINGUISHABLE from a nonexistent one (no existence oracle).
   */
  async function loadScoped(
    organizationScopeId: string,
    id: string,
  ): Promise<ReputationProof> {
    const found = await proofRepository.findById(id);
    if (!found || found.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`reputation proof not found: ${id}`, {
        proofId: id,
      });
    }
    return found;
  }

  function check(
    checkName: ReputationProofCheckName,
    subject: string | null,
    passed: boolean,
    reason: ReputationProofVerificationReason,
  ): ReputationProofCheck {
    return { check: checkName, subject, passed, reason };
  }

  function verdict(
    proofId: string,
    valid: boolean,
    reason: ReputationProofVerificationReason,
    checks: readonly ReputationProofCheck[],
  ): ReputationProofVerification {
    return Object.freeze({
      proofId,
      valid,
      reason,
      checks: Object.freeze([...checks]),
    });
  }

  /**
   * The aggregate disclosure projection: the SUBSTANTIVE, minimal
   * per-dimension facts disclosed by a proof (score + the authority's
   * capped flag + the three evidence-reference counts). The decayed
   * weight internals are NOT disclosed; raw input material NEVER
   * crosses this projection (PRIV-001..003).
   */
  function deriveDimensionFacts(
    snapshot: ReputationSnapshot,
  ): readonly ReputationProofDimensionFact[] {
    return snapshot.scores.map((s) => ({
      dimension: s.dimension,
      score: s.score,
      capped: s.capped,
      inputCount: s.inputCount,
      verifiedInputCount: s.verifiedInputCount,
      indicatedInputCount: s.indicatedInputCount,
    }));
  }

  /** Validate the issuance input shape (pure; before any mutation). */
  function validateIssueInput(input: IssueReputationProofInput): void {
    if (!input.organizationScopeId?.trim()) {
      throw new InvalidReputationProofError("organizationScopeId is required", {
        field: "organizationScopeId",
      });
    }
    if (!input.subjectPersonId?.trim()) {
      throw new InvalidReputationProofError("subjectPersonId is required", {
        field: "subjectPersonId",
      });
    }
    if (
      input.snapshotId !== undefined &&
      (typeof input.snapshotId !== "string" || !input.snapshotId.trim())
    ) {
      throw new InvalidReputationProofError(
        "snapshotId, when provided, must be a non-empty string",
        { field: "snapshotId" },
      );
    }
    if (!input.idempotencyKey?.trim()) {
      throw new InvalidReputationProofError("idempotencyKey is required", {
        field: "idempotencyKey",
      });
    }
  }

  /** Validate the verification input (evaluatedAt is explicit — determinism). */
  function validateEvaluatedAt(evaluatedAt: string): void {
    if (!evaluatedAt || Number.isNaN(Date.parse(evaluatedAt))) {
      throw new InvalidReputationProofError(
        `evaluatedAt must be a valid ISO-8601 timestamp (got ${String(evaluatedAt)}) — the staleness reference is an EXPLICIT input so verifications are deterministic`,
        { field: "evaluatedAt", evaluatedAt },
      );
    }
  }

  /**
   * The signer's returned triple must match its DECLARED
   * (algorithm, keyReference) and the CLOSED vocabularies — signing
   * fails closed on any deviation (the W029 discipline).
   */
  function assertSigningVocabulary(signed: ReputationProofSignatureMaterial): void {
    if (
      signed.algorithm !== signer.algorithm ||
      signed.keyReference !== signer.keyReference ||
      !signingVocabulary.algorithms.includes(signed.algorithm) ||
      !signingVocabulary.keyReferences.includes(signed.keyReference) ||
      !(signingVocabulary.keyReferenceByAlgorithm[signed.algorithm] ?? []).includes(
        signed.keyReference,
      )
    ) {
      throw new InvalidReputationProofError(
        `the injected signer returned a vocabulary violation (algorithm ${String(signed.algorithm)}, key reference ${String(signed.keyReference)}) — proof signing fails closed`,
        { algorithm: signed.algorithm, keyReference: signed.keyReference },
      );
    }
  }

  /**
   * The FIXED, fail-closed verification pipeline — the single
   * derivation shared by the authority-side and presentation-side
   * surfaces (identical checks, identical order, identical reasons;
   * returns on the first failure). PURE with respect to tenant state:
   * the only inputs are the (stored or presented) proof facts, the
   * injected verifier/vocabulary and the explicit evaluatedAt.
   */
  async function deriveVerification(
    proof: PresentedReputationProof,
    evaluatedAt: string,
  ): Promise<ReputationProofVerification> {
    const proofId = typeof proof?.id === "string" && proof.id.length > 0 ? proof.id : "unknown";
    const checks: ReputationProofCheck[] = [];

    // 1. Revocation — a revoked proof NEVER verifies (the one-way
    //    field; evaluated from the artifact itself so BOTH surfaces
    //    fail closed on it).
    if (proof?.revokedAt !== null && proof?.revokedAt !== undefined) {
      checks.push(check("revocation", null, false, "proof_revoked"));
      return verdict(proofId, false, "proof_revoked", checks);
    }
    checks.push(check("revocation", null, true, "verified"));

    // 2. Proof shape (closed subject/dimension vocabularies, frozen
    //    dimension order, typed fields — machine-readable issues).
    const issues = validateReputationProofShape(proof);
    if (issues.length > 0) {
      const first = issues[0];
      checks.push(
        check("proof_shape", first !== undefined ? first.field : null, false, "malformed_proof"),
      );
      return verdict(proofId, false, "malformed_proof", checks);
    }
    checks.push(check("proof_shape", null, true, "verified"));

    // 3. Algorithm vocabulary (closed, versioned — W029's, injected).
    if (!signingVocabulary.algorithms.includes(proof.algorithm)) {
      checks.push(check("algorithm_vocabulary", null, false, "unsupported_algorithm"));
      return verdict(proofId, false, "unsupported_algorithm", checks);
    }
    checks.push(check("algorithm_vocabulary", null, true, "verified"));

    // 4. Key-reference vocabulary (closed, versioned — W029's, injected).
    if (!signingVocabulary.keyReferences.includes(proof.keyReference)) {
      checks.push(check("key_reference_vocabulary", null, false, "unknown_key_reference"));
      return verdict(proofId, false, "unknown_key_reference", checks);
    }
    checks.push(check("key_reference_vocabulary", null, true, "verified"));

    // 5. Algorithm → key-reference pairing (the frozen map).
    const allowedReferences =
      signingVocabulary.keyReferenceByAlgorithm[proof.algorithm] ?? [];
    if (!allowedReferences.includes(proof.keyReference)) {
      checks.push(
        check("algorithm_key_reference_pairing", null, false, "algorithm_key_reference_mismatch"),
      );
      return verdict(proofId, false, "algorithm_key_reference_mismatch", checks);
    }
    checks.push(check("algorithm_key_reference_pairing", null, true, "verified"));

    // 6. Signature — rebuild the canonical input from the PRESENTED
    //    facts (the proof is self-contained: NO tenant state is
    //    queried) and delegate to the composed W029 verifier.
    const canonicalInput = buildReputationProofDigestInput(
      reputationProofCanonicalFacts(proof),
    );
    const decision = await verifier.verifyProof(canonicalInput, {
      algorithm: proof.algorithm,
      signature: proof.signature,
      keyReference: proof.keyReference,
    });
    if (!decision.valid) {
      checks.push(check("signature", null, false, "signature_mismatch"));
      return verdict(proofId, false, "signature_mismatch", checks);
    }
    checks.push(check("signature", null, true, "verified"));

    // 7. Staleness — the verification-time derivation over the
    //    issuance timestamp (never a stored state): fresh iff
    //    0 <= evaluatedAt - issuedAt <= the frozen window.
    if (!isReputationProofFresh(proof.issuedAt, evaluatedAt)) {
      checks.push(check("staleness", null, false, "proof_stale"));
      return verdict(proofId, false, "proof_stale", checks);
    }
    checks.push(check("staleness", null, true, "verified"));

    return verdict(proofId, true, "verified", checks);
  }

  const service: ReputationProofService = {
    async issueProof(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      validateIssueInput(input);

      // ---- Idempotent, atomic, audited issuance ------------------------
      const key = `reputation_proof:${input.organizationScopeId}:${input.subjectPersonId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // Resolve the authoritative snapshot INSIDE the issuance
          // transaction: an EXACT snapshot id, or the subject's LATEST
          // recorded snapshot in the issuance scope. Missing, cross-scope
          // and subject-mismatched snapshots fail closed BEFORE anything
          // is derived, signed or persisted.
          let snapshot: ReputationSnapshot | null = null;
          if (input.snapshotId !== undefined) {
            snapshot = await snapshotRepository.findByIdWithinTx(input.snapshotId, tx);
            if (!snapshot || snapshot.organizationScopeId !== input.organizationScopeId) {
              throw new NotFoundError(
                `reputation snapshot not found: ${input.snapshotId}`,
                { snapshotId: input.snapshotId },
              );
            }
          } else {
            const history = await snapshotRepository.listBySubjectWithinTx(
              input.organizationScopeId,
              input.subjectPersonId,
              tx,
            );
            snapshot = history.length > 0 ? history[history.length - 1] ?? null : null;
            if (!snapshot) {
              throw new NotFoundError(
                `no reputation snapshot recorded for subject ${input.subjectPersonId} in organization scope ${input.organizationScopeId}`,
                { subjectPersonId: input.subjectPersonId },
              );
            }
          }
          if (snapshot.subjectPersonId !== input.subjectPersonId) {
            throw new InvalidReputationProofError(
              `snapshot ${snapshot.id} belongs to subject ${snapshot.subjectPersonId}, not ${input.subjectPersonId}`,
              {
                snapshotId: snapshot.id,
                snapshotSubjectPersonId: snapshot.subjectPersonId,
                requestedSubjectPersonId: input.subjectPersonId,
              },
            );
          }

          // ---- Derive the AGGREGATE facts (never recompute, never
          // caller-asserted) and sign the canonical input ---------------
          const dimensions = deriveDimensionFacts(snapshot);
          const issuedAt = new Date().toISOString();
          const canonicalInput = buildReputationProofDigestInput({
            subjectPersonId: snapshot.subjectPersonId,
            organizationScopeId: snapshot.organizationScopeId,
            snapshotId: snapshot.id,
            policyId: snapshot.policyId,
            policyVersion: snapshot.policyVersion,
            referenceAt: snapshot.referenceAt,
            issuedAt,
            digest: snapshot.digest,
            dimensions,
          });
          // The signer's declared (algorithm, keyReference) build the
          // canonical trust envelope; the returned triple MUST match
          // them and the closed vocabularies — fail closed on deviation.
          const signed = await signer.signProof(canonicalInput);
          assertSigningVocabulary(signed);

          const record: ReputationProof = Object.freeze({
            id: randomUUID(),
            organizationScopeId: snapshot.organizationScopeId,
            subjectPersonId: snapshot.subjectPersonId,
            snapshotId: snapshot.id,
            policyId: snapshot.policyId,
            policyVersion: snapshot.policyVersion,
            referenceAt: snapshot.referenceAt,
            digest: snapshot.digest,
            dimensions: Object.freeze([...dimensions]),
            algorithm: signed.algorithm,
            keyReference: signed.keyReference,
            signature: signed.signature,
            issuedAt,
            revokedAt: null,
            revocationReason: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            createdAt: issuedAt,
            recordFormat: REPUTATION_PROOF_RECORD_FORMAT,
          });

          // ---- Atomic mutation + audit (post-commit publication) --------
          await proofRepository.saveWithinTx(record, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: PROOF_ISSUED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: record.subjectPersonId,
            resourceType: "reputation_proof",
            resourceId: record.id,
            metadata: {
              subjectPersonId: record.subjectPersonId,
              snapshotId: record.snapshotId,
              policyId: record.policyId,
              policyVersion: record.policyVersion,
              algorithm: record.algorithm,
              keyReference: record.keyReference,
              dimensionCount: record.dimensions.length,
              digest: record.digest,
              organizationScopeId: record.organizationScopeId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return record;
        },
        execution,
      );
      logger.info("reputation_proof.issued", {
        proofId: applied.result.id,
        snapshotId: applied.result.snapshotId,
        algorithm: applied.result.algorithm,
        keyReference: applied.result.keyReference,
        created: applied.executed,
      });
      return { proof: applied.result, created: applied.executed };
    },

    async getProof(_execution, organizationScopeId, id) {
      return loadScoped(organizationScopeId, id);
    },

    async verifyProof(_execution, input) {
      validateEvaluatedAt(input.evaluatedAt);
      // Authority-side: the STORED record carries the CURRENT one-way
      // revocation state (a revoked proof never verifies again).
      const proof = await loadScoped(input.organizationScopeId, input.proofId);
      return deriveVerification(proof, input.evaluatedAt);
    },

    async verifyPresentedProof(_execution, presented, evaluatedAt) {
      validateEvaluatedAt(evaluatedAt);
      // Presentation-side: the PRESENTED artifact is the ONLY input —
      // no store reads, no mutations, no audit (the portable path).
      return deriveVerification(presented, evaluatedAt);
    },

    async revokeProof(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw new InvalidReputationProofError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.proofId?.trim()) {
        throw new InvalidReputationProofError("proofId is required", {
          field: "proofId",
        });
      }
      if (!input.reason?.trim()) {
        throw new InvalidReputationProofError("a revocation reason is required", {
          field: "reason",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw new InvalidReputationProofError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }

      // ---- ONE-WAY revocation under the per-proof mutex ----------------
      // The lock serializes concurrent revocations of the SAME record
      // (the check-then-act read-modify-write); the composite
      // idempotency key makes each revocation request replay-safe. The
      // lock key and the apply key are DISTINCT strings (nesting the
      // same key would deadlock — the IdempotencyStore contract).
      const revoked = await idempotency.withLock(
        `reputation_proof:${input.organizationScopeId}:${input.proofId}`,
        async () => {
          const applied = await idempotency.applyIdempotent(
            `reputation_proof_revocation:${input.organizationScopeId}:${input.proofId}:${input.idempotencyKey}`,
            async (ctx) => {
              const tx = ctx.transaction;
              const found = await proofRepository.findByIdWithinTx(input.proofId, tx);
              if (!found || found.organizationScopeId !== input.organizationScopeId) {
                throw new NotFoundError(
                  `reputation proof not found: ${input.proofId}`,
                  { proofId: input.proofId },
                );
              }
              // ONE-WAY: an already-revoked proof is returned unchanged
              // (no second mutation, no second audit event).
              if (found.revokedAt !== null) {
                return found;
              }
              const revokedRecord: ReputationProof = Object.freeze({
                ...found,
                revokedAt: new Date().toISOString(),
                revocationReason: input.reason,
              });
              await proofRepository.saveWithinTx(revokedRecord, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: PROOF_REVOKED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: revokedRecord.subjectPersonId,
                resourceType: "reputation_proof",
                resourceId: revokedRecord.id,
                metadata: {
                  reason: revokedRecord.revocationReason,
                  snapshotId: revokedRecord.snapshotId,
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
      logger.info("reputation_proof.revoked", {
        proofId: revoked.id,
        revokedAt: revoked.revokedAt,
      });
      return revoked;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
