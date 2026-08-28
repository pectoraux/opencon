/**
 * CashService — cash obligations and internal settlement state
 * (NET-W008 §3.6).
 *
 * Architecture ref: spec/architecture-lock.md §1 (invariant 7:
 * Participation Credits are distinct from cash settlement), §14
 * (invariant 25: payment adapters provide transaction facts;
 * /settlement retains semantic authority — external payment EXECUTION
 * is NET-W030 and never happens here).
 *
 * Semantics: a payable books what the protocol OWES a counterparty
 * (credit cash_payable); a receivable books what a counterparty owes
 * the protocol (debit cash_receivable). Both post against
 * protocol_recognition(cash) so every transaction balances per unit.
 * Internal settlement (recognized → settled) and reversal
 * (recognized → reversed) are explicit, audited, append-only
 * corrections.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import { isEconomicCashKind, validateEconomicAmount } from "../core/economics.ts";
import type {
  CashObligation,
  CashObligationRepository,
  CashService,
  EconomicSubjectLookup,
  RecordCashObligationInput,
  RecordCashObligationResult,
  ReverseCashObligationInput,
  SettleCashObligationInput,
} from "./port.ts";
import { economicAccountId, negatePostings } from "./ledger.ts";
import {
  cashObligationLockKey,
  postLedgerTransactionWithinTx,
  withEconomicLocks,
  type EconomicServiceDeps,
} from "./posting.ts";

const OBLIGATION_RECORDED = "cash_obligation.recorded" as const;
const OBLIGATION_SETTLED = "cash_obligation.settled" as const;
const OBLIGATION_REVERSED = "cash_obligation.reversed" as const;

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

export interface CashServiceDeps extends EconomicServiceDeps {
  readonly repository: CashObligationRepository;
  readonly subjectLookup: EconomicSubjectLookup;
}

/** The account set a cash obligation posts to (lock set). */
export function obligationAccountIds(
  organizationScopeId: string,
  kind: "payable" | "receivable",
  counterpartyPersonId: string,
): string[] {
  return [
    economicAccountId(organizationScopeId, null, "protocol_recognition", "cash"),
    economicAccountId(
      organizationScopeId,
      counterpartyPersonId,
      kind === "payable" ? "cash_payable" : "cash_receivable",
      "cash",
    ),
  ];
}

export function createCashService(deps: CashServiceDeps): CashService {
  const { repository, subjectLookup, ledgerRepository, idempotency, auditWriter, logger } =
    deps;

  const service: CashService = {
    async recordCashObligation(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!isEconomicCashKind(input.kind)) {
        throw validationError(
          `cash obligation kind must be payable | receivable (got ${String(input.kind)})`,
          { kind: input.kind },
        );
      }
      if (!input.counterpartyPersonId?.trim()) {
        throw validationError("counterpartyPersonId is required", {
          field: "counterpartyPersonId",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      validateEconomicAmount("amount", input.amount);
      // Capture the narrowed kind BEFORE the applyIdempotent closure
      // (type narrowing does not survive into closures).
      const kind: CashObligation["kind"] = input.kind;
      const counterpartyPersonId = input.counterpartyPersonId;
      const amount = input.amount;
      const counterpartyExists = await subjectLookup.exists(
        input.counterpartyPersonId,
      );
      if (!counterpartyExists) {
        throw new NotFoundError(
          `cash counterparty person not found: ${input.counterpartyPersonId}`,
          { counterpartyPersonId: input.counterpartyPersonId },
        );
      }

      const key = `economic_cash_obligation:${input.organizationScopeId}:${input.counterpartyPersonId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        obligationAccountIds(
          input.organizationScopeId,
          input.kind,
          input.counterpartyPersonId,
        ),
        () =>
          idempotency.applyIdempotent(
            key,
            (ctx) => service.recordCashObligationWithinTx(execution, input, ctx),
            execution,
          ),
      );
      logger.info("cash_obligation.recorded", {
        obligationId: applied.result.id,
        kind: applied.result.kind,
        amount: applied.result.amount,
        created: applied.executed,
      });
      return { obligation: applied.result, created: applied.executed };
    },

    async recordCashObligationWithinTx(execution, input, ctx) {
      // NET-W020 remediation (PR #40 review): the SAME obligation body
      // as the standalone command, on the CALLER'S authoritative
      // transaction (ctx.transaction). No lock acquisition, no own
      // idempotency apply — the caller's transaction IS the atomicity
      // boundary.
      const tx = ctx.transaction;
      if (!isEconomicCashKind(input.kind)) {
        throw validationError(
          `cash obligation kind must be payable | receivable (got ${String(input.kind)})`,
          { kind: input.kind },
        );
      }
      // Capture the narrowed kind (type narrowing does not survive
      // into the posting entries below).
      const kind: CashObligation["kind"] = input.kind;
      const obligationId = randomUUID();
      // payable:    debit protocol_recognition(cash)  amount
      //             credit cash_payable(counterparty) amount
      // receivable: debit cash_receivable(counterparty) amount
      //             credit protocol_recognition(cash)    amount
      const transaction = await postLedgerTransactionWithinTx(
        tx,
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          kind: "cash_accounting",
          description: input.description,
          subject: { kind: "cash_obligation", id: obligationId },
          entries:
            kind === "payable"
              ? [
                  {
                    accountId: economicAccountId(
                      input.organizationScopeId,
                      null,
                      "protocol_recognition",
                      "cash",
                    ),
                    accountKind: "protocol_recognition",
                    ownerPersonId: null,
                    direction: "debit",
                    amount: input.amount,
                    unit: "cash",
                  },
                  {
                    accountId: economicAccountId(
                      input.organizationScopeId,
                      input.counterpartyPersonId,
                      "cash_payable",
                      "cash",
                    ),
                    accountKind: "cash_payable",
                    ownerPersonId: input.counterpartyPersonId,
                    direction: "credit",
                    amount: input.amount,
                    unit: "cash",
                  },
                ]
              : [
                  {
                    accountId: economicAccountId(
                      input.organizationScopeId,
                      input.counterpartyPersonId,
                      "cash_receivable",
                      "cash",
                    ),
                    accountKind: "cash_receivable",
                    ownerPersonId: input.counterpartyPersonId,
                    direction: "debit",
                    amount: input.amount,
                    unit: "cash",
                  },
                  {
                    accountId: economicAccountId(
                      input.organizationScopeId,
                      null,
                      "protocol_recognition",
                      "cash",
                    ),
                    accountKind: "protocol_recognition",
                    ownerPersonId: null,
                    direction: "credit",
                    amount: input.amount,
                    unit: "cash",
                  },
                ],
          idempotencyKey: input.idempotencyKey,
        },
        ledgerRepository,
      );
      const obligation: CashObligation = Object.freeze({
        id: obligationId,
        organizationScopeId: input.organizationScopeId,
        kind,
        counterpartyPersonId: input.counterpartyPersonId,
        amount: input.amount,
        status: "recognized",
        settledAt: null,
        settlementReference: null,
        reversal: null,
        transactionId: transaction.id,
        description: input.description?.trim() || null,
        recordedAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
      });
      await repository.createWithinTx(obligation, tx);
      const buffer = auditWriter.forTransaction(tx);
      await buffer.append({
        eventType: OBLIGATION_RECORDED,
        context: execution,
        actor: execution.actor?.id ?? null,
        subject: obligation.id,
        resourceType: "cash_obligation",
        resourceId: obligation.id,
        metadata: {
          organizationScopeId: obligation.organizationScopeId,
          kind: obligation.kind,
          counterpartyPersonId: obligation.counterpartyPersonId,
          amount: obligation.amount,
          unit: "cash",
          idempotencyKey: obligation.idempotencyKey,
          idempotencyRecordId: ctx.recordId,
          transactionId: tx.transactionId,
          ledgerTransactionId: transaction.id,
        },
      });
      return obligation;
    },

    async settleCashObligation(execution, input) {
      if (!input.obligationId?.trim()) {
        throw validationError("obligationId is required", {
          field: "obligationId",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      const existing = await repository.findById(input.obligationId);
      if (!existing) {
        throw new NotFoundError(`cash obligation not found: ${input.obligationId}`, {
          obligationId: input.obligationId,
        });
      }
      const key = `economic_cash_settlement:${input.obligationId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        obligationAccountIds(
          existing.organizationScopeId,
          existing.kind,
          existing.counterpartyPersonId,
        ),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const obligation = await repository.findByIdWithinTx(
              input.obligationId,
              tx,
            );
            if (!obligation) {
              throw new NotFoundError(
                `cash obligation not found: ${input.obligationId}`,
                { obligationId: input.obligationId },
              );
            }
            if (obligation.status !== "recognized") {
              throw validationError(
                `cash obligation ${obligation.id} is ${obligation.status}, not recognized — only a recognized obligation can settle internally`,
                { obligationId: obligation.id, status: obligation.status },
              );
            }
            // INTERNAL settlement: negate the recognition postings. The
            // external payment rails that might back this settlement are
            // NET-W030 adapters behind the neutral /payments port; the
            // reference below is internal audit lineage ONLY.
            const original = await ledgerRepository.findTransaction(
              obligation.transactionId,
            );
            if (!original) {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `original ledger transaction ${obligation.transactionId} for obligation ${obligation.id} not found — the ledger is incomplete`,
                context: { ledgerTransactionId: obligation.transactionId },
              });
            }
            const negated = negatePostings(original.entries);
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: obligation.organizationScopeId,
                kind: "settlement",
                description: `internal settlement of cash obligation ${obligation.id}`,
                subject: { kind: "cash_obligation", id: obligation.id },
                entries: negated,
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: CashObligation = Object.freeze({
              ...obligation,
              status: "settled",
              settledAt: new Date().toISOString(),
              settlementReference: input.reference?.trim() || null,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await repository.saveWithinTx(updated, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: OBLIGATION_SETTLED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "cash_obligation",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                kind: updated.kind,
                counterpartyPersonId: updated.counterpartyPersonId,
                amount: updated.amount,
                settlementReference: updated.settlementReference,
                reversedTransaction: obligation.transactionId,
                idempotencyKey: input.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return updated;
          }, execution),
        cashObligationLockKey(input.obligationId),
      );
      logger.info("cash_obligation.settled", {
        obligationId: applied.result.id,
      });
      return applied.result;
    },

    async reverseCashObligation(execution, input) {
      if (!input.obligationId?.trim()) {
        throw validationError("obligationId is required", {
          field: "obligationId",
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
      const existing = await repository.findById(input.obligationId);
      if (!existing) {
        throw new NotFoundError(`cash obligation not found: ${input.obligationId}`, {
          obligationId: input.obligationId,
        });
      }
      const key = `economic_cash_reversal:${input.obligationId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        obligationAccountIds(
          existing.organizationScopeId,
          existing.kind,
          existing.counterpartyPersonId,
        ),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const obligation = await repository.findByIdWithinTx(
              input.obligationId,
              tx,
            );
            if (!obligation) {
              throw new NotFoundError(
                `cash obligation not found: ${input.obligationId}`,
                { obligationId: input.obligationId },
              );
            }
            if (obligation.status !== "recognized") {
              throw validationError(
                `cash obligation ${obligation.id} is ${obligation.status}, not recognized — only a recognized obligation can be reversed (a settled obligation is corrected by NET-W030 settlement adapters)`,
                { obligationId: obligation.id, status: obligation.status },
              );
            }
            const original = await ledgerRepository.findTransaction(
              obligation.transactionId,
            );
            if (!original) {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `original ledger transaction ${obligation.transactionId} for obligation ${obligation.id} not found — the ledger is incomplete`,
                context: { ledgerTransactionId: obligation.transactionId },
              });
            }
            const negated = negatePostings(original.entries);
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: obligation.organizationScopeId,
                kind: "reversal",
                description: `reversal of cash obligation ${obligation.id}: ${input.reason.trim()}`,
                subject: { kind: "cash_obligation", id: obligation.id },
                entries: negated,
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: CashObligation = Object.freeze({
              ...obligation,
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
            await repository.saveWithinTx(updated, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: OBLIGATION_REVERSED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "cash_obligation",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                kind: updated.kind,
                counterpartyPersonId: updated.counterpartyPersonId,
                amount: updated.amount,
                reason: input.reason.trim(),
                reversedTransaction: obligation.transactionId,
                idempotencyKey: input.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return updated;
          }, execution),
        cashObligationLockKey(input.obligationId),
      );
      logger.info("cash_obligation.reversed", {
        obligationId: applied.result.id,
      });
      return applied.result;
    },

    async getObligation(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`cash obligation not found: ${id}`, {
          obligationId: id,
        });
      }
      return found;
    },

    async listObligations(_execution, organizationScopeId) {
      return repository.listByOrganization(organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  ExecutionContext,
  RecordCashObligationInput,
  RecordCashObligationResult,
  SettleCashObligationInput,
  ReverseCashObligationInput,
};
