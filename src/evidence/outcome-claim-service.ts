/**
 * OutcomeClaimService — domain service for provider-neutral outcome
 * claims (NET-W005 §3.4; OUT-001 vocabulary).
 *
 * Architecture ref: spec/architecture.md §4 (Outcome primitive),
 * §18 (`/outcomes` owns measurement semantics — NET-W006; NET-W005
 * carries the CLAIM vocabulary only). Provider-neutral: no campaign-,
 * platform-, or provider-specific semantics; unknown outcome types
 * are rejected with the stable error code UNSUPPORTED_OUTCOME_TYPE.
 *
 * Immutability rules (work order §3.4):
 *  - claimedValue (value + unit), outcomeType, subjectReference, and
 *    claimant are immutable after creation — a different value is a
 *    DIFFERENT claim;
 *  - the evidence set is append-only (attachEvidence);
 *  - `version` increments on evidence attachment (optimistic
 *    concurrency for the append: a caller may pass expectedVersion
 *    and stale writers are rejected).
 *
 * Atomicity: every mutation (create, attach) commits together with
 * its audit record in ONE authoritative transaction (transactional
 * audit buffer bound to the same tx — AUD-002 evidence lineage).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import {
  ConflictError,
  NotFoundError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  isStandardOutcomeType,
  validateConfidenceEstimate,
} from "../core/evidence.ts";
import type {
  CreateOutcomeClaimInput,
  EvidenceRepository,
  OutcomeClaim,
  OutcomeClaimRepository,
  OutcomeClaimService,
} from "./port.ts";

const CLAIM_CREATED = "outcome_claim.created" as const;
const EVIDENCE_ATTACHED = "outcome_claim.evidence_attached" as const;

export interface OutcomeClaimServiceDeps {
  readonly repository: OutcomeClaimRepository;
  /** For validating that referenced evidence exists in the same org scope. */
  readonly evidenceRepository: EvidenceRepository;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createOutcomeClaimService(
  deps: OutcomeClaimServiceDeps,
): OutcomeClaimService {
  const { repository, evidenceRepository, authority, auditWriter, logger } = deps;

  /**
   * Validate that every referenced evidence record exists and belongs
   * to the claim's organization scope (tenant scoping — the same
   * invariant pattern as the contributions domain's OpportunityLookup).
   */
  async function validateEvidenceIds(
    organizationScopeId: string,
    evidenceIds: readonly string[],
  ): Promise<void> {
    for (const evidenceId of evidenceIds) {
      const evidence = await evidenceRepository.findById(evidenceId);
      if (!evidence) {
        throw new NotFoundError(`evidence not found: ${evidenceId}`, {
          evidenceId,
        });
      }
      if (evidence.organizationScopeId !== organizationScopeId) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: `evidence ${evidenceId} belongs to organization scope ${evidence.organizationScopeId}, not ${organizationScopeId}`,
          context: { evidenceId, evidenceScope: evidence.organizationScopeId },
        });
      }
    }
  }

  const service: OutcomeClaimService = {
    async createOutcomeClaim(execution, input) {
      // ---- Validation --------------------------------------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.claimantId?.trim()) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: "claimantId is required",
          context: { field: "claimantId" },
        });
      }
      if (
        !input.subjectReference?.subjectId?.trim() ||
        !input.subjectReference?.subjectType?.trim()
      ) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: "subjectReference.subjectId and subjectReference.subjectType are required",
          context: { field: "subjectReference" },
        });
      }
      // OUT-001: the claim must name a type from the standard outcome
      // vocabulary; unknown types are rejected with a stable code.
      if (!isStandardOutcomeType(input.outcomeType)) {
        throw new OpenConError({
          code: "UNSUPPORTED_OUTCOME_TYPE",
          classification: "validation",
          message: `outcomeType must be one of the standard outcome types (got ${String(input.outcomeType)})`,
          context: { outcomeType: input.outcomeType },
        });
      }
      if (
        typeof input.claimedValue?.value !== "number" ||
        !Number.isFinite(input.claimedValue.value) ||
        input.claimedValue.value < 0
      ) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: "claimedValue.value must be a finite non-negative number",
          context: { field: "claimedValue.value" },
        });
      }
      if (!input.claimedValue?.unit?.trim()) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: "claimedValue.unit is required",
          context: { field: "claimedValue.unit" },
        });
      }
      // EVID-005: confidence invariants.
      const confidence = validateConfidenceEstimate(input.confidence);
      const evidenceIds = input.evidenceIds ?? [];
      if (evidenceIds.length !== new Set(evidenceIds).size) {
        throw new OpenConError({
          code: "OUTCOME_CLAIM_VALIDATION",
          classification: "validation",
          message: "evidenceIds must not contain duplicates",
          context: { field: "evidenceIds" },
        });
      }
      await validateEvidenceIds(input.organizationScopeId, evidenceIds);

      // ---- Create -------------------------------------------------------
      const now = new Date().toISOString();
      const claim: OutcomeClaim = Object.freeze({
        id: randomUUID(),
        organizationScopeId: input.organizationScopeId,
        claimantId: input.claimantId,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType,
        claimedValue: Object.freeze({ ...input.claimedValue }),
        confidence,
        evidenceIds,
        statement: input.statement ?? null,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
        updatedAt: now,
        version: 0,
      });

      // ---- Atomic mutation + audit (AUD-002) ----------------------------
      await authority.run(execution, async (tx) => {
        await repository.saveWithinTx(claim, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: CLAIM_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: claim.id,
          resourceType: "outcome_claim",
          resourceId: claim.id,
          metadata: {
            outcomeType: claim.outcomeType,
            claimedValue: claim.claimedValue.value,
            claimedUnit: claim.claimedValue.unit,
            confidencePoint: claim.confidence.point,
            evidenceCount: claim.evidenceIds.length,
            subjectId: claim.subjectReference.subjectId,
            subjectType: claim.subjectReference.subjectType,
            organizationScopeId: claim.organizationScopeId,
          },
        });
      });
      logger.info("outcome_claim.created", {
        claimId: claim.id,
        outcomeType: claim.outcomeType,
      });
      return claim;
    },

    async getOutcomeClaim(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`outcome claim not found: ${id}`, { claimId: id });
      }
      return found;
    },

    async attachEvidence(execution, claimId, evidenceId, expectedVersion) {
      // ---- Validation + append (claim value/type immutable by design) --
      const now = new Date().toISOString();
      const updated = await authority.run(execution, async (tx) => {
        const current = await repository.findByIdWithinTx(claimId, tx);
        if (!current) {
          throw new NotFoundError(`outcome claim not found: ${claimId}`, {
            claimId,
          });
        }
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          throw new ConflictError(
            `stale writer for outcome claim ${claimId}: expected version ${expectedVersion}, authoritative version ${current.version}`,
            { claimId, expectedVersion, authoritativeVersion: current.version },
          );
        }
        const evidence = await evidenceRepository.findById(evidenceId);
        if (!evidence) {
          throw new NotFoundError(`evidence not found: ${evidenceId}`, {
            evidenceId,
          });
        }
        if (evidence.organizationScopeId !== current.organizationScopeId) {
          throw new OpenConError({
            code: "OUTCOME_CLAIM_VALIDATION",
            classification: "validation",
            message: `evidence ${evidenceId} belongs to organization scope ${evidence.organizationScopeId}, not ${current.organizationScopeId}`,
            context: { evidenceId },
          });
        }
        if (current.evidenceIds.includes(evidenceId)) {
          // Append-only idempotency: attaching already-attached evidence
          // is a no-op (returns the current claim unchanged).
          return current;
        }
        const appended: OutcomeClaim = Object.freeze({
          ...current,
          evidenceIds: [...current.evidenceIds, evidenceId],
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
          updatedAt: now,
          version: current.version + 1,
        });
        await repository.saveWithinTx(appended, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: EVIDENCE_ATTACHED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: claimId,
          resourceType: "outcome_claim",
          resourceId: claimId,
          metadata: {
            evidenceId,
            evidenceGrade: evidence.grade,
            fromVersion: current.version,
            toVersion: appended.version,
            evidenceCount: appended.evidenceIds.length,
          },
        });
        return appended;
      });
      logger.info("outcome_claim.evidence_attached", {
        claimId,
        evidenceId,
      });
      return updated;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
