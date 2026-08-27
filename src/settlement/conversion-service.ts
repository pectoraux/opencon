/**
 * ConversionService — the explicit cash↔credits conversion path
 * (NET-W008 §3.6).
 *
 * Architecture ref: spec/architecture-lock.md §1 (invariant 7:
 * Participation Credits are distinct from cash settlement and are not
 * inherently speculative assets), §5 (economic authority); ECON-004
 * (cash, pending value, mature value, credits and reputation are
 * separate concepts).
 *
 * THE RULE (work order §2): cash and credits are distinct accounting
 * concepts — no implicit 1:1 conversion exists. `recordConversion` is
 * the ONLY path between them: BOTH amounts are explicit on the record
 * (the implied rate is recorded, never assumed) and the postings are
 * dual-side balanced per unit, mirroring the credit-issuance
 * structure:
 *
 *   cash_to_credits:
 *     cash side:    debit cash_payable(person)  cashAmount
 *                   credit protocol_recognition(cash) cashAmount
 *     credits side: debit protocol_recognition(credits) creditsAmount
 *                   credit credits(person)      creditsAmount
 *
 *   credits_to_cash:
 *     credits side: debit credits(person)       creditsAmount
 *                   credit protocol_recognition(credits) creditsAmount
 *     cash side:    debit protocol_recognition(cash) cashAmount
 *                   credit cash_payable(person)  cashAmount
 *
 * The posting layer's balance checks enforce that the surrendered
 * side actually holds the funds (conservation); the per-account locks
 * serialize concurrent conversions so the checks can never race.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import {
  isEconomicConversionDirection,
  validateEconomicAmount,
} from "../core/economics.ts";
import type {
  ConversionRepository,
  ConversionService,
  EconomicConversion,
  EconomicSubjectLookup,
  RecordConversionInput,
  RecordConversionResult,
  ReverseConversionInput,
} from "./port.ts";
import { economicAccountId, negatePostings } from "./ledger.ts";
import {
  postLedgerTransactionWithinTx,
  withEconomicLocks,
  type EconomicServiceDeps,
} from "./posting.ts";

const CONVERSION_RECORDED = "conversion.recorded" as const;
const CONVERSION_REVERSED = "conversion.reversed" as const;

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

export interface ConversionServiceDeps extends EconomicServiceDeps {
  readonly repository: ConversionRepository;
  readonly subjectLookup: EconomicSubjectLookup;
}

/** The account set a conversion posts to (lock set). */
function conversionAccountIds(
  organizationScopeId: string,
  personId: string,
): string[] {
  return [
    economicAccountId(organizationScopeId, null, "protocol_recognition", "cash"),
    economicAccountId(organizationScopeId, null, "protocol_recognition", "credits"),
    economicAccountId(organizationScopeId, personId, "cash_payable", "cash"),
    economicAccountId(organizationScopeId, personId, "credits", "credits"),
  ];
}

export function createConversionService(
  deps: ConversionServiceDeps,
): ConversionService {
  const { repository, subjectLookup, ledgerRepository, idempotency, auditWriter, logger } =
    deps;

  const service: ConversionService = {
    async recordConversion(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.personId?.trim()) {
        throw validationError("personId is required", { field: "personId" });
      }
      if (!isEconomicConversionDirection(input.direction)) {
        throw validationError(
          `conversion direction must be cash_to_credits | credits_to_cash (got ${String(input.direction)})`,
          { direction: input.direction },
        );
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      validateEconomicAmount("cashAmount", input.cashAmount);
      validateEconomicAmount("creditsAmount", input.creditsAmount);
      // Capture the narrowed direction BEFORE the applyIdempotent closure
      // (type narrowing does not survive into closures).
      const direction: EconomicConversion["direction"] = input.direction;
      const personId = input.personId;
      const cashAmount = input.cashAmount;
      const creditsAmount = input.creditsAmount;
      const personExists = await subjectLookup.exists(input.personId);
      if (!personExists) {
        throw new NotFoundError(`conversion person not found: ${input.personId}`, {
          personId: input.personId,
        });
      }
      // The explicit rate recorded on the conversion record.
      const rate = cashAmount / creditsAmount;

      const key = `economic_conversion:${input.organizationScopeId}:${input.personId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        conversionAccountIds(input.organizationScopeId, input.personId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const conversionId = randomUUID();
            const protocolCash = economicAccountId(
              input.organizationScopeId,
              null,
              "protocol_recognition",
              "cash",
            );
            const protocolCredits = economicAccountId(
              input.organizationScopeId,
              null,
              "protocol_recognition",
              "credits",
            );
            const personCashPayable = economicAccountId(
              input.organizationScopeId,
              input.personId,
              "cash_payable",
              "cash",
            );
            const personCredits = economicAccountId(
              input.organizationScopeId,
              input.personId,
              "credits",
              "credits",
            );
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: input.organizationScopeId,
                kind: "conversion",
                description: input.description,
                subject: { kind: "conversion", id: conversionId },
                entries:
                  direction === "cash_to_credits"
                    ? [
                        {
                          accountId: personCashPayable,
                          accountKind: "cash_payable",
                          ownerPersonId: input.personId,
                          direction: "debit",
                          amount: input.cashAmount,
                          unit: "cash",
                        },
                        {
                          accountId: protocolCash,
                          accountKind: "protocol_recognition",
                          ownerPersonId: null,
                          direction: "credit",
                          amount: input.cashAmount,
                          unit: "cash",
                        },
                        {
                          accountId: protocolCredits,
                          accountKind: "protocol_recognition",
                          ownerPersonId: null,
                          direction: "debit",
                          amount: input.creditsAmount,
                          unit: "credits",
                        },
                        {
                          accountId: personCredits,
                          accountKind: "credits",
                          ownerPersonId: input.personId,
                          direction: "credit",
                          amount: input.creditsAmount,
                          unit: "credits",
                        },
                      ]
                    : [
                        {
                          accountId: personCredits,
                          accountKind: "credits",
                          ownerPersonId: input.personId,
                          direction: "debit",
                          amount: input.creditsAmount,
                          unit: "credits",
                        },
                        {
                          accountId: protocolCredits,
                          accountKind: "protocol_recognition",
                          ownerPersonId: null,
                          direction: "credit",
                          amount: input.creditsAmount,
                          unit: "credits",
                        },
                        {
                          accountId: protocolCash,
                          accountKind: "protocol_recognition",
                          ownerPersonId: null,
                          direction: "debit",
                          amount: input.cashAmount,
                          unit: "cash",
                        },
                        {
                          accountId: personCashPayable,
                          accountKind: "cash_payable",
                          ownerPersonId: input.personId,
                          direction: "credit",
                          amount: input.cashAmount,
                          unit: "cash",
                        },
                      ],
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const conversion: EconomicConversion = Object.freeze({
              id: conversionId,
              organizationScopeId: input.organizationScopeId,
              personId,
              direction,
              cashAmount,
              creditsAmount,
              rate,
              status: "converted",
              reversal: null,
              transactionId: transaction.id,
              convertedAt: new Date().toISOString(),
              description: input.description?.trim() || null,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await repository.createWithinTx(conversion, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: CONVERSION_RECORDED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: conversion.id,
              resourceType: "conversion",
              resourceId: conversion.id,
              metadata: {
                organizationScopeId: conversion.organizationScopeId,
                personId: conversion.personId,
                direction: conversion.direction,
                cashAmount: conversion.cashAmount,
                creditsAmount: conversion.creditsAmount,
                rate: conversion.rate,
                idempotencyKey: conversion.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return conversion;
          }, execution),
      );
      logger.info("conversion.recorded", {
        conversionId: applied.result.id,
        direction: applied.result.direction,
        created: applied.executed,
      });
      return { conversion: applied.result, created: applied.executed };
    },

    async reverseConversion(execution, input) {
      if (!input.conversionId?.trim()) {
        throw validationError("conversionId is required", {
          field: "conversionId",
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
      const existing = await repository.findById(input.conversionId);
      if (!existing) {
        throw new NotFoundError(`conversion not found: ${input.conversionId}`, {
          conversionId: input.conversionId,
        });
      }
      const key = `economic_conversion_reversal:${input.conversionId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        conversionAccountIds(existing.organizationScopeId, existing.personId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const conversion = await repository.findByIdWithinTx(
              input.conversionId,
              tx,
            );
            if (!conversion) {
              throw new NotFoundError(
                `conversion not found: ${input.conversionId}`,
                { conversionId: input.conversionId },
              );
            }
            if (conversion.status !== "converted") {
              throw validationError(
                `conversion ${conversion.id} is already ${conversion.status}`,
                { conversionId: conversion.id, status: conversion.status },
              );
            }
            const original = await ledgerRepository.findTransaction(
              conversion.transactionId,
            );
            if (!original) {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `original ledger transaction ${conversion.transactionId} for conversion ${conversion.id} not found — the ledger is incomplete`,
                context: { ledgerTransactionId: conversion.transactionId },
              });
            }
            // Negate the original dual-side postings; the balance checks
            // inside the posting layer reject the reversal when either
            // side no longer holds the funds (conservation).
            const negated = negatePostings(original.entries);
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: conversion.organizationScopeId,
                kind: "reversal",
                description: `reversal of conversion ${conversion.id}: ${input.reason.trim()}`,
                subject: { kind: "conversion", id: conversion.id },
                entries: negated,
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: EconomicConversion = Object.freeze({
              ...conversion,
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
              eventType: CONVERSION_REVERSED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "conversion",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                personId: updated.personId,
                direction: updated.direction,
                cashAmount: updated.cashAmount,
                creditsAmount: updated.creditsAmount,
                reason: input.reason.trim(),
                reversedTransaction: conversion.transactionId,
                idempotencyKey: input.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return updated;
          }, execution),
      );
      logger.info("conversion.reversed", {
        conversionId: applied.result.id,
      });
      return applied.result;
    },

    async getConversion(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`conversion not found: ${id}`, {
          conversionId: id,
        });
      }
      return found;
    },

    async listConversions(_execution, organizationScopeId) {
      return repository.listByOrganization(organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  ExecutionContext,
  RecordConversionInput,
  RecordConversionResult,
  ReverseConversionInput,
};
