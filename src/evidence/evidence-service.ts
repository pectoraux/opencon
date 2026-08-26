/**
 * EvidenceService — domain service for evidence records.
 *
 * Work order ref: spec/work-orders/NET-W005.md
 *   §3.1 Evidence first-class model (provenance, confidence, grade,
 *      integrity metadata, sensitivity).
 *   §3.2 Evidence grades — deterministic (derived here via the rule
 *      table, never from model judgment).
 *   §3.3 Confidence and uncertainty (EVID-005 validation).
 *   §3.6 Evidence commitments (EVID-006 — privacy boundary).
 *   §4 invariant 1 (raw sensitive material NEVER enters the
 *      authoritative record) + invariant 4 (atomic mutation + audit).
 *
 * Architecture ref: spec/architecture-lock.md §6 (privacy authority),
 * §12 invariant 6 (raw personal activity data is not placed on a
 * public ledger).
 *
 * Tier compliance: this file is in the `evidence` domain boundary. It
 * imports ONLY its own port (self) and core contracts
 * (ExecutionContext, TransactionalAuditWriter, OpenConError). The
 * transactional audit writer is the CORE contract
 * (src/core/audit.ts); the concrete implementation is wired by the
 * bootstrap composition root.
 *
 * Atomicity: createEvidence performs the record write AND the audit
 * append within ONE authoritative transaction — the audit append goes
 * through the transactional audit buffer bound to that transaction
 * (`auditWriter.forTransaction(tx)`), so the audit record is
 * published STRICTLY AFTER the durable commit succeeds and discarded
 * if the transaction settles without committing (the NET-W004-AC-07
 * transaction-ordering contract).
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
import {
  isEvidenceSourceType,
  validateConfidenceEstimate,
  type EvidenceCommitment,
} from "../core/evidence.ts";
import {
  createEvidenceCommitment,
  validateEvidenceCommitment,
  verifyEvidenceCommitment,
} from "./commitments.ts";
import { gradeForProvenance } from "./grade-rules.ts";
import type {
  CommitmentVerification,
  CreateEvidenceInput,
  Evidence,
  EvidenceRepository,
  EvidenceService,
} from "./port.ts";

const EVIDENCE_CREATED = "evidence.created" as const;

export interface EvidenceServiceDeps {
  readonly repository: EvidenceRepository;
  /** The authoritative persistence boundary (opens the mutation transaction). */
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createEvidenceService(deps: EvidenceServiceDeps): EvidenceService {
  const { repository, authority, auditWriter, logger } = deps;

  const service: EvidenceService = {
    async createEvidence(execution, input) {
      // ---- Validation (work order §4 invariants 1..3) -----------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "EVIDENCE_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.ownerId?.trim()) {
        throw new OpenConError({
          code: "EVIDENCE_VALIDATION",
          classification: "validation",
          message: "ownerId is required",
          context: { field: "ownerId" },
        });
      }
      if (
        !input.subjectReference?.subjectId?.trim() ||
        !input.subjectReference?.subjectType?.trim()
      ) {
        throw new OpenConError({
          code: "EVIDENCE_VALIDATION",
          classification: "validation",
          message: "subjectReference.subjectId and subjectReference.subjectType are required",
          context: { field: "subjectReference" },
        });
      }
      if (!isEvidenceSourceType(input.provenance?.sourceType)) {
        throw new OpenConError({
          code: "EVIDENCE_VALIDATION",
          classification: "validation",
          message: `provenance.sourceType must be one of platform|attested|provider|model|self (got ${String(input.provenance?.sourceType)})`,
          context: { field: "provenance.sourceType" },
        });
      }
      if (!input.provenance?.method?.trim()) {
        throw new OpenConError({
          code: "EVIDENCE_VALIDATION",
          classification: "validation",
          message: "provenance.method is required",
          context: { field: "provenance.method" },
        });
      }
      // EVID-005: confidence invariants (range + interval ordering).
      const confidence = validateConfidenceEstimate(input.confidence);

      const sensitivity = input.sensitivity ?? "standard";
      if (sensitivity !== "standard" && sensitivity !== "sensitive") {
        throw new OpenConError({
          code: "EVIDENCE_VALIDATION",
          classification: "validation",
          message: `sensitivity must be "standard" or "sensitive" (got ${String(sensitivity)})`,
          context: { field: "sensitivity" },
        });
      }

      // ---- Privacy boundary (work order §4 invariant 1) ---------------
      // Sensitive material NEVER enters the authoritative record: the
      // durable record stores the commitment (+ optional reference) and
      // approved derived facts ONLY.
      let payload: Readonly<Record<string, unknown>> | null = null;
      let commitment: EvidenceCommitment | null = null;

      if (sensitivity === "sensitive") {
        if (input.payload !== undefined) {
          throw new OpenConError({
            code: "EVIDENCE_VALIDATION",
            classification: "validation",
            message:
              "inline payload is not allowed for sensitive evidence — provide sensitivePayload (committed then discarded) or a pre-computed commitment",
            context: { field: "payload" },
          });
        }
        if (input.sensitivePayload !== undefined && input.commitment !== undefined) {
          throw new OpenConError({
            code: "EVIDENCE_VALIDATION",
            classification: "validation",
            message:
              "provide either sensitivePayload or a pre-computed commitment, not both",
            context: { fields: ["sensitivePayload", "commitment"] },
          });
        }
        if (input.sensitivePayload !== undefined) {
          // Compute the commitment; the plaintext is used ONLY here and
          // is NEVER placed on the entity (or anywhere durable).
          commitment = createEvidenceCommitment(input.sensitivePayload);
        } else if (input.commitment !== undefined) {
          commitment = validateEvidenceCommitment(input.commitment);
        } else {
          throw new OpenConError({
            code: "EVIDENCE_VALIDATION",
            classification: "validation",
            message:
              "sensitive evidence requires sensitivePayload (committed then discarded) or a pre-computed commitment",
            context: { field: "sensitivePayload|commitment" },
          });
        }
      } else {
        // Standard evidence: inline non-sensitive facts + optional
        // pre-computed integrity commitment.
        payload = input.payload ?? null;
        if (input.sensitivePayload !== undefined) {
          throw new OpenConError({
            code: "EVIDENCE_VALIDATION",
            classification: "validation",
            message:
              "sensitivePayload is only valid for sensitive evidence — use payload for standard evidence",
            context: { field: "sensitivePayload" },
          });
        }
        if (input.commitment !== undefined) {
          commitment = validateEvidenceCommitment(input.commitment);
        }
      }

      // ---- Deterministic grade (work order §3.2) ----------------------
      const provenance = {
        sourceType: input.provenance.sourceType,
        ...(input.provenance.sourceId !== undefined
          ? { sourceId: input.provenance.sourceId }
          : {}),
        method: input.provenance.method,
        collectedAt:
          input.provenance.collectedAt ?? new Date().toISOString(),
        ...(input.provenance.collectorId !== undefined
          ? { collectorId: input.provenance.collectorId }
          : {}),
      };
      const grade = gradeForProvenance(provenance);

      const now = new Date().toISOString();
      const evidence: Evidence = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        subjectReference: input.subjectReference,
        provenance,
        grade,
        confidence,
        sensitivity,
        payload,
        commitment,
        payloadReference: input.payloadReference ?? null,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
      });

      // ---- Atomic mutation + audit (work order §4 invariant 4) --------
      // The record write and the audit append commit in ONE authoritative
      // transaction: the audit append goes through the transactional
      // audit buffer bound to the SAME transaction, so the audit record
      // is published STRICTLY AFTER the durable commit succeeds and
      // discarded if the transaction settles without committing (an
      // audit failure rolls the whole creation back — no evidence
      // record without its audit lineage). Transaction-ordering
      // contract: NET-W004-AC-07 remediation, src/core/postgres-authority.ts.
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(evidence, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: EVIDENCE_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: evidence.id,
          resourceType: "evidence",
          resourceId: evidence.id,
          metadata: {
            grade: evidence.grade,
            sourceType: evidence.provenance.sourceType,
            subjectId: evidence.subjectReference.subjectId,
            subjectType: evidence.subjectReference.subjectType,
            sensitivity: evidence.sensitivity,
            // The commitment DIGEST is audit-safe metadata; the committed
            // material is never present.
            commitmentDigest: evidence.commitment?.digest ?? null,
            confidencePoint: evidence.confidence.point,
            organizationScopeId: evidence.organizationScopeId,
          },
        });
      });
      logger.info("evidence.created", {
        evidenceId: evidence.id,
        grade: evidence.grade,
        sensitivity: evidence.sensitivity,
      });
      return evidence;
    },

    async getEvidence(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`evidence not found: ${id}`, { evidenceId: id });
      }
      return found;
    },

    async listEvidenceBySubject(_execution, subjectId) {
      return repository.listBySubject(subjectId);
    },

    async verifyEvidenceCommitment(_execution, id, presentedPayload) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`evidence not found: ${id}`, { evidenceId: id });
      }
      if (!found.commitment) {
        const result: CommitmentVerification = {
          evidenceId: id,
          valid: false,
          reason: "evidence record carries no commitment",
        };
        return result;
      }
      const valid = verifyEvidenceCommitment(presentedPayload, found.commitment);
      const result: CommitmentVerification = {
        evidenceId: id,
        valid,
        reason: valid
          ? "presented material matches the stored commitment"
          : "presented material does NOT match the stored commitment",
      };
      return result;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
