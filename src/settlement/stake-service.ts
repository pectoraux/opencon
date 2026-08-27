/**
 * StakeService — challenge participation stake escrow (NET-W010 §3.2).
 *
 * Architecture ref: spec/architecture.md §18 (module ownership:
 * /settlement owns credits and all economic accounting), §19;
 * spec/architecture-lock.md §5 (economic authority — the economic
 * engine owns Credits, pending value, matured value, reward
 * calculations and settlement records), §13 (economic safety
 * invariants 19–21; invariant 21 — a disputed claim cannot mature
 * until the applicable resolution policy permits it, and the STAKE
 * that makes a challenge formal is economic state, so it lives HERE).
 *
 * THE GATE (work order §2): the disputes boundary owns the challenge
 * and review DECISIONS; THIS service owns the money-like accounting of
 * the stake. The /disputes domain never posts, never mutates balances
 * — the composition root orchestrates: dispute record first (or the
 * bonding step), then the explicit stake command here, with compound
 * idempotency keys (the NET-W009 applyWorkflowHold precedent).
 *
 * THE POSTINGS (balanced per unit — conservation is mechanical):
 *
 * ```text
 * commit:  debit  credits(owner)       amount    credit stake_escrow(owner)    amount
 * release: debit  stake_escrow(owner)  amount    credit credits(owner)        amount
 * forfeit: debit  stake_escrow(owner)  amount    credit protocol(credits)     amount
 * ```
 *
 * The posting layer's per-account non-negative guard rejects an
 * over-commitment (committing more credits than the owner holds) and
 * every release/forfeit is balance-checked against the escrow — no
 * value or credits can be created or destroyed by staking.
 *
 * Concurrency: the purpose lock (`economic_stake_purpose:{kind}:{id}`)
 * serializes commits for one purpose (exactly one COMMITTED stake per
 * purpose); the record lock (`economic_stake_record:{id}`) serializes
 * the release/forfeit state flip; account locks follow the posting
 * layer's global ordering (deadlock-free).
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import {
  isEconomicStakePurposeKind,
  validateEconomicAmount,
} from "../core/economics.ts";
import type {
  CommitStakeInput,
  CommitStakeResult,
  EconomicStake,
  EconomicStakeRepository,
  EconomicSubjectLookup,
  ForfeitStakeInput,
  ReleaseStakeInput,
  StakeService,
} from "./port.ts";
import { economicAccountId } from "./ledger.ts";
import {
  postLedgerTransactionWithinTx,
  withEconomicLocks,
  type EconomicServiceDeps,
} from "./posting.ts";

const STAKE_COMMITTED = "stake.committed" as const;
const STAKE_RELEASED = "stake.released" as const;
const STAKE_FORFEITED = "stake.forfeited" as const;

const VALIDATION = "ECONOMIC_VALIDATION" as const;

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

/** The per-record serialization lock key for a stake. */
function stakeRecordLockKey(stakeId: string): string {
  return `economic_stake_record:${stakeId}`;
}

/** The per-purpose serialization lock key (one committed stake per purpose). */
function stakePurposeLockKey(purposeKind: string, purposeId: string): string {
  return `economic_stake_purpose:${purposeKind}:${purposeId}`;
}

/** The account set a stake posts to (lock set). */
function stakeAccountIds(
  organizationScopeId: string,
  ownerPersonId: string,
  includeProtocol: boolean,
): string[] {
  const ids = [
    economicAccountId(organizationScopeId, ownerPersonId, "credits", "credits"),
    economicAccountId(
      organizationScopeId,
      ownerPersonId,
      "stake_escrow",
      "credits",
    ),
  ];
  if (includeProtocol) {
    ids.push(
      economicAccountId(
        organizationScopeId,
        null,
        "protocol_recognition",
        "credits",
      ),
    );
  }
  return ids;
}

export interface StakeServiceDeps extends EconomicServiceDeps {
  readonly stakeRepository: EconomicStakeRepository;
  readonly subjectLookup: EconomicSubjectLookup;
}

export function createStakeService(deps: StakeServiceDeps): StakeService {
  const { stakeRepository, subjectLookup, ledgerRepository, idempotency, auditWriter, logger } =
    deps;

  const service: StakeService = {
    async commitStake(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.ownerPersonId?.trim()) {
        throw validationError("ownerPersonId is required", {
          field: "ownerPersonId",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      validateEconomicAmount("amount", input.amount);
      if (
        !input.purpose ||
        typeof input.purpose !== "object" ||
        !isEconomicStakePurposeKind(input.purpose.kind) ||
        typeof input.purpose.id !== "string" ||
        !input.purpose.id.trim()
      ) {
        throw validationError(
          `purpose must be one of the stake purpose kinds with a non-empty id (got ${String(input.purpose?.kind)})`,
          { purpose: input.purpose },
        );
      }
      // Narrowed consts BEFORE the idempotent closure (type-narrowing
      // does not cross into callbacks).
      const purpose = {
        kind: input.purpose.kind,
        id: input.purpose.id,
      } as const;
      const ownerExists = await subjectLookup.exists(input.ownerPersonId);
      if (!ownerExists) {
        throw new NotFoundError(
          `stake owner person not found: ${input.ownerPersonId}`,
          { ownerPersonId: input.ownerPersonId },
        );
      }

      const key = `economic_stake_commit:${input.organizationScopeId}:${input.ownerPersonId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        stakeAccountIds(input.organizationScopeId, input.ownerPersonId, false),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              // One COMMITTED stake per purpose (serialized by the
              // purpose lock acquired below — see the call site).
              const forPurpose = await stakeRepository.findByPurposeWithinTx(
                input.organizationScopeId,
                purpose.kind,
                purpose.id,
                tx,
              );
              if (forPurpose.some((s) => s.state === "COMMITTED")) {
                throw new ConflictError(
                  `purpose ${purpose.kind}:${purpose.id} already carries a COMMITTED stake (${forPurpose.find((s) => s.state === "COMMITTED")!.id})`,
                  {
                    purposeKind: purpose.kind,
                    purposeId: purpose.id,
                  },
                );
              }
              const stakeId = randomUUID();
              const transaction = await postLedgerTransactionWithinTx(
                tx,
                execution,
                {
                  organizationScopeId: input.organizationScopeId,
                  kind: "stake_commit",
                  description:
                    input.description?.trim() ||
                    `stake commitment for ${purpose.kind}:${purpose.id}`,
                  subject: { kind: "stake", id: stakeId },
                  entries: [
                    {
                      accountId: economicAccountId(
                        input.organizationScopeId,
                        input.ownerPersonId,
                        "credits",
                        "credits",
                      ),
                      accountKind: "credits",
                      ownerPersonId: input.ownerPersonId,
                      direction: "debit",
                      amount: input.amount,
                      unit: "credits",
                    },
                    {
                      accountId: economicAccountId(
                        input.organizationScopeId,
                        input.ownerPersonId,
                        "stake_escrow",
                        "credits",
                      ),
                      accountKind: "stake_escrow",
                      ownerPersonId: input.ownerPersonId,
                      direction: "credit",
                      amount: input.amount,
                      unit: "credits",
                    },
                  ],
                  idempotencyKey: input.idempotencyKey,
                },
                ledgerRepository,
              );
              const stake: EconomicStake = Object.freeze({
                id: stakeId,
                organizationScopeId: input.organizationScopeId,
                ownerPersonId: input.ownerPersonId,
                amount: input.amount,
                unit: "credits",
                state: "COMMITTED",
                purpose: { kind: purpose.kind, id: purpose.id },
                committedAt: new Date().toISOString(),
                outcome: null,
                transactionId: transaction.id,
                description: input.description?.trim() || null,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await stakeRepository.createWithinTx(stake, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: STAKE_COMMITTED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: stake.id,
                resourceType: "stake",
                resourceId: stake.id,
                metadata: {
                  organizationScopeId: stake.organizationScopeId,
                  ownerPersonId: stake.ownerPersonId,
                  amount: stake.amount,
                  unit: stake.unit,
                  purposeKind: stake.purpose.kind,
                  purposeId: stake.purpose.id,
                  idempotencyKey: stake.idempotencyKey,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                  ledgerTransactionId: transaction.id,
                },
              });
              return stake;
            },
            execution,
          ),
        stakePurposeLockKey(input.purpose.kind, input.purpose.id),
      );
      logger.info("stake.committed", {
        stakeId: applied.result.id,
        amount: applied.result.amount,
        created: applied.executed,
      });
      return { stake: applied.result, created: applied.executed };
    },

    async releaseStake(execution, input) {
      if (!input.stakeId?.trim()) {
        throw validationError("stakeId is required", { field: "stakeId" });
      }
      if (!input.reason?.trim()) {
        throw validationError("a stake release requires a reason", {
          field: "reason",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      const existing = await stakeRepository.findById(input.stakeId);
      if (!existing) {
        throw new NotFoundError(`stake not found: ${input.stakeId}`, {
          stakeId: input.stakeId,
        });
      }
      if (existing.state !== "COMMITTED") {
        throw validationError(
          `stake ${existing.id} is ${existing.state}, not COMMITTED — only a committed stake can be released`,
          { stakeId: existing.id, state: existing.state },
        );
      }
      const key = `economic_stake_release:${input.stakeId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        stakeAccountIds(
          existing.organizationScopeId,
          existing.ownerPersonId,
          false,
        ),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const stake = await stakeRepository.findByIdWithinTx(
                input.stakeId,
                tx,
              );
              if (!stake) {
                throw new NotFoundError(`stake not found: ${input.stakeId}`, {
                  stakeId: input.stakeId,
                });
              }
              if (stake.state !== "COMMITTED") {
                throw new ConflictError(
                  `stake ${stake.id} is already ${stake.state}`,
                  { stakeId: stake.id, state: stake.state },
                );
              }
              const transaction = await postLedgerTransactionWithinTx(
                tx,
                execution,
                {
                  organizationScopeId: stake.organizationScopeId,
                  kind: "stake_release",
                  description: `release of stake ${stake.id}: ${input.reason.trim()}`,
                  subject: { kind: "stake", id: stake.id },
                  entries: [
                    {
                      accountId: economicAccountId(
                        stake.organizationScopeId,
                        stake.ownerPersonId,
                        "stake_escrow",
                        "credits",
                      ),
                      accountKind: "stake_escrow",
                      ownerPersonId: stake.ownerPersonId,
                      direction: "debit",
                      amount: stake.amount,
                      unit: "credits",
                    },
                    {
                      accountId: economicAccountId(
                        stake.organizationScopeId,
                        stake.ownerPersonId,
                        "credits",
                        "credits",
                      ),
                      accountKind: "credits",
                      ownerPersonId: stake.ownerPersonId,
                      direction: "credit",
                      amount: stake.amount,
                      unit: "credits",
                    },
                  ],
                  idempotencyKey: input.idempotencyKey,
                },
                ledgerRepository,
              );
              const updated: EconomicStake = Object.freeze({
                ...stake,
                state: "RELEASED",
                outcome: {
                  disposition: "RELEASED" as const,
                  reason: input.reason.trim(),
                  outcomeAt: new Date().toISOString(),
                  transactionId: transaction.id,
                },
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await stakeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: STAKE_RELEASED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: updated.id,
                resourceType: "stake",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  ownerPersonId: updated.ownerPersonId,
                  amount: updated.amount,
                  reason: input.reason.trim(),
                  purposeKind: updated.purpose.kind,
                  purposeId: updated.purpose.id,
                  idempotencyKey: input.idempotencyKey,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                  ledgerTransactionId: transaction.id,
                },
              });
              return updated;
            },
            execution,
          ),
        stakeRecordLockKey(input.stakeId),
      );
      logger.info("stake.released", { stakeId: applied.result.id });
      return applied.result;
    },

    async forfeitStake(execution, input) {
      if (!input.stakeId?.trim()) {
        throw validationError("stakeId is required", { field: "stakeId" });
      }
      if (!input.reason?.trim()) {
        throw validationError("a stake forfeiture requires a reason", {
          field: "reason",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      const existing = await stakeRepository.findById(input.stakeId);
      if (!existing) {
        throw new NotFoundError(`stake not found: ${input.stakeId}`, {
          stakeId: input.stakeId,
        });
      }
      if (existing.state !== "COMMITTED") {
        throw validationError(
          `stake ${existing.id} is ${existing.state}, not COMMITTED — only a committed stake can be forfeited`,
          { stakeId: existing.id, state: existing.state },
        );
      }
      const key = `economic_stake_forfeit:${input.stakeId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        stakeAccountIds(
          existing.organizationScopeId,
          existing.ownerPersonId,
          true,
        ),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const stake = await stakeRepository.findByIdWithinTx(
                input.stakeId,
                tx,
              );
              if (!stake) {
                throw new NotFoundError(`stake not found: ${input.stakeId}`, {
                  stakeId: input.stakeId,
                });
              }
              if (stake.state !== "COMMITTED") {
                throw new ConflictError(
                  `stake ${stake.id} is already ${stake.state}`,
                  { stakeId: stake.id, state: stake.state },
                );
              }
              const transaction = await postLedgerTransactionWithinTx(
                tx,
                execution,
                {
                  organizationScopeId: stake.organizationScopeId,
                  kind: "stake_forfeit",
                  description: `forfeiture of stake ${stake.id}: ${input.reason.trim()}`,
                  subject: { kind: "stake", id: stake.id },
                  entries: [
                    {
                      accountId: economicAccountId(
                        stake.organizationScopeId,
                        stake.ownerPersonId,
                        "stake_escrow",
                        "credits",
                      ),
                      accountKind: "stake_escrow",
                      ownerPersonId: stake.ownerPersonId,
                      direction: "debit",
                      amount: stake.amount,
                      unit: "credits",
                    },
                    {
                      accountId: economicAccountId(
                        stake.organizationScopeId,
                        null,
                        "protocol_recognition",
                        "credits",
                      ),
                      accountKind: "protocol_recognition",
                      ownerPersonId: null,
                      direction: "credit",
                      amount: stake.amount,
                      unit: "credits",
                    },
                  ],
                  idempotencyKey: input.idempotencyKey,
                },
                ledgerRepository,
              );
              const updated: EconomicStake = Object.freeze({
                ...stake,
                state: "FORFEITED",
                outcome: {
                  disposition: "FORFEITED" as const,
                  reason: input.reason.trim(),
                  outcomeAt: new Date().toISOString(),
                  transactionId: transaction.id,
                },
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await stakeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: STAKE_FORFEITED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: updated.id,
                resourceType: "stake",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  ownerPersonId: updated.ownerPersonId,
                  amount: updated.amount,
                  reason: input.reason.trim(),
                  purposeKind: updated.purpose.kind,
                  purposeId: updated.purpose.id,
                  idempotencyKey: input.idempotencyKey,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                  ledgerTransactionId: transaction.id,
                },
              });
              return updated;
            },
            execution,
          ),
        stakeRecordLockKey(input.stakeId),
      );
      logger.info("stake.forfeited", { stakeId: applied.result.id });
      return applied.result;
    },

    async getStake(_execution, id) {
      const found = await stakeRepository.findById(id);
      if (!found) {
        throw new NotFoundError(`stake not found: ${id}`, { stakeId: id });
      }
      return found;
    },

    async listStakes(_execution, organizationScopeId, ownerPersonId) {
      if (ownerPersonId !== undefined) {
        return stakeRepository.listByOwner(organizationScopeId, ownerPersonId);
      }
      return stakeRepository.listByOrganization(organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  ExecutionContext,
  CommitStakeInput,
  CommitStakeResult,
  ReleaseStakeInput,
  ForfeitStakeInput,
};
