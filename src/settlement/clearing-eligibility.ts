/**
 * Cross-promotion clearing eligibility — the PURE evaluator
 * (NET-W020 §3.2; the NET-W019 eligibility-engine precedent).
 *
 * Architecture ref: spec/architecture.md §5 (economic model),
 * §17 (authoritative workflow — the ledger consumes VERIFIED upstream
 * records), §18 (/settlement owns settlement); spec/architecture-lock.md
 * §5 (economic authority), §12 (execution lineage), §13 (economic
 * safety invariants 19–21).
 *
 * The evaluator is a TOTAL, DETERMINISTIC function over the resolved
 * structural views: it never performs I/O, never consults a clock, and
 * never short-circuits — every applicable check appears in the trace
 * with a machine-readable reason. The service layer resolves the views
 * through the neutral lookups (composition-root wired over the OWNING
 * authorities: /contributions, /inventory, /campaigns, /disputes) and
 * the value repository; the caller can only REFERENCE records — every
 * eligibility fact below is DERIVED (there is no caller-asserted
 * eligibility input anywhere in the boundary).
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

// ---------------------------------------------------------------------------
// Structural input views (resolved by the service through neutral lookups)
// ---------------------------------------------------------------------------

/** The resolved source-contribution qualification view (the W014 bar). */
export interface ClearingContributionView {
  readonly contributionId: string;
  readonly organizationScopeId: string;
  /** The /workflows authority's lifecycle state (read-only here). */
  readonly lifecycleState: string;
  readonly contributorPersonId: string;
  /** The verified-usefulness claim state (the helpfulness boundary). */
  readonly proofOfHelpfulnessState: string;
  /** The derived moderation status (the moderation boundary). */
  readonly moderationStatus: string;
  /**
   * The moderation boundary's latest DETERMINISTIC quality evaluation band (null
   * when no evaluation exists — allowed; UNSATISFACTORY blocks). The
   * advisory blend is NEVER consulted (AI output is not a clearing
   * input).
   */
  readonly qualityBand: string | null;
}

/** The resolved target-placement view (the W019 derived readiness). */
export interface ClearingPlacementView {
  readonly placementId: string;
  readonly organizationScopeId: string;
  /** The placement's campaign binding (the pinned policy scope). */
  readonly campaignId: string;
  readonly campaignPolicyVersion: number;
  /** The item's registered owner (the acting person at registration). */
  readonly ownerPersonId: string;
  /** The W019 DERIVED settlement readiness (re-derived upstream). */
  readonly settlementReady: boolean;
}

/** One declared clearing rule (read-only view over the campaign policy). */
export interface ClearingRuleView {
  readonly id: string;
  readonly objectiveId: string;
  readonly basis: string;
  readonly drawKind: string;
  readonly rewardPolicyId: string | null;
  readonly maxDrawAmount: number;
}

/** The resolved campaign clearing-policy view. */
export interface ClearingCampaignView {
  readonly campaignId: string;
  readonly organizationScopeId: string;
  readonly administrativeStatus: string;
  readonly currentPolicyVersion: number;
  readonly clearingRules: readonly ClearingRuleView[];
}

/** The resolved risk/dispute gate view (active controls + ACTIVE disputes). */
export interface ClearingGateView {
  readonly clear: boolean;
  /** "risk_control" | "active_dispute" | null (null when clear). */
  readonly source: string | null;
  readonly controlId: string | null;
  readonly disputeId: string | null;
  readonly detail: Record<string, unknown>;
}

/** The value-record view the evaluator consumes (own-domain read). */
export interface ClearingValueView {
  readonly valueRecordId: string;
  readonly organizationScopeId: string;
  readonly state: string;
  readonly amount: number;
  readonly beneficiaryPersonId: string;
  readonly sources: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
}

// ---------------------------------------------------------------------------
// The evaluation trace
// ---------------------------------------------------------------------------

/** One machine-readable clearing-eligibility check result. */
export interface CrossPromotionClearingCheck {
  readonly check:
    | "source_contribution_qualified"
    | "placement_settlement_ready"
    | "placement_campaign_bound"
    | "campaign_clearing_policy"
    | "value_eligible"
    | "risk_dispute_gate";
  readonly satisfied: boolean;
  /** Deterministic machine-readable reason (never prose-only). */
  readonly reason:
    | "satisfied"
    | "contribution_not_verified"
    | "helpfulness_not_qualified"
    | "moderation_blocked"
    | "quality_unsatisfactory"
    | "scope_mismatch"
    | "placement_not_ready"
    | "placement_campaign_mismatch"
    | "campaign_not_active"
    | "clearing_rule_not_resolved"
    | "value_state_not_clearable"
    | "contribution_not_in_value_sources"
    | "amount_exceeds_cap"
    | "basis_not_satisfied"
    | "gated";
  readonly detail: Record<string, unknown>;
}

/** The derived cross-promotion clearing eligibility (never stored as truth). */
export interface CrossPromotionClearingEvaluation {
  /** True iff every check is satisfied. */
  readonly eligible: boolean;
  readonly checks: readonly CrossPromotionClearingCheck[];
  /** The resolved clearing rule when the policy check passes. */
  readonly resolvedRule: ClearingRuleView | null;
}

// ---------------------------------------------------------------------------
// The evaluator (pure)
// ---------------------------------------------------------------------------

/** The full input contract of the pure evaluator. */
export interface EvaluateCrossPromotionClearingInput {
  readonly organizationScopeId: string;
  readonly sourceContributionId: string;
  readonly targetPlacementId: string;
  readonly valueRecordId: string;
  /** Optional explicit rule id; omitted → the single declared rule. */
  readonly requestedRuleId: string | null;
  readonly contribution: ClearingContributionView | null;
  readonly placement: ClearingPlacementView | null;
  readonly campaign: ClearingCampaignView | null;
  readonly value: ClearingValueView | null;
  readonly gate: ClearingGateView;
}

function check(
  name: CrossPromotionClearingCheck["check"],
  satisfied: boolean,
  reason: CrossPromotionClearingCheck["reason"],
  detail: Record<string, unknown>,
): CrossPromotionClearingCheck {
  return { check: name, satisfied, reason, detail };
}

/**
 * Evaluate cross-promotion clearing eligibility over the resolved views.
 * Pure + total: every applicable check appears in the trace; `eligible`
 * is true iff every check is satisfied (an unresolved view fails closed).
 */
export function evaluateCrossPromotionClearing(
  input: EvaluateCrossPromotionClearingInput,
): CrossPromotionClearingEvaluation {
  const checks: CrossPromotionClearingCheck[] = [];

  // 1 — the qualified source contribution (the EXACT W014 recognition
  //     bar; an unresolved contribution fails closed).
  const c = input.contribution;
  let contributionQualified = false;
  if (!c) {
    checks.push(
      check(
        "source_contribution_qualified",
        false,
        "contribution_not_verified",
        { contributionId: input.sourceContributionId, resolved: false },
      ),
    );
  } else if (c.organizationScopeId !== input.organizationScopeId) {
    checks.push(check("source_contribution_qualified", false, "scope_mismatch", {
      contributionId: c.contributionId,
      contributionScope: c.organizationScopeId,
      inputScope: input.organizationScopeId,
    }));
  } else {
    // The lifecycle bar (gate 1 of the W014 composite).
    if (c.lifecycleState !== "VERIFIED") {
      checks.push(
        check("source_contribution_qualified", false, "contribution_not_verified", {
          lifecycleState: c.lifecycleState,
        }),
      );
    } else if (c.proofOfHelpfulnessState !== "QUALIFIED") {
      checks.push(
        check("source_contribution_qualified", false, "helpfulness_not_qualified", {
          proofOfHelpfulnessState: c.proofOfHelpfulnessState,
        }),
      );
    } else if (
      c.moderationStatus === "REJECTED" ||
      c.moderationStatus === "FLAGGED_FOR_REVIEW"
    ) {
      checks.push(
        check("source_contribution_qualified", false, "moderation_blocked", {
          moderationStatus: c.moderationStatus,
        }),
      );
    } else if (c.qualityBand === "UNSATISFACTORY") {
      checks.push(
        check("source_contribution_qualified", false, "quality_unsatisfactory", {
          qualityBand: c.qualityBand,
        }),
      );
    } else {
      contributionQualified = true;
      checks.push(
        check("source_contribution_qualified", true, "satisfied", {
          lifecycleState: c.lifecycleState,
          proofOfHelpfulnessState: c.proofOfHelpfulnessState,
          moderationStatus: c.moderationStatus,
          qualityBand: c.qualityBand,
        }),
      );
    }
  }

  // 2 — the settlement-ready target placement (the W019 derived gate).
  const p = input.placement;
  let placementReady = false;
  if (!p) {
    checks.push(
      check("placement_settlement_ready", false, "placement_not_ready", {
        placementId: input.targetPlacementId,
        resolved: false,
      }),
    );
  } else if (p.organizationScopeId !== input.organizationScopeId) {
    checks.push(check("placement_settlement_ready", false, "scope_mismatch", {
      placementId: p.placementId,
      placementScope: p.organizationScopeId,
      inputScope: input.organizationScopeId,
    }));
  } else if (!p.settlementReady) {
    checks.push(check("placement_settlement_ready", false, "placement_not_ready", {
      placementId: p.placementId,
      settlementReady: false,
    }));
  } else {
    placementReady = true;
    checks.push(
      check("placement_settlement_ready", true, "satisfied", {
        placementId: p.placementId,
        campaignId: p.campaignId,
        campaignPolicyVersion: p.campaignPolicyVersion,
      }),
    );
  }

  // 3 — the placement is bound to the clearing campaign (the placement
  //     IS the campaign's inventory context — the cross-promotion link).
  const campaign = input.campaign;
  let placementBound = false;
  if (p && campaign) {
    if (
      p.organizationScopeId === input.organizationScopeId &&
      campaign.organizationScopeId === input.organizationScopeId &&
      p.campaignId === campaign.campaignId
    ) {
      placementBound = true;
      checks.push(
        check("placement_campaign_bound", true, "satisfied", {
          placementId: p.placementId,
          campaignId: campaign.campaignId,
          placementPolicyVersion: p.campaignPolicyVersion,
          currentPolicyVersion: campaign.currentPolicyVersion,
        }),
      );
    } else {
      checks.push(
        check("placement_campaign_bound", false, "placement_campaign_mismatch", {
          placementCampaignId: p.campaignId,
          clearingCampaignId: campaign.campaignId,
          campaignScope: campaign.organizationScopeId,
          inputScope: input.organizationScopeId,
        }),
      );
    }
  } else if (p && !campaign) {
    checks.push(
      check("placement_campaign_bound", false, "placement_campaign_mismatch", {
        placementCampaignId: p.campaignId,
        clearingCampaignId: null,
        resolvedCampaign: false,
      }),
    );
  } else if (!p && campaign) {
    checks.push(
      check("placement_campaign_bound", false, "placement_not_ready", {
        placementId: input.targetPlacementId,
        resolved: false,
        clearingCampaignId: campaign.campaignId,
      }),
    );
  } else {
    checks.push(
      check("placement_campaign_bound", false, "placement_not_ready", {
        placementId: input.targetPlacementId,
        resolved: false,
        resolvedCampaign: false,
      }),
    );
  }

  // 4 — the campaign clearing policy (ACTIVE + the resolved rule in the
  //     CURRENT policy version).
  let resolvedRule: ClearingRuleView | null = null;
  let policySatisfied = false;
  if (!campaign) {
    checks.push(
      check("campaign_clearing_policy", false, "clearing_rule_not_resolved", {
        campaignId: p?.campaignId ?? null,
        resolved: false,
      }),
    );
  } else if (campaign.organizationScopeId !== input.organizationScopeId) {
    checks.push(check("campaign_clearing_policy", false, "scope_mismatch", {
      campaignId: campaign.campaignId,
      campaignScope: campaign.organizationScopeId,
      inputScope: input.organizationScopeId,
    }));
  } else if (campaign.administrativeStatus !== "ACTIVE") {
    checks.push(check("campaign_clearing_policy", false, "campaign_not_active", {
      campaignId: campaign.campaignId,
      administrativeStatus: campaign.administrativeStatus,
    }));
  } else {
    const rules = campaign.clearingRules;
    const rule =
      input.requestedRuleId !== null
        ? rules.find((r) => r.id === input.requestedRuleId)
        : rules.length === 1
          ? rules[0]!
          : undefined;
    if (!rule) {
      checks.push(
        check("campaign_clearing_policy", false, "clearing_rule_not_resolved", {
          campaignId: campaign.campaignId,
          currentPolicyVersion: campaign.currentPolicyVersion,
          requestedRuleId: input.requestedRuleId,
          declaredRuleIds: rules.map((r) => r.id),
        }),
      );
    } else {
      resolvedRule = rule;
      policySatisfied = true;
      checks.push(
        check("campaign_clearing_policy", true, "satisfied", {
          campaignId: campaign.campaignId,
          currentPolicyVersion: campaign.currentPolicyVersion,
          clearingRuleId: rule.id,
          drawKind: rule.drawKind,
          maxDrawAmount: rule.maxDrawAmount,
        }),
      );
    }
  }

  // 5 — the clearable value record (scope + state + contribution
  //     lineage + cap + basis — the W014 clearing bar plus the
  //     contribution-lineage requirement).
  const v = input.value;
  let valueEligible = false;
  if (!v) {
    checks.push(
      check("value_eligible", false, "value_state_not_clearable", {
        valueRecordId: input.valueRecordId,
        resolved: false,
      }),
    );
  } else if (v.organizationScopeId !== input.organizationScopeId) {
    checks.push(check("value_eligible", false, "scope_mismatch", {
      valueRecordId: v.valueRecordId,
      valueScope: v.organizationScopeId,
      inputScope: input.organizationScopeId,
    }));
  } else {
    // The W014 replay tolerance: a CONSUMED record is clearable ONLY as
    // the replay path of a consuming draw (the primitive re-plays the
    // identical result and refuses a fresh draw — exactly-once holds).
    const replayPath =
      resolvedRule !== null &&
      (resolvedRule.drawKind === "reward_allocation" ||
        resolvedRule.drawKind === "credit_issuance") &&
      v.state === "CONSUMED";
    if (v.state !== "MATURE" && !replayPath) {
      checks.push(
        check("value_eligible", false, "value_state_not_clearable", {
          valueRecordId: v.valueRecordId,
          state: v.state,
          replayPath,
        }),
      );
    } else if (
      !v.sources.some(
        (s) => s.kind === "contribution" && s.id === input.sourceContributionId,
      )
    ) {
      checks.push(
        check("value_eligible", false, "contribution_not_in_value_sources", {
          valueRecordId: v.valueRecordId,
          sourceContributionId: input.sourceContributionId,
          sourceKinds: v.sources.map((s) => s.kind),
        }),
      );
    } else if (resolvedRule && v.amount > resolvedRule.maxDrawAmount) {
      checks.push(check("value_eligible", false, "amount_exceeds_cap", {
        valueRecordId: v.valueRecordId,
        amount: v.amount,
        clearingRuleId: resolvedRule.id,
        maxDrawAmount: resolvedRule.maxDrawAmount,
      }));
    } else if (resolvedRule) {
      // The deterministic CAMP-005 basis check (the W014 composite).
      const sourceKinds = new Set(v.sources.map((s) => s.kind));
      const basisSatisfied =
        resolvedRule.basis === "attributed_outcome"
          ? sourceKinds.has("measured_outcome")
          : resolvedRule.basis === "verified_evidence"
            ? sourceKinds.has("evidence")
            : sourceKinds.has("proof_of_value");
      if (!basisSatisfied) {
        checks.push(check("value_eligible", false, "basis_not_satisfied", {
          valueRecordId: v.valueRecordId,
          sourceKinds: [...sourceKinds],
          clearingRuleId: resolvedRule.id,
          basis: resolvedRule.basis,
        }));
      } else {
        valueEligible = true;
        checks.push(
          check("value_eligible", true, "satisfied", {
            valueRecordId: v.valueRecordId,
            state: v.state,
            amount: v.amount,
            replayPath,
            clearingRuleId: resolvedRule.id,
          }),
        );
      }
    } else {
      // No resolved rule — the policy check already carries the reason;
      // the value check reports its own satisfiable sub-facts without
      // the cap/basis verdicts (they need the rule).
      checks.push(
        check("value_eligible", false, "clearing_rule_not_resolved", {
          valueRecordId: v.valueRecordId,
          state: v.state,
          clearingRuleResolved: false,
        }),
      );
    }
  }

  // 6 — the risk/dispute gate over the source contexts.
  checks.push(
    check("risk_dispute_gate", input.gate.clear, input.gate.clear ? "satisfied" : "gated", {
      source: input.gate.source,
      controlId: input.gate.controlId,
      disputeId: input.gate.disputeId,
      ...input.gate.detail,
    }),
  );

  const eligible =
    contributionQualified &&
    placementReady &&
    placementBound &&
    policySatisfied &&
    valueEligible &&
    input.gate.clear;
  return { eligible, checks, resolvedRule };
}

/**
 * The risk/dispute gate subjects for a clearing evaluation: the value
 * record + every upstream source id (including the contribution) + the
 * target placement (the inventory source context). Pure helper.
 */
export function clearingGateSubjectIds(
  value: ClearingValueView,
  targetPlacementId: string,
): string[] {
  return [
    value.valueRecordId,
    ...value.sources.map((s) => s.id),
    targetPlacementId,
  ];
}

/**
 * Map a clearing draw kind onto the risk operation class the gate
 * consults (the W014 composite's exact mapping). Pure helper.
 */
export function clearingOperationClass(
  drawKind: string,
): "reward_allocation" | "credit_issuance" | "cash_settlement" {
  if (drawKind === "reward_allocation") return "reward_allocation";
  if (drawKind === "credit_issuance") return "credit_issuance";
  return "cash_settlement";
}
