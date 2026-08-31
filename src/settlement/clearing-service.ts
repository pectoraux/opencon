/**
 * CrossPromotionClearingService — the NET-W020 clearing records +
 * the DERIVED eligibility view (work order §3.2/§3.3).
 *
 * Architecture ref: spec/architecture.md §5 (economic model), §17
 * (authoritative workflow), §18 (/settlement owns settlement);
 * spec/architecture-lock.md §5 (economic authority), §12 (execution
 * lineage), §13 (economic safety invariants 19–21).
 *
 * AUTHORITY MODEL (the decision of record, work order §2 + §3.7a —
 * the PR #40 remediation: THE SINGLE AUTHORITATIVE TRANSACTION):
 *  - executeCrossPromotionClearing (below) is the WHOLE clearing
 *    operation — qualify → risk/dispute gate → draw → clearing record
 *    → campaign bookkeeping — as ONE exactly-once economic unit in ONE
 *    authoritative transaction (one IdempotencyStore.applyIdempotent,
 *    one AuthorityTransaction, one COMMIT). The draw runs through the
 *    SAME-domain `...WithinTx` primitives (never the transaction-
 *    owning commands); a failed authoritative COMMIT leaves NO partial
 *    economic mutation; a same-key retry replays the committed
 *    composite result. NO compensating reversal exists on this path;
 *  - this service owns the CLEARING RECORDS (pure lineage — references
 *    + the re-derived eligibility snapshot + the verified draw result);
 *    it posts NOTHING to the ledger (no new account/transaction/value
 *    source kind exists) and creates no balances: /settlement stays
 *    the SOLE economic authority;
 *  - every cross-domain fact arrives READ-ONLY through the neutral
 *    lookups (contribution qualification over /contributions + W012/
 *    W013 derived states; placement settlement readiness over
 *    /inventory — the W019 derived gate; clearing rules over
 *    /campaigns; the risk/dispute gate over /disputes) and the
 *    campaign bookkeeping participates IN the clearing transaction
 *    through the neutral bookkeeping port (wired at the composition
 *    root; /campaigns stays the bookkeeping authority);
 *  - eligibility is RE-DERIVED inside the AUTHORITATIVE clearing
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
import type { IdempotentApplyContext } from "../core/idempotency.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  ClearingCampaignBookkeepingInput,
  ClearingCampaignRuleLookup,
  ClearingContributionLookup,
  ClearingGateLookup,
  ClearingGateView,
  ClearingLookups,
  ClearingPlacementLookup,
  ClearingRuleView,
  CashObligation,
  CreditIssuance,
  CrossPromotionClearingRecord,
  CrossPromotionClearingRepository,
  CrossPromotionClearingService,
  CrossPromotionClearingServiceDeps,
  EconomicValueRecord,
  ExecuteCrossPromotionClearingInput,
  ExecuteCrossPromotionClearingResult,
  RecordCrossPromotionClearingInput,
  RecordCrossPromotionClearingResult,
  RewardAllocation,
  RewardAllocationPolicyRepository,
} from "./port.ts";
import { allocationAccountIds } from "./reward-service.ts";
import { issuanceAccountIds } from "./credit-service.ts";
import { obligationAccountIds } from "./cash-service.ts";
import { valueRecordLockKey, withEconomicLocks } from "./posting.ts";
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

/**
 * The hard-refusal error from a not-clear gate view — the UNIFORM
 * codes (RISK_CONTROL / DISPUTE_CHALLENGE, the W014 discipline) with
 * the view's own context (the composition root's lookup adapter
 * carries the offending subject ids in `detail`; the settlement side
 * deliberately surfaces only the reference identifiers — the dispute
 * LIFECYCLE stays /disputes' authority).
 */
function clearingGateError(
  view: ClearingGateView,
  organizationScopeId: string,
  personSubjectId: string | null,
): OpenConError {
  if (view.source === "risk_control") {
    return new OpenConError({
      code: "RISK_CONTROL",
      classification: "precondition",
      message: `operation ${String(view.detail.operationClass)} is refused: active risk control ${String(view.controlId)} (${String(view.detail.action)}) covers this subject`,
      context: {
        controlDecisionId: view.controlId,
        action: view.detail.action ?? null,
        operationClass: view.detail.operationClass ?? null,
        originAssessmentId: view.detail.originAssessmentId ?? null,
        originCaseId: view.detail.originCaseId ?? null,
        recordSubjectId: view.detail.recordSubjectId ?? null,
        personSubjectId,
        organizationScopeId,
      },
    });
  }
  return new OpenConError({
    code: "DISPUTE_CHALLENGE",
    classification: "precondition",
    message: `operation is refused: active dispute ${String(view.disputeId)} (${String(view.detail.subjectType)}:${String(view.detail.subjectId)}) covers this record`,
    context: {
      disputeId: view.disputeId,
      disputeKind: view.detail.disputeKind ?? null,
      subjectType: view.detail.subjectType ?? null,
      subjectId: view.detail.subjectId ?? null,
      organizationScopeId,
    },
  });
}

/**
 * The hard gate pass (the W014 discipline, inside the composite):
 * risk controls + ACTIVE disputes over the value record, EVERY
 * upstream source id (including the contribution) and the placement
 * id, with the value beneficiary AND the placement owner as person
 * subjects — BEFORE the draw (AC-06). Uniform hard-refusal codes.
 */
async function assertClearingGatesClear(
  lookup: ClearingGateLookup,
  organizationScopeId: string,
  value: ClearingValueView,
  targetPlacementId: string,
  rule: ClearingRuleView,
  placementOwnerPersonId: string | null,
): Promise<void> {
  const subjectIds = clearingGateSubjectIds(value, targetPlacementId);
  const operationClass = clearingOperationClass(rule.drawKind);
  const primary = await lookup.assess({
    organizationScopeId,
    operationClass,
    recordSubjectIds: subjectIds,
    personSubjectId: value.beneficiaryPersonId,
  });
  if (!primary.clear) {
    throw clearingGateError(primary, organizationScopeId, value.beneficiaryPersonId);
  }
  if (placementOwnerPersonId && placementOwnerPersonId.trim() !== "") {
    const ownerPass = await lookup.assess({
      organizationScopeId,
      operationClass,
      recordSubjectIds: [targetPlacementId],
      personSubjectId: placementOwnerPersonId,
    });
    if (!ownerPass.clear) {
      throw clearingGateError(ownerPass, organizationScopeId, placementOwnerPersonId);
    }
  }
}

/**
 * Resolve the requested rule from a campaign view (the shared
 * pre-flight/in-tx resolution: explicit id → the single declared
 * rule).
 */
function resolveRequestedRule(
  campaign: ClearingCampaignView | null,
  requestedRuleId: string | null,
): ClearingRuleView | null {
  if (!campaign || campaign.administrativeStatus !== "ACTIVE") return null;
  const rules = campaign.clearingRules;
  if (requestedRuleId !== null) {
    return rules.find((r) => r.id === requestedRuleId) ?? null;
  }
  return rules.length === 1 ? rules[0]! : null;
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
    rewardService,
    creditService,
    cashService,
    rewardPolicyRepository,
    campaignBookkeeping,
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
    async executeCrossPromotionClearing(
      execution,
      input,
    ): Promise<ExecuteCrossPromotionClearingResult> {
      // ---- Validation (pure, before anything) -----------------------
      for (const [field, value] of [
        ["sourceContributionId", input.sourceContributionId],
        ["targetPlacementId", input.targetPlacementId],
        ["valueRecordId", input.valueRecordId],
        ["idempotencyKey", input.idempotencyKey],
      ] as const) {
        if (!value?.trim()) {
          throw validationError(`${field} is required`, { field }, "validation");
        }
      }
      const requestedRuleId =
        typeof input.clearingRuleId === "string" &&
        input.clearingRuleId.trim() !== ""
          ? input.clearingRuleId
          : null;

      // ---- THE TENANT ANCHOR (the economic authority's own record) --
      // A missing or cross-scope record fails closed before anything.
      const value = await valueRepository.findById(input.valueRecordId);
      if (!value) {
        throw new NotFoundError(
          `economic value record not found: ${input.valueRecordId}`,
          { valueRecordId: input.valueRecordId },
        );
      }
      const organizationScopeId = value.organizationScopeId;

      // ---- THE WHOLE OPERATION under the advisory pair mutex -------
      // (ONE clearing per contribution-placement pair; the in-tx
      // create-once check is the durable backstop).
      return idempotency.withLock(
        clearingPairLockKey(
          organizationScopeId,
          input.sourceContributionId,
          input.targetPlacementId,
        ),
        async (): Promise<ExecuteCrossPromotionClearingResult> => {
          // Pre-flight pair check (fast-fail, committed read): a
          // CLEARED pair under a DIFFERENT key refuses BEFORE any
          // economic mutation; the SAME key is the replay path.
          const existingPair = await clearingRepository.findByPair(
            organizationScopeId,
            input.sourceContributionId,
            input.targetPlacementId,
          );
          if (
            existingPair &&
            existingPair.idempotencyKey !== input.idempotencyKey
          ) {
            throw new CrossPromotionClearingConflictError(
              `contribution ${input.sourceContributionId} and placement ${input.targetPlacementId} were already cleared (clearing ${existingPair.id}) — one clearing per contribution-placement pair`,
              {
                organizationScopeId,
                sourceContributionId: input.sourceContributionId,
                targetPlacementId: input.targetPlacementId,
                existingClearingId: existingPair.id,
              },
            );
          }

          const compositeKey = `cross_promotion_clearing_execute:${organizationScopeId}:${input.sourceContributionId}:${input.targetPlacementId}:${input.idempotencyKey}`;
          if (existingPair) {
            // The SAME-KEY replay: the committed composite's stored
            // result replays verbatim with created:false. The atomic
            // commit guarantees the clearing record and the composite
            // idempotency record exist TOGETHER; a clearing record
            // WITHOUT the composite record can only predate the atomic
            // composite (or belong to the standalone record command) —
            // fail closed rather than adopt a foreign draw.
            const stored = await idempotency.get<ExecuteCrossPromotionClearingResult>(
              compositeKey,
            );
            if (stored) {
              logger.debug("cross_promotion_clearing.execute_replay", {
                organizationScopeId,
                clearingId: stored.result.clearing.id,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
              });
              return { ...stored.result, created: false };
            }
            throw new CrossPromotionClearingConflictError(
              `contribution ${input.sourceContributionId} and placement ${input.targetPlacementId} were already cleared (clearing ${existingPair.id}) under a foreign execution — one clearing per contribution-placement pair`,
              {
                organizationScopeId,
                sourceContributionId: input.sourceContributionId,
                targetPlacementId: input.targetPlacementId,
                existingClearingId: existingPair.id,
              },
            );
          }

          // ---- FRESH PATH: pre-flight gates + eligibility -----------
          // Hard gates FIRST (the W014 discipline — the uniform
          // hard-refusal error codes) with the resolved rule's
          // operation class, then the full derived eligibility trace.
          // These committed reads fast-fail BEFORE the transaction;
          // the IN-TX passes below are the authoritative backstops.
          const placement = await resolvePlacementView(
            lookups.placement,
            organizationScopeId,
            input.targetPlacementId,
          );
          const campaign = await resolveCampaignView(
            lookups.campaign,
            placement?.campaignId ?? null,
          );
          const gateRule = resolveRequestedRule(campaign, requestedRuleId);
          if (gateRule !== null) {
            await assertClearingGatesClear(
              lookups.gate,
              organizationScopeId,
              toValueView(value),
              input.targetPlacementId,
              gateRule,
              placement?.ownerPersonId ?? null,
            );
          }
          const evaluation = await deriveEvaluation(
            organizationScopeId,
            input.sourceContributionId,
            input.targetPlacementId,
            input.valueRecordId,
            requestedRuleId,
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
          if (
            rule.drawKind !== "reward_allocation" &&
            rule.drawKind !== "credit_issuance" &&
            rule.drawKind !== "cash_obligation"
          ) {
            throw validationError(
              `clearing rule ${rule.id} declares an unsupported draw kind ${rule.drawKind}`,
              { clearingRuleId: rule.id, drawKind: rule.drawKind },
            );
          }
          // TS narrowing (the W018 capture-local pattern).
          const drawKind: CrossPromotionClearingRecord["drawKind"] = rule.drawKind;

          // ---- Draw-parameter validation (the pre-draw bar) --------
          let creditsPerValueUnit: number | undefined;
          let cashKind: "payable" | "receivable" = "payable";
          let counterpartyPersonId: string | undefined;
          let cashAmount: number | undefined;
          if (drawKind === "credit_issuance") {
            creditsPerValueUnit = input.creditsPerValueUnit;
            if (
              creditsPerValueUnit === undefined ||
              !Number.isFinite(creditsPerValueUnit) ||
              creditsPerValueUnit <= 0
            ) {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "validation",
                message: "credit draw requires creditsPerValueUnit > 0",
                context: { creditsPerValueUnit: creditsPerValueUnit ?? null },
              });
            }
          } else if (drawKind === "cash_obligation") {
            const rawKind = input.cashKind ?? "payable";
            if (rawKind !== "payable" && rawKind !== "receivable") {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "validation",
                message: `cashKind must be payable | receivable (got ${String(rawKind)})`,
                context: { cashKind: rawKind },
              });
            }
            cashKind = rawKind;
            counterpartyPersonId = input.counterpartyPersonId;
            if (!counterpartyPersonId || !String(counterpartyPersonId).trim()) {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "validation",
                message: "cash draw requires counterpartyPersonId",
                context: {},
              });
            }
            cashAmount = input.cashAmount;
            if (
              cashAmount === undefined ||
              !Number.isFinite(cashAmount) ||
              cashAmount <= 0 ||
              cashAmount > rule.maxDrawAmount
            ) {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "validation",
                message: `cash draw amount must be > 0 and ≤ the rule max draw amount ${String(rule.maxDrawAmount)}`,
                context: {
                  cashAmount: cashAmount ?? null,
                  maxDrawAmount: rule.maxDrawAmount,
                },
              });
            }
          }

          // ---- The lock set (the EXACT keys the selected draw
          // primitive's standalone form would acquire — the reward
          // policy version is PINNED so the accounts locked and the
          // accounts posted are always the same set) ---------------
          let pinnedPolicyId: string | null = null;
          let pinnedPolicyVersion: number | undefined;
          let accountIds: readonly string[] = [];
          let recordLockKey: string | undefined;
          if (drawKind === "reward_allocation") {
            if (!rule.rewardPolicyId) {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "precondition",
                message: `clearing rule ${rule.id} draw kind reward_allocation requires a reward policy reference`,
                context: { clearingRuleId: rule.id },
              });
            }
            const pinned = await rewardPolicyRepository.findLatestVersion(
              rule.rewardPolicyId,
              undefined,
            );
            if (!pinned) {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "precondition",
                message: `clearing rule ${rule.id} references an unknown reward policy ${rule.rewardPolicyId}`,
                context: { clearingRuleId: rule.id, rewardPolicyId: rule.rewardPolicyId },
              });
            }
            if (pinned.organizationScopeId !== organizationScopeId) {
              throw new OpenConError({
                code: "ECONOMIC_VALIDATION",
                classification: "precondition",
                message: `reward policy ${pinned.policyId} belongs to organization scope ${pinned.organizationScopeId}, not ${organizationScopeId}`,
                context: {
                  clearingRuleId: rule.id,
                  rewardPolicyId: pinned.policyId,
                  policyScope: pinned.organizationScopeId,
                  inputScope: organizationScopeId,
                },
              });
            }
            pinnedPolicyId = pinned.policyId;
            pinnedPolicyVersion = pinned.version;
            accountIds = allocationAccountIds(
              organizationScopeId,
              value.beneficiaryPersonId,
              pinned.allocations.map((a) => a.beneficiaryPersonId),
            );
            recordLockKey = valueRecordLockKey(value.id);
          } else if (drawKind === "credit_issuance") {
            accountIds = issuanceAccountIds(
              organizationScopeId,
              value.beneficiaryPersonId,
            );
            recordLockKey = valueRecordLockKey(value.id);
          } else {
            accountIds = obligationAccountIds(
              organizationScopeId,
              cashKind,
              counterpartyPersonId!,
            );
          }
          if (!placement || !campaign) {
            // Unreachable when eligibility passed (the evaluator
            // requires a resolvable placement bound to the campaign).
            throw validationError(
              "internal: eligibility passed without a resolvable placement/campaign binding",
              {
                targetPlacementId: input.targetPlacementId,
                resolvedPlacement: placement !== null,
                resolvedCampaign: campaign !== null,
              },
            );
          }

          // ---- THE SINGLE AUTHORITATIVE TRANSACTION ----------------
          // pair mutex → campaign bookkeeping lock → economic account
          // locks → ONE applyIdempotent → ONE AuthorityTransaction:
          // in-tx fresh read → in-tx hard gates → in-tx eligibility
          // re-derivation → the draw WITHIN THE SAME TX → the
          // clearing record → the campaign bookkeeping → the buffered
          // audit lineage → COMMIT (everything, or nothing).
          return idempotency.withLock(
            campaignBookkeeping.bookkeepingLockKey(campaign.campaignId),
            () =>
              withEconomicLocks(
                idempotency,
                accountIds,
                async (): Promise<ExecuteCrossPromotionClearingResult> => {
                  const applied = await idempotency.applyIdempotent(
                    compositeKey,
                    async (ctx): Promise<ExecuteCrossPromotionClearingResult> => {
                      const tx = ctx.transaction;

                      // (1) In-tx fresh value read (TOCTOU closure).
                      const valueInTx = await valueRepository.findByIdWithinTx(
                        input.valueRecordId,
                        tx,
                      );
                      if (!valueInTx) {
                        throw new NotFoundError(
                          `economic value record not found: ${input.valueRecordId}`,
                          { valueRecordId: input.valueRecordId },
                        );
                      }
                      if (valueInTx.organizationScopeId !== organizationScopeId) {
                        throw validationError(
                          `economic value record ${valueInTx.id} belongs to organization scope ${valueInTx.organizationScopeId}, not ${organizationScopeId}`,
                          {
                            valueRecordId: valueInTx.id,
                            recordScope: valueInTx.organizationScopeId,
                            inputScope: organizationScopeId,
                          },
                        );
                      }

                      // (2) In-tx hard gates (the authoritative pass —
                      // the uniform hard-refusal codes; before any
                      // mutation, AC-06).
                      const placementInTx = await resolvePlacementView(
                        lookups.placement,
                        organizationScopeId,
                        input.targetPlacementId,
                      );
                      const campaignInTx = await resolveCampaignView(
                        lookups.campaign,
                        placementInTx?.campaignId ?? null,
                      );
                      const gateRuleInTx = resolveRequestedRule(
                        campaignInTx,
                        requestedRuleId,
                      );
                      if (gateRuleInTx !== null) {
                        await assertClearingGatesClear(
                          lookups.gate,
                          organizationScopeId,
                          toValueView(valueInTx),
                          input.targetPlacementId,
                          gateRuleInTx,
                          placementInTx?.ownerPersonId ?? null,
                        );
                      }

                      // (3) In-tx eligibility re-derivation (the
                      // authoritative pre-draw bar — nothing
                      // caller-asserted qualifies).
                      const evaluationInTx = await deriveEvaluation(
                        organizationScopeId,
                        input.sourceContributionId,
                        input.targetPlacementId,
                        input.valueRecordId,
                        requestedRuleId,
                        valueInTx,
                      );
                      if (!evaluationInTx.eligible || !evaluationInTx.resolvedRule) {
                        throw validationError(
                          `cross-promotion clearing for contribution ${input.sourceContributionId} and placement ${input.targetPlacementId} is not eligible: ${firstFailedCheckFragment(evaluationInTx)}`,
                          {
                            sourceContributionId: input.sourceContributionId,
                            targetPlacementId: input.targetPlacementId,
                            valueRecordId: input.valueRecordId,
                            failedChecks: evaluationInTx.checks
                              .filter((c) => !c.satisfied)
                              .map((c) => ({ check: c.check, reason: c.reason, detail: c.detail })),
                            checks: evaluationInTx.checks,
                          },
                        );
                      }
                      const ruleInTx: ClearingRuleView = evaluationInTx.resolvedRule;
                      if (ruleInTx.drawKind !== drawKind) {
                        // The campaign's CURRENT rule content drifted
                        // from the prepared draw — fail closed (the
                        // retry re-resolves everything).
                        throw validationError(
                          `the campaign's current clearing rule ${ruleInTx.id} draw kind is ${ruleInTx.drawKind}, not ${drawKind} — the clearing prepared a ${drawKind} draw (fail closed; retry re-resolves the rule)`,
                          {
                            clearingRuleId: ruleInTx.id,
                            currentDrawKind: ruleInTx.drawKind,
                            preparedDrawKind: drawKind,
                          },
                        );
                      }
                      if (
                        drawKind === "reward_allocation" &&
                        ruleInTx.rewardPolicyId !== pinnedPolicyId
                      ) {
                        // The pinned policy no longer matches the
                        // current rule content — fail closed (the
                        // locked accounts must always be the posted
                        // accounts).
                        throw validationError(
                          `the campaign's current clearing rule ${ruleInTx.id} references reward policy ${String(ruleInTx.rewardPolicyId)}, not the pinned ${String(pinnedPolicyId)} — fail closed; retry re-resolves the rule and its policy`,
                          {
                            clearingRuleId: ruleInTx.id,
                            currentRewardPolicyId: ruleInTx.rewardPolicyId,
                            pinnedRewardPolicyId: pinnedPolicyId,
                          },
                        );
                      }

                      // (4) THE DRAW — the same-domain primitive body on
                      // THIS transaction (posting + issuance/obligation
                      // record + exactly-once value consumption + the
                      // buffered audit event, all on ctx.transaction).
                      let allocation: RewardAllocation | undefined;
                      let issuance: CreditIssuance | undefined;
                      let obligation: CashObligation | undefined;
                      if (drawKind === "reward_allocation") {
                        allocation = await rewardService.allocateRewardsWithinTx(
                          execution,
                          {
                            organizationScopeId,
                            sourceValueRecordId: value.id,
                            policyId: pinnedPolicyId!,
                            version: pinnedPolicyVersion,
                            idempotencyKey: input.idempotencyKey,
                          },
                          ctx,
                        );
                      } else if (drawKind === "credit_issuance") {
                        issuance = await creditService.issueCreditsWithinTx(
                          execution,
                          {
                            organizationScopeId,
                            beneficiaryPersonId: valueInTx.beneficiaryPersonId,
                            sourceValueRecordId: value.id,
                            creditsPerValueUnit: creditsPerValueUnit!,
                            description: `cross-promotion clearing draw (credits) — rule ${rule.id}`,
                            idempotencyKey: input.idempotencyKey,
                          },
                          ctx,
                        );
                      } else {
                        obligation = await cashService.recordCashObligationWithinTx(
                          execution,
                          {
                            organizationScopeId,
                            kind: cashKind!,
                            counterpartyPersonId: counterpartyPersonId!,
                            amount: cashAmount!,
                            description: `cross-promotion clearing draw — rule ${rule.id}, value record ${value.id}, placement ${input.targetPlacementId}`,
                            idempotencyKey: input.idempotencyKey,
                          },
                          ctx,
                        );
                      }

                      // (5) THE CLEARING RECORD — the SAME record body
                      // (re-derives eligibility with the post-draw
                      // CONSUMED tolerance, verifies the STAGED draw
                      // result in-tx, the create-once pair backstop,
                      // the audit lineage) on THIS transaction.
                      const drawResultId =
                        allocation?.id ?? issuance?.id ?? obligation!.id;
                      const clearing =
                        await service.recordCrossPromotionClearingWithinTx(
                          execution,
                          {
                            organizationScopeId,
                            sourceContributionId: input.sourceContributionId,
                            targetPlacementId: input.targetPlacementId,
                            valueRecordId: value.id,
                            clearingRuleId: rule.id,
                            drawKind,
                            drawResultId,
                            idempotencyKey: input.idempotencyKey,
                          },
                          ctx,
                        );

                      // (6) THE CAMPAIGN BOOKKEEPING — the neutral port
                      // on THIS transaction (the event append + the
                      // audit lineage commit with everything else).
                      const bookkeeping =
                        await campaignBookkeeping.recordClearingExecutionWithinTx(
                          execution,
                          {
                            campaignId: clearing.campaignId,
                            clearingRuleId: rule.id,
                            drawKind,
                            valueRecordId: value.id,
                            resultId: drawResultId,
                            amount: clearing.amount,
                            description: `cross-promotion clearing draw (${drawKind === "reward_allocation" ? `reward allocation ${drawResultId}` : drawKind === "credit_issuance" ? `credit issuance ${drawResultId}` : `cash obligation ${drawResultId}`}, clearing ${clearing.id})`,
                            idempotencyKey: input.idempotencyKey,
                          },
                          ctx,
                        );

                      // (7) The committed composite outcome (the
                      // post-draw value state is read IN the
                      // transaction — deterministic on replay).
                      const valueAfter = await valueRepository.findByIdWithinTx(
                        input.valueRecordId,
                        tx,
                      );
                      const result: ExecuteCrossPromotionClearingResult = {
                        drawKind,
                        clearing,
                        ...(allocation !== undefined ? { allocation } : {}),
                        ...(issuance !== undefined ? { issuance } : {}),
                        ...(obligation !== undefined ? { obligation } : {}),
                        created: true,
                        value: valueAfter ?? valueInTx,
                        campaignEventCount: bookkeeping.eventCount,
                      };
                      return result;
                    },
                    execution,
                  );
                  // The committed composite outcome (created:true —
                  // the replay path replays the stored result with
                  // created:false BEFORE ever reaching this apply).
                  logger.info("cross_promotion_clearing.executed", {
                    clearingId: applied.result.clearing.id,
                    organizationScopeId,
                    drawKind: applied.result.drawKind,
                    amount: applied.result.clearing.amount,
                    campaignEventCount: applied.result.campaignEventCount,
                    executionId: execution.executionId,
                  });
                  return applied.result;
                },
                recordLockKey,
              ),
          );
        },
      );
    },

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
      // NOTE: pair-level serialization is the ATOMIC COMPOSITE's
      // contract — executeCrossPromotionClearing (below) holds the
      // advisory pair mutex (clearingPairLockKey) across the whole
      // operation. This standalone record command deliberately does
      // NOT acquire that mutex (IdempotencyStore.withLock is NOT
      // reentrant — re-acquiring here would deadlock the composite);
      // it is serialized per idempotency key by applyIdempotent, and
      // the in-tx create-once pair check below is the durable
      // backstop.
      const applied = await idempotency.applyIdempotent(
        key,
        (ctx) =>
          service.recordCrossPromotionClearingWithinTx(execution, input, ctx),
        execution,
      );
      logger.info("cross_promotion_clearing.recorded", {
        clearingId: applied.result.id,
        organizationScopeId: applied.result.organizationScopeId,
        drawKind: applied.result.drawKind,
        amount: applied.result.amount,
        created: applied.executed,
      });
      return { clearing: applied.result, created: applied.executed };
    },

    async recordCrossPromotionClearingWithinTx(execution, input, ctx) {
      // NET-W020 remediation (PR #40 review): the SAME record body the
      // standalone command commits, on the CALLER'S authoritative
      // transaction — the atomic composite below invokes THIS body
      // between the draw and the campaign bookkeeping so the clearing
      // record commits in the SAME transaction as the economic
      // mutation it verifies.
      // ---- Validation + narrowing (pure; mirrors the wrapper) --------
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
