/**
 * RiskPolicyService — domain service for the immutable, versioned
 * deterministic risk policies (NET-W009 §3.3).
 *
 * Architecture ref: spec/architecture.md §12 (fraud detection
 * combines multiple signals — the policy decides how they combine),
 * §19; spec/architecture-lock.md §3 (PostgreSQL authoritative),
 * §12 (execution lineage).
 *
 * Versioning rules — the FULL NET-W007/NET-W008 policy-lineage
 * pattern (including the PR #14 remediation semantics):
 *  - a lineage starts at version 1; every subsequent create MUST name
 *    exactly latest+1 (monotonic — a lower version is a conflict, a
 *    higher version is rejected);
 *  - the (policyId, version) tuple is the idempotency key: retrying
 *    the same tuple replays the committed record; concurrent
 *    same-tuple creates are serialized by the idempotency store's
 *    per-key lock (exactly-one);
 *  - a (policyId, version) pair is unique — existing versions are
 *    NEVER rewritten (historical assessments stay reproducible,
 *    invariant 4);
 *  - all versions of a lineage share one organization scope (a
 *    lineage cannot be forked across scopes — checked on EVERY create
 *    INCLUDING version 1).
 *
 * LINEAGE SERIALIZATION: the idempotency key is ORG-SCOPED, so two
 * DIFFERENT organizations concurrently creating the same `policyId`
 * at version 1 would acquire DIFFERENT locks and could both read "no
 * existing lineage". The whole apply therefore runs under the
 * ORGANIZATION-INDEPENDENT lineage mutex `risk_policy_lineage:{policyId}`
 * on the idempotency store's per-key mutex (the documented
 * SELECT … FOR UPDATE stand-in; single-process modular monolith, one
 * runtime-wired store instance):
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
 * Atomicity: the policy record, its audit record
 * (`risk_policy.version_created`) and the idempotency record commit
 * in ONE authoritative transaction (NET-W004-AC-07; AUD-005).
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
import {
  validateRiskPolicyShape,
  type RiskEvaluationRule,
  type RiskSignalCategory,
  type RiskState,
  type RiskStateThresholds,
} from "../core/risk.ts";
import type {
  CreateRiskPolicyInput,
  RiskPolicy,
  RiskPolicyRepository,
  RiskPolicyService,
} from "./port.ts";

const POLICY_VERSION_CREATED = "risk_policy.version_created" as const;

export interface RiskPolicyServiceDeps {
  readonly repository: RiskPolicyRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

/** Normalize + validate the raw policy input through the core validator. */
function normalizeShape(input: CreateRiskPolicyInput): {
  rules: readonly RiskEvaluationRule[];
  thresholds: RiskStateThresholds;
  criticalFloorState: RiskState;
  advisoryOnlyCapState: RiskState;
  requiredCategories: readonly RiskSignalCategory[];
  missingDataState: RiskState;
} {
  return validateRiskPolicyShape({
    rules: input.rules.map((r) => ({
      category: r.category,
      weight: r.weight,
      advisoryWeightFactor: r.advisoryWeightFactor,
      severityPoints: r.severityPoints,
    })),
    thresholds: input.thresholds,
    criticalFloorState: input.criticalFloorState,
    advisoryOnlyCapState: input.advisoryOnlyCapState,
    requiredCategories: input.requiredCategories,
    missingDataState: input.missingDataState,
  });
}

export function createRiskPolicyService(
  deps: RiskPolicyServiceDeps,
): RiskPolicyService {
  const { repository, idempotency, auditWriter, logger } = deps;

  const service: RiskPolicyService = {
    async createPolicyVersion(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "RISK_POLICY_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.policyId?.trim()) {
        throw new OpenConError({
          code: "RISK_POLICY_VALIDATION",
          classification: "validation",
          message: "policyId is required (the stable lineage id)",
          context: { field: "policyId" },
        });
      }
      if (!Number.isInteger(input.version) || input.version < 1) {
        throw new OpenConError({
          code: "RISK_POLICY_VALIDATION",
          classification: "validation",
          message: `version must be a positive integer (got ${String(input.version)})`,
          context: { field: "version", version: input.version },
        });
      }
      const shape = normalizeShape(input);

      // ---- Idempotent, atomic, audited version append ------------------
      // LINEAGE LOCK: org-independent mutex serializes the whole apply
      // (see header doc). Lock ordering: lineage-mutex → idempotency
      // key-mutex, never reversed.
      const lineageLockKey = `risk_policy_lineage:${input.policyId}`;
      const key = `risk_policy:${input.organizationScopeId}:${input.policyId}:${String(input.version)}`;
      const applied = await idempotency.withLock(lineageLockKey, () =>
        idempotency.applyIdempotent(
          key,
          async (ctx) => {
            const tx = ctx.transaction;
            // Read the lineage ORGANIZATION-INDEPENDENTLY (the highest
            // version of this policyId in ANY scope). The lineage-scope
            // invariant applies to EVERY create — INCLUDING version 1
            // (organization B must not fork a lineage organization A
            // already owns).
            const lineage = await repository.findLatestVersionWithinTx(
              input.policyId,
              undefined,
              tx,
            );
            if (lineage) {
              if (lineage.organizationScopeId !== input.organizationScopeId) {
                throw new OpenConError({
                  code: "RISK_POLICY_VALIDATION",
                  classification: "validation",
                  message: `policy lineage ${input.policyId} belongs to organization scope ${lineage.organizationScopeId}, not ${input.organizationScopeId}`,
                  context: {
                    policyId: input.policyId,
                    lineageScope: lineage.organizationScopeId,
                    requestedScope: input.organizationScopeId,
                  },
                });
              }
              if (input.version !== lineage.version + 1) {
                throw new ConflictError(
                  `policy lineage ${input.policyId} is at version ${String(lineage.version)}; the next version is ${String(lineage.version + 1)} (got ${String(input.version)})`,
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
                  `policy lineage ${input.policyId} does not exist; a new lineage starts at version 1 (got ${String(input.version)})`,
                  { policyId: input.policyId, requestedVersion: input.version },
                );
              }
            }
            const record: RiskPolicy = Object.freeze({
              id: randomUUID(),
              policyId: input.policyId,
              version: input.version,
              organizationScopeId: input.organizationScopeId,
              description: input.description?.trim() || null,
              rules: shape.rules,
              thresholds: shape.thresholds,
              criticalFloorState: shape.criticalFloorState,
              advisoryOnlyCapState: shape.advisoryOnlyCapState,
              requiredCategories: shape.requiredCategories,
              missingDataState: shape.missingDataState,
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
              resourceType: "risk_policy",
              resourceId: record.id,
              metadata: {
                policyId: record.policyId,
                version: record.version,
                organizationScopeId: record.organizationScopeId,
                categories: record.rules.map((r) => r.category),
                requiredCategories: record.requiredCategories,
                missingDataState: record.missingDataState,
                advisoryOnlyCapState: record.advisoryOnlyCapState,
                criticalFloorState: record.criticalFloorState,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return record;
          },
          execution,
        ),
      );
      logger.info("risk_policy.version_created", {
        policyId: applied.result.policyId,
        version: applied.result.version,
        created: applied.executed,
      });
      return applied.result;
    },

    async getPolicy(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`risk policy not found: ${id}`, {
          policyRecordId: id,
        });
      }
      return found;
    },

    async getPolicyVersion(_execution, policyId, version) {
      const found = await repository.findVersion(policyId, version);
      if (!found) {
        throw new NotFoundError(
          `risk policy version not found: ${policyId} v${String(version)}`,
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
