/**
 * CreditService — Participation Credit issuance against verified
 * value (NET-W008 §3.4).
 *
 * Architecture ref: spec/architecture.md §4 (Participation Credit: an
 * earned utility/accounting unit representing verified participation
 * value — distinct from cash), §19 (model output never sufficient);
 * spec/architecture-lock.md §1 (invariant 7: Participation Credits
 * are distinct from cash settlement and are not inherently
 * speculative assets), §5 (economic authority — credit issuance MUST
 * reference verified value), §13 (invariant 20: Participation Credit
 * issuance requires a Proof-of-Value reference).
 *
 * THE GATE (work order §2): `issueCredits` consumes ONE MATURE value
 * record whose sources include ≥1 `proof_of_value` reference that
 * resolves VERIFIED. The rate is EXPLICIT on the issuance record (the
 * issuance record IS the explicit policy/ledger entry authorizing the
 * value→credits conversion — never an implicit 1:1). The postings are
 * dual-side balanced per unit:
 *
 *   value side:   debit  mature_value(beneficiary)      sourceAmount
 *                 credit protocol_recognition(value)    sourceAmount
 *   credits side: debit  protocol_recognition(credits)  creditAmount
 *                 credit credits(beneficiary)           creditAmount
 *
 * ECON-002/ECON-003: raw activity, spend, wealth, deposits and
 * reputation cannot reach this gate structurally (the only consumed
 * object is a value record created through the verified-source input
 * gate), and the PoV requirement is re-resolved at issuance time.
 *
 * Atomicity + concurrency: the consumption is serialized per value
 * record (`economic_value_record:{id}` — exactly-once consumption)
 * plus per-account locks (posting.ts); the issuance + postings + audit
 * + idempotency record commit in ONE authoritative transaction.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import { computeCreditAmount } from "../core/economics.ts";
import type {
  CreditIssuance,
  CreditIssuanceRepository,
  CreditService,
  EconomicSubjectLookup,
  EconomicValueRepository,
  IssueCreditsInput,
  IssueCreditsResult,
  ReverseIssuanceInput,
} from "./port.ts";
import { economicAccountId, negatePostings } from "./ledger.ts";
import {
  postLedgerTransactionWithinTx,
  valueRecordLockKey,
  withEconomicLocks,
  type EconomicServiceDeps,
} from "./posting.ts";

const ISSUANCE_ISSUED = "credit_issuance.issued" as const;
const ISSUANCE_REVERSED = "credit_issuance.reversed" as const;

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

export interface CreditServiceDeps extends EconomicServiceDeps {
  readonly issuanceRepository: CreditIssuanceRepository;
  readonly valueRepository: EconomicValueRepository;
  readonly subjectLookup: EconomicSubjectLookup;
  readonly proofOfValueLookup: import("./port.ts").EconomicProofOfValueLookup;
}

/** The account set an issuance posts to (lock set). */
export function issuanceAccountIds(
  organizationScopeId: string,
  beneficiaryPersonId: string,
): string[] {
  return [
    economicAccountId(organizationScopeId, null, "protocol_recognition", "value"),
    economicAccountId(organizationScopeId, null, "protocol_recognition", "credits"),
    economicAccountId(organizationScopeId, beneficiaryPersonId, "mature_value", "value"),
    economicAccountId(organizationScopeId, beneficiaryPersonId, "credits", "credits"),
  ];
}

export function createCreditService(deps: CreditServiceDeps): CreditService {
  const {
    issuanceRepository,
    valueRepository,
    subjectLookup,
    proofOfValueLookup,
    ledgerRepository,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  const service: CreditService = {
    async issueCredits(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.beneficiaryPersonId?.trim()) {
        throw validationError("beneficiaryPersonId is required", {
          field: "beneficiaryPersonId",
        });
      }
      if (!input.sourceValueRecordId?.trim()) {
        throw validationError("sourceValueRecordId is required", {
          field: "sourceValueRecordId",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      // The rate must be a valid positive ≤ 6-decimal number (the
      // explicit conversion authorization recorded on the issuance).
      const creditAmountProbe = computeCreditAmount(1, input.creditsPerValueUnit);
      if (!(creditAmountProbe > 0)) {
        throw validationError("creditsPerValueUnit is invalid", {
          creditsPerValueUnit: input.creditsPerValueUnit,
        });
      }
      const beneficiaryExists = await subjectLookup.exists(
        input.beneficiaryPersonId,
      );
      if (!beneficiaryExists) {
        throw new NotFoundError(
          `credit beneficiary person not found: ${input.beneficiaryPersonId}`,
          { beneficiaryPersonId: input.beneficiaryPersonId },
        );
      }

      const key = `economic_credit_issuance:${input.organizationScopeId}:${input.beneficiaryPersonId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        issuanceAccountIds(input.organizationScopeId, input.beneficiaryPersonId),
        () =>
          idempotency.applyIdempotent(
            key,
            (ctx) => service.issueCreditsWithinTx(execution, input, ctx),
            execution,
          ),
        valueRecordLockKey(input.sourceValueRecordId),
      );
      logger.info("credit_issuance.issued", {
        issuanceId: applied.result.id,
        beneficiaryPersonId: applied.result.beneficiaryPersonId,
        creditAmount: applied.result.creditAmount,
        created: applied.executed,
      });
      return { issuance: applied.result, created: applied.executed };
    },

    async issueCreditsWithinTx(execution, input, ctx) {
      // NET-W020 remediation (PR #40 review): the SAME issuance body
      // as the standalone command, on the CALLER'S authoritative
      // transaction (ctx.transaction). No lock acquisition, no own
      // idempotency apply — the caller's transaction IS the atomicity
      // boundary; the exactly-once value consumption (MATURE →
      // CONSUMED below) makes a re-run inside a surviving transaction
      // impossible.
      const tx = ctx.transaction;
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
      if (record.beneficiaryPersonId !== input.beneficiaryPersonId) {
        throw validationError(
          `source value record ${record.id} belongs to beneficiary ${record.beneficiaryPersonId}, not ${input.beneficiaryPersonId}`,
          {
            sourceValueRecordId: record.id,
            recordBeneficiary: record.beneficiaryPersonId,
            inputBeneficiary: input.beneficiaryPersonId,
          },
        );
      }
      if (record.state === "PENDING") {
        throw validationError(
          `source value record ${record.id} is PENDING — pending value cannot be consumed as mature value (architecture-lock invariant 19: mature the record explicitly first)`,
          { sourceValueRecordId: record.id, state: record.state },
        );
      }
      if (record.state !== "MATURE") {
        throw validationError(
          `source value record ${record.id} is ${record.state}, not MATURE — only mature value can issue Participation Credits`,
          { sourceValueRecordId: record.id, state: record.state },
        );
      }
      // THE PROOF-OF-VALUE GATE (architecture-lock invariant 20):
      // ≥1 source must be a Proof-of-Value that resolves VERIFIED.
      const povRefs = record.sources.filter(
        (s) => s.kind === "proof_of_value",
      );
      let verifiedPovId: string | null = null;
      for (const ref of povRefs) {
        const resolved = await proofOfValueLookup.resolve(ref.id);
        if (resolved && resolved.state === "VERIFIED") {
          verifiedPovId = ref.id;
          break;
        }
      }
      if (verifiedPovId === null) {
        throw validationError(
          `credit issuance against source value record ${record.id} requires a VERIFIED Proof-of-Value reference (architecture-lock invariant 20) — the record's sources carry no VERIFIED Proof-of-Value`,
          {
            sourceValueRecordId: record.id,
            sourceKinds: record.sources.map((s) => s.kind),
          },
        );
      }
      const creditAmount = computeCreditAmount(
        record.amount,
        input.creditsPerValueUnit,
      );
      const issuanceId = randomUUID();
      // THE DUAL-SIDE ISSUANCE POSTINGS (balanced per unit).
      const transaction = await postLedgerTransactionWithinTx(
        tx,
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          kind: "credit_issuance",
          description: input.description,
          subject: { kind: "credit_issuance", id: issuanceId },
          entries: [
            {
              accountId: economicAccountId(
                input.organizationScopeId,
                input.beneficiaryPersonId,
                "mature_value",
                "value",
              ),
              accountKind: "mature_value",
              ownerPersonId: input.beneficiaryPersonId,
              direction: "debit",
              amount: record.amount,
              unit: "value",
            },
            {
              accountId: economicAccountId(
                input.organizationScopeId,
                null,
                "protocol_recognition",
                "value",
              ),
              accountKind: "protocol_recognition",
              ownerPersonId: null,
              direction: "credit",
              amount: record.amount,
              unit: "value",
            },
            {
              accountId: economicAccountId(
                input.organizationScopeId,
                null,
                "protocol_recognition",
                "credits",
              ),
              accountKind: "protocol_recognition",
              ownerPersonId: null,
              direction: "debit",
              amount: creditAmount,
              unit: "credits",
            },
            {
              accountId: economicAccountId(
                input.organizationScopeId,
                input.beneficiaryPersonId,
                "credits",
                "credits",
              ),
              accountKind: "credits",
              ownerPersonId: input.beneficiaryPersonId,
              direction: "credit",
              amount: creditAmount,
              unit: "credits",
            },
          ],
          idempotencyKey: input.idempotencyKey,
        },
        ledgerRepository,
      );
      const issuance: CreditIssuance = Object.freeze({
        id: issuanceId,
        organizationScopeId: input.organizationScopeId,
        beneficiaryPersonId: input.beneficiaryPersonId,
        creditAmount,
        sourceValueRecordId: record.id,
        sourceValueAmount: record.amount,
        proofOfValueId: verifiedPovId,
        creditsPerValueUnit: input.creditsPerValueUnit,
        status: "issued",
        reversal: null,
        transactionId: transaction.id,
        issuedAt: new Date().toISOString(),
        description: input.description?.trim() || null,
        idempotencyKey: input.idempotencyKey,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
      });
      await issuanceRepository.createWithinTx(issuance, tx);
      // Consume the record (exactly-once — serialized per record).
      const consumed = Object.freeze({
        ...record,
        state: "CONSUMED" as const,
        version: record.version + 1,
        consumedBy: { kind: "credit_issuance" as const, id: issuanceId },
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
      });
      await valueRepository.saveWithinTx(consumed, record.version, tx);
      const buffer = auditWriter.forTransaction(tx);
      await buffer.append({
        eventType: ISSUANCE_ISSUED,
        context: execution,
        actor: execution.actor?.id ?? null,
        subject: issuance.id,
        resourceType: "credit_issuance",
        resourceId: issuance.id,
        metadata: {
          organizationScopeId: issuance.organizationScopeId,
          beneficiaryPersonId: issuance.beneficiaryPersonId,
          creditAmount: issuance.creditAmount,
          sourceValueRecordId: issuance.sourceValueRecordId,
          sourceValueAmount: issuance.sourceValueAmount,
          proofOfValueId: issuance.proofOfValueId,
          creditsPerValueUnit: issuance.creditsPerValueUnit,
          idempotencyKey: issuance.idempotencyKey,
          idempotencyRecordId: ctx.recordId,
          transactionId: tx.transactionId,
          ledgerTransactionId: transaction.id,
        },
      });
      return issuance;
    },

    async reverseIssuance(execution, input) {
      if (!input.issuanceId?.trim()) {
        throw validationError("issuanceId is required", { field: "issuanceId" });
      }
      if (!input.reason?.trim()) {
        throw validationError("a reversal requires a reason", { field: "reason" });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      const existing = await issuanceRepository.findById(input.issuanceId);
      if (!existing) {
        throw new NotFoundError(`credit issuance not found: ${input.issuanceId}`, {
          issuanceId: input.issuanceId,
        });
      }
      const key = `economic_issuance_reversal:${input.issuanceId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        issuanceAccountIds(
          existing.organizationScopeId,
          existing.beneficiaryPersonId,
        ),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const issuance = await issuanceRepository.findByIdWithinTx(
              input.issuanceId,
              tx,
            );
            if (!issuance) {
              throw new NotFoundError(
                `credit issuance not found: ${input.issuanceId}`,
                { issuanceId: input.issuanceId },
              );
            }
            if (issuance.status !== "issued") {
              throw validationError(
                `credit issuance ${issuance.id} is already ${issuance.status}`,
                { issuanceId: issuance.id, status: issuance.status },
              );
            }
            const record = await valueRepository.findByIdWithinTx(
              issuance.sourceValueRecordId,
              tx,
            );
            if (!record || record.state !== "CONSUMED") {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `source value record ${issuance.sourceValueRecordId} for issuance ${issuance.id} is not CONSUMED — the ledger is inconsistent`,
                context: { issuanceId: issuance.id },
              });
            }
            // Negate the ORIGINAL authorized issuance postings exactly;
            // the credits-account balance check inside the posting layer
            // rejects the reversal when the beneficiary no longer holds
            // the credits (conservation).
            const original = await ledgerRepository.findTransaction(
              issuance.transactionId,
            );
            if (!original) {
              throw new OpenConError({
                code: "ECONOMIC_LEDGER_VALIDATION",
                classification: "invariant",
                message:
                  `original ledger transaction ${issuance.transactionId} for issuance ${issuance.id} not found — the ledger is incomplete`,
                context: { ledgerTransactionId: issuance.transactionId },
              });
            }
            const negated = negatePostings(original.entries);
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: issuance.organizationScopeId,
                kind: "reversal",
                description: `reversal of credit issuance ${issuance.id}: ${input.reason.trim()}`,
                subject: { kind: "credit_issuance", id: issuance.id },
                entries: negated,
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: CreditIssuance = Object.freeze({
              ...issuance,
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
            await issuanceRepository.saveWithinTx(updated, tx);
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
              eventType: ISSUANCE_REVERSED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "credit_issuance",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                beneficiaryPersonId: updated.beneficiaryPersonId,
                creditAmount: updated.creditAmount,
                sourceValueRecordId: updated.sourceValueRecordId,
                reason: input.reason.trim(),
                reversedTransaction: issuance.transactionId,
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
      logger.info("credit_issuance.reversed", {
        issuanceId: applied.result.id,
      });
      return applied.result;
    },

    async getIssuance(_execution, id) {
      const found = await issuanceRepository.findById(id);
      if (!found) {
        throw new NotFoundError(`credit issuance not found: ${id}`, {
          issuanceId: id,
        });
      }
      return found;
    },

    async listIssuances(_execution, organizationScopeId, beneficiaryPersonId) {
      return issuanceRepository.listByBeneficiary(
        organizationScopeId,
        beneficiaryPersonId,
      );
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  ExecutionContext,
  IssueCreditsInput,
  IssueCreditsResult,
  ReverseIssuanceInput,
};
