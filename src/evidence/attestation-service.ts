/**
 * AttestationService — domain service for verifier-neutral
 * attestations (NET-W005 §3.5).
 *
 * Architecture ref: spec/architecture-lock.md §6 (privacy authority:
 * attestations prove integrity without publishing raw personal data),
 * §4 (evidence authority). The attestation binds a verifier's
 * statement to the COMMITMENT DIGESTS of the covered evidence — so
 * verification requires NO plaintext disclosure (work order AC-05).
 *
 * Verifier neutrality (work order §4 invariant 8): signing and
 * verification are delegated to the injected AttestationSigner /
 * AttestationVerifier structural interfaces. The domain builds the
 * canonical digest input; the signer produces an opaque
 * (algorithm, signature) pair; the verifier checks it. The default
 * HMAC implementation (hmac-attestation-verifier.ts) is a
 * clearly-marked development/test default; production verifiers
 * arrive as adapters behind the same interface.
 *
 * Canonical digest input (deterministic, used identically at signing
 * and verification):
 *
 * ```text
 * attestation/v1
 * statement:   <statement>
 * verifier:    <verifierId>
 * evidence:    <evidenceId>:<digest|none>   (sorted by evidenceId)
 * ```
 *
 * Because the digests come from the STORED commitments, the canonical
 * input can be rebuilt at any time WITHOUT any sensitive plaintext —
 * tampering with the statement, the evidence set, or the underlying
 * commitments invalidates the rebuilt input and verification fails.
 *
 * Tier compliance: evidence domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import {
  NotFoundError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  Attestation,
  AttestationRepository,
  AttestationService,
  AttestationSigner,
  AttestationVerifier,
  AttestationVerification,
  CreateAttestationInput,
  EvidenceRepository,
} from "./port.ts";

const ATTESTATION_CREATED = "attestation.created" as const;

/**
 * Build the canonical digest input for an attestation from the
 * statement, verifier id, and the covered evidence ids + commitment
 * digests. PURE + deterministic: the same (statement, verifierId,
 * evidence id→digest pairs) always produces the same input string.
 * Sorted by evidence id so the input is order-insensitive.
 */
export function buildAttestationDigestInput(
  statement: string,
  verifierId: string,
  covered: readonly { evidenceId: string; digest: string | null }[],
): string {
  const lines = covered
    .slice()
    .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0))
    .map((c) => `evidence:${c.evidenceId}:${c.digest ?? "none"}`);
  return ["attestation/v1", `statement:${statement}`, `verifier:${verifierId}`, ...lines].join(
    "\n",
  );
}

export interface AttestationServiceDeps {
  readonly repository: AttestationRepository;
  /** For resolving the covered evidence records (and their commitments). */
  readonly evidenceRepository: EvidenceRepository;
  readonly signer: AttestationSigner;
  readonly verifier: AttestationVerifier;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/**
 * Resolve the covered evidence id → commitment-digest pairs from the
 * CURRENT STORED evidence records — the exact input the canonical
 * digest input is rebuilt from at verification time. Missing evidence
 * records contribute a null digest (the covered set cannot be
 * reconstructed; verification fails on the mismatched input). NEVER
 * touches plaintext: sensitive records carry none, and only the stored
 * commitment digest participates.
 *
 * Shared by the attestation service's verification path AND the
 * Proof-of-Value service's EVALUATING → VERIFIED precondition (both
 * rebuild the canonical input from the SAME stored commitments —
 * one source of truth for the digest resolution).
 */
export async function resolveStoredCommitmentDigests(
  evidenceIds: readonly string[],
  evidenceRepository: Pick<EvidenceRepository, "findById">,
): Promise<readonly { evidenceId: string; digest: string | null }[]> {
  const covered: { evidenceId: string; digest: string | null }[] = [];
  for (const evidenceId of evidenceIds) {
    const evidence = await evidenceRepository.findById(evidenceId);
    covered.push({
      evidenceId,
      digest: evidence?.commitment?.digest ?? null,
    });
  }
  return covered;
}

export function createAttestationService(deps: AttestationServiceDeps): AttestationService {
  const {
    repository,
    evidenceRepository,
    signer,
    verifier,
    authority,
    auditWriter,
    logger,
  } = deps;

  const service: AttestationService = {
    async createAttestation(execution, input) {
      // ---- Validation --------------------------------------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "ATTESTATION_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.verifierId?.trim()) {
        throw new OpenConError({
          code: "ATTESTATION_VALIDATION",
          classification: "validation",
          message: "verifierId is required",
          context: { field: "verifierId" },
        });
      }
      if (!input.statement?.trim()) {
        throw new OpenConError({
          code: "ATTESTATION_VALIDATION",
          classification: "validation",
          message: "statement is required",
          context: { field: "statement" },
        });
      }
      if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
        throw new OpenConError({
          code: "ATTESTATION_VALIDATION",
          classification: "validation",
          message: "an attestation must cover at least one evidence record",
          context: { field: "evidenceIds" },
        });
      }
      if (input.evidenceIds.length !== new Set(input.evidenceIds).size) {
        throw new OpenConError({
          code: "ATTESTATION_VALIDATION",
          classification: "validation",
          message: "evidenceIds must not contain duplicates",
          context: { field: "evidenceIds" },
        });
      }

      // Resolve the covered evidence records; validate existence +
      // organization scope; collect their commitment digests (never
      // plaintext — sensitive records carry none).
      const covered: { evidenceId: string; digest: string | null }[] = [];
      for (const evidenceId of input.evidenceIds) {
        const evidence = await evidenceRepository.findById(evidenceId);
        if (!evidence) {
          throw new NotFoundError(`evidence not found: ${evidenceId}`, { evidenceId });
        }
        if (evidence.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "ATTESTATION_VALIDATION",
            classification: "validation",
            message: `evidence ${evidenceId} belongs to organization scope ${evidence.organizationScopeId}, not ${input.organizationScopeId}`,
            context: { evidenceId },
          });
        }
        covered.push({
          evidenceId,
          digest: evidence.commitment?.digest ?? null,
        });
      }

      // ---- Sign (verifier-neutral) --------------------------------------
      const canonicalInput = buildAttestationDigestInput(
        input.statement,
        input.verifierId,
        covered,
      );
      const signed = await signer.sign(canonicalInput);

      const now = new Date().toISOString();
      const attestation: Attestation = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        verifierId: input.verifierId,
        statement: input.statement,
        evidenceIds: input.evidenceIds,
        algorithm: signed.algorithm,
        signature: signed.signature,
        signedAt: now,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });

      // ---- Atomic mutation + audit (AUD-002) ----------------------------
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(attestation, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: ATTESTATION_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: attestation.id,
          resourceType: "attestation",
          resourceId: attestation.id,
          metadata: {
            verifierId: attestation.verifierId,
            algorithm: attestation.algorithm,
            coveredEvidenceCount: attestation.evidenceIds.length,
            organizationScopeId: attestation.organizationScopeId,
          },
        });
      });
      logger.info("attestation.created", {
        attestationId: attestation.id,
        verifierId: attestation.verifierId,
      });
      return attestation;
    },

    async getAttestation(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`attestation not found: ${id}`, { attestationId: id });
      }
      return found;
    },

    async verifyAttestation(_execution, id) {
      const attestation = await repository.findById(id);
      if (!attestation) {
        throw new NotFoundError(`attestation not found: ${id}`, { attestationId: id });
      }
      // Rebuild the canonical digest input from the STORED evidence
      // commitments — NO plaintext disclosure anywhere on this path.
      const covered = await resolveStoredCommitmentDigests(
        attestation.evidenceIds,
        evidenceRepository,
      );
      const canonicalInput = buildAttestationDigestInput(
        attestation.statement,
        attestation.verifierId,
        covered,
      );
      const decision = await verifier.verify(canonicalInput, {
        algorithm: attestation.algorithm,
        signature: attestation.signature,
      });
      const result: AttestationVerification = {
        attestationId: id,
        valid: decision.valid,
        reason: decision.reason,
      };
      return result;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
