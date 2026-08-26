/**
 * RewardService — deterministic reward accounting (NET-W008 §3.5):
 * immutable versioned allocation policies + the deterministic split
 * of ONE MATURE source value record among beneficiaries.
 *
 * Architecture ref: spec/architecture.md §18 (/settlement owns reward
 * accounting within the economic ledger); spec/architecture-lock.md
 * §5 (economic authority owns reward calculations), §13 (economic
 * safety invariants), §12 (execution lineage).
 *
 * POLICY LINEAGE (the exact NET-W007 pattern, incl. the PR #14
 * remediation): all versions of a `policyId` share one organization
 * scope; the whole create — lineage read → scope check → version
 * check → create → commit — runs under the ORGANIZATION-INDEPENDENT
 * mutex `economic_reward_policy_lineage:{policyId}`
 * (IdempotencyStore.withLock — the store's per-key mutex, the
 * documented stand-in for PostgreSQL SELECT … FOR UPDATE row
 * locking), and the cross-scope check runs against the
 * org-independent lineage read on EVERY create (including version 1):
 * a lineage can never fork, even under concurrent cross-organization
 * creates.
 *
 * DETERMINISM (work order §3.5): shares are computed by the pure
 * computeRewardSplit in ledger.ts — floor-division in policy
 * declaration order with last-share remainder absorption, so
 * identical (source amount, policy version) ALWAYS produces the
 * identical split and Σ shares === source EXACTLY (conservation).
 *
 * Atomicity + concurrency: allocation is serialized per source value
 * record (`economic_value_record:{id}` — exactly-once consumption)
 * plus per-account locks (posting.ts); the allocation + postings +
 * audit + idempotency record commit in ONE authoritative transaction.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import { validateEconomicAmount } from "../core/economics.ts";
import type {
  AllocateRewardsInput,
  AllocateRewardsResult,
  CreateRewardPolicyInput,
  EconomicSubjectLookup,
  EconomicValueRepository,
  RewardAllocation,
  RewardAllocationPolicy,
  RewardAllocationPolicyRepository,
  RewardAllocationRepository,
  RewardPolicyService,
  RewardService,
  ReverseAllocationInput,
} from "./port.ts";
import { computeRewardSplit, economicAccountId, negatePostings } from "./ledger.ts";
import {
  postLedgerTransactionWithinTx,
  valueRecordLockKey,
  withEconomicLocks,
  type EconomicServiceDeps,
} from "./posting.ts";

const POLICY_CREATED = "reward_policy.version_created" as const;
const ALLOCATION_RECORDED = "reward_allocation.recorded" as const;
const ALLOCATION_REVERSED = "reward_allocation.reversed" as const;

const POLICY_VALIDATION = "REWARD_POLICY_VALIDATION" as const;
const VALIDATION = "ECONOMIC_VALIDATION" as const;

function policyValidationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({
    code: POLICY_VALIDATION,
    classification: "validation",
    message,
    context,
  });
}

function validationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({
    code: VALIDATION,
    classification: "validation",
    message,
    context,
  });
}

export interface RewardPolicyServiceDeps extends EconomicServiceDeps {
  readonly policyRepository: RewardAllocationPolicyRepository;
  readonly subjectLookup: EconomicSubjectLookup;
}

export function createRewardPolicyService(
  deps: RewardPolicyServiceDeps,
): RewardPolicyService {
  const { policyRepository, subjectLookup, idempotency, auditWriter, logger } = deps;

  const service: RewardPolicyService = {
    async createPolicyVersion(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw policyValidationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.policyId?.trim()) {
        throw policyValidationError("policyId is required", {
          field: "policyId",
        });
      }
      if (
        !Number.isInteger(input.version) ||
        input.version < 1
      ) {
        throw policyValidationError(
          `version must be a positive integer (got ${String(input.version)})`,
          { version: input.version },
        );
      }
      if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
        throw policyValidationError(
          "a reward policy requires at least one allocation entry",
          { allocationCount: Array.isArray(input.allocations) ? input.allocations.length : 0 },
        );
      }
      const seen = new Set<string>();
      for (const allocation of input.allocations) {
        if (!allocation.beneficiaryPersonId?.trim()) {
          throw policyValidationError(
            "each allocation entry requires a beneficiaryPersonId",
            { allocation },
          );
        }
        if (seen.has(allocation.beneficiaryPersonId)) {
          throw policyValidationError(
            `beneficiary ${allocation.beneficiaryPersonId} appears more than once in the allocation set`,
            { beneficiaryPersonId: allocation.beneficiaryPersonId },
          );
        }
        seen.add(allocation.beneficiaryPersonId);
        validateEconomicAmount("weight", allocation.weight);
        const exists = await subjectLookup.exists(allocation.beneficiaryPersonId);
        if (!exists) {
          throw new NotFoundError(
            `reward beneficiary person not found: ${allocation.beneficiaryPersonId}`,
            { beneficiaryPersonId: allocation.beneficiaryPersonId },
          );
        }
      }

      // ---- Lineage-serialized, idempotent, atomic create ---------------
      const key = `economic_reward_policy:${input.organizationScopeId}:${input.policyId}:${input.version}`;
      const applied = await idempotency.withLock(
        `economic_reward_policy_lineage:${input.policyId}`,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            // ORG-INDEPENDENT lineage read on EVERY create (incl. v1):
            // a lineage can never fork across organization scopes.
            const latest = await policyRepository.findLatestVersionWithinTx(
              input.policyId,
              undefined,
              tx,
            );
            if (latest) {
              if (latest.organizationScopeId !== input.organizationScopeId) {
                throw policyValidationError(
                  `reward policy lineage ${input.policyId} belongs to organization scope ${latest.organizationScopeId}, not ${input.organizationScopeId} — a policy lineage cannot fork across organization scopes`,
                  {
                    policyId: input.policyId,
                    lineageScope: latest.organizationScopeId,
                    inputScope: input.organizationScopeId,
                  },
                );
              }
              if (input.version !== latest.version + 1) {
                throw policyValidationError(
                  `reward policy ${input.policyId} is at version ${String(latest.version)} — the next version is exactly ${String(latest.version + 1)} (got ${String(input.version)})`,
                  {
                    policyId: input.policyId,
                    latestVersion: latest.version,
                    requestedVersion: input.version,
                  },
                );
              }
            } else if (input.version !== 1) {
              throw policyValidationError(
                `reward policy lineage ${input.policyId} does not exist — the first version must be 1 (got ${String(input.version)})`,
                { policyId: input.policyId, requestedVersion: input.version },
              );
            }
            const policy: RewardAllocationPolicy = Object.freeze({
              id: randomUUID(),
              policyId: input.policyId,
              version: input.version,
              organizationScopeId: input.organizationScopeId,
              description: input.description?.trim() || null,
              allocations: input.allocations.map((a) => ({
                beneficiaryPersonId: a.beneficiaryPersonId,
                weight: a.weight,
              })),
              createdBy: execution.actor?.id ?? "system",
              createdAt: new Date().toISOString(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await policyRepository.createWithinTx(policy, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: POLICY_CREATED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: policy.id,
              resourceType: "reward_policy",
              resourceId: policy.id,
              metadata: {
                policyId: policy.policyId,
                version: policy.version,
                organizationScopeId: policy.organizationScopeId,
                allocations: policy.allocations.map(
                  (a) => `${a.beneficiaryPersonId}:${String(a.weight)}`,
                ),
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return policy;
          }, execution),
      );
      logger.info("reward_policy.version_created", {
        policyId: applied.result.policyId,
        version: applied.result.version,
      });
      return applied.result;
    },

    async getPolicy(_execution, id) {
      const found = await policyRepository.findById(id);
      if (!found) {
        throw new NotFoundError(`reward policy not found: ${id}`, { policyId: id });
      }
      return found;
    },

    async getPolicyVersion(_execution, policyId, version) {
      const found = await policyRepository.findVersion(policyId, version);
      if (!found) {
        throw new NotFoundError(
          `reward policy version not found: ${policyId} v${String(version)}`,
          { policyId, version },
        );
      }
      return found;
    },

    async listPolicyVersions(_execution, policyId, organizationScopeId) {
      return policyRepository.listVersions(policyId, organizationScopeId);
    },
  };

  return service;
}

export interface RewardServiceDeps extends EconomicServiceDeps {
  readonly policyRepository: RewardAllocationPolicyRepository;
  readonly allocationRepository: RewardAllocationRepository;
  readonly valueRepository: EconomicValueRepository;
}

/** The account set an allocation posts to (lock set). */
function allocationAccountIds(
  organizationScopeId: string,
  sourceHolderPersonId: string,
  beneficiaries: readonly string[],
): string[] {
  return [
    economicAccountId(organizationScopeId, sourceHolderPersonId, "mature_value", "value"),
    ...beneficiaries.map((personId) =>
      economicAccountId(organizationScopeId, personId, "rewards", "value"),
    ),
  ];
}

export function createRewardService(deps: RewardServiceDeps): RewardService {
  const {
    policyRepository,
    allocationRepository,
    valueRepository,
    ledgerRepository,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  const service: RewardService = {
    async allocateRewards(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.sourceValueRecordId?.trim()) {
        throw validationError("sourceValueRecordId is required", {
          field: "sourceValueRecordId",
        });
      }
      if (!input.policyId?.trim()) {
        throw validationError("policyId is required", { field: "policyId" });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      // Resolve the policy version up front (committed read) and PIN it:
      // the in-tx load then reads the exact pinned version, so the lock
      // set below always covers the beneficiaries actually paid.
      const pinned =
        input.version !== undefined
          ? await policyRepository.findVersion(input.policyId, input.version)
          : await policyRepository.findLatestVersion(input.policyId, undefined);
      if (!pinned) {
        throw new NotFoundError(
          `reward policy not found: ${input.policyId}${input.version !== undefined ? ` v${String(input.version)}` : ""}`,
          { policyId: input.policyId, version: input.version },
        );
      }
      if (pinned.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `reward policy ${pinned.policyId} belongs to organization scope ${pinned.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            policyId: pinned.policyId,
            policyScope: pinned.organizationScopeId,
            inputScope: input.organizationScopeId,
          },
        );
      }
      const existingRecord = await valueRepository.findById(input.sourceValueRecordId);
      if (!existingRecord) {
        throw new NotFoundError(
          `source economic value record not found: ${input.sourceValueRecordId}`,
          { sourceValueRecordId: input.sourceValueRecordId },
        );
      }

      const key = `economic_reward_allocation:${input.organizationScopeId}:${input.sourceValueRecordId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        allocationAccountIds(
          input.organizationScopeId,
          existingRecord.beneficiaryPersonId,
          pinned.allocations.map((a) => a.beneficiaryPersonId),
        ),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            // Load the EXACT pinned policy version (immutable — cannot
            // drift between the pin and this read).
            const policy = await policyRepository.findVersionWithinTx(
              pinned.policyId,
              pinned.version,
              tx,
            );
            if (!policy) {
              throw new NotFoundError(
                `reward policy version not found: ${pinned.policyId} v${String(pinned.version)}`,
                { policyId: pinned.policyId, version: pinned.version },
              );
            }
            const record = await valueRepository.findByIdWithinTx(
              input.sourceValueRecordId,
              tx,
            );
            if (!record) {
              throw new NotFoundError(
                `source economic value record not found: ${input.sourceValueRecordId}`,
                { sourceValueRecordId: input.sourceValueRecordId },
              );
            }
            if (record.organizationScopeId !== input.organizationScopeId) {
              throw validationError(
                `source value record ${record.id} belongs to organization scope ${record.organizationScopeId}, not ${input.organizationScopeId}`,
                {
                  sourceValueRecordId: record.id,
                  recordScope: record.organizationScopeId,
                  inputScope: input.organizationScopeId,
                },
              );
            }
            if (record.state !== "MATURE") {
              throw validationError(
                `source value record ${record.id} is ${record.state}, not MATURE — ${record.state === "PENDING" ? "pending value cannot be consumed as mature value (architecture-lock invariant 19)" : "only mature value can fund reward allocations"}`,
                { sourceValueRecordId: record.id, state: record.state },
              );
            }
            // The deterministic split (pure; Σ shares === source exactly).
            const shares = computeRewardSplit(record.amount, policy.allocations);
            const allocationId = randomUUID();
            // THE ALLOCATION POSTINGS (balanced in the value unit):
            //   debit  mature_value(source holder)  sourceAmount
            //   credit rewards(beneficiary_i)       share_i   (per share)
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: record.organizationScopeId,
                kind: "reward_allocation",
                subject: { kind: "reward_allocation", id: allocationId },
                entries: [
                  {
                    accountId: economicAccountId(
                      record.organizationScopeId,
                      record.beneficiaryPersonId,
                      "mature_value",
                      "value",
                    ),
                    accountKind: "mature_value",
                    ownerPersonId: record.beneficiaryPersonId,
                    direction: "debit",
                    amount: record.amount,
                    unit: "value",
                  },
                  ...shares.map((share) => ({
                    accountId: economicAccountId(
                      record.organizationScopeId,
                      share.beneficiaryPersonId,
                      "rewards",
                      "value",
                    ),
                    accountKind: "rewards" as const,
                    ownerPersonId: share.beneficiaryPersonId,
                    direction: "credit" as const,
                    amount: share.amount,
                    unit: "value" as const,
                  })),
                ],
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const allocation: RewardAllocation = Object.freeze({
              id: allocationId,
              organizationScopeId: record.organizationScopeId,
              sourceValueRecordId: record.id,
              sourceValueAmount: record.amount,
              sourceBeneficiaryPersonId: record.beneficiaryPersonId,
              policyId: policy.policyId,
              policyVersion: policy.version,
              totalAllocated: record.amount,
              shares: shares.map((share, index) => ({
                beneficiaryPersonId: share.beneficiaryPersonId,
                amount: share.amount,
                weight: policy.allocations[index]!.weight,
              })),
              status: "allocated",
              reversal: null,
              transactionId: transaction.id,
              allocatedAt: new Date().toISOString(),
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await allocationRepository.createWithinTx(allocation, tx);
            // Consume the source record (exactly-once).
            const consumed = Object.freeze({
              ...record,
              state: "CONSUMED" as const,
              version: record.version + 1,
              consumedBy: { kind: "reward_allocation" as const, id: allocationId },
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await valueRepository.saveWithinTx(consumed, record.version, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: ALLOCATION_RECORDED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: allocation.id,
              resourceType: "reward_allocation",
              resourceId: allocation.id,
              metadata: {
                organizationScopeId: allocation.organizationScopeId,
                sourceValueRecordId: allocation.sourceValueRecordId,
                sourceValueAmount: allocation.sourceValueAmount,
                policyId: allocation.policyId,
                policyVersion: allocation.policyVersion,
                shares: allocation.shares.map(
                  (s) => `${s.beneficiaryPersonId}:${String(s.amount)}`,
                ),
                idempotencyKey: allocation.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return allocation;
          }, execution),
        valueRecordLockKey(input.sourceValueRecordId),
      );
      logger.info("reward_allocation.recorded", {
        allocationId: applied.result.id,
        policyId: applied.result.policyId,
        policyVersion: applied.result.policyVersion,
        created: applied.executed,
      });
      return { allocation: applied.result, created: applied.executed };
    },

    async reverseAllocation(execution, input) {
      if (!input.allocationId?.trim()) {
        throw validationError("allocationId is required", {
          field: "allocationId",
        });
      }
      if (!input.reason?.trim()) {
        throw validationError("a reversal requires a reason", { field: "reason" });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      const existing = await allocationRepository.findById(input.allocationId);
      if (!existing) {
        throw new NotFoundError(`reward allocation not found: ${input.allocationId}`, {
          allocationId: input.allocationId,
        });
      }
      const key = `economic_allocation_reversal:${input.allocationId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        allocationAccountIds(
          existing.organizationScopeId,
          existing.sourceBeneficiaryPersonId,
          existing.shares.map((s) => s.beneficiaryPersonId),
        ),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const allocation = await allocationRepository.findByIdWithinTx(
              input.allocationId,
              tx,
            );
            if (!allocation) {
              throw new NotFoundError(
                `reward allocation not found: ${input.allocationId}`,
                { allocationId: input.allocationId },
              );
            }
            if (allocation.status !== "allocated") {
              throw validationError(
                `reward allocation ${allocation.id} is already ${allocation.status}`,
                { allocationId: allocation.id, status: allocation.status },
              );
            }
            const record = await valueRepository.findByIdWithinTx(
              allocation.sourceValueRecordId,
              tx,
            );
            if (!record || record.state !== "CONSUMED") {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `source value record ${allocation.sourceValueRecordId} for allocation ${allocation.id} is not CONSUMED — the ledger is inconsistent`,
                context: { allocationId: allocation.id },
              });
            }
            // Negate the ORIGINAL allocation postings; the per-beneficiary
            // rewards balance checks inside the posting layer reject the
            // reversal when a beneficiary no longer holds the rewards
            // (conservation).
            const original = await ledgerRepository.findTransaction(
              allocation.transactionId,
            );
            if (!original) {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `original ledger transaction ${allocation.transactionId} for allocation ${allocation.id} not found — the ledger is incomplete`,
                context: { ledgerTransactionId: allocation.transactionId },
              });
            }
            const negated = negatePostings(original.entries);
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: allocation.organizationScopeId,
                kind: "reversal",
                description: `reversal of reward allocation ${allocation.id}: ${input.reason.trim()}`,
                subject: { kind: "reward_allocation", id: allocation.id },
                entries: negated,
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: RewardAllocation = Object.freeze({
              ...allocation,
              status: "reversed",
              reversal: {
                reversedAt: new Date().toISOString(),
                reason: input.reason.trim(),
                transactionId: transaction.id,
              },
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await allocationRepository.saveWithinTx(updated, tx);
            // Restore the source record to MATURE (unconsumed).
            const restored = Object.freeze({
              ...record,
              state: "MATURE" as const,
              version: record.version + 1,
              consumedBy: null,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await valueRepository.saveWithinTx(restored, record.version, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: ALLOCATION_REVERSED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "reward_allocation",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                sourceValueRecordId: updated.sourceValueRecordId,
                policyId: updated.policyId,
                policyVersion: updated.policyVersion,
                reason: input.reason.trim(),
                reversedTransaction: allocation.transactionId,
                idempotencyKey: input.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return updated;
          }, execution),
        valueRecordLockKey(existing.sourceValueRecordId),
      );
      logger.info("reward_allocation.reversed", {
        allocationId: applied.result.id,
      });
      return applied.result;
    },

    async getAllocation(_execution, id) {
      const found = await allocationRepository.findById(id);
      if (!found) {
        throw new NotFoundError(`reward allocation not found: ${id}`, {
          allocationId: id,
        });
      }
      return found;
    },

    async listAllocations(_execution, organizationScopeId) {
      return allocationRepository.listByOrganization(organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  AllocateRewardsInput,
  AllocateRewardsResult,
  CreateRewardPolicyInput,
  ExecutionContext,
  RewardPolicyService,
  ReverseAllocationInput,
};
