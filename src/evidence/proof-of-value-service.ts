/**
 * ProofOfValueService — domain service orchestrating the
 * Proof-of-Value lifecycle (NET-W005 §3.8).
 *
 * Architecture ref: spec/architecture.md §4 (Proof-of-Value: an
 * evidence-backed settlement claim containing value, provenance,
 * confidence and supporting attestations — NET-W005 implements the
 * EVIDENCE/CONFIDENCE/ATTESTATION structure; the ECONOMIC value
 * dimension attaches in NET-W008, which requires a VERIFIED PoV
 * reference per architecture-lock §20), §17 (authoritative workflow);
 * spec/architecture-lock.md §7 (workflow authority: ONLY /workflows
 * mutates lifecycle state — this service validates preconditions and
 * REQUESTS transitions through the WorkflowService), §4 (agent/model
 * output is input evidence, never authoritative — enforced by the
 * VERIFIED precondition requiring MEASURED/ATTESTED evidence).
 *
 * Division of responsibility (work order §4 invariant 5):
 *  - THIS service: domain preconditions (evidence presence, evidence
 *    set frozen at EVALUATING, aggregation recorded, high-grade
 *    evidence, attestations) + domain mutations (attach evidence,
 *    aggregate, attach attestation — audited atomically).
 *  - /workflows WorkflowService: EVERY lifecycle state change
 *    (authorization, transition legality, idempotency, optimistic
 *    concurrency, audit lineage with the authoritative transaction id).
 *
 * Version semantics: `version` is the LIFECYCLE version (workflow
 * transitions only). Domain mutations update `updatedAt` but not
 * `version`.
 *
 * Tier compliance: evidence domain → self + core contracts only
 * (WorkflowService is consumed through the CORE-declared port shape
 * re-exported from the workflows port — structural interface, no
 * domain→domain import: the bootstrap composition root injects it).
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
import type { TransitionRequest, TransitionResult } from "../core/workflow.ts";
import { policyActionFor } from "../core/workflow.ts";
import { aggregateEvidence, hasHighSupportEvidence } from "./aggregation.ts";
import type {
  AttestationRepository,
  CreateProofOfValueInput,
  EvidenceRepository,
  OutcomeClaimRepository,
  ProofOfValue,
  ProofOfValueRepository,
  ProofOfValueService,
  ProofOfValueTransitionInput,
  ProofOfValueTransitionResult,
  SubjectLookup,
} from "./port.ts";

const POV_CREATED = "proof_of_value.created" as const;
const POV_EVIDENCE_ATTACHED = "proof_of_value.evidence_attached" as const;
const POV_AGGREGATED = "proof_of_value.aggregated" as const;
const POV_ATTESTATION_ATTACHED = "proof_of_value.attestation_attached" as const;

/**
 * The workflow surface this service needs (structural interface — the
 * workflows port's WorkflowService satisfies it; declared HERE so the
 * evidence domain does not import the workflows domain). The bootstrap
 * composition root injects the concrete workflow service.
 */
export interface WorkflowTransitionAuthority {
  requestTransition(
    request: TransitionRequest,
    execution: ExecutionContext,
  ): Promise<TransitionResult>;
}

export interface ProofOfValueServiceDeps {
  readonly repository: ProofOfValueRepository;
  readonly evidenceRepository: EvidenceRepository;
  readonly outcomeClaimRepository: OutcomeClaimRepository;
  readonly attestationRepository: AttestationRepository;
  /** Validates the PoV subject exists + resolves its org scope. */
  readonly subjectLookup: SubjectLookup;
  /** The /workflows authority (injected by the composition root). */
  readonly workflow: WorkflowTransitionAuthority;
  readonly authority: PostgresAuthority;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createProofOfValueService(
  deps: ProofOfValueServiceDeps,
): ProofOfValueService {
  const {
    repository,
    evidenceRepository,
    outcomeClaimRepository,
    attestationRepository,
    subjectLookup,
    workflow,
    authority,
    auditWriter,
    logger,
  } = deps;

  /** Load a PoV or throw NotFoundError. */
  async function requireProof(id: string): Promise<ProofOfValue> {
    const proof = await repository.findById(id);
    if (!proof) {
      throw new NotFoundError(`proof of value not found: ${id}`, { proofId: id });
    }
    return proof;
  }

  /**
   * Validate that evidence records exist, share the PoV's org scope,
   * and are not already attached; return them (for aggregation).
   */
  async function resolveEvidenceForAttachment(
    proof: ProofOfValue,
    evidenceIds: readonly string[],
  ): Promise<void> {
    for (const evidenceId of evidenceIds) {
      const evidence = await evidenceRepository.findById(evidenceId);
      if (!evidence) {
        throw new NotFoundError(`evidence not found: ${evidenceId}`, { evidenceId });
      }
      if (evidence.organizationScopeId !== proof.organizationScopeId) {
        throw new OpenConError({
          code: "PROOF_OF_VALUE_VALIDATION",
          classification: "validation",
          message: `evidence ${evidenceId} belongs to organization scope ${evidence.organizationScopeId}, not ${proof.organizationScopeId}`,
          context: { evidenceId },
        });
      }
    }
  }

  /**
   * Request a lifecycle transition through the /workflows authority
   * (the SOLE lifecycle mutator) and wrap the result with the fresh
   * PoV entity. The policy action is derived from the CURRENT state →
   * target using the CORE string vocabulary (identical to the
   * transition table's rule actions by construction — no domain→domain
   * import needed).
   */
  async function requestLifecycleTransition(
    execution: ExecutionContext,
    input: ProofOfValueTransitionInput,
    targetState: TransitionRequest["targetState"],
  ): Promise<ProofOfValueTransitionResult> {
    const current = await requireProof(input.proofId);
    const request: TransitionRequest = {
      subjectId: input.proofId,
      subjectKind: "proof_of_value",
      targetState,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      actorPersonId: input.actorPersonId,
      policyAction: policyActionFor("proof_of_value", current.state, targetState),
      metadata: input.metadata,
    };
    // The workflow service authorizes (deny-by-default), checks
    // legality against the PoV transition table, applies idempotency
    // + optimistic concurrency, and emits the transition audit record
    // atomically with the mutation.
    const result = await workflow.requestTransition(request, execution);
    const proof = await repository.findById(input.proofId);
    if (!proof) {
      throw new NotFoundError(`proof of value not found: ${input.proofId}`, {
        proofId: input.proofId,
      });
    }
    return {
      proof,
      executed: result.executed,
      transitionId: result.transitionId,
      recordId: result.recordId,
      auditEventName: result.auditEventName,
      executionId: result.executionId,
      correlationId: result.correlationId,
      causationId: result.causationId,
      transactionId: result.transactionId,
    };
  }

  const service: ProofOfValueService = {
    async createProofOfValue(execution, input) {
      // ---- Validation --------------------------------------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "PROOF_OF_VALUE_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.ownerId?.trim()) {
        throw new OpenConError({
          code: "PROOF_OF_VALUE_VALIDATION",
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
          code: "PROOF_OF_VALUE_VALIDATION",
          classification: "validation",
          message: "subjectReference.subjectId and subjectReference.subjectType are required",
          context: { field: "subjectReference" },
        });
      }
      // The subject must exist and share the PoV's organization scope
      // (tenant scoping via the injected SubjectLookup — no
      // domain→domain import).
      const subjectExists = await subjectLookup.exists(
        input.subjectReference.subjectType,
        input.subjectReference.subjectId,
      );
      if (!subjectExists) {
        throw new NotFoundError(
          `${input.subjectReference.subjectType} ${input.subjectReference.subjectId} not found`,
          {
            subjectId: input.subjectReference.subjectId,
            subjectType: input.subjectReference.subjectType,
          },
        );
      }
      const subjectScope = await subjectLookup.getOrganizationScope(
        input.subjectReference.subjectType,
        input.subjectReference.subjectId,
      );
      if (subjectScope !== input.organizationScopeId) {
        throw new OpenConError({
          code: "PROOF_OF_VALUE_VALIDATION",
          classification: "validation",
          message: `subject ${input.subjectReference.subjectId} belongs to organization scope ${String(subjectScope)}, not ${input.organizationScopeId}`,
          context: { subjectScope },
        });
      }
      const outcomeClaimIds = input.outcomeClaimIds ?? [];
      for (const claimId of outcomeClaimIds) {
        const claim = await outcomeClaimRepository.findById(claimId);
        if (!claim) {
          throw new NotFoundError(`outcome claim not found: ${claimId}`, { claimId });
        }
        if (claim.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `outcome claim ${claimId} belongs to organization scope ${claim.organizationScopeId}, not ${input.organizationScopeId}`,
            context: { claimId },
          });
        }
      }
      const evidenceIds = input.evidenceIds ?? [];
      const draft: ProofOfValue = Object.freeze({
        id: randomUUID(),
        kind: "proof_of_value",
        state: "DRAFT",
        version: 0,
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subjectReference: input.subjectReference,
        outcomeClaimIds,
        evidenceIds,
        aggregation: null,
        attestationIds: [],
      });
      await resolveEvidenceForAttachment(draft, evidenceIds);

      // ---- Atomic mutation + audit (AUD-002) ----------------------------
      await authority.run(execution, async (tx) => {
        await repository.createWithinTx(draft, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: POV_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: draft.id,
          resourceType: "proof_of_value",
          resourceId: draft.id,
          metadata: {
            subjectId: draft.subjectReference.subjectId,
            subjectType: draft.subjectReference.subjectType,
            outcomeClaimCount: draft.outcomeClaimIds.length,
            initialEvidenceCount: draft.evidenceIds.length,
            organizationScopeId: draft.organizationScopeId,
          },
        });
      });
      logger.info("proof_of_value.created", { proofId: draft.id });
      return draft;
    },

    async getProofOfValue(_execution, id) {
      return requireProof(id);
    },

    async attachEvidence(execution, proofId, evidenceId) {
      // ---- Domain precondition + append (audited atomically) ------------
      const now = new Date().toISOString();
      const updated = await authority.run(execution, async (tx) => {
        const current = await repository.findByIdWithinTx(proofId, tx);
        if (!current) {
          throw new NotFoundError(`proof of value not found: ${proofId}`, { proofId });
        }
        // Evidence attachment is legal while DRAFT or MEASURING (the
        // evidence set freezes when evaluation begins).
        if (current.state !== "DRAFT" && current.state !== "MEASURING") {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `evidence cannot be attached in state ${current.state} (allowed: DRAFT, MEASURING — the evidence set freezes at EVALUATING)`,
            context: { proofId, state: current.state },
          });
        }
        const evidence = await evidenceRepository.findById(evidenceId);
        if (!evidence) {
          throw new NotFoundError(`evidence not found: ${evidenceId}`, { evidenceId });
        }
        if (evidence.organizationScopeId !== current.organizationScopeId) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `evidence ${evidenceId} belongs to organization scope ${evidence.organizationScopeId}, not ${current.organizationScopeId}`,
            context: { evidenceId },
          });
        }
        if (current.evidenceIds.includes(evidenceId)) {
          return current; // append-only idempotency
        }
        const appended: ProofOfValue = Object.freeze({
          ...current,
          evidenceIds: [...current.evidenceIds, evidenceId],
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
          updatedAt: now,
        });
        await repository.saveWithinTx(appended, current.version, execution, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: POV_EVIDENCE_ATTACHED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: proofId,
          resourceType: "proof_of_value",
          resourceId: proofId,
          metadata: {
            evidenceId,
            evidenceGrade: evidence.grade,
            evidenceSensitivity: evidence.sensitivity,
            evidenceCount: appended.evidenceIds.length,
            state: appended.state,
          },
        });
        return appended;
      });
      logger.info("proof_of_value.evidence_attached", { proofId, evidenceId });
      return updated;
    },

    async aggregateEvidence(execution, proofId) {
      // ---- Deterministic aggregation over the attached evidence ---------
      const now = new Date().toISOString();
      const updated = await authority.run(execution, async (tx) => {
        const current = await repository.findByIdWithinTx(proofId, tx);
        if (!current) {
          throw new NotFoundError(`proof of value not found: ${proofId}`, { proofId });
        }
        // Aggregation happens during EVALUATING (the evidence set is
        // frozen by then — deterministic input).
        if (current.state !== "EVALUATING") {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `evidence can be aggregated only in state EVALUATING (current: ${current.state})`,
            context: { proofId, state: current.state },
          });
        }
        if (current.evidenceIds.length === 0) {
          throw new OpenConError({
            code: "AGGREGATION_REQUIRES_EVIDENCE",
            classification: "validation",
            message: "evidence aggregation requires at least one evidence record",
            context: { proofId },
          });
        }
        const records = [];
        for (const evidenceId of current.evidenceIds) {
          const evidence = await evidenceRepository.findById(evidenceId);
          if (!evidence) {
            throw new NotFoundError(`evidence not found: ${evidenceId}`, { evidenceId });
          }
          records.push(evidence);
        }
        // PURE deterministic function (aggregation.ts) — same input,
        // same output; consumes durable records only (no raw payloads;
        // sensitive records carry none).
        const aggregation = aggregateEvidence(records);
        const aggregated: ProofOfValue = Object.freeze({
          ...current,
          aggregation,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
          updatedAt: now,
        });
        await repository.saveWithinTx(aggregated, current.version, execution, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: POV_AGGREGATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: proofId,
          resourceType: "proof_of_value",
          resourceId: proofId,
          metadata: {
            evidenceCount: aggregation.evidenceCount,
            independentSources: aggregation.independentSources,
            aggregatePoint: aggregation.aggregatePoint,
            aggregateInterval: aggregation.aggregateInterval,
            dominantGrade: aggregation.dominantGrade,
            gradesPresent: aggregation.gradesPresent,
          },
        });
        return aggregated;
      });
      logger.info("proof_of_value.aggregated", { proofId });
      return updated;
    },

    async attachAttestation(execution, proofId, attestationId) {
      // ---- Domain precondition + append (audited atomically) ------------
      const now = new Date().toISOString();
      const updated = await authority.run(execution, async (tx) => {
        const current = await repository.findByIdWithinTx(proofId, tx);
        if (!current) {
          throw new NotFoundError(`proof of value not found: ${proofId}`, { proofId });
        }
        // Attestations attach while evidence gathering / evaluation is
        // open (MEASURING or EVALUATING — a DRAFT PoV has nothing to
        // attest yet).
        if (current.state !== "MEASURING" && current.state !== "EVALUATING") {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `attestations can be attached only in states MEASURING or EVALUATING (current: ${current.state})`,
            context: { proofId, state: current.state },
          });
        }
        const attestation = await attestationRepository.findById(attestationId);
        if (!attestation) {
          throw new NotFoundError(`attestation not found: ${attestationId}`, {
            attestationId,
          });
        }
        if (attestation.organizationScopeId !== current.organizationScopeId) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `attestation ${attestationId} belongs to organization scope ${attestation.organizationScopeId}, not ${current.organizationScopeId}`,
            context: { attestationId },
          });
        }
        // The attestation must cover ONLY evidence already attached to
        // this PoV (deterministic rule: an attestation over evidence
        // the PoV does not carry cannot support it).
        const uncovered = attestation.evidenceIds.filter(
          (evidenceId) => !current.evidenceIds.includes(evidenceId),
        );
        if (uncovered.length > 0) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message: `attestation ${attestationId} covers evidence not attached to this proof of value: ${uncovered.join(", ")}`,
            context: { attestationId, uncovered },
          });
        }
        if (current.attestationIds.includes(attestationId)) {
          return current; // append-only idempotency
        }
        const appended: ProofOfValue = Object.freeze({
          ...current,
          attestationIds: [...current.attestationIds, attestationId],
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
          updatedAt: now,
        });
        await repository.saveWithinTx(appended, current.version, execution, tx);
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: POV_ATTESTATION_ATTACHED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: proofId,
          resourceType: "proof_of_value",
          resourceId: proofId,
          metadata: {
            attestationId,
            verifierId: attestation.verifierId,
            attestationCount: appended.attestationIds.length,
            state: appended.state,
          },
        });
        return appended;
      });
      logger.info("proof_of_value.attestation_attached", { proofId, attestationId });
      return updated;
    },

    async beginMeasuring(execution, input) {
      // DRAFT → MEASURING: open evidence gathering. No evidence
      // precondition (gathering may begin empty); legality +
      // authorization + idempotency are enforced by the workflow.
      await requireProof(input.proofId);
      return requestLifecycleTransition(execution, input, "MEASURING");
    },

    async completeEvidenceGathering(execution, input) {
      // MEASURING → EVALUATING: deterministic precondition — at least
      // one attached evidence record (work order §3.8).
      const proof = await requireProof(input.proofId);
      if (proof.state === "MEASURING" && proof.evidenceIds.length === 0) {
        throw new OpenConError({
          code: "PROOF_OF_VALUE_VALIDATION",
          classification: "validation",
          message:
            "evidence gathering cannot complete without at least one attached evidence record",
          context: { proofId: input.proofId },
        });
      }
      return requestLifecycleTransition(execution, input, "EVALUATING");
    },

    async verify(execution, input) {
      // EVALUATING → VERIFIED: deterministic preconditions (work order
      // §3.8; architecture-lock §4 — evidence, not participant/agent
      // claims, is authoritative):
      //   1. a recorded aggregation (the evaluation actually ran);
      //   2. ≥1 MEASURED or ATTESTED evidence (never model-assessed or
      //      self-reported alone);
      //   3. ≥1 attached attestation.
      const proof = await requireProof(input.proofId);
      if (proof.state === "EVALUATING") {
        if (proof.aggregation === null) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message:
              "the proof of value cannot be verified before its evidence is aggregated",
            context: { proofId: input.proofId },
          });
        }
        if (proof.attestationIds.length === 0) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message:
              "the proof of value cannot be verified without at least one attached attestation",
            context: { proofId: input.proofId },
          });
        }
        const records = [];
        for (const evidenceId of proof.evidenceIds) {
          const evidence = await evidenceRepository.findById(evidenceId);
          if (evidence) records.push(evidence);
        }
        if (!hasHighSupportEvidence(records)) {
          throw new OpenConError({
            code: "PROOF_OF_VALUE_VALIDATION",
            classification: "validation",
            message:
              "the proof of value cannot be verified on model-assessed or self-reported evidence alone — at least one MEASURED or ATTESTED evidence record is required (architecture-lock §4)",
            context: { proofId: input.proofId, evidenceCount: records.length },
          });
        }
      }
      return requestLifecycleTransition(execution, input, "VERIFIED");
    },

    async reject(execution, input) {
      // MEASURING|EVALUATING → REJECTED (deterministic rules failed).
      await requireProof(input.proofId);
      return requestLifecycleTransition(execution, input, "REJECTED");
    },

    async cancel(execution, input) {
      // DRAFT|MEASURING|EVALUATING → CANCELLED.
      await requireProof(input.proofId);
      return requestLifecycleTransition(execution, input, "CANCELLED");
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
