/**
 * EconomicValueService — the pending/mature value domain service
 * (NET-W008 §3.3): the economic input gate, the explicit maturation
 * gate and append-only reversals.
 *
 * Architecture ref: spec/architecture-lock.md §1 (invariants 3/4: no
 * economically material reward from raw activity alone; evidence, not
 * participant or agent claims, is authoritative for settlement), §5
 * (economic authority), §13 (invariant 19: pending value is not
 * equivalent to mature value), §12 (execution lineage).
 *
 * THE GATES (work order §2/§4):
 *  - recordPendingValue requires ≥1 upstream source, each RESOLVED
 *    through the injected neutral lookups (existence + same
 *    organization scope + qualifying VERIFIED state: a VERIFIED
 *    Proof-of-Value, a VERIFIED measured outcome, or platform/
 *    attested/provider evidence). Spend, wealth, deposits, raw
 *    activity, reputation records and model output have NO source
 *    kind — a bare economic assertion cannot enter the system.
 *  - matureValue is the EXPLICIT maturation gate (PENDING → MATURE,
 *    audited, version-checked); a `fixed_window` policy requires the
 *    explicit `effectiveAt` reference timestamp to have reached
 *    `windowEndAt` (SETTLE-002 — no wall clock).
 *  - reverseValue is an append-only correction (negated postings).
 *
 * Atomicity + concurrency: every mutation runs through
 * IdempotencyStore.applyIdempotent (the NET-W004 primitive) — the
 * record + the balanced ledger transaction + the audit record + the
 * idempotency record commit in ONE authoritative transaction. Record
 * state mutations are serialized per record under the
 * organization-independent mutex `economic_value_record:{id}`
 * (IdempotencyStore.withLock — the NET-W007 remediation pattern) and
 * every posting additionally serializes per account (sorted lock
 * acquisition — see posting.ts) so balance checks can never race.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import {
  QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES,
  isEconomicValueSourceKind,
  validateEconomicAmount,
  validateEconomicMaturationPolicy,
  type EconomicMaturationPolicy,
  type EconomicValueSourceKind,
} from "../core/economics.ts";
import type {
  EconomicContributionLookup,
  EconomicEvidenceLookup,
  EconomicMeasuredOutcomeLookup,
  EconomicProofOfValueLookup,
  EconomicSubjectLookup,
  EconomicValueRecord,
  EconomicValueRepository,
  EconomicValueService,
  EconomicValueSourceRef,
  MatureValueInput,
  RecordPendingValueInput,
  RecordPendingValueResult,
  ResolvedContributionSource,
  ResolvedEvidenceRecordSource,
  ResolvedMeasuredOutcomeSource,
  ResolvedProofOfValueSource,
  ReverseValueInput,
} from "./port.ts";
import type { EconomicLedgerEntry } from "./port.ts";
import {
  economicAccountId,
  negatePostings,
} from "./ledger.ts";
import {
  postLedgerTransactionWithinTx,
  valueRecordLockKey,
  withEconomicLocks,
  type EconomicServiceDeps,
} from "./posting.ts";

const VALUE_RECORDED = "economic_value.recorded" as const;
const VALUE_MATURED = "economic_value.matured" as const;
const VALUE_REVERSED = "economic_value.reversed" as const;

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

export interface EconomicValueServiceDeps extends EconomicServiceDeps {
  readonly repository: EconomicValueRepository;
  readonly subjectLookup: EconomicSubjectLookup;
  readonly proofOfValueLookup: EconomicProofOfValueLookup;
  readonly measuredOutcomeLookup: EconomicMeasuredOutcomeLookup;
  readonly evidenceLookup: EconomicEvidenceLookup;
  /** NET-W014: resolves `contribution` sources (same qualifying bar). */
  readonly contributionLookup: EconomicContributionLookup;
}

/** A source ref narrowed to its kind + id (validation output). */
function narrowSources(
  sources: readonly { kind: string; id: string }[],
): EconomicValueSourceRef[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw validationError(
      "an economic value record requires at least one upstream source reference (proof of value, measured outcome, evidence or contribution) — a bare activity, spend, wealth or reputation assertion cannot create economic value",
      { sourceCount: Array.isArray(sources) ? sources.length : 0 },
    );
  }
  const narrowed: EconomicValueSourceRef[] = [];
  for (const source of sources) {
    if (!source || !source.id?.trim()) {
      throw validationError("each economic source requires an id", { source });
    }
    if (!isEconomicValueSourceKind(source.kind)) {
      throw validationError(
        `economic source kind must be one of proof_of_value | measured_outcome | evidence | contribution (got ${String(source.kind)}) — spend, wealth, deposits, raw activity and reputation are not economic sources`,
        { kind: source.kind },
      );
    }
    narrowed.push({ kind: source.kind, id: source.id });
  }
  return narrowed;
}

/**
 * Resolve one source ref through the neutral lookups and enforce the
 * qualifying VERIFIED state (the economic input gate — the caller has
 * already validated the kind).
 */
async function resolveQualifyingSource(
  ref: EconomicValueSourceRef,
  deps: EconomicValueServiceDeps,
  organizationScopeId: string,
): Promise<void> {
  let resolved:
    | ResolvedProofOfValueSource
    | ResolvedMeasuredOutcomeSource
    | ResolvedEvidenceRecordSource
    | ResolvedContributionSource
    | null = null;
  if (ref.kind === "proof_of_value") {
    resolved = await deps.proofOfValueLookup.resolve(ref.id);
  } else if (ref.kind === "measured_outcome") {
    resolved = await deps.measuredOutcomeLookup.resolve(ref.id);
  } else if (ref.kind === "contribution") {
    // NET-W014: the verified helpful contribution — the identical
    // qualifying bar as the other lifecycle sources (same scope +
    // state VERIFIED; the /workflows authority's terminal
    // confirmation).
    resolved = await deps.contributionLookup.resolve(ref.id);
  } else {
    resolved = await deps.evidenceLookup.resolve(ref.id);
  }
  if (!resolved) {
    throw new NotFoundError(`upstream ${ref.kind} not found: ${ref.id}`, {
      kind: ref.kind,
      id: ref.id,
    });
  }
  if (resolved.organizationScopeId !== organizationScopeId) {
    throw validationError(
      `upstream ${ref.kind} ${ref.id} belongs to organization scope ${resolved.organizationScopeId}, not ${organizationScopeId}`,
      {
        kind: ref.kind,
        id: ref.id,
        sourceScope: resolved.organizationScopeId,
        inputScope: organizationScopeId,
      },
    );
  }
  if (ref.kind === "evidence") {
    const evidence = resolved as ResolvedEvidenceRecordSource;
    const qualifies = (
      QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES as readonly string[]
    ).includes(evidence.sourceType);
    if (!qualifies) {
      throw validationError(
        `evidence ${ref.id} has source type "${evidence.sourceType}" which does not qualify as a verified economic input (only platform/attested/provider evidence qualifies — model/self output is never authoritative for settlement)`,
        { id: ref.id, sourceType: evidence.sourceType },
      );
    }
    return;
  }
  const lifecycle = resolved as
    | ResolvedProofOfValueSource
    | ResolvedMeasuredOutcomeSource
    | ResolvedContributionSource;
  if (lifecycle.state !== "VERIFIED") {
    throw validationError(
      `upstream ${ref.kind} ${ref.id} is in state ${lifecycle.state}, not VERIFIED — unverified value cannot create economic records`,
      { kind: ref.kind, id: ref.id, state: lifecycle.state },
    );
  }
}

/** The account ids a pending-value recognition posts to (lock set). */
function recognitionAccountIds(
  organizationScopeId: string,
  beneficiaryPersonId: string,
): string[] {
  return [
    economicAccountId(organizationScopeId, null, "protocol_recognition", "value"),
    economicAccountId(organizationScopeId, beneficiaryPersonId, "pending_value", "value"),
  ];
}

export function createEconomicValueService(
  deps: EconomicValueServiceDeps,
): EconomicValueService {
  const { repository, ledgerRepository, idempotency, auditWriter, logger } = deps;

  const service: EconomicValueService = {
    async recordPendingValue(execution, input) {
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
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      validateEconomicAmount("amount", input.amount);
      const sources = narrowSources(input.sources);
      const maturation: EconomicMaturationPolicy = input.maturation
        ? validateEconomicMaturationPolicy({
            strategy: input.maturation.strategy as EconomicMaturationPolicy["strategy"],
            ...(input.maturation.windowEndAt !== undefined
              ? { windowEndAt: input.maturation.windowEndAt }
              : {}),
          })
        : { strategy: "immediate" };

      // ---- Beneficiary + upstream resolution (neutral lookups) ---------
      const beneficiaryExists = await deps.subjectLookup.exists(
        input.beneficiaryPersonId,
      );
      if (!beneficiaryExists) {
        throw new NotFoundError(
          `economic beneficiary person not found: ${input.beneficiaryPersonId}`,
          { beneficiaryPersonId: input.beneficiaryPersonId },
        );
      }
      for (const ref of sources) {
        await resolveQualifyingSource(ref, deps, input.organizationScopeId);
      }

      // ---- Idempotent, atomic, audited recognition ---------------------
      const key = `economic_value:${input.organizationScopeId}:${input.beneficiaryPersonId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        recognitionAccountIds(input.organizationScopeId, input.beneficiaryPersonId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const recordId = randomUUID();
            // THE RECOGNITION POSTINGS (balanced per unit):
            //   debit  protocol_recognition(value)   amount
            //   credit pending_value(beneficiary)    amount
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: input.organizationScopeId,
                kind: "value_recognition",
                description: input.description,
                subject: { kind: "economic_value", id: recordId },
                entries: [
                  {
                    accountId: economicAccountId(
                      input.organizationScopeId,
                      null,
                      "protocol_recognition",
                      "value",
                    ),
                    accountKind: "protocol_recognition",
                    ownerPersonId: null,
                    direction: "debit",
                    amount: input.amount,
                    unit: "value",
                  },
                  {
                    accountId: economicAccountId(
                      input.organizationScopeId,
                      input.beneficiaryPersonId,
                      "pending_value",
                      "value",
                    ),
                    accountKind: "pending_value",
                    ownerPersonId: input.beneficiaryPersonId,
                    direction: "credit",
                    amount: input.amount,
                    unit: "value",
                  },
                ],
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const record: EconomicValueRecord = Object.freeze({
              id: recordId,
              organizationScopeId: input.organizationScopeId,
              beneficiaryPersonId: input.beneficiaryPersonId,
              state: "PENDING",
              version: 0,
              amount: input.amount,
              sources,
              maturation,
              description: input.description?.trim() || null,
              recordedAt: new Date().toISOString(),
              maturedAt: null,
              consumedBy: null,
              reversal: null,
              recognitionTransactionId: transaction.id,
              maturationTransactionId: null,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await repository.createWithinTx(record, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: VALUE_RECORDED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: record.id,
              resourceType: "economic_value",
              resourceId: record.id,
              metadata: {
                organizationScopeId: record.organizationScopeId,
                beneficiaryPersonId: record.beneficiaryPersonId,
                amount: record.amount,
                unit: "value",
                state: record.state,
                maturationStrategy: record.maturation.strategy,
                sources: record.sources.map((s) => `${s.kind}:${s.id}`),
                idempotencyKey: record.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return record;
          }, execution),
      );
      logger.info("economic_value.recorded", {
        valueRecordId: applied.result.id,
        amount: applied.result.amount,
        state: applied.result.state,
        created: applied.executed,
      });
      return { value: applied.result, created: applied.executed };
    },

    async matureValue(execution, input) {
      if (!input.valueRecordId?.trim()) {
        throw validationError("valueRecordId is required", {
          field: "valueRecordId",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      if (
        input.effectiveAt !== undefined &&
        Number.isNaN(Date.parse(input.effectiveAt))
      ) {
        throw validationError(
          `effectiveAt must be a valid ISO-8601 timestamp (got ${String(input.effectiveAt)})`,
          { effectiveAt: input.effectiveAt },
        );
      }
      // Pre-read (committed) to determine the lock set; the
      // authoritative state check runs in-tx.
      const existing = await repository.findById(input.valueRecordId);
      if (!existing) {
        throw new NotFoundError(
          `economic value record not found: ${input.valueRecordId}`,
          { valueRecordId: input.valueRecordId },
        );
      }
      const key = `economic_maturation:${input.valueRecordId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        [
          economicAccountId(
            existing.organizationScopeId,
            existing.beneficiaryPersonId,
            "pending_value",
            "value",
          ),
          economicAccountId(
            existing.organizationScopeId,
            existing.beneficiaryPersonId,
            "mature_value",
            "value",
          ),
        ],
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const record = await repository.findByIdWithinTx(
              input.valueRecordId,
              tx,
            );
            if (!record) {
              throw new NotFoundError(
                `economic value record not found: ${input.valueRecordId}`,
                { valueRecordId: input.valueRecordId },
              );
            }
            if (record.state !== "PENDING") {
              throw validationError(
                `economic value record ${record.id} is ${record.state}, not PENDING — pending value must mature explicitly and each state change applies once (architecture-lock invariant 19: pending value is not equivalent to mature value)`,
                { valueRecordId: record.id, state: record.state },
              );
            }
            // THE EXPLICIT MATURATION GATE (SETTLE-002): a fixed_window
            // policy matures only once the explicit reference timestamp
            // reaches windowEndAt — deterministic, no wall clock.
            if (record.maturation.strategy === "fixed_window") {
              if (input.effectiveAt === undefined) {
                throw validationError(
                  `economic value record ${record.id} uses a fixed_window maturation policy — the explicit effectiveAt reference timestamp is required`,
                  { valueRecordId: record.id, strategy: "fixed_window" },
                );
              }
              const windowEnd = Date.parse(record.maturation.windowEndAt!);
              if (Date.parse(input.effectiveAt) < windowEnd) {
                throw validationError(
                  `economic value record ${record.id} is still inside its settlement window (windowEndAt ${record.maturation.windowEndAt}, effectiveAt ${input.effectiveAt}) — value cannot silently become mature`,
                  {
                    valueRecordId: record.id,
                    windowEndAt: record.maturation.windowEndAt,
                    effectiveAt: input.effectiveAt,
                  },
                );
              }
            }
            // THE MATURATION POSTINGS (balanced):
            //   debit  pending_value(beneficiary)  amount
            //   credit mature_value(beneficiary)   amount
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: record.organizationScopeId,
                kind: "maturation",
                subject: { kind: "economic_value", id: record.id },
                entries: [
                  {
                    accountId: economicAccountId(
                      record.organizationScopeId,
                      record.beneficiaryPersonId,
                      "pending_value",
                      "value",
                    ),
                    accountKind: "pending_value",
                    ownerPersonId: record.beneficiaryPersonId,
                    direction: "debit",
                    amount: record.amount,
                    unit: "value",
                  },
                  {
                    accountId: economicAccountId(
                      record.organizationScopeId,
                      record.beneficiaryPersonId,
                      "mature_value",
                      "value",
                    ),
                    accountKind: "mature_value",
                    ownerPersonId: record.beneficiaryPersonId,
                    direction: "credit",
                    amount: record.amount,
                    unit: "value",
                  },
                ],
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: EconomicValueRecord = Object.freeze({
              ...record,
              state: "MATURE",
              version: record.version + 1,
              maturedAt: new Date().toISOString(),
              maturationTransactionId: transaction.id,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await repository.saveWithinTx(updated, record.version, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: VALUE_MATURED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "economic_value",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                beneficiaryPersonId: updated.beneficiaryPersonId,
                amount: updated.amount,
                fromState: record.state,
                toState: updated.state,
                fromVersion: record.version,
                toVersion: updated.version,
                maturationStrategy: updated.maturation.strategy,
                effectiveAt: input.effectiveAt ?? null,
                idempotencyKey: input.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return updated;
          }, execution),
        valueRecordLockKey(input.valueRecordId),
      );
      logger.info("economic_value.matured", {
        valueRecordId: applied.result.id,
        version: applied.result.version,
      });
      return applied.result;
    },

    async reverseValue(execution, input) {
      if (!input.valueRecordId?.trim()) {
        throw validationError("valueRecordId is required", {
          field: "valueRecordId",
        });
      }
      if (!input.reason?.trim()) {
        throw validationError("a reversal requires a reason", {
          field: "reason",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      const existing = await repository.findById(input.valueRecordId);
      if (!existing) {
        throw new NotFoundError(
          `economic value record not found: ${input.valueRecordId}`,
          { valueRecordId: input.valueRecordId },
        );
      }
      const key = `economic_value_reversal:${input.valueRecordId}:${input.idempotencyKey}`;
      const applied = await withEconomicLocks(
        idempotency,
        [
          economicAccountId(
            existing.organizationScopeId,
            null,
            "protocol_recognition",
            "value",
          ),
          economicAccountId(
            existing.organizationScopeId,
            existing.beneficiaryPersonId,
            "pending_value",
            "value",
          ),
          economicAccountId(
            existing.organizationScopeId,
            existing.beneficiaryPersonId,
            "mature_value",
            "value",
          ),
        ],
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const record = await repository.findByIdWithinTx(
              input.valueRecordId,
              tx,
            );
            if (!record) {
              throw new NotFoundError(
                `economic value record not found: ${input.valueRecordId}`,
                { valueRecordId: input.valueRecordId },
              );
            }
            if (record.state === "CONSUMED") {
              throw validationError(
                `economic value record ${record.id} is CONSUMED by a ${record.consumedBy?.kind ?? "unknown"} — reverse the consumption instead of the record`,
                { valueRecordId: record.id, state: record.state },
              );
            }
            if (record.state === "REVERSED") {
              throw validationError(
                `economic value record ${record.id} is already REVERSED`,
                { valueRecordId: record.id, state: record.state },
              );
            }
            // Collect the ORIGINAL authorized postings (recognition +
            // maturation) and negate them exactly.
            const originalTxIds = [
              record.recognitionTransactionId,
              record.maturationTransactionId,
            ].filter((id): id is string => id !== null);
            const originalEntries: EconomicLedgerEntry[] = [];
            for (const txId of originalTxIds) {
              const original = await ledgerRepository.findTransaction(txId);
              if (!original) {
                throw new OpenConError({
                  code: "ECONOMIC_LEDGER_VALIDATION",
                  classification: "invariant",
                  message: `original ledger transaction ${txId} for value record ${record.id} not found — the ledger is incomplete`,
                  context: { ledgerTransactionId: txId, valueRecordId: record.id },
                });
              }
              originalEntries.push(...original.entries);
            }
            const negated = negatePostings(originalEntries);
            const transaction = await postLedgerTransactionWithinTx(
              tx,
              execution,
              {
                organizationScopeId: record.organizationScopeId,
                kind: "reversal",
                description: `reversal of economic value record ${record.id}: ${input.reason.trim()}`,
                subject: { kind: "economic_value", id: record.id },
                entries: negated,
                idempotencyKey: input.idempotencyKey,
              },
              ledgerRepository,
            );
            const updated: EconomicValueRecord = Object.freeze({
              ...record,
              state: "REVERSED",
              version: record.version + 1,
              reversal: {
                reversedAt: new Date().toISOString(),
                reason: input.reason.trim(),
                transactionId: transaction.id,
              },
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await repository.saveWithinTx(updated, record.version, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: VALUE_REVERSED,
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: updated.id,
              resourceType: "economic_value",
              resourceId: updated.id,
              metadata: {
                organizationScopeId: updated.organizationScopeId,
                beneficiaryPersonId: updated.beneficiaryPersonId,
                amount: updated.amount,
                fromState: record.state,
                toState: updated.state,
                reason: input.reason.trim(),
                reversedTransactions: originalTxIds,
                idempotencyKey: input.idempotencyKey,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
                ledgerTransactionId: transaction.id,
              },
            });
            return updated;
          }, execution),
        valueRecordLockKey(input.valueRecordId),
      );
      logger.info("economic_value.reversed", {
        valueRecordId: applied.result.id,
        version: applied.result.version,
      });
      return applied.result;
    },

    async getValue(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`economic value record not found: ${id}`, {
          valueRecordId: id,
        });
      }
      return found;
    },

    async listValues(_execution, organizationScopeId, beneficiaryPersonId, states) {
      const stateSet = states
        ?.map((state) => {
          if (
            !["PENDING", "MATURE", "CONSUMED", "REVERSED"].includes(state)
          ) {
            throw validationError(
              `unknown economic value state filter ${String(state)}`,
              { state },
            );
          }
          return state as EconomicValueRecord["state"];
        });
      return repository.listByBeneficiary(
        organizationScopeId,
        beneficiaryPersonId,
        stateSet,
      );
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  EconomicValueSourceKind,
  RecordPendingValueInput,
  RecordPendingValueResult,
  MatureValueInput,
  ReverseValueInput,
  ExecutionContext,
};
