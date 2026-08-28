/**
 * CrossPromotionClearingService — the NET-W020 clearing records +
 * the DERIVED eligibility view (work order §3.2/§3.3).
 *
 * Architecture ref: spec/architecture.md §5 (economic model), §17
 * (authoritative workflow), §18 (/settlement owns settlement);
 * spec/architecture-lock.md §5 (economic authority), §12 (execution
 * lineage), §13 (economic safety invariants 19–21).
 *
 * AUTHORITY MODEL (the decision of record, work order §2):
 *  - this service owns the CLEARING RECORDS (pure lineage — references
 *    + the re-derived eligibility snapshot + the verified draw result);
 *    it posts NOTHING to the ledger (no new account/transaction/value
 *    source kind exists) and creates no balances: /settlement stays
 *    the SOLE economic authority and the draws flow exclusively
 *    through the EXISTING allocateRewards / issueCredits /
 *    recordCashObligation primitives (composed at the bootstrap
 *    boundary);
 *  - every cross-domain fact arrives READ-ONLY through the neutral
 *    lookups (contribution qualification over /contributions + W012/
 *    W013 derived states; placement settlement readiness over
 *    /inventory — the W019 derived gate; clearing rules over
 *    /campaigns; the risk/dispute gate over /disputes);
 *  - eligibility is RE-DERIVED inside the AUTHORITATIVE record
 *    transaction — there is no caller-asserted eligibility input;
 *  - ONE clearing record per (sourceContributionId, targetPlacementId)
 *    — the advisory pair mutex serializes the whole composite and the
 *    in-tx create-once check is the durable backstop (the W019
 *    active-placement pair pattern);
 *  - no AI path exists anywhere in this surface.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  ClearingCampaignRuleLookup,
  ClearingContributionLookup,
  ClearingGateLookup,
  ClearingGateView,
  ClearingLookups,
  ClearingPlacementLookup,
  ClearingRuleView,
  CrossPromotionClearingRecord,
  CrossPromotionClearingRepository,
  CrossPromotionClearingService,
  CrossPromotionClearingServiceDeps,
  EconomicValueRecord,
  RecordCrossPromotionClearingInput,
  RecordCrossPromotionClearingResult,
} from "./port.ts";
import {
  clearingGateSubjectIds,
  clearingOperationClass,
  evaluateCrossPromotionClearing,
  type ClearingCampaignView,
  type ClearingContributionView,
  type ClearingPlacementView,
  type ClearingValueView,
  type CrossPromotionClearingEvaluation,
} from "./clearing-eligibility.ts";

const CLEARING_RECORDED = "cross_promotion_clearing.recorded" as const;

const VALIDATION = "CROSS_PROMOTION_CLEARING_VALIDATION" as const;
const CONFLICT = "CLEARING_CONFLICT" as const;

function validationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
  classification: "validation" | "precondition" = "precondition",
): OpenConError {
  return new OpenConError({
    code: VALIDATION,
    classification,
    message,
    context,
  });
}

/** The stable pair-conflict error (ONE clearing per pair — W019 pattern). */
export class CrossPromotionClearingConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: CONFLICT,
      classification: "conflict",
      message,
      retryable: false,
      context,
    });
  }
}

/** The advisory pair mutex key (serializes the whole clearing composite). */
export function clearingPairLockKey(
  organizationScopeId: string,
  sourceContributionId: string,
  targetPlacementId: string,
): string {
  return `cross_promotion_clearing_pair:${organizationScopeId}:${sourceContributionId}:${targetPlacementId}`;
}

/** The first failed check rendered as a deterministic message fragment. */
function firstFailedCheckFragment(
  evaluation: CrossPromotionClearingEvaluation,
): string {
  const failed = evaluation.checks.find((c) => !c.satisfied);
  if (!failed) return "no failed check";
  return `${failed.check} (${failed.reason})`;
}

// ---------------------------------------------------------------------------
// View resolution (committed reads through the neutral lookups + own repos)
// ---------------------------------------------------------------------------

async function resolveContributionView(
  lookup: ClearingContributionLookup,
  contributionId: string,
): Promise<ClearingContributionView | null> {
  const resolved = await lookup.resolve(contributionId);
  if (!resolved) return null;
  return {
    contributionId,
    organizationScopeId: resolved.organizationScopeId,
    lifecycleState: resolved.lifecycleState,
    contributorPersonId: resolved.contributorPersonId,
    proofOfHelpfulnessState: resolved.proofOfHelpfulnessState,
    moderationStatus: resolved.moderationStatus,
    qualityBand: resolved.qualityBand,
  };
}

async function resolvePlacementView(
  lookup: ClearingPlacementLookup,
  organizationScopeId: string,
  placementId: string,
): Promise<ClearingPlacementView | null> {
  const resolved = await lookup.readiness(organizationScopeId, placementId);
  if (!resolved) return null;
  return {
    placementId: resolved.placementId,
    organizationScopeId: resolved.organizationScopeId,
    campaignId: resolved.campaignId,
    campaignPolicyVersion: resolved.campaignPolicyVersion,
    ownerPersonId: resolved.ownerPersonId,
    settlementReady: resolved.settlementReady,
  };
}

async function resolveCampaignView(
  lookup: ClearingCampaignRuleLookup,
  campaignId: string | null,
): Promise<ClearingCampaignView | null> {
  if (!campaignId) return null;
  const resolved = await lookup.resolve(campaignId);
  if (!resolved) return null;
  return {
    campaignId: resolved.campaignId,
    organizationScopeId: resolved.organizationScopeId,
    administrativeStatus: resolved.administrativeStatus,
    currentPolicyVersion: resolved.currentPolicyVersion,
    clearingRules: resolved.clearingRules.map((rule) => ({
      id: rule.id,
      objectiveId: rule.objectiveId,
      basis: rule.basis,
      drawKind: rule.drawKind,
      rewardPolicyId: rule.rewardPolicyId,
      maxDrawAmount: rule.maxDrawAmount,
    })),
  };
}

/**
 * The gate view over the clearing source contexts: the value record +
 * every upstream source id (including the contribution) + the target
 * placement, with the value beneficiary as the person subject. When the
 * draw kind is known (a resolved rule), the exact operation class is
 * consulted; otherwise ALL THREE classes (a conservative view read —
 * the execution path enforces the precise class).
 */
async function resolveGateView(
  lookup: ClearingGateLookup,
  organizationScopeId: string,
  value: ClearingValueView,
  targetPlacementId: string,
  drawKind: string | null,
  personSubjectId: string,
): Promise<ClearingGateView> {
  const recordSubjectIds = clearingGateSubjectIds(value, targetPlacementId);
  const classes =
    drawKind !== null
      ? [clearingOperationClass(drawKind)]
      : ["reward_allocation", "credit_issuance", "cash_settlement"];
  for (const operationClass of classes) {
    const view = await lookup.assess({
      organizationScopeId,
      operationClass,
      recordSubjectIds,
      personSubjectId,
    });
    if (!view.clear) {
      return {
        clear: false,
        source: view.source,
        controlId: view.controlId,
        disputeId: view.disputeId,
        detail: {
          operationClass,
          ...view.detail,
        },
      };
    }
  }
  return {
    clear: true,
    source: null,
    controlId: null,
    disputeId: null,
    detail: {
      recordSubjectIds,
      personSubjectId,
      operationClasses: classes,
    },
  };
}

function toValueView(record: EconomicValueRecord): ClearingValueView {
  return {
    valueRecordId: record.id,
    organizationScopeId: record.organizationScopeId,
    state: record.state,
    amount: record.amount,
    beneficiaryPersonId: record.beneficiaryPersonId,
    sources: record.sources.map((s) => ({ kind: s.kind, id: s.id })),
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function createCrossPromotionClearingService(
  deps: CrossPromotionClearingServiceDeps,
): CrossPromotionClearingService {
  const {
    clearingRepository,
    valueRepository,
    allocationRepository,
    issuanceRepository,
    obligationRepository,
    lookups,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /** Resolve every view and run the PURE evaluator (read-only path). */
  async function deriveEvaluation(
    organizationScopeId: string,
    sourceContributionId: string,
    targetPlacementId: string,
    valueRecordId: string,
    requestedRuleId: string | null,
    value: EconomicValueRecord | null,
  ): Promise<CrossPromotionClearingEvaluation> {
    const contribution = await resolveContributionView(
      lookups.contribution,
      sourceContributionId,
    );
    const placement = await resolvePlacementView(
      lookups.placement,
      organizationScopeId,
      targetPlacementId,
    );
    const campaign = await resolveCampaignView(
      lookups.campaign,
      placement?.campaignId ?? null,
    );
    const valueView = value ? toValueView(value) : null;
    // The rule resolution needs a first pass for the gate's operation
    // class: derive the rule from the campaign view directly (pure).
    let drawKind: string | null = null;
    if (campaign && campaign.administrativeStatus === "ACTIVE") {
      const rules = campaign.clearingRules;
      const rule =
        requestedRuleId !== null
          ? rules.find((r) => r.id === requestedRuleId)
          : rules.length === 1
            ? rules[0]!
            : undefined;
      drawKind = rule ? rule.drawKind : null;
    }
    const gate = await resolveGateView(
      lookups.gate,
      organizationScopeId,
      valueView ?? {
        valueRecordId,
        organizationScopeId,
        state: "UNRESOLVED",
        amount: 0,
        beneficiaryPersonId: "",
        sources: [],
      },
      targetPlacementId,
      drawKind,
      value?.beneficiaryPersonId ?? "",
    );
    return evaluateCrossPromotionClearing({
      organizationScopeId,
      sourceContributionId,
      targetPlacementId,
      valueRecordId,
      requestedRuleId,
      contribution,
      placement,
      campaign,
      value: valueView,
      gate,
    });
  }

  const service: CrossPromotionClearingService = {
    async evaluateClearingEligibility(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        }, "validation");
      }
      if (!input.sourceContributionId?.trim()) {
        throw validationError("sourceContributionId is required", {
          field: "sourceContributionId",
        }, "validation");
      }
      if (!input.targetPlacementId?.trim()) {
        throw validationError("targetPlacementId is required", {
          field: "targetPlacementId",
        }, "validation");
      }
      if (!input.valueRecordId?.trim()) {
        throw validationError("valueRecordId is required", {
          field: "valueRecordId",
        }, "validation");
      }
      // The VALUE RECORD is the tenant anchor (the economic authority's
      // own record): a missing or cross-scope record is NOT FOUND — the
      // read fails closed before any view resolves.
      const value = await valueRepository.findById(input.valueRecordId);
      if (!value || value.organizationScopeId !== input.organizationScopeId) {
        throw new NotFoundError(
          `economic value record not found in scope ${input.organizationScopeId}: ${input.valueRecordId}`,
          { valueRecordId: input.valueRecordId },
        );
      }
      const evaluation = await deriveEvaluation(
        input.organizationScopeId,
        input.sourceContributionId,
        input.targetPlacementId,
        input.valueRecordId,
        input.clearingRuleId?.trim() || null,
        value,
      );
      logger.debug("cross_promotion_clearing.eligibility_evaluated", {
        organizationScopeId: input.organizationScopeId,
        sourceContributionId: input.sourceContributionId,
        targetPlacementId: input.targetPlacementId,
        eligible: evaluation.eligible,
        executionId: execution.executionId,
      });
      return {
        organizationScopeId: input.organizationScopeId,
        sourceContributionId: input.sourceContributionId,
        targetPlacementId: input.targetPlacementId,
        valueRecordId: input.valueRecordId,
        eligible: evaluation.eligible,
        checks: evaluation.checks,
        resolvedRule: evaluation.resolvedRule,
        evaluatedAt: new Date().toISOString(),
      };
    },

    async recordCrossPromotionClearing(execution, input) {
      // ---- Validation (pure, before the transaction) -------------------
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        }, "validation");
      }
      for (const [field, value] of [
        ["sourceContributionId", input.sourceContributionId],
        ["targetPlacementId", input.targetPlacementId],
        ["valueRecordId", input.valueRecordId],
        ["clearingRuleId", input.clearingRuleId],
        ["drawResultId", input.drawResultId],
        ["idempotencyKey", input.idempotencyKey],
      ] as const) {
        if (!value?.trim()) {
          throw validationError(`${field} is required`, { field }, "validation");
        }
      }
      if (
        input.drawKind !== "reward_allocation" &&
        input.drawKind !== "credit_issuance" &&
        input.drawKind !== "cash_obligation"
      ) {
        throw validationError(
          `drawKind must be reward_allocation | credit_issuance | cash_obligation (got ${String(input.drawKind)})`,
          { drawKind: input.drawKind },
          "validation",
        );
      }
      // TS narrowing (the W018 capture-local pattern).
      const drawKind: CrossPromotionClearingRecord["drawKind"] = input.drawKind;
      // Committed pre-flight reads (NotFound fast-fail; the in-tx
      // re-derivation below is the authoritative bar).
      const existingValue = await valueRepository.findById(input.valueRecordId);
      if (!existingValue) {
        throw new NotFoundError(
          `economic value record not found: ${input.valueRecordId}`,
          { valueRecordId: input.valueRecordId },
        );
      }
      if (existingValue.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `economic value record ${existingValue.id} belongs to organization scope ${existingValue.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            valueRecordId: existingValue.id,
            recordScope: existingValue.organizationScopeId,
            inputScope: input.organizationScopeId,
          },
        );
      }

      const key = `cross_promotion_clearing:${input.organizationScopeId}:${input.sourceContributionId}:${input.targetPlacementId}:${input.idempotencyKey}`;
      // NOTE: pair-level serialization is the COMPOSITE's contract —
      // the composition-root executeCrossPromotionClearing holds the
      // advisory pair mutex (clearingPairLockKey) across the whole
      // chain (pre-flight → draw → record → bookkeeping). This record
      // command deliberately does NOT re-acquire that mutex
      // (IdempotencyStore.withLock is NOT reentrant — re-acquiring
      // here would deadlock the composite); it is serialized per
      // idempotency key by applyIdempotent, and the in-tx create-once
      // pair check below is the durable backstop.
      const applied = await idempotency.applyIdempotent(key, async (ctx) => {
        const tx = ctx.transaction;

        // ---- In-tx fresh reads (TOCTOU closure) -------------------
        const value = await valueRepository.findByIdWithinTx(
          input.valueRecordId,
          tx,
        );
        if (!value) {
          throw new NotFoundError(
            `economic value record not found: ${input.valueRecordId}`,
            { valueRecordId: input.valueRecordId },
          );
        }
        if (value.organizationScopeId !== input.organizationScopeId) {
          throw validationError(
            `economic value record ${value.id} belongs to organization scope ${value.organizationScopeId}, not ${input.organizationScopeId}`,
            {
              valueRecordId: value.id,
              recordScope: value.organizationScopeId,
              inputScope: input.organizationScopeId,
            },
          );
        }

        // ---- THE IN-TX ELIGIBILITY RE-DERIVATION (AC-02) ----------
        // Nothing caller-asserted qualifies: the full trace is
        // re-derived from CURRENT authoritative records inside the
        // authoritative record transaction.
        const evaluation = await deriveEvaluation(
          input.organizationScopeId,
          input.sourceContributionId,
          input.targetPlacementId,
          input.valueRecordId,
          input.clearingRuleId,
          value,
        );
        if (!evaluation.eligible || !evaluation.resolvedRule) {
          throw validationError(
            `cross-promotion clearing for contribution ${input.sourceContributionId} and placement ${input.targetPlacementId} is not eligible: ${firstFailedCheckFragment(evaluation)}`,
            {
              sourceContributionId: input.sourceContributionId,
              targetPlacementId: input.targetPlacementId,
              valueRecordId: input.valueRecordId,
              failedChecks: evaluation.checks
                .filter((c) => !c.satisfied)
                .map((c) => ({ check: c.check, reason: c.reason, detail: c.detail })),
              checks: evaluation.checks,
            },
          );
        }
        const rule: ClearingRuleView = evaluation.resolvedRule;
        if (rule.drawKind !== drawKind) {
          throw validationError(
            `clearing rule ${rule.id} draw kind is ${rule.drawKind}, not ${drawKind} — the rule is the draw-kind authority`,
            {
              clearingRuleId: rule.id,
              ruleDrawKind: rule.drawKind,
              inputDrawKind: drawKind,
            },
          );
        }

        // ---- THE DRAW-RESULT VERIFICATION (same domain) -----------
        // The recorded draw must be a REAL, same-scope, same-value
        // primitive result — a fabricated reference cannot be
        // recorded (AC-07 lineage integrity).
        let amount: number;
        let drawTransactionId: string;
        if (drawKind === "reward_allocation") {
          const allocation = await allocationRepository.findByIdWithinTx(
            input.drawResultId,
            tx,
          );
          if (!allocation) {
            throw new NotFoundError(
              `reward allocation not found: ${input.drawResultId}`,
              { drawResultId: input.drawResultId },
            );
          }
          if (allocation.organizationScopeId !== input.organizationScopeId) {
            throw validationError(
              `reward allocation ${allocation.id} belongs to organization scope ${allocation.organizationScopeId}, not ${input.organizationScopeId}`,
              {
                drawResultId: allocation.id,
                allocationScope: allocation.organizationScopeId,
                inputScope: input.organizationScopeId,
              },
            );
          }
          if (allocation.sourceValueRecordId !== input.valueRecordId) {
            throw validationError(
              `reward allocation ${allocation.id} consumed value record ${allocation.sourceValueRecordId}, not ${input.valueRecordId}`,
              {
                drawResultId: allocation.id,
                allocationSourceValueRecordId: allocation.sourceValueRecordId,
                valueRecordId: input.valueRecordId,
              },
            );
          }
          amount = allocation.totalAllocated;
          drawTransactionId = allocation.transactionId;
        } else if (drawKind === "credit_issuance") {
          const issuance = await issuanceRepository.findByIdWithinTx(
            input.drawResultId,
            tx,
          );
          if (!issuance) {
            throw new NotFoundError(
              `credit issuance not found: ${input.drawResultId}`,
              { drawResultId: input.drawResultId },
            );
          }
          if (issuance.organizationScopeId !== input.organizationScopeId) {
            throw validationError(
              `credit issuance ${issuance.id} belongs to organization scope ${issuance.organizationScopeId}, not ${input.organizationScopeId}`,
              {
                drawResultId: issuance.id,
                issuanceScope: issuance.organizationScopeId,
                inputScope: input.organizationScopeId,
              },
            );
          }
          if (issuance.sourceValueRecordId !== input.valueRecordId) {
            throw validationError(
              `credit issuance ${issuance.id} consumed value record ${issuance.sourceValueRecordId}, not ${input.valueRecordId}`,
              {
                drawResultId: issuance.id,
                issuanceSourceValueRecordId: issuance.sourceValueRecordId,
                valueRecordId: input.valueRecordId,
              },
            );
          }
          amount = issuance.creditAmount;
          drawTransactionId = issuance.transactionId;
        } else {
          const obligation = await obligationRepository.findByIdWithinTx(
            input.drawResultId,
            tx,
          );
          if (!obligation) {
            throw new NotFoundError(
              `cash obligation not found: ${input.drawResultId}`,
              { drawResultId: input.drawResultId },
            );
          }
          if (obligation.organizationScopeId !== input.organizationScopeId) {
            throw validationError(
              `cash obligation ${obligation.id} belongs to organization scope ${obligation.organizationScopeId}, not ${input.organizationScopeId}`,
              {
                drawResultId: obligation.id,
                obligationScope: obligation.organizationScopeId,
                inputScope: input.organizationScopeId,
              },
            );
          }
          // Cash obligations are booked against the protocol (the
          // W014 composite binds the value record in the
          // description); the clearing record itself carries the
          // value-record lineage.
          amount = obligation.amount;
          drawTransactionId = obligation.transactionId;
        }
        if (amount > rule.maxDrawAmount) {
          throw validationError(
            `drawn amount ${String(amount)} exceeds clearing rule ${rule.id} max draw amount ${String(rule.maxDrawAmount)}`,
            {
              amount,
              clearingRuleId: rule.id,
              maxDrawAmount: rule.maxDrawAmount,
            },
          );
        }

        // ---- THE CREATE-ONCE PAIR CONSTRAINT (AC-04) --------------
        const existingPair = await clearingRepository.findByPairWithinTx(
          input.organizationScopeId,
          input.sourceContributionId,
          input.targetPlacementId,
          tx,
        );
        if (existingPair) {
          throw new CrossPromotionClearingConflictError(
            `contribution ${input.sourceContributionId} and placement ${input.targetPlacementId} were already cleared (clearing ${existingPair.id}) — one clearing per contribution-placement pair`,
            {
              organizationScopeId: input.organizationScopeId,
              sourceContributionId: input.sourceContributionId,
              targetPlacementId: input.targetPlacementId,
              existingClearingId: existingPair.id,
            },
          );
        }

        // ---- The record --------------------------------------------
        const placement = await resolvePlacementView(
          lookups.placement,
          input.organizationScopeId,
          input.targetPlacementId,
        );
        const campaign = await resolveCampaignView(
          lookups.campaign,
          placement?.campaignId ?? null,
        );
        const clearing: CrossPromotionClearingRecord = Object.freeze({
          id: randomUUID(),
          organizationScopeId: input.organizationScopeId,
          campaignId: campaign?.campaignId ?? "",
          campaignPolicyVersion: campaign?.currentPolicyVersion ?? 0,
          clearingRuleId: rule.id,
          sourceContributionId: input.sourceContributionId,
          targetPlacementId: input.targetPlacementId,
          valueRecordId: input.valueRecordId,
          drawKind,
          drawResultId: input.drawResultId,
          drawTransactionId,
          amount,
          eligibility: {
            eligible: true as const,
            checks: evaluation.checks.map((c) => ({
              check: c.check,
              satisfied: c.satisfied,
              reason: c.reason,
              detail: c.detail,
            })),
          },
          status: "cleared",
          clearedAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
        });
        await clearingRepository.createWithinTx(clearing, tx);

        // ---- THE AUDIT LINEAGE (invariant 7 / AC-07) --------------
        // Binds campaign + contribution + placement + clearing
        // record + idempotency record + authoritative transaction +
        // draw transaction + value record.
        const buffer = auditWriter.forTransaction(tx);
        await buffer.append({
          eventType: CLEARING_RECORDED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: clearing.id,
          resourceType: "cross_promotion_clearing",
          resourceId: clearing.id,
          metadata: {
            organizationScopeId: clearing.organizationScopeId,
            campaignId: clearing.campaignId,
            campaignPolicyVersion: clearing.campaignPolicyVersion,
            clearingRuleId: clearing.clearingRuleId,
            sourceContributionId: clearing.sourceContributionId,
            targetPlacementId: clearing.targetPlacementId,
            valueRecordId: clearing.valueRecordId,
            drawKind: clearing.drawKind,
            drawResultId: clearing.drawResultId,
            drawTransactionId: clearing.drawTransactionId,
            amount: clearing.amount,
            eligibilityChecks: clearing.eligibility.checks.map(
              (c) => `${c.check}:${c.satisfied ? "satisfied" : c.reason}`,
            ),
            idempotencyKey: clearing.idempotencyKey,
            idempotencyRecordId: ctx.recordId,
            transactionId: tx.transactionId,
          },
        });
        return clearing;
      }, execution);
      logger.info("cross_promotion_clearing.recorded", {
        clearingId: applied.result.id,
        organizationScopeId: applied.result.organizationScopeId,
        drawKind: applied.result.drawKind,
        amount: applied.result.amount,
        created: applied.executed,
      });
      return { clearing: applied.result, created: applied.executed };
    },

    async getCrossPromotionClearing(_execution, organizationScopeId, clearingId) {
      const found = await clearingRepository.findById(clearingId);
      if (!found || found.organizationScopeId !== organizationScopeId) {
        throw new NotFoundError(
          `cross-promotion clearing not found in scope ${organizationScopeId}: ${clearingId}`,
          { clearingId },
        );
      }
      return found;
    },

    async listCrossPromotionClearings(_execution, organizationScopeId) {
      return clearingRepository.listByOrganization(organizationScopeId);
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
export type {
  AuthorityTransaction,
  ExecutionContext,
  RecordCrossPromotionClearingInput,
  RecordCrossPromotionClearingResult,
};
