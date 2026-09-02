/**
 * ValidationPolicyService — domain service for the immutable, versioned
 * quorum policies (NET-W032 §3.5).
 *
 * Architecture ref: spec/architecture.md §12, §18 (module ownership:
 * /disputes owns the validation coordination incl. the versioned
 * quorum policy contract); spec/architecture-lock.md §3 (PostgreSQL
 * authoritative), §12 (execution lineage).
 *
 * Versioning rules — the FULL NET-W007/NET-W008/NET-W009/NET-W010
 * policy-lineage pattern:
 *  - a lineage starts at version 1; every subsequent create MUST name
 *    exactly latest+1 (monotonic — a lower version is a conflict, a
 *    higher version is rejected);
 *  - the (policyId, version) tuple is the idempotency key: retrying
 *    the same tuple replays the committed record; concurrent
 *    same-tuple creates are serialized by the idempotency store's
 *    per-key lock (exactly-one);
 *  - a (policyId, version) pair is unique — existing versions are
 *    NEVER rewritten (historical derivations stay reproducible,
 *    invariant 4);
 *  - all versions of a lineage share one organization scope (a
 *    lineage cannot be forked across scopes — checked on EVERY create
 *    INCLUDING version 1).
 *
 * LINEAGE SERIALIZATION: the idempotency key is ORG-SCOPED, so two
 * DIFFERENT organizations concurrently creating the same `policyId`
 * at version 1 would acquire DIFFERENT locks and could both read "no
 * existing lineage". The whole apply therefore runs under the
 * ORGANIZATION-INDEPENDENT lineage mutex
 * `validation_policy_lineage:{policyId}` on the idempotency store's
 * per-key mutex (the documented SELECT … FOR UPDATE stand-in;
 * single-process modular monolith, one runtime-wired store instance):
 *
 * ```text
 * lock(policyId)                    ← org-INDEPENDENT serialization
 *     ↓
 * applyIdempotent(org-scoped key)  ← opens the authoritative tx
 *     ├─ read lineage (within tx, org-independently)
 *     ├─ verify organizationScopeId
 *     ├─ verify version = latest + 1 (or 1 for a new lineage)
 *     ├─ create version (+ audit record)
 *     └─ commit (mutation + idempotency + audit atomically)
 * release(policyId)
 * ```
 *
 * Lock ordering is strictly lineage-mutex → idempotency-key-mutex
 * (never reversed), so no deadlock is possible.
 *
 * The policy SHAPE is validated by the PURE core
 * `validateValidationQuorumPolicyShape` (the frozen quorum contract:
 * count-based thresholds, bounded window, stake requirement — work
 * order §3.5 "represented by a versioned policy, not undocumented
 * constants").
 *
 * Atomicity: the policy record, its audit record
 * (`validation_policy.version_created`) and the idempotency record
 * commit in ONE authoritative transaction (NET-W004-AC-07; AUD-005).
 *
 * Tier compliance: disputes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import {
  ConflictError,
  NotFoundError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { validateValidationQuorumPolicyShape } from "../core/validation.ts";
import type {
  CreateValidationPolicyVersionInput,
  ValidationPolicyService,
  ValidationQuorumPolicy,
  ValidationPolicyRepository,
} from "./port.ts";

const POLICY_VERSION_CREATED = "validation_policy.version_created" as const;

export interface ValidationPolicyServiceDeps {
  readonly repository: ValidationPolicyRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createValidationPolicyService(
  deps: ValidationPolicyServiceDeps,
): ValidationPolicyService {
  const { repository, idempotency, auditWriter, logger } = deps;

  const service: ValidationPolicyService = {
    async createPolicyVersion(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "VALIDATION_POLICY_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.policyId?.trim()) {
        throw new OpenConError({
          code: "VALIDATION_POLICY_VALIDATION",
          classification: "validation",
          message: "policyId is required (the stable lineage id)",
          context: { field: "policyId" },
        });
      }
      if (!Number.isInteger(input.version) || input.version < 1) {
        throw new OpenConError({
          code: "VALIDATION_POLICY_VALIDATION",
          classification: "validation",
          message: `version must be a positive integer (got ${String(input.version)})`,
          context: { field: "version", version: input.version },
        });
      }
      const shape = validateValidationQuorumPolicyShape({
        assignmentCardinality: input.assignmentCardinality,
        minimumSubmitted: input.minimumSubmitted,
        upholdThreshold: input.upholdThreshold,
        rejectThreshold: input.rejectThreshold,
        challengeWindowMs: input.challengeWindowMs,
        validatorStakeRequirementCredits: input.validatorStakeRequirementCredits,
      });

      // ---- Idempotent, atomic, audited version append ------------------
      // LINEAGE LOCK: org-independent mutex serializes the whole apply
      // (see header doc). Lock ordering: lineage-mutex → idempotency
      // key-mutex, never reversed.
      const lineageLockKey = `validation_policy_lineage:${input.policyId}`;
      const key = `validation_policy:${input.organizationScopeId}:${input.policyId}:${String(input.version)}`;
      const applied = await idempotency.withLock(lineageLockKey, () =>
        idempotency.applyIdempotent(
          key,
          async (ctx) => {
            const tx = ctx.transaction;
            // Read the lineage ORGANIZATION-INDEPENDENTLY (the highest
            // version of this policyId in ANY scope). The lineage-scope
            // invariant applies to EVERY create — INCLUDING version 1.
            const lineage = await repository.findLatestVersionWithinTx(
              input.policyId,
              undefined,
              tx,
            );
            if (lineage) {
              if (lineage.organizationScopeId !== input.organizationScopeId) {
                throw new OpenConError({
                  code: "VALIDATION_POLICY_VALIDATION",
                  classification: "validation",
                  message: `validation policy lineage ${input.policyId} belongs to organization scope ${lineage.organizationScopeId}, not ${input.organizationScopeId}`,
                  context: {
                    policyId: input.policyId,
                    lineageScope: lineage.organizationScopeId,
                    requestedScope: input.organizationScopeId,
                  },
                });
              }
              if (input.version !== lineage.version + 1) {
                throw new ConflictError(
                  `validation policy lineage ${input.policyId} is at version ${String(lineage.version)}; the next version is ${String(lineage.version + 1)} (got ${String(input.version)})`,
                  {
                    policyId: input.policyId,
                    latestVersion: lineage.version,
                    requestedVersion: input.version,
                  },
                );
              }
            } else {
              if (input.version !== 1) {
                throw new ConflictError(
                  `validation policy lineage ${input.policyId} does not exist; a new lineage starts at version 1 (got ${String(input.version)})`,
                  { policyId: input.policyId, requestedVersion: input.version },
                );
              }
            }
            const record: ValidationQuorumPolicy = Object.freeze({
              id: randomUUID(),
              policyId: input.policyId,
              version: input.version,
              organizationScopeId: input.organizationScopeId,
              description: input.description?.trim() || null,
              assignmentCardinality: shape.assignmentCardinality,
              minimumSubmitted: shape.minimumSubmitted,
              upholdThreshold: shape.upholdThreshold,
              rejectThreshold: shape.rejectThreshold,
              challengeWindowMs: shape.challengeWindowMs,
              validatorStakeRequirementCredits:
                shape.validatorStakeRequirementCredits,
              createdBy: execution.actor?.id ?? "unknown",
              createdAt: new Date().toISOString(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await repository.createWithinTx(record, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: POLICY_VERSION_CREATED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: record.id,
              resourceType: "validation_policy",
              resourceId: record.id,
              metadata: {
                policyId: record.policyId,
                version: record.version,
                organizationScopeId: record.organizationScopeId,
                assignmentCardinality: record.assignmentCardinality,
                minimumSubmitted: record.minimumSubmitted,
                upholdThreshold: record.upholdThreshold,
                rejectThreshold: record.rejectThreshold,
                challengeWindowMs: record.challengeWindowMs,
                validatorStakeRequirementCredits:
                  record.validatorStakeRequirementCredits,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return record;
          },
          execution,
        ),
      );
      logger.info("validation_policy.version_created", {
        policyId: applied.result.policyId,
        version: applied.result.version,
      });
      return applied.result;
    },

    async getPolicyVersion(_execution, policyId, version) {
      const found = await repository.findVersion(policyId, version);
      if (!found) {
        throw new NotFoundError(
          `validation policy version not found: ${policyId} v${String(version)}`,
          { policyId, version },
        );
      }
      return found;
    },

    async listPolicyVersions(_execution, policyId, organizationScopeId) {
      return repository.listVersions(policyId, organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError, ConflictError };
