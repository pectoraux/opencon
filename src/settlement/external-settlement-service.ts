/**
 * NET-W030 — the external settlement service (issue #61; work order
 * spec/work-orders/NET-W030.md).
 *
 * The authenticated, fail-closed ingestion + exactly-once fact
 * recording + DERIVED deterministic reconciliation layer INSIDE the
 * /settlement boundary (SETTLE-001..003, ADAPTER-008; architecture-
 * lock §14 invariant 25: payment adapters provide transaction facts;
 * /settlement retains semantic authority).
 *
 * The command flow (work order §3.1/§3.2/§3.6):
 *
 * ```text
 * validate input (closed provider vocabulary)
 *   → route to the provider's NEUTRAL adapter (composition-root wired)
 *   → normalize (the adapter re-asserts its identity)
 *   → validate the neutral facts (closed vocabularies + bounded shapes)
 *   → verify the trust envelope (injected authenticator —
 *     SecretProvider material, fail closed, never recorded on false)
 *   → enforce freshness (observedAt window — stale fails closed)
 *   → identity mutex (org scope, provider, external id)
 *     → applyIdempotent (composite key)
 *         → SINGLE authoritative transaction
 *             ├── create-once identity backstop (in-tx)
 *             ├── correction-target resolution (in-tx, same-scope)
 *             ├── reconciliation DERIVATION (in-tx, from the
 *             │   authoritative ledger lineage of the SAME domain)
 *             ├── the fact record create (create-only — immutable)
 *             └── the buffered audit lineage (same tx; the derived
 *                 verdict travels in the event metadata)
 *         COMMIT — the fact + audit are durable together, or NOTHING
 * ```
 *
 * An external fact posts NO ledger entries, touches NO account, and
 * mints/consumes/reverses NOTHING: the only economic primitives
 * remain the EXISTING /settlement commands. Reconciliation is DERIVED
 * (the W020 evaluateClearingEligibility discipline): no command
 * asserts, stores or waives a verdict, and a mismatch is recorded +
 * audited (the mismatch-observation event on derivation; the verdict
 * in the recording event's metadata), never auto-corrected.
 *
 * Privacy (PRIV-002): rejection errors carry machine-readable reasons
 * plus bounded identifiers only — never payload content, signatures
 * or key material.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { EconomicUnitType } from "../core/economics.ts";
import type {
  EconomicLedgerTransaction,
  ExternalSettlementFactRecord,
  ExternalSettlementReconciliationCheck,
  ExternalSettlementFactRepository,
  ExternalSettlementProviderAdapter,
  ExternalSettlementReconciliationView,
  ExternalSettlementService,
  ExternalSettlementServiceDeps,
  ExternalSettlementTransactionFacts,
  ExternalSettlementRejectionReason,
  RecordExternalSettlementFactInput,
  RecordExternalSettlementFactResult,
} from "./port.ts";
import {
  EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT,
  isExternalSettlementProvider,
} from "./port.ts";
import {
  isExternalSettlementObservationFresh,
  ledgerTransactionUnitAmount,
  validateExternalSettlementFacts,
} from "./external-settlement-input.ts";

/**
 * The machine-readable ingestion rejection (work order §3.2): a
 * closed reason from EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS
 * in the error context. Classification is `validation` for gate
 * failures and `conflict` for the exactly-once identity conflict.
 */
export class ExternalSettlementIngestionError extends OpenConError {
  public constructor(
    reason: ExternalSettlementRejectionReason,
    message: string,
    options: {
      readonly classification?: "validation" | "conflict";
      readonly context?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super({
      code: "EXTERNAL_SETTLEMENT_INGESTION_REJECTED",
      classification: options.classification ?? "validation",
      message,
      retryable: false,
      context: { reason, ...(options.context ?? {}) },
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
  }
}

const IDENTITY_LOCK_PREFIX = "external_settlement_fact_identity";
const IDEMPOTENCY_PREFIX = "external_settlement_fact";

function substanceOf(record: {
  readonly internalTransactionId: string;
  readonly reportedAmount: number;
  readonly reportedUnit: string;
  readonly observedAt: string;
  readonly correctionOf: string | null;
}): string {
  return JSON.stringify([
    record.internalTransactionId,
    record.reportedAmount,
    record.reportedUnit,
    record.observedAt,
    record.correctionOf,
  ]);
}

export function createExternalSettlementService(
  deps: ExternalSettlementServiceDeps,
): ExternalSettlementService {
  const { repository, ledgerRepository, adapters, authenticator, idempotency, auditWriter, logger } =
    deps;
  const now = deps.now ?? (() => Date.now());

  // ---- The DERIVED reconciliation (work order §3.3) ----------------------
  //
  // Deterministic, server-side, pure over (fact, authoritative
  // ledger lineage). Cross-scope lineage resolves as NOT FOUND
  // (recorded-yet and cross-tenant are indistinguishable — no
  // existence oracle). `readTransaction` is the in-tx twin inside the
  // recording transaction and the committed read on evaluation
  // (ledger transactions are immutable after creation, so both reads
  // return the same authoritative content).
  async function deriveReconciliation(
    organizationScopeId: string,
    fact: {
      readonly id: string;
      readonly provider: string;
      readonly externalId: string;
      readonly internalTransactionId: string;
      readonly reportedAmount: number;
      readonly reportedUnit: EconomicUnitType;
    },
    readTransaction: (id: string) => Promise<EconomicLedgerTransaction | null>,
  ): Promise<ExternalSettlementReconciliationView> {
    const resolved = await readTransaction(fact.internalTransactionId);
    const scoped =
      resolved !== null && resolved.organizationScopeId === organizationScopeId
        ? resolved
        : null;

    const checks: ExternalSettlementReconciliationCheck[] = [];
    if (scoped === null) {
      checks.push({
        check: "internal_lineage_resolved",
        satisfied: false,
        reason: "internal_lineage_not_found",
        detail: { internalTransactionId: fact.internalTransactionId },
      });
      return {
        factId: fact.id,
        organizationScopeId,
        provider: fact.provider,
        externalId: fact.externalId,
        internalTransactionId: fact.internalTransactionId,
        verdict: "pending",
        reason: "internal_lineage_not_found",
        checks,
        internalTransaction: null,
        derivedAt: new Date().toISOString(),
      };
    }
    checks.push({
      check: "internal_lineage_resolved",
      satisfied: true,
      reason: "lineage_resolved",
      detail: {
        kind: scoped.kind,
        recordedAt: scoped.recordedAt,
      },
    });

    const unitEntries = scoped.entries.filter((e) => e.unit === fact.reportedUnit);
    if (unitEntries.length === 0) {
      checks.push({
        check: "reported_unit_present",
        satisfied: false,
        reason: "unit_absent_in_lineage",
        detail: {
          reportedUnit: fact.reportedUnit,
          lineageUnits: [...new Set(scoped.entries.map((e) => e.unit))].sort(),
        },
      });
      return {
        factId: fact.id,
        organizationScopeId,
        provider: fact.provider,
        externalId: fact.externalId,
        internalTransactionId: fact.internalTransactionId,
        verdict: "mismatched",
        reason: "unit_absent_in_lineage",
        checks,
        internalTransaction: {
          id: fact.internalTransactionId,
          kind: scoped.kind,
          recordedAt: scoped.recordedAt,
          unitAmount: 0,
        },
        derivedAt: new Date().toISOString(),
      };
    }
    checks.push({
      check: "reported_unit_present",
      satisfied: true,
      reason: "unit_present",
      detail: { reportedUnit: fact.reportedUnit },
    });

    const unitAmount = ledgerTransactionUnitAmount(scoped, fact.reportedUnit);
    const matched = unitAmount === fact.reportedAmount;
    checks.push({
      check: "reported_amount_agrees",
      satisfied: matched,
      reason: matched ? "amount_matched" : "amount_mismatched",
      detail: {
        reportedAmount: fact.reportedAmount,
        lineageUnitAmount: unitAmount,
      },
    });
    return {
      factId: fact.id,
      organizationScopeId,
      provider: fact.provider,
      externalId: fact.externalId,
      internalTransactionId: fact.internalTransactionId,
      verdict: matched ? "matched" : "mismatched",
      reason: matched ? "amount_matched" : "amount_mismatched",
      checks,
      internalTransaction: {
        id: fact.internalTransactionId,
        kind: scoped.kind,
        recordedAt: scoped.recordedAt,
        unitAmount,
      },
      derivedAt: new Date().toISOString(),
    };
  }

  async function loadScopedFact(
    organizationScopeId: string,
    factId: string,
  ): Promise<ExternalSettlementFactRecord | null> {
    const fact = await repository.findById(factId);
    // Cross-tenant and nonexistent are indistinguishable (no
    // existence oracle).
    return fact !== null && fact.organizationScopeId === organizationScopeId ? fact : null;
  }

  const service: ExternalSettlementService = {
    async recordExternalSettlementFact(execution, input) {
      // ---- Input validation (pure, closed vocabulary) -------------------
      if (!input.organizationScopeId.trim()) {
        throw new ExternalSettlementIngestionError(
          "malformed_submission",
          "external settlement fact ingestion requires a non-empty organizationScopeId",
          { context: { field: "organizationScopeId" } },
        );
      }
      if (!input.idempotencyKey.trim()) {
        throw new ExternalSettlementIngestionError(
          "malformed_submission",
          "external settlement fact ingestion requires a non-empty idempotencyKey",
          { context: { field: "idempotencyKey" } },
        );
      }
      if (!isExternalSettlementProvider(input.provider)) {
        throw new ExternalSettlementIngestionError(
          "unsupported_provider",
          `the external settlement provider vocabulary does not contain provider "${input.provider}"`,
          { context: { provider: input.provider } },
        );
      }

      // ---- Route to the provider's NEUTRAL adapter -----------------------
      const adapter = adapters.find(
        (a) => a.info.kind === "external_settlement" && a.info.provider === input.provider,
      );
      if (!adapter) {
        throw new ExternalSettlementIngestionError(
          "unsupported_provider",
          `no external settlement adapter is wired for provider "${input.provider}"`,
          { context: { provider: input.provider } },
        );
      }

      // ---- Normalize (the adapter re-asserts its own identity) ----------
      let facts: ExternalSettlementTransactionFacts;
      try {
        facts = await adapter.normalizeTransaction({
          providerId: input.provider,
          payload: input.payload,
        });
      } catch (err) {
        throw new ExternalSettlementIngestionError(
          "malformed_submission",
          "the provider adapter rejected the raw submission payload",
          { context: { provider: input.provider }, cause: err },
        );
      }

      // ---- Closed-vocabulary + shape validation (pure) -------------------
      const issues = validateExternalSettlementFacts(facts, input.provider);
      const issue = issues[0];
      if (issue) {
        throw new ExternalSettlementIngestionError(
          issue.reason,
          `the adapter-normalized external settlement submission failed validation (${issue.reason} on ${issue.field})`,
          { context: { provider: input.provider, field: issue.field } },
        );
      }

      // ---- Authentication (fail closed — NEVER recorded on false) -------
      const authenticated = authenticator.verify(facts);
      if (!authenticated) {
        throw new ExternalSettlementIngestionError(
          "unauthenticated",
          "the external settlement submission's trust envelope could not be verified — ingestion fails closed",
          { context: { provider: facts.provider, externalId: facts.externalId } },
        );
      }

      // ---- Freshness (the W023 semantics; stale fails closed) -----------
      if (!isExternalSettlementObservationFresh(facts.observedAt, now())) {
        throw new ExternalSettlementIngestionError(
          "stale",
          "the external settlement observation is older than the freshness window — ingestion fails closed",
          { context: { provider: facts.provider, externalId: facts.externalId } },
        );
      }

      // ---- Identity mutex → ONE authoritative transaction ----------------
      const identityLock = `${IDENTITY_LOCK_PREFIX}:${input.organizationScopeId}:${facts.provider}:${facts.externalId}`;
      const applied = await idempotency.withLock(identityLock, () =>
        idempotency.applyIdempotent(
          `${IDEMPOTENCY_PREFIX}:${input.organizationScopeId}:${facts.provider}:${facts.externalId}:${input.idempotencyKey}`,
          async (ctx) => {
            const tx = ctx.transaction;

            // -- Create-once identity backstop (in-tx) --------------------
            const existing = await repository.findByIdentityWithinTx(
              input.organizationScopeId,
              facts.provider,
              facts.externalId,
              tx,
            );
            if (existing) {
              if (substanceOf(existing) === substanceOf(facts)) {
                // Same identity + same substance: the committed record
                // replays verbatim (exactly-once; a different idempotency
                // key changes nothing).
                const reconciliation = await deriveReconciliation(
                  input.organizationScopeId,
                  existing,
                  (id) => ledgerRepository.findTransactionWithinTx(id, tx),
                );
                return { fact: existing, created: false, reconciliation };
              }
              throw new ExternalSettlementIngestionError(
                "conflicting_fact",
                `an external settlement fact with provider "${facts.provider}" external id "${facts.externalId}" is already recorded with a different substance — the identity is exactly-once and facts are immutable`,
                {
                  classification: "conflict",
                  context: {
                    provider: facts.provider,
                    externalId: facts.externalId,
                    organizationScopeId: input.organizationScopeId,
                  },
                },
              );
            }

            // -- Correction-target resolution (in-tx, same scope) ---------
            if (facts.correctionOf !== null) {
              const target = await repository.findByIdWithinTx(facts.correctionOf, tx);
              if (target === null || target.organizationScopeId !== input.organizationScopeId) {
                throw new ExternalSettlementIngestionError(
                  "correction_target_not_found",
                  `the correction target fact "${facts.correctionOf}" does not resolve in organization scope "${input.organizationScopeId}" — ingestion fails closed`,
                  {
                    context: {
                      provider: facts.provider,
                      externalId: facts.externalId,
                      correctionOf: facts.correctionOf,
                    },
                  },
                );
              }
            }

            // -- The fact record (create-only; immutable after recording) -
            const record: ExternalSettlementFactRecord = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              provider: facts.provider,
              providerVersion: facts.providerVersion,
              externalId: facts.externalId,
              internalTransactionId: facts.internalTransactionId,
              reportedAmount: facts.reportedAmount,
              reportedUnit: facts.reportedUnit as EconomicUnitType,
              observedAt: facts.observedAt,
              recordedAt: new Date().toISOString(),
              correctionOf: facts.correctionOf,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
              recordFormat: EXTERNAL_SETTLEMENT_FACT_RECORD_FORMAT,
            });

            // -- In-tx reconciliation derivation (the authoritative
            //    ledger lineage of the SAME domain) ----------------------
            const reconciliation = await deriveReconciliation(
              input.organizationScopeId,
              record,
              (id) => ledgerRepository.findTransactionWithinTx(id, tx),
            );

            // -- Atomic mutation + audit (post-commit publication) --------
            await repository.createWithinTx(record, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: "external_settlement_fact.recorded",
              context: execution,
              actor: execution.actor?.id ?? null,
              subject: record.id,
              resourceType: "external_settlement_fact",
              resourceId: record.id,
              metadata: {
                provider: record.provider,
                providerVersion: record.providerVersion,
                externalId: record.externalId,
                internalTransactionId: record.internalTransactionId,
                reportedAmount: record.reportedAmount,
                reportedUnit: record.reportedUnit,
                correctionOf: record.correctionOf,
                organizationScopeId: record.organizationScopeId,
                reconciliationVerdict: reconciliation.verdict,
                reconciliationReason: reconciliation.reason,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return { fact: record, created: true, reconciliation };
          },
          execution,
        ),
      );

      // `created` reflects whether THIS call committed a new fact
      // record: an idempotency-layer replay (same composite key)
      // reports the committed record verbatim with created: false
      // (the W008 value-service `applied.executed` mapping); a fresh
      // apply that found the identity already committed (a different
      // key, same substance) also reports created: false from the
      // callback body.
      const created = applied.executed ? applied.result.created : false;
      logger.info("external_settlement_fact.recorded", {
        factId: applied.result.fact.id,
        provider: applied.result.fact.provider,
        externalId: applied.result.fact.externalId,
        verdict: applied.result.reconciliation.verdict,
        created,
      });
      return {
        fact: applied.result.fact,
        created,
        reconciliation: applied.result.reconciliation,
      };
    },

    async getExternalSettlementFact(_execution, organizationScopeId, factId) {
      return loadScopedFact(organizationScopeId, factId);
    },

    async listExternalSettlementFacts(_execution, organizationScopeId) {
      return repository.listByOrganization(organizationScopeId);
    },

    async listExternalSettlementFactsByTransaction(
      _execution,
      organizationScopeId,
      internalTransactionId,
    ) {
      return repository.listByInternalTransaction(organizationScopeId, internalTransactionId);
    },

    async evaluateExternalSettlementReconciliation(execution, input) {
      const fact = await loadScopedFact(input.organizationScopeId, input.factId);
      if (fact === null) {
        throw new NotFoundError(
          `external settlement fact not found: ${input.factId}`,
          { factId: input.factId },
        );
      }
      const view = await deriveReconciliation(
        input.organizationScopeId,
        fact,
        (id) => ledgerRepository.findTransaction(id),
      );
      // A mismatch is recorded + audited (work order §3.3) — the
      // DERIVED verdict observation, never an auto-correction. The
      // direct append (post-decision, non-transactional observation)
      // follows the audit writer's append-only contract.
      if (view.verdict === "mismatched") {
        await auditWriter.append({
          eventType: "external_settlement_fact.mismatch_observed",
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: fact.id,
          resourceType: "external_settlement_fact",
          resourceId: fact.id,
          metadata: {
            provider: fact.provider,
            externalId: fact.externalId,
            internalTransactionId: fact.internalTransactionId,
            reconciliationVerdict: view.verdict,
            reconciliationReason: view.reason,
            organizationScopeId: fact.organizationScopeId,
          },
        });
      }
      return view;
    },
  };

  return service;
}
