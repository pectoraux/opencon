/**
 * ReputationSnapshotService — the deterministic snapshot engine
 * (NET-W007 §3.4/§3.5): computes multidimensional scores with time
 * decay and records immutable, reconstructable snapshots.
 *
 * Architecture ref: spec/architecture.md §11 (multidimensional,
 * evidence-traced reputation), §19; spec/architecture-lock.md §3
 * (PostgreSQL authoritative), §4 (model output non-authoritative —
 * the engine's indicated-only cap), §12 (execution lineage).
 *
 * Determinism (work order §4 invariants 1, 2, 4):
 *  - `computeScores` is a PURE projection: policy (exact version) +
 *    subject inputs + explicit `referenceAt` → scores + digest. NO
 *    wall clock, NO hidden state. Identical inputs → bit-identical
 *    outputs (the digest makes this assertable).
 *  - `recordSnapshot` runs the SAME engine INSIDE the authoritative
 *    transaction over the transaction-consistent input set, so the
 *    persisted snapshot always matches a recomputation from its
 *    recorded (inputIds, policyVersion, referenceAt) triple —
 *    reconstructability (AUD-004).
 *
 * Idempotency + atomicity: the snapshot record, its audit record
 * (`reputation_snapshot.recorded`) and the idempotency record commit
 * in ONE authoritative transaction (IdempotencyStore.apply — the
 * NET-W004 primitive); the key is scoped to (organization, subject,
 * caller key). Append-only: different keys → additional snapshots;
 * the history stays ordered and every score change is auditable.
 *
 * Tier compliance: reputation domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { ReputationScoringRule } from "../core/reputation.ts";
import type {
  ComputeReputationScoresInput,
  ComputeReputationScoresResult,
  RecordReputationSnapshotInput,
  RecordReputationSnapshotResult,
  ReputationInputRepository,
  ReputationScoringPolicy,
  ReputationScoringPolicyRepository,
  ReputationSnapshot,
  ReputationSnapshotRepository,
  ReputationSnapshotService,
} from "./port.ts";
import {
  computeDimensionScores,
  computeScoresDigest,
  includedInputIds,
} from "./scoring.ts";

const SNAPSHOT_RECORDED = "reputation_snapshot.recorded" as const;

export interface ReputationSnapshotServiceDeps {
  readonly policyRepository: ReputationScoringPolicyRepository;
  readonly inputRepository: ReputationInputRepository;
  readonly snapshotRepository: ReputationSnapshotRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/**
 * Validate the shared computation input shape (org scope, subject,
 * policy lineage, explicit referenceAt). Returns the normalized
 * reference timestamp.
 */
function validateComputationShape(
  input: ComputeReputationScoresInput,
): string {
  if (!input.organizationScopeId?.trim()) {
    throw new OpenConError({
      code: "REPUTATION_COMPUTATION",
      classification: "validation",
      message: "organizationScopeId is required",
      context: { field: "organizationScopeId" },
    });
  }
  if (!input.subjectPersonId?.trim()) {
    throw new OpenConError({
      code: "REPUTATION_COMPUTATION",
      classification: "validation",
      message: "subjectPersonId is required",
      context: { field: "subjectPersonId" },
    });
  }
  if (!input.policyId?.trim()) {
    throw new OpenConError({
      code: "REPUTATION_COMPUTATION",
      classification: "validation",
      message: "policyId is required (reputation is always computed against an explicit policy lineage)",
      context: { field: "policyId" },
    });
  }
  if (!input.referenceAt || Number.isNaN(Date.parse(input.referenceAt))) {
    throw new OpenConError({
      code: "REPUTATION_COMPUTATION",
      classification: "validation",
      message: `referenceAt must be a valid ISO-8601 timestamp (got ${String(input.referenceAt)}) — the decay reference is an EXPLICIT input so computations are deterministic`,
      context: { referenceAt: input.referenceAt },
    });
  }
  return input.referenceAt;
}

export function createReputationSnapshotService(
  deps: ReputationSnapshotServiceDeps,
): ReputationSnapshotService {
  const {
    policyRepository,
    inputRepository,
    snapshotRepository,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /**
   * Resolve the exact policy version for a computation. version
   * omitted → the lineage's LATEST version. The resolved record must
   * belong to the computation's organization scope.
   */
  async function resolvePolicy(
    input: ComputeReputationScoresInput,
  ): Promise<ReputationScoringPolicy> {
    let policy: ReputationScoringPolicy | null;
    if (input.version !== undefined) {
      if (!Number.isInteger(input.version) || input.version < 1) {
        throw new OpenConError({
          code: "REPUTATION_COMPUTATION",
          classification: "validation",
          message: `version must be a positive integer (got ${String(input.version)})`,
          context: { version: input.version },
        });
      }
      policy = await policyRepository.findVersion(input.policyId, input.version);
    } else {
      policy = await policyRepository.findLatestVersion(
        input.policyId,
        input.organizationScopeId,
      );
    }
    if (!policy) {
      throw new NotFoundError(
        `reputation scoring policy not found: ${input.policyId}${input.version !== undefined ? ` v${String(input.version)}` : " (latest)"}`,
        { policyId: input.policyId, version: input.version },
      );
    }
    if (policy.organizationScopeId !== input.organizationScopeId) {
      throw new OpenConError({
        code: "REPUTATION_COMPUTATION",
        classification: "validation",
        message: `policy lineage ${input.policyId} belongs to organization scope ${policy.organizationScopeId}, not ${input.organizationScopeId}`,
        context: {
          policyId: input.policyId,
          policyScope: policy.organizationScopeId,
          requestedScope: input.organizationScopeId,
        },
      });
    }
    return policy;
  }

  const service: ReputationSnapshotService = {
    async computeScores(execution, input) {
      // ---- Validation (pure) --------------------------------------------
      const referenceAt = validateComputationShape(input);

      // ---- Read-only projection (no persistence) ------------------------
      const policy = await resolvePolicy(input);
      const inputs = await inputRepository.listBySubject(
        input.organizationScopeId,
        input.subjectPersonId,
      );
      const rules: readonly ReputationScoringRule[] = policy.rules;
      const scores = computeDimensionScores(rules, inputs, referenceAt);
      const inputIds = includedInputIds(rules, inputs, referenceAt);
      const digest = computeScoresDigest(
        policy.policyId,
        policy.version,
        referenceAt,
        scores,
      );
      logger.debug("reputation.scores_computed", {
        subjectPersonId: input.subjectPersonId,
        policyId: policy.policyId,
        policyVersion: policy.version,
        includedInputs: inputIds.length,
        executionId: execution.executionId,
      });
      return {
        organizationScopeId: input.organizationScopeId,
        subjectPersonId: input.subjectPersonId,
        policyId: policy.policyId,
        policyVersion: policy.version,
        referenceAt,
        scores,
        inputIds,
        digest,
      };
    },

    async recordSnapshot(execution, input) {
      // ---- Validation (pure) --------------------------------------------
      const referenceAt = validateComputationShape(input);
      if (!input.idempotencyKey?.trim()) {
        throw new OpenConError({
          code: "REPUTATION_COMPUTATION",
          classification: "validation",
          message: "idempotencyKey is required",
          context: { field: "idempotencyKey" },
        });
      }

      // ---- Idempotent, atomic, audited snapshot append -------------------
      const key = `reputation_snapshot:${input.organizationScopeId}:${input.subjectPersonId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // Resolve the policy + inputs INSIDE the transaction so the
          // persisted snapshot is transaction-consistent (a concurrent
          // input append cannot produce a snapshot whose recorded
          // inputIds diverge from its scores).
          let policy: ReputationScoringPolicy;
          if (input.version !== undefined) {
            if (!Number.isInteger(input.version) || input.version < 1) {
              throw new OpenConError({
                code: "REPUTATION_COMPUTATION",
                classification: "validation",
                message: `version must be a positive integer (got ${String(input.version)})`,
                context: { version: input.version },
              });
            }
            const found = await policyRepository.findVersionWithinTx(
              input.policyId,
              input.version,
              tx,
            );
            if (!found) {
              throw new NotFoundError(
                `reputation scoring policy not found: ${input.policyId} v${String(input.version)}`,
                { policyId: input.policyId, version: input.version },
              );
            }
            policy = found;
          } else {
            const found = await policyRepository.findLatestVersionWithinTx(
              input.policyId,
              input.organizationScopeId,
              tx,
            );
            if (!found) {
              throw new NotFoundError(
                `reputation scoring policy not found: ${input.policyId} (latest)`,
                { policyId: input.policyId },
              );
            }
            policy = found;
          }
          if (policy.organizationScopeId !== input.organizationScopeId) {
            throw new OpenConError({
              code: "REPUTATION_COMPUTATION",
              classification: "validation",
              message: `policy lineage ${input.policyId} belongs to organization scope ${policy.organizationScopeId}, not ${input.organizationScopeId}`,
              context: {
                policyId: input.policyId,
                policyScope: policy.organizationScopeId,
                requestedScope: input.organizationScopeId,
              },
            });
          }
          const inputs = await inputRepository.listBySubjectWithinTx(
            input.organizationScopeId,
            input.subjectPersonId,
            tx,
          );
          const rules: readonly ReputationScoringRule[] = policy.rules;
          const scores = computeDimensionScores(rules, inputs, referenceAt);
          const inputIds = includedInputIds(rules, inputs, referenceAt);
          const digest = computeScoresDigest(
            policy.policyId,
            policy.version,
            referenceAt,
            scores,
          );
          const snapshot: ReputationSnapshot = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            subjectPersonId: input.subjectPersonId,
            policyId: policy.policyId,
            policyVersion: policy.version,
            referenceAt,
            computedAt: new Date().toISOString(),
            scores,
            inputIds,
            digest,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await snapshotRepository.createWithinTx(snapshot, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: SNAPSHOT_RECORDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: snapshot.id,
            resourceType: "reputation_snapshot",
            resourceId: snapshot.id,
            metadata: {
              subjectPersonId: snapshot.subjectPersonId,
              organizationScopeId: snapshot.organizationScopeId,
              policyId: snapshot.policyId,
              policyVersion: snapshot.policyVersion,
              referenceAt: snapshot.referenceAt,
              digest: snapshot.digest,
              inputCount: snapshot.inputIds.length,
              inputIds: snapshot.inputIds,
              scores: snapshot.scores.map(
                (s) => `${s.dimension}=${s.score.toFixed(6)}`,
              ),
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return snapshot;
        },
        execution,
      );
      logger.info("reputation_snapshot.recorded", {
        snapshotId: applied.result.id,
        subjectPersonId: applied.result.subjectPersonId,
        policyVersion: applied.result.policyVersion,
        created: applied.executed,
      });
      return { snapshot: applied.result, created: applied.executed };
    },

    async getSnapshot(_execution, id) {
      const found = await snapshotRepository.findById(id);
      if (!found) {
        throw new NotFoundError(`reputation snapshot not found: ${id}`, {
          snapshotId: id,
        });
      }
      return found;
    },

    async getSnapshotHistory(_execution, organizationScopeId, subjectPersonId) {
      return snapshotRepository.listBySubject(organizationScopeId, subjectPersonId);
    },

    async getLatestSnapshot(_execution, organizationScopeId, subjectPersonId) {
      const history = await snapshotRepository.listBySubject(
        organizationScopeId,
        subjectPersonId,
      );
      return history.length > 0 ? history[history.length - 1]! : null;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
