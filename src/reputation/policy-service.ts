/**
 * ReputationPolicyService — domain service for the immutable,
 * versioned deterministic scoring policies (NET-W007 §3.3).
 *
 * Architecture ref: spec/architecture.md §11 (multidimensional
 * reputation), §19; spec/architecture-lock.md §3 (PostgreSQL
 * authoritative), §12 (execution lineage).
 *
 * Versioning rules (work order §3.3 / §4 invariant 2):
 *  - a lineage starts at version 1; every subsequent create MUST name
 *    exactly latest+1 (monotonic — a lower version is a conflict, a
 *    higher version is rejected);
 *  - the (policyId, version) tuple is the idempotency key: retrying
 *    the same tuple replays the committed record (created=false);
 *    concurrent same-tuple creates are serialized by the idempotency
 *    store's per-key lock (exactly-one);
 *  - a (policyId, version) pair is unique — existing versions are
 *    NEVER rewritten (historical snapshots stay reproducible);
 *  - all versions of a lineage share one organization scope (a lineage
 *    cannot be forked across scopes).
 *
 * Rule-set validation (work order §3.1): exactly one rule per
 * dimension — ALL eight (a partial policy would silently zero the
 * unlisted dimensions); every rule validated by the core validator
 * (deterministic parameters only).
 *
 * Atomicity: the policy record, its audit record
 * (`reputation_policy.version_created`) and the idempotency record
 * commit in ONE authoritative transaction (IdempotencyStore.apply
 * opens the tx — the same NET-W004 primitive the workflow service
 * uses; AUD-004 reputation lineage).
 *
 * Tier compliance: reputation domain → self + core contracts only.
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
  REPUTATION_DIMENSIONS,
  isReputationDimension,
  validateReputationScoringRule,
  type ReputationScoringRule,
} from "../core/reputation.ts";
import type {
  CreateReputationScoringPolicyInput,
  ReputationPolicyService,
  ReputationScoringPolicy,
  ReputationScoringPolicyRepository,
} from "./port.ts";

const POLICY_VERSION_CREATED = "reputation_policy.version_created" as const;

export interface ReputationPolicyServiceDeps {
  readonly repository: ReputationScoringPolicyRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

export function createReputationPolicyService(
  deps: ReputationPolicyServiceDeps,
): ReputationPolicyService {
  const { repository, idempotency, auditWriter, logger } = deps;

  /**
   * Normalize + validate the raw rule input into the canonical rule
   * set: exactly one rule per dimension (all eight), canonical order =
   * the frozen dimension vocabulary (deterministic serialization).
   */
  function normalizeRules(
    raw: CreateReputationScoringPolicyInput["rules"],
  ): readonly ReputationScoringRule[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new OpenConError({
        code: "REPUTATION_POLICY_VALIDATION",
        classification: "validation",
        message: "a scoring policy requires a non-empty rules array",
        context: { ruleCount: Array.isArray(raw) ? raw.length : 0 },
      });
    }
    const byDimension = new Map<string, CreateReputationScoringPolicyInput["rules"][number]>();
    for (const rule of raw) {
      if (!rule || typeof rule !== "object") {
        throw new OpenConError({
          code: "REPUTATION_POLICY_VALIDATION",
          classification: "validation",
          message: "each scoring rule must be an object",
          context: { rule },
        });
      }
      if (!isReputationDimension(rule.dimension)) {
        throw new OpenConError({
          code: "REPUTATION_POLICY_VALIDATION",
          classification: "validation",
          message: `scoring rule dimension must be one of the standard reputation dimensions (got ${String(rule.dimension)})`,
          context: { dimension: rule.dimension },
        });
      }
      if (byDimension.has(rule.dimension)) {
        throw new OpenConError({
          code: "REPUTATION_POLICY_VALIDATION",
          classification: "validation",
          message: `scoring policy carries more than one rule for dimension ${rule.dimension}`,
          context: { dimension: rule.dimension },
        });
      }
      byDimension.set(rule.dimension, rule);
    }
    const missing = REPUTATION_DIMENSIONS.filter((d) => !byDimension.has(d));
    if (missing.length > 0) {
      throw new OpenConError({
        code: "REPUTATION_POLICY_VALIDATION",
        classification: "validation",
        message: `a scoring policy requires exactly one rule per dimension; missing: ${missing.join(", ")}`,
        context: { missingDimensions: missing },
      });
    }
    return REPUTATION_DIMENSIONS.map((dimension) => {
      const rule = byDimension.get(dimension)!;
      return validateReputationScoringRule({
        dimension,
        inputWeight: rule.inputWeight,
        decayHalfLifeDays: rule.decayHalfLifeDays,
        maxScore: rule.maxScore,
        indicatedWeightFactor: rule.indicatedWeightFactor,
        indicatedOnlyCap: rule.indicatedOnlyCap,
      });
    });
  }

  const service: ReputationPolicyService = {
    async createPolicyVersion(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "REPUTATION_POLICY_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.policyId?.trim()) {
        throw new OpenConError({
          code: "REPUTATION_POLICY_VALIDATION",
          classification: "validation",
          message: "policyId is required (the stable lineage id)",
          context: { field: "policyId" },
        });
      }
      if (
        !Number.isInteger(input.version) ||
        input.version < 1
      ) {
        throw new OpenConError({
          code: "REPUTATION_POLICY_VALIDATION",
          classification: "validation",
          message: `version must be a positive integer (got ${String(input.version)})`,
          context: { field: "version", version: input.version },
        });
      }
      const rules = normalizeRules(input.rules);

      // ---- Idempotent, atomic, audited version append ------------------
      // Key = the (policyId, version) tuple: retrying the same tuple
      // replays the committed record; concurrent same-tuple creates are
      // serialized by the idempotency store's per-key lock.
      const key = `reputation_policy:${input.organizationScopeId}:${input.policyId}:${String(input.version)}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const latest = await repository.findLatestVersionWithinTx(
            input.policyId,
            input.organizationScopeId,
            tx,
          );
          if (latest) {
            if (input.version !== latest.version + 1) {
              throw new ConflictError(
                `policy lineage ${input.policyId} is at version ${String(latest.version)}; the next version is ${String(latest.version + 1)} (got ${String(input.version)})`,
                {
                  policyId: input.policyId,
                  latestVersion: latest.version,
                  requestedVersion: input.version,
                },
              );
            }
          } else {
            // No version of this lineage exists in the requested scope.
            if (input.version !== 1) {
              // Either the lineage lives in ANOTHER organization scope
              // (cannot be forked across scopes) or it never existed
              // (cannot start at version > 1).
              const anywhere = await repository.findLatestVersionWithinTx(
                input.policyId,
                undefined,
                tx,
              );
              if (anywhere) {
                throw new OpenConError({
                  code: "REPUTATION_POLICY_VALIDATION",
                  classification: "validation",
                  message: `policy lineage ${input.policyId} belongs to organization scope ${anywhere.organizationScopeId}, not ${input.organizationScopeId}`,
                  context: {
                    policyId: input.policyId,
                    lineageScope: anywhere.organizationScopeId,
                    requestedScope: input.organizationScopeId,
                  },
                });
              }
              throw new ConflictError(
                `policy lineage ${input.policyId} does not exist; a new lineage starts at version 1 (got ${String(input.version)})`,
                { policyId: input.policyId, requestedVersion: input.version },
              );
            }
          }
          const record: ReputationScoringPolicy = Object.freeze({
            id: randomUUID(),
            policyId: input.policyId,
            version: input.version,
            organizationScopeId: input.organizationScopeId,
            description: input.description?.trim() || null,
            rules,
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
            resourceType: "reputation_scoring_policy",
            resourceId: record.id,
            metadata: {
              policyId: record.policyId,
              version: record.version,
              organizationScopeId: record.organizationScopeId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
              dimensions: record.rules.map((r) => r.dimension),
            },
          });
          return record;
        },
        execution,
      );
      logger.info("reputation_policy.version_created", {
        policyId: applied.result.policyId,
        version: applied.result.version,
        created: applied.executed,
      });
      return applied.result;
    },

    async getPolicy(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`reputation scoring policy not found: ${id}`, {
          policyRecordId: id,
        });
      }
      return found;
    },

    async getPolicyVersion(_execution, policyId, version) {
      const found = await repository.findVersion(policyId, version);
      if (!found) {
        throw new NotFoundError(
          `reputation scoring policy version not found: ${policyId} v${String(version)}`,
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
