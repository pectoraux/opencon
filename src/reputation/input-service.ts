/**
 * ReputationInputService — domain service recording the immutable,
 * evidence-backed reputation inputs (NET-W007 §3.2).
 *
 * Architecture ref: spec/architecture.md §11 (reputation not
 * purchasable; every major change traceable to evidence),
 * §19 (model output never sufficient by itself);
 * spec/architecture-lock.md §4 (model output is input evidence, never
 * authoritative), §3 (PostgreSQL authoritative), §12 (execution
 * lineage).
 *
 * THE GATE (work order §2 / §4 invariants 3, 5, 6):
 *  - every input MUST carry ≥1 upstream source reference — a bare
 *    activity/spend/wealth assertion CANNOT enter the system (there
 *    is no contract field for any of them — REP-002 is structural);
 *  - every source is RESOLVED through the injected neutral lookups
 *    (existence + same organization scope enforced — tenant scoping);
 *  - the `basis` is DERIVED from the resolved upstream records, never
 *    caller-asserted: `verified` iff any source resolves verified-grade
 *    (VERIFIED contribution/Proof-of-Value/measured outcome, or
 *    platform/attested/provider evidence), else `indicated`;
 *  - the subject person must exist (structural identity lookup).
 *
 * Atomicity + idempotency: the input record, its audit record
 * (`reputation_input.recorded`) and the idempotency record commit in
 * ONE authoritative transaction (IdempotencyStore.apply — the same
 * NET-W004 primitive the workflow service uses); the idempotency key
 * is scoped to (organization, subject, caller key) so concurrent
 * same-key recordings produce exactly one input.
 *
 * Tier compliance: reputation domain → self + core contracts only
 * (upstream domains are consumed through the structural lookup
 * interfaces declared in port.ts; the composition root wires them).
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  VERIFIED_GRADE_EVIDENCE_SOURCE_TYPES,
  isReputationDimension,
  isReputationInputSourceKind,
  type ReputationDimension,
  type ReputationInputBasis,
  type ReputationInputSourceKind,
} from "../core/reputation.ts";
import type {
  RecordReputationInputInput,
  RecordReputationInputResult,
  ReputationContributionLookup,
  ReputationEvidenceLookup,
  ReputationInput,
  ReputationInputRepository,
  ReputationInputService,
  ReputationInputSourceRef,
  ReputationMeasuredOutcomeLookup,
  ReputationProofOfValueLookup,
  ReputationSubjectLookup,
  ResolvedEvidenceSource,
  ResolvedLifecycleSource,
} from "./port.ts";

const INPUT_RECORDED = "reputation_input.recorded" as const;

export interface ReputationInputServiceDeps {
  readonly repository: ReputationInputRepository;
  /** Validates the subject person exists (identity domain adapter). */
  readonly subjectLookup: ReputationSubjectLookup;
  /** Resolves evidence sources (evidence domain adapter). */
  readonly evidenceLookup: ReputationEvidenceLookup;
  /** Resolves Proof-of-Value sources (evidence domain adapter). */
  readonly proofOfValueLookup: ReputationProofOfValueLookup;
  /** Resolves measured-outcome sources (outcomes domain adapter). */
  readonly measuredOutcomeLookup: ReputationMeasuredOutcomeLookup;
  /** Resolves contribution sources (contributions domain adapter). */
  readonly contributionLookup: ReputationContributionLookup;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createReputationInputService(
  deps: ReputationInputServiceDeps,
): ReputationInputService {
  const {
    repository,
    subjectLookup,
    evidenceLookup,
    proofOfValueLookup,
    measuredOutcomeLookup,
    contributionLookup,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /** Resolve one source ref to its structural view (null = unknown). */
  async function resolveSource(
    ref: ReputationInputSourceRef,
  ): Promise<ResolvedLifecycleSource | ResolvedEvidenceSource | null> {
    switch (ref.kind) {
      case "evidence":
        return evidenceLookup.resolve(ref.id);
      case "proof_of_value":
        return proofOfValueLookup.resolve(ref.id);
      case "measured_outcome":
        return measuredOutcomeLookup.resolve(ref.id);
      case "contribution":
        return contributionLookup.resolve(ref.id);
      default:
        return null;
    }
  }

  /**
   * Deterministically derive the basis from a resolved source:
   * lifecycle records are verified-grade iff VERIFIED; evidence is
   * verified-grade iff its sourceType is platform/attested/provider
   * (model/self evidence is `indicated` only — architecture-lock §4).
   */
  function sourceIsVerifiedGrade(
    kind: ReputationInputSourceKind,
    resolved: ResolvedLifecycleSource | ResolvedEvidenceSource,
  ): boolean {
    if (kind === "evidence") {
      const evidence = resolved as ResolvedEvidenceSource;
      return (VERIFIED_GRADE_EVIDENCE_SOURCE_TYPES as readonly string[]).includes(
        evidence.sourceType,
      );
    }
    return (resolved as ResolvedLifecycleSource).state === "VERIFIED";
  }

  const service: ReputationInputService = {
    async recordInput(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "REPUTATION_INPUT_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.subjectPersonId?.trim()) {
        throw new OpenConError({
          code: "REPUTATION_INPUT_VALIDATION",
          classification: "validation",
          message: "subjectPersonId is required",
          context: { field: "subjectPersonId" },
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "REPUTATION_INPUT_VALIDATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }
      if (!isReputationDimension(input.dimension)) {
        throw new OpenConError({
          code: "REPUTATION_INPUT_VALIDATION",
          classification: "validation",
          message: `dimension must be one of the standard reputation dimensions (got ${String(input.dimension)})`,
          context: { dimension: input.dimension },
        });
      }
      // Capture the narrowed dimension BEFORE the applyIdempotent
      // closure (type narrowing does not survive into closures).
      const dimension: ReputationDimension = input.dimension;
      if (!Array.isArray(input.sources) || input.sources.length === 0) {
        throw new OpenConError({
          code: "REPUTATION_INPUT_VALIDATION",
          classification: "validation",
          message:
            "a reputation input requires at least one upstream source reference (evidence, proof of value, measured outcome or contribution) — a bare activity or spend assertion cannot enter the reputation system",
          context: {
            subjectPersonId: input.subjectPersonId,
            sourceCount: Array.isArray(input.sources) ? input.sources.length : 0,
          },
        });
      }
      const sources: ReputationInputSourceRef[] = [];
      for (const source of input.sources) {
        if (!source || !source.id?.trim()) {
          throw new OpenConError({
            code: "REPUTATION_INPUT_VALIDATION",
            classification: "validation",
            message: "each source requires an id",
            context: { source },
          });
        }
        if (!isReputationInputSourceKind(source.kind)) {
          throw new OpenConError({
            code: "REPUTATION_INPUT_VALIDATION",
            classification: "validation",
            message: `source kind must be one of evidence | proof_of_value | measured_outcome | contribution (got ${String(source.kind)})`,
            context: { kind: source.kind },
          });
        }
        sources.push({ kind: source.kind, id: source.id });
      }
      if (!input.occurredAt || Number.isNaN(Date.parse(input.occurredAt))) {
        throw new OpenConError({
          code: "REPUTATION_INPUT_VALIDATION",
          classification: "validation",
          message: `occurredAt must be a valid ISO-8601 timestamp (got ${String(input.occurredAt)})`,
          context: { occurredAt: input.occurredAt },
        });
      }

      // ---- Subject + upstream resolution (neutral lookups) -------------
      const subjectExists = await subjectLookup.exists(input.subjectPersonId);
      if (!subjectExists) {
        throw new NotFoundError(
          `reputation subject person not found: ${input.subjectPersonId}`,
          { subjectPersonId: input.subjectPersonId },
        );
      }
      let anyVerified = false;
      for (const ref of sources) {
        const resolved = await resolveSource(ref);
        if (!resolved) {
          throw new NotFoundError(
            `upstream ${ref.kind} not found: ${ref.id}`,
            { kind: ref.kind, id: ref.id },
          );
        }
        if (resolved.organizationScopeId !== input.organizationScopeId) {
          throw new OpenConError({
            code: "REPUTATION_INPUT_VALIDATION",
            classification: "validation",
            message: `upstream ${ref.kind} ${ref.id} belongs to organization scope ${resolved.organizationScopeId}, not ${input.organizationScopeId}`,
            context: {
              kind: ref.kind,
              id: ref.id,
              sourceScope: resolved.organizationScopeId,
              inputScope: input.organizationScopeId,
            },
          });
        }
        if (sourceIsVerifiedGrade(ref.kind, resolved)) {
          anyVerified = true;
        }
      }
      // THE DERIVED BASIS (never caller-asserted — work order §4
      // invariant 6): model/self-only backing is `indicated`.
      const basis: ReputationInputBasis = anyVerified ? "verified" : "indicated";

      // ---- Idempotent, atomic, audited append --------------------------
      const key = `reputation_input:${input.organizationScopeId}:${input.subjectPersonId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const record: ReputationInput = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            subjectPersonId: input.subjectPersonId,
            dimension,
            basis,
            sources,
            description: input.description?.trim() || null,
            occurredAt: input.occurredAt,
            recordedAt: new Date().toISOString(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await repository.createWithinTx(record, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: INPUT_RECORDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: record.id,
            resourceType: "reputation_input",
            resourceId: record.id,
            metadata: {
              subjectPersonId: record.subjectPersonId,
              organizationScopeId: record.organizationScopeId,
              dimension: record.dimension,
              basis: record.basis,
              sources: record.sources.map((s) => `${s.kind}:${s.id}`),
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
              occurredAt: record.occurredAt,
            },
          });
          return record;
        },
        execution,
      );
      logger.info("reputation_input.recorded", {
        inputId: applied.result.id,
        dimension: applied.result.dimension,
        basis: applied.result.basis,
        created: applied.executed,
      });
      return { input: applied.result, created: applied.executed };
    },

    async getInput(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`reputation input not found: ${id}`, {
          inputId: id,
        });
      }
      return found;
    },

    async listInputs(_execution, organizationScopeId, subjectPersonId) {
      return repository.listBySubject(organizationScopeId, subjectPersonId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
